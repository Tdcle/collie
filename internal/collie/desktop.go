package collie

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
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

// The desktop apps (Claude, Codex, Antigravity) keep their own lists of
// conversations. Collie reads those lists, so a conversation shows whether or
// not it runs right now, the way the app's own sidebar shows it: the running
// ones, and the rest of the last week. Each app is read its own way, read-only:
//
//   - Claude: the desktop app's session index, one JSON per session under
//     ~/Library/Application Support/Claude/claude-code-sessions (title,
//     directory, archived, which transcript it runs).
//   - Codex: the App's thread table in <CODEX_HOME>/state_<n>.sqlite (source
//     "vscode" is the App); a message goes through the App's local message bus,
//     so it runs in the App window that owns the thread.
//   - Antigravity: its conversation index, ~/.gemini/antigravity/conversation_summaries.db.

const (
	desktopWindow = 7 * 24 * time.Hour
	desktopMax    = 20 // per app
)

const (
	appClaude = "Claude 桌面版"
	appCodex  = "Codex 桌面版"
	appAgy    = "Antigravity 桌面版"
)

// desktopRow is one conversation as an app's index lists it.
type desktopRow struct {
	id, kind, app       string
	session, title, cwd string
	path, format        string
	created, updated    time.Time
	running             bool // the app says a turn is running (Codex, Antigravity)
	asking              bool // Codex has an unanswered request_user_input question
	waiting             bool // stopped, with something still to come (an Antigravity timer)
	run                 *[2]string
}

var desktopCache struct {
	sync.Mutex
	at    time.Time
	rows  []desktopRow
	app   bool // the Codex App's local IPC socket is reachable
	winUp bool // Windows Codex desktop process is running (no external IPC bus)
}

// desktopRows reads the apps' indexes, at most every 10 seconds.
func (s *Server) desktopRows() ([]desktopRow, bool, bool) {
	desktopCache.Lock()
	defer desktopCache.Unlock()
	if time.Since(desktopCache.at) < 5*time.Second && desktopCache.rows != nil {
		return desktopCache.rows, desktopCache.app, desktopCache.winUp
	}
	var rows []desktopRow
	rows = append(rows, s.claudeDesktopRows()...)
	rows = append(rows, s.codexAppRows()...)
	rows = append(rows, s.agyDesktopRows()...)
	appUp := s.codexAppUp()
	winUp := !appUp && runtime.GOOS == "windows" && codexDesktopProcRunning()
	desktopCache.at, desktopCache.rows, desktopCache.app, desktopCache.winUp = time.Now(), rows, appUp, winUp
	return rows, desktopCache.app, desktopCache.winUp
}

func forgetDesktopRows() {
	desktopCache.Lock()
	desktopCache.at = time.Time{}
	desktopCache.Unlock()
}

