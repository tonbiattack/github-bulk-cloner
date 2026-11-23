// Package clone runs git and gh with fixed arguments, never through a shell.
package clone

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/tonbiattack/github-bulk-cloner/native-host/internal/protocol"
	"github.com/tonbiattack/github-bulk-cloner/native-host/internal/validate"
)

// Method identifies which tool performed a clone.
const (
	MethodGit = "git"
	MethodGh  = "gh"
)

// DefaultTimeout bounds a single repository clone.
const DefaultTimeout = 10 * time.Minute

// maxMessageLen keeps error text short enough for the popup.
const maxMessageLen = 300

// credentialPattern redacts anything that looks like userinfo in a URL.
var credentialPattern = regexp.MustCompile(`(?i)\b([a-z][a-z0-9+.-]*://)[^/\s@]+@`)

// Runner clones repositories beneath a single root directory.
type Runner struct {
	// Root is the resolved absolute clone root.
	Root string
	// Timeout bounds each repository. Zero means DefaultTimeout.
	Timeout time.Duration
	// Log receives diagnostics. It must not be stdout.
	Log io.Writer
	// GitPath and GhPath override tool lookup; empty means search PATH.
	GitPath string
	GhPath  string
}

// ErrGitMissing means git could not be found on PATH.
var ErrGitMissing = errors.New("git が見つかりません。Git for Windows をインストールして PATH に追加してください")

// CheckTools verifies that git is available before any clone is attempted.
func (r *Runner) CheckTools() error {
	if _, err := r.git(); err != nil {
		return ErrGitMissing
	}
	return nil
}

func (r *Runner) git() (string, error) { return resolveTool(r.GitPath, "git") }

func (r *Runner) gh() (string, error) { return resolveTool(r.GhPath, "gh") }

// resolveTool returns the executable to run. An explicit override is still
// checked for existence so a misconfigured path fails loudly instead of
// producing a confusing exec error later.
func resolveTool(override, name string) (string, error) {
	if override == "" {
		return exec.LookPath(name)
	}
	info, err := os.Stat(override)
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		return "", fmt.Errorf("%s is a directory, not an executable", override)
	}
	return override, nil
}

func (r *Runner) timeout() time.Duration {
	if r.Timeout > 0 {
		return r.Timeout
	}
	return DefaultTimeout
}

func (r *Runner) logf(format string, args ...any) {
	if r.Log == nil {
		return
	}
	fmt.Fprintf(r.Log, format+"\n", args...)
}

// Clone clones one repository and reports its outcome. It never returns an
// error: every failure is folded into a failed Result so the caller can keep
// processing the remaining repositories.
func (r *Runner) Clone(ctx context.Context, requestID, spec string) protocol.Result {
	result := protocol.Result{
		Type:       protocol.TypeResult,
		RequestID:  requestID,
		Repository: spec,
	}

	owner, name, err := validate.RepoSpec(spec)
	if err != nil {
		result.Status = protocol.StatusFailed
		result.Message = sanitize(err.Error())
		return result
	}

	target, err := validate.Target(r.Root, owner, name)
	if err != nil {
		result.Status = protocol.StatusFailed
		result.Message = sanitize(err.Error())
		return result
	}
	result.Path = target

	// Never overwrite, delete, or pull an existing directory.
	if _, statErr := os.Lstat(target); statErr == nil {
		existing := validate.IsGitRepo(target)
		result.Status = protocol.StatusSkipped
		result.ExistingGitRepo = &existing
		if existing {
			result.Message = "既存の Git リポジトリのためスキップしました"
		} else {
			result.Message = "既存のディレクトリのためスキップしました"
		}
		return result
	} else if !errors.Is(statErr, os.ErrNotExist) {
		result.Status = protocol.StatusFailed
		result.Message = sanitize(fmt.Sprintf("保存先を確認できません: %v", statErr))
		return result
	}

	method := r.method(ctx, spec)
	result.Method = method

	cloneErr := r.run(ctx, method, spec, target)
	if cloneErr == nil {
		result.Status = protocol.StatusSuccess
		return result
	}

	// A public clone can fail because the repository is private. Retry once
	// through gh, which uses the user's existing gh credentials.
	if method == MethodGit && r.ghAvailable(ctx) && isAuthFailure(cloneErr) {
		if _, statErr := os.Lstat(target); errors.Is(statErr, os.ErrNotExist) {
			r.logf("git clone failed for %s, retrying with gh", spec)
			if ghErr := r.run(ctx, MethodGh, spec, target); ghErr == nil {
				result.Method = MethodGh
				result.Status = protocol.StatusSuccess
				return result
			} else {
				cloneErr = ghErr
			}
		}
	}

	result.Status = protocol.StatusFailed
	result.Message = sanitize(describe(cloneErr))
	return result
}

