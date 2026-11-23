package clone

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/tonbiattack/github-bulk-cloner/native-host/internal/protocol"
	"github.com/tonbiattack/github-bulk-cloner/native-host/internal/validate"
)

func newRunner(t *testing.T) (*Runner, string) {
	t.Helper()
	root := t.TempDir()
	real, err := validate.Root(root)
	if err != nil {
		t.Fatalf("root: %v", err)
	}
	return &Runner{Root: real, Timeout: 30 * time.Second, Log: &bytes.Buffer{}}, real
}

func TestCloneRejectsInvalidSpecBeforeRunning(t *testing.T) {
	runner, root := newRunner(t)

	for _, spec := range []string{"", "owner", "owner/repo/extra", "../escape", "owner/-repo"} {
		result := runner.Clone(context.Background(), "r1", spec)
		if result.Status != protocol.StatusFailed {
			t.Errorf("Clone(%q) status = %q, want failed", spec, result.Status)
		}
		if result.Message == "" {
			t.Errorf("Clone(%q) should explain the failure", spec)
		}
	}

	// Nothing may have been created for a rejected spec.
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("rejected specs created entries: %v", entries)
	}
}

func TestCloneSkipsExistingDirectory(t *testing.T) {
	runner, root := newRunner(t)

	target := filepath.Join(root, "owner", "repo")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(target, "keep.txt")
	if err := os.WriteFile(marker, []byte("do not touch"), 0o644); err != nil {
		t.Fatal(err)
	}

	result := runner.Clone(context.Background(), "r1", "owner/repo")
	if result.Status != protocol.StatusSkipped {
		t.Fatalf("status = %q, want skipped (%s)", result.Status, result.Message)
	}
	if result.ExistingGitRepo == nil || *result.ExistingGitRepo {
		t.Fatalf("existingGitRepo = %v, want false", result.ExistingGitRepo)
	}

	// The existing content must be untouched.
	data, err := os.ReadFile(marker)
	if err != nil {
		t.Fatalf("existing file was removed: %v", err)
	}
	if string(data) != "do not touch" {
		t.Fatalf("existing file was modified: %q", data)
	}
}

func TestCloneSkipsExistingGitRepo(t *testing.T) {
	runner, root := newRunner(t)

	target := filepath.Join(root, "owner", "repo")
	if err := os.MkdirAll(filepath.Join(target, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}

	result := runner.Clone(context.Background(), "r1", "owner/repo")
	if result.Status != protocol.StatusSkipped {
		t.Fatalf("status = %q, want skipped", result.Status)
	}
	if result.ExistingGitRepo == nil || !*result.ExistingGitRepo {
		t.Fatalf("existingGitRepo = %v, want true", result.ExistingGitRepo)
	}
}

func TestCloneReportsMissingGit(t *testing.T) {
	runner, _ := newRunner(t)
	runner.GitPath = filepath.Join(t.TempDir(), "definitely-not-git")

	if err := runner.CheckTools(); err == nil {
		t.Fatal("CheckTools should fail when git is absent")
	}
}

func TestTargetPathDoesNotTouchDisk(t *testing.T) {
	runner, root := newRunner(t)

	got, err := runner.TargetPath("owner/repo")
	if err != nil {
		t.Fatalf("TargetPath: %v", err)
	}
	want := filepath.Join(root, "owner", "repo")
	if got != want {
		t.Fatalf("TargetPath = %q, want %q", got, want)
	}
	if _, err := os.Stat(filepath.Join(root, "owner")); !os.IsNotExist(err) {
		t.Fatal("TargetPath must not create directories")
	}
}

func TestSanitizeRedactsCredentials(t *testing.T) {
	cases := map[string]string{
		"https://user:token@github.com/o/r.git": "https://***@github.com/o/r.git",
		"fatal: https://ghp_secret@github.com/o/r": "fatal: https://***@github.com/o/r",
	}
	for in, want := range cases {
		if got := sanitize(in); got != want {
			t.Errorf("sanitize(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSanitizeCapsLength(t *testing.T) {
	got := sanitize(strings.Repeat("x", maxMessageLen*2))
	if len(got) > maxMessageLen+len("…") {
		t.Fatalf("sanitize did not cap length: %d", len(got))
	}
}

func TestSanitizeCollapsesWhitespace(t *testing.T) {
	if got := sanitize("a\n\tb   c"); got != "a b c" {
		t.Fatalf("sanitize = %q, want %q", got, "a b c")
	}
}

func TestIsAuthFailure(t *testing.T) {
	auth := &toolError{err: os.ErrPermission, output: "fatal: Authentication failed for 'https://github.com/o/r'"}
	if !isAuthFailure(auth) {
		t.Error("authentication failure not detected")
	}
	notAuth := &toolError{err: os.ErrPermission, output: "fatal: destination path already exists"}
	if isAuthFailure(notAuth) {
		t.Error("non-auth failure misdetected as auth failure")
	}
	if isAuthFailure(os.ErrNotExist) {
		t.Error("plain error misdetected as auth failure")
	}
}

func TestDescribeProducesActionableMessages(t *testing.T) {
	cases := map[string]string{
		"fatal: repository 'https://github.com/o/r/' not found": "リポジトリが見つかりません",
		"fatal: Authentication failed":                          "認証に失敗しました",
		"fatal: could not resolve host: github.com":             "ネットワークに接続できません",
		"GraphQL: Could not resolve to a Repository with the name 'o/r'.": "リポジトリが見つかりません",
	}
	for output, want := range cases {
		got := describe(&toolError{err: os.ErrInvalid, output: output})
		if !strings.Contains(got, want) {
			t.Errorf("describe(%q) = %q, want it to contain %q", output, got, want)
		}
	}
}

// TestCloneRealRepository performs an actual clone when the environment allows
// it. It is skipped in short mode and when git or the network is unavailable.
func TestCloneRealRepository(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping network clone in short mode")
	}
	if runtime.GOOS != "windows" && os.Getenv("CI") == "" {
		t.Skip("real clone test targets the Windows MVP")
	}

	runner, root := newRunner(t)
	if err := runner.CheckTools(); err != nil {
		t.Skipf("git unavailable: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	result := runner.Clone(ctx, "real", "octocat/Hello-World")
	if result.Status != protocol.StatusSuccess {
		t.Skipf("network clone unavailable: %s (%s)", result.Status, result.Message)
	}
	if !validate.IsGitRepo(result.Path) {
		t.Fatalf("clone reported success but %q is not a Git repository", result.Path)
	}
	if !validate.Contains(root, result.Path) {
		t.Fatalf("clone landed outside root: %q", result.Path)
	}

	// A second run must skip rather than overwrite.
	again := runner.Clone(ctx, "real", "octocat/Hello-World")
	if again.Status != protocol.StatusSkipped {
		t.Fatalf("second clone status = %q, want skipped", again.Status)
	}
	if again.ExistingGitRepo == nil || !*again.ExistingGitRepo {
		t.Fatalf("second clone existingGitRepo = %v, want true", again.ExistingGitRepo)
	}
}