// desktopSessions turns the apps' rows into sessions, joined with what runs
// now: Claude desktop processes (regs) and terminal agents already listed.
func (s *Server) desktopSessions(regs map[int]*claudeReg, listed map[string]bool, now time.Time) []*External {
	rows, appUp, winUp := s.desktopRows()
	bySession := map[string]*claudeReg{}
	for _, r := range regs {
		if strings.HasPrefix(r.Entrypoint, "claude-desktop") {
			bySession[r.SessionID] = r
		}
	}
	var out []*External
	for _, d := range rows {
		if listed[d.session] {
			continue
		}
		e := &External{ID: d.id, Kind: d.kind, Cwd: d.cwd, App: d.app, Started: d.created, Session: d.session, Title: d.title, Updated: d.updated, Run: d.run, path: d.path, format: d.format, desktop: true}
		if e.path != "" {
			if fi, err := os.Stat(e.path); err == nil && fi.ModTime().After(e.Updated) {
				e.Updated = fi.ModTime()
			}
		}
		switch d.kind {
		case "claude":
			if r := bySession[d.session]; r != nil {
				e.reg, e.PID, e.Live = r, r.PID, true
				s.reachable(e)
			} else {
				e.CanTakeOver = (e.path != "" || e.Session != "") && e.Cwd != ""
			}
		case "codex":
			e.Live = d.running || d.asking
			if d.asking {
				e.Status = "blocked"
			} else if d.running {
				e.Status = "working"
			}
			canResume := !d.running && e.Session != "" && e.Cwd != ""
			switch {
			case appUp:
				e.CanSend, e.via = true, "app"
				e.CanTakeOver = canResume
			case s.codexDaemonHas(d.session):
				e.CanSend = true
				e.CanTakeOver = canResume
			case isCodexApp(d.app) && !d.running && s.codexDaemonSock() != "":
				// The new Codex App (and a closed one) has no ipc.sock; continue
				// the thread in Codex's shared background daemon when idle, while
				// still allowing seamless herdr takeover as fallback.
				e.CanSend, e.via = true, "bg"
				e.CanTakeOver = canResume
			case isCodexApp(d.app) && d.running:
				e.ReadOnly = "当前步骤由桌面端 Codex 私有进程启动，完成后即可直接在此发消息或插话"
			default:
				e.CanTakeOver = canResume
				_ = winUp
			}
		case "agy":
			e.Live = d.running || d.waiting
			if d.running {
				e.Status = "working"
			} else if d.waiting {
				e.Status = "waiting"
			}
			if agyDesktopServer() != nil {
				e.CanSend, e.via = true, "app"
			} else {
				e.CanTakeOver = !e.Live && e.Session != "" && e.Cwd != ""
			}
		}
		out = append(out, e)
	}
	// Desktop processes the index does not know yet (just created) still show.
	for pid, r := range regs {
		if !strings.HasPrefix(r.Entrypoint, "claude-desktop") || listed[r.SessionID] || rowsHave(rows, r.SessionID) {
			continue
		}
		e := &External{ID: fmt.Sprintf("claude-%d", pid), Kind: "claude", PID: pid, Cwd: r.Cwd, App: appClaude, Session: r.SessionID, reg: r, Live: true, desktop: true, Started: now}
		if path, format := s.findTranscript("claude", "id", r.SessionID, "", ""); path != "" {
			e.path, e.format = path, format
			if fi, err := os.Stat(path); err == nil {
				e.Updated = fi.ModTime()
			}
			e.Title = firstUserLine(path, format)
		}
		s.reachable(e)
		out = append(out, e)
	}
	return out
}

func rowsHave(rows []desktopRow, session string) bool {
	for _, d := range rows {
		if d.session == session {
			return true
		}
	}
	return false
}

// firstUserLine is a conversation's first message, as a title. It reads from
// the top only until that message (a session's log can be tens of MB, and the
// session list asks for every running one every few seconds), and remembers it.
var firstUserCache = struct {
	sync.Mutex
	m map[string]string
}{m: map[string]string{}}

func firstUserLine(path, format string) string {
	firstUserCache.Lock()
	t, ok := firstUserCache.m[path]
	firstUserCache.Unlock()
	if ok {
		return t
	}
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	tr := newTranscript(path, format)
	r := bufio.NewReaderSize(f, 1<<20)
	read := 0
	for read < 8<<20 && t == "" {
		line, err := r.ReadBytes('\n')
		if err != nil {
			break
		}
		read += len(line)
		tr.line(line)
		for _, m := range tr.msgs {
			if m.Kind == "user" && strings.TrimSpace(m.Text) != "" && !strings.HasPrefix(m.Text, "[collie]") {
				t = messageTitle(m.Text)
				break
			}
		}
		tr.msgs = tr.msgs[:0]
	}
	if t != "" {
		firstUserCache.Lock()
		if len(firstUserCache.m) > 2000 {
			firstUserCache.m = map[string]string{}
		}
		firstUserCache.m[path] = t
		firstUserCache.Unlock()
	}
	return t
}

// ---------------------------------------------------------------- Claude

// claudeDesktopDirs are the desktop apps' data directories (the build on a
// third-party provider keeps its own).
func (s *Server) claudeDesktopDirs() []string {
	switch runtime.GOOS {
	case "darwin":
		base := filepath.Join(s.home, "Library", "Application Support")
		return []string{filepath.Join(base, "Claude"), filepath.Join(base, "Claude-3p")}
	case "windows":
		base := os.Getenv("APPDATA")
		if base == "" {
			base = filepath.Join(s.home, "AppData", "Roaming")
		}
		return []string{filepath.Join(base, "Claude"), filepath.Join(base, "Claude-3p")}
	}
	return nil
}

type claudeDesktopJSON struct {
	SessionID    string `json:"sessionId"`
	CliSessionID string `json:"cliSessionId"`
	Cwd          string `json:"cwd"`
	Title        string `json:"title"`
	Archived     bool   `json:"isArchived"`
	Created      int64  `json:"createdAt"`
	Activity     int64  `json:"lastActivityAt"`
}

