package validate

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestRepoSpecAcceptsValidSpecs(t *testing.T) {
	cases := []struct{ spec, owner, name string }{
		{"tonbiattack/zip-scope", "tonbiattack", "zip-scope"},
		{"a/b", "a", "b"},
		{"Owner-Name/repo.name_with-chars", "Owner-Name", "repo.name_with-chars"},
		{"owner/UPPER", "owner", "UPPER"},
		{"o123/r_1", "o123", "r_1"},
	}
	for _, tc := range cases {
		owner, name, err := RepoSpec(tc.spec)
		if err != nil {
			t.Errorf("RepoSpec(%q) returned error: %v", tc.spec, err)
			continue
		}
		if owner != tc.owner || name != tc.name {
			t.Errorf("RepoSpec(%q) = (%q, %q), want (%q, %q)", tc.spec, owner, name, tc.owner, tc.name)
		}
	}
}

func TestRepoSpecRejectsInvalidSpecs(t *testing.T) {
	cases := map[string]string{
		"empty":                "",
		"no slash":             "owner",
		"two slashes":          "owner/repo/extra",
		"trailing slash":       "owner/",
		"leading slash":        "/repo",
		"dot dot":              "../etc",
		"dot dot name":         "owner/..",
		"dot name":             "owner/.",
		"absolute path":        `C:\Windows\System32`,
		"url":                  "https://github.com/owner/repo",
		"scheme":               "git@github.com:owner/repo.git",
		"space":                "owner/re po",
		"shell metachar":       "owner/repo;rm -rf /",
		"backtick":             "owner/re`po`",
		"pipe":                 "owner/repo|calc",
		"newline":              "owner/repo\nrm",
		"leading hyphen repo":  "owner/-repo",
		"leading hyphen owner": "-owner/repo",
		"trailing dot":         "owner/repo.",
		"trailing space":       "owner/repo ",
		"reserved con":         "owner/con",
		"reserved nul":         "owner/NUL",
		"reserved com1":        "owner/com1",
		"reserved lpt9":        "owner/lpt9",
		"reserved owner":       "con/repo",
		"colon":                "owner/re:po",
		"asterisk":             "owner/re*po",
		"question":             "owner/re?po",
		"quote":                `owner/re"po`,
		"owner too long":       strings.Repeat("a", MaxOwnerLen+1) + "/repo",
		"repo too long":        "owner/" + strings.Repeat("a", MaxRepoLen+1),
		"owner trailing hyphen": "owner-/repo",
	}
	for name, spec := range cases {
		if _, _, err := RepoSpec(spec); err == nil {
			t.Errorf("%s: RepoSpec(%q) should have failed", name, spec)
		}
	}
}

func TestRepoSpecAcceptsMaxLengths(t *testing.T) {
	owner := strings.Repeat("a", MaxOwnerLen)
	name := strings.Repeat("b", MaxRepoLen)
	if _, _, err := RepoSpec(owner + "/" + name); err != nil {
		t.Fatalf("max-length spec rejected: %v", err)
	}
}

func TestRootRejectsBadInput(t *testing.T) {
	if _, err := Root(""); err == nil {
		t.Error("empty root should fail")
	}
	if _, err := Root("   "); err == nil {
		t.Error("blank root should fail")
	}
	if _, err := Root("relative/path"); err == nil {
		t.Error("relative root should fail")
	}

	file := filepath.Join(t.TempDir(), "file.txt")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Root(file); err == nil {
		t.Error("file root should fail")
	}
}

// TestRootCreatesMissingDirectory covers the case where the user points at a
// folder that does not exist yet.
func TestRootCreatesMissingDirectory(t *testing.T) {
	base := t.TempDir()
	missing := filepath.Join(base, "nested", "clone-root")

	got, err := Root(missing)
	if err != nil {
		t.Fatalf("Root(%q): %v", missing, err)
	}
	if !filepath.IsAbs(got) {
		t.Fatalf("resolved root %q is not absolute", got)
	}
	info, err := os.Stat(got)
	if err != nil {
		t.Fatalf("root was not created: %v", err)
	}
	if !info.IsDir() {
		t.Fatal("created root is not a directory")
	}
}

