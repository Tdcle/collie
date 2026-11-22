package collie

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// External sessions are claude / codex / agy running in an ordinary terminal
// (iTerm, VS Code, tmux, an SSH session…) rather than inside herdr. Collie
// cannot type into those terminals, but every agent keeps its conversation on
// disk, so it can show them read-only, and take one over: stop the original
// process and resume the same conversation in a herdr pane, where it becomes
// a normal agent you can talk to from anywhere.
type External struct {
	ID      string    `json:"id"` // "<kind>-<pid>", plus "@machine" on the hub
	Kind    string    `json:"kind"`
	PID     int       `json:"pid"`
	Cwd     string    `json:"cwd"`
	App     string    `json:"app,omitempty"` // the terminal it runs in
	Started time.Time `json:"started"`
	Session string    `json:"session,omitempty"`
	Title   string    `json:"title,omitempty"`
	Updated time.Time `json:"updated,omitempty"`
	Machine string    `json:"machine,omitempty"`
	Status  string    `json:"status,omitempty"` // working | idle | blocked, when the agent says
	// CanSend: a message can go to it where it runs (Claude's peer inbox, the
	// Codex daemon); otherwise ReadOnly says why.
	CanSend  bool   `json:"can_send,omitempty"`
	ReadOnly string `json:"read_only,omitempty"`
	// Live: it runs right now (a process, or a turn the app is running). A
	// desktop app's conversation is listed while it rests too.
	Live bool `json:"live"`
	// CanTakeOver: it can be continued in a herdr pane from here.
	CanTakeOver bool       `json:"can_take_over,omitempty"`
	Run         *[2]string `json:"run,omitempty"`

	path, format string
	reg          *claudeReg
	desktop      bool   // listed from a desktop app's index (desktop.go)
	via          string // "app": a message goes through the Codex App's message bus
}

type proc struct {
	pid, ppid int
	tty       string
	age       time.Duration
	args      []string
	name      string // what the process is, by its program name
}

// externalKinds maps program names to agent kinds.
var externalKinds = map[string]string{"claude": "claude", "codex": "codex", "agy": "agy", "antigravity": "agy", "gemini": "gemini"}

func cleanProgBase(arg string) string {
	n := strings.TrimPrefix(baseOfPath(arg), "-")
	low := strings.ToLower(n)
	for _, ext := range []string{".exe", ".cmd", ".bat", ".ps1", ".js", ".mjs", ".cjs"} {
		if strings.HasSuffix(low, ext) {
			return low[:len(low)-len(ext)]
		}
	}
	return low
}

// progName is the program a command line runs; for "node …/codex.js" it is
// the script.
func progName(args []string) string {
	if len(args) == 0 {
		return ""
	}
	n := cleanProgBase(args[0])
	if (n == "node" || n == "bun" || n == "deno") && len(args) > 1 {
		for _, a := range args[1:] {
			if strings.HasPrefix(a, "-") {
				continue
			}
			return cleanProgBase(a)
		}
	}
	return n
}

// parseEtime reads ps's [[dd-]hh:]mm:ss.
func parseEtime(s string) time.Duration {
	var d, h, m, sec int
	if i := strings.IndexByte(s, '-'); i >= 0 {
		d, _ = strconv.Atoi(s[:i])
		s = s[i+1:]
	}
	parts := strings.Split(s, ":")
	switch len(parts) {
	case 3:
		h, _ = strconv.Atoi(parts[0])
		m, _ = strconv.Atoi(parts[1])
		sec, _ = strconv.Atoi(parts[2])
	case 2:
		m, _ = strconv.Atoi(parts[0])
		sec, _ = strconv.Atoi(parts[1])
	}
	return time.Duration(((d*24+h)*60+m)*60+sec) * time.Second
}

var shells = map[string]bool{
	"zsh": true, "bash": true, "fish": true, "sh": true, "login": true, "sudo": true, "su": true, "nu": true, "env": true, "script": true,
	"powershell": true, "pwsh": true, "cmd": true, "conhost": true, "openconsole": true,
}

var guiHostProcs = map[string]bool{
	"chatgpt": true, "sihost": true, "svchost": true, "runtimebroker": true, "applicationframehost": true,
}