// Index files are read again only when they change.
var claudeDesktopFiles = struct {
	sync.Mutex
	m map[string]struct {
		mod time.Time
		v   claudeDesktopJSON
	}
}{m: map[string]struct {
	mod time.Time
	v   claudeDesktopJSON
}{}}

func (s *Server) claudeDesktopRows() []desktopRow {
	var rows []desktopRow
	cutoff := time.Now().Add(-desktopWindow)
	claudeDesktopFiles.Lock()
	defer claudeDesktopFiles.Unlock()
	for _, dir := range s.claudeDesktopDirs() {
		files, _ := filepath.Glob(filepath.Join(dir, "claude-code-sessions", "*", "*", "local_*.json"))
		for _, f := range files {
			fi, err := os.Stat(f)
			if err != nil {
				continue
			}
			c, ok := claudeDesktopFiles.m[f]
			if !ok || !c.mod.Equal(fi.ModTime()) {
				c.mod = fi.ModTime()
				c.v = claudeDesktopJSON{}
				if b, err := os.ReadFile(f); err == nil {
					json.Unmarshal(b, &c.v)
				}
				claudeDesktopFiles.m[f] = c
			}
			v := c.v
			last := time.UnixMilli(v.Activity)
			if v.Activity == 0 {
				last = fi.ModTime()
			}
			if v.CliSessionID == "" || v.Archived || last.Before(cutoff) {
				continue
			}
			local := strings.TrimPrefix(v.SessionID, "local_")
			if local == "" {
				local = v.CliSessionID
			}
			cwd := v.Cwd
			if isWindowsPath(cwd) {
				cwd = winClean(cwd)
			}
			d := desktopRow{id: "cd-" + local, kind: "claude", app: appClaude, session: v.CliSessionID, title: v.Title, cwd: cwd, created: time.UnixMilli(v.Created), updated: last}
			d.path, d.format = s.findTranscript("claude", "id", v.CliSessionID, "", "")
			rows = append(rows, d)
		}
	}
	return newestRows(rows)
}

func newestRows(rows []desktopRow) []desktopRow {
	sort.Slice(rows, func(i, j int) bool { return rows[i].updated.After(rows[j].updated) })
	if len(rows) > desktopMax {
		rows = rows[:desktopMax]
	}
	return rows
}

// ---------------------------------------------------------------- Codex App

// codexStateDB is the newest of the App's state databases (its number goes up with its schema).
func (s *Server) codexStateDB() string {
	paths, _ := filepath.Glob(filepath.Join(s.codexHome(), "state_*.sqlite"))
	best, bestN := "", -1
	for _, p := range paths {
		n, err := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(filepath.Base(p), "state_"), ".sqlite"))
		if err == nil && n > bestN {
			best, bestN = p, n
		}
	}
	return best
}

func (s *Server) codexRolloutFromStateDB(session string) string {
	if session == "" {
		return ""
	}
	path := s.codexStateDB()
	if path == "" {
		return ""
	}
	db, err := sql.Open("sqlite", sqliteURI(path, "mode=ro&_pragma=busy_timeout(2000)"))
	if err != nil {
		return ""
	}
	defer db.Close()
	var rollout string
	if db.QueryRow(`SELECT rollout_path FROM threads WHERE id = ? LIMIT 1`, session).Scan(&rollout) != nil {
		return ""
	}
	if isWindowsPath(rollout) {
		rollout = winClean(rollout)
	}
	if isFile(rollout) {
		return rollout
	}
	return ""
}

func (s *Server) codexThreadRun(session string) *[2]string {
	if session == "" {
		return nil
	}
	path := s.codexStateDB()
	if path == "" {
		return nil
	}
	db, err := sql.Open("sqlite", sqliteURI(path, "mode=ro&_pragma=busy_timeout(2000)"))
	if err != nil {
		return nil
	}
	defer db.Close()
	var model, effort string
	if db.QueryRow(`SELECT COALESCE(model,''), COALESCE(reasoning_effort,'') FROM threads WHERE id = ? LIMIT 1`, session).Scan(&model, &effort) != nil {
		return nil
	}
	if model == "" && effort == "" {
		return nil
	}
	return &[2]string{model, effort}
}

