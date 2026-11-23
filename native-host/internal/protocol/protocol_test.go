package protocol

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
)

func frame(payload string) []byte {
	buf := make([]byte, 4+len(payload))
	binary.LittleEndian.PutUint32(buf[:4], uint32(len(payload)))
	copy(buf[4:], payload)
	return buf
}

func TestReaderDecodesFrames(t *testing.T) {
	stream := bytes.Join([][]byte{
		frame(`{"type":"ping"}`),
		frame(`{"type":"clone","requestId":"r1","root":"C:\\apps","repositories":["a/b"]}`),
	}, nil)

	r := NewReader(bytes.NewReader(stream))

	first, err := r.ReadRequest()
	if err != nil {
		t.Fatalf("first frame: %v", err)
	}
	if first.Type != TypePing {
		t.Fatalf("type = %q, want %q", first.Type, TypePing)
	}

	second, err := r.ReadRequest()
	if err != nil {
		t.Fatalf("second frame: %v", err)
	}
	if second.RequestID != "r1" || second.Root != `C:\apps` {
		t.Fatalf("unexpected request: %+v", second)
	}
	if len(second.Repositories) != 1 || second.Repositories[0] != "a/b" {
		t.Fatalf("unexpected repositories: %v", second.Repositories)
	}

	if _, err := r.ReadRequest(); !errors.Is(err, io.EOF) {
		t.Fatalf("want io.EOF at end of stream, got %v", err)
	}
}

func TestReaderRejectsOversizedFrame(t *testing.T) {
	var header [4]byte
	binary.LittleEndian.PutUint32(header[:], MaxMessageSize+1)

	_, err := NewReader(bytes.NewReader(header[:])).ReadFrame()
	if !errors.Is(err, ErrMessageTooLarge) {
		t.Fatalf("want ErrMessageTooLarge, got %v", err)
	}
}

func TestReaderRejectsEmptyFrame(t *testing.T) {
	var header [4]byte
	if _, err := NewReader(bytes.NewReader(header[:])).ReadFrame(); err == nil {
		t.Fatal("want error for zero-length frame")
	}
}

func TestReaderRejectsTruncatedFrame(t *testing.T) {
	stream := frame(`{"type":"ping"}`)
	_, err := NewReader(bytes.NewReader(stream[:len(stream)-3])).ReadFrame()
	if err == nil {
		t.Fatal("want error for truncated frame")
	}
}

func TestReaderRejectsInvalidJSON(t *testing.T) {
	_, err := NewReader(bytes.NewReader(frame(`{not json`))).ReadRequest()
	if err == nil {
		t.Fatal("want error for invalid JSON")
	}
}

func TestWriterRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	w := NewWriter(&buf)

	want := Result{
		Type:       TypeResult,
		RequestID:  "r1",
		Repository: "owner/repo",
		Status:     StatusSuccess,
		Path:       `C:\apps\owner\repo`,
	}
	if err := w.Write(want); err != nil {
		t.Fatalf("write: %v", err)
	}

	raw := buf.Bytes()
	if got := binary.LittleEndian.Uint32(raw[:4]); int(got) != len(raw)-4 {
		t.Fatalf("length prefix = %d, want %d", got, len(raw)-4)
	}

	var got Result
	if err := json.Unmarshal(raw[4:], &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got != want {
		t.Fatalf("round trip = %+v, want %+v", got, want)
	}
}

func TestWriterOmitsEmptyOptionalFields(t *testing.T) {
	var buf bytes.Buffer
	if err := NewWriter(&buf).Write(Result{Type: TypeResult, Status: StatusSuccess}); err != nil {
		t.Fatalf("write: %v", err)
	}
	body := buf.Bytes()[4:]
	for _, field := range []string{"message", "method", "existingGitRepo"} {
		if strings.Contains(string(body), `"`+field+`"`) {
			t.Errorf("optional field %q should be omitted, got %s", field, body)
		}
	}
}

func TestWriterRejectsOversizedPayload(t *testing.T) {
	var buf bytes.Buffer
	err := NewWriter(&buf).WriteFrame(bytes.Repeat([]byte("a"), MaxMessageSize+1))
	if !errors.Is(err, ErrMessageTooLarge) {
		t.Fatalf("want ErrMessageTooLarge, got %v", err)
	}
}

func TestWriterIsConcurrencySafe(t *testing.T) {
	var buf bytes.Buffer
	w := NewWriter(&buf)

	const writers = 8
	done := make(chan struct{}, writers)
	for i := 0; i < writers; i++ {
		go func() {
			defer func() { done <- struct{}{} }()
			_ = w.Write(Pong{Type: TypePong, Version: "test"})
		}()
	}
	for i := 0; i < writers; i++ {
		<-done
	}

	// Every frame must decode independently; interleaved writes would corrupt
	// the length prefixes.
	r := NewReader(bytes.NewReader(buf.Bytes()))
	for i := 0; i < writers; i++ {
		if _, err := r.ReadFrame(); err != nil {
			t.Fatalf("frame %d: %v", i, err)
		}
	}
	if _, err := r.ReadFrame(); !errors.Is(err, io.EOF) {
		t.Fatalf("want io.EOF after %d frames, got %v", writers, err)
	}
}