// isDesktopOrHelperProc reports whether an executable/command line belongs to a
// desktop GUI app (Electron/MSIX/Squirrel/.app) or a non-interactive daemon
// rather than an interactive terminal agent CLI.
func isDesktopOrHelperProc(kind string, args []string) bool {
	if len(args) == 0 {
		return false
	}
	exe := strings.ToLower(strings.ReplaceAll(args[0], `\`, "/"))
	switch {
	case strings.Contains(exe, "/windowsapps/openai.codex"),
		strings.Contains(exe, "/windowsapps/anthropic"),
		strings.Contains(exe, "/appdata/local/anthropicclaude/"),
		strings.Contains(exe, "/appdata/local/programs/claude/"),
		strings.Contains(exe, "/appdata/local/programs/antigravity/antigravity.exe"),
		strings.Contains(exe, "/programs/antigravity/antigravity.exe"),
		strings.Contains(exe, ".app/contents/macos/"),
		strings.Contains(exe, ".app/contents/frameworks/"):
		return true
	}
	for i := 1; i < len(args); i++ {
		a := args[i]
		al := strings.ToLower(a)
		switch {
		case strings.HasPrefix(al, "--type="), // Electron / Chromium helper process
			strings.HasPrefix(al, "--utility-sub-type="),
			strings.HasPrefix(al, "--squirrel-"),
			strings.HasPrefix(al, "-psn_"):
			return true
		case kind == "codex" && (a == "app-server" || a == "mcp-server" || a == "exec" || a == "cloud" || a == "completion"):
			return true
		case kind == "claude" && (a == "-p" || a == "--print" || a == "--output-format" || strings.HasPrefix(a, "--output-format=") || a == "mcp"):
			return true
		case a == "--version" || a == "-v" || a == "-V" || a == "--help" || a == "-h":
			return true
		}
	}
	return false
}

// terminalApp names what an agent process runs in, from its ancestors.
func terminalApp(ps map[int]*proc, p *proc) (app string, inHerdr bool) {
	sawShell := false
	for q, n := ps[p.ppid], 0; q != nil && n < 30; q, n = ps[q.ppid], n+1 {
		name := strings.ToLower(q.name)
		if strings.HasPrefix(name, "herdr") {
			return "", true
		}
		if shells[name] {
			sawShell = true
		}
		if guiHostProcs[name] && !sawShell {
			return "", true // desktop app host (e.g. ChatGPT / MSIX), listed by desktopSessions
		}
		if app == "" && !shells[name] && externalKinds[name] == "" {
			app = q.name
			switch {
			case strings.HasPrefix(name, "sshd"):
				app = "SSH"
			case strings.HasPrefix(name, "tmux"):
				app = "tmux"
			case strings.HasPrefix(name, "cursor"):
				app = "Cursor"
			case strings.HasPrefix(name, "windsurf"):
				app = "Windsurf"
			case strings.HasPrefix(name, "code") || strings.Contains(name, "electron"):
				app = "VS Code"
			case name == "iterm2":
				app = "iTerm2"
			case name == "windowsterminal":
				app = "Windows Terminal"
			case strings.HasPrefix(name, "wezterm"):
				app = "WezTerm"
			case name == "alacritty":
				app = "Alacritty"
			case name == "mintty":
				app = "Git Bash"
			case name == "explorer":
				app = "终端"
			}
		}
		if q.ppid <= 1 || q.ppid == q.pid {
			break
		}
	}
	return app, false
}

// externalCache keeps discovery cheap when several viewers poll.
var externalCache struct {
	sync.Mutex
	at   time.Time
	list []*External
}

// externalSessions finds interactive agents on this machine outside herdr.
func (s *Server) externalSessions() []*External {
	externalCache.Lock()
	defer externalCache.Unlock()
	if time.Since(externalCache.at) < 4*time.Second && externalCache.list != nil {
		return externalCache.list
	}
	ps, err := listProcs()
	if err != nil {
		return []*External{}
	}
	var cands []*proc
	for _, p := range ps {
		kind := externalKinds[p.name]
		if kind == "" || p.tty == "" || strings.HasPrefix(p.tty, "?") || isDesktopOrHelperProc(kind, p.args) {
			continue
		}
		// One agent can be a wrapper plus its real process; keep the outer one.
		if parent := ps[p.ppid]; parent != nil && externalKinds[parent.name] == kind && !isDesktopOrHelperProc(kind, parent.args) {
			continue
		}
		cands = append(cands, p)
	}
	pids := make([]int, 0, len(cands))
	for _, p := range cands {
		pids = append(pids, p.pid)
	}
	cwds := cwdOf(pids)
	now := time.Now()
	list := []*External{}
	// Claude registers each interactive process (maybe a wrapper's child).
	regs := s.claudeRegs()
	regOf := map[int]*claudeReg{}
	for pid, r := range regs {
		for q, n := ps[pid], 0; q != nil && n < 4; q, n = ps[q.ppid], n+1 {
			if externalKinds[q.name] == "claude" {
				regOf[q.pid] = r
			}
		}
	}
	used := map[int]bool{}
	for _, p := range cands {
		app, inHerdr := terminalApp(ps, p)
		if r := regOf[p.pid]; r != nil {
			used[r.PID] = true
		}
		if inHerdr {
			continue
		}
		if r := regOf[p.pid]; r != nil && strings.HasPrefix(r.Entrypoint, "claude-desktop") {
			continue // listed by desktopSessions
		}
		kind := externalKinds[p.name]
		cwd := cwds[p.pid]
		if cwd == "" && regOf[p.pid] != nil {
			cwd = regOf[p.pid].Cwd
		}
		if isWindowsPath(cwd) {
			cwd = winClean(cwd)
		}
		if strings.Contains(strings.ToLower(strings.ReplaceAll(cwd, `\`, "/")), "/windowsapps/") {
			continue // MSIX package working directory: desktop app, not a user terminal
		}
		e := &External{ID: fmt.Sprintf("%s-%d", kind, p.pid), Kind: kind, PID: p.pid, Cwd: cwd, App: app, Started: now.Add(-p.age), Live: true}
		s.locateExternal(e, p)
		e.reg = regOf[p.pid]
		// On Windows, Toolhelp32 cannot distinguish a hidden daemon/GUI helper
		// from a console process by POSIX tty alone. If a process has been up
		// for over 2 minutes with no transcript, session id, or registration,
		// and isn't inside a known terminal app, skip the empty ghost entry.
		if p.tty == "console" && e.path == "" && e.Session == "" && e.reg == nil && p.age > 2*time.Minute &&
			app != "Windows Terminal" && app != "WezTerm" && app != "Alacritty" && app != "Git Bash" && app != "VS Code" && app != "Cursor" && app != "Windsurf" && app != "SSH" {
			continue
		}
		s.reachable(e)
		if e.path != "" {
			if fi, err := os.Stat(e.path); err == nil {
				e.Updated = fi.ModTime()
			}
			e.Title = firstUserLine(e.path, e.format)
		}
		list = append(list, e)
	}
	// The desktop apps' conversations, running or resting (desktop.go).
	listed := map[string]bool{}
	for _, e := range list {
		e.CanTakeOver = e.Session != ""
		if e.Session != "" {
			listed[e.Session] = true
		}
	}
	list = append(list, s.desktopSessions(regs, listed, now)...)
	// Collie's own workers (a herdr pane while they run, its history after)
	// are listed as Collie's, not as the computer's other sessions.
	kept := list[:0]
	for _, e := range list {
		if !collieSession(e.Title) {
			kept = append(kept, e)
		}
	}
	list = kept
	sortSessions(list)
	externalCache.at, externalCache.list = now, list
	return list
}

// reachable works out whether a message can reach e where it runs.
func (s *Server) reachable(e *External) {
	switch e.Kind {
	case "claude":
		if e.reg == nil {
			e.ReadOnly = "找不到这个 Claude 会话的登记信息，只能看"
			return
		}
		e.Status = e.reg.state()
		if e.Session == "" {
			e.Session = e.reg.SessionID
		}
		e.CanSend, e.ReadOnly = e.reg.canSend()
	case "codex":
		if e.Session == "" {
			e.ReadOnly = "这个 Codex 还没开始对话：先在那边说第一句，之后就能从这里发消息"
			return
		}
		ids, err := s.codexLoaded()
		switch {
		case err != nil:
			e.ReadOnly = err.Error()
		case !ids[e.Session]:
			e.ReadOnly = "这个 Codex 会话没有在共享后台里运行（旧版本，或用了独立的后台），只能看"
		default:
			e.CanSend = true
		}
	default:
		e.ReadOnly = "Antigravity 不支持从外面发消息；要对话可以在 herdr 里接管"
	}
}

var conversationRe = regexp.MustCompile(`^[0-9a-f-]{16,}$`)

// locateExternal finds the conversation file an external agent is writing.
func (s *Server) locateExternal(e *External, p *proc) {
	since := e.Started.Add(-5 * time.Second)
	switch e.Kind {
	case "claude":
		root := envOr("CLAUDE_CONFIG_DIR", filepath.Join(s.home, ".claude"))
		// Claude Code registers each interactive process with its session id.
		var reg struct {
			SessionID string `json:"sessionId"`
		}
		if b, err := os.ReadFile(filepath.Join(root, "sessions", strconv.Itoa(p.pid)+".json")); err == nil && json.Unmarshal(b, &reg) == nil && reg.SessionID != "" {
			e.Session = reg.SessionID
			if m, _ := filepath.Glob(filepath.Join(root, "projects", "*", reg.SessionID+".jsonl")); len(m) > 0 {
				e.path, e.format = m[0], "claude"
				return
			}
		}
		if e.Cwd != "" {
			slug := claudeProjectSlug(e.Cwd)
			if f := newestSince(filepath.Join(root, "projects", slug, "*.jsonl"), since); f != "" {
				e.path, e.format = f, "claude"
				e.Session = strings.TrimSuffix(filepath.Base(f), ".jsonl")
			}
		}
	case "codex":
		root := envOr("CODEX_HOME", filepath.Join(s.home, ".codex"))
		files, _ := filepath.Glob(filepath.Join(root, "sessions", "*", "*", "*", "rollout-*.jsonl"))
		var best string
		var bestAt time.Time
		for _, f := range files {
			fi, err := os.Stat(f)
			if err != nil || fi.ModTime().Before(since) {
				continue
			}
			id, cwd := codexMeta(f)
			if !samePath(cwd, e.Cwd) || fi.ModTime().Before(bestAt) {
				continue
			}
			best, bestAt, e.Session = f, fi.ModTime(), id
		}
		if best != "" {
			e.path, e.format = best, "codex"
		}
	case "agy":
		brain := filepath.Join(s.agyCLIHome(), "brain")
		for i, a := range p.args {
			if (a == "--conversation" || a == "-c") && i+1 < len(p.args) && conversationRe.MatchString(p.args[i+1]) {
				f := filepath.Join(brain, p.args[i+1], ".system_generated", "logs", "transcript.jsonl")
				if isFile(f) {
					e.Session, e.path, e.format = p.args[i+1], f, "agy"
					return
				}
			}
		}
		if e.Cwd == "" {
			return
		}
		index := agyWorkspaces(filepath.Dir(brain))
		var bestAt time.Time
		for id, wss := range index {
			match := false
			for _, w := range wss {
				match = match || samePath(w, e.Cwd)
			}
			if !match {
				continue
			}
			f := filepath.Join(brain, id, ".system_generated", "logs", "transcript.jsonl")
			fi, err := os.Stat(f)
			if err != nil || fi.ModTime().Before(since) || fi.ModTime().Before(bestAt) {
				continue
			}
			e.Session, e.path, e.format, bestAt = id, f, "agy", fi.ModTime()
		}
	}
}

func newestSince(glob string, since time.Time) string {
	files, _ := filepath.Glob(glob)
	var best string
	var at time.Time
	for _, f := range files {
		if fi, err := os.Stat(f); err == nil && !fi.ModTime().Before(since) && fi.ModTime().After(at) {
			best, at = f, fi.ModTime()
		}
	}
	return best
}

// codexMeta reads a rollout's session id and cwd from its first line.
func codexMeta(path string) (id, cwd string) {
	f, err := os.Open(path)
	if err != nil {
		return "", ""
	}
	defer f.Close()
	r := bufio.NewReaderSize(f, 64<<10)
	line, _ := r.ReadBytes('\n')
	var m struct {
		Payload struct {
			ID  string `json:"id"`
			Cwd string `json:"cwd"`
		} `json:"payload"`
	}
	json.Unmarshal(line, &m)
	return m.Payload.ID, m.Payload.Cwd
}

// externalByID looks a session up in a list at most a few seconds old.
func (s *Server) externalByID(id string) *External {
	for _, e := range s.externalSessions() {
		if e.ID == id {
			return e
		}
	}
	return nil
}

// viewableByID is for reading only: the list the page just showed is almost
// always still there, so use it rather than look at every process again.
func (s *Server) viewableByID(id string) *External {
	externalCache.Lock()
	cached, at := externalCache.list, externalCache.at
	externalCache.Unlock()
	if time.Since(at) < time.Minute {
		for _, e := range cached {
			if e.ID == id {
				return e
			}
		}
	}
	for _, e := range s.externalSessions() {
		if e.ID == id {
			return e
		}
	}
	return nil
}

// ---------------------------------------------------------------- HTTP

// listExternal answers for this machine; the hub adds every connected node's.
func (s *Server) listExternal(w http.ResponseWriter, r *http.Request) {
	list := s.externalSessions()
	if s.node {
		writeJSON(w, 200, map[string]any{"sessions": list})
		return
	}
	all := append([]*External{}, list...)
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, m := range s.herdr.Machines() {
		if m.Local || !m.Online {
			continue
		}
		// Answer from the last copy and refresh it behind the scenes: the
		// link to a computer can take a good part of a second each way.
		if cached, fresh := remoteExternal.get(m.ID); cached != nil {
			all = append(all, cached...)
			if !fresh {
				go s.refreshRemoteExternal(m)
			}
			continue
		}
		wg.Add(1)
		go func(m Machine) {
			defer wg.Done()
			got := s.refreshRemoteExternal(m)
			mu.Lock()
			all = append(all, got...)
			mu.Unlock()
		}(m)
	}
	wg.Wait()
	sortSessions(all)
	writeJSON(w, 200, map[string]any{"sessions": all})
}

// remoteExternal is the hub's last copy of each computer's session list.
var remoteExternal = &remoteLists{m: map[string]*remoteList{}}

type remoteLists struct {
	sync.Mutex
	m map[string]*remoteList
}

type remoteList struct {
	at   time.Time
	list []*External
	busy bool
}

const (
	remoteFresh = 2 * time.Second  // younger copies are served as they are
	remoteStale = 60 * time.Second // older ones are not served at all
)

// get: the copy (nil if there is none or it is too old) and whether it is fresh.
func (r *remoteLists) get(machine string) ([]*External, bool) {
	r.Lock()
	defer r.Unlock()
	c := r.m[machine]
	if c == nil || c.list == nil || time.Since(c.at) > remoteStale {
		return nil, false
	}
	return c.list, time.Since(c.at) < remoteFresh || c.busy
}

// refreshRemoteExternal asks a computer for its sessions and keeps the answer.
func (s *Server) refreshRemoteExternal(m Machine) []*External {
	r := remoteExternal
	r.Lock()
	c := r.m[m.ID]
	if c == nil {
		c = &remoteList{}
		r.m[m.ID] = c
	}
	if c.busy {
		list := c.list
		r.Unlock()
		return list
	}
	c.busy = true
	r.Unlock()
	list := s.fetchRemoteExternal(m)
	r.Lock()
	c.busy = false
	if list != nil {
		c.at, c.list = time.Now(), list
	}
	r.Unlock()
	return list
}

func (s *Server) fetchRemoteExternal(m Machine) []*External {
	client, err := s.herdr.Client(m.ID)
	if err != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", "http://node/api/external", nil)
	resp, err := client.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	var body struct {
		Sessions []*External `json:"sessions"`
	}
	if json.NewDecoder(resp.Body).Decode(&body) != nil {
		return nil
	}
	for _, e := range body.Sessions {
		e.ID, e.Machine = join(e.ID, m.ID), m.ID
	}
	if body.Sessions == nil {
		body.Sessions = []*External{}
	}
	return body.Sessions
}

// streamExternal follows an external agent's conversation, read-only.
func (s *Server) streamExternal(w http.ResponseWriter, r *http.Request) {
	e := s.viewableByID(r.PathValue("id"))
	if e == nil {
		writeJSON(w, 404, map[string]any{"error": "这个会话已经结束了"})
		return
	}
	sse, ok := newSSE(w)
	if !ok {
		return
	}
	send := func(ev string, v any) bool { b, _ := json.Marshal(v); return sse.send(ev, b) == nil }
	if !send("meta", map[string]any{"structured": e.path != ""}) {
		return
	}
	var tr *transcript
	var ms msgSync
	if e.path != "" {
		tr = s.newChainedTranscript(e.path, e.format)
		tr.openTail()
	}
	first, beat := true, time.Now()
	checked := time.Now()
	for {
		if tr != nil && (tr.update() || first) {
			if p := ms.patch(tr); p != nil {
				if !send("patch", p) {
					return
				}
				beat = time.Now()
			}
		}
		first = false
		if time.Since(checked) >= time.Second {
			checked = time.Now()
			if !e.desktop && !alive(e.PID) {
				send("gone", map[string]any{})
				return
			}
		}
		if time.Since(beat) > 15*time.Second {
			sse.comment()
			beat = time.Now()
		}
		select {
		case <-r.Context().Done():
			return
		case <-time.After(250 * time.Millisecond):
		}
	}
}

func (s *Server) codexThreadWriterLocked(session string) bool {
	if session == "" || strings.ContainsAny(session, `/\*?[`) {
		return false
	}
	lockPath := filepath.Join(s.codexHome(), "thread-writer-locks", session+".lock")
	if !isFile(lockPath) {
		return false
	}
	return isFileLockedByOtherProcess(lockPath)
}

// tryClearCodexWriterLock clears a Codex thread-writer-lock file if possible
// (e.g. on Windows where Codex Desktop holds an idle handle with FILE_SHARE_DELETE)
// so Collie can run a turn directly in the exact same conversation without forking.
func (s *Server) tryClearCodexWriterLock(session string) bool {
	if session == "" || strings.ContainsAny(session, `/\*?[`) {
		return false
	}
	if p, _ := s.findCodexRolloutSingle(session); p != "" && codexTurnRunning(p) {
		return false // never steal a lock while a turn is actively running
	}
	lockPath := filepath.Join(s.codexHome(), "thread-writer-locks", session+".lock")
	if !isFile(lockPath) {
		return false
	}
	if os.Remove(lockPath) == nil {
		return true
	}
	return false
}

func (s *Server) checkCodexLock(w http.ResponseWriter, r *http.Request) {
	sess := strings.TrimSpace(r.URL.Query().Get("session"))
	writeJSON(w, 200, map[string]any{"locked": s.codexThreadWriterLocked(sess)})
}

func (s *Server) isCodexSessionLockedOn(ctx context.Context, machine, session string) bool {
	if session == "" {
		return false
	}
	if machine == "" {
		return s.codexThreadWriterLocked(session)
	}
	client, err := s.herdr.Client(machine)
	if err != nil {
		return false
	}
	qctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(qctx, "GET", "http://node/api/codex/lock?session="+url.QueryEscape(session), nil)
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	var body struct {
		Locked bool `json:"locked"`
	}
	return json.NewDecoder(resp.Body).Decode(&body) == nil && body.Locked
}

// takeOverExternal stops an external agent (if live) and resumes its
// conversation in a new herdr workspace on the same machine, optionally
// sending an initial user prompt right away.
func (s *Server) takeOverExternal(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Prompt string `json:"prompt"`
		Label  string `json:"label"`
		Model  string `json:"model"`
		Effort string `json:"effort"`
	}
	if r.Body != nil {
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&body)
	}
	if !modelNameRe.MatchString(body.Model) || !modelNameRe.MatchString(body.Effort) {
		writeJSON(w, 400, map[string]any{"error": "invalid model or effort"})
		return
	}
	e := s.externalByID(r.PathValue("id"))
	if e == nil {
		writeJSON(w, 404, map[string]any{"error": "这个会话已经结束了"})
		return
	}
	if e.Session == "" || e.Cwd == "" {
		writeJSON(w, 409, map[string]any{"error": "找不到这个会话的记录或目录，无法继续对话"})
		return
	}
	args := resumeArgs(e.Kind, e.Session)
	if len(args) == 0 {
		writeJSON(w, 409, map[string]any{"error": "暂不支持继续这种类型的会话"})
		return
	}
	if e.Kind == "codex" && s.codexThreadWriterLocked(e.Session) {
		_ = s.tryClearCodexWriterLock(e.Session)
	}
	args = append(modelArgs(e.Kind, body.Model, body.Effort), args...)
	if e.Live && !e.CanTakeOver {
		writeJSON(w, 409, map[string]any{"error": "这个会话正在 " + e.App + " 里执行，请等它当前步骤跑完后再发消息"})
		return
	}
	// Two processes writing one conversation would garble it: stop the
	// original first, the way Ctrl-C would, and give it a moment to save.
	if e.PID > 0 && !stopProcess(e.PID) {
		writeJSON(w, 409, map[string]any{"error": "原来的进程没有退出（PID " + strconv.Itoa(e.PID) + "），请先关闭原终端里的会话"})
		return
	}
	cwd := s.expand(e.Cwd)
	if !isDir(cwd) {
		cwd = s.home
	}
	externalCache.Lock()
	externalCache.at = time.Time{}
	externalCache.Unlock()
	forgetDesktopRows()
	name := s.freeName(r.Context(), e.Kind)
	if !nameRe.MatchString(name) {
		name = e.Kind + "-" + strings.SplitN(e.Session, "-", 2)[0]
	}
	label := strings.TrimSpace(body.Label)
	if label == "" {
		label = strings.TrimSpace(e.Title)
	}
	if label == "" {
		label = name
	}
	if len([]rune(label)) > 48 {
		label = string([]rune(label)[:48])
	}
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	pane, ws, err := s.startAgent(ctx, "", kinds[e.Kind], name, cwd, label, args)
	if pane != "" && (body.Model != "" || body.Effort != "") {
		s.herdr.RememberRun(pane, body.Model, body.Effort)
	} else if pane != "" && e.Run != nil {
		s.herdr.RememberRun(pane, e.Run[0], e.Run[1])
	}
	var he *HerdrError
	if err != nil && !(errors.As(err, &he) && he.Code == "agent_not_ready") {
		fail(w, err)
		return
	}
	var warn string
	if p := strings.TrimSpace(body.Prompt); p != "" && pane != "" {
		var perr error
		for wait := time.Now().Add(25 * time.Second); ; {
			perr = s.herdr.Prompt(ctx, pane, p)
			var phe *HerdrError
			if perr == nil || !errors.As(perr, &phe) || (phe.Code != "agent_not_ready" && phe.Code != "agent_not_found") || time.Now().After(wait) || ctx.Err() != nil {
				break
			}
			time.Sleep(1200 * time.Millisecond)
		}
		if perr != nil {
			warn = "会话已连接，但消息发送失败：" + perr.Error()
		}
	}
	out := map[string]any{"pane_id": pane, "workspace_id": ws, "name": name}
	if warn != "" {
		out["warning"] = warn
	}
	writeJSON(w, 200, out)
}

// sortSessions puts running sessions first, then the most recently active.
func sortSessions(list []*External) {
	sort.SliceStable(list, func(i, j int) bool {
		if list[i].Live != list[j].Live {
			return list[i].Live
		}
		return lastActive(list[i]).After(lastActive(list[j]))
	})
}

func lastActive(e *External) time.Time {
	if e.Updated.After(e.Started) {
		return e.Updated
	}
	return e.Started
}

// collieSession: a conversation Collie started, recognised by its first
// message (a worker's brief, or the event batches Collie delivers).
func collieSession(title string) bool {
	t := strings.TrimSpace(title)
	return strings.HasPrefix(t, "[collie]") || strings.HasPrefix(t, "You are worker ")
}

// revealExternal brings the session up in the app it runs in, on this
// computer: Claude's desktop app opens it where it waits for you (its own
// dialogs can only be answered there), the Codex App opens the thread.
func (s *Server) revealExternal(w http.ResponseWriter, r *http.Request) {
	e := s.viewableByID(r.PathValue("id"))
	if e == nil {
		writeJSON(w, 404, map[string]any{"error": "这个会话已经结束了"})
		return
	}
	if runtime.GOOS != "darwin" && runtime.GOOS != "windows" {
		writeJSON(w, 409, map[string]any{"error": "只能在桌面电脑上打开 " + e.App})
		return
	}
	var link string
	switch {
	case e.Kind == "claude" && strings.HasPrefix(e.ID, "cd-"):
		link = "claude://code/needs-input?source=collie&session=" + url.QueryEscape("local_"+strings.TrimPrefix(e.ID, "cd-"))
	case e.Kind == "codex" && (e.via == "app" || e.desktop) && e.Session != "":
		link = "codex://threads/" + url.PathEscape(e.Session)
	default:
		writeJSON(w, 409, map[string]any{"error": "这个会话没法从这里在 " + e.App + " 里打开"})
		return
	}
	if err := openURL(r.Context(), link); err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}
