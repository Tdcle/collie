package collie

import (
	"os"
	"testing"
	"time"
)

func TestParseEtime(t *testing.T) {
	for in, want := range map[string]time.Duration{
		"05:07":      5*time.Minute + 7*time.Second,
		"01:06:25":   time.Hour + 6*time.Minute + 25*time.Second,
		"2-03:00:01": 51*time.Hour + time.Second,
	} {
		if got := parseEtime(in); got != want {
			t.Errorf("%s: %v, want %v", in, got, want)
		}
	}
}

func TestProgName(t *testing.T) {
	for want, args := range map[string][]string{
		"claude": {"/Users/x/.local/bin/claude", "--resume", "id"},
		"codex":  {"node", "/usr/lib/node_modules/@openai/codex/bin/codex.js"},
		"zsh":    {"-zsh"},
	} {
		if got := progName(args); got != want {
			t.Errorf("%v: %q, want %q", args, got, want)
		}
	}
}

func TestIsDesktopOrHelperProc(t *testing.T) {
	desktopOrHelpers := []struct {
		kind string
		args []string
	}{
		{"codex", []string{`C:\Program Files\WindowsApps\OpenAI.Codex_26.311.21342.0_x64__2p2nqsd0c76g0\app\Codex.exe`}},
		{"codex", []string{`C:\Program Files\WindowsApps\OpenAI.Codex_26.311.21342.0_x64__2p2nqsd0c76g0\app\resources\codex.exe`, "app-server"}},
		{"codex", []string{`C:\Users\26422\AppData\Local\Programs\Codex\Codex.exe`, "--type=renderer"}},
		{"codex", []string{"/Applications/Codex.app/Contents/MacOS/Codex"}},
		{"claude", []string{"/Applications/Claude.app/Contents/MacOS/Claude"}},
		{"codex", []string{"codex", "mcp-server"}},
		{"codex", []string{"codex", "exec", "fix bug"}},
		{"claude", []string{"claude", "--output-format", "stream-json"}},
	}
	for _, tc := range desktopOrHelpers {
		if !isDesktopOrHelperProc(tc.kind, tc.args) {
			t.Errorf("expected desktop/helper filter to exclude (%s, %v)", tc.kind, tc.args)
		}
	}

	interactiveCLIs := []struct {
		kind string
		args []string
	}{
		{"codex", []string{`C:\Users\26422\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js`}},
		{"claude", []string{`C:\Users\26422\.local\bin\claude.exe`, "--resume", "abc"}},
		{"codex", []string{"/opt/homebrew/bin/codex", "-m", "gpt-5.4"}},
		{"claude", []string{"/Users/alice/.local/bin/claude"}},
	}
	for _, tc := range interactiveCLIs {
		if isDesktopOrHelperProc(tc.kind, tc.args) {
			t.Errorf("expected interactive CLI to remain visible: (%s, %v)", tc.kind, tc.args)
		}
	}
}


// COLLIE_EXTERNAL=1 go test -run TestExternalLive -v prints what this machine finds.
func TestExternalLive(t *testing.T) {
	if os.Getenv("COLLIE_EXTERNAL") == "" {
		t.Skip("set COLLIE_EXTERNAL=1")
	}
	home, _ := os.UserHomeDir()
	s := &Server{home: home}
	for _, e := range s.externalSessions() {
		t.Logf("%s app=%q cwd=%s session=%s title=%q path=%s", e.ID, e.App, e.Cwd, e.Session, e.Title, e.path)
	}
}
