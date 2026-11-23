package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tonbiattack/github-bulk-cloner/native-host/internal/protocol"
)

// encode builds a length-prefixed frame for a request.
func encode(t *testing.T, v any) []byte {
	t.Helper()
	payload, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	buf := make([]byte, 4+len(payload))
	binary.LittleEndian.PutUint32(buf[:4], uint32(len(payload)))
	copy(buf[4:], payload)
	return buf
}

// decodeAll reads every frame the host wrote.
func decodeAll(t *testing.T, raw []byte) []map[string]any {
	t.Helper()
	var out []map[string]any
	r := protocol.NewReader(bytes.NewReader(raw))
	for {
		payload, err := r.ReadFrame()
		if err == io.EOF {
			return out
		}
		if err != nil {
			t.Fatalf("read frame: %v", err)
		}
		var msg map[string]any
		if err := json.Unmarshal(payload, &msg); err != nil {
			t.Fatalf("unmarshal frame: %v", err)
		}
		out = append(out, msg)
	}
}

func runServe(t *testing.T, requests ...any) []map[string]any {
	t.Helper()
	return runServeWithContext(t, context.Background(), requests...)
}

// runServeWithContext runs the request loop with a caller-supplied context.
func runServeWithContext(t *testing.T, ctx context.Context, requests ...any) []map[string]any {
	t.Helper()
	var stdin bytes.Buffer
	for _, req := range requests {
		stdin.Write(encode(t, req))
	}
	var stdout, stderr bytes.Buffer
	if err := serve(ctx, &stdin, &stdout, &stderr); err != nil {
		t.Fatalf("serve: %v (stderr: %s)", err, stderr.String())
	}
	return decodeAll(t, stdout.Bytes())
}

func TestServeAnswersPing(t *testing.T) {
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
}

func TestServeRejectsUnknownType(t *testing.T) {
	msgs := runServe(t, protocol.Request{Type: "delete-everything", RequestID: "r1"})
	if len(msgs) != 1 {
		t.Fatalf("got %d messages, want 1", len(msgs))
	}
	if msgs[0]["type"] != protocol.TypeError {
		t.Fatalf("type = %v, want error", msgs[0]["type"])
	}
	if msgs[0]["code"] != "unsupported_type" {
		t.Fatalf("code = %v, want unsupported_type", msgs[0]["code"])
	}
}

func TestServeRejectsCloneWithoutRequestID(t *testing.T) {
	msgs := runServe(t, protocol.Request{
		Type:         protocol.TypeClone,
		Root:         t.TempDir(),
		Repositories: []string{"owner/repo"},
	})
	if len(msgs) != 1 || msgs[0]["code"] != "invalid_request" {
		t.Fatalf("unexpected response: %v", msgs)
	}
}

func TestServeRejectsCloneWithoutRepositories(t *testing.T) {
	msgs := runServe(t, protocol.Request{
		Type:      protocol.TypeClone,
		RequestID: "r1",
		Root:      t.TempDir(),
	})
	if len(msgs) != 1 || msgs[0]["code"] != "invalid_request" {
		t.Fatalf("unexpected response: %v", msgs)
	}
}

func TestServeRejectsTooManyRepositories(t *testing.T) {
	repos := make([]string, maxRepositories+1)
	for i := range repos {
		repos[i] = "owner/repo"
	}
	msgs := runServe(t, protocol.Request{
		Type:         protocol.TypeClone,
		RequestID:    "r1",
		Root:         t.TempDir(),
		Repositories: repos,
	})
	if len(msgs) != 1 || msgs[0]["code"] != "too_many_repositories" {
		t.Fatalf("unexpected response: %v", msgs)
	}
}

// TestServeCreatesMissingRoot covers the case where the user points at a
// folder that does not exist yet: the host creates it and proceeds.
func TestServeCreatesMissingRoot(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "does-not-exist")

	msgs := runServe(t, protocol.Request{
		Type:         protocol.TypeClone,
		RequestID:    "r1",
		Root:         root,
		Repositories: []string{"owner/repo"},
	})

	// The root is created, so the request proceeds to the clone attempt. The
	// repository does not exist, so the result is a failure rather than an
	// invalid_root error.
	if len(msgs) == 0 {
		t.Fatal("expected a response")
	}
	if msgs[0]["type"] == protocol.TypeError && msgs[0]["code"] == "invalid_root" {
		t.Fatalf("missing root should be created, got invalid_root: %v", msgs)
	}
	if info, err := os.Stat(root); err != nil || !info.IsDir() {
		t.Fatalf("root was not created: %v", err)
	}
}

