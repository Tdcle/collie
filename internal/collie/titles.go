package collie

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
)

// Each agent names its own session: claude puts the topic in the terminal
// title, codex keeps thread names in session_index.jsonl, antigravity keeps
// titles in conversation_summaries.db. Those beat names like "agy-1".
// The files live on the agent's machine, so every machine reads its own and
// the hub collects them from the nodes.

var genericTitles = map[string]bool{
	"": true, "claude": true, "claude code": true, "codex": true, "agy": true, "antigravity": true,
	"bash": true, "zsh": true, "powershell": true, "pwsh": true, "cmd": true, "cmd.exe": true, "powershell.exe": true, "pwsh.exe": true,
}

// cleanTitle drops the spinner/status glyphs claude puts in front of the topic.
func cleanTitle(t string) string {
	t = strings.TrimLeftFunc(t, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsNumber(r) })
	t = strings.TrimSpace(t)
	if genericTitles[strings.ToLower(t)] {
		return ""
	}
	return clip(t, 60)
}

var codexNames struct {
	sync.Mutex
	mod    time.Time
	m      map[string]string
	byName map[string]string
}

func (s *Server) codexThreadName(id string) string {
	s.loadCodexNames()
	codexNames.Lock()
	defer codexNames.Unlock()
	return codexNames.m[id]
}

func (s *Server) codexIDByName(name string) string {
	s.loadCodexNames()
	codexNames.Lock()
	defer codexNames.Unlock()
	return codexNames.byName[name]
}

func (s *Server) loadCodexNames() {
	path := filepath.Join(envOr("CODEX_HOME", filepath.Join(s.home, ".codex")), "session_index.jsonl")
	fi, err := os.Stat(path)
	if err != nil {
		return
	}
	codexNames.Lock()
	defer codexNames.Unlock()
	if !fi.ModTime().Equal(codexNames.mod) {
		m, byName := map[string]string{}, map[string]string{}
		if f, err := os.Open(path); err == nil {
			sc := bufio.NewScanner(f)
			sc.Buffer(make([]byte, 64<<10), 1<<20)
			for sc.Scan() {
				var e struct {
					ID   string `json:"id"`
					Name string `json:"thread_name"`
				}
				if json.Unmarshal(sc.Bytes(), &e) == nil && e.ID != "" {
					m[e.ID] = e.Name // later lines are renames
					byName[e.Name] = e.ID
				}
			}
			f.Close()
		}
		codexNames.mod, codexNames.m, codexNames.byName = fi.ModTime(), m, byName
	}
}

var agyTitles struct {
	sync.Mutex
	at time.Time
	m  map[string]string
}

func (s *Server) agyTitle(id string) string {
	agyTitles.Lock()
	defer agyTitles.Unlock()
	if time.Since(agyTitles.at) > 5*time.Second {
		agyTitles.at = time.Now()
		m := map[string]string{}
		path := filepath.Join(s.agyCLIHome(), "conversation_summaries.db")
		if isFile(path) {
			if db, err := sql.Open("sqlite", sqliteURI(path, "mode=ro&_pragma=busy_timeout(2000)")); err == nil {
				if rows, err := db.Query(`SELECT conversation_id, title FROM conversation_summaries WHERE last_modified_time > ?`,
					time.Now().Add(-7*24*time.Hour).UTC().Format("2006-01-02 15:04:05")); err == nil {
					for rows.Next() {
						var cid, t string
						if rows.Scan(&cid, &t) == nil {
							m[cid] = t
						}
					}
					rows.Close()
				}
				db.Close()
			}
		}
		agyTitles.m = m
	}
	return agyTitles.m[id]
}

// paneSession is what a machine knows about one of its agents' sessions.
type paneSession struct {
	Title   string     `json:"title,omitempty"`
	Session string     `json:"session,omitempty"` // id to resume it by
	Run     *[2]string `json:"run,omitempty"`     // model, effort it was started with
}