// codexLatestFork checks whether an interactive Codex TUI pane forked `session`
// into a newer child thread on disk (written as `"forked_from_id":"<session>"`
// on the first line of the rollout file). Returns the newest child session ID
// and its rollout path when found.
func (s *Server) codexLatestFork(session, cwd string) (childID, rolloutPath string) {
	if session == "" || strings.ContainsAny(session, `/\*?[`) {
		return "", ""
	}
	root := s.codexHome()
	// Check recent session day folders (today and yesterday cover live TUI forks).
	now := time.Now()
	needle := `"forked_from_id":"` + session + `"`
	var bestTime time.Time
	for _, day := range []time.Time{now, now.Add(-24 * time.Hour)} {
		dir := filepath.Join(root, "sessions", day.Format("2006"), day.Format("01"), day.Format("02"))
		files, _ := filepath.Glob(filepath.Join(dir, "rollout-*.jsonl"))
		for _, f := range files {
			fi, err := os.Stat(f)
			if err != nil || !fi.Mode().IsRegular() || (!bestTime.IsZero() && !fi.ModTime().After(bestTime)) {
				continue
			}
			fp, err := os.Open(f)
			if err != nil {
				continue
			}
			r := bufio.NewReaderSize(fp, 32<<10)
			line, _ := r.ReadString('\n')
			fp.Close()
			if !strings.Contains(line, needle) {
				continue
			}
			var meta struct {
				Payload struct {
					ID  string `json:"id"`
					Cwd string `json:"cwd"`
				} `json:"payload"`
			}
			if json.Unmarshal([]byte(line), &meta) != nil || meta.Payload.ID == "" || meta.Payload.ID == session {
				continue
			}
			if cwd != "" && meta.Payload.Cwd != "" && !samePath(meta.Payload.Cwd, cwd) {
				continue
			}
			bestTime = fi.ModTime()
			childID, rolloutPath = meta.Payload.ID, f
		}
	}
	return childID, rolloutPath
}

// codexRolloutChain walks a Codex rollout file's `forked_from_id` / `history_base`
// ancestry (up to 8 hops) and returns the ordered list of rollout files from
// oldest ancestor to `leafPath`, so paginated/forked conversations retain their
// earlier messages seamlessly.
func (s *Server) codexRolloutChain(leafPath string) []string {
	if leafPath == "" || !isFile(leafPath) {
		return nil
	}
	chain := []string{leafPath}
	seen := map[string]bool{filepath.Clean(leafPath): true}
	cur := leafPath
	root := s.codexHome()
	for hop := 0; hop < 8; hop++ {
		fp, err := os.Open(cur)
		if err != nil {
			break
		}
		r := bufio.NewReaderSize(fp, 32<<10)
		line, _ := r.ReadString('\n')
		fp.Close()
		var meta struct {
			Payload struct {
				ForkedFromID string `json:"forked_from_id"`
				HistoryBase  *struct {
					ThreadID string `json:"thread_id"`
				} `json:"history_base"`
			} `json:"payload"`
		}
		if json.Unmarshal([]byte(line), &meta) != nil {
			break
		}
		prevPath := ""
		if meta.Payload.HistoryBase != nil && meta.Payload.HistoryBase.ThreadID != "" {
			tid := meta.Payload.HistoryBase.ThreadID
			if !strings.ContainsAny(tid, `/\*?[`) {
				if m, _ := filepath.Glob(filepath.Join(root, "sessions", "*", "*", "*", "rollout-*"+tid+"*.jsonl")); len(m) > 0 {
					prevPath = newestRegularFile(m)
				}
			}
		}
		if prevPath == "" && meta.Payload.ForkedFromID != "" {
			prevPath, _ = s.findCodexRolloutSingle(meta.Payload.ForkedFromID)
		}
		if prevPath == "" || seen[filepath.Clean(prevPath)] || !isFile(prevPath) {
			break
		}
		seen[filepath.Clean(prevPath)] = true
		chain = append([]string{prevPath}, chain...)
		cur = prevPath
	}
	return chain
}

func (s *Server) findCodexRolloutSingle(value string) (string, string) {
	if value == "" || strings.ContainsAny(value, `/\*?[`) {
		return "", ""
	}
	root := s.codexHome()
	var matches []string
	for _, pat := range []string{
		filepath.Join(root, "sessions", "*", "*", "*", "rollout-*"+value+".jsonl"),
		filepath.Join(root, "sessions", "*", "*", "*", "rollout-*"+value+"_*.jsonl"),
	} {
		if m, _ := filepath.Glob(pat); len(m) > 0 {
			matches = append(matches, m...)
		}
	}
	if best := newestRegularFile(matches); best != "" {
		return best, "codex"
	}
	if dbPath := s.codexRolloutFromStateDB(value); dbPath != "" {
		return dbPath, "codex"
	}
	return "", ""
}

