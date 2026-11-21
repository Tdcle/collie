package collie

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Project represents a pinned workspace directory bound to a specific machine
// and a preferred default agent, grouping its sessions in the sidebar like a
// native desktop IDE/agent app.
type Project struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Machine   string    `json:"machine"`           // "" = Hub, or node device ID
	Cwd       string    `json:"cwd"`               // e.g. "~/maso/collie" or "D:\\Paper"
	Roots     []string  `json:"roots,omitempty"`   // optional multi-root paths imported from host app
	Kind      string    `json:"kind"`              // default agent kind: claude | codex | agy | gemini
	Model     string    `json:"model,omitempty"`   // optional default model
	Effort    string    `json:"effort,omitempty"`  // optional default effort
	HostApp   string    `json:"host_app,omitempty"` // e.g. "Codex 桌面版" when synced from host
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

var projectStore = struct {
	sync.Mutex
	list      []*Project
	dismissed map[string]bool
	loaded    bool
}{}

func newProjectID() string {
	var b [5]byte
	_, _ = rand.Read(b[:])
	return "prj_" + hex.EncodeToString(b[:])
}

func normProjectCwdKey(cwd string) string {
	s := strings.TrimSpace(cwd)
	s = strings.ReplaceAll(s, "\\", "/")
	if len(s) > 1 {
		s = strings.TrimRight(s, "/")
	}
	return strings.ToLower(s)
}

func defaultProjectName(cwd string) string {
	s := strings.TrimSpace(cwd)
	s = strings.TrimRight(s, "/\\")
	if s == "" || s == "~" || s == "/" {
		return "主目录"
	}
	if len(s) == 2 && isAlpha(s[0]) && s[1] == ':' {
		return strings.ToUpper(s)
	}
	idx := strings.LastIndexAny(s, "/\\")
	if idx >= 0 && idx+1 < len(s) {
		return s[idx+1:]
	}
	return s
}

func (s *Server) loadProjectsLocked() {
	if projectStore.loaded {
		return
	}
	projectStore.loaded = true
	projectStore.list = []*Project{}
	projectStore.dismissed = map[string]bool{}
	if s.sup == nil || s.sup.db == nil {
		return
	}
	var raw string
	if s.sup.db.QueryRow(`SELECT v FROM kv WHERE k='projects'`).Scan(&raw) == nil && raw != "" {
		_ = json.Unmarshal([]byte(raw), &projectStore.list)
		if projectStore.list == nil {
			projectStore.list = []*Project{}
		}
	}
	var rawDis string
	if s.sup.db.QueryRow(`SELECT v FROM kv WHERE k='projects_dismissed'`).Scan(&rawDis) == nil && rawDis != "" {
		_ = json.Unmarshal([]byte(rawDis), &projectStore.dismissed)
		if projectStore.dismissed == nil {
			projectStore.dismissed = map[string]bool{}
		}
	}
}

func (s *Server) saveProjectsLocked() {
	if s.sup == nil || s.sup.db == nil {
		return
	}
	b, _ := json.Marshal(projectStore.list)
	if _, err := s.sup.db.Exec(`INSERT INTO kv(k,v) VALUES('projects',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, string(b)); err != nil {
		log.Printf("save projects: %v", err)
	}
	if projectStore.dismissed != nil {
		db, _ := json.Marshal(projectStore.dismissed)
		if _, err := s.sup.db.Exec(`INSERT INTO kv(k,v) VALUES('projects_dismissed',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, string(db)); err != nil {
			log.Printf("save projects_dismissed: %v", err)
		}
	}
}

func (s *Server) machineHome(machine string) string {
	if s.herdr == nil {
		if machine == "" {
			return s.home
		}
		return ""
	}
	for _, m := range s.herdr.Machines() {
		if m.ID == machine {
			return m.Home
		}
	}
	return ""
}

func (s *Server) projectsSnapshot() []*Project {
	if s.node {
		return nil
	}
	s.triggerHostProjectSync()
	projectStore.Lock()
	defer projectStore.Unlock()
	s.loadProjectsLocked()
	if len(projectStore.list) == 0 {
		return nil
	}
	out := make([]*Project, 0, len(projectStore.list))
	for _, p := range projectStore.list {
		if p == nil {
			continue
		}
		cp := *p
		if len(p.Roots) > 0 {
			cp.Roots = append([]string(nil), p.Roots...)
		}
		out = append(out, &cp)
	}
	return out
}

