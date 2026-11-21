package collie

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTrustAgyFolder(t *testing.T) {
	home := t.TempDir()
	real := filepath.Join(home, "real")
	os.Mkdir(real, 0o755)
	link := filepath.Join(home, "link")
	target := link
	if err := os.Symlink(real, link); err != nil {
		// Unprivileged Windows runners without Developer Mode disallow symlinks.
		target = real
	}
	file := agySettings(home)
	os.MkdirAll(filepath.Dir(file), 0o755)
	os.WriteFile(file, []byte(`{"model":"x","trustedWorkspaces":["/old"]}`), 0o600)

	for i := 0; i < 2; i++ { // the second call changes nothing
		if err := trustAgyFolder(home, target); err != nil {
			t.Fatal(err)
		}
	}
	var got struct {
		Model   string   `json:"model"`
		Trusted []string `json:"trustedWorkspaces"`
	}
	b, _ := os.ReadFile(file)
	json.Unmarshal(b, &got)
	realResolved, _ := filepath.EvalSymlinks(real)
	if target == link {
		if got.Model != "x" || len(got.Trusted) != 3 || got.Trusted[0] != "/old" || got.Trusted[1] != link || got.Trusted[2] != realResolved {
			t.Fatalf("settings = %s", b)
		}
	} else {
		if got.Model != "x" || len(got.Trusted) < 2 || got.Trusted[0] != "/old" || got.Trusted[1] != filepath.Clean(real) {
			t.Fatalf("settings = %s", b)
		}
	}
	if err := trustAgyFolder(t.TempDir(), os.TempDir()); err != nil { // no settings file yet
		t.Fatal(err)
	}
}

func TestTrustDialogFor(t *testing.T) {
	claude := " Accessing workspace:\n\n /data00/home/u/agent-workspace   \n\n Quick safety check: Is this a project you created or one you trust?\n ❯ 1. Yes, I trust this folder\n   2. No, exit\n Enter to confirm · Esc to cancel"
	if !trustDialogFor(claude, "/home/u/agent-workspace", "~/agent-workspace") {
		t.Error("trust dialog for a symlinked folder not recognised")
	}
	if trustDialogFor(claude, "/home/u/other", "~/other") {
		t.Error("trust dialog for another folder answered")
	}
	hooks := "Hooks need review\n 4 hooks are new or changed.\n Hooks can run outside the sandbox after you trust them.\n› 1. Review hooks\n  2. Trust all and continue"
	if trustDialogFor(hooks, "/home/u/agent-workspace", "~/agent-workspace") {
		t.Error("hooks review taken as a folder trust dialog")
	}
}

func TestPickChoice(t *testing.T) {
	a := Approval{Choices: []Choice{
		{Label: "GPT-6.1-Sol (current)   Latest workhorse model", Text: "1"},
		{Label: "GPT-6-Astra   Frontier intelligence", Text: "2"},
		{Label: "GPT-6.1 Terra   GPT-6.1 Terra Codex model.", Text: "3"},
	}}
	for want, label := range map[string]string{"2": "GPT-6-Astra", "terra": "GPT-6.1 Terra", "6.1-sol": "GPT-6.1-Sol"} {
		if c, ok := pickChoice(a, want); !ok || !strings.HasPrefix(c.Label, label) {
			t.Errorf("pickChoice(%q) = %q %v", want, c.Label, ok)
		}
	}
	if _, ok := pickChoice(a, "gpt"); ok {
		t.Error("an ambiguous label picked a choice")
	}
	cursor := Approval{Choices: []Choice{{Label: "Review hooks", Keys: []string{"enter"}}, {Label: "Trust all and continue", Keys: []string{"down", "enter"}}}}
	if c, ok := pickChoice(cursor, "2"); !ok || c.Label != "Trust all and continue" {
		t.Errorf("by position: %q %v", c.Label, ok)
	}
}
