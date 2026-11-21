package collie

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
)

func (s *Server) superRoutes(mux *http.ServeMux) {
	api := func(pattern string, h http.HandlerFunc) { mux.Handle(pattern, s.auth(h)) }
	api("GET /api/super", s.superSnapshot)
	api("GET /api/super/events", s.superEvents)
	api("POST /api/super/say", s.superSay)
	api("POST /api/super/reply", s.superReply)
	api("POST /api/super/spawn", s.superSpawn)
	api("POST /api/super/send", s.superSend)
	api("POST /api/super/report", s.superReport)
	api("POST /api/super/subscribe", s.superSubscribe)
	api("POST /api/super/stop", s.superStop)
	api("POST /api/super/answer", s.superAnswer)
	api("GET /api/super/show/{id}", s.superShow)
	api("GET /api/super/list", s.superList)
	api("GET /api/super/triggers", s.superTriggers)
	api("GET /api/super/timers", s.superTimers)
	api("POST /api/super/timers", s.superAddTimer)
	api("POST /api/super/timers/{id}/delete", s.superDeleteTimer)
	api("GET /api/super/settings", s.superSettings)
	api("POST /api/super/settings", s.superSaveSettings)
	api("POST /api/super/seen", s.superSeen)
	api("GET /api/super/lark", s.superLark)
	api("GET /api/super/earlier", s.superEarlier)
	api("GET /api/super/memory", s.superMemory)
	api("POST /api/super/memory", s.superSaveMemory)
	api("POST /api/super/dream", s.superDream)
	api("POST /api/super/router/restart", s.superRestartRouter)
	api("POST /api/super/exec", s.superExec)
	mux.HandleFunc("POST /hooks/{source}", s.webhook)
}

// ---------------------------------------------------------------- snapshot

type routerView struct {
	Alive   bool   `json:"alive"`
	Status  string `json:"status"`
	PaneID  string `json:"pane_id,omitempty"`
	Kind    string `json:"kind"`
	Machine string `json:"machine,omitempty"`
	// How full its context is (percent), and when it rotates to a fresh session.
	Context  int  `json:"context,omitempty"`
	RotateAt int  `json:"rotate_at"`
	Handover bool `json:"handover,omitempty"`
	Dreaming bool `json:"dreaming,omitempty"`
	// The model and effort it runs with ("" = the agent's own default), and
	// whether the settings have changed since it started.
	Model   string `json:"model,omitempty"`
	Effort  string `json:"effort,omitempty"`
	Pending bool   `json:"pending,omitempty"`
}

type superView struct {
	Router  routerView `json:"router"`
	Entries []*Entry   `json:"entries"`
	Earlier bool       `json:"earlier,omitempty"` // older chat than Entries: /api/super/earlier
	Workers []*Worker  `json:"workers"`
	Queued  int        `json:"queued"`
	// QueuedRouter: those waiting for Collie itself, not for a worker.
	QueuedRouter int  `json:"queued_router"`
	Paused       bool `json:"paused"`
}

func (s *Server) superState(ctx context.Context) superView {
	sp := s.sup
	live, _ := sp.liveAgents(ctx)
	sp.mu.Lock()
	defer sp.mu.Unlock()
	v := superView{Router: routerView{Kind: sp.st.Settings.RouterKind, Machine: sp.st.Settings.RouterMachine, Status: "asleep"}, Paused: sp.st.Settings.Paused}
	if a, ok := live[routerName]; ok {
		_, rm := split(a.Pane)
		v.Router = routerView{Alive: true, Status: a.Status, PaneID: a.Pane, Kind: a.Kind, Machine: rm}
	} else if sp.routerLaunching {
		v.Router.Status = "starting"
	}
	v.Router.Context, v.Router.RotateAt, v.Router.Handover = sp.routerUsage.Pct(), sp.rotateAtLocked(), sp.handover != nil
	v.Router.Dreaming = sp.dream != nil
	st := sp.st.Settings
	v.Router.Model, v.Router.Effort = st.RouterModel, st.RouterEffort
	if run := sp.routerRunLocked(); run != nil && v.Router.Alive {
		v.Router.Model, v.Router.Effort = run[0], run[1]
		wantM := st.RouterMachine
		v.Router.Pending = *run != [2]string{st.RouterModel, st.RouterEffort} ||
			kinds[v.Router.Kind] != kinds[st.RouterKind] ||
			(wantM != "" && v.Router.Machine != wantM)
	}
	if sp.dream != nil {
		v.Router.Status = "dreaming"
	}
	es := sp.st.Entries
	if len(es) > 200 {
		es = es[len(es)-200:]
		v.Earlier = true
	}
	v.Entries = append([]*Entry{}, es...)
	v.Workers = []*Worker{}
	for _, w := range sp.st.Workers {
		if !w.Ended || time.Since(w.CreatedAt) < 12*time.Hour {
			cp := *w
			v.Workers = append(v.Workers, &cp)
		}
	}
	sort.Slice(v.Workers, func(i, j int) bool { return v.Workers[i].CreatedAt.After(v.Workers[j].CreatedAt) })
	for _, t := range sp.st.Triggers {
		if t.Status == "queued" {
			v.Queued++
			if len(t.Targets) == 0 || slices.Contains(t.Targets, routerName) {
				v.QueuedRouter++
			}
		}
	}
	return v
}

