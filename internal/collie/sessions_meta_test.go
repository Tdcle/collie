package collie

import (
	"bytes"
	"net/http/httptest"
	"os"
	"path/filepath"
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
	dev, _, err := srv.auths.redeem(code, "machine", "DV4GH6W2PM", "darwin/arm64")
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

	rArch := httptest.NewRequest("POST", "/api/sessions/archive", bytes.NewBufferString(`{"kind":"codex","machine":"wlc","session":"sess-1","archived":true}`))
	wArch := httptest.NewRecorder()
	srv.archiveSession(wArch, rArch)
	if wArch.Code != 200 || !srv.sessionMetaSnapshot()[ck].Archived {
		t.Fatalf("expected session to be archived")
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
	if len(projs) != 2 || projs[0].Name != "SFD-Net" || projs[0].Cwd != "~/Desktop/SFD_Net" || len(projs[0].Roots) != 2 {
		t.Fatalf("unexpected synced projects: %+v", projs)
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
