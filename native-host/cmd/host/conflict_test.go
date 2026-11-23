package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tonbiattack/github-bulk-cloner/native-host/internal/protocol"
)

// makeRepoWithRemote creates a Git repository whose origin points at spec.
func makeRepoWithRemote(t *testing.T, dir, spec string) {
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

func TestServeReportsConflictInSummary(t *testing.T) {
	root := t.TempDir()
	// ownerA/tool already owns the flat destination.
	makeRepoWithRemote(t, filepath.Join(root, "tool"), "ownerA/tool")

	msgs := runServe(t, protocol.Request{
		Type:         protocol.TypeClone,
		RequestID:    "c1",
		Root:         root,
		Repositories: []string{"ownerB/tool"},
	})

	if len(msgs) != 2 {
		t.Fatalf("got %d messages, want result + done: %v", len(msgs), msgs)
	}
	if msgs[0]["status"] != protocol.StatusConflict {
		t.Fatalf("status = %v, want conflict", msgs[0]["status"])
	}
	if msgs[0]["existingRepository"] != "ownerA/tool" {
		t.Errorf("existingRepository = %v, want ownerA/tool", msgs[0]["existingRepository"])
	}

	summary, ok := msgs[1]["summary"].(map[string]any)
	if !ok {
		t.Fatalf("done has no summary: %v", msgs[1])
	}
	if summary["conflict"] != float64(1) {
		t.Errorf("summary.conflict = %v, want 1", summary["conflict"])
	}
	if summary["skipped"] != float64(0) {
		t.Errorf("summary.skipped = %v, want 0; a conflict must not count as skipped", summary["skipped"])
	}
}

func TestServeRejectsInvalidLayout(t *testing.T) {
	root := t.TempDir()
	msgs := runServe(t, protocol.Request{
		Type:         protocol.TypeClone,
		RequestID:    "c1",
		Root:         root,
		Layout:       "bogus",
		Repositories: []string{"owner/repo"},
	})
	if len(msgs) != 1 || msgs[0]["code"] != "invalid_layout" {
		t.Fatalf("unexpected response: %v", msgs)
	}
}

func TestServeOwnerLayoutSeparatesSameName(t *testing.T) {
	root := t.TempDir()
	makeRepoWithRemote(t, filepath.Join(root, "ownerA", "tool"), "ownerA/tool")

	msgs := runServe(t, protocol.Request{
		Type:         protocol.TypeClone,
		RequestID:    "c1",
		Root:         root,
		Layout:       protocol.LayoutOwner,
		Repositories: []string{"ownerA/tool"},
	})
	if len(msgs) != 2 {
		t.Fatalf("got %d messages, want result + done", len(msgs))
	}
	if msgs[0]["status"] != protocol.StatusSkipped {
		t.Fatalf("status = %v, want skipped", msgs[0]["status"])
	}
	// The path must be the owner-nested one.
	wantPath := filepath.Join(root, "ownerA", "tool")
	if msgs[0]["path"] != wantPath {
		t.Errorf("path = %v, want %v", msgs[0]["path"], wantPath)
	}
}

// TestServePingReportsCapabilities covers the diagnostics contract: the host
// reports what it can actually observe, not guesses.
func TestServePingReportsCapabilities(t *testing.T) {
	msgs := runServe(t, protocol.Request{Type: protocol.TypePing})

	if len(msgs) != 1 {
		t.Fatalf("got %d messages, want 1", len(msgs))
	}
	if msgs[0]["type"] != protocol.TypePong {
		t.Fatalf("type = %v, want pong", msgs[0]["type"])
	}
	if msgs[0]["version"] == "" {
		t.Error("pong should carry a version")
	}

	caps, ok := msgs[0]["capabilities"].(map[string]any)
	if !ok {
		t.Fatalf("pong has no capabilities: %v", msgs[0])
	}
	// git is present in this environment, so the probe must see it.
	if caps["gitAvailable"] != true {
		t.Errorf("capabilities.gitAvailable = %v, want true", caps["gitAvailable"])
	}
	if caps["os"] == "" {
		t.Error("capabilities.os should be set")
	}
	if caps["arch"] == "" {
		t.Error("capabilities.arch should be set")
	}
}