func (s *Server) superSnapshot(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, s.superState(r.Context()))
}

func (s *Server) superEvents(w http.ResponseWriter, r *http.Request) {
	sse, ok := newSSE(w)
	if !ok {
		return
	}
	ch, done := s.sup.subscribe()
	defer done()
	var last string
	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	beat := time.Now()
	for {
		b, _ := json.Marshal(s.superState(r.Context()))
		if string(b) != last {
			last = string(b)
			if sse.send("super", b) != nil {
				return
			}
			beat = time.Now()
		} else if time.Since(beat) > 15*time.Second {
			sse.comment()
			beat = time.Now()
		}
		select {
		case <-r.Context().Done():
			return
		case <-ch:
		case <-tick.C:
		}
	}
}

// ---------------------------------------------------------------- conversation

func (s *Server) superSay(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Text    string `json:"text"`
		Machine string `json:"machine"` // where to dispatch this time, "" = the default
		Kind    string `json:"kind"`
		Model   string `json:"model"`
		Effort  string `json:"effort"`
		Re      string `json:"re"` // a message of Collie's this answers
	}
	if !decode(w, r, &body) || strings.TrimSpace(body.Text) == "" {
		if strings.TrimSpace(body.Text) == "" {
			writeJSON(w, 400, map[string]any{"error": "empty message"})
		}
		return
	}
	sp := s.sup
	sp.mu.Lock()
	re := sp.collieQuoteLocked(body.Re)
	e := sp.addEntryReLocked("user", mainThread, body.Text, "", "", re)
	// The composer's "派到" chip: a one-off choice the router should honour.
	text := body.Text
	if re != nil { // which of your messages they mean: Collie need not guess
		text = "[In reply to what you said earlier: \"" + clip(re.Text, 300) + "\"]\n" + text
	}
	st := sp.st.Settings
	pickedM := s.machineByName(body.Machine)
	pickedLocal := body.Machine == "local" || body.Machine == "hub"
	if body.Kind == "agy" { // the composer's name for it
		body.Kind = "antigravity"
	}
	_, known := kinds[body.Kind]

	// First-wake auto-adoption: if Collie itself has never replied yet (or its
	// currently configured machine/agent cannot run) and the human explicitly
	// picked a machine/agent/model in the composer, adopt that choice so Collie
	// wakes with what the human actually picked instead of failing on defaults.
	neverReplied := true
	for i := len(sp.st.Entries) - 1; i >= 0; i-- {
		if sp.st.Entries[i].Role == "collie" {
			neverReplied = false
			break
		}
	}
	if !sp.routerLaunching && (neverReplied || func() bool { _, _, err := sp.resolveRouterTarget(st); return err != nil }()) {
		changed := false
		if pickedM != "" || pickedLocal {
			if st.RouterMachine != pickedM {
				st.RouterMachine = pickedM
				changed = true
			}
			if st.WorkerMachine != pickedM {
				st.WorkerMachine = pickedM
				if pickedM != "" && (st.WorkerCwd == "" || st.WorkerCwd == s.home) {
					st.WorkerCwd = "~"
				}
				changed = true
			}
		}
		if known && kinds[body.Kind] != kinds[st.RouterKind] {
			st.RouterKind = body.Kind
			st.RouterModel = ""
			st.RouterEffort = ""
			if m := strings.TrimSpace(body.Model); m != "" && modelNameRe.MatchString(m) {
				st.RouterModel = m
			}
			if ef := strings.TrimSpace(body.Effort); ef != "" && modelNameRe.MatchString(ef) {
				st.RouterEffort = ef
			}
			changed = true
		}
		if known && kinds[body.Kind] != kinds[st.WorkerKind] {
			st.WorkerKind = body.Kind
			changed = true
		}
		if changed {
			sp.st.Settings = st
			sp.routerLaunchAt = time.Time{} // retry right away instead of waiting out the 45s backoff
		}
	}

	var hint []string
	if pickedM != "" || pickedLocal {
		if pickedM != st.WorkerMachine {
			name := "hub"
			if pickedM != "" {
				name = pickedM
			}
			hint = append(hint, "--machine "+name)
		}
	}
	if known && kinds[body.Kind] != kinds[st.WorkerKind] {
		hint = append(hint, "--kind "+body.Kind)
	}
	// Model choices only differ from the defaults for the default kind.
	defModel, defEffort := "", ""
	if !known || kinds[body.Kind] == kinds[st.WorkerKind] {
		defModel, defEffort = st.WorkerModel, st.WorkerEffort
	}
	if m := strings.TrimSpace(body.Model); m != "" && m != defModel && modelNameRe.MatchString(m) {
		hint = append(hint, "--model "+m)
	}
	if e := strings.TrimSpace(body.Effort); e != "" && e != defEffort && modelNameRe.MatchString(e) {
		hint = append(hint, "--effort "+e)
	}
	if len(hint) > 0 {
		text += "\n\n[The human picked where this runs: spawn with " + strings.Join(hint, " ") + "]"
	}
	t := sp.ingestLocked("chat", mainThread, "you", text, "", "", e.ID)
	sp.mu.Unlock()
	writeJSON(w, 200, map[string]any{"entry": e.ID, "trigger": t.ID})
}