// method picks gh for repositories the user cannot read anonymously.
func (r *Runner) method(ctx context.Context, spec string) string {
	ghPath, err := r.gh()
	if err != nil {
		return MethodGit
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, ghPath, "repo", "view", spec, "--json", "visibility", "--jq", ".visibility")
	cmd.Env = toolEnv()
	out, err := cmd.Output()
	if err != nil {
		return MethodGit
	}
	switch strings.ToUpper(strings.TrimSpace(string(out))) {
	case "PRIVATE", "INTERNAL":
		return MethodGh
	default:
		return MethodGit
	}
}

func (r *Runner) ghAvailable(ctx context.Context) bool {
	ghPath, err := r.gh()
	if err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, ghPath, "auth", "status")
	cmd.Env = toolEnv()
	return cmd.Run() == nil
}

// run executes one clone. Arguments are fixed; the repository spec is already
// validated, so it cannot be read as an option.
func (r *Runner) run(ctx context.Context, method, spec, target string) error {
	ctx, cancel := context.WithTimeout(ctx, r.timeout())
	defer cancel()

	var cmd *exec.Cmd
	switch method {
	case MethodGh:
		ghPath, err := r.gh()
		if err != nil {
			return fmt.Errorf("gh が見つかりません: %w", err)
		}
		cmd = exec.CommandContext(ctx, ghPath, "repo", "clone", spec, target)
	default:
		gitPath, err := r.git()
		if err != nil {
			return ErrGitMissing
		}
		url := "https://github.com/" + spec + ".git"
		cmd = exec.CommandContext(ctx, gitPath, "clone", "--", url, target)
	}

	cmd.Env = toolEnv()
	cmd.Dir = r.Root
	output, err := cmd.CombinedOutput()
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return fmt.Errorf("タイムアウトしました（%s）", r.timeout())
		}
		return &toolError{err: err, output: string(output)}
	}
	return nil
}

// toolError carries the tool's stderr alongside the exit error.
type toolError struct {
	err    error
	output string
}

func (e *toolError) Error() string { return e.err.Error() }
func (e *toolError) Unwrap() error { return e.err }

// toolEnv disables interactive credential prompts so a clone can never hang
// waiting for input that no one can provide.
func toolEnv() []string {
	env := os.Environ()
	return append(env,
		"GIT_TERMINAL_PROMPT=0",
		"GCM_INTERACTIVE=never",
		"GH_PROMPT_DISABLED=1",
		"GIT_ASKPASS=",
		"SSH_ASKPASS=",
	)
}

// isAuthFailure reports whether a git failure looks like missing credentials.
func isAuthFailure(err error) bool {
	var te *toolError
	if !errors.As(err, &te) {
		return false
	}
	lower := strings.ToLower(te.output)
	for _, marker := range []string{
		"authentication failed",
		"could not read username",
		"terminal prompts disabled",
		"permission denied",
		"403",
		"401",
	} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	// git words this as "repository '<url>' not found", so match the phrase
	// rather than a fixed adjacency.
	return notFoundPattern.MatchString(lower)
}

// notFoundPattern matches git's "repository ... not found" wording.
var notFoundPattern = regexp.MustCompile(`repository\b.*\bnot found`)

// describe turns a tool failure into a short, actionable message.
func describe(err error) string {
	var te *toolError
	if !errors.As(err, &te) {
		return err.Error()
	}
	lower := strings.ToLower(te.output)
	switch {
	case notFoundPattern.MatchString(lower),
		strings.Contains(lower, "could not resolve to a repository"):
		return "リポジトリが見つかりません。Private の場合は gh auth login で認証してください"
	case strings.Contains(lower, "authentication failed"),
		strings.Contains(lower, "could not read username"),
		strings.Contains(lower, "terminal prompts disabled"):
		return "認証に失敗しました。gh auth login で認証してください"
	case strings.Contains(lower, "permission denied"):
		return "アクセスが拒否されました。リポジトリへの権限を確認してください"
	case strings.Contains(lower, "already exists and is not an empty directory"):
		return "保存先に既存の内容があります"
	case strings.Contains(lower, "could not resolve host"),
		strings.Contains(lower, "network is unreachable"):
		return "ネットワークに接続できません"
	}
	// Fall back to the last non-empty line of tool output.
	lines := strings.Split(strings.TrimSpace(te.output), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if line := strings.TrimSpace(lines[i]); line != "" {
			return line
		}
	}
	return te.err.Error()
}