func (s *Server) listProjects(w http.ResponseWriter, _ *http.Request) {
	list := s.projectsSnapshot()
	if list == nil {
		list = []*Project{}
	}
	writeJSON(w, 200, map[string]any{"projects": list})
}

func (s *Server) createProject(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name    string `json:"name"`
		Machine string `json:"machine"`
		Cwd     string `json:"cwd"`
		Kind    string `json:"kind"`
		Model   string `json:"model"`
		Effort  string `json:"effort"`
	}
	if !decode(w, r, &body) {
		return
	}
	cwd := strings.TrimSpace(body.Cwd)
	if cwd == "" {
		writeJSON(w, 400, map[string]any{"error": "请选择项目目录"})
		return
	}
	kind := normSessionKind(body.Kind)
	if kind == "" {
		kind = "claude"
	}
	if _, ok := kinds[kind]; !ok {
		writeJSON(w, 400, map[string]any{"error": "不支持的 Agent 类型"})
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		name = defaultProjectName(cwd)
	}
	if len([]rune(name)) > 60 {
		name = string([]rune(name)[:60])
	}
	machine := strings.TrimSpace(body.Machine)
	if machine == "hub" || machine == "local" {
		machine = ""
	}
	now := time.Now()
	home := s.machineHome(machine)
	cwdKey := expandProjectCwdKey(cwd, home)

	projectStore.Lock()
	s.loadProjectsLocked()
	if projectStore.dismissed != nil && cwdKey != "" {
		delete(projectStore.dismissed, machine+"|"+cwdKey)
	}
	var created *Project
	for _, existing := range projectStore.list {
		if existing != nil && existing.Machine == machine && expandProjectCwdKey(existing.Cwd, home) == cwdKey {
			existing.Name = name
			existing.Cwd = cwd
			existing.Kind = kind
			existing.Model = strings.TrimSpace(body.Model)
			existing.Effort = strings.TrimSpace(body.Effort)
			existing.UpdatedAt = now
			cp := *existing
			created = &cp
			break
		}
	}
	if created == nil {
		p := &Project{
			ID:        newProjectID(),
			Name:      name,
			Machine:   machine,
			Cwd:       cwd,
			Kind:      kind,
			Model:     strings.TrimSpace(body.Model),
			Effort:    strings.TrimSpace(body.Effort),
			CreatedAt: now,
			UpdatedAt: now,
		}
		projectStore.list = append(projectStore.list, p)
		cp := *p
		created = &cp
	}
	s.saveProjectsLocked()
	projectStore.Unlock()

	if s.sup != nil {
		s.sup.changed()
	}
	writeJSON(w, 200, map[string]any{"ok": true, "project": created})
}

func (s *Server) updateProject(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	var body struct {
		Name    *string `json:"name"`
		Machine *string `json:"machine"`
		Cwd     *string `json:"cwd"`
		Kind    *string `json:"kind"`
		Model   *string `json:"model"`
		Effort  *string `json:"effort"`
	}
	if !decode(w, r, &body) {
		return
	}
	projectStore.Lock()
	s.loadProjectsLocked()
	var updated *Project
	for _, p := range projectStore.list {
		if p == nil || p.ID != id {
			continue
		}
		if body.Cwd != nil {
			cwd := strings.TrimSpace(*body.Cwd)
			if cwd == "" {
				projectStore.Unlock()
				writeJSON(w, 400, map[string]any{"error": "项目目录不能为空"})
				return
			}
			p.Cwd = cwd
		}
		if body.Name != nil {
			name := strings.TrimSpace(*body.Name)
			if name == "" {
				name = defaultProjectName(p.Cwd)
			}
			if len([]rune(name)) > 60 {
				name = string([]rune(name)[:60])
			}
			p.Name = name
		}
		if body.Machine != nil {
			m := strings.TrimSpace(*body.Machine)
			if m == "hub" || m == "local" {
				m = ""
			}
			p.Machine = m
		}
		if body.Kind != nil {
			k := normSessionKind(*body.Kind)
			if _, ok := kinds[k]; ok {
				p.Kind = k
			}
		}
		if body.Model != nil {
			p.Model = strings.TrimSpace(*body.Model)
		}
		if body.Effort != nil {
			p.Effort = strings.TrimSpace(*body.Effort)
		}
		p.UpdatedAt = time.Now()
		cp := *p
		updated = &cp
		break
	}
	if updated == nil {
		projectStore.Unlock()
		writeJSON(w, 404, map[string]any{"error": "找不到这个项目"})
		return
	}
	s.saveProjectsLocked()
	projectStore.Unlock()

	if s.sup != nil {
		s.sup.changed()
	}
	writeJSON(w, 200, map[string]any{"ok": true, "project": updated})
}

