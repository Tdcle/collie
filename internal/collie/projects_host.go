package collie

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// HostProject describes a project configured natively in a desktop agent app on
// a host machine (currently Codex Desktop's projects in state_<n>.sqlite and
// .codex-global-state.json). Read-only by design: desktop apps hold their own
// Electron state in memory, so Collie reads them without mutating their files.
type HostProject struct {
	HostID    string    `json:"host_id"`
	Name      string    `json:"name"`
	Cwd       string    `json:"cwd"`
	Roots     []string  `json:"roots,omitempty"`
	Kind      string    `json:"kind"`
	App       string    `json:"app"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

func normalizeHostPath(p string) string {
	p = strings.TrimSpace(p)
	if p == "" {
		return ""
	}
	if isWindowsPath(p) {
		return winClean(p)
	}
	return filepath.Clean(p)
}

func (s *Server) listHostProjectsNode(w http.ResponseWriter, _ *http.Request) {
	list := s.localHostProjects()
	if list == nil {
		list = []*HostProject{}
	}
	writeJSON(w, 200, map[string]any{"projects": list})
}

func (s *Server) localHostProjects() []*HostProject {
	var out []*HostProject
	seen := map[string]bool{}
	add := func(hp *HostProject) {
		if hp == nil || hp.Cwd == "" {
			return
		}
		key := normProjectCwdKey(hp.Cwd)
		if seen[key] {
			return
		}
		seen[key] = true
		out = append(out, hp)
	}
	for _, hp := range s.codexSQLiteProjects() {
		add(hp)
	}
	for _, hp := range s.codexGlobalStateProjects() {
		add(hp)
	}
	return out
}

func (s *Server) codexSQLiteProjects() []*HostProject {
	path := s.codexStateDB()
	if path == "" {
		return nil
	}
	db, err := sql.Open("sqlite", sqliteURI(path, "mode=ro&_pragma=busy_timeout(2000)"))
	if err != nil {
		return nil
	}
	defer db.Close()

	rootsByID := map[string][]string{}
	if rres, err := db.Query(`SELECT project_id, path FROM project_roots ORDER BY project_id, position ASC`); err == nil {
		for rres.Next() {
			var pid, root string
			if rres.Scan(&pid, &root) == nil {
				if clean := normalizeHostPath(root); clean != "" {
					rootsByID[pid] = append(rootsByID[pid], clean)
				}
			}
		}
		rres.Close()
	}

	res, err := db.Query(`SELECT id, name, created_at_ms, updated_at_ms FROM projects ORDER BY position ASC, updated_at_ms DESC`)
	if err != nil {
		return nil
	}
	defer res.Close()
	var out []*HostProject
	for res.Next() {
		var id, name string
		var createdMS, updatedMS int64
		if res.Scan(&id, &name, &createdMS, &updatedMS) != nil {
			continue
		}
		roots := rootsByID[id]
		if len(roots) == 0 {
			continue
		}
		name = strings.TrimSpace(name)
		if name == "" {
			name = defaultProjectName(roots[0])
		}
		created := time.Now()
		if createdMS > 0 {
			created = time.UnixMilli(createdMS)
		}
		updated := created
		if updatedMS > 0 {
			updated = time.UnixMilli(updatedMS)
		}
		out = append(out, &HostProject{
			HostID:    "codex:" + id,
			Name:      name,
			Cwd:       roots[0],
			Roots:     roots,
			Kind:      "codex",
			App:       appCodex,
			CreatedAt: created,
			UpdatedAt: updated,
		})
	}
	return out
}

func (s *Server) codexGlobalStateProjects() []*HostProject {
	p := filepath.Join(s.codexHome(), ".codex-global-state.json")
	b, err := os.ReadFile(p)
	if err != nil {
		return nil
	}
	var doc struct {
		Order []string `json:"project-order"`
		Local map[string]struct {
			ID        string   `json:"id"`
			Name      string   `json:"name"`
			RootPaths []string `json:"rootPaths"`
			CreatedAt int64    `json:"createdAt"`
			UpdatedAt int64    `json:"updatedAt"`
		} `json:"local-projects"`
	}
	if json.Unmarshal(b, &doc) != nil || len(doc.Local) == 0 {
		return nil
	}
	ids := make([]string, 0, len(doc.Local))
	inOrder := map[string]bool{}
	for _, id := range doc.Order {
		if _, ok := doc.Local[id]; ok && !inOrder[id] {
			ids = append(ids, id)
			inOrder[id] = true
		}
	}
	rest := make([]string, 0)
	for id := range doc.Local {
		if !inOrder[id] {
			rest = append(rest, id)
		}
	}
	sort.Slice(rest, func(i, j int) bool {
		return doc.Local[rest[i]].UpdatedAt > doc.Local[rest[j]].UpdatedAt
	})
	ids = append(ids, rest...)

	var out []*HostProject
	for _, id := range ids {
		lp := doc.Local[id]
		var roots []string
		for _, r := range lp.RootPaths {
			if clean := normalizeHostPath(r); clean != "" {
				roots = append(roots, clean)
			}
		}
		if len(roots) == 0 {
			continue
		}
		name := strings.TrimSpace(lp.Name)
		if name == "" {
			name = defaultProjectName(roots[0])
		}
		created := time.Now()
		if lp.CreatedAt > 0 {
			created = time.UnixMilli(lp.CreatedAt)
		}
		updated := created
		if lp.UpdatedAt > 0 {
			updated = time.UnixMilli(lp.UpdatedAt)
		}
		out = append(out, &HostProject{
			HostID:    "codex-local:" + id,
			Name:      name,
			Cwd:       roots[0],
			Roots:     roots,
			Kind:      "codex",
			App:       appCodex,
			CreatedAt: created,
			UpdatedAt: updated,
		})
	}
	return out
}

var hostProjectSync = struct {
	sync.Mutex
	lastByMachine map[string]time.Time
	running       bool
}{lastByMachine: map[string]time.Time{}}

// triggerHostProjectSync refreshes host projects asynchronously in the background
// when any connected machine hasn't been synced in the last 30s.
func (s *Server) triggerHostProjectSync() {
	if s.node || s.sup == nil || s.sup.db == nil || s.herdr == nil {
		return
	}
	machines := s.herdr.Machines()
	now := time.Now()
	hostProjectSync.Lock()
	if hostProjectSync.running {
		hostProjectSync.Unlock()
		return
	}
	need := false
	for _, m := range machines {
		if !m.Online {
			continue
		}
		if now.Sub(hostProjectSync.lastByMachine[m.ID]) > 30*time.Second {
			need = true
			break
		}
	}
	if !need {
		hostProjectSync.Unlock()
		return
	}
	hostProjectSync.running = true
	hostProjectSync.Unlock()

	go func() {
		defer func() {
			hostProjectSync.Lock()
			hostProjectSync.running = false
			hostProjectSync.Unlock()
		}()
		ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
		defer cancel()
		_, changed := s.syncHostProjectsNow(ctx)
		if changed && s.sup != nil {
			s.sup.changed()
		}
	}()
}

func (s *Server) fetchMachineHostProjects(ctx context.Context, m Machine) ([]*HostProject, bool) {
	if m.Local {
		return s.localHostProjects(), true
	}
	client, err := s.herdr.Client(m.ID)
	if err != nil {
		return nil, false
	}
	reqCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(reqCtx, "GET", "http://node/api/host-projects", nil)
	resp, err := client.Do(req)
	if err != nil {
		return nil, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, false
	}
	var body struct {
		Projects []*HostProject `json:"projects"`
	}
	if json.NewDecoder(resp.Body).Decode(&body) != nil {
		return nil, false
	}
	return body.Projects, true
}

func expandProjectCwdKey(cwd, home string) string {
	s := strings.TrimSpace(cwd)
	h := strings.TrimSpace(home)
	if h != "" && (s == "~" || strings.HasPrefix(s, "~/") || strings.HasPrefix(s, `~\`)) {
		hNorm := strings.TrimRight(strings.ReplaceAll(h, `\`, "/"), "/")
		rest := strings.TrimLeft(strings.ReplaceAll(s[1:], `\`, "/"), "/")
		if rest == "" {
			s = hNorm
		} else {
			s = hNorm + "/" + rest
		}
	}
	return normProjectCwdKey(s)
}

func compactDisplayCwd(cwd, home string) string {
	c := strings.TrimSpace(cwd)
	h := strings.TrimSpace(home)
	if h == "" || c == "" {
		return c
	}
	isWin := isWindowsPath(c) || isWindowsPath(h)
	cSlash := strings.ReplaceAll(c, `\`, "/")
	hSlash := strings.TrimRight(strings.ReplaceAll(h, `\`, "/"), "/")
	if hSlash == "" {
		return c
	}
	match := false
	if isWin {
		match = strings.EqualFold(cSlash, hSlash) || (len(cSlash) > len(hSlash) && strings.EqualFold(cSlash[:len(hSlash)], hSlash) && cSlash[len(hSlash)] == '/')
	} else {
		match = cSlash == hSlash || strings.HasPrefix(cSlash, hSlash+"/")
	}
	if !match {
		return c
	}
	rest := strings.TrimLeft(cSlash[len(hSlash):], "/")
	if rest == "" {
		return "~"
	}
	if isWin {
		return `~\` + strings.ReplaceAll(rest, "/", `\`)
	}
	return "~/" + rest
}

func (s *Server) syncHostProjectsNow(ctx context.Context) (added int, changed bool) {
	if s.node || s.sup == nil || s.sup.db == nil || s.herdr == nil {
		return 0, false
	}
	machines := s.herdr.Machines()
	type mResult struct {
		m    Machine
		list []*HostProject
		ok   bool
	}
	results := make([]mResult, len(machines))
	var wg sync.WaitGroup
	for i, m := range machines {
		if !m.Online {
			continue
		}
		wg.Add(1)
		go func(idx int, mach Machine) {
			defer wg.Done()
			list, ok := s.fetchMachineHostProjects(ctx, mach)
			results[idx] = mResult{m: mach, list: list, ok: ok}
		}(i, m)
	}
	wg.Wait()

	now := time.Now()
	hostProjectSync.Lock()
	for _, r := range results {
		if r.ok {
			hostProjectSync.lastByMachine[r.m.ID] = now
		}
	}
	hostProjectSync.Unlock()

	projectStore.Lock()
	defer projectStore.Unlock()
	s.loadProjectsLocked()

	for _, r := range results {
		if !r.ok || len(r.list) == 0 {
			continue
		}
		mID := r.m.ID
		home := r.m.Home
		for _, hp := range r.list {
			if hp == nil || hp.Cwd == "" {
				continue
			}
			hpKey := expandProjectCwdKey(hp.Cwd, home)
			if hpKey == "" {
				continue
			}
			var roots []string
			for _, rt := range hp.Roots {
				disp := compactDisplayCwd(rt, home)
				if disp != "" {
					roots = append(roots, disp)
				}
			}
			dispCwd := compactDisplayCwd(hp.Cwd, home)

			// Skip if user previously dismissed this host project directory in Collie.
			if projectStore.dismissed != nil && projectStore.dismissed[mID+"|"+hpKey] {
				continue
			}

			var match *Project
			for _, ex := range projectStore.list {
				if ex == nil || ex.Machine != mID {
					continue
				}
				if expandProjectCwdKey(ex.Cwd, home) == hpKey {
					match = ex
					break
				}
				for _, ert := range ex.Roots {
					if expandProjectCwdKey(ert, home) == hpKey {
						match = ex
						break
					}
				}
				if match != nil {
					break
				}
			}
			if match != nil {
				// Enrich existing Collie project with multi-root metadata if missing, without overwriting user edits.
				if len(roots) > len(match.Roots) {
					match.Roots = roots
					changed = true
				}
				if match.HostApp == "" && hp.App != "" {
					match.HostApp = hp.App
					changed = true
				}
				continue
			}

			kind := normSessionKind(hp.Kind)
			if _, ok := kinds[kind]; !ok {
				kind = "codex"
			}
			created := hp.CreatedAt
			if created.IsZero() {
				created = now
			}
			updated := hp.UpdatedAt
			if updated.IsZero() {
				updated = created
			}
			projectStore.list = append(projectStore.list, &Project{
				ID:        newProjectID(),
				Name:      hp.Name,
				Machine:   mID,
				Cwd:       dispCwd,
				Roots:     roots,
				Kind:      kind,
				HostApp:   hp.App,
				CreatedAt: created,
				UpdatedAt: updated,
			})
			added++
			changed = true
		}
	}
	if changed {
		s.saveProjectsLocked()
	}
	return added, changed
}

func (s *Server) syncProjectsHandler(w http.ResponseWriter, r *http.Request) {
	added, _ := s.syncHostProjectsNow(r.Context())
	if added > 0 && s.sup != nil {
		s.sup.changed()
	}
	list := s.projectsSnapshot()
	if list == nil {
		list = []*Project{}
	}
	writeJSON(w, 200, map[string]any{"ok": true, "added": added, "projects": list})
}