// sanitize removes credentials and caps the length of a message bound for the
// extension.
func sanitize(msg string) string {
	msg = credentialPattern.ReplaceAllString(msg, "${1}***@")
	msg = strings.Join(strings.Fields(msg), " ")
	if len(msg) > maxMessageLen {
		msg = msg[:maxMessageLen] + "…"
	}
	return msg
}

// TargetPath exposes the destination for a spec without touching the disk.
func (r *Runner) TargetPath(spec string) (string, error) {
	owner, name, err := validate.RepoSpec(spec)
	if err != nil {
		return "", err
	}
	return validate.Target(r.Root, owner, name)
}

// ---------------------------------------------------------------- pull

// maxScanDepth bounds how deep DiscoverRepositories walks. The layout is
// <root>/<owner>/<repo>, so three levels is enough; the extra headroom covers
// a root that is itself a repository.
const maxScanDepth = 4

// maxDiscovered caps a single pull run so one click cannot start unbounded
// work on a very large tree.
const maxDiscovered = 500

// DiscoverRepositories returns every Git working tree under root, as
// owner/repo specs where the layout allows it, or as a path-relative label
// otherwise. Directories that are themselves repositories are not descended
// into, so nested checkouts are not reported twice.
func (r *Runner) DiscoverRepositories() ([]Discovered, error) {
	var found []Discovered

	var walk func(dir string, depth int) error
	walk = func(dir string, depth int) error {
		if depth > maxScanDepth {
			return nil
		}
		if len(found) >= maxDiscovered {
			return nil
		}

		entries, err := os.ReadDir(dir)
		if err != nil {
			// An unreadable directory is skipped rather than failing the scan.
			return nil
		}

		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			name := entry.Name()
			// Skip VCS internals and dependency trees that are never the target.
			if name == ".git" || name == "node_modules" {
				continue
			}

			child := filepath.Join(dir, name)
			if validate.IsGitRepo(child) {
				found = append(found, r.describeRepo(child))
				continue
			}
			if err := walk(child, depth+1); err != nil {
				return err
			}
		}
		return nil
	}

	if err := walk(r.Root, 0); err != nil {
		return nil, err
	}
	return found, nil
}

// Discovered is one repository found under the clone root.
type Discovered struct {
	// Spec is the owner/repo identifier when the layout matches, otherwise a
	// path relative to the root.
	Spec string
	// Path is the absolute working tree path.
	Path string
}

// describeRepo builds a Discovered for an existing working tree.
//
// The flat layout <root>/<repo> is what this tool creates, so the repository
// name is used as the label. The remote URL supplies the owner when it points
// at GitHub, which keeps the label in owner/repo form for display.
func (r *Runner) describeRepo(path string) Discovered {
	rel, err := filepath.Rel(r.Root, path)
	if err == nil {
		parts := strings.Split(filepath.ToSlash(rel), "/")
		// <owner>/<repo> from an older layout still resolves to owner/repo.
		if len(parts) == 2 {
			if _, _, specErr := validate.RepoSpec(parts[0] + "/" + parts[1]); specErr == nil {
				return Discovered{Spec: parts[0] + "/" + parts[1], Path: path}
			}
		}
	}

	name := filepath.Base(path)
	if owner := r.remoteOwner(path); owner != "" {
		return Discovered{Spec: owner + "/" + name, Path: path}
	}
	return Discovered{Spec: name, Path: path}
}

// remoteOwner extracts the owner from the origin remote when it is a GitHub
// URL. It returns "" when the remote is absent or not on GitHub.
func (r *Runner) remoteOwner(path string) string {
	gitPath, err := r.git()
	if err != nil {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, gitPath, "remote", "get-url", "origin")
	cmd.Dir = path
	cmd.Env = toolEnv()
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return ownerFromRemote(strings.TrimSpace(string(out)))
}

