// Package protocol implements the Chrome Native Messaging wire format:
// a 4-byte little-endian length prefix followed by a UTF-8 JSON document.
//
// stdout carries protocol frames only. Diagnostics must go to stderr.
package protocol

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
)

// MaxMessageSize caps a single inbound frame. Chrome itself allows up to 1 MiB
// from the extension, so anything larger is treated as a protocol violation.
const MaxMessageSize = 1 << 20

// Message types accepted from the extension.
const (
	TypeClone = "clone"
	TypePull  = "pull"
	TypePing  = "ping"
)

// Message types sent to the extension.
const (
	TypeResult = "result"
	TypeDone   = "done"
	TypeError  = "error"
	TypePong   = "pong"
)

// Clone statuses reported per repository.
const (
	StatusSuccess = "success"
	StatusSkipped = "skipped"
	StatusFailed  = "failed"
)

// Pull statuses reported per repository.
const (
	// StatusUpdated means the pull brought in new commits.
	StatusUpdated = "updated"
	// StatusUpToDate means the repository was already current.
	StatusUpToDate = "up-to-date"
)

// Request is an inbound message. Only the fields relevant to Type are used.
//
// For TypePull, Repositories may be empty, in which case the host discovers
// every Git repository under Root and pulls each one.
type Request struct {
	Type         string   `json:"type"`
	RequestID    string   `json:"requestId"`
	Root         string   `json:"root"`
	Repositories []string `json:"repositories"`
}

// Result reports the outcome for a single repository.
type Result struct {
	Type            string `json:"type"`
	RequestID       string `json:"requestId"`
	Repository      string `json:"repository"`
	Status          string `json:"status"`
	Path            string `json:"path,omitempty"`
	Message         string `json:"message,omitempty"`
	Method          string `json:"method,omitempty"`
	ExistingGitRepo *bool  `json:"existingGitRepo,omitempty"`
}

// Summary counts the outcomes of a finished request. Clone runs use Success,
// Skipped, and Failed; pull runs use Updated, UpToDate, and Failed.
type Summary struct {
	Success  int `json:"success"`
	Skipped  int `json:"skipped"`
	Failed   int `json:"failed"`
	Updated  int `json:"updated,omitempty"`
	UpToDate int `json:"upToDate,omitempty"`
}

// Done terminates a request.
type Done struct {
	Type      string  `json:"type"`
	RequestID string  `json:"requestId"`
	Summary   Summary `json:"summary"`
}

// Error reports a request-level failure (bad payload, unusable root, ...).
type Error struct {
	Type      string `json:"type"`
	RequestID string `json:"requestId"`
	Code      string `json:"code"`
	Message   string `json:"message"`
}

// Pong answers a ping, used by the installer to prove the host is reachable.
type Pong struct {
	Type    string `json:"type"`
	Version string `json:"version"`
}

// ErrMessageTooLarge is returned when a frame exceeds MaxMessageSize.
var ErrMessageTooLarge = errors.New("protocol: message exceeds maximum size")

// Reader decodes length-prefixed frames from a stream.
type Reader struct {
	r io.Reader
}

// NewReader wraps r.
func NewReader(r io.Reader) *Reader { return &Reader{r: r} }

// ReadFrame returns the next raw JSON payload. It returns io.EOF cleanly when
// the stream ends on a frame boundary.
func (r *Reader) ReadFrame() ([]byte, error) {
	var header [4]byte
	if _, err := io.ReadFull(r.r, header[:]); err != nil {
		return nil, err
	}
	size := binary.LittleEndian.Uint32(header[:])
	if size == 0 {
		return nil, errors.New("protocol: empty frame")
	}
	if size > MaxMessageSize {
		return nil, fmt.Errorf("%w: %d bytes", ErrMessageTooLarge, size)
	}
	payload := make([]byte, size)
	if _, err := io.ReadFull(r.r, payload); err != nil {
		return nil, fmt.Errorf("protocol: truncated frame: %w", err)
	}
	return payload, nil
}

// ReadRequest decodes the next frame into a Request.
func (r *Reader) ReadRequest() (Request, error) {
	var req Request
	payload, err := r.ReadFrame()
	if err != nil {
		return req, err
	}
	if err := json.Unmarshal(payload, &req); err != nil {
		return req, fmt.Errorf("protocol: invalid JSON: %w", err)
	}
	return req, nil
}

// Writer encodes length-prefixed frames. It is safe for concurrent use so a
// future concurrent runner cannot interleave partial frames.
type Writer struct {
	mu sync.Mutex
	w  io.Writer
}

// NewWriter wraps w.
func NewWriter(w io.Writer) *Writer { return &Writer{w: w} }

// WriteFrame writes one JSON payload with its length prefix.
func (w *Writer) WriteFrame(payload []byte) error {
	if len(payload) > MaxMessageSize {
		return fmt.Errorf("%w: %d bytes", ErrMessageTooLarge, len(payload))
	}
	frame := make([]byte, 4+len(payload))
	binary.LittleEndian.PutUint32(frame[:4], uint32(len(payload)))
	copy(frame[4:], payload)

	w.mu.Lock()
	defer w.mu.Unlock()
	_, err := w.w.Write(frame)
	return err
}

// Write marshals v and writes it as a single frame.
func (w *Writer) Write(v any) error {
	payload, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("protocol: marshal: %w", err)
	}
	return w.WriteFrame(payload)
}
