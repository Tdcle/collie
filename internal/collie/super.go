package collie

import (
	"context"
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
	"sort"
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

	routerLaunching     bool
	routerActiveMachine string   // machine ID hosting the active Router ("", "hub", or node ID)
	rereadTrig          *Trigger // the pending "re-read ROUTER.md", if any
	routerLaunchAt      time.Time
	routerFresh         bool
	routerAskedAt       time.Time // last delivery to the router not yet followed by a reply or check
	routerRetries       int       // turns in a row that ended on an API error, each retried
	routerNudged        bool      // the watchdog interrupted this turn once already
	routerUsage         ctxUsage
	// The model and effort the running router was launched with (unknown after a hub restart).
	routerRun     *[2]string
	handover      *handover            // set while the router writes its memory before a fresh session
	dream         *dreamRun            // set while Collie sleeps and a dream session tidies its memory
	dreamFailSlot time.Time            // scheduled dream slot of the latest failed nightly attempt
	dreamFailAt   time.Time            // when the latest dream attempt failed
	dreamFailures int                  // consecutive failures for dreamFailSlot
	lastTrust     map[string]time.Time // pane → when its trust dialog was last answered
	lastScreen    map[string]screenMark
	transcripts   map[string]*transcript
	noAgent       map[string]time.Time // worker → since when its pane has had no agent in it
	workerAskedAt map[string]time.Time // worker → when its latest prompt was delivered
	notifyBuf     []notice
	notifyAt      time.Time
	seenAt        time.Time // when a page of Collie was last open in front of you
	seenURL       string    // where that page was, for the link in a notification
	paneWatch     map[string]string
	panePrimed    map[string]bool
	extWatch      map[string]extWatchSnap
	extPrimed     map[string]bool
	extSentAt     map[string]time.Time
	sessionScanAt time.Time
	quotaAlertAt  time.Time
}