func (s *Server) superReply(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Text   string `json:"text"`
		Thread string `json:"thread"`
		Re     string `json:"re"`
	}
	if !decode(w, r, &body) {
		return
	}
	text := strings.TrimSpace(body.Text)
	if text == "" {
		writeJSON(w, 400, map[string]any{"error": "empty reply"})
		return
	}
	if body.Thread == "" {
		body.Thread = mainThread
	}
	sp := s.sup
	sp.mu.Lock()
	limit := sp.st.Settings.ReplyChars
	re := sp.quoteLocked(body.Re)
	e := sp.addEntryReLocked("collie", body.Thread, text, "", "", re)
	sp.mu.Unlock()
	res := map[string]any{"ok": true, "entry": e.ID}
	if body.Re != "" && re == nil {
		res["warning"] = "--re " + body.Re + " is not an event or message I know; the reply went out without it"
	}
	if n := replyLen(text); limit > 0 && n > limit {
		res["warning"] = fmt.Sprintf("reply is %d characters; chat replies are usually ≤%d. Fine if the human asked for detail or the result needs a list; otherwise keep the next one shorter", n, limit)
	}
	writeJSON(w, 200, res)
}

// replyLen is a reply's length as people read it: each Chinese/Japanese/Korean
// character counts one, and so does each run of Latin text (a word).
func replyLen(s string) int {
	n, cjk := 0, 0
	for _, f := range strings.Fields(s) {
		ascii := true
		for _, r := range f {
			if r > 0x2E80 {
				cjk++
				ascii = false
			}
		}
		if ascii {
			n++
		}
	}
	return n + cjk
}

// ---------------------------------------------------------------- workers

func (s *Server) superSpawn(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Kind      string   `json:"kind"`
		Cwd       string   `json:"cwd"`
		Task      string   `json:"task"`
		Thread    string   `json:"thread"`
		Name      string   `json:"name"`
		By        string   `json:"by"`
		Machine   *string  `json:"machine"`
		Model     string   `json:"model"`
		Effort    string   `json:"effort"`
		Args      []string `json:"args"`
		Subscribe *bool    `json:"subscribe"`
		Resume    string   `json:"resume"` // a stopped worker to carry on from
	}
	if !decode(w, r, &body) {
		return
	}
	session := ""
	if body.Resume != "" {
		old, err := s.sup.resumeFrom(body.Resume)
		if err != nil {
			writeJSON(w, 400, map[string]any{"error": err.Error()})
			return
		}
		// Its own computer, directory and agent: that is where the conversation is.
		body.Kind, body.Cwd, session = old.Kind, old.Cwd, old.Session
		m := old.Machine
		body.Machine = &m
		if body.Name == "" {
			body.Name = old.Name
		}
		if body.Model == "" && body.Effort == "" {
			body.Model, body.Effort = old.Model, old.Effort
		}
		if body.Thread == "" {
			body.Thread = old.Thread
		}
	}
	if strings.TrimSpace(body.Task) == "" {
		writeJSON(w, 400, map[string]any{"error": "task is required"})
		return
	}
	if !modelNameRe.MatchString(body.Model) || !modelNameRe.MatchString(body.Effort) {
		writeJSON(w, 400, map[string]any{"error": "invalid model or effort"})
		return
	}
	if body.By == "" {
		body.By = routerName
	}
	if body.Thread == "" {
		body.Thread = mainThread
	}
	// Workers subscribe to their own thread unless it is the shared main chat,
	// which always stays with the router.
	sub := body.Thread != mainThread
	if body.Subscribe != nil {
		sub = *body.Subscribe
	}
	machine := s.sup.settings().WorkerMachine
	if session != "" {
		machine = *body.Machine // an id already
	} else if body.Machine != nil {
		machine = s.machineByName(*body.Machine)
	}
	wk, started, err := s.sup.Spawn(body.Kind, body.Cwd, body.Task, body.Thread, body.Name, body.By, machine, body.Model, body.Effort, body.Args, sub, session)
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}
	// Most failures (the computer's herdr down, a bad directory) show in the
	// first seconds: say them now, so nobody hears "started" first.
	status := "starting"
	select {
	case err := <-started:
		if err != nil {
			writeJSON(w, 502, map[string]any{"error": "worker " + wk.Name + " failed to start: " + err.Error()})
			return
		}
		status = "started"
	case <-time.After(8 * time.Second):
	}
	res := map[string]any{"worker": wk.Name, "kind": wk.Kind, "status": status, "thread": wk.Thread,
		"note": "its agent is starting; you will get a [collie] event when it reports, finishes, gets blocked or fails. Tell the human it is on its way, not that it is done"}
	writeJSON(w, 202, res)
}

