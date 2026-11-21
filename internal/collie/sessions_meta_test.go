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
