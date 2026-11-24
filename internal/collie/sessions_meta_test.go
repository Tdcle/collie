package collie

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestDeviceRenameAndSessionLifecycle(t *testing.T) {
	dir := t.TempDir()
	db, err := openDB(filepath.Join(dir, "collie.db"))
	if err != nil {
		t.Fatalf("openDB: %v", err)
	}
	defer db.Close()

	sessionMetaStore.Lock()
	sessionMetaStore.loaded = false
	sessionMetaStore.byKey = nil
	sessionMetaStore.Unlock()

	srv := &Server{
		herdr: newHerdr("", "old-hub-host", dir),
		token: "tok",
		home:  dir,
		sup:   &Super{db: db},
		auths: newAuth(db, "tok"),
	}
	code, _ := srv.auths.newCode("machine")
	dev, _, _, err := srv.auths.redeem(code, "machine", "DV4GH6W2PM", "darwin/arm64", "DV4GH6W2PM", "/Users/alex")
	if err != nil {
		t.Fatalf("redeem: %v", err)
	}
	srv.herdr.attach(&Machine{ID: dev.ID, Name: dev.Name, OS: "darwin/arm64", Online: true})

	// 1. Rename remote machine and Hub
	r := httptest.NewRequest("POST", "/api/devices/"+dev.ID+"/rename", bytes.NewBufferString(`{"name":"我的 MacBook"}`))
	r.SetPathValue("id", dev.ID)
	w := httptest.NewRecorder()
	srv.renameDevice(w, r)
	if w.Code != 200 {
		t.Fatalf("renameDevice code=%d body=%s", w.Code, w.Body.String())
	}
	ms := srv.herdr.Machines()
	found := false
	for _, m := range ms {
		if m.ID == dev.ID && m.Name == "我的 MacBook" {
			found = true
		}
	}
	if !found {
		t.Fatalf("machine name was not updated in herdr.Machines(): %+v", ms)
	}

	rHub := httptest.NewRequest("POST", "/api/devices/hub/rename", bytes.NewBufferString(`{"name":"阿里云中枢"}`))
	rHub.SetPathValue("id", "hub")
	wHub := httptest.NewRecorder()
	srv.renameDevice(wHub, rHub)
	if wHub.Code != 200 || srv.herdr.Machines()[0].Name != "阿里云中枢" || srv.auths.HubName() != "阿里云中枢" {
		t.Fatalf("hub rename failed: code=%d name=%s", wHub.Code, srv.herdr.Machines()[0].Name)
	}

	// 2. Rename, archive, and delete session metadata
	rRen := httptest.NewRequest("POST", "/api/sessions/rename", bytes.NewBufferString(`{"kind":"codex","machine":"wlc","session":"sess-1","ext_id":"cx-sess-1@wlc","title":"论文返修定稿"}`))
	wRen := httptest.NewRecorder()
	srv.renameSession(wRen, rRen)
	if wRen.Code != 200 {
		t.Fatalf("renameSession code=%d", wRen.Code)
	}
	snap := srv.sessionMetaSnapshot()
	ck := canonicalSessionKey("codex", "wlc", "sess-1")
	if snap[ck] == nil || snap[ck].Title != "论文返修定稿" {
		t.Fatalf("unexpected session meta after rename: %+v", snap[ck])
	}

	rPin := httptest.NewRequest("POST", "/api/sessions/pin", bytes.NewBufferString(`{"kind":"codex","machine":"wlc","session":"sess-1","ext_id":"cx-sess-1@wlc","pinned":true}`))
	wPin := httptest.NewRecorder()
	srv.pinSession(wPin, rPin)
	if wPin.Code != 200 || !srv.sessionMetaSnapshot()[ck].Pinned || srv.sessionMetaSnapshot()[ck].PinnedAt <= 0 {
		t.Fatalf("expected session to be pinned: code=%d meta=%+v", wPin.Code, srv.sessionMetaSnapshot()[ck])
	}

	rArch := httptest.NewRequest("POST", "/api/sessions/archive", bytes.NewBufferString(`{"kind":"codex","machine":"wlc","session":"sess-1","archived":true}`))
	wArch := httptest.NewRecorder()
	srv.archiveSession(wArch, rArch)
	if wArch.Code != 200 || !srv.sessionMetaSnapshot()[ck].Archived || srv.sessionMetaSnapshot()[ck].Pinned {
		t.Fatalf("expected session to be archived and unpinned")
	}

	rDel := httptest.NewRequest("POST", "/api/sessions/delete", bytes.NewBufferString(`{"kind":"codex","machine":"wlc","session":"sess-1"}`))
	wDel := httptest.NewRecorder()
	srv.deleteSession(wDel, rDel)
	if wDel.Code != 200 || !srv.isSessionDeleted("codex", "wlc", "sess-1") {
		t.Fatalf("expected session to be marked deleted")
	}
}