func (s *Server) superSend(w http.ResponseWriter, r *http.Request) {
	var body struct {
		To     string `json:"to"`
		Text   string `json:"text"`
		Thread string `json:"thread"`
	}
	if !decode(w, r, &body) {
		return
	}
	sp := s.sup
	sp.mu.Lock()
	wk := sp.st.Workers[body.To]
	if wk == nil || wk.Ended {
		sp.mu.Unlock()
		writeJSON(w, 404, map[string]any{"error": "no running worker named " + body.To})
		return
	}
	if body.Thread == "" {
		body.Thread = wk.Thread
	}
	t := sp.ingestLocked("router", body.Thread, routerName, body.Text, "", body.To, "")
	sp.mu.Unlock()
	writeJSON(w, 202, map[string]any{"trigger": t.ID, "note": "queued; delivered when the worker is free"})
}

func (s *Server) superReport(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Worker string `json:"worker"`
		Pane   string `json:"pane"`
		Text   string `json:"text"`
	}
	if !decode(w, r, &body) {
		return
	}
	name := body.Worker
	if name == "" && body.Pane != "" {
		// A worker on another computer reports through that computer's token.
		if _, d := s.identity(r); d != nil && d.Kind == "machine" {
			body.Pane = join(body.Pane, d.ID)
		}
		name = s.sup.workerByPane(body.Pane)
	}
	if name == "" {
		writeJSON(w, 400, map[string]any{"error": "could not tell which worker you are; pass --worker <name>"})
		return
	}
	if err := s.sup.Report(name, strings.TrimSpace(body.Text)); err != nil {
		writeJSON(w, 404, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) superSubscribe(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Worker string `json:"worker"`
		Thread string `json:"thread"`
		Off    bool   `json:"off"`
	}
	if !decode(w, r, &body) {
		return
	}
	sp := s.sup
	sp.mu.Lock()
	defer sp.mu.Unlock()
	if sp.st.Workers[body.Worker] == nil || body.Thread == "" {
		writeJSON(w, 400, map[string]any{"error": "worker and thread are required"})
		return
	}
	if body.Thread == mainThread && !body.Off {
		writeJSON(w, 400, map[string]any{"error": "chat:main always routes to the router"})
		return
	}
	th := sp.threadLocked(body.Thread)
	if body.Off {
		th.Subscribers = remove(th.Subscribers, body.Worker)
	} else if !contains(th.Subscribers, body.Worker) {
		th.Subscribers = append(th.Subscribers, body.Worker)
	}
	sp.changed()
	writeJSON(w, 200, map[string]any{"thread": th.ID, "subscribers": th.Subscribers})
}