func TestRootResolvesExistingDirectory(t *testing.T) {
	dir := t.TempDir()
	got, err := Root(dir)
	if err != nil {
		t.Fatalf("Root(%q): %v", dir, err)
	}
	if !filepath.IsAbs(got) {
		t.Fatalf("resolved root %q is not absolute", got)
	}
}

func TestContains(t *testing.T) {
	root := filepath.Join(string(filepath.Separator), "apps")
	cases := []struct {
		target string
		want   bool
	}{
		{root, true},
		{filepath.Join(root, "owner"), true},
		{filepath.Join(root, "owner", "repo"), true},
		{filepath.Join(string(filepath.Separator), "apps2"), false},
		{filepath.Join(string(filepath.Separator), "windows"), false},
		{filepath.Join(root, "..", "escape"), false},
	}
	for _, tc := range cases {
		if got := Contains(root, tc.target); got != tc.want {
			t.Errorf("Contains(%q, %q) = %v, want %v", root, tc.target, got, tc.want)
		}
	}
}

func TestTargetStaysUnderRoot(t *testing.T) {
	root := t.TempDir()
	real, err := Root(root)
	if err != nil {
		t.Fatal(err)
	}

	target, err := Target(real, "owner", "repo")
	if err != nil {
		t.Fatalf("Target: %v", err)
	}
	if !Contains(real, target) {
		t.Fatalf("target %q escaped root %q", target, real)
	}
	// The layout is flat: <root>/<repo>, with no owner directory.
	if filepath.Base(target) != "repo" {
		t.Fatalf("target base = %q, want repo", filepath.Base(target))
	}
	if filepath.Dir(target) != real {
		t.Fatalf("target dir = %q, want the root itself", filepath.Dir(target))
	}
}

// makeLinkTo creates a link at link pointing at target. It prefers a
// directory junction, which Windows allows without administrator rights, and
// falls back to a symlink.
func makeLinkTo(t *testing.T, target, link string) {
	t.Helper()

	if err := os.Symlink(target, link); err == nil {
		return
	}

	// mklink /J does not need SeCreateSymbolicLinkPrivilege.
	cmd := exec.Command("cmd", "/c", "mklink", "/J", link, target)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("cannot create a junction or symlink: %v (%s)", err, out)
	}
}

// TestTargetRejectsEscapingRepoDirectory plants a directory junction where the
// repository directory would go and checks that the escape is refused.
func TestTargetRejectsEscapingRepoDirectory(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("junction creation is Windows-specific")
	}

	root := t.TempDir()
	outside := t.TempDir()
	real, err := Root(root)
	if err != nil {
		t.Fatal(err)
	}

	// A junction at <root>/repo pointing outside the root.
	link := filepath.Join(real, "repo")
	makeLinkTo(t, outside, link)

	if _, err := Target(real, "owner", "repo"); err == nil {
		t.Fatal("Target should refuse a destination that resolves outside the root")
	}
}

// TestTargetAllowsLinkInsideRoot makes sure the containment check does not
// reject a destination that is a link but still stays under the root.
func TestTargetAllowsLinkInsideRoot(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("junction creation is Windows-specific")
	}

	root := t.TempDir()
	real, err := Root(root)
	if err != nil {
		t.Fatal(err)
	}

	inner := filepath.Join(real, "actual")
	if err := os.MkdirAll(inner, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(real, "repo")
	makeLinkTo(t, inner, link)

	target, err := Target(real, "owner", "repo")
	if err != nil {
		t.Fatalf("a link inside the root should be allowed: %v", err)
	}
	if !Contains(real, target) {
		t.Fatalf("target %q escaped root %q", target, real)
	}
}

func TestIsGitRepo(t *testing.T) {
	dir := t.TempDir()
	if IsGitRepo(dir) {
		t.Error("empty directory should not look like a Git repo")
	}
	if err := os.Mkdir(filepath.Join(dir, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if !IsGitRepo(dir) {
		t.Error("directory with .git should look like a Git repo")
	}
}