// ownerFromRemote parses the owner out of a GitHub remote URL.
func ownerFromRemote(remote string) string {
	remote = strings.TrimSuffix(remote, ".git")

	// https://github.com/<owner>/<repo>
	if idx := strings.Index(remote, "github.com/"); idx >= 0 {
		rest := remote[idx+len("github.com/"):]
		parts := strings.Split(rest, "/")
		if len(parts) >= 2 && parts[0] != "" {
			return parts[0]
		}
		return ""
	}
	// git@github.com:<owner>/<repo>
	if idx := strings.Index(remote, "github.com:"); idx >= 0 {
		rest := remote[idx+len("github.com:"):]
		parts := strings.Split(rest, "/")
		if len(parts) >= 2 && parts[0] != "" {
			return parts[0]
		}
	}
	return ""
}

// Pull updates one existing working tree with a fast-forward-only pull.
//
// It never merges, rebases, stashes, or discards local work: if the branch has
// diverged or the tree is dirty, the pull is reported as failed and the
// repository is left exactly as it was.
func (r *Runner) Pull(ctx context.Context, requestID, spec, path string) protocol.Result {
	result := protocol.Result{
		Type:       protocol.TypeResult,
		RequestID:  requestID,
		Repository: spec,
		Path:       path,
	}

	if !validate.Contains(r.Root, path) {
		result.Status = protocol.StatusFailed
		result.Message = "保存先の外にあるため処理しません"
		return result
	}
	if !validate.IsGitRepo(path) {
		result.Status = protocol.StatusFailed
		result.Message = "Git リポジトリではありません"
		return result
	}

	before, _ := r.revParse(ctx, path, "HEAD")

	// --ff-only guarantees a divergent branch fails instead of creating a
	// merge commit the user did not ask for.
	if err := r.runGit(ctx, path, "pull", "--ff-only", "--no-rebase"); err != nil {
		result.Status = protocol.StatusFailed
		result.Message = sanitize(describePull(err))
		return result
	}

	after, _ := r.revParse(ctx, path, "HEAD")
	if before != "" && before == after {
		result.Status = protocol.StatusUpToDate
		result.Message = "最新です"
		return result
	}
	result.Status = protocol.StatusUpdated
	if before != "" && after != "" {
		result.Message = shortSHA(before) + " → " + shortSHA(after)
	}
	return result
}

// revParse returns the commit SHA for a revision, or "" when unavailable.
func (r *Runner) revParse(ctx context.Context, dir, rev string) (string, error) {
	gitPath, err := r.git()
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, gitPath, "rev-parse", rev)
	cmd.Dir = dir
	cmd.Env = toolEnv()
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// runGit runs a git subcommand inside dir with fixed arguments.
func (r *Runner) runGit(ctx context.Context, dir string, args ...string) error {
	gitPath, err := r.git()
	if err != nil {
		return ErrGitMissing
	}

	ctx, cancel := context.WithTimeout(ctx, r.timeout())
	defer cancel()

	cmd := exec.CommandContext(ctx, gitPath, args...)
	cmd.Dir = dir
	cmd.Env = toolEnv()
	output, err := cmd.CombinedOutput()
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return fmt.Errorf("タイムアウトしました（%s）", r.timeout())
		}
		return &toolError{err: err, output: string(output)}
	}
	return nil
}

// shortSHA trims a commit SHA for display.
func shortSHA(sha string) string {
	if len(sha) > 7 {
		return sha[:7]
	}
	return sha
}

// describePull turns a pull failure into a short, actionable message.
func describePull(err error) string {
	var te *toolError
	if !errors.As(err, &te) {
		return err.Error()
	}
	lower := strings.ToLower(te.output)
	switch {
	case strings.Contains(lower, "not possible to fast-forward"),
		strings.Contains(lower, "diverging branches"),
		strings.Contains(lower, "would be overwritten"):
		return "ローカルの変更と競合するため pull しませんでした（手動で解決してください）"
	case strings.Contains(lower, "no tracking information"),
		strings.Contains(lower, "no upstream branch"):
		return "追跡ブランチが設定されていません"
	case strings.Contains(lower, "not a git repository"):
		return "Git リポジトリではありません"
	case strings.Contains(lower, "authentication failed"),
		strings.Contains(lower, "could not read username"),
		strings.Contains(lower, "terminal prompts disabled"):
		return "認証に失敗しました。gh auth login で認証してください"
	case strings.Contains(lower, "could not resolve host"),
		strings.Contains(lower, "network is unreachable"):
		return "ネットワークに接続できません"
	}
	lines := strings.Split(strings.TrimSpace(te.output), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if line := strings.TrimSpace(lines[i]); line != "" {
			return line
		}
	}
	return te.err.Error()
}