func (s *Server) deleteProject(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	projectStore.Lock()
	s.loadProjectsLocked()
	next := make([]*Project, 0, len(projectStore.list))
	removed := false
	for _, p := range projectStore.list {
		if p != nil && p.ID == id {
			removed = true
			home := s.machineHome(p.Machine)
			if projectStore.dismissed == nil {
				projectStore.dismissed = map[string]bool{}
			}
			if k := expandProjectCwdKey(p.Cwd, home); k != "" {
				projectStore.dismissed[p.Machine+"|"+k] = true
			}
			for _, rt := range p.Roots {
				if k := expandProjectCwdKey(rt, home); k != "" {
					projectStore.dismissed[p.Machine+"|"+k] = true
				}
			}
			continue
		}
		if p != nil {
			next = append(next, p)
		}
	}
	projectStore.list = next
	if removed {
		s.saveProjectsLocked()
	}
	projectStore.Unlock()
	if !removed {
		writeJSON(w, 404, map[string]any{"error": "找不到这个项目"})
		return
	}

	// Unbind sessions explicitly referencing the deleted project without deleting the sessions.
	sessionMetaStore.Lock()
	s.loadSessionMetaLocked()
	dirtyMeta := false
	for k, m := range sessionMetaStore.byKey {
		if m != nil && m.ProjectID == id {
			m.ProjectID = ""
			m.UpdatedAt = time.Now()
			if m.Title == "" && !m.Archived && !m.Deleted && m.ProjectID == "" {
				delete(sessionMetaStore.byKey, k)
			}
			dirtyMeta = true
		}
	}
	if dirtyMeta {
		s.saveSessionMetaLocked()
	}
	sessionMetaStore.Unlock()

	if s.sup != nil {
		s.sup.changed()
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) bindPaneProject(paneID, projectID string) {
	paneID = strings.TrimSpace(paneID)
	projectID = strings.TrimSpace(projectID)
	if paneID == "" || projectID == "" || s.node {
		return
	}
	sessionMetaStore.Lock()
	s.loadSessionMetaLocked()
	upsertMetaKey("p:"+paneID, func(m *SessionMeta) {
		m.ProjectID = projectID
	})
	s.saveSessionMetaLocked()
	sessionMetaStore.Unlock()
	if s.sup != nil {
		s.sup.changed()
	}
}

func (s *Server) promotePaneProjectToSession(paneID, kind, machine, session string) {
	if s.node || paneID == "" || session == "" {
		return
	}
	ckey := canonicalSessionKey(kind, machine, session)
	if ckey == "" {
		return
	}
	sessionMetaStore.Lock()
	s.loadSessionMetaLocked()
	pm := sessionMetaStore.byKey["p:"+paneID]
	if pm != nil && pm.ProjectID != "" {
		cm := sessionMetaStore.byKey[ckey]
		if cm == nil || cm.ProjectID == "" {
			upsertMetaKey(ckey, func(m *SessionMeta) {
				m.ProjectID = pm.ProjectID
			})
			s.saveSessionMetaLocked()
		}
	}
	sessionMetaStore.Unlock()
}

// assignSessionProject explicitly binds a session to a project (or "-" to detach
// it from automatic folder-based project grouping).
func (s *Server) assignSessionProject(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Key       string `json:"key"`
		PaneID    string `json:"pane_id"`
		ExtID     string `json:"ext_id"`
		HistID    string `json:"hist_id"`
		Kind      string `json:"kind"`
		Machine   string `json:"machine"`
		Session   string `json:"session"`
		ProjectID string `json:"project_id"`
	}
	if !decode(w, r, &body) {
		return
	}
	pid := strings.TrimSpace(body.ProjectID)
	ckey := canonicalSessionKey(body.Kind, body.Machine, body.Session)
	sessionMetaStore.Lock()
	s.loadSessionMetaLocked()
	for _, k := range []string{body.Key, ckey, prefixKey("p:", body.PaneID), prefixKey("x:", body.ExtID), prefixKey("h:", body.HistID)} {
		upsertMetaKey(k, func(m *SessionMeta) {
			m.ProjectID = pid
		})
	}
	s.saveSessionMetaLocked()
	sessionMetaStore.Unlock()
	if s.sup != nil {
		s.sup.changed()
	}
	writeJSON(w, 200, map[string]any{"ok": true, "project_id": pid})
}