type extWatchSnap struct {
	status  string
	updated time.Time
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
		paneWatch:     map[string]string{},
		panePrimed:    map[string]bool{},
		extWatch:      map[string]extWatchSnap{},
		extPrimed:     map[string]bool{},
		extSentAt:     map[string]time.Time{},
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
	sp.mu.Lock()
	preferRouterM := sp.routerActiveMachine
	if preferRouterM == "" {
		preferRouterM = sp.st.Settings.RouterMachine
	}
	sp.mu.Unlock()

	m := map[string]liveAgent{}
	for _, a := range list {
		if a.Name == nil {
			continue
		}
		la := liveAgent{Pane: a.PaneID, Status: a.AgentStatus, Ready: a.Ready, Kind: deref(a.Agent)}
		if a.Session != nil {
			la.Session = sessionID(a.Session.Kind, a.Session.Value)
		}
		if *a.Name == routerName {
			if prev, exists := m[routerName]; exists {
				_, prevM := split(prev.Pane)
				_, curM := split(la.Pane)
				if prevM == preferRouterM && curM != preferRouterM {
					continue
				}
			}
		}
		m[*a.Name] = la
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
	var dead []*Worker
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
				delete(sp.workerAskedAt, w.Name)
				if now.Sub(w.ReportAt) > 90*time.Second {
					fin = append(fin, finished{w, false})
				}
			}
		} else if !asked.IsZero() && (a.Status == "done" || a.Status == "idle") && now.Sub(asked) >= 5*time.Second {
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
	if ra, hasR := live[routerName]; hasR {
		routerAlive = true
		_, rm := split(ra.Pane)
		if sp.routerActiveMachine == "" {
			sp.routerActiveMachine = rm
		}
	}
	sp.mu.Unlock()

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
			continue
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
		if a.Status == "blocked" || a.Status == "starting" || (!a.Ready && a.Status == "unknown") {
			continue
		}
		sp.mu.Lock()
		awaitFirstIdle := (target == routerName && sp.routerFresh) || (target != routerName && sp.workerAskedAt[target].IsZero())
		sp.mu.Unlock()
		if awaitFirstIdle && a.Status != "idle" && a.Status != "done" {
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
		sp.maybeSwitchBackRouter(ctx, a, len(deliveries[routerName]) > 0)
	}
	sp.checkHandover(ctx, live, len(deliveries[routerName]) > 0)
	sp.checkDream(ctx, live, len(deliveries[routerName]) > 0)

	// 5. Watchdog, standalone session notifications & low-quota alerts.
	sp.watchdog(ctx, live, routerAlive)
	sp.watchStandaloneSessions(ctx)
	sp.checkQuotaAlerts(ctx)
}

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
		return
	}
	for _, t := range list {
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
		if len([]rune(text)) > 700 {
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
		fmt.Fprintf(&b, "\nReply with `collie reply`, usually ≤%d characters.", words)
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
		sp.routerAskedAt = time.Now()
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

func deathReason(screen string) string {
	lines := strings.Split(screen, "\n")
	var loose string
	for i, l := range lines {
		t := strings.TrimSpace(l)
		low := strings.ToLower(t)
		if strings.Contains(low, "error:") || strings.HasPrefix(low, "error ") || strings.HasPrefix(low, "fatal") || strings.Contains(low, "panic:") ||
			strings.Contains(low, "command not found") || strings.Contains(low, "no such file") || strings.Contains(low, "not recognized as") {
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

var workerQuotaRe = regexp.MustCompile(`(?i)(usage limit|limit reached|hit your( \w+)? limit|reached your( \w+)? limit|quota exceeded|exceeded your( current)? quota|insufficient[_ ]balance|insufficient[_ ]quota|payment required|resource.?exhausted|daily limit|rate.?limit(ed)?\b|credit balance|out of credits|please run /login|not logged in|invalid api key|authentication[_ ]error|api error|overloaded|unexpected status \d{3}|model .* (not found|does not exist|is not supported)|try again (at|in) )`)

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

// ---------------------------------------------------------------- recall

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
	projs := sp.s.snapshotProjects()
	machines := sp.s.allMachines()
	sp.mu.Lock()
	defer sp.mu.Unlock()
	var b strings.Builder
	b.WriteString("machines (pass the id or name to `collie spawn -machine`; avoid agents marked UNAVAILABLE/EXHAUSTED):\n")
	mByID := map[string]*Machine{}
	for i := range machines {
		m := &machines[i]
		mByID[m.ID] = m
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
		qBrief := sp.s.machineQuotaBrief(m.ID)
		if qBrief != "" {
			fmt.Fprintf(&b, "  %-14s %-11s %s  agents=%s  quotas=%s  home=%s\n", id, state, m.Name, ag, qBrief, m.Home)
		} else {
			fmt.Fprintf(&b, "  %-14s %-11s %s  agents=%s  home=%s\n", id, state, m.Name, ag, m.Home)
		}
	}
	b.WriteString("projects (pinned workspaces; use their machine and cwd when the human refers to them):\n")
	if len(projs) == 0 {
		b.WriteString("  (none)\n")
	} else {
		for _, p := range projs {
			mid := p.Machine
			mName, mState := "hub", "online"
			if m := mByID[p.Machine]; m != nil {
				mName = m.Name
				if m.Local {
					if !m.Online && len(localAgents(sp.s.home, false)) == 0 {
						mState = "relay-only"
					}
				} else if !m.Online {
					mState = "offline"
				}
			} else if mid != "" {
				mName, mState = mid, "offline"
			}
			if mid == "" {
				mid = "hub"
			}
			pk := p.Kind
			if pk == "" {
				pk = "default"
			}
			fmt.Fprintf(&b, "  %-22q machine=%s (%s, %s)  kind=%s  cwd=%s\n", p.Name, mid, mName, mState, pk, p.Cwd)
		}
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

func collieAllow(bin string, extra ...string) []string {
	rules := []string{"Bash(collie:*)", "Bash(collie *)", "Bash(collie.exe:*)", "Bash(collie.exe *)", "Read(~/.collie/uploads/**)"}
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
