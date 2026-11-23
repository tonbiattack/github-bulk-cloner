package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tonbiattack/github-bulk-cloner/native-host/internal/protocol"
)

// gitEnv is the identity used for test commits.
func gitEnv() []string {
	return append(os.Environ(),
		"GIT_AUTHOR_NAME=test", "GIT_AUTHOR_EMAIL=test@example.com",
		"GIT_COMMITTER_NAME=test", "GIT_COMMITTER_EMAIL=test@example.com",
	)
}

// git runs a git command in dir and fails the test on error.
func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = gitEnv()
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

// initRepoWithCommit creates a Git repository at dir with one commit and no
// remote. Pulling it fails, which is what the failure-path tests need.
func initRepoWithCommit(t *testing.T, dir string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not available")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	git(t, dir, "init", "-b", "main")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("a\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git(t, dir, "add", ".")
	git(t, dir, "commit", "-m", "init")
}

// initRepoWithUpstream creates a bare upstream and a working clone at dir that
// tracks it, so a pull can succeed.
func initRepoWithUpstream(t *testing.T, dir string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not available")
	}

	base := t.TempDir()
	bare := filepath.Join(base, "upstream.git")
	git(t, base, "init", "--bare", "-b", "main", bare)

	seed := filepath.Join(base, "seed")
	git(t, base, "clone", bare, seed)
	git(t, seed, "checkout", "-b", "main")
	if err := os.WriteFile(filepath.Join(seed, "a.txt"), []byte("a\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git(t, seed, "add", ".")
	git(t, seed, "commit", "-m", "init")
	git(t, seed, "push", "-u", "origin", "main")

	if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
		t.Fatal(err)
	}
	git(t, base, "clone", bare, dir)
}

func TestServePullDiscoversRepositories(t *testing.T) {
	root := t.TempDir()
	initRepoWithUpstream(t, filepath.Join(root, "alpha", "one"))
	initRepoWithUpstream(t, filepath.Join(root, "beta", "two"))

	msgs := runServe(t, protocol.Request{
		Type:      protocol.TypePull,
		RequestID: "p1",
		Root:      root,
	})

	// Two repositories plus the done frame.
	if len(msgs) != 3 {
		t.Fatalf("got %d messages, want 3: %v", len(msgs), msgs)
	}

	seen := map[string]bool{}
	for _, msg := range msgs[:2] {
		if msg["type"] != protocol.TypeResult {
			t.Fatalf("expected result, got %v", msg["type"])
		}
		seen[msg["repository"].(string)] = true
	}
	for _, want := range []string{"alpha/one", "beta/two"} {
		if !seen[want] {
			t.Errorf("missing %q in results: %v", want, seen)
		}
	}

	if msgs[2]["type"] != protocol.TypeDone {
		t.Fatalf("last message type = %v, want done", msgs[2]["type"])
	}
}

func TestServePullReportsNothingToPull(t *testing.T) {
	root := t.TempDir()

	msgs := runServe(t, protocol.Request{
		Type:      protocol.TypePull,
		RequestID: "p1",
		Root:      root,
	})

	if len(msgs) != 1 {
		t.Fatalf("got %d messages, want 1: %v", len(msgs), msgs)
	}
	if msgs[0]["type"] != protocol.TypeError {
		t.Fatalf("type = %v, want error", msgs[0]["type"])
	}
	if msgs[0]["code"] != "nothing_to_pull" {
		t.Fatalf("code = %v, want nothing_to_pull", msgs[0]["code"])
	}
}

func TestServePullRejectsInvalidRoot(t *testing.T) {
	msgs := runServe(t, protocol.Request{
		Type:      protocol.TypePull,
		RequestID: "p1",
		Root:      filepath.Join(t.TempDir(), "missing"),
	})
	if len(msgs) != 1 || msgs[0]["code"] != "invalid_root" {
		t.Fatalf("unexpected response: %v", msgs)
	}
}

