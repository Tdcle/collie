package collie

import (
	"bytes"
	"net/http/httptest"
	"path/filepath"
	"testing"
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
