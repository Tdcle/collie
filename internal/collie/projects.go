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

func sessionMetaKeyMatchesMachine(k, machine string) bool {
	if machine == "" || k == "" {
		return false
	}
	if strings.HasPrefix(k, "s:") {
		parts := strings.SplitN(k, ":", 4)
		return len(parts) == 4 && parts[2] == machine
	}
	if strings.HasPrefix(k, "p:") || strings.HasPrefix(k, "x:") {
		_, m := split(k[2:])
		return m == machine
	}
	return false
}

// purgeMachineData cascade-deletes all projects, session metadata, external
// session snapshots, history entries, and machine settings bound to a removed
// machine so deleting a computer leaves zero orphaned records behind.
func (s *Server) purgeMachineData(machine string) {
	machine = strings.TrimSpace(machine)
	if machine == "" {
		return
	}
	if s.herdr != nil {
		s.herdr.purgeMachine(machine)
	}

	// 1. Remove projects and dismissed project tombstones for this machine.
	removedProjIDs := map[string]bool{}
	projectStore.Lock()
	s.loadProjectsLocked()
	keptProjs := make([]*Project, 0, len(projectStore.list))
	projChanged := false
	for _, p := range projectStore.list {
		if p == nil {
			continue
		}
		if p.Machine == machine {
			removedProjIDs[p.ID] = true
			projChanged = true
			continue
		}
		keptProjs = append(keptProjs, p)
	}
	projectStore.list = keptProjs
	prefix := machine + "|"
	for k := range projectStore.dismissed {
		if strings.HasPrefix(k, prefix) {
			delete(projectStore.dismissed, k)
			projChanged = true
		}
	}
	if projChanged {
		s.saveProjectsLocked()
	}
	projectStore.Unlock()

	// 2. Remove ended history entries for this machine and collect their IDs.
	removedHistIDs := map[string]bool{}
	history.Lock()
	s.loadHistory()
	keptHist := make([]*Ended, 0, len(history.list))
	histChanged := false
	for _, e := range history.list {
		if e == nil {
			continue
		}
		if e.Machine == machine {
			if e.ID != "" {
				removedHistIDs[e.ID] = true
			}
			histChanged = true
			continue
		}
		keptHist = append(keptHist, e)
	}
	history.list = keptHist
	if histChanged {
		s.saveHistory()
	}
	history.Unlock()

	// 3. Remove session_meta entries belonging to this machine or its deleted projects/history.
	sessionMetaStore.Lock()
	s.loadSessionMetaLocked()
	metaChanged := false
	for k, m := range sessionMetaStore.byKey {
		if sessionMetaKeyMatchesMachine(k, machine) ||
			(strings.HasPrefix(k, "h:") && removedHistIDs[k[2:]]) {
			delete(sessionMetaStore.byKey, k)
			metaChanged = true
			continue
		}
		if m != nil && removedProjIDs[m.ProjectID] {
			m.ProjectID = ""
			m.UpdatedAt = time.Now()
			metaChanged = true
		}
	}
	if metaChanged {
		s.saveSessionMetaLocked()
	}
	sessionMetaStore.Unlock()

	// 4. Clear cached and persisted external session snapshots for this machine.
	remoteExternal.Lock()
	delete(remoteExternal.m, machine)
	remoteExternal.Unlock()
	if s.sup != nil && s.sup.db != nil {
		_, _ = s.sup.db.Exec(`DELETE FROM kv WHERE k=?`, "ext_snapshot:"+machine)
	}

	// 5. Clear RouterMachine / WorkerMachine references if they pointed to this machine.
	if s.sup != nil {
		s.sup.mu.Lock()
		settingsChanged := false
		if s.sup.st.Settings.RouterMachine == machine {
			s.sup.st.Settings.RouterMachine = ""
			settingsChanged = true
		}
		if s.sup.st.Settings.WorkerMachine == machine {
			s.sup.st.Settings.WorkerMachine = ""
			settingsChanged = true
		}
		if settingsChanged || projChanged || histChanged || metaChanged {
			s.sup.changed()
		}
		s.sup.mu.Unlock()
	}
}

// snapshotProjects returns value copies of all registered projects for safe
// lock-free inspection by Router prompts, `collie list`, and project matching.
func (s *Server) snapshotProjects() []*Project {
	if s == nil {
		return nil
	}
	projectStore.Lock()
	s.loadProjectsLocked()
	out := make([]*Project, 0, len(projectStore.list))
	for _, p := range projectStore.list {
		if p == nil {
			continue
		}
		cp := *p
		out = append(out, &cp)
	}
	projectStore.Unlock()
	return out
}

// matchProjectsInText finds pinned projects explicitly mentioned by name (or cwd)
// in a user's message so Collie immediately knows which computer and directory
// hold that project without guessing.
func (s *Server) matchProjectsInText(text string) []*Project {
	low := strings.ToLower(strings.TrimSpace(text))
	if low == "" {
		return nil
	}
	all := s.snapshotProjects()
	seen := map[string]bool{}
	var out []*Project
	for _, p := range all {
		name := strings.TrimSpace(p.Name)
		cwd := strings.TrimSpace(p.Cwd)
		matched := false
		if name != "" && name != "主目录" && len([]rune(name)) >= 2 && strings.Contains(low, strings.ToLower(name)) {
			matched = true
		} else if len(cwd) >= 4 && cwd != "~" && strings.Contains(low, strings.ToLower(cwd)) {
			matched = true
		}
		if !matched {
			continue
		}
		dedupKey := p.Machine + "|" + normProjectCwdKey(cwd)
		if seen[dedupKey] {
			continue
		}
		seen[dedupKey] = true
		out = append(out, p)
	}
	return out
}

// pruneOrphanMachineState cleans up any leftover kv records for machines that
// are no longer in Auth.devices (e.g. deleted by an older Collie version).
func (s *Server) pruneOrphanMachineState() {
	if s.node || s.auths == nil {
		return
	}
	valid := map[string]bool{"": true}
	for _, d := range s.auths.list() {
		if d.Kind == "machine" {
			valid[d.ID] = true
		}
	}
	orphans := map[string]bool{}
	projectStore.Lock()
	s.loadProjectsLocked()
	for _, p := range projectStore.list {
		if p != nil && !valid[p.Machine] {
			orphans[p.Machine] = true
		}
	}
	for k := range projectStore.dismissed {
		if i := strings.IndexByte(k, '|'); i > 0 && !valid[k[:i]] {
			orphans[k[:i]] = true
		}
	}
	projectStore.Unlock()

	if s.sup != nil && s.sup.db != nil {
		rows, err := s.sup.db.Query(`SELECT k FROM kv WHERE k LIKE 'ext_snapshot:%'`)
		if err == nil {
			for rows.Next() {
				var k string
				if rows.Scan(&k) == nil {
					if m := strings.TrimPrefix(k, "ext_snapshot:"); m != "" && !valid[m] {
						orphans[m] = true
					}
				}
			}
			rows.Close()
		}
	}
	for m := range orphans {
		s.purgeMachineData(m)
	}
}