func (s *Server) superStop(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Worker string `json:"worker"`
	}
	if !decode(w, r, &body) {
		return
	}
	sp := s.sup
	sp.mu.Lock()
	wk := sp.st.Workers[body.Worker]
	sp.mu.Unlock()
	if wk == nil {
		writeJSON(w, 404, map[string]any{"error": "unknown worker"})
		return
	}
	if wk.Session == "" && wk.PaneID != "" {
		// herdr does not always know (Antigravity): ask the pane's machine.
		local, m := split(wk.PaneID)
		if ps := s.titlesFor(m, r.Context())[local]; ps.Session != "" {
			sp.mu.Lock()
			wk.Session = ps.Session
			sp.mu.Unlock()
		}
	}
	if wk.PaneID != "" {
		// Esc stops the turn it is on, the way you would before closing it:
		// Codex's turn lives in a shared daemon and would carry on without
		// its window.
		s.herdr.Call(r.Context(), "pane.send_keys", map[string]any{"pane_id": wk.PaneID, "keys": []string{"esc"}}, nil)
		time.Sleep(700 * time.Millisecond)
	}
	if kinds[wk.Kind] == "codex" && wk.Session != "" {
		// Its turn runs in Codex's shared daemon and outlives the terminal.
		if err := s.stopCodexTurn(r.Context(), wk.Machine, wk.Session); err != nil {
			log.Printf("stop %s: interrupt its codex turn: %v", wk.Name, err)
		}
	}
	if wk.WorkspaceID != "" {
		s.herdr.Call(r.Context(), "workspace.close", map[string]any{"workspace_id": wk.WorkspaceID}, nil)
	}
	sp.mu.Lock()
	delete(sp.workerAskedAt, wk.Name)
	wk.Ended, wk.Status = true, "gone"
	for _, th := range sp.st.Threads {
		th.Subscribers = remove(th.Subscribers, wk.Name)
	}
	sp.addEntryLocked("event", wk.Thread, wk.Name+" 已停止", wk.Name, "info")
	sp.mu.Unlock()
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) superShow(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if out, ok := s.sup.Show(id); ok {
		if strings.HasPrefix(out, "thread ") {
			if older := threadHistory(s.sup.db, id, 1<<62, 40); len(older) > 15 {
				out += fmt.Sprintf("  … %d older triggers in history (SQLite)\n", len(older)-15)
			}
		} else if strings.HasPrefix(out, "worker ") {
			s.sup.mu.Lock()
			wk := s.sup.st.Workers[id]
			pane := ""
			if wk != nil {
				pane = wk.PaneID
			}
			s.sup.mu.Unlock()
			if pane != "" {
				cctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
				if rr, err := s.herdr.Read(cctx, pane, "recent_unwrapped", "text", 50); err == nil && strings.TrimSpace(rr.Text) != "" {
					out += "\nrecent screen:\n" + tailLines(rr.Text, 35) + "\n"
				}
				cancel()
			}
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		io.WriteString(w, out)
		return
	}
	http.Error(w, "nothing found for "+id+" (ids look like t12, a thread like chat:main, or a worker name)", 404)
}

func (s *Server) superList(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	io.WriteString(w, s.sup.List())
}

func (s *Server) superTriggers(w http.ResponseWriter, r *http.Request) {
	sp := s.sup
	sp.mu.Lock()
	defer sp.mu.Unlock()
	ts := sp.st.Triggers
	if len(ts) > 120 {
		ts = ts[len(ts)-120:]
	}
	out := make([]*Trigger, 0, len(ts))
	for i := len(ts) - 1; i >= 0; i-- {
		cp := *ts[i]
		cp.Text = clip(cp.Text, 600)
		out = append(out, &cp)
	}
	ths := []*Thread{}
	for _, th := range sp.st.Threads {
		ths = append(ths, th)
	}
	sort.Slice(ths, func(i, j int) bool { return ths[i].LastAt.After(ths[j].LastAt) })
	if len(ths) > 40 {
		ths = ths[:40]
	}
	writeJSON(w, 200, map[string]any{"triggers": out, "threads": ths})
}

// ---------------------------------------------------------------- timers

func (s *Server) superTimers(w http.ResponseWriter, r *http.Request) {
	sp := s.sup
	sp.mu.Lock()
	defer sp.mu.Unlock()
	writeJSON(w, 200, map[string]any{"timers": sp.st.Timers})
}

func (s *Server) superAddTimer(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Spec   string `json:"spec"`
		Text   string `json:"text"`
		Thread string `json:"thread"`
		Target string `json:"target"`
		Owner  string `json:"owner"`
	}
	if !decode(w, r, &body) {
		return
	}
	next, err := parseSpec(body.Spec, time.Now())
	if err != nil || strings.TrimSpace(body.Text) == "" {
		msg := "text is required"
		if err != nil {
			msg = err.Error()
		}
		writeJSON(w, 400, map[string]any{"error": msg})
		return
	}
	if body.Thread == "" {
		body.Thread = mainThread
	}
	sp := s.sup
	sp.mu.Lock()
	t := &Timer{ID: sp.st.nextID("m"), Spec: strings.TrimSpace(body.Spec), Thread: body.Thread, Target: body.Target,
		Text: body.Text, NextRun: next, Enabled: true, Owner: body.Owner}
	sp.st.Timers = append(sp.st.Timers, t)
	sp.changed()
	sp.mu.Unlock()
	writeJSON(w, 200, t)
}

func (s *Server) superDeleteTimer(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	sp := s.sup
	sp.mu.Lock()
	defer sp.mu.Unlock()
	for i, t := range sp.st.Timers {
		if t.ID == id {
			sp.st.Timers = append(sp.st.Timers[:i], sp.st.Timers[i+1:]...)
			sp.deletedTimers = append(sp.deletedTimers, id)
			sp.changed()
			writeJSON(w, 200, map[string]any{"ok": true})
			return
		}
	}
	writeJSON(w, 404, map[string]any{"error": "no timer " + id})
}