func (s *Server) codexAppRows() []desktopRow {
	path := s.codexStateDB()
	if path == "" {
		return nil
	}
	db, err := sql.Open("sqlite", sqliteURI(path, "mode=ro&_pragma=busy_timeout(2000)"))
	if err != nil {
		return nil
	}
	defer db.Close()
	q := `SELECT id, COALESCE(NULLIF(name,''), NULLIF(title,''), first_user_message), cwd, rollout_path,
		COALESCE(created_at_ms, created_at*1000), COALESCE(updated_at_ms, updated_at*1000), COALESCE(originator, ''),
		COALESCE(model, ''), COALESCE(reasoning_effort, '')
		FROM threads WHERE archived = 0 AND source = 'vscode' AND updated_at > ? ORDER BY updated_at DESC LIMIT ?`
	res, err := db.Query(q, time.Now().Add(-desktopWindow).Unix(), desktopMax)
	if err != nil {
		return nil
	}
	defer res.Close()
	var rows []desktopRow
	for res.Next() {
		var id, title, cwd, rollout, originator, model, effort string
		var created, updated int64
		if res.Scan(&id, &title, &cwd, &rollout, &created, &updated, &originator, &model, &effort) != nil {
			continue
		}
		if isWindowsPath(cwd) {
			cwd = winClean(cwd)
		}
		if isWindowsPath(rollout) {
			rollout = winClean(rollout)
		}
		app := codexClient(originator, cwd)
		var run *[2]string
		if model != "" || effort != "" {
			run = &[2]string{model, effort}
		}
		d := desktopRow{id: "cx-" + id, kind: "codex", app: app, session: id, title: messageTitle(title), cwd: cwd, created: time.UnixMilli(created), updated: time.UnixMilli(updated), run: run}
		if isFile(rollout) {
			d.path, d.format = rollout, "codex"
			d.running = codexTurnRunning(rollout)
			d.asking = codexHasOpenQuestion(rollout)
		}
		rows = append(rows, d)
	}
	return rows
}

// codexTurnRunning: the rollout's last turn has started and not ended. A turn
// silent for 20 minutes is taken as over (the App may have died mid-turn).
// A long turn's start can sit megabytes back, so read backwards a chunk at a
// time until a start or an end turns up.
func codexTurnRunning(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || time.Since(fi.ModTime()) > 20*time.Minute {
		return false
	}
	return lastTurnOpen(f, fi.Size())
}

// codexHasOpenQuestion reports whether the tail of a recent Codex rollout has
// an unanswered `request_user_input` / `request_user_input_async` question to
// the human (so sidebar, header, and Feishu notifications surface `blocked`).
func codexHasOpenQuestion(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || fi.Size() == 0 || time.Since(fi.ModTime()) > 24*time.Hour {
		return false
	}
	const tailWindow = 512 << 10
	off := max(fi.Size()-tailWindow, int64(0))
	buf := make([]byte, fi.Size()-off)
	if _, err := f.ReadAt(buf, off); err != nil && err != io.EOF {
		return false
	}
	if !bytes.Contains(buf, []byte("request_user_input")) {
		return false
	}
	lines := bytes.Split(buf, []byte{'\n'})
	startIdx := 0
	if off > 0 && len(lines) > 1 {
		startIdx = 1 // skip potentially truncated first line
	}
	type openAsk struct {
		seq   int
		async bool
	}
	openByCall := map[string]openAsk{}
	lastAskSeq := -1
	lastUserSeq := -1
	for i := startIdx; i < len(lines); i++ {
		l := bytes.TrimSpace(lines[i])
		if len(l) == 0 || !bytes.Contains(l, []byte(`"response_item"`)) {
			if bytes.Contains(l, []byte(`"turn_aborted"`)) {
				lastUserSeq = i
			}
			continue
		}
		if bytes.Contains(l, []byte(`"function_call"`)) && bytes.Contains(l, []byte(`"request_user_input`)) {
			var ev struct {
				Type    string `json:"type"`
				Payload struct {
					Type   string `json:"type"`
					Name   string `json:"name"`
					CallID string `json:"call_id"`
				} `json:"payload"`
			}
			if json.Unmarshal(l, &ev) == nil && ev.Type == "response_item" && ev.Payload.Type == "function_call" &&
				(ev.Payload.Name == "request_user_input" || ev.Payload.Name == "request_user_input_async") {
				isAsync := ev.Payload.Name == "request_user_input_async"
				if ev.Payload.CallID != "" {
					openByCall[ev.Payload.CallID] = openAsk{seq: i, async: isAsync}
				}
				lastAskSeq = i
			}
			continue
		}
		if bytes.Contains(l, []byte(`"function_call_output"`)) && len(openByCall) > 0 {
			var ev struct {
				Type    string `json:"type"`
				Payload struct {
					Type   string          `json:"type"`
					CallID string          `json:"call_id"`
					Output json.RawMessage `json:"output"`
				} `json:"payload"`
			}
			if json.Unmarshal(l, &ev) == nil && ev.Type == "response_item" && ev.Payload.CallID != "" {
				if oa, ok := openByCall[ev.Payload.CallID]; ok && !oa.async {
					txt, _ := textAndImagesOf(ev.Payload.Output)
					if formatCodexAskOutput("request_user_input", txt) != "" {
						delete(openByCall, ev.Payload.CallID)
					}
				}
			}
			continue
		}
		if bytes.Contains(l, []byte(`"role":"user"`)) {
			var ev struct {
				Type    string `json:"type"`
				Payload struct {
					Type    string          `json:"type"`
					Role    string          `json:"role"`
					Content json.RawMessage `json:"content"`
				} `json:"payload"`
			}
			if json.Unmarshal(l, &ev) == nil && ev.Type == "response_item" && ev.Payload.Type == "message" && ev.Payload.Role == "user" {
				txt := strings.TrimSpace(textOf(ev.Payload.Content))
				if _, isReply := parseCodexQuestionReply(txt); isReply || !noise(txt) {
					lastUserSeq = i
				}
			}
		}
	}
	if lastAskSeq < 0 || lastUserSeq > lastAskSeq {
		return false
	}
	for _, oa := range openByCall {
		if oa.seq > lastUserSeq {
			return true
		}
	}
	return len(openByCall) == 0 && lastAskSeq > lastUserSeq
}

