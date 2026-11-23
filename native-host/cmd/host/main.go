// Command github-bulk-cloner-host is the Chrome Native Messaging host.
//
// It reads length-prefixed JSON requests on stdin and writes length-prefixed
// JSON responses on stdout. All diagnostics go to stderr, because stdout is
// reserved for the protocol.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"

	"github.com/tonbiattack/github-bulk-cloner/native-host/internal/clone"
	"github.com/tonbiattack/github-bulk-cloner/native-host/internal/protocol"
	"github.com/tonbiattack/github-bulk-cloner/native-host/internal/validate"
)

// version is overridden at build time with -ldflags "-X main.version=...".
var version = "dev"

// maxRepositories bounds a single request so one click cannot start an
// unbounded amount of work.
const maxRepositories = 200

func main() {
	// Chrome launches the host with the caller's origin as an argument. It is
	// informational only; the registry entry already restricts callers.
	_ = flag.String("parent-window", "", "parent window handle supplied by Chrome")
	showVersion := flag.Bool("version", false, "print the host version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Fprintln(os.Stderr, version)
		return
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := serve(ctx, os.Stdin, os.Stdout, os.Stderr); err != nil && !errors.Is(err, io.EOF) {
		fmt.Fprintf(os.Stderr, "host: %v\n", err)
		os.Exit(1)
	}
}

// serve runs the request loop until stdin closes.
func serve(ctx context.Context, stdin io.Reader, stdout, stderr io.Writer) error {
	reader := protocol.NewReader(stdin)
	writer := protocol.NewWriter(stdout)

	for {
		req, err := reader.ReadRequest()
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			// A malformed frame is unrecoverable: the stream is out of sync.
			return err
		}

		switch req.Type {
		case protocol.TypePing:
			if err := writer.Write(protocol.Pong{Type: protocol.TypePong, Version: version}); err != nil {
				return err
			}
		case protocol.TypeClone:
			handleClone(ctx, writer, stderr, req)
		case protocol.TypePull:
			handlePull(ctx, writer, stderr, req)
		default:
			_ = writer.Write(protocol.Error{
				Type:      protocol.TypeError,
				RequestID: req.RequestID,
				Code:      "unsupported_type",
				Message:   fmt.Sprintf("未対応のメッセージ種別です: %q", req.Type),
			})
		}
	}
}

// handleClone validates the request, clones each repository in order, and
// reports a per-repository result followed by a summary.
func handleClone(ctx context.Context, writer *protocol.Writer, stderr io.Writer, req protocol.Request) {
	fail := func(code, message string) {
		_ = writer.Write(protocol.Error{
			Type:      protocol.TypeError,
			RequestID: req.RequestID,
			Code:      code,
			Message:   message,
		})
	}

	if req.RequestID == "" {
		fail("invalid_request", "requestId がありません")
		return
	}
	if len(req.Repositories) == 0 {
		fail("invalid_request", "リポジトリが選択されていません")
		return
	}
	if len(req.Repositories) > maxRepositories {
		fail("too_many_repositories", fmt.Sprintf("一度に指定できるのは %d 件までです", maxRepositories))
		return
	}

	root, err := validate.Root(req.Root)
	if err != nil {
		fail("invalid_root", err.Error())
		return
	}

	runner := &clone.Runner{Root: root, Log: stderr}
	if err := runner.CheckTools(); err != nil {
		fail("git_missing", err.Error())
		return
	}

	var summary protocol.Summary
	seen := make(map[string]bool, len(req.Repositories))

	for _, spec := range req.Repositories {
		if ctx.Err() != nil {
			fail("cancelled", "処理が中断されました")
			return
		}
		// Deduplicate defensively; the extension already normalises.
		if seen[spec] {
			continue
		}
		seen[spec] = true

		result := runner.Clone(ctx, req.RequestID, spec)
		switch result.Status {
		case protocol.StatusSuccess:
			summary.Success++
		case protocol.StatusSkipped:
			summary.Skipped++
		default:
			summary.Failed++
		}
		if err := writer.Write(result); err != nil {
			fmt.Fprintf(stderr, "host: cannot write result: %v\n", err)
			return
		}
	}

	_ = writer.Write(protocol.Done{
		Type:      protocol.TypeDone,
		RequestID: req.RequestID,
		Summary:   summary,
	})
}

// handlePull updates existing working trees under the clone root.
//
// When the request names repositories, only those are pulled. When it names
// none, every Git repository under the root is discovered and pulled, which is
// what the popup's "Pull all" button sends.
func handlePull(ctx context.Context, writer *protocol.Writer, stderr io.Writer, req protocol.Request) {
	fail := func(code, message string) {
		_ = writer.Write(protocol.Error{
			Type:      protocol.TypeError,
			RequestID: req.RequestID,
			Code:      code,
			Message:   message,
		})
	}

	if req.RequestID == "" {
		fail("invalid_request", "requestId がありません")
		return
	}
	if len(req.Repositories) > maxRepositories {
		fail("too_many_repositories", fmt.Sprintf("一度に指定できるのは %d 件までです", maxRepositories))
		return
	}

	root, err := validate.Root(req.Root)
	if err != nil {
		fail("invalid_root", err.Error())
		return
	}

	runner := &clone.Runner{Root: root, Log: stderr}
	if err := runner.CheckTools(); err != nil {
		fail("git_missing", err.Error())
		return
	}

	targets, err := pullTargets(runner, req.Repositories)
	if err != nil {
		fail("invalid_root", err.Error())
		return
	}
	if len(targets) == 0 {
		fail("nothing_to_pull", "保存先に Git リポジトリが見つかりませんでした")
		return
	}

	var summary protocol.Summary
	for _, target := range targets {
		if ctx.Err() != nil {
			fail("cancelled", "処理が中断されました")
			return
		}

		result := runner.Pull(ctx, req.RequestID, target.Spec, target.Path)
		switch result.Status {
		case protocol.StatusUpdated:
			summary.Updated++
		case protocol.StatusUpToDate:
			summary.UpToDate++
		default:
			summary.Failed++
		}
		if err := writer.Write(result); err != nil {
			fmt.Fprintf(stderr, "host: cannot write result: %v\n", err)
			return
		}
	}

	_ = writer.Write(protocol.Done{
		Type:      protocol.TypeDone,
		RequestID: req.RequestID,
		Summary:   summary,
	})
}

// pullTargets resolves the repositories to pull. An empty request means
// "everything under the root".
func pullTargets(runner *clone.Runner, specs []string) ([]clone.Discovered, error) {
	if len(specs) == 0 {
		return runner.DiscoverRepositories()
	}

	seen := make(map[string]bool, len(specs))
	targets := make([]clone.Discovered, 0, len(specs))
	for _, spec := range specs {
		if seen[spec] {
			continue
		}
		seen[spec] = true

		path, err := runner.TargetPath(spec)
		if err != nil {
			// An invalid spec is reported as a failed pull rather than aborting
			// the whole run.
			targets = append(targets, clone.Discovered{Spec: spec, Path: ""})
			continue
		}
		targets = append(targets, clone.Discovered{Spec: spec, Path: path})
	}
	return targets, nil
}