// ---------------------------------------------------------------- settings

func (s *Server) hookKey() string {
	h := sha256.Sum256([]byte("collie-hooks:" + s.token))
	return hex.EncodeToString(h[:12])
}

func (s *Server) superSettings(w http.ResponseWriter, r *http.Request) {
	sp := s.sup
	sp.mu.Lock()
	defer sp.mu.Unlock()
	writeJSON(w, 200, map[string]any{
		"settings": sp.st.Settings, "policies": sp.st.Policies,
		"hook_key": s.hookKey(), "router_dir": sp.routerDir(), "bin": sp.bin,
	})
}

// superSeen: a page of Collie is open in front of you. Its origin goes in
// the notifications' link.
func (s *Server) superSeen(w http.ResponseWriter, r *http.Request) {
	var body struct {
		URL string `json:"url"`
	}
	if !decode(w, r, &body) {
		return
	}
	if !strings.HasPrefix(body.URL, "http://") && !strings.HasPrefix(body.URL, "https://") || len(body.URL) > 200 {
		body.URL = ""
	}
	s.sup.Seen(body.URL)
	writeJSON(w, 200, map[string]any{"ok": true})
}

// superEarlier is Collie's chat before a given entry, a page at a time,
// oldest first: what the page shows when you scroll back past what it has.
func (s *Server) superEarlier(w http.ResponseWriter, r *http.Request) {
	before := idNum(r.URL.Query().Get("before"))
	if before <= 0 {
		writeJSON(w, 400, map[string]any{"error": "before?"})
		return
	}
	sp := s.sup
	sp.flush() // what memory has but the DB not yet
	const page = 120
	es := entryHistory(sp.db, mainThread, before, page+1)
	more := len(es) > page
	if more {
		es = es[:page]
	}
	for i, j := 0, len(es)-1; i < j; i, j = i+1, j-1 {
		es[i], es[j] = es[j], es[i]
	}
	writeJSON(w, 200, map[string]any{"entries": es, "more": more})
}

// superLark says whom the hub's lark-cli would write to.
func (s *Server) superLark(w http.ResponseWriter, r *http.Request) {
	_, _, who, problem := lark.get(r.URL.Query().Has("fresh"))
	writeJSON(w, 200, map[string]any{"ready": problem == "", "who": who, "problem": problem})
}

func (s *Server) superSaveSettings(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Settings *Settings `json:"settings"`
		Policies []Policy  `json:"policies"`
		Restart  bool      `json:"restart"`
	}
	if !decode(w, r, &body) {
		return
	}
	sp := s.sup
	sp.mu.Lock()
	old := sp.st.Settings
	routerChanged := false
	if body.Settings != nil {
		ns := *body.Settings
		if _, ok := kinds[ns.RouterKind]; !ok {
			ns.RouterKind = sp.st.Settings.RouterKind
		}
		if _, ok := kinds[ns.WorkerKind]; !ok {
			ns.WorkerKind = sp.st.Settings.WorkerKind
		}
		if ns.NotifyLevel != "normal" {
			ns.NotifyLevel = "quiet"
		}
		for _, p := range []*string{&ns.RouterModel, &ns.RouterEffort, &ns.WorkerModel, &ns.WorkerEffort} {
			if *p = strings.TrimSpace(*p); !modelNameRe.MatchString(*p) {
				*p = ""
			}
		}
		ns.migrateReply()
		if ns.DreamAt != "off" {
			var h, m int
			if _, err := fmt.Sscanf(ns.DreamAt, "%d:%d", &h, &m); err != nil || h < 0 || h > 23 || m < 0 || m > 59 {
				ns.DreamAt = ""
			} else {
				ns.DreamAt = fmt.Sprintf("%02d:%02d", h, m)
			}
		}
		if ns.RotatePct > 95 || (ns.RotatePct > 0 && ns.RotatePct < 20) {
			ns.RotatePct = 0
		} else if ns.RotatePct < 0 {
			ns.RotatePct = -1
		}
		ns.RouterMachine = s.machineByName(ns.RouterMachine)
		ns.WorkerMachine = s.machineByName(ns.WorkerMachine)
		if ns.WorkerMachine == "" {
			// Paths on other computers are resolved there, against their home.
			ns.WorkerCwd = s.expand(ns.WorkerCwd)
		} else if ns.WorkerCwd == "" || ns.WorkerCwd == s.home {
			ns.WorkerCwd = "~"
		}
		routerChanged = kinds[ns.RouterKind] != kinds[old.RouterKind] ||
			ns.RouterMachine != old.RouterMachine ||
			ns.RouterModel != old.RouterModel ||
			ns.RouterEffort != old.RouterEffort ||
			strings.Join(ns.RouterArgs, " ") != strings.Join(old.RouterArgs, " ") ||
			ns.AskPermissions != old.AskPermissions
		if routerChanged {
			sp.routerLaunchAt = time.Time{}
		}
		sp.st.Settings = ns
	}
	if body.Policies != nil {
		valid := []Policy{}
		for _, p := range body.Policies {
			if p.Source != "" && (p.Action == "respond" || p.Action == "candidate" || p.Action == "ignore") {
				valid = append(valid, p)
			}
		}
		sp.st.Policies = valid
	}
	sp.changed()
	settingsOut := sp.st.Settings
	policiesOut := sp.st.Policies
	sp.mu.Unlock()
	if body.Settings != nil {
		go func(doRestart bool) { // ROUTER.md quotes some settings (reply length, where workers go)
			if err := sp.writeRouterFiles(); err != nil {
				log.Printf("router files: %v", err)
			}
			if doRestart {
				_ = sp.RestartRouter(context.Background())
			}
		}(body.Restart && routerChanged)
	}
	writeJSON(w, 200, map[string]any{"settings": settingsOut, "policies": policiesOut, "restarted": body.Restart && routerChanged})
}

