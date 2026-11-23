package clone

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tonbiattack/github-bulk-cloner/native-host/internal/protocol"
	"github.com/tonbiattack/github-bulk-cloner/native-host/internal/validate"
)

// gitAvailable reports whether git can be used in this environment.
func gitAvailable(t *testing.T) string {
	t.Helper()
	path, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git is not available")
	}
	return path
}

// runGit runs a git command in dir and fails the test on error.
func runGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=test", "GIT_AUTHOR_EMAIL=test@example.com",
		"GIT_COMMITTER_NAME=test", "GIT_COMMITTER_EMAIL=test@example.com",
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

// makeUpstream creates a bare repository plus a working clone to push from,
// and returns the bare path.
func makeUpstream(t *testing.T) string {
	t.Helper()
	gitAvailable(t)

	base := t.TempDir()
	bare := filepath.Join(base, "upstream.git")
	runGit(t, base, "init", "--bare", "-b", "main", bare)

	seed := filepath.Join(base, "seed")
	runGit(t, base, "clone", bare, seed)
	runGit(t, seed, "checkout", "-b", "main")
	if err := os.WriteFile(filepath.Join(seed, "file.txt"), []byte("one\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, seed, "add", ".")
	runGit(t, seed, "commit", "-m", "first")
	runGit(t, seed, "push", "-u", "origin", "main")

	return bare
}

// pushCommit adds a commit to the upstream through the seed clone.
func pushCommit(t *testing.T, bare, content string) {
	t.Helper()
	seed := filepath.Join(filepath.Dir(bare), "seed")
	if err := os.WriteFile(filepath.Join(seed, "file.txt"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, seed, "add", ".")
	runGit(t, seed, "commit", "-m", "update "+content)
	runGit(t, seed, "push", "origin", "main")
}

// makeWorkingClone clones the upstream into root/owner/repo.
func makeWorkingClone(t *testing.T, bare, root, owner, repo string) string {
	t.Helper()
	target := filepath.Join(root, owner, repo)
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatal(err)
	}
	runGit(t, root, "clone", bare, target)
	return target
}

func newPullRunner(t *testing.T) (*Runner, string) {
	t.Helper()
	root := t.TempDir()
	real, err := validate.Root(root)
	if err != nil {
		t.Fatalf("root: %v", err)
	}
	return &Runner{Root: real, Timeout: 60 * time.Second, Log: &os.File{}}, real
}

func TestPullReportsUpToDate(t *testing.T) {
	bare := makeUpstream(t)
	runner, root := newPullRunner(t)
	target := makeWorkingClone(t, bare, root, "owner", "repo")

	result := runner.Pull(context.Background(), "r1", "owner/repo", target)
	if result.Status != protocol.StatusUpToDate {
		t.Fatalf("status = %q, want up-to-date (%s)", result.Status, result.Message)
	}
}

func TestPullFetchesNewCommits(t *testing.T) {
	bare := makeUpstream(t)
	runner, root := newPullRunner(t)
	target := makeWorkingClone(t, bare, root, "owner", "repo")

	pushCommit(t, bare, "two\n")

	result := runner.Pull(context.Background(), "r1", "owner/repo", target)
	if result.Status != protocol.StatusUpdated {
		t.Fatalf("status = %q, want updated (%s)", result.Status, result.Message)
	}
	if !strings.Contains(result.Message, "→") {
		t.Errorf("message should show the commit range, got %q", result.Message)
	}

	data, err := os.ReadFile(filepath.Join(target, "file.txt"))
	if err != nil {
		t.Fatal(err)
	}
	// git may rewrite line endings on checkout, so compare normalised text.
	if got := strings.ReplaceAll(string(data), "\r\n", "\n"); got != "two\n" {
		t.Fatalf("file content = %q, want %q", got, "two\n")
	}
}

// TestPullRefusesDivergedBranch is the important safety property: a diverged
// branch must fail rather than create a merge commit.
func TestPullRefusesDivergedBranch(t *testing.T) {
	bare := makeUpstream(t)
	runner, root := newPullRunner(t)
	target := makeWorkingClone(t, bare, root, "owner", "repo")

	// Diverge: a local commit plus an upstream commit.
	if err := os.WriteFile(filepath.Join(target, "local.txt"), []byte("local\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, target, "add", ".")
	runGit(t, target, "commit", "-m", "local work")
	localHead := runGit(t, target, "rev-parse", "HEAD")

	pushCommit(t, bare, "upstream\n")

	result := runner.Pull(context.Background(), "r1", "owner/repo", target)
	if result.Status != protocol.StatusFailed {
		t.Fatalf("status = %q, want failed for a diverged branch", result.Status)
	}

	// The local commit must still be HEAD: no merge, no rebase, no reset.
	if head := runGit(t, target, "rev-parse", "HEAD"); head != localHead {
		t.Fatalf("HEAD moved from %s to %s; pull must not rewrite local history", localHead, head)
	}
	if _, err := os.Stat(filepath.Join(target, "local.txt")); err != nil {
		t.Fatal("local file was removed by pull")
	}
}

// TestPullLeavesDirtyTreeAlone checks that uncommitted changes are not
// discarded or overwritten.
func TestPullLeavesDirtyTreeAlone(t *testing.T) {
	bare := makeUpstream(t)
	runner, root := newPullRunner(t)
	target := makeWorkingClone(t, bare, root, "owner", "repo")

	// Modify a tracked file locally without committing.
	if err := os.WriteFile(filepath.Join(target, "file.txt"), []byte("dirty\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	pushCommit(t, bare, "upstream\n")

	result := runner.Pull(context.Background(), "r1", "owner/repo", target)
	if result.Status != protocol.StatusFailed {
		t.Fatalf("status = %q, want failed for a dirty tree", result.Status)
	}

	data, err := os.ReadFile(filepath.Join(target, "file.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "dirty\n" {
		t.Fatalf("local change was overwritten: %q", data)
	}
}

func TestPullRejectsNonRepository(t *testing.T) {
	runner, root := newPullRunner(t)
	dir := filepath.Join(root, "owner", "plain")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}

	result := runner.Pull(context.Background(), "r1", "owner/plain", dir)
	if result.Status != protocol.StatusFailed {
		t.Fatalf("status = %q, want failed", result.Status)
	}
	if !strings.Contains(result.Message, "Git リポジトリではありません") {
		t.Errorf("message = %q", result.Message)
	}
}

func TestPullRejectsPathOutsideRoot(t *testing.T) {
	runner, _ := newPullRunner(t)
	outside := t.TempDir()

	result := runner.Pull(context.Background(), "r1", "owner/repo", outside)
	if result.Status != protocol.StatusFailed {
		t.Fatalf("status = %q, want failed", result.Status)
	}
	if !strings.Contains(result.Message, "保存先の外") {
		t.Errorf("message = %q", result.Message)
	}
}

func TestDiscoverRepositoriesFindsOwnerRepoLayout(t *testing.T) {
	bare := makeUpstream(t)
	runner, root := newPullRunner(t)

	makeWorkingClone(t, bare, root, "alpha", "one")
	makeWorkingClone(t, bare, root, "beta", "two")

	found, err := runner.DiscoverRepositories()
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	if len(found) != 2 {
		t.Fatalf("found %d repositories, want 2: %+v", len(found), found)
	}

	specs := map[string]bool{}
	for _, item := range found {
		specs[item.Spec] = true
		if !validate.IsGitRepo(item.Path) {
			t.Errorf("%s is not a repository", item.Path)
		}
	}
	for _, want := range []string{"alpha/one", "beta/two"} {
		if !specs[want] {
			t.Errorf("missing %q in %v", want, specs)
		}
	}
}

func TestDiscoverRepositoriesSkipsNestedAndNoise(t *testing.T) {
	bare := makeUpstream(t)
	runner, root := newPullRunner(t)

	target := makeWorkingClone(t, bare, root, "owner", "repo")

	// A nested checkout inside the repository must not be reported twice.
	nested := filepath.Join(target, "vendor", "inner")
	if err := os.MkdirAll(filepath.Dir(nested), 0o755); err != nil {
		t.Fatal(err)
	}
	runGit(t, target, "clone", bare, nested)

	// node_modules is skipped entirely.
	if err := os.MkdirAll(filepath.Join(root, "node_modules", "pkg", ".git"), 0o755); err != nil {
		t.Fatal(err)
	}

	found, err := runner.DiscoverRepositories()
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	if len(found) != 1 {
		t.Fatalf("found %d repositories, want 1: %+v", len(found), found)
	}
	if found[0].Spec != "owner/repo" {
		t.Fatalf("spec = %q, want owner/repo", found[0].Spec)
	}
}

func TestDiscoverRepositoriesEmptyRoot(t *testing.T) {
	runner, _ := newPullRunner(t)

	found, err := runner.DiscoverRepositories()
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	if len(found) != 0 {
		t.Fatalf("found %d repositories in an empty root", len(found))
	}
}

func TestDescribePullProducesActionableMessages(t *testing.T) {
	cases := map[string]string{
		"fatal: Not possible to fast-forward, aborting.": "競合するため pull しませんでした",
		"fatal: Authentication failed":                   "認証に失敗しました",
		"fatal: could not resolve host: github.com":      "ネットワークに接続できません",
	}
	for output, want := range cases {
		got := describePull(&toolError{err: os.ErrInvalid, output: output})
		if !strings.Contains(got, want) {
			t.Errorf("describePull(%q) = %q, want it to contain %q", output, got, want)
		}
	}
}

func TestShortSHA(t *testing.T) {
	if got := shortSHA("0123456789abcdef"); got != "0123456" {
		t.Errorf("shortSHA = %q", got)
	}
	if got := shortSHA("abc"); got != "abc" {
		t.Errorf("shortSHA short input = %q", got)
	}
}
