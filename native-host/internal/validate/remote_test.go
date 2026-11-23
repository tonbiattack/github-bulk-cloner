package validate

import (
	"path/filepath"
	"testing"
)

func TestParseGitHubRemote(t *testing.T) {
	cases := []struct {
		remote string
		want   string
		ok     bool
	}{
		// https forms
		{"https://github.com/tonbiattack/zip-scope.git", "tonbiattack/zip-scope", true},
		{"https://github.com/tonbiattack/zip-scope", "tonbiattack/zip-scope", true},
		{"https://github.com/tonbiattack/zip-scope/", "tonbiattack/zip-scope", true},
		{"https://www.github.com/tonbiattack/zip-scope.git", "tonbiattack/zip-scope", true},
		{"https://user:token@github.com/tonbiattack/zip-scope.git", "tonbiattack/zip-scope", true},
		{"HTTPS://GitHub.com/Owner/Repo.git", "Owner/Repo", true},

		// ssh forms
		{"git@github.com:tonbiattack/zip-scope.git", "tonbiattack/zip-scope", true},
		{"git@github.com:tonbiattack/zip-scope", "tonbiattack/zip-scope", true},
		{"ssh://git@github.com/tonbiattack/zip-scope.git", "tonbiattack/zip-scope", true},
		{"ssh://git@github.com:22/tonbiattack/zip-scope.git", "tonbiattack/zip-scope", true},

		// not GitHub: must never match
		{"https://gitlab.com/owner/repo.git", "", false},
		{"git@bitbucket.org:owner/repo.git", "", false},
		{"https://example.com/github.com/owner/repo", "", false},
		{"https://github.company.internal/owner/repo.git", "", false},

		// malformed
		{"", "", false},
		{"   ", "", false},
		{"not a url", "", false},
		{"git@github.com:owner", "", false},
		{"git@github.com:owner/repo/extra.git", "", false},
		{"https://github.com/owner/repo/tree/main", "", false},
	}

	for _, tc := range cases {
		got, ok := ParseGitHubRemote(tc.remote)
		if ok != tc.ok {
			t.Errorf("ParseGitHubRemote(%q) ok = %v, want %v", tc.remote, ok, tc.ok)
			continue
		}
		if tc.ok && got != tc.want {
			t.Errorf("ParseGitHubRemote(%q) = %q, want %q", tc.remote, got, tc.want)
		}
	}
}

func TestSameRepo(t *testing.T) {
	if !SameRepo("owner/repo", "owner/repo") {
		t.Error("identical specs should match")
	}
	if !SameRepo("Owner/Repo", "owner/repo") {
		t.Error("GitHub is case-insensitive, so these should match")
	}
	if SameRepo("owner/repo", "other/repo") {
		t.Error("different owners must not match")
	}
	if SameRepo("owner/repo", "owner/other") {
		t.Error("different repositories must not match")
	}
}

func TestTargetWithLayout(t *testing.T) {
	root := t.TempDir()
	real, err := Root(root)
	if err != nil {
		t.Fatal(err)
	}

	flat, err := TargetWithLayout(real, "owner", "repo", "flat")
	if err != nil {
		t.Fatalf("flat: %v", err)
	}
	if got, want := flat, real+string(filepath.Separator)+"repo"; got != want {
		t.Errorf("flat target = %q, want %q", got, want)
	}

	empty, err := TargetWithLayout(real, "owner", "repo", "")
	if err != nil {
		t.Fatalf("empty layout: %v", err)
	}
	if empty != flat {
		t.Errorf("empty layout should default to flat: %q vs %q", empty, flat)
	}

	nested, err := TargetWithLayout(real, "owner", "repo", "owner")
	if err != nil {
		t.Fatalf("owner layout: %v", err)
	}
	wantNested := real + string(filepath.Separator) + "owner" + string(filepath.Separator) + "repo"
	if nested != wantNested {
		t.Errorf("owner target = %q, want %q", nested, wantNested)
	}

	// Both layouts must stay under the root.
	for _, target := range []string{flat, nested} {
		if !Contains(real, target) {
			t.Errorf("target %q escaped root %q", target, real)
		}
	}

	if _, err := TargetWithLayout(real, "owner", "repo", "bogus"); err == nil {
		t.Error("unknown layout should fail")
	}
}