func (s *Server) superRestartRouter(w http.ResponseWriter, r *http.Request) {
	s.sup.RestartRouter(r.Context())
	writeJSON(w, 202, map[string]any{"ok": true})
}

// ---------------------------------------------------------------- webhooks

// webhook ingests external events (GitHub, Feishu/Lark, anything that can
// POST JSON). It acknowledges immediately; filtering and routing happen in
// the inbox, never in the request path.
func (s *Server) webhook(w http.ResponseWriter, r *http.Request) {
	key := r.URL.Query().Get("key")
	want := s.hookKey()
	if subtle.ConstantTimeCompare([]byte(key), []byte(want)) != 1 && !s.authed(r) {
		writeJSON(w, 401, map[string]any{"error": "bad hook key"})
		return
	}
	src := strings.ToLower(r.PathValue("source"))
	if !nameRe.MatchString(src) {
		writeJSON(w, 400, map[string]any{"error": "bad source name"})
		return
	}
	raw, _ := io.ReadAll(http.MaxBytesReader(w, r.Body, 2<<20))
	var payload map[string]any
	json.Unmarshal(raw, &payload)

	// Feishu/Lark URL verification handshake.
	if payload["type"] == "url_verification" {
		writeJSON(w, 200, map[string]any{"challenge": payload["challenge"]})
		return
	}

	thread, from, text, idem := genericEvent(src, payload, raw, r)
	switch {
	case r.Header.Get("X-GitHub-Event") != "":
		thread, from, text = githubEvent(r.Header.Get("X-GitHub-Event"), payload)
		idem = r.Header.Get("X-GitHub-Delivery")
	case payload["header"] != nil && payload["event"] != nil:
		thread, from, text, idem = feishuEvent(payload)
	}
	if text == "" {
		writeJSON(w, 202, map[string]any{"ok": true, "ignored": "empty event"})
		return
	}
	t := s.sup.Ingest("webhook:"+src, thread, from, text, idem, "", "")
	res := map[string]any{"ok": true}
	if t != nil {
		res["trigger"], res["action"] = t.ID, t.Action
	} else {
		res["duplicate"] = true
	}
	writeJSON(w, 202, res)
}

func str(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case float64:
		return fmt.Sprintf("%.0f", x)
	}
	return ""
}

func dig(m map[string]any, path ...string) any {
	var cur any = m
	for _, p := range path {
		mm, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur = mm[p]
	}
	return cur
}

func genericEvent(src string, p map[string]any, raw []byte, r *http.Request) (thread, from, text, idem string) {
	thread = r.Header.Get("X-Collie-Thread")
	if thread == "" {
		thread = str(p["thread"])
	}
	if thread == "" {
		thread = src
	}
	if !strings.Contains(thread, ":") {
		thread = src + ":" + thread
	}
	from = str(p["from"])
	text = str(p["text"])
	if text == "" {
		text = clip(string(raw), 4000)
	}
	idem = r.Header.Get("X-Idempotency-Key")
	if idem == "" {
		idem = str(p["id"])
	}
	return
}

