package collie

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// Antigravity does not tell herdr which conversation a pane is running, so we
// pair them ourselves. Showing the wrong conversation would leak an unrelated
// session into this pane, so a candidate must be provably this pane's:
//
//   - agy's own index (conversation_summaries.db) lists the pane's cwd as the
//     conversation's workspace, exactly; and
//   - the conversation was born after the agent started (when Collie knows the
//     start time), or within the last few hours otherwise.
//
// Each transcript is claimed by at most one pane.

var agyIndex struct {
	sync.Mutex
	at time.Time
	ws map[string][]string // conversation id → workspace paths
}

func agyWorkspaces(root string) map[string][]string {
	agyIndex.Lock()
	defer agyIndex.Unlock()
	if time.Since(agyIndex.at) < 3*time.Second && agyIndex.ws != nil {
		return agyIndex.ws
	}
	agyIndex.at = time.Now()
	m := map[string][]string{}
	path := filepath.Join(root, "conversation_summaries.db")
	if !isFile(path) {
		agyIndex.ws = m
		return m
	}
	db, err := sql.Open("sqlite", sqliteURI(path, "mode=ro&_pragma=busy_timeout(2000)"))
	if err != nil {
		agyIndex.ws = m
		return m
	}
	defer db.Close()
	rows, err := db.Query(`SELECT conversation_id, workspace_uris FROM conversation_summaries WHERE last_modified_time > ?`,
		time.Now().Add(-48*time.Hour).UTC().Format("2006-01-02 15:04:05"))
	if err != nil {
		agyIndex.ws = m
		return m
	}
	defer rows.Close()
	for rows.Next() {
		var id, raw string
		if rows.Scan(&id, &raw) != nil {
			continue
		}
		var uris []string
		json.Unmarshal([]byte(raw), &uris)
		for _, u := range uris {
			m[id] = append(m[id], uriToPath(u))
		}
	}
	agyIndex.ws = m
	return m
}

func (s *Server) guessAgy(brain, pane, cwd string) string {
	claimed.Lock()
	defer claimed.Unlock()
	for p, owner := range claimed.m {
		if owner == pane && isFile(p) {
			return p
		}
	}
	if cwd == "" {
		return ""
	}
	since, known := s.startedAt(pane)
	if !known {
		since = time.Now().Add(-6 * time.Hour)
	}
	index := agyWorkspaces(filepath.Dir(brain))

	files, _ := filepath.Glob(filepath.Join(brain, "*", ".system_generated", "logs", "transcript.jsonl"))
	type cand struct {
		path string
		born time.Time
	}
	var cs []cand
	for _, f := range files {
		if _, taken := claimed.m[f]; taken {
			continue
		}
		dir := filepath.Dir(filepath.Dir(filepath.Dir(f)))
		match := false
		for _, w := range index[filepath.Base(dir)] {
			if samePath(w, cwd) {
				match = true
				break
			}
		}
		if !match {
			continue
		}
		di, err := os.Stat(dir)
		if err != nil {
			continue
		}
		born := di.ModTime()
		if bt := birthTime(di); !bt.IsZero() {
			born = bt
		}
		if born.Before(since.Add(-10 * time.Second)) {
			continue
		}
		cs = append(cs, cand{f, born})
	}
	if len(cs) == 0 {
		return ""
	}
	// The earliest conversation after the start is the one the agent opened.
	sort.Slice(cs, func(i, j int) bool { return cs[i].born.Before(cs[j].born) })
	claimed.m[cs[0].path] = pane
	return cs[0].path
}

// agyCLIHome is where the agy CLI keeps its conversations. The desktop app
// keeps its own in ~/.gemini/antigravity (desktop.go); the CLI, in a
// terminal or a herdr pane, uses antigravity-cli (older ones used the app's).
func (s *Server) agyCLIHome() string {
	if d := filepath.Join(s.home, ".gemini", "antigravity-cli"); isDir(d) {
		return d
	}
	return filepath.Join(s.home, ".gemini", "antigravity")
}