func lastTurnOpen(r io.ReaderAt, size int64) bool {
	const chunk, overlap = 512 << 10, 64
	for end := size; end > 0; end -= chunk - overlap {
		off := max(end-chunk, 0)
		b := make([]byte, end-off)
		if _, err := r.ReadAt(b, off); err != nil && err != io.EOF {
			return false
		}
		started := bytes.LastIndex(b, []byte(`"type":"task_started"`))
		ended := max(bytes.LastIndex(b, []byte(`"type":"task_complete"`)), bytes.LastIndex(b, []byte(`"type":"turn_aborted"`)))
		if started >= 0 || ended >= 0 {
			return started > ended
		}
		if off == 0 {
			break
		}
	}
	return false
}

// The Codex App's local message bus: its windows ask each other to run a turn
// in a thread one of them owns; Collie joins as one more client. Frames are a
// 4-byte little-endian length and a JSON object; each request carries the
// version the App expects for its method.
func (s *Server) codexAppSock() string {
	if runtime.GOOS == "windows" {
		return `\\.\pipe\codex-ipc`
	}
	return filepath.Join(s.codexHome(), "ipc", "ipc.sock")
}

func (s *Server) codexAppUp() bool {
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	c, err := dialLocalSocket(ctx, s.codexAppSock())
	if err != nil {
		return false
	}
	c.Close()
	return true
}

var codexAppVersions = map[string]int{
	"thread-owner-discovery":     1,
	"thread-follower-start-turn": 2,
	"thread-follower-steer-turn": 1,
	"thread-follower-interrupt":  1,
}

type codexAppFrame struct {
	Type            string          `json:"type"`
	RequestID       string          `json:"requestId,omitempty"`
	Method          string          `json:"method,omitempty"`
	ResultType      string          `json:"resultType,omitempty"`
	Error           string          `json:"error,omitempty"`
	HandledByClient string          `json:"handledByClientId,omitempty"`
	Params          any             `json:"params,omitempty"`
	Version         int             `json:"version,omitempty"`
	TargetClientID  string          `json:"targetClientId,omitempty"`
	Response        any             `json:"response,omitempty"`
	Result          json.RawMessage `json:"result,omitempty"`
}

type codexApp struct{ conn net.Conn }

func (c *codexApp) write(f codexAppFrame) error {
	b, err := json.Marshal(f)
	if err != nil {
		return err
	}
	buf := make([]byte, 4+len(b))
	binary.LittleEndian.PutUint32(buf, uint32(len(b)))
	copy(buf[4:], b)
	_, err = c.conn.Write(buf)
	return err
}

