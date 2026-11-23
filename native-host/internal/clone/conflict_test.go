package clone

import (
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tonbiattack/github-bulk-cloner/native-host/internal/protocol"
	"github.com/tonbiattack/github-bulk-cloner/native-host/internal/validate"
)

// makeExistingRepo creates a directory that looks like a clone of spec by
// initialising a repository with the matching origin remote.
func makeExistingRepo(t *testing.T, dir, spec string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not available")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=test", "GIT_AUTHOR_EMAIL=test@example.com",
			"GIT_COMMITTER_NAME=test", "GIT_COMMITTER_EMAIL=test@example.com",
		)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
		}
	}
	run("init", "-b", "main")
	run("remote", "add", "origin", "https://github.com/"+spec+".git")
}

func newConflictRunner(t *testing.T, layout string) (*Runner, string) {
	t.Helper()
	root := t.TempDir()
	real, err := validate.Root(root)
	if err != nil {
		t.Fatalf("root: %v", err)
	}
	return &Runner{Root: real, Layout: layout, Timeout: 30 * time.Second, Log: io.Discard}, real
}

// TestCloneSkipsMatchingExistingRepo is the baseline: the same repository that
// is already cloned must still be skipped, not reported as a conflict.
func TestCloneSkipsMatchingExistingRepo(t *testing.T) {
	runner, root := newConflictRunner(t, protocol.LayoutFlat)
	makeExistingRepo(t, filepath.Join(root, "tool"), "ownerA/tool")

	result := runner.Clone(context.Background(), "r1", "ownerA/tool")
	if result.Status != protocol.StatusSkipped {
		t.Fatalf("status = %q, want skipped (%s)", result.Status, result.Message)
	}
	if result.ExistingGitRepo == nil || !*result.ExistingGitRepo {
		t.Fatalf("existingGitRepo = %v, want true", result.ExistingGitRepo)
	}
	if strings.Contains(result.Message, "別のリポジトリ") {
		t.Errorf("matching repository must not be reported as a conflict: %q", result.Message)
	}
}

// TestCloneReportsConflictForDifferentOwner is the behaviour this issue is
// about: ownerB/tool must not be silently treated as already cloned just
// because ownerA/tool occupies the flat destination.
func TestCloneReportsConflictForDifferentOwner(t *testing.T) {
	runner, root := newConflictRunner(t, protocol.LayoutFlat)
	makeExistingRepo(t, filepath.Join(root, "tool"), "ownerA/tool")

	result := runner.Clone(context.Background(), "r1", "ownerB/tool")
	if result.Status != protocol.StatusConflict {
		t.Fatalf("status = %q, want conflict (%s)", result.Status, result.Message)
	}
	if result.ExistingRepository != "ownerA/tool" {
		t.Errorf("existingRepository = %q, want ownerA/tool", result.ExistingRepository)
	}
	if !strings.Contains(result.Message, "ownerA/tool") || !strings.Contains(result.Message, "ownerB/tool") {
		t.Errorf("message should name both repositories, got %q", result.Message)
	}

	// The existing checkout must be untouched.
	if !validate.IsGitRepo(filepath.Join(root, "tool")) {
		t.Fatal("existing repository was disturbed")
	}
}

// TestCloneConflictMatchesCaseInsensitively checks that GitHub's
// case-insensitive naming does not produce false conflicts.
func TestCloneConflictMatchesCaseInsensitively(t *testing.T) {
	runner, root := newConflictRunner(t, protocol.LayoutFlat)
	makeExistingRepo(t, filepath.Join(root, "tool"), "OwnerA/Tool")

	result := runner.Clone(context.Background(), "r1", "ownera/tool")
	if result.Status != protocol.StatusSkipped {
		t.Fatalf("status = %q, want skipped for the same repository", result.Status)
	}
}

// TestCloneSkipsWhenRemoteUnknown makes sure an unverifiable origin is not
// reported as a match, but also not as a conflict.
func TestCloneSkipsWhenRemoteUnknown(t *testing.T) {
	runner, root := newConflictRunner(t, protocol.LayoutFlat)

	// A repository with no origin remote at all.
	dir := filepath.Join(root, "tool")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not available")
	}
	cmd := exec.Command("git", "init", "-b", "main")
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git init: %v\n%s", err, out)
	}

	result := runner.Clone(context.Background(), "r1", "owner/tool")
	if result.Status != protocol.StatusSkipped {
		t.Fatalf("status = %q, want skipped (%s)", result.Status, result.Message)
	}
	if !strings.Contains(result.Message, "リモートを確認できませんでした") {
		t.Errorf("message should say the remote could not be verified, got %q", result.Message)
	}
}

// TestCloneSkipsNonRepositoryDirectory keeps the existing behaviour for a
// plain folder: skip without touching it.
func TestCloneSkipsNonRepositoryDirectory(t *testing.T) {
	runner, root := newConflictRunner(t, protocol.LayoutFlat)
	dir := filepath.Join(root, "tool")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}

	result := runner.Clone(context.Background(), "r1", "owner/tool")
	if result.Status != protocol.StatusSkipped {
		t.Fatalf("status = %q, want skipped", result.Status)
	}
	if result.ExistingGitRepo == nil || *result.ExistingGitRepo {
		t.Fatalf("existingGitRepo = %v, want false", result.ExistingGitRepo)
	}
}

// TestOwnerLayoutAllowsSameNameFromDifferentOwners verifies the resolution
// path: the owner layout keeps both repositories side by side.
func TestOwnerLayoutAllowsSameNameFromDifferentOwners(t *testing.T) {
	runner, root := newConflictRunner(t, protocol.LayoutOwner)

	pathA, err := runner.TargetPath("ownerA/tool")
	if err != nil {
		t.Fatal(err)
	}
	pathB, err := runner.TargetPath("ownerB/tool")
	if err != nil {
		t.Fatal(err)
	}
	if pathA == pathB {
		t.Fatalf("owner layout must separate the two: both %q", pathA)
	}
	for _, p := range []string{pathA, pathB} {
		if !validate.Contains(root, p) {
			t.Errorf("target %q escaped root %q", p, root)
		}
		if filepath.Base(p) != "tool" {
			t.Errorf("target base = %q, want tool", filepath.Base(p))
		}
	}

	makeExistingRepo(t, pathA, "ownerA/tool")

	// The repository that lives at pathA is skipped, proving the check is
	// per-target and unaffected by the other owner.
	resultA := runner.Clone(context.Background(), "r1", "ownerA/tool")
	if resultA.Status != protocol.StatusSkipped {
		t.Fatalf("ownerA status = %q, want skipped (%s)", resultA.Status, resultA.Message)
	}

	// ownerB resolves to a different folder, so it is not a conflict. It is
	// left to a network attempt, which is out of scope here.
	pathB2, err := runner.TargetPath("ownerB/tool")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(pathB2); !os.IsNotExist(err) {
		t.Fatalf("ownerB target %q should not exist yet", pathB2)
	}
}