func TestCodexSegmentedRolloutAndGeminiTranscript(t *testing.T) {
	home := t.TempDir()
	srv := &Server{home: home}

	// Codex segmented rollout: rollout-*-<session>_<segment>.jsonl
	sessID := "01a15378-6cc5-78d0-8d61-b0c7e4f8b367"
	oldDir := filepath.Join(home, ".codex", "sessions", "2026", "11", "18")
	newDir := filepath.Join(home, ".codex", "sessions", "2026", "11", "21")
	os.MkdirAll(oldDir, 0o755)
	os.MkdirAll(newDir, 0o755)
	oldFile := filepath.Join(oldDir, "rollout-2026-11-18T16-10-11-"+sessID+"_01a1edb4-ccc5-7a52-bf2a-add01e9a4659.jsonl")
	newFile := filepath.Join(newDir, "rollout-2026-11-21T11-21-02-"+sessID+"_01a1fc1f-27ad-7331-ab36-7a9f501316ce.jsonl")
	os.WriteFile(oldFile, []byte(`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"text":"older"}]}}`+"\n"), 0o600)
	os.WriteFile(newFile, []byte(`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"text":"论文返修最新"}]}}`+"\n"), 0o600)
	past := time.Now().Add(-time.Hour)
	os.Chtimes(oldFile, past, past)

	gotPath, gotFmt := srv.findTranscript("codex", "id", sessID, "", "")
	if gotPath != newFile || gotFmt != "codex" {
		t.Fatalf("findTranscript codex segmented = (%q, %q), want (%q, codex)", gotPath, gotFmt, newFile)
	}

	// Gemini CLI transcript parsing & lookup
	gemDir := filepath.Join(home, ".gemini", "tmp", "proj1", "chats")
	os.MkdirAll(gemDir, 0o755)
	os.WriteFile(filepath.Join(home, ".gemini", "tmp", "proj1", ".project_root"), []byte("/work/proj1\n"), 0o600)
	gemFile := filepath.Join(gemDir, "session-2026-11-21T10-00-42e06597.jsonl")
	os.WriteFile(gemFile, []byte(
		`{"sessionId":"42e06597-56a1-4b98-a2d7-b92b85c23c96"}`+"\n"+
			`{"$set":{"messages":[{"type":"user","content":[{"text":"<session_context>ignore</session_context>"}]},{"type":"user","content":[{"text":"你好 Gemini"}]},{"type":"gemini","content":[{"text":"你好！"}]}]}}`+"\n",
	), 0o600)

	gp, gf := srv.findTranscript("gemini", "id", "42e06597-56a1-4b98-a2d7-b92b85c23c96", "", "/work/proj1")
	if gp != gemFile || gf != "gemini" {
		t.Fatalf("findTranscript gemini = (%q, %q), want (%q, gemini)", gp, gf, gemFile)
	}
	tr := newTranscript(gp, gf)
	tr.openTail()
	if len(tr.msgs) != 2 || tr.msgs[0].Text != "你好 Gemini" || tr.msgs[1].Text != "你好！" {
		t.Fatalf("unexpected gemini messages: %+v", tr.msgs)
	}
}