func (c *codexApp) read() (codexAppFrame, error) {
	var f codexAppFrame
	var head [4]byte
	if _, err := io.ReadFull(c.conn, head[:]); err != nil {
		return f, err
	}
	n := binary.LittleEndian.Uint32(head[:])
	if n == 0 || n > 64<<20 {
		return f, fmt.Errorf("Codex App 消息格式不对（%d 字节）", n)
	}
	b := make([]byte, n)
	if _, err := io.ReadFull(c.conn, b); err != nil {
		return f, err
	}
	return f, json.Unmarshal(b, &f)
}

// request sends one request and waits for its answer. When the bus asks
// whether Collie handles someone else's request, it says no at once.
func (c *codexApp) request(method string, params any, target string) (codexAppFrame, error) {
	id := uuid4()
	if err := c.write(codexAppFrame{Type: "request", RequestID: id, Method: method, Params: params, Version: codexAppVersions[method], TargetClientID: target}); err != nil {
		return codexAppFrame{}, err
	}
	for {
		f, err := c.read()
		if err != nil {
			return f, err
		}
		switch f.Type {
		case "client-discovery-request":
			if err := c.write(codexAppFrame{Type: "client-discovery-response", RequestID: f.RequestID, Response: map[string]any{"canHandle": false}}); err != nil {
				return f, err
			}
		case "response":
			if f.RequestID != id {
				continue
			}
			if f.ResultType != "success" {
				return f, fmt.Errorf("Codex App %s: %s", method, f.Error)
			}
			return f, nil
		}
	}
}

var errCodexNotLoaded = errors.New("Codex App 没能打开这个对话：在电脑上的 Codex App 里点开它一次再发")

func (c *codexApp) owner(thread string) (string, error) {
	f, err := c.request("thread-owner-discovery", map[string]any{"hostId": "local", "conversationId": thread}, "")
	if err == nil && f.HandledByClient == "" {
		err = errCodexNotLoaded
	}
	return f.HandledByClient, err
}

// codexAppSend runs a turn in the App window that owns the thread. A thread
// the App has not loaded is opened in it first (the App comes forward).
func (s *Server) codexAppSend(ctx context.Context, thread, text string) error {
	conn, err := dialLocalSocket(ctx, s.codexAppSock())
	if err != nil {
		return errors.New("连不上电脑上的 Codex App：它可能没有打开")
	}
	defer conn.Close()
	if dl, ok := ctx.Deadline(); ok {
		conn.SetDeadline(dl)
	}
	c := &codexApp{conn: conn}
	if _, err := c.request("initialize", map[string]any{"clientType": "collie"}, ""); err != nil {
		return err
	}
	owner, err := c.owner(thread)
	if err != nil && openURL(ctx, "codex://threads/"+thread) == nil {
		for deadline := time.Now().Add(30 * time.Second); err != nil && time.Now().Before(deadline) && ctx.Err() == nil; {
			time.Sleep(time.Second)
			owner, err = c.owner(thread)
		}
	}
	if err != nil {
		return errCodexNotLoaded
	}
	input := []map[string]any{{"type": "text", "text": text, "text_elements": []any{}}}
	turn := map[string]any{
		"conversationId": thread,
		"turnStart": map[string]any{
			"request": map[string]any{"threadId": thread, "clientUserMessageId": uuid4(), "input": input},
			"context": map[string]any{},
		},
	}
	_, err = c.request("thread-follower-start-turn", turn, owner)
	if err != nil {
		steer := map[string]any{
			"conversationId": thread,
			"turnSteer": map[string]any{
				"request": map[string]any{"threadId": thread, "clientUserMessageId": uuid4(), "input": input},
			},
		}
		if _, err2 := c.request("thread-follower-steer-turn", steer, owner); err2 == nil {
			err = nil
		}
	}
	forgetDesktopRows()
	return err
}

func (s *Server) codexAppInterrupt(ctx context.Context, thread string) error {
	conn, err := dialLocalSocket(ctx, s.codexAppSock())
	if err != nil {
		return err
	}
	defer conn.Close()
	if dl, ok := ctx.Deadline(); ok {
		conn.SetDeadline(dl)
	}
	c := &codexApp{conn: conn}
	if _, err := c.request("initialize", map[string]any{"clientType": "collie"}, ""); err != nil {
		return err
	}
	owner, err := c.owner(thread)
	if err != nil {
		return err
	}
	_, err = c.request("thread-follower-interrupt", map[string]any{"conversationId": thread}, owner)
	forgetDesktopRows()
	return err
}

