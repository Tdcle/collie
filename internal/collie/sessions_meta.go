package collie

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

// SessionMeta stores user-defined metadata (custom title, archived flag,
// deleted tombstone) for any session across live herdr panes, external CLI/App
// sessions, and ended history entries.
type SessionMeta struct {
	Title     string    `json:"title,omitempty"`
	ProjectID string    `json:"project_id,omitempty"`
	Archived  bool      `json:"archived,omitempty"`
	Deleted   bool      `json:"deleted,omitempty"`
	UpdatedAt time.Time `json:"updated_at"`
}

var sessionMetaStore = struct {
	sync.Mutex
	byKey  map[string]*SessionMeta
	loaded bool
}{}

func normSessionKind(kind string) string {
	k := strings.ToLower(strings.TrimSpace(kind))
	if k == "antigravity" {
		return "agy"
	}
	return k
}

func canonicalSessionKey(kind, machine, session string) string {
	session = strings.TrimSpace(session)
	if session == "" {
		return ""
	}
	return "s:" + normSessionKind(kind) + ":" + strings.TrimSpace(machine) + ":" + session
}

func (s *Server) loadSessionMetaLocked() {
	if sessionMetaStore.loaded {
		return
	}
	sessionMetaStore.loaded = true
	sessionMetaStore.byKey = map[string]*SessionMeta{}
	if s.sup == nil || s.sup.db == nil {
		return
	}
	var raw string
	if s.sup.db.QueryRow(`SELECT v FROM kv WHERE k='session_meta'`).Scan(&raw) == nil && raw != "" {
		_ = json.Unmarshal([]byte(raw), &sessionMetaStore.byKey)
		if sessionMetaStore.byKey == nil {
			sessionMetaStore.byKey = map[string]*SessionMeta{}
		}
	}
}