func TestServeRejectsFileAsRoot(t *testing.T) {
	file := filepath.Join(t.TempDir(), "file.txt")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	msgs := runServe(t, protocol.Request{
		Type:         protocol.TypeClone,
		RequestID:    "r1",
		Root:         file,
		Repositories: []string{"owner/repo"},
	})
	if len(msgs) != 1 || msgs[0]["code"] != "invalid_root" {
		t.Fatalf("unexpected response: %v", msgs)
	}
}

func TestServeRejectsRelativeRoot(t *testing.T) {
	msgs := runServe(t, protocol.Request{
		Type:         protocol.TypeClone,
		RequestID:    "r1",
		Root:         "relative",
		Repositories: []string{"owner/repo"},
	})
	if len(msgs) != 1 || msgs[0]["code"] != "invalid_root" {
		t.Fatalf("unexpected response: %v", msgs)
	}
}

// TestServeSkipsExistingAndReportsDone exercises the full request path without
// touching the network: the only repository already exists on disk.
func TestServeSkipsExistingAndReportsDone(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "repo"), 0o755); err != nil {
		t.Fatal(err)
	}

	msgs := runServe(t, protocol.Request{
		Type:         protocol.TypeClone,
		RequestID:    "r1",
		Root:         root,
		Repositories: []string{"owner/repo"},
	})

	if len(msgs) != 2 {
		t.Fatalf("got %d messages, want result + done: %v", len(msgs), msgs)
	}
	if msgs[0]["type"] != protocol.TypeResult {
		t.Fatalf("first message type = %v, want result", msgs[0]["type"])
	}
	if msgs[0]["status"] != protocol.StatusSkipped {
		t.Fatalf("status = %v, want skipped", msgs[0]["status"])
	}
	if msgs[1]["type"] != protocol.TypeDone {
		t.Fatalf("second message type = %v, want done", msgs[1]["type"])
	}
	summary, ok := msgs[1]["summary"].(map[string]any)
	if !ok {
		t.Fatalf("done has no summary: %v", msgs[1])
	}
	if summary["skipped"] != float64(1) {
		t.Fatalf("summary.skipped = %v, want 1", summary["skipped"])
	}
}

// TestServeDeduplicatesRepositories checks that a repeated spec is cloned once.
func TestServeDeduplicatesRepositories(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "repo"), 0o755); err != nil {
		t.Fatal(err)
	}

	msgs := runServe(t, protocol.Request{
		Type:         protocol.TypeClone,
		RequestID:    "r1",
		Root:         root,
		Repositories: []string{"owner/repo", "owner/repo", "owner/repo"},
	})

	results := 0
	for _, msg := range msgs {
		if msg["type"] == protocol.TypeResult {
			results++
		}
	}
	if results != 1 {
		t.Fatalf("got %d results, want 1 after deduplication", results)
	}
}

// TestServeKeepsGoingAfterFailure verifies that one bad spec does not stop the
// remaining repositories.
func TestServeKeepsGoingAfterFailure(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "good"), 0o755); err != nil {
		t.Fatal(err)
	}

	msgs := runServe(t, protocol.Request{
		Type:         protocol.TypeClone,
		RequestID:    "r1",
		Root:         root,
		Repositories: []string{"../bad", "owner/good"},
	})

	var statuses []string
	for _, msg := range msgs {
		if msg["type"] == protocol.TypeResult {
			statuses = append(statuses, msg["status"].(string))
		}
	}
	want := []string{protocol.StatusFailed, protocol.StatusSkipped}
	if strings.Join(statuses, ",") != strings.Join(want, ",") {
		t.Fatalf("statuses = %v, want %v", statuses, want)
	}
}

func TestServeStopsCleanlyOnEOF(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if err := serve(context.Background(), bytes.NewReader(nil), &stdout, &stderr); err != nil {
		t.Fatalf("serve on empty stdin: %v", err)
	}
	if stdout.Len() != 0 {
		t.Fatalf("empty stdin produced output: %q", stdout.String())
	}
}

func TestServeFailsOnMalformedFrame(t *testing.T) {
	var stdout, stderr bytes.Buffer
	err := serve(context.Background(), strings.NewReader("garbage"), &stdout, &stderr)
	if err == nil {
		t.Fatal("malformed input should return an error")
	}
}
