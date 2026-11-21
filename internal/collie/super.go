package collie

import (
	"bytes"
	"context"
	"crypto/sha1"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Super is Collie's super-agent: one resident Router session (the herdr agent
// named "collie") that talks to the human and dispatches work, plus isolated
// Worker sessions (other herdr agents) that do it. Everything that reaches the
// system is a Trigger in a durable inbox; Collie filters, routes, batches and
// delivers triggers whenever the target session is free.
type Super struct {
	s   *Server
	db  *sql.DB
	bin string
	dir string // ~/.config/collie

	mu            sync.Mutex
	st            *State
	dirty         bool
	deletedTimers []string
	subs          map[chan struct{}]bool

	routerLaunching bool
	rereadTrig      *Trigger // the pending "re-read ROUTER.md", if any
	routerLaunchAt  time.Time
	routerFresh     bool
	routerAskedAt   time.Time // last delivery to the router not yet followed by a reply or check
	routerRetries   int       // turns in a row that ended on an API error, each retried
	routerUsage     ctxUsage
	// The model and effort the running router was launched with (unknown after a hub restart).
	routerRun   *[2]string
	handover    *handover            // set while the router writes its memory before a fresh session
	dream       *dreamRun            // set while Collie sleeps and a dream session tidies its memory
	lastTrust   map[string]time.Time // pane → when its trust dialog was last answered
	lastScreen    map[string]screenMark
	transcripts   map[string]*transcript
	noAgent       map[string]time.Time // worker → since when its pane has had no agent in it
	workerAskedAt map[string]time.Time // worker → when its latest prompt was delivered
	notifyBuf     []notice
	notifyAt    time.Time
	seenAt      time.Time // when a page of Collie was last open in front of you
	seenURL     string    // where that page was, for the link in a notification
}

type screenMark struct {
	hash  string
	since time.Time
	flag  bool
}

const (
	routerName  = "collie"
	routerLabel = "collie · router"
)
const mainThread = "chat:main"

func newSuper(s *Server, dir string) (*Super, error) {
	bin, _ := os.Executable()
	if r, err := filepath.EvalSymlinks(bin); err == nil {
		bin = r
	}
	bin = stableBin(bin, dir)
	sp := &Super{
		s: s, dir: dir, bin: bin,
		subs:          map[chan struct{}]bool{},
		lastScreen:    map[string]screenMark{},
		transcripts:   map[string]*transcript{},
		noAgent:       map[string]time.Time{},
		workerAskedAt: map[string]time.Time{},
	}
	db, err := openDB(filepath.Join(dir, "herd.db")) // ~/.collie/collie.db belongs to another app
	if err != nil {
		return nil, err
	}
	sp.db = db
	if sp.st, err = loadState(db, s.home); err != nil {
		return nil, err
	}
	return sp, nil
}

// ---------------------------------------------------------------- state plumbing

func (sp *Super) changed() {
	sp.dirty = true
	for ch := range sp.subs {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

func (sp *Super) subscribe() (chan struct{}, func()) {
	ch := make(chan struct{}, 1)
	sp.mu.Lock()
	sp.subs[ch] = true
	sp.mu.Unlock()
	return ch, func() { sp.mu.Lock(); delete(sp.subs, ch); sp.mu.Unlock() }
}

func (sp *Super) flush() {
	sp.mu.Lock()
	defer sp.mu.Unlock()
	if !sp.dirty {
		return
	}
	if err := saveState(sp.db, sp.st, sp.deletedTimers); err != nil {
		log.Printf("save state: %v", err)
		return
	}
	sp.st.trim() // history beyond the working set stays in SQLite
	sp.dirty, sp.deletedTimers = false, nil
}

func (sp *Super) addEntryLocked(role, thread, text, ref, tone string) *Entry {
	return sp.addEntryReLocked(role, thread, text, ref, tone, nil)
}

func (sp *Super) addEntryReLocked(role, thread, text, ref, tone string, re *Quote) *Entry {
	e := &Entry{ID: sp.st.nextID("e"), Role: role, Thread: thread, Text: text, At: time.Now(), Ref: ref, Tone: tone, Re: re}
	sp.st.Entries = append(sp.st.Entries, e)
	if role == "collie" || tone == "blocked" || tone == "error" {
		sp.queueNotifyLocked(role, text, tone, re)
	}
	sp.changed()
	return e
}

func (sp *Super) threadLocked(id string) *Thread {
	th := sp.st.Threads[id]
	if th == nil {
		th = &Thread{ID: id, Subscribers: []string{}, Triggers: []string{}}
		sp.st.Threads[id] = th
	}
	return th
}

// Ingest puts one trigger in the inbox after the fast-path policy check.
// It returns the trigger (nil when it was a duplicate).
func (sp *Super) Ingest(source, thread, from, text, key, target, ref string) *Trigger {
	sp.mu.Lock()
	defer sp.mu.Unlock()
	return sp.ingestLocked(source, thread, from, text, key, target, ref)
}

func (sp *Super) ingestLocked(source, thread, from, text, key, target, ref string) *Trigger {
	if key != "" {
		for i := len(sp.st.Triggers) - 1; i >= 0 && i > len(sp.st.Triggers)-400; i-- {
			if sp.st.Triggers[i].Key == key {
				return nil
			}
		}
	}
	if thread == "" {
		thread = mainThread
	}
	pol := sp.st.policyFor(source)
	action := pol.Action
	if len(pol.Allow) > 0 && !contains(pol.Allow, from) {
		action = "ignore"
	}
	t := &Trigger{
		ID: sp.st.nextID("t"), Source: source, Thread: thread, From: from, Text: text,
		At: time.Now(), Action: action, Status: "queued", Key: key, Ref: ref,
	}
	if action == "ignore" {
		t.Status = "ignored"
	} else if target != "" {
		t.Targets = []string{target}
	}
	sp.st.Triggers = append(sp.st.Triggers, t)
	th := sp.threadLocked(thread)
	th.LastAt = t.At
	th.Triggers = append(th.Triggers, t.ID)
	sp.changed()
	return t
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------- run loop

func (sp *Super) Run(ctx context.Context) {
	// A new build may change the router's instructions: the next session
	// (a handover, a dream, a restart) reads them fresh.
	if err := sp.writeRouterFiles(); err != nil {
		log.Printf("router files: %v", err)
	}
	tick := time.NewTicker(1500 * time.Millisecond)
	defer tick.Stop()
	save := time.NewTicker(2 * time.Second)
	defer save.Stop()
	for {
		select {
		case <-ctx.Done():
			sp.flush()
			return
		case <-save.C:
			sp.flush()
			sp.sendNotifications()
		case <-tick.C:
			func() {
				defer func() {
					if r := recover(); r != nil {
						log.Printf("super tick panic: %v", r)
					}
				}()
				sp.tick(ctx)
			}()
		}
	}
}

type liveAgent struct {
	Pane    string
	Status  string
	Ready   bool
	Kind    string
	Session string
}

var uuidRe = regexp.MustCompile(`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)

// sessionID is what an agent's conversation is resumed by. herdr gives some
// (Codex) as the path of their log, whose name ends in the id.
func sessionID(kind, value string) string {
	if kind != "path" {
		return value
	}
	ids := uuidRe.FindAllString(baseOfPath(value), -1)
	if len(ids) == 0 {
		return ""
	}
	return ids[len(ids)-1]
}

func (sp *Super) liveAgents(ctx context.Context) (map[string]liveAgent, bool) {
	list, err := sp.s.herdr.Agents(ctx)
	if err != nil {
		return nil, false
	}
	m := map[string]liveAgent{}
	for _, a := range list {
		if a.Name != nil {
			la := liveAgent{Pane: a.PaneID, Status: a.AgentStatus, Ready: a.Ready, Kind: deref(a.Agent)}
			if a.Session != nil {
				la.Session = sessionID(a.Session.Kind, a.Session.Value)
			}
			m[*a.Name] = la
		}
	}
	return m, true
}

func (sp *Super) tick(parent context.Context) {
	ctx, cancel := context.WithTimeout(parent, 20*time.Second)
	defer cancel()
	live, ok := sp.liveAgents(ctx)
	if !ok {
		return // herdr unavailable; keep everything queued
	}
	now := time.Now()

	type finished struct {
		w       *Worker
		blocked bool
	}
	var fin []finished
	var dead []*Worker // the agent never started, or quit, leaving a shell
	deliveries := map[string][]*Trigger{}

	sp.mu.Lock()
	paused := sp.st.Settings.Paused
	// 1. Timers → triggers.
	for _, t := range sp.st.Timers {
		if t.Enabled && !t.NextRun.After(now) {
			at := now
			t.LastRun = &at
			t.advance(now)
			sp.ingestLocked("timer", t.Thread, t.ID, t.Text, "", t.Target, t.ID)
		}
	}
	// 2. Worker lifecycle → triggers for the router.
	for _, w := range sp.st.Workers {
		if w.Ended {
			// herdr restored its pane (a herdr restart or update): it's back.
			if a, ok := live[w.Name]; ok && w.Status == "gone" && w.PaneID != "" && a.Pane == w.PaneID {
				w.Ended, w.Status = false, a.Status
				sp.ingestLocked("worker", w.Thread, w.Name, fmt.Sprintf("worker %s is back: herdr restored its pane (status %s).", w.Name, a.Status), "", "", w.Name)
				sp.addEntryLocked("event", w.Thread, w.Name+" 回来了（herdr 恢复了它的窗格）", w.Name, "info")
				sp.changed()
			}
			continue
		}
		a, alive := live[w.Name]
		if !alive {
			if w.Status != "starting" && w.Status != "failed" {
				delete(sp.noAgent, w.Name)
				delete(sp.workerAskedAt, w.Name)
				w.Ended, w.Status = true, "gone"
				for _, t := range sp.st.Triggers {
					if t.Status == "queued" && len(t.Targets) == 1 && t.Targets[0] == w.Name && t.Source == "system" {
						t.Status = "ignored"
					}
				}
				dead = append(dead, w)
				sp.changed()
			}
			continue
		}
		// No agent in the pane for a few seconds after launch: it failed to start
		// (a broken config/install, a bad flag) or quit right back to the shell.
		if a.Kind == "" {
			since, seen := sp.noAgent[w.Name]
			if !seen {
				sp.noAgent[w.Name], since = now, now
			}
			if w.Status != "starting" && now.Sub(since) > 5*time.Second && now.Sub(w.CreatedAt) > 6*time.Second {
				delete(sp.noAgent, w.Name)
				delete(sp.workerAskedAt, w.Name)
				w.Ended, w.Status, w.PaneID = true, "failed", a.Pane
				for _, t := range sp.st.Triggers {
					if t.Status == "queued" && len(t.Targets) == 1 && t.Targets[0] == w.Name {
						t.Status = "ignored"
					}
				}
				dead = append(dead, w)
				sp.changed()
			}
			continue
		}
		delete(sp.noAgent, w.Name)
		if a.Session != "" && a.Session != w.Session {
			w.Session = a.Session
			sp.dirty = true
		}
		prev := w.Status
		asked := sp.workerAskedAt[w.Name]
		if a.Status != prev {
			w.Status = a.Status
			w.PaneID = a.Pane
			sp.changed()
			switch {
			case a.Status == "blocked":
				fin = append(fin, finished{w, true})
			case (prev == "working" || prev == "waiting") && (a.Status == "done" || a.Status == "idle"):
				delete(sp.workerAskedAt, w.Name)
				if now.Sub(w.ReportAt) > 90*time.Second {
					fin = append(fin, finished{w, false})
				}
			case !asked.IsZero() && (a.Status == "done" || a.Status == "idle"):
				// Fast sub-tick turn or immediate API error (e.g. 402 Insufficient Balance in <1s)
				// that finished before tick() ever observed "working".
				delete(sp.workerAskedAt, w.Name)
				if now.Sub(w.ReportAt) > 90*time.Second {
					fin = append(fin, finished{w, false})
				}
			}
		} else if !asked.IsZero() && (a.Status == "done" || a.Status == "idle") && now.Sub(asked) >= 5*time.Second {
			// Prompt was delivered, status never left idle/done for 5s+: check for
			// immediate agent error or fast silent completion.
			delete(sp.workerAskedAt, w.Name)
			if now.Sub(w.ReportAt) > 90*time.Second {
				fin = append(fin, finished{w, false})
			}
		}
	}
	// 3. Route queued triggers to sessions: subscribed workers first (fast path), router otherwise.
	for _, t := range sp.st.Triggers {
		if t.Status != "queued" {
			continue
		}
		if len(t.Targets) == 0 {
			if t.Source != "worker" && t.Source != "chat" {
				if th := sp.st.Threads[t.Thread]; th != nil {
					for _, sub := range th.Subscribers {
						if w := sp.st.Workers[sub]; w != nil && !w.Ended && sub != t.From {
							t.Targets = append(t.Targets, sub)
						}
					}
				}
			}
			if len(t.Targets) == 0 {
				t.Targets = []string{routerName}
			}
		}
		for _, target := range t.Targets {
			deliveries[target] = append(deliveries[target], t)
		}
	}
	routerAlive := false
	_, routerAlive = live[routerName]
	sp.mu.Unlock()

	// Worker completion summaries need file/screen IO: do it outside the lock.
	for _, f := range fin {
		sp.workerSettled(ctx, f.w, f.blocked)
	}
	for _, w := range dead {
		sp.workerDead(ctx, w)
	}

	if paused {
		return
	}

	// 4. Deliver batches to free sessions.
	for target, list := range deliveries {
		if target == routerName && (sp.handingOver() || sp.dreaming()) {
			continue // events wait for the fresh session
		}
		a, alive := live[target]
		if !alive {
			if target == routerName {
				sp.ensureRouter(ctx)
			} else {
				sp.rerouteToRouter(target, list)
			}
			continue
		}
		if target == routerName && a.Status == "blocked" {
			sp.trustOwnDir(ctx, a.Pane)
		}
		// Nothing is typed over a dialog or into an agent that is still
		// starting. Otherwise a message goes in mid-turn: Claude, Codex and agy
		// queue typed input and pick it up between steps, so corrections and
		// questions arrive now rather than after the current step. Collie's
		// other events (reports, timers) batch up while it works; the human's
		// own messages don't wait.
		if a.Status == "blocked" || (!a.Ready && a.Status == "unknown") {
			continue
		}
		if a.Status == "working" && target == routerName {
			if list = fromHuman(list); len(list) == 0 {
				continue
			}
		}
		sp.deliver(ctx, target, list)
	}

	if a, ok := live[routerName]; ok && (a.Status == "done" || a.Status == "idle") {
		sp.routerSettled(ctx, a.Pane)
	}
	sp.checkHandover(ctx, live, len(deliveries[routerName]) > 0)
	sp.checkDream(ctx, live, len(deliveries[routerName]) > 0)

	// 5. Watchdog.
	sp.watchdog(ctx, live, routerAlive)
}

// fromHuman keeps what the human said in the chat.
func fromHuman(list []*Trigger) []*Trigger {
	var out []*Trigger
	for _, t := range list {
		if t.Source == "chat" {
			out = append(out, t)
		}
	}
	return out
}

func (sp *Super) rerouteToRouter(target string, list []*Trigger) {
	sp.mu.Lock()
	defer sp.mu.Unlock()
	w := sp.st.Workers[target]
	if w != nil && !w.Ended && (w.Status == "starting" || time.Since(w.CreatedAt) < 2*time.Minute) {
		return // still launching
	}
	for _, t := range list {
		// Never reroute a worker's own initial system brief ("You are worker X...")
		// back to Collie Router when X dies before receiving it.
		if t.Source == "system" && t.From == routerName && len(t.Targets) == 1 && t.Targets[0] == target {
			t.Status = "ignored"
			continue
		}
		t.Targets = replace(t.Targets, target, routerName)
	}
	sp.changed()
}

func replace(list []string, from, to string) []string {
	out := []string{}
	for _, x := range list {
		if x == from {
			x = to
		}
		if !contains(out, x) {
			out = append(out, x)
		}
	}
	return out
}

// deliver submits all pending triggers for one session as a single prompt.
func (sp *Super) deliver(ctx context.Context, target string, list []*Trigger) {
	sort.Slice(list, func(i, j int) bool { return list[i].At.Before(list[j].At) })
	if len(list) > 20 {
		list = list[:20]
	}
	sp.mu.Lock()
	fresh := target == routerName && sp.routerFresh
	words := sp.st.Settings.ReplyChars
	sp.mu.Unlock()

	var b strings.Builder
	if fresh {
		b.WriteString(sp.sessionStart())
		b.WriteString("\n")
	}
	if len(list) == 1 {
		b.WriteString("[collie] 1 new event\n")
	} else {
		fmt.Fprintf(&b, "[collie] %d new events (batched)\n", len(list))
	}
	for _, t := range list {
		fmt.Fprintf(&b, "\n#%s · %s · %s", t.ID, t.Thread, t.Source)
		if t.From != "" {
			fmt.Fprintf(&b, " · from %s", t.From)
		}
		if t.Action == "candidate" {
			b.WriteString(" · candidate (act only if a rule or memory says so; otherwise stay silent)")
		}
		fmt.Fprintf(&b, " · %s\n", t.At.Format("15:04"))
		text := strings.TrimSpace(t.Text)
		if len([]rune(text)) > 700 { // Inline & Spill
			text = string([]rune(text)[:700]) + fmt.Sprintf(" … [spilled; run `collie show %s`]", t.ID)
		}
		b.WriteString(indent(text, "  "))
		b.WriteString("\n")
	}
	if target == routerName {
		if pane := sp.s.herdr.paneOfName(ctx, routerName); pane != "" {
			if _, m := split(pane); m != "" {
				sp.writeMessages()
				_, _ = sp.pushRouterToNode(ctx, m)
			}
		}
		fmt.Fprintf(&b, "\nReply to the human only via `collie reply` (usually ≤%d characters; longer only when they ask for detail; add --re <event id> when it answers something other than their latest message). Delegate work with `collie spawn`; never do task work yourself.", words)
	} else {
		b.WriteString("\nWork it through on your own: retry, try another approach. If you truly can't go on (a decision only the human can make, access you don't have, the same failure after a few different tries), don't spin or wait silently, and don't ask the human: run `collie report \"BLOCKED: <what you need> · tried: <what you tried> · I'd pick: <your choice>\"` and Collie will decide or ask them. When done, run `collie report \"…\"` with the result.")
	}

	err := sp.s.herdr.Prompt(ctx, target, b.String())
	var he *HerdrError
	if err != nil && errors.As(err, &he) && (he.Code == "agent_blocked" || he.Code == "agent_not_ready") {
		return
	}
	sp.mu.Lock()
	defer sp.mu.Unlock()
	if err != nil {
		log.Printf("deliver to %s: %v", target, err)
		return
	}
	if fresh {
		sp.routerFresh = false
	}
	if target == routerName && sp.routerAskedAt.IsZero() {
		sp.routerAskedAt = time.Now() // a message mid-turn keeps the turn's start
	} else if target != routerName {
		sp.workerAskedAt[target] = time.Now()
	}
	for _, t := range list {
		t.Targets = remove(t.Targets, target)
		if len(t.Targets) == 0 {
			t.Status = "delivered"
		}
	}
	sp.changed()
}

func remove(list []string, v string) []string {
	out := list[:0:0]
	for _, x := range list {
		if x != v {
			out = append(out, x)
		}
	}
	return out
}

func indent(s, p string) string {
	return p + strings.ReplaceAll(s, "\n", "\n"+p)
}

// workerSettled turns a worker reaching done/blocked into a router trigger,
// carrying a short summary from the worker's transcript or screen.
// workerDead tells the router and the human that a worker's agent isn't
// running (or exited prematurely), reading what its screen says before closing
// any leftover shell workspace.
func (sp *Super) workerDead(ctx context.Context, w *Worker) {
	tail := ""
	if w.PaneID != "" {
		if res, err := sp.s.herdr.Read(ctx, w.PaneID, "recent_unwrapped", "text", 40); err == nil {
			var keep []string
			for _, l := range strings.Split(res.Text, "\n") {
				if l = strings.TrimRight(l, " \r"); strings.TrimSpace(l) != "" {
					keep = append(keep, l)
				}
			}
			if len(keep) > 12 {
				keep = keep[len(keep)-12:]
			}
			tail = strings.Join(keep, "\n")
		}
	}
	// Close the orphaned shell workspace so dead worker panes don't pile up in 终端.
	if w.WorkspaceID != "" {
		_ = sp.s.herdr.Call(ctx, "workspace.close", map[string]any{"workspace_id": w.WorkspaceID}, nil)
	}
	why := deathReason(tail)
	if len([]rune(why)) > 200 {
		why = string([]rune(why)[:200]) + "…"
	}
	log.Printf("worker %s: no agent in its pane %s (status=%s); why=%q", w.Name, w.PaneID, w.Status, why)
	sp.mu.Lock()
	defer sp.mu.Unlock()
	if tail == "" && w.Status == "gone" {
		sp.ingestLocked("worker", w.Thread, w.Name, fmt.Sprintf("worker %s exited (its herdr pane is gone).", w.Name), "", "", w.Name)
		sp.addEntryLocked("event", w.Thread, w.Name+" 已退出", w.Name, "info")
		sp.changed()
		return
	}
	w.Status = "failed"
	if why != "" {
		w.Note = why
	}
	sp.ingestLocked("worker", w.Thread, w.Name, fmt.Sprintf(
		"worker %s failed: %s isn't running in its pane (it never started, or exited early). Last lines on its screen:\n%s\nFix the cause (pass `--arg` flags to `collie spawn`, switch to another agent on that computer, or use `collie exec --machine %s` if no agent CLI on that computer can start) or tell the human.",
		w.Name, w.Kind, tail, firstNonEmpty(w.Machine, "hub")), "", "", w.Name)
	msg := w.Name + " 的 " + w.Kind + " 没有跑起来（或异常退出）"
	if why != "" {
		msg += "：" + why
	}
	sp.addEntryLocked("event", w.Thread, msg, w.Name, "error")
	sp.changed()
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// deathReason picks the line that says why: "Error: …" / "Error loading …" over
// a stack frame like "throw new Error(".
func deathReason(screen string) string {
	lines := strings.Split(screen, "\n")
	var loose string
	for i, l := range lines {
		t := strings.TrimSpace(l)
		low := strings.ToLower(t)
		if strings.Contains(low, "error:") || strings.HasPrefix(low, "error ") || strings.HasPrefix(low, "fatal") || strings.Contains(low, "panic:") ||
			strings.Contains(low, "command not found") || strings.Contains(low, "no such file") || strings.Contains(low, "not recognized as") {
			// Include one short continuation line (e.g. `in 'service_tier'`) if present,
			// skipping stack frames (`at ...`) and shell prompts.
			if i+1 < len(lines) {
				next := strings.TrimSpace(lines[i+1])
				nlow := strings.ToLower(next)
				if next != "" && !strings.HasPrefix(nlow, "at ") && !strings.HasPrefix(nlow, "ps ") &&
					!strings.HasPrefix(nlow, "(base)") && !strings.HasPrefix(nlow, "node.js ") &&
					!strings.HasSuffix(next, ">") && !strings.HasSuffix(next, "$") && len(next) < 80 {
					return t + " " + next
				}
			}
			return t
		}
		if loose == "" && strings.Contains(low, "error") {
			loose = t
		}
	}
	return loose
}

func (sp *Super) workerSettled(ctx context.Context, w *Worker, blocked bool) {
	// The human chose to bypass permissions in settings, so a worker's
	// "trust this folder?" (the folder Collie started it in) isn't theirs to
	// click. Anything else still goes to them.
	sp.mu.Lock()
	ask := sp.st.Settings.AskPermissions
	sp.mu.Unlock()
	if blocked && !ask && sp.answerTrust(ctx, w.PaneID, w.Cwd) {
		log.Printf("worker %s: trusted its folder %s", w.Name, w.Cwd)
		return
	}
	summary := sp.lastAssistant(ctx, w)
	sp.mu.Lock()
	defer sp.mu.Unlock()
	if blocked {
		sp.ingestLocked("worker", w.Thread, w.Name,
			fmt.Sprintf("worker %s is BLOCKED on a dialog in its terminal (the human also sees it as a card in chat). Screen:\n%s%s\nIf the answer follows from what the human asked, or is routine, answer it yourself: `collie answer %s <choice>`. Leave it to the human only when it is theirs to decide (see ROUTER.md).", w.Name, summary, sp.choicesText(ctx, w.PaneID), w.Name), "", "", w.Name)
		sp.addEntryLocked("event", w.Thread, w.Name+" 等你确认", w.Name, "blocked")
		return
	}
	if msg := sp.workerAgentError(ctx, w, summary); msg != "" {
		// Its agent stopped it (out of quota/balance, logged out, the API down):
		// the turn ended, the work did not. If it never produced any work at all,
		// close its unusable workspace and mark it failed so it doesn't linger.
		noWorkDone := w.LastReport == "" && (summary == "" || summary == "(no output captured)" || strings.Contains(summary, msg))
		wsToClose := ""
		if noWorkDone {
			w.Ended, w.Status, w.Note = true, "failed", msg
			wsToClose = w.WorkspaceID
		}
		sp.ingestLocked("worker", w.Thread, w.Name,
			fmt.Sprintf("worker %s stopped on an error from its agent, not because it was done:\n%s\nLast message before it:\n%s\nIf this is a usage/balance limit, a login or an outage, it won't get better by itself soon: hand the job to another kind of agent (or if every agent CLI on %s fails to start/authenticate, use `collie exec --machine %s` to repair the CLI or tell the human), then tell the human in one line what happened.", w.Name, msg, summary, firstNonEmpty(w.Machine, "hub"), firstNonEmpty(w.Machine, "hub")), "", "", w.Name)
		sp.addEntryLocked("event", w.Thread, w.Name+" 出错了："+msg, w.Name, "error")
		sp.changed()
		if wsToClose != "" {
			go func(ws string) {
				cctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				_ = sp.s.herdr.Call(cctx, "workspace.close", map[string]any{"workspace_id": ws}, nil)
			}(wsToClose)
		}
		return
	}
	sp.ingestLocked("worker", w.Thread, w.Name,
		fmt.Sprintf("worker %s finished a turn. Last message:\n%s", w.Name, summary), "", "", w.Name)
	sp.addEntryLocked("event", w.Thread, w.Name+" 完成了一轮", w.Name, "done")
}

// workerQuotaRe is an agent CLI saying it can't go on: a usage limit, the
// login, the API. Narrower than agentErrRe: a worker's screen is full of its
// work, and "error:" there is mostly the work's own.
var workerQuotaRe = regexp.MustCompile(`(?i)(usage limit|limit reached|hit your( \w+)? limit|reached your( \w+)? limit|quota exceeded|exceeded your( current)? quota|insufficient[_ ]balance|insufficient[_ ]quota|payment required|resource.?exhausted|daily limit|rate.?limit(ed)?\b|credit balance|out of credits|please run /login|not logged in|invalid api key|authentication[_ ]error|api error|overloaded|unexpected status \d{3}|model .* (not found|does not exist|is not supported)|try again (at|in) )`)

// workerAgentError reads the bottom of a worker's terminal after a turn:
// what its agent printed when it gave up, or "". A line that is also in its
// last message is the work talking about such things, not the agent.
func (sp *Super) workerAgentError(ctx context.Context, w *Worker, summary string) string {
	if w.PaneID == "" {
		return ""
	}
	rr, err := sp.s.herdr.Read(ctx, w.PaneID, "recent", "text", 40)
	if err != nil {
		return ""
	}
	return agentStopLine(rr.Text, summary)
}

func agentStopLine(screen, summary string) string {
	var tail []string
	for _, l := range strings.Split(screen, "\n") {
		if t := strings.TrimSpace(l); t != "" {
			tail = append(tail, t)
		}
	}
	if len(tail) > 12 {
		tail = tail[len(tail)-12:]
	}
	for _, l := range tail {
		if workerQuotaRe.MatchString(l) && !strings.Contains(summary, strings.Trim(l, "⎿⏺●•✗✘⚠■│ ")) {
			return clip(strings.Trim(l, "⎿⏺●•✗✘⚠■│ "), 200)
		}
	}
	return ""
}

func (sp *Super) lastAssistant(ctx context.Context, w *Worker) string {
	if pane, machine := split(w.PaneID); machine != "" {
		// Its transcript lives on that computer: ask its node.
		if c, err := sp.s.herdr.Client(machine); err == nil {
			req, _ := http.NewRequestWithContext(ctx, "GET", "http://node/api/panes/"+url.PathEscape(pane)+"/last", nil)
			if resp, err := c.Do(req); err == nil {
				var out struct {
					Text string `json:"text"`
				}
				json.NewDecoder(resp.Body).Decode(&out)
				resp.Body.Close()
				if out.Text != "" {
					return clip(out.Text, 1200)
				}
			}
		}
	} else if w.PaneID != "" {
		var info struct {
			Agent agentDetail `json:"agent"`
		}
		if sp.s.herdr.Call(ctx, "agent.get", map[string]any{"target": w.Name}, &info) == nil {
			if tr := sp.s.transcriptFor(w.Name, w.PaneID, info.Agent, sp.transcripts); tr != nil {
				tr.update()
				msgs := tr.view()
				for i := len(msgs) - 1; i >= 0; i-- {
					if msgs[i].Kind == "assistant" {
						return clip(msgs[i].Text, 1200)
					}
				}
			}
		}
		if res, err := sp.s.herdr.Read(ctx, w.PaneID, "detection", "text", 0); err == nil {
			return tailLines(res.Text, 14)
		}
	}
	return "(no output captured)"
}

// ---------------------------------------------------------------- router

func (sp *Super) routerDir() string { return filepath.Join(sp.dir, "router") }

func (sp *Super) ensureRouter(ctx context.Context) {
	sp.mu.Lock()
	if sp.routerLaunching || time.Since(sp.routerLaunchAt) < 45*time.Second {
		sp.mu.Unlock()
		return
	}
	sp.routerLaunching, sp.routerLaunchAt = true, time.Now()
	st := sp.st.Settings
	sp.mu.Unlock()

	go func() {
		defer func() { sp.mu.Lock(); sp.routerLaunching = false; sp.mu.Unlock() }()
		targetMachine, kind, resolveErr := sp.resolveRouterTarget(st)
		if resolveErr != nil {
			sp.mu.Lock()
			sp.recordRouterLaunchErrorLocked(resolveErr)
			sp.mu.Unlock()
			return
		}
		machineID := targetMachine.ID
		sp.mu.Lock()
		model, effort := sp.st.Settings.RouterModel, sp.st.Settings.RouterEffort
		if kinds[kind] != kinds[sp.st.Settings.RouterKind] {
			model, effort = "", ""
		}
		args := append(append([]string{}, sp.st.Settings.RouterArgs...), modelArgs(kind, model, effort)...)
		args = withBypass(args, kind, sp.st.Settings.AskPermissions)
		sp.setRouterRun([2]string{model, effort})
		sp.mu.Unlock()

		sp.closeStaleRouterWorkspaces(context.Background())
		if err := sp.writeRouterFilesFor(targetMachine); err != nil {
			log.Printf("router files: %v", err)
		}
		sp.routerReadsFresh()
		lctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		rdir := sp.routerDir()
		if machineID != "" {
			var syncErr error
			if rdir, syncErr = sp.pushRouterToNode(lctx, machineID); syncErr != nil {
				sp.mu.Lock()
				sp.recordRouterLaunchErrorLocked(syncErr)
				sp.mu.Unlock()
				return
			}
		}
		_, _, err := sp.s.startAgent(lctx, machineID, kinds[kind], routerName, rdir, routerLabel, args)
		sp.mu.Lock()
		defer sp.mu.Unlock()
		var he *HerdrError
		if err != nil && !(errors.As(err, &he) && he.Code == "agent_not_ready") {
			sp.recordRouterLaunchErrorLocked(err)
			return
		}
		sp.routerFresh = true
		where := kind
		if !targetMachine.Local && targetMachine.Name != "" {
			where = kind + " @ " + targetMachine.Name
		}
		sp.addEntryLocked("event", mainThread, "Collie 已唤醒（"+where+"）", routerName, "info")
	}()
}

func (sp *Super) recordRouterLaunchErrorLocked(err error) {
	msg := "Collie 启动失败：" + err.Error()
	if strings.Contains(err.Error(), "没装") {
		msg += "。装上它，或在页面顶部 / 自动化 → 设置 → Collie 自己 里换一个电脑或 agent"
	}
	for i := len(sp.st.Entries) - 1; i >= 0 && i >= len(sp.st.Entries)-6; i-- {
		e := sp.st.Entries[i]
		if e.Role == "user" || e.Role == "collie" {
			break
		}
		if e.Text == msg && time.Since(e.At) < 10*time.Minute {
			return // avoid flooding chat every 45s while waiting on setup/offline machine
		}
	}
	sp.addEntryLocked("event", mainThread, msg, routerName, "error")
}

func (sp *Super) RestartRouter(ctx context.Context) error {
	if live, ok := sp.liveAgents(ctx); ok {
		if a, ok := live[routerName]; ok {
			var p Pane
			if err := sp.s.herdr.Call(ctx, "pane.get", map[string]any{"pane_id": a.Pane}, &struct {
				Pane *Pane `json:"pane"`
			}{&p}); err == nil && p.WorkspaceID != "" {
				sp.s.herdr.Call(ctx, "workspace.close", map[string]any{"workspace_id": p.WorkspaceID}, nil)
			}
		}
	}
	sp.mu.Lock()
	sp.routerLaunchAt = time.Time{}
	sp.mu.Unlock()
	sp.ensureRouter(ctx)
	return nil
}

// routerReadFile keeps a copy of the ROUTER.md the running Collie read.
const routerReadFile = ".router-read.md"

// routerDocChanged: ROUTER.md was just written (a new build, new settings).
// The running Collie read it when its session began; if it now says
// something else, have it read it again.
func (sp *Super) routerDocChanged(dir string, doc []byte) {
	read, err := os.ReadFile(filepath.Join(dir, routerReadFile))
	if err != nil || bytes.Equal(read, doc) {
		return // no session has read it yet, or nothing changed
	}
	os.WriteFile(filepath.Join(dir, routerReadFile), doc, 0o600)
	sp.mu.Lock()
	defer sp.mu.Unlock()
	if t := sp.rereadTrig; t != nil && t.Status == "queued" {
		return // already asked
	}
	sp.rereadTrig = sp.ingestLocked("system", mainThread, "collie", "ROUTER.md changed (a new Collie build or new settings). Re-read it now and work by it from here on. Nothing to tell the human.", "", "", "")
}

// routerReadsFresh: a new session is starting and reads ROUTER.md as it is.
func (sp *Super) routerReadsFresh() {
	dir := sp.routerDir()
	if b, err := os.ReadFile(filepath.Join(dir, "ROUTER.md")); err == nil {
		os.WriteFile(filepath.Join(dir, routerReadFile), b, 0o600)
	}
	sp.mu.Lock()
	if t := sp.rereadTrig; t != nil && t.Status == "queued" {
		t.Status = "ignored" // it reads them anyway
	}
	sp.rereadTrig = nil
	sp.mu.Unlock()
}

func (sp *Super) writeRouterFiles() error {
	sp.mu.Lock()
	st := sp.st.Settings
	sp.mu.Unlock()
	m, _, _ := sp.resolveRouterTarget(st)
	return sp.writeRouterFilesFor(m)
}

func (sp *Super) writeRouterFilesFor(m *Machine) error {
	dir := sp.routerDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	sp.mu.Lock()
	words := sp.st.Settings.ReplyChars
	wkind := sp.st.Settings.WorkerKind
	wmachine := sp.st.Settings.WorkerMachine
	wcwdRaw := sp.st.Settings.WorkerCwd
	sp.mu.Unlock()
	wcwd := sp.s.tilde(wcwdRaw)
	if wmachine != "" {
		if wm, err := sp.s.herdr.machine(wmachine); err == nil && wm.Home != "" {
			wcwd = tildeIn(wm.Home, wcwdRaw)
		}
	}
	rbin := sp.routerBinOn(m)
	rdirOn := sp.routerDirOn(m)
	layout := "   " + strings.ReplaceAll(memoryLayout, "\n", "\n   ")
	doc := strings.NewReplacer("{{LAYOUT}}", layout, "{{BIN}}", shellBin(rbin), "{{WORDS}}", fmt.Sprint(words), "{{WKIND}}", wkind, "{{WCWD}}", wcwd).Replace(routerDoc)
	for _, name := range []string{"ROUTER.md", "CLAUDE.md", "AGENTS.md", "GEMINI.md"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(doc), 0o600); err != nil {
			return err
		}
	}
	sp.routerDocChanged(dir, []byte(doc))
	// Claude Code asks before every shell command; the router's whole job is
	// running the collie CLI and keeping memory/, so allow exactly that.
	perms, _ := json.MarshalIndent(map[string]any{"permissions": map[string]any{
		"allow": collieAllow(rbin, append(memoryRules(rdirOn),
			// Read-only peeks at a worker's terminal.
			"Bash(herdr agent read:*)", "Bash(herdr agent list:*)", "Bash(herdr agent get:*)", "Bash(herdr pane read:*)")...),
	}}, "", "  ")
	os.MkdirAll(filepath.Join(dir, ".claude"), 0o700)
	if err := os.WriteFile(filepath.Join(dir, ".claude", "settings.json"), perms, 0o600); err != nil {
		return err
	}
	sp.ensureMemory()
	return nil
}

// ---------------------------------------------------------------- workers

var workerNameRe = regexp.MustCompile(`[^a-z0-9_-]+`)

// Spawn starts a worker session asynchronously (start() returns at once; the
// outcome arrives later as a trigger — the async ReAct pattern).
// model and effort are launch choices for this worker; "" falls back to the
// default worker settings when kind is the default kind, else the agent's own.
// resumeFrom is what `spawn --resume` carries over from a stopped worker:
// where it ran and the conversation to open again.
func (sp *Super) resumeFrom(name string) (*Worker, error) {
	sp.mu.Lock()
	defer sp.mu.Unlock()
	w := sp.st.Workers[name]
	switch {
	case w == nil:
		return nil, fmt.Errorf("no worker named %s", name)
	case !w.Ended:
		return nil, fmt.Errorf("%s is still running: `send` it instead", name)
	case w.Session == "":
		return nil, fmt.Errorf("%s left no conversation to resume; spawn a fresh worker", name)
	}
	c := *w
	return &c, nil
}

func (sp *Super) Spawn(kind, cwd, task, thread, name, by, machine, model, effort string, extraArgs []string, subscribe bool, resume string) (*Worker, <-chan error, error) {
	if machine == "" {
		if lm := sp.s.herdr.Machines()[0]; len(lm.Agents) == 0 && !lm.Online {
			// Local hub has neither herdr nor agents: fall back to the first online node.
			for _, rm := range sp.s.herdr.Machines()[1:] {
				if rm.Online && (rm.Agents == nil || len(rm.Agents) > 0) {
					machine = rm.ID
					break
				}
			}
		}
	}
	m, err := sp.s.herdr.machine(machine)
	if err != nil {
		return nil, nil, fmt.Errorf("machine %q is not connected", machine)
	}
	sp.mu.Lock()
	if kind == "" {
		kind = sp.st.Settings.WorkerKind
	}
	if _, ok := kinds[kind]; !ok {
		sp.mu.Unlock()
		return nil, nil, fmt.Errorf("unknown kind %q (claude, codex, antigravity)", kind)
	}
	// Say so now, while the router can still pick another computer or kind.
	have := m.Agents
	if m.Local {
		have = localAgents(sp.s.home, false)
	}
	if have != nil && !slices.Contains(have, kinds[kind]) {
		sp.mu.Unlock()
		return nil, nil, fmt.Errorf("%s has no %s installed (it has: %s); pick another computer or kind", m.Name, kind, strings.Join(append(have, "none")[:max(len(have), 1)], ", "))
	}
	if cwd == "" && (m.ID == sp.st.Settings.WorkerMachine || (m.Local && sp.st.Settings.WorkerMachine == "")) {
		cwd = sp.st.Settings.WorkerCwd
	}
	if thread == "" {
		thread = mainThread
	}
	if name == "" {
		base := kind
		if base == "antigravity" {
			base = "agy"
		}
		for i := 1; ; i++ {
			n := fmt.Sprintf("%s-%d", base, i)
			if w := sp.st.Workers[n]; w == nil || w.Ended {
				name = n
				break
			}
		}
	}
	name = strings.Trim(workerNameRe.ReplaceAllString(strings.ToLower(name), "-"), "-")
	if !nameRe.MatchString(name) || name == routerName {
		sp.mu.Unlock()
		return nil, nil, fmt.Errorf("invalid worker name %q", name)
	}
	if w := sp.st.Workers[name]; w != nil && !w.Ended {
		sp.mu.Unlock()
		return nil, nil, fmt.Errorf("worker %s already exists", name)
	}
	dir := expandIn(m.Home, cwd)
	if m.Local && !isDir(dir) {
		sp.mu.Unlock()
		return nil, nil, fmt.Errorf("directory not found: %s", dir)
	}
	w := &Worker{Name: name, Kind: kind, Model: model, Effort: effort, Machine: m.ID, Cwd: dir, Task: task, Thread: thread, CreatedBy: by, CreatedAt: time.Now(), Status: "starting", Session: resume}
	sp.st.Workers[name] = w
	if subscribe {
		th := sp.threadLocked(thread)
		if !contains(th.Subscribers, name) {
			th.Subscribers = append(th.Subscribers, name)
		}
	}
	where := ""
	if !m.Local {
		where = " @ " + m.Name
	}
	verb := "派出"
	if resume != "" {
		verb = "续上"
	}
	sp.addEntryLocked("event", thread, fmt.Sprintf("%s %s（%s%s）：%s", verb, name, kind, where, clip(firstLine(task), 120)), name, "spawn")
	sp.mu.Unlock()

	// The default model applies to the default kind of worker.
	sp.mu.Lock()
	if kinds[kind] == kinds[sp.st.Settings.WorkerKind] {
		if model == "" {
			model = sp.st.Settings.WorkerModel
		}
		if effort == "" {
			effort = sp.st.Settings.WorkerEffort
		}
	}
	w.Run = &[2]string{model, effort}
	ask := sp.st.Settings.AskPermissions
	sp.mu.Unlock()
	wargs := append(withBypass(modelArgs(kind, model, effort), kind, ask), extraArgs...)

	// started answers whoever is still waiting on the spawn (superSpawn waits
	// a few seconds): a failure it hears it can say at once, as the spawn's
	// own error, instead of as an event after it already said "started".
	started := make(chan error)
	tell := func(err error) bool {
		select {
		case started <- err:
			return true
		default:
			return false
		}
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		bin := sp.bin
		if !m.Local && m.Bin != "" {
			bin = m.Bin
		} else if !m.Local {
			bin = "collie"
		}
		// codex's resume is a subcommand: it goes first, the flags after it.
		args := append(resumeArgs(kinds[kind], resume), wargs...)
		if kinds[kind] == "claude" {
			// Reporting back is part of the job; don't make it a permission prompt.
			args = append(args, "--allowedTools", strings.Join(collieAllow(bin), ","))
		}
		pane, ws, err := sp.s.startAgent(ctx, m.ID, kinds[kind], name, dir, name, args)
		if pane != "" {
			sp.s.herdr.RememberRun(pane, model, effort)
		}
		sp.mu.Lock()
		w.PaneID, w.WorkspaceID = pane, ws
		var he *HerdrError
		blocked := err != nil && errors.As(err, &he) && he.Code == "agent_not_ready"
		if err != nil && !blocked {
			w.Status, w.Ended, w.Note = "failed", true, err.Error()
			sp.addEntryLocked("event", thread, name+" 启动失败："+err.Error(), name, "error")
			sp.mu.Unlock()
			if !tell(err) {
				sp.Ingest("worker", thread, name, fmt.Sprintf("worker %s failed to start: %v", name, err), "", "", name)
			}
			return
		}
		w.Status = "idle"
		if blocked {
			w.Status = "blocked"
		}
		sp.changed()
		sp.mu.Unlock()
		tell(nil)
		// The task brief is delivered like any other trigger, so it waits
		// politely if the worker is stuck on a startup dialog.
		sp.Ingest("system", thread, routerName, workerBrief(bin, w), "", name, name)
	}()
	return w, started, nil
}

// choicesText lists a dialog's choices for the router, numbered as `collie
// answer` takes them.
func (sp *Super) choicesText(ctx context.Context, pane string) string {
	rr, err := sp.s.herdr.Read(ctx, pane, "detection", "text", 0)
	if err != nil || !screenAsks(rr.Text) {
		return ""
	}
	var b strings.Builder
	b.WriteString("\nChoices:")
	for i, c := range parseApproval(rr.Text).Choices {
		fmt.Fprintf(&b, "\n  %d. %s", i+1, c.Label)
	}
	return b.String()
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

func workerBrief(bin string, w *Worker) string {
	return fmt.Sprintf(`You are worker %q, managed by Collie (thread %s). Your task:

%s

Rules:
- Work autonomously in this directory; you never talk to humans directly.
- When you finish, or need a decision only a human can make, run:
    %s report "<≤100 words: outcome, what changed, where; or the exact question>"
- Follow-ups for your thread arrive as messages starting with [collie].`, w.Name, w.Thread, strings.TrimSpace(w.Task), shellBin(bin))
}

func (sp *Super) Report(name, text string) error {
	sp.mu.Lock()
	defer sp.mu.Unlock()
	w := sp.st.Workers[name]
	if w == nil {
		return fmt.Errorf("unknown worker %s", name)
	}
	delete(sp.workerAskedAt, name)
	w.LastReport, w.ReportAt = text, time.Now()
	sp.ingestLocked("worker", w.Thread, name, fmt.Sprintf("report from %s:\n%s", name, text), "", "", name)
	sp.addEntryLocked("event", w.Thread, name+" 回报："+clip(text, 160), name, "done")
	return nil
}

func (sp *Super) workerByPane(pane string) string {
	sp.mu.Lock()
	defer sp.mu.Unlock()
	for _, w := range sp.st.Workers {
		if w.PaneID == pane && !w.Ended {
			return w.Name
		}
	}
	return ""
}

// ---------------------------------------------------------------- watchdog

// watchdog is the external control loop: it restarts the router when work is
// waiting and flags workers that look stuck (screen unchanged while working).
func (sp *Super) watchdog(ctx context.Context, live map[string]liveAgent, routerAlive bool) {
	sp.mu.Lock()
	stall := time.Duration(sp.st.Settings.StallMinutes) * time.Minute
	var watch []*Worker
	for _, w := range sp.st.Workers {
		if !w.Ended && w.Status == "working" {
			watch = append(watch, w)
		}
	}
	sp.mu.Unlock()
	for _, w := range watch {
		a, ok := live[w.Name]
		if !ok {
			continue
		}
		res, err := sp.s.herdr.Read(ctx, a.Pane, "detection", "text", 0)
		if err != nil {
			continue
		}
		h := fmt.Sprintf("%x", sha1.Sum([]byte(res.Text)))
		m := sp.lastScreen[w.Name]
		if m.hash != h {
			sp.lastScreen[w.Name] = screenMark{hash: h, since: time.Now()}
			continue
		}
		if !m.flag && stall > 0 && time.Since(m.since) > stall {
			m.flag = true
			sp.lastScreen[w.Name] = m
			sp.Ingest("system", w.Thread, "watchdog",
				fmt.Sprintf("watchdog: worker %s has shown no visible progress for %d min while 'working'. Inspect with `collie show %s`; send guidance, stop it, or tell the human.", w.Name, int(stall.Minutes()), w.Name), "", "", w.Name)
		}
	}
}

// ---------------------------------------------------------------- outbox

func (sp *Super) queueNotifyLocked(role, text, tone string, re *Quote) {
	if sp.st.Settings.NotifyWebhook == "" && !sp.st.Settings.NotifyLark {
		return
	}
	if sp.st.Settings.NotifyLevel == "quiet" && role == "collie" {
		return
	}
	sp.notifyBuf = append(sp.notifyBuf, notice{tone: tone, text: text, re: re})
}

// A notice is one thing to tell you: what Collie said (and what about), or
// what needs you.
type notice struct {
	tone, text string
	re         *Quote
}

// quoteLine is a Quote as one line: "你：首页加一个暗色模式…".
func (q *Quote) line() string {
	t := strings.Join(strings.Fields(q.Text), " ")
	return q.Who + "：" + clip(t, 60)
}

// quoteLocked finds what a reply's --re points at: an event Collie was given
// (#t942), or an entry. Unknown ids give nil: the reply goes out anyway.
func (sp *Super) quoteLocked(id string) *Quote {
	id = strings.TrimPrefix(strings.TrimSpace(id), "#")
	if id == "" {
		return nil
	}
	entry := func(eid string) *Quote {
		for i := len(sp.st.Entries) - 1; i >= 0; i-- {
			if e := sp.st.Entries[i]; e.ID == eid && e.Role == "user" {
				return &Quote{Entry: e.ID, Who: "你", Text: humanText(e.Text)}
			}
		}
		return nil
	}
	if q := entry(id); q != nil {
		return q
	}
	t := sp.st.trigger(id)
	if t == nil {
		return nil
	}
	switch t.Source {
	case "chat":
		if q := entry(t.Ref); q != nil {
			return q
		}
		return &Quote{Who: "你", Text: humanText(t.Text)}
	case "timer":
		return &Quote{Who: "定时", Text: t.Text}
	}
	name := t.Ref
	if name == "" {
		name = t.From
	}
	if w := sp.st.Workers[name]; w != nil {
		return &Quote{Worker: w.Name, Who: w.Name, Text: w.Task}
	}
	return nil
}

// collieQuoteLocked is a message of Collie's you answer, as a Quote.
func (sp *Super) collieQuoteLocked(id string) *Quote {
	if id == "" {
		return nil
	}
	for i := len(sp.st.Entries) - 1; i >= 0; i-- {
		if e := sp.st.Entries[i]; e.ID == id && e.Role == "collie" {
			return &Quote{Entry: e.ID, Who: "Collie", Text: clip(e.Text, 600)}
		}
	}
	return nil
}

// humanText is your message as you wrote it: without the attachment list and
// the notes the hub adds for Collie.
func humanText(t string) string {
	if i := strings.Index(t, "\n\n[The human picked"); i >= 0 {
		t = t[:i]
	}
	if i := strings.LastIndex(t, "附件：\n"); i >= 0 {
		t = strings.TrimSpace(t[:i]) + " 📎"
	}
	return strings.TrimSpace(t)
}

func (n notice) label() string {
	switch n.tone {
	case "blocked":
		return "Collie · 需要你"
	case "error":
		return "Collie · 出错了"
	}
	return "Collie"
}

// noticesText is the plain form (webhooks, and the card's fallback).
func noticesText(ns []notice) string {
	var parts []string
	for _, n := range ns {
		p := n.label() + "：" + clip(n.text, 400)
		if n.re != nil {
			p = "↩ " + n.re.line() + "\n" + p
		}
		parts = append(parts, p)
	}
	return strings.Join(parts, "\n\n")
}

// Seen notes that a page of Collie is open in front of you (the page says so
// every 30 seconds while it is visible).
func (sp *Super) Seen(url string) {
	sp.mu.Lock()
	sp.seenAt = time.Now()
	if url != "" {
		sp.seenURL = url
	}
	sp.mu.Unlock()
}

// sendNotifications paces outgoing notifications: messages are coalesced and
// sent at most every 20 seconds, and not at all while you are looking at
// Collie (you see them there).
func (sp *Super) sendNotifications() {
	sp.mu.Lock()
	if len(sp.notifyBuf) == 0 || time.Since(sp.notifyAt) < 20*time.Second {
		sp.mu.Unlock()
		return
	}
	notices := sp.notifyBuf
	text := noticesText(notices)
	url, toLark := sp.st.Settings.NotifyWebhook, sp.st.Settings.NotifyLark
	looking := time.Since(sp.seenAt) < 75*time.Second
	link := sp.seenURL
	sp.notifyBuf, sp.notifyAt = nil, time.Now()
	sp.mu.Unlock()
	if looking {
		return
	}
	if toLark {
		if link != "" {
			link += "/#/collie"
		}
		if err := larkSend(notices, link); err != nil {
			log.Printf("notify lark: %v", err)
		}
	}
	if url == "" {
		return
	}
	body, _ := json.Marshal(map[string]any{
		"msg_type": "text", "content": map[string]string{"text": text}, // Feishu/Lark bot
		"text": text, // Slack-style
	})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if resp, err := http.DefaultClient.Do(req); err != nil {
		log.Printf("notify: %v", err)
	} else {
		resp.Body.Close()
	}
}

// ---------------------------------------------------------------- recall

// Show renders any object by id with links to related ids (chain of recall).
func (sp *Super) Show(id string) (string, bool) {
	sp.mu.Lock()
	defer sp.mu.Unlock()
	var b strings.Builder
	if t := sp.st.trigger(id); t != nil {
		fmt.Fprintf(&b, "trigger %s\nsource: %s  thread: %s  from: %s  at: %s  status: %s  action: %s\n", t.ID, t.Source, t.Thread, t.From, t.At.Format(time.RFC3339), t.Status, t.Action)
		if t.Ref != "" {
			fmt.Fprintf(&b, "ref: %s\n", t.Ref)
		}
		fmt.Fprintf(&b, "\n%s\n", t.Text)
		return b.String(), true
	}
	if th := sp.st.Threads[id]; th != nil {
		fmt.Fprintf(&b, "thread %s\nsubscribers: %s\nrecent triggers:\n", th.ID, strings.Join(th.Subscribers, ", "))
		ids := th.Triggers
		if len(ids) > 15 {
			ids = ids[len(ids)-15:]
		}
		for _, tid := range ids {
			if t := sp.st.trigger(tid); t != nil {
				fmt.Fprintf(&b, "  #%s %s %s: %s\n", t.ID, t.At.Format("01-02 15:04"), t.Source, clip(firstLine(t.Text), 90))
			}
		}
		return b.String(), true
	}
	if w := sp.st.Workers[id]; w != nil {
		fmt.Fprintf(&b, "worker %s (%s)\nstatus: %s  thread: %s  pane: %s  cwd: %s\ncreated: %s by %s\n", w.Name, w.Kind, w.Status, w.Thread, w.PaneID, w.Cwd, w.CreatedAt.Format("01-02 15:04"), w.CreatedBy)
		fmt.Fprintf(&b, "\ntask:\n%s\n", w.Task)
		if w.LastReport != "" {
			fmt.Fprintf(&b, "\nlast report (%s):\n%s\n", w.ReportAt.Format("01-02 15:04"), w.LastReport)
		}
		if w.Note != "" {
			fmt.Fprintf(&b, "\nnote: %s\n", w.Note)
		}
		fmt.Fprintf(&b, "\nterminal: herdr agent read %s --source recent-unwrapped --lines 80\n", w.Name)
		return b.String(), true
	}
	return "", false
}

func (sp *Super) List() string {
	sp.mu.Lock()
	defer sp.mu.Unlock()
	var b strings.Builder
	b.WriteString("machines (pass the name to `collie spawn -machine`):\n")
	for _, m := range sp.s.herdr.Machines() {
		state := "online"
		have := m.Agents
		if m.Local {
			have = localAgents(sp.s.home, false)
			if !m.Online && len(have) == 0 {
				state = "relay-only"
			}
		} else if !m.Online {
			state = "offline"
		}
		id := m.ID
		if m.Local {
			id = "hub"
		}
		ag := "none"
		if len(have) > 0 {
			ag = strings.Join(have, ",")
		}
		fmt.Fprintf(&b, "  %-14s %-11s %s  agents=%s  home=%s\n", id, state, m.Name, ag, m.Home)
	}
	b.WriteString("workers:\n")
	names := make([]string, 0, len(sp.st.Workers))
	for n := range sp.st.Workers {
		names = append(names, n)
	}
	sort.Strings(names)
	any := false
	for _, n := range names {
		w := sp.st.Workers[n]
		if w.Ended && time.Since(w.CreatedAt) > 24*time.Hour {
			continue
		}
		any = true
		fmt.Fprintf(&b, "  %-14s %-8s %-8s thread=%s  %s\n", w.Name, w.Kind, w.Status, w.Thread, clip(firstLine(w.Task), 70))
	}
	if !any {
		b.WriteString("  (none)\n")
	}
	b.WriteString("threads:\n")
	ths := make([]*Thread, 0, len(sp.st.Threads))
	for _, th := range sp.st.Threads {
		ths = append(ths, th)
	}
	sort.Slice(ths, func(i, j int) bool { return ths[i].LastAt.After(ths[j].LastAt) })
	for i, th := range ths {
		if i >= 12 {
			break
		}
		fmt.Fprintf(&b, "  %-28s last=%s subscribers=%s\n", th.ID, th.LastAt.Format("01-02 15:04"), strings.Join(th.Subscribers, ","))
	}
	b.WriteString("timers:\n")
	for _, t := range sp.st.Timers {
		if t.Enabled {
			fmt.Fprintf(&b, "  %s %q next=%s → %s\n", t.ID, t.Spec, t.NextRun.Format("01-02 15:04"), clip(t.Text, 60))
		}
	}
	return b.String()
}

// trustOwnDir answers the "do you trust this folder?" dialog for the router's
// own working directory. Collie created that directory and wrote every file in
// it, so asking the human adds friction without adding safety. Any other
// dialog (and any other directory) is left for the human.
func (sp *Super) trustOwnDir(ctx context.Context, pane string) {
	dir := sp.routerDir()
	if _, m := split(pane); m != "" {
		if mc, err := sp.s.herdr.machine(m); err == nil {
			dir = sp.routerDirOn(mc)
		}
	}
	if sp.answerTrust(ctx, pane, dir) {
		log.Printf("router: trusted its own directory %s", dir)
	}
}

// answerTrust picks "Yes, I trust this folder" when pane shows a folder-trust
// dialog for dir, the folder Collie started that agent in. It reports whether
// it answered. Nothing else is ever answered this way.
func (sp *Super) answerTrust(ctx context.Context, pane, dir string) bool {
	sp.mu.Lock()
	if sp.lastTrust == nil {
		sp.lastTrust = map[string]time.Time{}
	}
	if time.Since(sp.lastTrust[pane]) < 5*time.Second {
		sp.mu.Unlock()
		return false
	}
	sp.lastTrust[pane] = time.Now()
	sp.mu.Unlock()

	tld := sp.s.tilde(dir)
	if _, m := split(pane); m != "" {
		if mc, err := sp.s.herdr.machine(m); err == nil && mc.Home != "" {
			tld = tildeIn(mc.Home, dir)
		}
	}
	rr, err := sp.s.herdr.Read(ctx, pane, "visible", "text", 0)
	if err != nil || !trustDialogFor(rr.Text, dir, tld) {
		return false
	}
	for _, c := range parseApproval(rr.Text).Choices {
		l := strings.ToLower(c.Label)
		if strings.HasPrefix(l, "yes") && strings.Contains(l, "trust") {
			return sp.choose(ctx, pane, c) == nil
		}
	}
	return false
}

// choose answers a dialog in pane with one of its choices: its digit for a
// numbered menu, or the keys that move the cursor there and confirm.
func (sp *Super) choose(ctx context.Context, pane string, c Choice) error {
	if c.Text != "" {
		return sp.s.herdr.Call(ctx, "pane.send_text", map[string]any{"pane_id": pane, "text": c.Text}, nil)
	}
	keys := c.Keys
	if len(keys) == 0 {
		keys = []string{"enter"}
	}
	return sp.s.herdr.Call(ctx, "pane.send_keys", map[string]any{"pane_id": pane, "keys": keys}, nil)
}

// pickChoice finds the choice the router named: its number as shown ("3"),
// its position, or words of its label.
func pickChoice(a Approval, want string) (Choice, bool) {
	want = strings.TrimSpace(want)
	for _, c := range a.Choices {
		if c.Text != "" && c.Text == want {
			return c, true
		}
	}
	if n, err := strconv.Atoi(want); err == nil && n >= 1 && n <= len(a.Choices) {
		return a.Choices[n-1], true
	}
	var hit []Choice
	for _, c := range a.Choices {
		if want != "" && strings.Contains(strings.ToLower(c.Label), strings.ToLower(want)) {
			hit = append(hit, c)
		}
	}
	if len(hit) == 1 {
		return hit[0], true
	}
	return Choice{}, false
}

// trustDialogFor: the screen asks whether to trust a folder, and names dir
// (as given, with ~, or by its last part: the screen may show the path a
// symlink resolves to).
func trustDialogFor(screen, dir, tilde string) bool {
	low := strings.ToLower(screen)
	if !strings.Contains(low, "trust") || dir == "" {
		return false
	}
	if strings.Contains(screen, dir) || (tilde != "" && strings.Contains(screen, tilde)) {
		return true
	}
	if isWindowsPath(dir) && (strings.Contains(low, strings.ToLower(dir)) || (tilde != "" && strings.Contains(low, strings.ToLower(tilde)))) {
		return true
	}
	base := baseOfPath(dir)
	if base == "" {
		return false
	}
	return regexp.MustCompile(`(?m)[\\/]` + regexp.QuoteMeta(base) + `[\\/]?\s*$`).MatchString(screen)
}

// closeStaleRouterWorkspaces removes router workspaces whose agent has exited,
// so a crashed router does not leave an orphan shell behind.
func (sp *Super) closeStaleRouterWorkspaces(ctx context.Context) {
	wss, err := sp.s.herdr.Workspaces(ctx)
	if err != nil {
		return
	}
	for _, ws := range wss {
		if ws.Label == routerLabel {
			sp.s.herdr.Call(ctx, "workspace.close", map[string]any{"workspace_id": ws.ID}, nil)
		}
	}
}

// agentErrRe matches what an agent CLI prints when it can't run (the API
// refused, the login expired, the quota ran out), not Collie's own words about
// a task: "the backup failed twice" and "its error output" are work, not errors.
var agentErrRe = regexp.MustCompile(`(?i)(api error|please run /login|invalid api key|quota exceeded|daily limit|rate.?limit(ed)?\b|overloaded|unauthori[sz]ed|credit balance|unexpected status \d{3}|^[\W]*(⚠|■|error\b|error:))`)

// routerSettled runs once after the router finishes a turn that we prompted.
// If it went quiet without a `collie reply` and its screen shows an error
// (bad credentials, region block, quota…), surface that in the chat instead of
// leaving the human staring at silence.
func (sp *Super) routerSettled(ctx context.Context, pane string) {
	sp.mu.Lock()
	asked := sp.routerAskedAt
	if asked.IsZero() || time.Since(asked) < 4*time.Second {
		sp.mu.Unlock()
		return
	}
	sp.routerAskedAt = time.Time{}
	replied := false
	for i := len(sp.st.Entries) - 1; i >= 0; i-- {
		e := sp.st.Entries[i]
		if e.At.Before(asked) {
			break
		}
		if e.Role == "collie" {
			sp.routerRetries = 0
			replied = true
			break
		}
	}
	sp.mu.Unlock()
	if _, m := split(pane); m != "" {
		_, _ = sp.pullRouterFromNode(ctx, m, "", "", "", 0)
	}
	if replied {
		return
	}

	rr, err := sp.s.herdr.Read(ctx, pane, "recent", "text", 60)
	if err != nil {
		return
	}
	lines := strings.Split(rr.Text, "\n")
	// Only look at what the agent printed after our prompt, never at the event text itself.
	start := 0
	for i, l := range lines {
		if strings.Contains(l, "collie reply") || strings.Contains(l, "yourself.") || strings.Contains(l, routerRetryMark) {
			start = i + 1
		}
	}
	for i := start; i < len(lines); i++ {
		l := strings.TrimSpace(lines[i])
		if l == "" || !agentErrRe.MatchString(l) {
			continue
		}
		// Messages wrap in the terminal: keep following lines of the same block.
		msg := l
		for j := i + 1; j < len(lines) && j <= i+3; j++ {
			next := strings.TrimSpace(lines[j])
			if next == "" || strings.HasPrefix(next, "─") || strings.HasPrefix(next, "✻") || strings.HasPrefix(next, "Error ID") {
				break
			}
			msg += " " + next
		}
		if r := []rune(msg); len(r) > 240 {
			msg = string(r[:240]) + "…"
		}
		sp.mu.Lock()
		// Most of these pass (a region check, a busy API, a dropped
		// connection): try again before calling it an error.
		if n := sp.routerRetries; n < len(routerRetryWait) {
			sp.routerRetries++
			wait := routerRetryWait[n]
			sp.addEntryLocked("event", mainThread, fmt.Sprintf("Collie 遇到 API 错误（%s），%s后自动重试", clip(msg, 80), waitText(wait)), "", "info")
			sp.mu.Unlock()
			go sp.retryRouter(wait, msg)
			return
		}
		sp.routerRetries = 0
		text := "Collie 出错了：" + msg + "（自动重试了 " + fmt.Sprint(len(routerRetryWait)) + " 次都没好；可以在终端里让它继续，或在 自动化 → 设置 里给 Collie 换一个 agent）"
		for i := len(sp.st.Entries) - 1; i >= 0 && i >= len(sp.st.Entries)-6; i-- {
			if e := sp.st.Entries[i]; e.Text == text && time.Since(e.At) < 10*time.Minute {
				sp.mu.Unlock()
				return // same failure again; one notice is enough
			}
		}
		sp.addEntryLocked("event", mainThread, text, routerName, "error")
		sp.mu.Unlock()
		return
	}
	sp.mu.Lock()
	sp.routerRetries = 0 // a quiet turn, no error: it is working again
	sp.mu.Unlock()
}

// routerRetryWait: how long to wait before each retry of a turn that ended
// on an API error.
var routerRetryWait = []time.Duration{20 * time.Second, time.Minute, 3 * time.Minute}

// routerRetryMark starts the retry prompt; the error scan reads from there.
const routerRetryMark = "[collie] Your last turn stopped"

func waitText(d time.Duration) string {
	if d < time.Minute {
		return fmt.Sprintf("%d 秒", int(d.Seconds()))
	}
	return fmt.Sprintf("%d 分钟", int(d.Minutes()))
}

// retryRouter nudges Collie to carry on after an API error, unless something
// else has got it going meanwhile (your next message, a worker's event).
func (sp *Super) retryRouter(wait time.Duration, msg string) {
	time.Sleep(wait)
	sp.mu.Lock()
	busy := !sp.routerAskedAt.IsZero() || sp.routerLaunching
	sp.mu.Unlock()
	if busy {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := sp.s.herdr.Prompt(ctx, routerName, routerRetryMark+" on an error from your model's API ("+msg+"). It may have passed: carry on with what you were doing; the events you had are still yours to handle."); err != nil {
		log.Printf("router retry: %v", err)
		return
	}
	sp.mu.Lock()
	if sp.routerAskedAt.IsZero() {
		sp.routerAskedAt = time.Now() // so this turn is checked like any other
	}
	sp.mu.Unlock()
}

// stableBin returns a path to this binary that agents can keep calling. A
// `go run` build lives in a temp dir that vanishes on restart, so in that case
// copy the executable to ~/.collie/bin/collie and hand out that path instead.
func stableBin(exe, dir string) string {
	if !strings.Contains(exe, "go-build") {
		return exe
	}
	dst := filepath.Join(dir, "bin", exeName("collie"))
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return exe
	}
	b, err := os.ReadFile(exe)
	if err != nil {
		return exe
	}
	tmp := dst + ".tmp"
	if err := os.WriteFile(tmp, b, 0o755); err != nil {
		return exe
	}
	if err := replaceBinary(tmp, dst); err != nil {
		_ = os.Remove(tmp)
		return exe
	}
	return dst
}

func (sp *Super) settings() Settings {
	sp.mu.Lock()
	defer sp.mu.Unlock()
	return sp.st.Settings
}

// collieAllow is the Claude Code permission rule set for calling the collie
// CLI, by its absolute path and by name.
func collieAllow(bin string, extra ...string) []string {
	rules := []string{"Bash(collie:*)", "Bash(collie *)", "Bash(collie.exe:*)", "Bash(collie.exe *)", "Read(~/.collie/uploads/**)"}
	// Claude matches the resolved path too; home is often a symlink.
	if up, err := filepath.EvalSymlinks(filepath.Join(collieDir(), "uploads")); err == nil {
		s := filepath.ToSlash(up)
		if !strings.HasPrefix(s, "/") {
			s = "/" + s
		}
		rules = append(rules, "Read(/"+strings.TrimPrefix(s, "/")+"/**)")
	}
	if bin != "" && bin != "collie" && bin != "collie.exe" {
		rules = append(rules, "Bash("+bin+":*)", "Bash("+bin+" *)")
		if sb := shellBin(bin); sb != bin {
			rules = append(rules, "Bash("+sb+":*)", "Bash("+sb+" *)")
		}
	}
	return append(rules, extra...)
}

// routerArgsLocked: the extra launch flags plus the chosen model and effort.
func (sp *Super) routerArgsLocked() []string {
	st := sp.st.Settings
	args := append(append([]string{}, st.RouterArgs...), modelArgs(st.RouterKind, st.RouterModel, st.RouterEffort)...)
	return withBypass(args, st.RouterKind, st.AskPermissions)
}

// The model and effort the router was launched with, kept across hub restarts.
func (sp *Super) setRouterRun(run [2]string) {
	sp.routerRun = &run
	b, _ := json.Marshal(run)
	sp.db.Exec(`INSERT INTO kv(k,v) VALUES('router_run',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, string(b))
}

func (sp *Super) routerRunLocked() *[2]string {
	if sp.routerRun == nil {
		var raw string
		var run [2]string
		if sp.db.QueryRow(`SELECT v FROM kv WHERE k='router_run'`).Scan(&raw) == nil && json.Unmarshal([]byte(raw), &run) == nil {
			sp.routerRun = &run
		}
	}
	return sp.routerRun
}
