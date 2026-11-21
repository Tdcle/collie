package collie

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// When an agent exits (its pane closes, or the program quits back to the
// shell) its conversation is still on disk. The hub remembers those sessions
// so they can be read and continued later.

type Ended struct {
	ID      string    `json:"id"`
	Kind    string    `json:"kind"` // claude | codex | agy
	Machine string    `json:"machine,omitempty"`
	Cwd     string    `json:"cwd"`
	Title   string    `json:"title,omitempty"`
	Name    string    `json:"name,omitempty"`
	Session string    `json:"session"`
	Ended   time.Time `json:"ended"`
}

const maxEnded = 40

var history = struct {
	sync.Mutex
	list   []*Ended
	loaded bool
}{}

func (s *Server) loadHistory() {
	if history.loaded {
		return
	}
	history.loaded = true
	var raw string
	if s.sup != nil && s.sup.db.QueryRow(`SELECT v FROM kv WHERE k='ended_sessions'`).Scan(&raw) == nil {
		json.Unmarshal([]byte(raw), &history.list)
	}
}

func (s *Server) saveHistory() {
	if s.sup == nil {
		return
	}
	b, _ := json.Marshal(history.list)
	if _, err := s.sup.db.Exec(`INSERT INTO kv(k,v) VALUES('ended_sessions',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, string(b)); err != nil {
		log.Printf("save ended sessions: %v", err)
	}
}

func (s *Server) remember(e *Ended) {
	if s.isSessionDeleted(e.Kind, e.Machine, e.Session) {
		return
	}
	history.Lock()
	defer history.Unlock()
	s.loadHistory()
	kept := history.list[:0]
	for _, x := range history.list {
		if !(x.Kind == e.Kind && x.Session == e.Session && x.Machine == e.Machine) {
			kept = append(kept, x)
		}
	}
	e.ID = randomToken()[:10]
	history.list = append([]*Ended{e}, kept...)
	if len(history.list) > maxEnded {
		history.list = history.list[:maxEnded]
	}
	s.saveHistory()
}

// forgetSession drops a session that is live again (it was continued).
func (s *Server) forgetSession(kind, machine, session string) {
	history.Lock()
	defer history.Unlock()
	s.loadHistory()
	kept := history.list[:0]
	for _, x := range history.list {
		if !(x.Kind == kind && x.Session == session && x.Machine == machine) {
			kept = append(kept, x)
		}
	}
	if len(kept) != len(history.list) {
		history.list = kept
		s.saveHistory()
	}
}

// watchEndings polls the fleet and records agents that went away.
func (s *Server) watchEndings(ctx context.Context) {
	type seen struct {
		Ended
		missed int
	}
	prev := map[string]*seen{}
	tick := time.NewTicker(3 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		c, cancel := context.WithTimeout(ctx, 8*time.Second)
		st := s.state(c)
		cancel()
		if !st.OK {
			continue
		}
		online := map[string]bool{"": true}
		for _, m := range st.Machines {
			if m.Online {
				online[m.ID] = true
			}
		}
		now := map[string]bool{}
		for _, a := range st.Agents {
			now[a.PaneID] = true
			// Collie's own session isn't one to reopen; its name can lag behind
			// after a restart, its workspace label doesn't.
			if a.Name == routerName || a.WorkspaceLabel == routerLabel || a.Name == dreamName || a.WorkspaceLabel == dreamLabel || a.Session == "" {
				delete(prev, a.PaneID)
				continue
			}
			kind := a.Kind
			if kind == "antigravity" {
				kind = "agy"
			}
			prev[a.PaneID] = &seen{Ended: Ended{Kind: kind, Machine: a.Machine, Cwd: a.Cwd, Title: a.Topic, Name: a.Name, Session: a.Session}}
			s.forgetSession(kind, a.Machine, a.Session)
		}
		for id, p := range prev {
			if now[id] {
				continue
			}
			if !online[p.Machine] {
				continue // the machine went away, not the agent
			}
			// Two misses in a row: herdr can briefly drop an agent while it restarts.
			if p.missed++; p.missed < 2 {
				continue
			}
			delete(prev, id)
			e := p.Ended
			e.Ended = time.Now()
			s.remember(&e)
		}
	}
}

func (s *Server) listHistory(w http.ResponseWriter, r *http.Request) {
	history.Lock()
	s.loadHistory()
	list := append([]*Ended{}, history.list...)
	history.Unlock()
	sort.SliceStable(list, func(i, j int) bool { return list[i].Ended.After(list[j].Ended) })
	writeJSON(w, 200, map[string]any{"sessions": list})
}

func (s *Server) deleteHistory(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	history.Lock()
	s.loadHistory()
	kept := history.list[:0]
	for _, x := range history.list {
		if x.ID != id {
			kept = append(kept, x)
		}
	}
	history.list = kept
	s.saveHistory()
	history.Unlock()
	writeJSON(w, 200, map[string]any{"ok": true})
}

// getTranscript reads a finished conversation on this machine.
func (s *Server) getTranscript(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	kind, session := q.Get("kind"), q.Get("session")
	if kind == "antigravity" {
		kind = "agy"
	}
	if session == "" || strings.ContainsAny(session, "/\\*?[") {
		writeJSON(w, 400, map[string]any{"error": "bad session"})
		return
	}
	path, format := s.findTranscript(kind, "id", session, "", s.expand(q.Get("cwd")))
	if path == "" {
		writeJSON(w, 404, map[string]any{"error": "这台电脑上找不到这个会话的记录了"})
		return
	}
	if before := queryOffset(r); before > 0 {
		writeEarlier(w, path, format, before)
		return
	}
	tr := newTranscript(path, format)
	tr.openTail()
	writeJSON(w, 200, map[string]any{"messages": tr.view(), "earlier": tr.earlierCursor()})
}

// earlierPage is how many older messages one "load earlier" brings.
const earlierPage = 120

func queryOffset(r *http.Request) int64 {
	n, _ := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64)
	return n
}

func writeEarlier(w http.ResponseWriter, path, format string, before int64) {
	msgs, cursor := earlierMessages(path, format, before, earlierPage)
	if msgs == nil {
		msgs = []*Message{}
	}
	writeJSON(w, 200, map[string]any{"messages": msgs, "earlier": cursor})
}

// externalEarlier: older messages of a session running elsewhere on this computer.
func (s *Server) externalEarlier(w http.ResponseWriter, r *http.Request) {
	e := s.viewableByID(r.PathValue("id"))
	if e == nil || e.path == "" {
		writeJSON(w, 404, map[string]any{"error": "这个会话没有记录"})
		return
	}
	writeEarlier(w, e.path, e.format, queryOffset(r))
}

// paneEarlier: older messages of the agent in a herdr pane.
func (s *Server) paneEarlier(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	var info struct {
		Agent agentDetail `json:"agent"`
	}
	if err := s.herdr.Call(ctx, "agent.get", map[string]any{"target": id}, &info); err != nil || info.Agent.Agent == nil {
		writeJSON(w, 404, map[string]any{"error": "这个窗格里没有 agent"})
		return
	}
	tr := s.transcriptFor(id, id, info.Agent, map[string]*transcript{})
	if tr == nil {
		writeJSON(w, 404, map[string]any{"error": "这个 agent 没有会话记录"})
		return
	}
	writeEarlier(w, tr.path, tr.format, queryOffset(r))
}