func TestProjectsLifecycleAndMakeDir(t *testing.T) {
	dir := t.TempDir()
	db, err := openDB(filepath.Join(dir, "collie.db"))
	if err != nil {
		t.Fatalf("openDB: %v", err)
	}
	defer db.Close()

	projectStore.Lock()
	projectStore.loaded = false
	projectStore.list = nil
	projectStore.Unlock()
	sessionMetaStore.Lock()
	sessionMetaStore.loaded = false
	sessionMetaStore.byKey = nil
	sessionMetaStore.Unlock()

	srv := &Server{
		herdr: newHerdr("", "hub", dir),
		token: "tok",
		home:  dir,
		sup:   &Super{db: db},
		auths: newAuth(db, "tok"),
	}

	// 1. makeDir creates folder cleanly
	rMk := httptest.NewRequest("POST", "/api/dirs", bytes.NewBufferString(`{"parent":"~","name":"paper-rev"}`))
	wMk := httptest.NewRecorder()
	srv.makeDir(wMk, rMk)
	if wMk.Code != 200 || !isDir(filepath.Join(dir, "paper-rev")) {
		t.Fatalf("makeDir failed: code=%d body=%s", wMk.Code, wMk.Body.String())
	}

	// 2. Create project
	rCr := httptest.NewRequest("POST", "/api/projects", bytes.NewBufferString(`{"machine":"wlc","cwd":"~/paper-rev","kind":"codex"}`))
	wCr := httptest.NewRecorder()
	srv.createProject(wCr, rCr)
	if wCr.Code != 200 {
		t.Fatalf("createProject failed: code=%d body=%s", wCr.Code, wCr.Body.String())
	}
	projs := srv.projectsSnapshot()
	if len(projs) != 1 || projs[0].Name != "paper-rev" || projs[0].Kind != "codex" || projs[0].Machine != "wlc" {
		t.Fatalf("unexpected projects: %+v", projs)
	}
	pid := projs[0].ID

	// 3. Bind pane project and promote to canonical session
	srv.bindPaneProject("w9:p1@wlc", pid)
	srv.promotePaneProjectToSession("w9:p1@wlc", "codex", "wlc", "sess-99")
	ck := canonicalSessionKey("codex", "wlc", "sess-99")
	if srv.sessionMetaSnapshot()[ck] == nil || srv.sessionMetaSnapshot()[ck].ProjectID != pid {
		t.Fatalf("expected promoted session project binding, got %+v", srv.sessionMetaSnapshot()[ck])
	}

	// 4. Update project
	rUp := httptest.NewRequest("POST", "/api/projects/"+pid+"/update", bytes.NewBufferString(`{"name":"IEEE 论文返修","kind":"claude"}`))
	rUp.SetPathValue("id", pid)
	wUp := httptest.NewRecorder()
	srv.updateProject(wUp, rUp)
	if wUp.Code != 200 || srv.projectsSnapshot()[0].Name != "IEEE 论文返修" || srv.projectsSnapshot()[0].Kind != "claude" {
		t.Fatalf("updateProject failed: code=%d projs=%+v", wUp.Code, srv.projectsSnapshot())
	}

	// 5. Delete project clears explicit session project_id without marking session deleted
	rDel := httptest.NewRequest("POST", "/api/projects/"+pid+"/delete", bytes.NewBufferString(`{}`))
	rDel.SetPathValue("id", pid)
	wDel := httptest.NewRecorder()
	srv.deleteProject(wDel, rDel)
	if wDel.Code != 200 || len(srv.projectsSnapshot()) != 0 {
		t.Fatalf("deleteProject failed: code=%d", wDel.Code)
	}
	if srv.isSessionDeleted("codex", "wlc", "sess-99") {
		t.Fatalf("deleting project must not delete sessions")
	}
}

