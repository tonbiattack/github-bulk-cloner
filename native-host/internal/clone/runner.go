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
	"runtime"
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
	// Layout is "flat" (<root>/<repo>) or "owner" (<root>/<owner>/<repo>).
	// Empty means flat.
	Layout string
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

// Capabilities reports the tooling available on this machine.
//
// These are facts only the host can observe; the extension must not guess
// them. The probe is best-effort: a missing gh is not an error.
func (r *Runner) Capabilities(ctx context.Context) protocol.Capabilities {
	caps := protocol.Capabilities{
		OS:   runtime.GOOS,
		Arch: runtime.GOARCH,
	}

	if _, err := r.git(); err == nil {
		caps.GitAvailable = true
	}

	ghPath, err := r.gh()
	if err != nil {
		return caps
	}
	caps.GhAvailable = true

	// gh auth status talks to the local config only, but bound it anyway.
	probeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(probeCtx, ghPath, "auth", "status")
	cmd.Env = toolEnv()
	if cmd.Run() == nil {
		caps.GhAuthenticated = true
	}
	return caps
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

	target, err := validate.TargetWithLayout(r.Root, owner, name, r.Layout)
	if err != nil {
		result.Status = protocol.StatusFailed
		result.Message = sanitize(err.Error())
		return result
	}
	result.Path = target

	// Never overwrite, delete, or pull an existing directory.
	if _, statErr := os.Lstat(target); statErr == nil {
		return r.existingOutcome(ctx, spec, target, result)
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

// existingOutcome decides what to report when the destination already exists.
//
// Nothing on disk is modified. The point is to avoid telling the user that
// their repository is already cloned when the folder actually holds a
// different repository: with the flat layout, ownerA/tool and ownerB/tool
// resolve to the same folder, so the remote is the only way to tell them
// apart.
func (r *Runner) existingOutcome(ctx context.Context, spec, target string, result protocol.Result) protocol.Result {
	isRepo := validate.IsGitRepo(target)
	result.ExistingGitRepo = &isRepo

	if !isRepo {
		result.Status = protocol.StatusSkipped
		result.Message = "既存のディレクトリのためスキップしました"
		return result
	}

	existing, ok := r.remoteSpec(ctx, target)
	if !ok {
		// The remote is missing or not on GitHub, so the origin cannot be
		// confirmed. Skip without claiming it matches.
		result.Status = protocol.StatusSkipped
		result.Message = "既存の Git リポジトリのためスキップしました（リモートを確認できませんでした）"
		return result
	}

	if validate.SameRepo(existing, spec) {
		result.Status = protocol.StatusSkipped
		result.Message = "既に clone 済みのためスキップしました"
		return result
	}

	// A different repository already occupies the destination.
	result.Status = protocol.StatusConflict
	result.ExistingRepository = existing
	result.Message = sanitize(fmt.Sprintf(
		"保存先には別のリポジトリ %s があります。%s は clone していません。保存先を変更するか、所有者ごとのフォルダに保存する設定にしてください",
		existing, spec))
	return result
}

// remoteSpec returns the owner/repo of the origin remote of the working tree
// at dir, or ok=false when it cannot be determined.
func (r *Runner) remoteSpec(ctx context.Context, dir string) (string, bool) {
	gitPath, err := r.git()
	if err != nil {
		return "", false
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, gitPath, "remote", "get-url", "origin")
	cmd.Dir = dir
	cmd.Env = toolEnv()
	out, err := cmd.Output()
	if err != nil {
		return "", false
	}
	return validate.ParseGitHubRemote(string(out))
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
	layout := r.Layout
	if layout == "" {
		layout = protocol.LayoutFlat
	}
	if layout == protocol.LayoutOwner {
		return filepath.Join(r.Root, owner, name), nil
	}
	return filepath.Join(r.Root, name), nil
}

