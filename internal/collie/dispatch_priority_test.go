package collie

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDispatchPriorityAndProjectAwareness(t *testing.T) {
	dir := t.TempDir()
	srv := &Server{herdr: newHerdr("", "hub", dir), home: dir}
	sp, err := newSuper(srv, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer sp.db.Close()
	srv.sup = sp

	sp.mu.Lock()
	sp.st.Settings.RouterMachine = "mac1"
	sp.st.Settings.RouterKind = "codex"
	sp.st.Settings.WorkerMachine = "mac1"
	sp.st.Settings.WorkerKind = "codex"
	sp.st.Settings.WorkerCwd = "~"
	sp.mu.Unlock()

	// Register two remote computers: Mac (online) and Win (online).
	srv.herdr.mu.Lock()
	srv.herdr.remote["mac1"] = &Machine{ID: "mac1", Name: "Mac", Home: "/Users/test", Online: true, Agents: []string{"codex", "claude"}}
	srv.herdr.remote["wlc"] = &Machine{ID: "wlc", Name: "Win", Home: `C:\Users\26422`, Online: true, Agents: []string{"codex"}}
	srv.herdr.mu.Unlock()

	// Seed sidebar projects on Win and Mac.
	projectStore.Lock()
	projectStore.loaded = true
	projectStore.dismissed = map[string]bool{}
	projectStore.list = []*Project{
		{ID: "prj_win", Name: "论文返修", Machine: "wlc", Cwd: `C:\Users\26422\Desktop\论文返修`, Kind: "codex"},
		{ID: "prj_mac", Name: "中转网页", Machine: "mac1", Cwd: "/Users/test/relay", Kind: "codex"},
	}
	projectStore.Unlock()
	defer func() {
		projectStore.Lock()
		projectStore.loaded = false
		projectStore.list = nil
		projectStore.Unlock()
	}()

	// 1. `collie list` must expose pinned projects with computer, online state, and cwd.
	listOut := sp.List()
	if !strings.Contains(listOut, "projects (pinned workspaces") || !strings.Contains(listOut, `"论文返修"`) || !strings.Contains(listOut, `machine=wlc (Win, online)`) || !strings.Contains(listOut, `C:\Users\26422\Desktop\论文返修`) {
		t.Fatalf("expected Super.List() to include pinned projects map, got:\n%s", listOut)
	}

	// 2. Auto mode (no composer override) mentioning "论文返修":
	//    - User chat entry stays clean
	//    - Trigger gets Tier 1 `[Project context matched from sidebar ...]`
	//    - NO `[One-off dispatch target...]` suffix!
	sp.mu.Lock()
	sp.st.Entries = append(sp.st.Entries, &Entry{ID: "e0", Role: "collie", Text: "你好"})
	sp.mu.Unlock()

	body1, _ := json.Marshal(map[string]any{
		"text": "帮我看看论文返修第三章里的图表脚本为什么报错",
	})
	req1 := httptest.NewRequest("POST", "/api/super/say", bytes.NewReader(body1))
	rec1 := httptest.NewRecorder()
	srv.superSay(rec1, req1)
	if rec1.Code != 200 {
		t.Fatalf("superSay auto failed: %d %s", rec1.Code, rec1.Body.String())
	}
	lastEntry := sp.st.Entries[len(sp.st.Entries)-1]
	if lastEntry.Text != "帮我看看论文返修第三章里的图表脚本为什么报错" {
		t.Fatalf("expected user bubble text to remain clean, got %q", lastEntry.Text)
	}
	lastTrig := sp.st.Triggers[len(sp.st.Triggers)-1]
	if !strings.Contains(lastTrig.Text, `[Project context matched from sidebar`) || !strings.Contains(lastTrig.Text, `machine=wlc (Win, online)`) {
		t.Fatalf("expected Tier 1 project context in trigger, got:\n%s", lastTrig.Text)
	}
	if strings.Contains(lastTrig.Text, "One-off dispatch target") {
		t.Fatalf("expected NO one-off override hint in auto mode, got:\n%s", lastTrig.Text)
	}

	// 3. Explicit one-off override in composer (even when machine == default WorkerMachine "mac1"):
	//    - Must emit `--machine mac1 --kind codex --model gpt-5.4` AND explicitly defer to Tier 1 project/message affinity!
	body2, _ := json.Marshal(map[string]any{
		"text":     "写一个测速脚本跑一下",
		"machine":  "mac1",
		"kind":     "codex",
		"model":    "gpt-5.4",
		"override": true,
	})
	req2 := httptest.NewRequest("POST", "/api/super/say", bytes.NewReader(body2))
	rec2 := httptest.NewRecorder()
	srv.superSay(rec2, req2)
	if rec2.Code != 200 {
		t.Fatalf("superSay override failed: %d %s", rec2.Code, rec2.Body.String())
	}
	trig2 := sp.st.Triggers[len(sp.st.Triggers)-1]
	if !strings.Contains(trig2.Text, "--machine mac1") || !strings.Contains(trig2.Text, "--kind codex") || !strings.Contains(trig2.Text, "--model gpt-5.4") || !strings.Contains(trig2.Text, "Tier 1") {
		t.Fatalf("expected Tier 2 one-off override hint with Tier 1 deferral, got:\n%s", trig2.Text)
	}

	// 4. Tier 3 live availability fallback: when default WorkerMachine ("mac1") goes offline,
	//    resolveAutoWorkerTarget("") automatically switches to online "wlc" ("Win")!
	srv.herdr.mu.Lock()
	srv.herdr.remote["mac1"].Online = false
	srv.herdr.mu.Unlock()

	autoM, autoK := sp.resolveAutoWorkerTarget("")
	if autoM != "wlc" || autoK != "codex" {
		t.Fatalf("expected auto worker target to fall back from offline mac1 to online wlc/codex, got machine=%q kind=%q", autoM, autoK)
	}

	// Meanwhile, an EXPLICIT `--machine mac1` while mac1 is offline must fail clearly instead of running on Win!
	_, _, spawnErr := sp.Spawn("codex", "/Users/test/relay", "fix bug", mainThread, "", routerName, "mac1", "", "", nil, false, "", true)
	if spawnErr == nil || !strings.Contains(spawnErr.Error(), "offline") {
		t.Fatalf("expected explicit spawn on offline mac1 to return offline error, got %v", spawnErr)
	}
}