func TestServePullRejectsMissingRequestID(t *testing.T) {
	msgs := runServe(t, protocol.Request{
		Type: protocol.TypePull,
		Root: t.TempDir(),
	})
	if len(msgs) != 1 || msgs[0]["code"] != "invalid_request" {
		t.Fatalf("unexpected response: %v", msgs)
	}
}

func TestServePullNamedRepositories(t *testing.T) {
	root := t.TempDir()
	initRepoWithUpstream(t, filepath.Join(root, "alpha", "one"))
	initRepoWithUpstream(t, filepath.Join(root, "beta", "two"))

	// Only the named repository should be pulled.
	msgs := runServe(t, protocol.Request{
		Type:         protocol.TypePull,
		RequestID:    "p1",
		Root:         root,
		Repositories: []string{"alpha/one"},
	})

	if len(msgs) != 2 {
		t.Fatalf("got %d messages, want result + done: %v", len(msgs), msgs)
	}
	if msgs[0]["repository"] != "alpha/one" {
		t.Fatalf("repository = %v, want alpha/one", msgs[0]["repository"])
	}
}

func TestServePullKeepsGoingAfterFailure(t *testing.T) {
	root := t.TempDir()
	initRepoWithUpstream(t, filepath.Join(root, "alpha", "one"))

	// A non-repository directory must fail without stopping the run.
	if err := os.MkdirAll(filepath.Join(root, "beta", "plain"), 0o755); err != nil {
		t.Fatal(err)
	}

	msgs := runServe(t, protocol.Request{
		Type:         protocol.TypePull,
		RequestID:    "p1",
		Root:         root,
		Repositories: []string{"beta/plain", "alpha/one"},
	})

	var statuses []string
	for _, msg := range msgs {
		if msg["type"] == protocol.TypeResult {
			statuses = append(statuses, msg["status"].(string))
		}
	}
	if len(statuses) != 2 {
		t.Fatalf("got %d results, want 2: %v", len(statuses), statuses)
	}
	if statuses[0] != protocol.StatusFailed {
		t.Errorf("first status = %q, want failed", statuses[0])
	}
	if statuses[1] != protocol.StatusUpToDate {
		t.Errorf("second status = %q, want up-to-date", statuses[1])
	}
}

func TestServePullSummaryCounts(t *testing.T) {
	root := t.TempDir()
	initRepoWithUpstream(t, filepath.Join(root, "alpha", "one"))

	msgs := runServe(t, protocol.Request{
		Type:      protocol.TypePull,
		RequestID: "p1",
		Root:      root,
	})

	done := msgs[len(msgs)-1]
	summary, ok := done["summary"].(map[string]any)
	if !ok {
		t.Fatalf("done has no summary: %v", done)
	}
	if summary["upToDate"] != float64(1) {
		t.Fatalf("summary.upToDate = %v, want 1", summary["upToDate"])
	}
}

func TestServeStillHandlesClone(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "owner", "repo"), 0o755); err != nil {
		t.Fatal(err)
	}

	msgs := runServe(t, protocol.Request{
		Type:         protocol.TypeClone,
		RequestID:    "c1",
		Root:         root,
		Repositories: []string{"owner/repo"},
	})
	if len(msgs) != 2 || msgs[0]["status"] != protocol.StatusSkipped {
		t.Fatalf("clone path regressed: %v", msgs)
	}
}

func TestServePullHonoursCancellation(t *testing.T) {
	root := t.TempDir()
	initRepoWithUpstream(t, filepath.Join(root, "alpha", "one"))

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	// A cancelled context must not panic and must report cancellation.
	msgs := runServeWithContext(t, ctx, protocol.Request{
		Type:      protocol.TypePull,
		RequestID: "p1",
		Root:      root,
	})
	if len(msgs) == 0 {
		t.Fatal("expected at least one message")
	}
	if msgs[0]["code"] != "cancelled" {
		t.Fatalf("code = %v, want cancelled", msgs[0]["code"])
	}
}