func githubEvent(kind string, p map[string]any) (thread, from, text string) {
	repo := str(dig(p, "repository", "full_name"))
	num := str(dig(p, "issue", "number"))
	if num == "" {
		num = str(dig(p, "pull_request", "number"))
	}
	if num == "" {
		num = str(p["number"])
	}
	thread = "github:" + repo
	if num != "" {
		thread += "#" + num
	}
	from = str(dig(p, "sender", "login"))
	title := str(dig(p, "issue", "title"))
	if title == "" {
		title = str(dig(p, "pull_request", "title"))
	}
	body := str(dig(p, "comment", "body"))
	if body == "" {
		body = str(dig(p, "review", "body"))
	}
	if body == "" {
		body = str(dig(p, "issue", "body"))
	}
	if body == "" {
		body = str(dig(p, "pull_request", "body"))
	}
	url := str(dig(p, "comment", "html_url"))
	if url == "" {
		url = str(dig(p, "issue", "html_url"))
	}
	if url == "" {
		url = str(dig(p, "pull_request", "html_url"))
	}
	if kind == "check_run" || kind == "workflow_run" || kind == "check_suite" {
		name := str(dig(p, kind, "name"))
		concl := str(dig(p, kind, "conclusion"))
		branch := str(dig(p, kind, "head_branch"))
		url = str(dig(p, kind, "html_url"))
		if concl == "" {
			return thread, from, ""
		}
		return thread, from, fmt.Sprintf("GitHub %s %q on %s: %s\n%s", kind, name, branch, concl, url)
	}
	text = fmt.Sprintf("GitHub %s/%s on %s: %s\n%s\n%s", kind, str(p["action"]), thread, title, clip(body, 2500), url)
	return thread, from, strings.TrimSpace(text)
}

func feishuEvent(p map[string]any) (thread, from, text, idem string) {
	idem = str(dig(p, "header", "event_id"))
	msg, _ := dig(p, "event", "message").(map[string]any)
	if msg == nil {
		return "feishu:events", "", clip(fmt.Sprint(p["event"]), 2000), idem
	}
	chat := str(msg["chat_id"])
	root := str(msg["root_id"])
	if root == "" {
		root = str(msg["message_id"])
	}
	thread = "feishu:" + chat + ":" + root
	from = str(dig(p, "event", "sender", "sender_id", "open_id"))
	var content struct {
		Text string `json:"text"`
	}
	json.Unmarshal([]byte(str(msg["content"])), &content)
	text = content.Text
	if text == "" {
		text = "[" + str(msg["message_type"]) + " message]"
	}
	return thread, from, "Feishu message in " + chat + ":\n" + text, idem
}

// machineByName accepts a machine id or its display name ("" or "hub" = the
// hub's own machine).
func (s *Server) machineByName(n string) string {
	n = strings.TrimSpace(n)
	if n == "" || n == "hub" || n == "local" {
		return ""
	}
	for _, m := range s.herdr.Machines() {
		if m.ID == n || strings.EqualFold(m.Name, n) {
			return m.ID
		}
	}
	return n
}

// modelNameRe: model ids and effort names go onto a command line as one argument.
var modelNameRe = regexp.MustCompile(`^[A-Za-z0-9._:/@\[\]-]{0,120}$`)

// superAnswer: the router answers a dialog a worker is stuck on, by choice
// number, label words or "esc". The human sees what it picked.
func (s *Server) superAnswer(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Worker string `json:"worker"`
		Choice string `json:"choice"`
	}
	if !decode(w, r, &body) {
		return
	}
	sp := s.sup
	sp.mu.Lock()
	wk := sp.st.Workers[body.Worker]
	sp.mu.Unlock()
	if wk == nil || wk.Ended || wk.PaneID == "" {
		writeJSON(w, 404, map[string]any{"error": "no running worker " + body.Worker})
		return
	}
	rr, err := s.herdr.Read(r.Context(), wk.PaneID, "detection", "text", 0)
	if err != nil {
		fail(w, err)
		return
	}
	if !screenAsks(rr.Text) {
		writeJSON(w, 409, map[string]any{"error": body.Worker + " isn't showing a dialog now"})
		return
	}
	a := parseApproval(rr.Text)
	label := "Esc"
	if strings.EqualFold(strings.TrimSpace(body.Choice), "esc") {
		err = s.herdr.Call(r.Context(), "pane.send_keys", map[string]any{"pane_id": wk.PaneID, "keys": []string{"esc"}}, nil)
	} else {
		c, ok := pickChoice(a, body.Choice)
		if !ok {
			var list []string
			for i, c := range a.Choices {
				list = append(list, fmt.Sprintf("%d. %s", i+1, c.Label))
			}
			writeJSON(w, 400, map[string]any{"error": "no single choice matches " + strconv.Quote(body.Choice), "choices": list})
			return
		}
		label, err = strings.Join(strings.Fields(c.Label), " "), sp.choose(r.Context(), wk.PaneID, c)
	}
	if err != nil {
		fail(w, err)
		return
	}
	sp.mu.Lock()
	sp.addEntryLocked("event", wk.Thread, "替 "+wk.Name+" 选了："+clip(label, 80), wk.Name, "info")
	sp.mu.Unlock()
	writeJSON(w, 200, map[string]any{"ok": true, "picked": label})
}