func (s *Server) saveSessionMetaLocked() {
	if s.sup == nil || s.sup.db == nil {
		return
	}
	b, _ := json.Marshal(sessionMetaStore.byKey)
	if _, err := s.sup.db.Exec(`INSERT INTO kv(k,v) VALUES('session_meta',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, string(b)); err != nil {
		log.Printf("save session_meta: %v", err)
	}
}

func (s *Server) sessionMetaSnapshot() map[string]*SessionMeta {
	if s.node {
		return nil
	}
	sessionMetaStore.Lock()
	defer sessionMetaStore.Unlock()
	s.loadSessionMetaLocked()
	if len(sessionMetaStore.byKey) == 0 {
		return nil
	}
	out := make(map[string]*SessionMeta, len(sessionMetaStore.byKey))
	for k, v := range sessionMetaStore.byKey {
		if v == nil || (v.Title == "" && v.ProjectID == "" && !v.Archived && !v.Deleted) {
			continue
		}
		cp := *v
		out[k] = &cp
	}
	return out
}

func (s *Server) isSessionDeleted(kind, machine, session string) bool {
	key := canonicalSessionKey(kind, machine, session)
	if key == "" {
		return false
	}
	sessionMetaStore.Lock()
	defer sessionMetaStore.Unlock()
	s.loadSessionMetaLocked()
	m := sessionMetaStore.byKey[key]
	return m != nil && m.Deleted
}

func (s *Server) clearSessionArchivedOrDeleted(kind, machine, session string) {
	key := canonicalSessionKey(kind, machine, session)
	if key == "" {
		return
	}
	sessionMetaStore.Lock()
	s.loadSessionMetaLocked()
	m := sessionMetaStore.byKey[key]
	changed := false
	if m != nil && (m.Archived || m.Deleted) {
		m.Archived = false
		m.Deleted = false
		m.UpdatedAt = time.Now()
		changed = true
	}
	if changed {
		s.saveSessionMetaLocked()
	}
	sessionMetaStore.Unlock()
	if changed && s.sup != nil {
		s.sup.changed()
	}
}

func upsertMetaKey(key string, fn func(m *SessionMeta)) {
	key = strings.TrimSpace(key)
	if key == "" {
		return
	}
	m := sessionMetaStore.byKey[key]
	if m == nil {
		m = &SessionMeta{}
		sessionMetaStore.byKey[key] = m
	}
	fn(m)
	m.UpdatedAt = time.Now()
	if m.Title == "" && m.ProjectID == "" && !m.Archived && !m.Deleted {
		delete(sessionMetaStore.byKey, key)
	}
}

// renameSession sets or clears a custom display title for any session.
func (s *Server) renameSession(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Key         string `json:"key"`
		PaneID      string `json:"pane_id"`
		WorkspaceID string `json:"workspace_id"`
		ExtID       string `json:"ext_id"`
		HistID      string `json:"hist_id"`
		Kind        string `json:"kind"`
		Machine     string `json:"machine"`
		Session     string `json:"session"`
		Title       string `json:"title"`
	}
	if !decode(w, r, &body) {
		return
	}
	title := strings.TrimSpace(body.Title)
	if len([]rune(title)) > 80 {
		title = string([]rune(title)[:80])
	}
	ckey := canonicalSessionKey(body.Kind, body.Machine, body.Session)
	sessionMetaStore.Lock()
	s.loadSessionMetaLocked()
	for _, k := range []string{body.Key, ckey, prefixKey("p:", body.PaneID), prefixKey("x:", body.ExtID), prefixKey("h:", body.HistID)} {
		upsertMetaKey(k, func(m *SessionMeta) { m.Title = title })
	}
	s.saveSessionMetaLocked()
	sessionMetaStore.Unlock()

	if body.HistID != "" && title != "" {
		history.Lock()
		s.loadHistory()
		for _, h := range history.list {
			if h.ID == body.HistID {
				h.Title = title
				s.saveHistory()
				break
			}
		}
		history.Unlock()
	}
	if body.WorkspaceID != "" && title != "" {
		ctx, cancel := context.WithTimeout(r.Context(), 4*time.Second)
		_ = s.herdr.Call(ctx, "workspace.rename", map[string]any{"workspace_id": body.WorkspaceID, "label": title}, nil)
		cancel()
	}
	if s.sup != nil {
		s.sup.changed()
	}
	writeJSON(w, 200, map[string]any{"ok": true, "title": title})
}

// archiveSession archives or unarchives a session. Archiving a live herdr
// workspace gracefully stops it and records its ended session so it appears
// immediately in the Archived section.
func (s *Server) archiveSession(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Key         string `json:"key"`
		PaneID      string `json:"pane_id"`
		WorkspaceID string `json:"workspace_id"`
		ExtID       string `json:"ext_id"`
		HistID      string `json:"hist_id"`
		Kind        string `json:"kind"`
		Machine     string `json:"machine"`
		Session     string `json:"session"`
		Cwd         string `json:"cwd"`
		Title       string `json:"title"`
		Name        string `json:"name"`
		Archived    bool   `json:"archived"`
	}
	if !decode(w, r, &body) {
		return
	}
	ckey := canonicalSessionKey(body.Kind, body.Machine, body.Session)
	sessionMetaStore.Lock()
	s.loadSessionMetaLocked()
	for _, k := range []string{body.Key, ckey, prefixKey("x:", body.ExtID), prefixKey("h:", body.HistID)} {
		upsertMetaKey(k, func(m *SessionMeta) {
			m.Archived = body.Archived
			if body.Archived {
				m.Deleted = false
			}
			if body.Title != "" && m.Title == "" {
				m.Title = strings.TrimSpace(body.Title)
			}
		})
	}
	s.saveSessionMetaLocked()
	sessionMetaStore.Unlock()

	if body.Archived && body.WorkspaceID != "" {
		ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
		_ = s.herdr.Call(ctx, "workspace.close", map[string]any{"workspace_id": body.WorkspaceID}, nil)
		cancel()
		if body.Session != "" && body.Kind != "" {
			s.remember(&Ended{
				Kind: normSessionKind(body.Kind), Machine: body.Machine, Cwd: body.Cwd,
				Title: body.Title, Name: body.Name, Session: body.Session, Ended: time.Now(),
			})
		}
	}
	if s.sup != nil {
		s.sup.changed()
	}
	writeJSON(w, 200, map[string]any{"ok": true, "archived": body.Archived})
}

// deleteSession closes any live workspace, drops history records, and writes a
// deleted tombstone so disk-backed external conversations stay hidden.
func (s *Server) deleteSession(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Key         string `json:"key"`
		PaneID      string `json:"pane_id"`
		WorkspaceID string `json:"workspace_id"`
		ExtID       string `json:"ext_id"`
		HistID      string `json:"hist_id"`
		Kind        string `json:"kind"`
		Machine     string `json:"machine"`
		Session     string `json:"session"`
	}
	if !decode(w, r, &body) {
		return
	}
	ckey := canonicalSessionKey(body.Kind, body.Machine, body.Session)
	sessionMetaStore.Lock()
	s.loadSessionMetaLocked()
	for _, k := range []string{body.Key, ckey, prefixKey("p:", body.PaneID), prefixKey("x:", body.ExtID), prefixKey("h:", body.HistID)} {
		upsertMetaKey(k, func(m *SessionMeta) {
			m.Deleted = true
			m.Archived = false
		})
	}
	s.saveSessionMetaLocked()
	sessionMetaStore.Unlock()

	if body.WorkspaceID != "" {
		ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
		_ = s.herdr.Call(ctx, "workspace.close", map[string]any{"workspace_id": body.WorkspaceID}, nil)
		cancel()
	}
	if body.Session != "" && body.Kind != "" {
		s.forgetSession(normSessionKind(body.Kind), body.Machine, body.Session)
	}
	if body.HistID != "" {
		history.Lock()
		s.loadHistory()
		kept := history.list[:0]
		for _, x := range history.list {
			if x.ID != body.HistID {
				kept = append(kept, x)
			}
		}
		history.list = kept
		s.saveHistory()
		history.Unlock()
	}
	if s.sup != nil {
		s.sup.changed()
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func prefixKey(prefix, v string) string {
	v = strings.TrimSpace(v)
	if v == "" {
		return ""
	}
	return prefix + v
}