// ---------------------------------------------------------------- Antigravity

func (s *Server) agyDesktopRows() []desktopRow {
	root := filepath.Join(s.home, ".gemini", "antigravity")
	path := filepath.Join(root, "conversation_summaries.db")
	if !isFile(path) {
		return nil
	}
	db, err := sql.Open("sqlite", sqliteURI(path, "mode=ro&_pragma=busy_timeout(2000)"))
	if err != nil {
		return nil
	}
	defer db.Close()
	// not_fully_idle: the turn is over but the agent will be back on its own
	// (it set a timer, or a command runs in the background).
	res, err := db.Query(`SELECT conversation_id, title, preview, workspace_uris, status, not_fully_idle, last_modified_time, last_user_input_time
		FROM conversation_summaries WHERE nesting_depth = 0 AND killed = 0 AND last_modified_time > ?
		ORDER BY last_modified_time DESC LIMIT ?`, time.Now().Add(-desktopWindow).UTC().Format("2006-01-02 15:04:05"), desktopMax)
	if err != nil {
		return nil
	}
	defer res.Close()
	var rows []desktopRow
	for res.Next() {
		var id, title, preview, uris, status string
		var notIdle bool
		var mod, input any
		if res.Scan(&id, &title, &preview, &uris, &status, &notIdle, &mod, &input) != nil {
			continue
		}
		if title == "" {
			title = preview
		}
		var ws []string
		json.Unmarshal([]byte(uris), &ws)
		cwd := ""
		if len(ws) > 0 {
			cwd = uriToPath(ws[0])
		}
		d := desktopRow{id: "ag-" + id, kind: "agy", app: appAgy, session: id, title: messageTitle(title), cwd: cwd,
			created: sqlTime(input), updated: sqlTime(mod), running: status == "CASCADE_RUN_STATUS_RUNNING"}
		d.waiting = !d.running && notIdle
		if f := filepath.Join(root, "brain", id, ".system_generated", "logs", "transcript.jsonl"); isFile(f) {
			d.path, d.format = f, "agy"
		}
		rows = append(rows, d)
	}
	return rows
}

// sqlTime reads a datetime column, which the driver may hand back as a time or as text.
func sqlTime(v any) time.Time {
	switch t := v.(type) {
	case time.Time:
		return t
	case string:
		for _, layout := range []string{"2006-01-02 15:04:05.999999999-07:00", "2006-01-02 15:04:05.999999999Z07:00", "2006-01-02 15:04:05"} {
			if p, err := time.Parse(layout, t); err == nil {
				return p
			}
		}
	}
	return time.Time{}
}

// leadingTag is a block of context a tool put before the message itself
// (<persona-context>…</persona-context> and the like).
var leadingTag = regexp.MustCompile(`(?s)^\s*<([A-Za-z][\w:-]*)[^>]*>.*?</([A-Za-z][\w:-]*)>`)

// messageTitle is a conversation's title as one short line, without the context
// blocks some tools put before the message.
var imageMark = regexp.MustCompile(`\[image(:[^\]\s]*)?\]\s*`)

func messageTitle(t string) string {
	t = imageMark.ReplaceAllString(t, "") // a picture says nothing as a title
	for i := 0; i < 4; i++ {
		m := leadingTag.FindStringSubmatchIndex(t)
		if m == nil || t[m[2]:m[3]] != t[m[4]:m[5]] {
			break
		}
		t = t[m[1]:]
	}
	return clip(oneLine(t), 80)
}

// codexDaemonHas: Codex's shared background service has the thread loaded.
func (s *Server) codexDaemonHas(thread string) bool {
	ids, err := s.codexLoaded()
	return err == nil && ids[thread]
}

const appCodexRemote = "Codex App（远程）"

func isCodexApp(app string) bool { return app == appCodex || app == appCodexRemote }

// codexClient names what started a "vscode" thread: the Codex App, or another
// program driving Codex's app-server.
func codexClient(originator, cwd string) string {
	// The Mac's shared Codex service stamps every thread it runs with the
	// program that started the service, so "persona" says nothing about who
	// asked: these are the App's.
	if originator == "persona" {
		originator = ""
	}
	switch originator {
	case "", "Codex Desktop", "codex_work_desktop":
		if runtime.GOOS != "darwin" && runtime.GOOS != "windows" {
			return appCodexRemote // the App on another computer opened it here over SSH
		}
		return appCodex
	case "codex-tui":
		return "Codex 终端"
	}
	return originator + "（Codex）"
}
