package collie

import "testing"

func TestDefaultHerdrSocketFor(t *testing.T) {
	env := func(m map[string]string) func(string) string {
		return func(k string) string { return m[k] }
	}
	if got := defaultHerdrSocketFor("windows", `C:\Users\Alice`, env(map[string]string{
		"APPDATA": `C:\Users\Alice\AppData\Roaming`,
	})); got != `C:\Users\Alice\AppData\Roaming\herdr\herdr.sock` {
		t.Fatalf("windows default socket = %q", got)
	}
	if got := defaultHerdrSocketFor("windows", `C:\Users\Alice`, env(map[string]string{
		"APPDATA":       `C:\Users\Alice\AppData\Roaming`,
		"HERDR_SESSION": "work",
	})); got != `C:\Users\Alice\AppData\Roaming\herdr\sessions\work\herdr.sock` {
		t.Fatalf("windows session socket = %q", got)
	}
	if got := defaultHerdrSocketFor("darwin", "/Users/alice", env(nil)); got != "/Users/alice/.config/herdr/herdr.sock" {
		t.Fatalf("unix default socket = %q", got)
	}
	if got := defaultHerdrSocketFor("windows", `C:\Users\Alice`, env(map[string]string{
		"HERDR_SOCKET_PATH": `\\.\pipe\custom-herdr`,
	})); got != `\\.\pipe\custom-herdr` {
		t.Fatalf("explicit socket = %q", got)
	}
}

func TestExpandAndTildeWindowsAndUnix(t *testing.T) {
	winHome := `C:\Users\Alice`
	cases := []struct {
		in, want string
	}{
		{"", `C:\Users\Alice`},
		{"~", `C:\Users\Alice`},
		{"~/code/app", `C:\Users\Alice\code\app`},
		{`~\code\app`, `C:\Users\Alice\code\app`},
		{"projects/demo", `C:\Users\Alice\projects\demo`},
		{`D:\work\repo\`, `D:\work\repo`},
		{`C:/Users/Alice/..`, `C:\Users`},
		{`C:\`, `C:\`},
		{"/d/src/collie", `D:\src\collie`},
	}
	for _, tc := range cases {
		if got := expandIn(winHome, tc.in); got != tc.want {
			t.Errorf("expandIn(%q, %q) = %q, want %q", winHome, tc.in, got, tc.want)
		}
	}

	if got := tildeIn(winHome, `c:\users\alice\code\app`); got != `~\code\app` {
		t.Errorf("tildeIn windows = %q", got)
	}
	if got := tildeIn(winHome, `C:\Users\Alice`); got != "~" {
		t.Errorf("tildeIn exact windows home = %q", got)
	}
	if got := tildeIn("/Users/alice", "/Users/alice/code"); got != "~/code" {
		t.Errorf("tildeIn unix = %q", got)
	}
}

func TestWindowsHelpers(t *testing.T) {
	if got := sqliteURI(`C:\Users\Alice\.collie\herd.db`, "mode=ro"); got != "file:///C:/Users/Alice/.collie/herd.db?mode=ro" {
		t.Errorf("sqliteURI windows = %q", got)
	}
	if got := sqliteURI("/Users/alice/.collie/herd.db", "_pragma=busy_timeout(5000)"); got != "file:/Users/alice/.collie/herd.db?_pragma=busy_timeout(5000)" {
		t.Errorf("sqliteURI unix = %q", got)
	}
	if got := uriToPath("file:///c:/Users/Alice/My%20Repo/"); got != `C:\Users\Alice\My Repo` {
		t.Errorf("uriToPath windows = %q", got)
	}
	if got := uriToPath("file:///Users/alice/repo/"); got != "/Users/alice/repo" {
		t.Errorf("uriToPath unix = %q", got)
	}
	if !samePath(`C:\Users\Alice\Repo\`, `c:/users/alice/repo`) {
		t.Errorf("samePath should match Windows paths case-insensitively")
	}
	if got := baseOfPath(`C:\Users\Alice\Repo\`); got != "Repo" {
		t.Errorf("baseOfPath = %q", got)
	}
	if !isDriveRoot(`C:\`) || !isDriveRoot("d:") || isDriveRoot(`C:\Users`) {
		t.Errorf("isDriveRoot unexpected result")
	}
	if got := claudeProjectSlug(`C:\Users\Alice\my.repo`); got != "C--Users-Alice-my-repo" {
		t.Errorf("claudeProjectSlug = %q", got)
	}
	if got := sessionID("path", `C:\Users\Alice\.codex\sessions\2026\04\20\rollout-2026-04-20-01965500-1234-7abc-9def-0123456789ab.jsonl`); got != "01965500-1234-7abc-9def-0123456789ab" {
		t.Errorf("sessionID windows = %q", got)
	}
	if got := progName([]string{`C:\Program Files\nodejs\node.exe`, `C:\Users\Alice\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js`}); got != "codex" {
		t.Errorf("progName node windows = %q", got)
	}
	if got := progName([]string{`C:\Users\Alice\.local\bin\claude.exe`}); got != "claude" {
		t.Errorf("progName exe = %q", got)
	}
	if !trustDialogFor("Do you trust the files in this folder?\n\n  C:\\Users\\Alice\\repo\n", `C:\Users\Alice\repo`, `~\repo`) {
		t.Errorf("trustDialogFor should match Windows folder")
	}
	if !trustDialogFor("Do you trust the files in this folder?\n\n  D:\\real\\repo\n", `C:\Users\Alice\repo`, `~\repo`) {
		t.Errorf("trustDialogFor should match Windows folder basename after backslash")
	}
	if got := shellBin(`C:\Program Files\Collie\collie.exe`); got != `"C:/Program Files/Collie/collie.exe"` {
		t.Errorf("shellBin = %q", got)
	}
	if got := releaseAssetFor("windows", "amd64"); got != "collie-windows-amd64.exe" {
		t.Errorf("releaseAssetFor windows = %q", got)
	}
	if got := releaseAssetFor("linux", "arm64"); got != "collie-linux-arm64" {
		t.Errorf("releaseAssetFor linux = %q", got)
	}
}

func TestWindowsExtendedPathPrefixStripping(t *testing.T) {
	if got := winClean(`\\?\C:\Users\26422\Documents\Code\my-app\`); got != `C:\Users\26422\Documents\Code\my-app` {
		t.Fatalf("winClean extended drive path = %q", got)
	}
	if got := winClean(`\\?\UNC\server\share\folder\`); got != `\\server\share\folder` {
		t.Fatalf("winClean extended UNC path = %q", got)
	}
	if got := tildeIn(`C:\Users\26422`, `\\?\C:\Users\26422\Documents\Code`); got != `~\Documents\Code` {
		t.Fatalf("tildeIn extended path = %q", got)
	}
	if !samePath(`\\?\C:\Users\26422\Documents\Code`, `C:\Users\26422\Documents\Code\`) {
		t.Fatalf("samePath should match extended and regular Windows paths")
	}
	if got := baseOfPath(`\\?\C:\Users\26422\Documents\Code\`); got != "Code" {
		t.Fatalf("baseOfPath extended = %q", got)
	}
}