func TestHostCodexProjectSyncAndDismiss(t *testing.T) {
	t.Setenv("CODEX_HOME", "")
	dir := t.TempDir()
	codexDir := filepath.Join(dir, ".codex")
	if err := os.MkdirAll(codexDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// 1. Seed Codex state_5.sqlite + .codex-global-state.json
	stateDBPath := filepath.Join(codexDir, "state_5.sqlite")
	sdb, err := openDB(stateDBPath)
	if err != nil {
		t.Fatal(err)
	}
	_, err = sdb.Exec(`
		CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', position INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
		CREATE TABLE project_roots (project_id TEXT NOT NULL, position INTEGER NOT NULL, path TEXT NOT NULL, PRIMARY KEY (project_id, position));
		INSERT INTO projects VALUES ('p-sfd', 'SFD-Net', '{}', 0, 1795144334317, 1795144334342);
		INSERT INTO project_roots VALUES ('p-sfd', 0, ?), ('p-sfd', 1, ?);
	`, filepath.Join(dir, "Desktop", "SFD_Net"), filepath.Join(dir, "Desktop", "SFD_Net_2"))
	if err != nil {
		t.Fatal(err)
	}
	sdb.Close()

	globalJSON := `{"project-order":["lp-win"],"local-projects":{"lp-win":{"id":"lp-win","name":"SFD-Win","rootPaths":["C:\\Users\\26422\\Documents\\ChatGPT\\SFD-Net 2"],"createdAt":1794292127806,"updatedAt":1794292127806}}}`
	if err := os.WriteFile(filepath.Join(codexDir, ".codex-global-state.json"), []byte(globalJSON), 0o644); err != nil {
		t.Fatal(err)
	}

	db, err := openDB(filepath.Join(dir, "collie.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	projectStore.Lock()
	projectStore.loaded = false
	projectStore.list = nil
	projectStore.dismissed = nil
	projectStore.Unlock()
	hostProjectSync.Lock()
	hostProjectSync.lastByMachine = map[string]time.Time{}
	hostProjectSync.running = false
	hostProjectSync.Unlock()

	h := newHerdr("", "hub", dir)
	h.local.Online = true
	srv := &Server{
		herdr: h,
		token: "tok",
		home:  dir,
		sup:   &Super{db: db},
		auths: newAuth(db, "tok"),
	}

	added, changed := srv.syncHostProjectsNow(t.Context())
	if added != 2 || !changed {
		t.Fatalf("expected 2 synced projects, got added=%d changed=%v", added, changed)
	}
	projs := srv.projectsSnapshot()
	wantCwd := tildeIn(dir, filepath.Join(dir, "Desktop", "SFD_Net"))
	if len(projs) != 2 || projs[0].Name != "SFD-Net" || projs[0].Cwd != wantCwd || len(projs[0].Roots) != 2 {
		t.Fatalf("unexpected synced projects: len=%d first=%+v wantCwd=%q", len(projs), projs[0], wantCwd)
	}

	// Dismissing/deleting a synced project must prevent it from re-importing on subsequent syncs
	rDel := httptest.NewRequest("POST", "/api/projects/"+projs[0].ID+"/delete", bytes.NewBufferString(`{}`))
	rDel.SetPathValue("id", projs[0].ID)
	wDel := httptest.NewRecorder()
	srv.deleteProject(wDel, rDel)
	if wDel.Code != 200 {
		t.Fatalf("deleteProject failed: %d", wDel.Code)
	}
	added2, _ := srv.syncHostProjectsNow(t.Context())
	if added2 != 0 || len(srv.projectsSnapshot()) != 1 {
		t.Fatalf("dismissed project should not be re-imported: added2=%d len=%d", added2, len(srv.projectsSnapshot()))
	}
}

func TestEnsureNonBlockingAgentArgs(t *testing.T) {
	got := ensureNonBlockingAgentArgs("codex", []string{"resume", "abc-123"})
	want := []string{"--no-daemon", "-c", "check_for_update_on_startup=false", "-c", "features.respect_system_proxy=true", "resume", "abc-123"}
	if len(got) != len(want) {
		t.Fatalf("unexpected codex args len: got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("unexpected codex args[%d]: got %q, want %q (%v)", i, got[i], want[i], got)
		}
	}
	// Idempotent if already specified
	got2 := ensureNonBlockingAgentArgs("codex", got)
	if len(got2) != len(want) {
		t.Fatalf("expected idempotent args, got %v", got2)
	}
	// Non-codex untouched
	got3 := ensureNonBlockingAgentArgs("claude", []string{"--resume", "s1"})
	if len(got3) != 2 || got3[0] != "--resume" {
		t.Fatalf("expected claude args untouched, got %v", got3)
	}
}

func TestSuperReportBlockedTone(t *testing.T) {
	dir := t.TempDir()
	srv := &Server{home: dir}
	sp, err := newSuper(srv, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer sp.db.Close()

	sp.st.Workers["w1"] = &Worker{Name: "w1", Thread: "chat"}
	sp.st.Workers["w2"] = &Worker{Name: "w2", Thread: "chat"}
	if err := sp.Report("w1", "BLOCKED: missing proxy credentials"); err != nil {
		t.Fatal(err)
	}
	if err := sp.Report("w2", "Updated Codex CLI to 0.171.0"); err != nil {
		t.Fatal(err)
	}
	if len(sp.st.Entries) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(sp.st.Entries))
	}
	if sp.st.Entries[0].Tone != "blocked" {
		t.Fatalf("expected BLOCKED report to have tone=blocked, got %q", sp.st.Entries[0].Tone)
	}
	if sp.st.Entries[1].Tone != "done" {
		t.Fatalf("expected normal report to have tone=done, got %q", sp.st.Entries[1].Tone)
	}
}

func TestPromptUnlocksReadOnlyCodexPaneWithoutForking(t *testing.T) {
	lockedScreen := "Worked for 4m 0s\n\n  🔒  This conversation is open in another app   r to retry\n   r retry   f fork\n"
	unlockedScreen := "› Ask Codex to do anything\n"

	screen := lockedScreen
	retryResolves := true
	var keysSent []string
	var promptsSent []string

	h := newHerdr("", "hub", t.TempDir())
	h.local.conn = &herdrConn{
		dial: func(ctx context.Context) (net.Conn, error) {
			c1, c2 := net.Pipe()
			go func() {
				defer c2.Close()
				r := bufio.NewReader(c2)
				line, err := r.ReadBytes('\n')
				if err != nil {
					return
				}
				var req struct {
					ID     string         `json:"id"`
					Method string         `json:"method"`
					Params map[string]any `json:"params"`
				}
				_ = json.Unmarshal(line, &req)
				var res any = map[string]any{"ok": true}
				switch req.Method {
				case "pane.read":
					res = map[string]any{"read": map[string]any{"text": screen}}
				case "pane.send_keys":
					if ks, ok := req.Params["keys"].([]any); ok {
						for _, k := range ks {
							if s, ok := k.(string); ok {
								keysSent = append(keysSent, s)
								if s == "r" && retryResolves {
									screen = unlockedScreen
								}
							}
						}
					}
				case "agent.prompt":
					txt, _ := req.Params["text"].(string)
					promptsSent = append(promptsSent, txt)
				}
				b, _ := json.Marshal(map[string]any{"id": req.ID, "result": res})
				_, _ = c2.Write(append(b, '\n'))
			}()
			return c1, nil
		},
	}

	// Case 1: Desktop released lock, 'r' unlocks same session cleanly without 'f'
	if err := h.Prompt(t.Context(), "w7:p1", "检查表 III 数据"); err != nil {
		t.Fatalf("Prompt failed: %v", err)
	}
	if !slices.Equal(keysSent, []string{"r"}) {
		t.Fatalf("expected only retry key [r] (never fork [f]), got %v", keysSent)
	}
	if !slices.Equal(promptsSent, []string{"检查表 III 数据"}) {
		t.Fatalf("expected prompt sent once after retry unlock, got %v", promptsSent)
	}

	// Case 2: Desktop still holds lock, must NEVER press 'f' (fork) and must return clear error
	screen = lockedScreen
	retryResolves = false
	keysSent = nil
	promptsSent = nil
	if err := h.Prompt(t.Context(), "w7:p1", "不应创建副本"); err == nil {
		t.Fatal("expected error when desktop still holds lock instead of forking")
	}
	if slices.Contains(keysSent, "f") {
		t.Fatalf("must NEVER send 'f' (fork), got %v", keysSent)
	}
	if len(promptsSent) != 0 {
		t.Fatalf("must not submit prompt when locked, got %v", promptsSent)
	}
}

func TestCodexRolloutChainAndImageExtraction(t *testing.T) {
	t.Setenv("CODEX_HOME", "")
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("USERPROFILE", dir)
	now := time.Now()
	sessDir := filepath.Join(dir, ".codex", "sessions", now.Format("2006"), now.Format("01"), now.Format("02"))
	if err := os.MkdirAll(sessDir, 0o755); err != nil {
		t.Fatal(err)
	}
	cwd := filepath.Join(dir, "SFD-Net 2")
	cwdJSON, _ := json.Marshal(cwd)

	origID := "01a15378-6cc5-78d0-8d61-b0c7e4f8b367"
	segID := "01a1fc1f-27ad-7331-ab36-7a9f501316ce"
	forkID := "01a20149-b855-7b13-b51c-06c45332c3ec"

	segPath := filepath.Join(sessDir, "rollout-2026-11-21T11-21-02-"+origID+"_"+segID+".jsonl")
	segContent := `{"type":"session_meta","payload":{"id":"` + origID + `","cwd":` + string(cwdJSON) + `}}` + "\n" +
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"补完 CVC-300 直接推理"}]}}` + "\n" +
		`{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"已补完 CVC-300 全部 60 张图的直接推理。"}]}}` + "\n"
	if err := os.WriteFile(segPath, []byte(segContent), 0o644); err != nil {
		t.Fatal(err)
	}

	// 1x1 transparent PNG in base64
	tinyPNG := "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
	forkPath := filepath.Join(sessDir, "rollout-2026-11-22T11-25-38-"+forkID+".jsonl")
	forkContent := `{"type":"session_meta","payload":{"id":"` + forkID + `","forked_from_id":"` + origID + `","cwd":` + string(cwdJSON) + `,"history_mode":"paginated","history_base":{"thread_id":"` + segID + `"}}}` + "\n" +
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"继续修改模型图，先给我设计图吧。"}]}}` + "\n" +
		`{"type":"response_item","payload":{"type":"custom_tool_call","call_id":"call_view","name":"exec","input":"image((await tools.view_image({path:\"C:/Users/26422/Desktop/SFD-Net.png\"})).image_url)"}}` + "\n" +
		`{"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"call_view","output":[{"type":"input_text","text":"Script completed"},{"type":"input_image","image_url":"` + tinyPNG + `"}]}}` + "\n" +
		`{"type":"response_item","payload":{"type":"custom_tool_call","call_id":"call_gen","name":"exec","input":"const result=await tools.image_gen__imagegen({prompt:\"Edit SFD-Net\"})"}}` + "\n" +
		`{"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"call_gen","output":[{"type":"input_text","text":"Script completed\nWall time 65.1 seconds"},{"type":"input_image","image_url":"` + tinyPNG + `"},{"type":"input_text","text":"Generated images are saved to C:\\Users\\26422\\.codex\\generated_images\\x.png"}]}}` + "\n" +
		`{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"这是设计预览，桌面上的 Visio 原稿已保留。"}]}}` + "\n" +
		// Turn 2: model ALSO embeds a Markdown file link to the generated PNG -> must NOT duplicate!
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"把输入改成 Video Sequence"}]}}` + "\n" +
		`{"type":"response_item","payload":{"type":"custom_tool_call","call_id":"call_gen2","name":"exec","input":"generatedImage(await tools.image_gen__imagegen({prompt:\"Video Sequence\"}))"}}` + "\n" +
		`{"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"call_gen2","output":[{"type":"input_text","text":"Script completed"},{"type":"input_image","image_url":"` + tinyPNG + `"}]}}` + "\n" +
		`{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"[新版设计稿](C:/Users/26422/.codex/generated_images/exec-2.png)已将输入简化为 Video Sequence。"}]}}` + "\n"
	if err := os.WriteFile(forkPath, []byte(forkContent), 0o644); err != nil {
		t.Fatal(err)
	}

	srv := &Server{herdr: newHerdr("", "hub", dir), home: dir}

	chain := srv.codexRolloutChain(forkPath)
	if len(chain) != 2 || chain[0] != segPath || chain[1] != forkPath {
		t.Fatalf("expected rollout chain [%s, %s], got %v", segPath, forkPath, chain)
	}

	agentKind := "codex"
	tr := srv.transcriptFor("pane:w7:p1", "w7:p1", agentDetail{
		Agent: &agentKind,
		Cwd:   &cwd,
		Session: &struct {
			Kind  string `json:"kind"`
			Value string `json:"value"`
		}{Kind: "id", Value: forkID},
	}, map[string]*transcript{})
	if tr == nil {
		t.Fatal("expected non-nil chained transcript")
	}
	tr.openTail()
	msgs := tr.view()
	// Expect 9 messages total:
	// 0: user (ancestor)
	// 1: assistant (ancestor)
	// 2: user ("继续修改模型图...")
	// 3: tool (view_image -> skipped!)
	// 4: tool (imagegen)
	// 5: assistant ("这是设计预览...\n\n[image:~/.collie/images/...png]" -> image attached below text!)
	// 6: user ("把输入改成 Video Sequence")
	// 7: tool (imagegen 2)
	// 8: assistant ("[新版设计稿](C:/.../exec-2.png)..." -> pendingImgs dropped because reply already links PNG!)
	if len(msgs) != 9 {
		t.Fatalf("expected 9 messages without duplicate image bubbles, got %d: %+v", len(msgs), msgs)
	}
	if !strings.Contains(msgs[5].Text, "这是设计预览") || !strings.Contains(msgs[5].Text, "[image:~/.collie/images/") {
		t.Fatalf("expected Turn 1 reply to carry appended [image:...], got %q", msgs[5].Text)
	}
	if strings.Contains(msgs[8].Text, "[image:") {
		t.Fatalf("expected Turn 2 reply NOT to duplicate [image:...] when Markdown PNG link is present, got %q", msgs[8].Text)
	}

	// Regression test: when herdr omits agent_session (e.g. on Windows ConPTY) and only
	// reports terminal_title_stripped ("论文返修 | SFD-Net 2"), transcriptFor must still
	// resolve the structured transcript via session_index.jsonl / RememberSession!
	sessIndex := filepath.Join(dir, ".codex", "session_index.jsonl")
	if err := os.WriteFile(sessIndex, []byte(`{"id":"`+forkID+`","thread_name":"论文返修"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	trByTitle := srv.transcriptFor("pane:w8:p1", "w8:p1@wlc", agentDetail{
		Agent:         &agentKind,
		Cwd:           &cwd,
		TerminalTitle: "论文返修 | SFD-Net 2",
		Session:       nil,
	}, map[string]*transcript{})
	if trByTitle == nil {
		t.Fatal("expected transcriptFor to resolve Codex transcript from TerminalTitle when agent_session is nil")
	}

	// And RememberSession resolves even when TerminalTitle is empty/generic:
	srv.herdr.RememberSession("w9:p1", forkID)
	trByRemember := srv.transcriptFor("pane:w9:p1", "w9:p1@wlc", agentDetail{
		Agent:         &agentKind,
		Cwd:           &cwd,
		TerminalTitle: "codex",
		Session:       nil,
	}, map[string]*transcript{})
	if trByRemember == nil {
		t.Fatal("expected transcriptFor to resolve Codex transcript from RememberSession when agent_session is nil")
	}

	// And codexDaemonSock succeeds when socket file exists:
	sockDir := filepath.Join(dir, ".codex", "app-server-control")
	if err := os.MkdirAll(sockDir, 0o755); err != nil {
		t.Fatal(err)
	}
	sockFile := filepath.Join(sockDir, "app-server-control.sock")
	if err := os.WriteFile(sockFile, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if got := srv.codexDaemonSock(); got != sockFile {
		t.Fatalf("expected codexDaemonSock=%q, got %q", sockFile, got)
	}
}

func TestRepairMachineDeduplicationAndDeleteCascade(t *testing.T) {
	dir := t.TempDir()
	db, err := openDB(filepath.Join(dir, "herd.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	projectStore.Lock()
	projectStore.loaded = false
	projectStore.list = nil
	projectStore.dismissed = nil
	projectStore.Unlock()

	sessionMetaStore.Lock()
	sessionMetaStore.loaded = false
	sessionMetaStore.byKey = nil
	sessionMetaStore.Unlock()

	history.Lock()
	history.loaded = false
	history.list = nil
	history.Unlock()

	srv := &Server{
		herdr: newHerdr("", "hub", dir),
		token: "tok",
		home:  dir,
		sup:   &Super{db: db, subs: map[chan struct{}]bool{}, st: &State{Settings: Settings{RouterMachine: "wlc", WorkerMachine: "wlc"}}},
		auths: newAuth(db, "tok"),
	}

	// 1. Pair Windows machine ("WLC") and rename it to "Win"
	c1, _ := srv.auths.newCode("machine")
	d1, tok1, rebound1, err := srv.auths.redeem(c1, "machine", "WLC", "windows/amd64", "WLC", `C:\Users\26422`)
	if err != nil || rebound1 || d1.ID != "wlc" {
		t.Fatalf("first pair failed: d1=%+v rebound=%v err=%v", d1, rebound1, err)
	}
	srv.auths.rename("wlc", "Win")

	// 2. Re-pair the exact same physical Windows machine -> must reuse ID "wlc", preserve custom name "Win", and rotate token!
	c2, _ := srv.auths.newCode("machine")
	d2, tok2, rebound2, err := srv.auths.redeem(c2, "machine", "WLC", "windows/amd64", "WLC", `C:\Users\26422`)
	if err != nil {
		t.Fatalf("re-pair failed: %v", err)
	}
	if !rebound2 || d2.ID != "wlc" {
		t.Fatalf("expected re-pair to reuse machine ID 'wlc' with rebound=true, got id=%q rebound=%v", d2.ID, rebound2)
	}
	if d2.Name != "Win" {
		t.Fatalf("expected re-pair to preserve renamed display name 'Win', got %q", d2.Name)
	}
	if tok1 == tok2 {
		t.Fatal("expected re-pair to rotate token")
	}
	if len(srv.auths.list()) != 1 {
		t.Fatalf("expected exactly 1 device (no wlc-2 duplicate), got %d: %+v", len(srv.auths.list()), srv.auths.list())
	}

	// 3. Pair a DIFFERENT Windows machine -> must get distinct ID ("wlc-2")
	c3, _ := srv.auths.newCode("machine")
	d3, _, rebound3, err := srv.auths.redeem(c3, "machine", "WLC", "windows/amd64", "WLC-OFFICE", `C:\Users\other`)
	if err != nil || rebound3 || d3.ID != "wlc-2" {
		t.Fatalf("expected different machine to get wlc-2, got d3=%+v rebound=%v err=%v", d3, rebound3, err)
	}

	// 4. Populate projects, dismissed tombstones, session_meta, history, and ext_snapshot for "wlc"
	srv.herdr.attach(&Machine{ID: "wlc", Name: "Win", OS: "windows/amd64", Online: true})
	projectStore.Lock()
	srv.loadProjectsLocked()
	projectStore.list = append(projectStore.list,
		&Project{ID: "prj_win", Name: "SFD-Net", Machine: "wlc", Cwd: `~\Documents\SFD-Net 2`, Kind: "codex"},
		&Project{ID: "prj_other", Name: "Office", Machine: "wlc-2", Cwd: `D:\Office`, Kind: "codex"},
	)
	projectStore.dismissed["wlc|d:/pythonproject/apix"] = true
	srv.saveProjectsLocked()
	projectStore.Unlock()

	srv.remember(&Ended{Kind: "codex", Machine: "wlc", Cwd: `~\Documents\SFD-Net 2`, Session: "sess-win", Ended: time.Now()})
	srv.saveExternalSnapshot("wlc", []*External{{ID: "cx-sess-win@wlc", Kind: "codex", Machine: "wlc", Session: "sess-win", Title: "论文返修"}})

	sessionMetaStore.Lock()
	srv.loadSessionMetaLocked()
	sessionMetaStore.byKey["s:codex:wlc:sess-win"] = &SessionMeta{Title: "论文返修", ProjectID: "prj_win", UpdatedAt: time.Now()}
	sessionMetaStore.byKey["x:cx-sess-win@wlc"] = &SessionMeta{Title: "论文返修", UpdatedAt: time.Now()}
	sessionMetaStore.byKey["s:codex:wlc-2:sess-keep"] = &SessionMeta{Title: "保留会话", ProjectID: "prj_other", UpdatedAt: time.Now()}
	srv.saveSessionMetaLocked()
	sessionMetaStore.Unlock()

	// 5. Delete "wlc" via /api/devices/wlc/delete -> must cascade-delete all wlc data while keeping wlc-2 untouched!
	req := httptest.NewRequest("POST", "/api/devices/wlc/delete", bytes.NewBufferString(`{}`))
	req.SetPathValue("id", "wlc")
	w := httptest.NewRecorder()
	srv.deleteDevice(w, req)
	if w.Code != 200 {
		t.Fatalf("deleteDevice status=%d body=%s", w.Code, w.Body.String())
	}

	projs := srv.projectsSnapshot()
	if len(projs) != 1 || projs[0].ID != "prj_other" {
		t.Fatalf("expected wlc project cascade-deleted and prj_other kept, got %+v", projs)
	}
	if snap := srv.offlineExternalSnapshot("wlc"); len(snap) != 0 {
		t.Fatalf("expected wlc external snapshot deleted, got %+v", snap)
	}
	meta := srv.sessionMetaSnapshot()
	if _, exists := meta["s:codex:wlc:sess-win"]; exists {
		t.Fatalf("expected wlc session_meta deleted, got %+v", meta)
	}
	if _, exists := meta["x:cx-sess-win@wlc"]; exists {
		t.Fatalf("expected wlc ext session_meta deleted, got %+v", meta)
	}
	if _, exists := meta["s:codex:wlc-2:sess-keep"]; !exists {
		t.Fatalf("expected wlc-2 session_meta preserved, got %+v", meta)
	}
	if srv.sup.st.Settings.RouterMachine != "" || srv.sup.st.Settings.WorkerMachine != "" {
		t.Fatalf("expected RouterMachine/WorkerMachine cleared when pointing to deleted machine, got %+v", srv.sup.st.Settings)
	}

	// 6. Verify /install.ps1 and /install.sh are served directly by Hub Routes()
	mux := srv.Routes()
	for _, p := range []string{"/install.ps1", "/install.sh"} {
		ir := httptest.NewRequest("GET", p, nil)
		iw := httptest.NewRecorder()
		mux.ServeHTTP(iw, ir)
		if iw.Code != 200 || iw.Body.Len() < 500 {
			t.Fatalf("expected %s served with status 200, got code=%d len=%d", p, iw.Code, iw.Body.Len())
		}
	}
}