// localSessions maps this machine's agent panes (local ids) to their sessions.
func (s *Server) localSessions(ctx context.Context) map[string]paneSession {
	out := map[string]paneSession{}
	agents, err := s.herdr.Agents(ctx)
	if err != nil {
		return out
	}
	if panes, err := s.herdr.Panes(ctx); err == nil {
		alive := map[string]bool{}
		for _, p := range panes {
			alive[p.ID] = true
		}
		s.herdr.pruneRuns(alive, func(m string) bool { return m == "" })
	}
	for _, a := range agents {
		local, machine := split(a.PaneID)
		if machine != "" {
			continue
		}
		sess := ""
		if a.Session != nil {
			if s := sessionID(a.Session.Kind, a.Session.Value); !strings.ContainsAny(s, `/\`) {
				sess = s
			}
		}
		kind := deref(a.Agent)
		var t string
		switch kind {
		case "codex":
			t = s.codexThreadName(sess)
		case "agy":
			if sess == "" {
				// Antigravity doesn't tell herdr its conversation; pair it like the chat view does.
				if p, _ := s.findTranscript("agy", "", "", local, deref(a.Cwd)); p != "" {
					sess = filepath.Base(filepath.Dir(filepath.Dir(filepath.Dir(p))))
				}
			}
			t = s.agyTitle(sess)
		}
		if t = cleanTitle(t); t == "" {
			tt := a.TerminalTitle
			if kind == "codex" {
				// codex titles its terminal "<thread name> | <user>"
				if i := strings.LastIndex(tt, " | "); i > 0 {
					tt = tt[:i]
				}
				if sess == "" {
					sess = s.codexIDByName(strings.TrimSpace(tt))
				}
			}
			t = cleanTitle(tt)
		}
		run, _ := s.herdr.Run(local)
		if t != "" || sess != "" || run != nil {
			out[local] = paneSession{Title: t, Session: sess, Run: run}
		}
	}
	return out
}

func (s *Server) getTitles(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"sessions": s.titlesFor("", r.Context())})
}

// titlesFor returns the cached titles of one machine ("" = this one) and
// refreshes them in the background, so building the state never waits.
type titleCache struct {
	at      time.Time
	m       map[string]paneSession
	loading bool
}

var titles = struct {
	sync.Mutex
	by map[string]*titleCache
}{by: map[string]*titleCache{}}

func (s *Server) titlesFor(machine string, ctx context.Context) map[string]paneSession {
	titles.Lock()
	c := titles.by[machine]
	if c == nil {
		c = &titleCache{}
		titles.by[machine] = c
	}
	stale := time.Since(c.at) > 4*time.Second && !c.loading
	if stale {
		c.loading = true
	}
	m := c.m
	titles.Unlock()
	if !stale {
		return m
	}
	load := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
		defer cancel()
		var got map[string]paneSession
		if machine == "" {
			got = s.localSessions(ctx)
		} else if client, err := s.herdr.Client(machine); err == nil {
			req, _ := http.NewRequestWithContext(ctx, "GET", "http://node/api/titles", nil)
			if resp, err := client.Do(req); err == nil {
				var body struct {
					Sessions map[string]paneSession `json:"sessions"`
				}
				if json.NewDecoder(resp.Body).Decode(&body) == nil && body.Sessions != nil {
					got = body.Sessions
				}
				resp.Body.Close()
			}
		}
		titles.Lock()
		c.loading, c.at = false, time.Now()
		if got != nil {
			c.m = got
		}
		titles.Unlock()
	}
	if m == nil {
		load() // first time: worth the wait
		titles.Lock()
		m = c.m
		titles.Unlock()
		return m
	}
	go load()
	return m
}

// freeName picks an unused handle like "claude-2" for an agent the human
// didn't name; the UI shows the session's title instead.
func (s *Server) freeName(ctx context.Context, kind string) string {
	base := kind
	if base == "antigravity" {
		base = "agy"
	}
	taken := map[string]bool{}
	if agents, err := s.herdr.Agents(ctx); err == nil {
		for _, a := range agents {
			taken[deref(a.Name)] = true
		}
	}
	for i := 1; ; i++ {
		if n := base + "-" + strconv.Itoa(i); !taken[n] {
			return n
		}
	}
}
