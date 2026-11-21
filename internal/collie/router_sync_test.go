package collie

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestRouterSyncTreeRoundTrip(t *testing.T) {
	src := t.TempDir()
	dst := t.TempDir()

	os.MkdirAll(filepath.Join(src, "memory", "notes"), 0o700)
	os.MkdirAll(filepath.Join(src, ".claude"), 0o700)
	os.WriteFile(filepath.Join(src, "ROUTER.md"), []byte("# Router\n"), 0o600)
	os.WriteFile(filepath.Join(src, ".claude", "settings.json"), []byte(`{"permissions":{}}`), 0o600)
	os.WriteFile(filepath.Join(src, "memory", "instructions.md"), []byte("prefer codex\n"), 0o600)
	os.WriteFile(filepath.Join(src, "memory", "notes", "index.md"), []byte("- win.md\n"), 0o600)

	items := collectRouterTree(src, nil)
	if len(items) != 4 {
		t.Fatalf("collectRouterTree items = %d, want 4", len(items))
	}
	// Unsafe traversal items must be ignored by applyRouterTree.
	items = append(items, routerSyncItem{Path: "../outside.txt", Text: "bad"})
	if err := applyRouterTree(dst, items, []string{"memory"}, nil); err != nil {
		t.Fatalf("applyRouterTree: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dst, "..", "outside.txt")); err == nil {
		t.Fatalf("path traversal should have been rejected")
	}
	got, err := os.ReadFile(filepath.Join(dst, "memory", "instructions.md"))
	if err != nil || string(got) != "prefer codex\n" {
		t.Fatalf("instructions.md = %q, err=%v", string(got), err)
	}

	// Pulling editable files back skips ROUTER.md and memory/messages.md.
	os.WriteFile(filepath.Join(dst, "memory", "messages.md"), []byte("generated"), 0o600)
	os.WriteFile(filepath.Join(dst, "memory", "instructions.md"), []byte("updated on node\n"), 0o600)
	pulled := collectRouterTree(dst, routerEditableRel)
	for _, it := range pulled {
		if it.Path == "ROUTER.md" || it.Path == "memory/messages.md" {
			t.Fatalf("unexpected non-editable path in pull: %s", it.Path)
		}
	}
	if err := applyRouterTree(src, pulled, []string{"memory"}, routerEditableRel); err != nil {
		t.Fatalf("applyRouterTree pull: %v", err)
	}
	got2, _ := os.ReadFile(filepath.Join(src, "memory", "instructions.md"))
	if string(got2) != "updated on node\n" {
		t.Fatalf("pulled instructions.md = %q", string(got2))
	}
}

func TestIsHTTPSReqForwardedProto(t *testing.T) {
	r := httptest.NewRequest("GET", "http://101.200.80.58/api/devices", nil)
	if isHTTPSReq(r) {
		t.Fatalf("plain HTTP request should not be HTTPS")
	}
	r.Header.Set("X-Forwarded-Proto", "https, http")
	if !isHTTPSReq(r) {
		t.Fatalf("X-Forwarded-Proto: https should be detected as HTTPS")
	}
}
