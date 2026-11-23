// Package validate enforces the input rules from the MVP spec: only
// `owner/repo` identifiers are accepted, and every clone target must stay
// inside the user-configured root directory even when symlinks or junctions
// are involved.
package validate

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Length limits mirror GitHub's own constraints.
const (
	MaxOwnerLen    = 39
	MaxRepoLen     = 100
	MaxRepoSpecLen = MaxOwnerLen + 1 + MaxRepoLen
)

var (
	// GitHub logins: alphanumeric and hyphens, no leading or trailing hyphen.
	ownerPattern = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$`)
	// GitHub repository names: alphanumerics, dot, underscore, hyphen.
	repoPattern = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)
)

// reservedNames are Windows device names that cannot be used as directories.
var reservedNames = map[string]bool{
	"con": true, "prn": true, "aux": true, "nul": true,
	"com1": true, "com2": true, "com3": true, "com4": true, "com5": true,
	"com6": true, "com7": true, "com8": true, "com9": true,
	"lpt1": true, "lpt2": true, "lpt3": true, "lpt4": true, "lpt5": true,
	"lpt6": true, "lpt7": true, "lpt8": true, "lpt9": true,
}

// RepoSpec splits and validates an `owner/repo` identifier. It rejects
// anything that could be interpreted as a path, a URL, a command-line option,
// or a shell fragment.
func RepoSpec(spec string) (owner, name string, err error) {
	if spec == "" {
		return "", "", errors.New("repository is empty")
	}
	if len(spec) > MaxRepoSpecLen {
		return "", "", fmt.Errorf("repository %q is longer than %d characters", spec, MaxRepoSpecLen)
	}
	if strings.Count(spec, "/") != 1 {
		return "", "", fmt.Errorf("repository %q must be in owner/repo form", spec)
	}
	owner, name, _ = strings.Cut(spec, "/")
	if err := checkOwner(owner); err != nil {
		return "", "", err
	}
	if err := checkRepoName(name); err != nil {
		return "", "", err
	}
	return owner, name, nil
}

func checkOwner(owner string) error {
	if owner == "" {
		return errors.New("repository owner is empty")
	}
	if len(owner) > MaxOwnerLen {
		return fmt.Errorf("repository owner %q is longer than %d characters", owner, MaxOwnerLen)
	}
	if !ownerPattern.MatchString(owner) {
		return fmt.Errorf("repository owner %q contains unsupported characters", owner)
	}
	if reservedNames[strings.ToLower(owner)] {
		return fmt.Errorf("repository owner %q is a reserved Windows device name", owner)
	}
	return nil
}

func checkRepoName(name string) error {
	if name == "" {
		return errors.New("repository name is empty")
	}
	if len(name) > MaxRepoLen {
		return fmt.Errorf("repository name %q is longer than %d characters", name, MaxRepoLen)
	}
	if name == "." || name == ".." {
		return fmt.Errorf("repository name %q is not a valid directory name", name)
	}
	if !repoPattern.MatchString(name) {
		return fmt.Errorf("repository name %q contains unsupported characters", name)
	}
	// A leading hyphen would be read as an option by git or gh.
	if strings.HasPrefix(name, "-") {
		return fmt.Errorf("repository name %q must not start with a hyphen", name)
	}
	// Windows silently strips trailing dots and spaces, which would make the
	// on-disk name differ from the requested one.
	if strings.HasSuffix(name, ".") || strings.HasSuffix(name, " ") {
		return fmt.Errorf("repository name %q must not end with a dot or space", name)
	}
	base, _, _ := strings.Cut(name, ".")
	if reservedNames[strings.ToLower(base)] {
		return fmt.Errorf("repository name %q is a reserved Windows device name", name)
	}
	return nil
}

// Root validates the user-configured clone root and returns its fully resolved
// path. A missing directory is created, because the user should not have to
// prepare the folder before cloning into it.
func Root(root string) (string, error) {
	if strings.TrimSpace(root) == "" {
		return "", errors.New("root directory is empty")
	}
	if !filepath.IsAbs(root) {
		return "", fmt.Errorf("root %q must be an absolute path", root)
	}
	cleaned := filepath.Clean(root)

	info, err := os.Stat(cleaned)
	switch {
	case err == nil:
		if !info.IsDir() {
			return "", fmt.Errorf("root %q is not a directory", cleaned)
		}
	case errors.Is(err, os.ErrNotExist):
		// Create the folder, including any missing parents.
		if mkErr := os.MkdirAll(cleaned, 0o755); mkErr != nil {
			return "", fmt.Errorf("root %q cannot be created: %w", cleaned, mkErr)
		}
	default:
		return "", fmt.Errorf("root %q is not accessible: %w", cleaned, err)
	}

	real, err := filepath.EvalSymlinks(cleaned)
	if err != nil {
		return "", fmt.Errorf("root %q cannot be resolved: %w", cleaned, err)
	}
	return real, nil
}

// Contains reports whether target is root itself or lives underneath it.
// Comparison follows the platform's case rules via filepath.Rel.
func Contains(root, target string) bool {
	rel, err := filepath.Rel(root, target)
	if err != nil {
		return false
	}
	if rel == "." {
		return true
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return false
	}
	return !filepath.IsAbs(rel)
}

// Target returns the clone destination for owner/name.
//
// The default layout is flat: <root>/<name>. This tool is mainly used for the
// user's own repositories, so the owner segment would only add a directory
// level. The owner layout (<root>/<owner>/<name>) is available when
// same-named repositories from different owners must coexist.
//
// The owner is always validated, because it identifies which repository to
// fetch.
func Target(rootReal, owner, name string) (string, error) {
	return TargetWithLayout(rootReal, owner, name, "flat")
}

// TargetWithLayout is Target with an explicit layout:
// "flat" for <root>/<name>, "owner" for <root>/<owner>/<name>.
func TargetWithLayout(rootReal, owner, name, layout string) (string, error) {
	var target string
	switch layout {
	case "", "flat":
		target = filepath.Join(rootReal, name)
	case "owner":
		ownerDir := filepath.Join(rootReal, owner)
		if err := os.MkdirAll(ownerDir, 0o755); err != nil {
			return "", fmt.Errorf("cannot create owner directory: %w", err)
		}
		// Resolve the owner directory so a junction planted there cannot move
		// the clone outside the root.
		ownerReal, err := filepath.EvalSymlinks(ownerDir)
		if err != nil {
			return "", fmt.Errorf("cannot resolve owner directory: %w", err)
		}
		if !Contains(rootReal, ownerReal) {
			return "", fmt.Errorf("owner directory %q resolves outside the clone root", ownerDir)
		}
		target = filepath.Join(ownerReal, name)
	default:
		return "", fmt.Errorf("unknown layout %q", layout)
	}

	if !Contains(rootReal, target) {
		return "", fmt.Errorf("clone target %q resolves outside the clone root", target)
	}
	return target, nil
}

// IsGitRepo reports whether dir looks like a Git working tree.
func IsGitRepo(dir string) bool {
	_, err := os.Lstat(filepath.Join(dir, ".git"))
	return err == nil
}

// ParseGitHubRemote extracts owner/repo from a GitHub remote URL.
//
// It accepts the forms git writes on clone:
//
//	https://github.com/<owner>/<repo>.git
//	git@github.com:<owner>/<repo>.git
//	ssh://git@github.com/<owner>/<repo>.git
//
// Anything not pointing at github.com returns ok=false, so callers never
// mistake an unrelated remote for a match.
func ParseGitHubRemote(remote string) (spec string, ok bool) {
	remote = strings.TrimSpace(remote)
	if remote == "" {
		return "", false
	}
	remote = strings.TrimSuffix(remote, "/")
	remote = strings.TrimSuffix(remote, ".git")

	var rest string
	switch {
	case strings.Contains(remote, "://"):
		// scheme://[user@]host[:port]/path
		_, after, found := strings.Cut(remote, "://")
		if !found {
			return "", false
		}
		// Strip any userinfo.
		if at := strings.Index(after, "@"); at >= 0 {
			after = after[at+1:]
		}
		host, path, found := strings.Cut(after, "/")
		if !found || !isGitHubHost(host) {
			return "", false
		}
		rest = path
	default:
		// scp-like syntax: [user@]host:path
		colon := strings.Index(remote, ":")
		if colon < 0 {
			return "", false
		}
		hostPart := remote[:colon]
		if at := strings.Index(hostPart, "@"); at >= 0 {
			hostPart = hostPart[at+1:]
		}
		if !isGitHubHost(hostPart) {
			return "", false
		}
		rest = remote[colon+1:]
	}

	parts := strings.Split(strings.Trim(rest, "/"), "/")
	if len(parts) != 2 {
		return "", false
	}
	owner, name := parts[0], parts[1]
	if _, _, err := RepoSpec(owner + "/" + name); err != nil {
		return "", false
	}
	return owner + "/" + name, true
}

// isGitHubHost reports whether host names github.com, ignoring a port.
func isGitHubHost(host string) bool {
	if idx := strings.LastIndex(host, ":"); idx >= 0 {
		host = host[:idx]
	}
	return strings.EqualFold(host, "github.com") || strings.EqualFold(host, "www.github.com")
}

// SameRepo reports whether two owner/repo specs name the same repository.
// GitHub treats owner and repository names case-insensitively.
func SameRepo(a, b string) bool {
	return strings.EqualFold(a, b)
}
