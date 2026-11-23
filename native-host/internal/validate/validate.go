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
// The layout is flat: <root>/<name>. This tool is used for the user's own
// repositories, so the owner segment only adds a directory level. The owner is
// still validated, because it identifies which repository to fetch.
func Target(rootReal, owner, name string) (string, error) {
	_ = owner // validated by RepoSpec; not part of the path
	target := filepath.Join(rootReal, name)
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
