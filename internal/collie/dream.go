package collie

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Dreaming: while Collie sleeps (nightly, or on demand) a separate session
// reviews what happened since the last dream (the chat with the human and
// Collie's own session logs) and tidies memory/. It replaces stale entries
// and records patterns that only show across many sessions. Collie then wakes
// up in a fresh session.

const (
	dreamName  = "collie-dream"
	dreamLabel = "collie · dream"
)

type dreamRun struct {
	at        time.Time
	machine   string
	started   bool // the dream session is up and has its prompt
	worked    bool
	idleAt    time.Time
	reason    string
	blockedAt time.Time
	told      bool
}

func (sp *Super) dreaming() bool {
	sp.mu.Lock()
	defer sp.mu.Unlock()
	return sp.dream != nil
}

func (sp *Super) lastDream() time.Time {
	var raw string
	if sp.db.QueryRow(`SELECT v FROM kv WHERE k='last_dream'`).Scan(&raw) == nil {
		if t, err := time.Parse(time.RFC3339, raw); err == nil {
			return t
		}
	}
	return time.Time{}
}

func (sp *Super) setLastDream(t time.Time) {
	sp.db.Exec(`INSERT INTO kv(k,v) VALUES('last_dream',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, t.Format(time.RFC3339))
}

// dreamAtLocked parses the nightly time ("04:00" by default; "off" disables).
func (sp *Super) dreamAtLocked() (h, m int, ok bool) {
	v := sp.st.Settings.DreamAt
	if v == "" {
		v = "04:00"
	}
	if v == "off" {
		return 0, 0, false
	}
	if _, err := fmt.Sscanf(v, "%d:%d", &h, &m); err != nil || h < 0 || h > 23 || m < 0 || m > 59 {
		return 4, 0, true
	}
	return h, m, true
}

// nextDream is when the next scheduled nightly dream will occur for UI display (zero when off).
func (sp *Super) nextDream(now time.Time) time.Time {
	sp.mu.Lock()
	h, m, ok := sp.dreamAtLocked()
	sp.mu.Unlock()
	if !ok {
		return time.Time{}
	}
	t := time.Date(now.Year(), now.Month(), now.Day(), h, m, 0, 0, now.Location())
	if !now.Before(t) && !sp.lastDream().Before(t) {
		return t.AddDate(0, 0, 1)
	}
	if now.After(t.Add(18 * time.Hour)) {
		return t.AddDate(0, 0, 1)
	}
	if !now.Before(t) {
		// Today's slot passed; if still pending catch-up (e.g. laptop was asleep at 04:00),
		// show tomorrow's slot in UI after failed quota, otherwise keep next upcoming slot clear.
		sp.mu.Lock()
		exhausted := sp.dreamFailSlot.Equal(t) && sp.dreamFailures >= 3
		sp.mu.Unlock()
		if exhausted {
			return t.AddDate(0, 0, 1)
		}
		return t.AddDate(0, 0, 1)
	}
	return t
}

// dueDreamSlot returns the scheduled dream slot that is currently due to run
// (allowing up to 18h of catch-up so a laptop asleep at 04:00 smoothly runs its
// memory tidy once opened and idle in the morning), or zero when nothing is due.
func (sp *Super) dueDreamSlot(now time.Time) time.Time {
	sp.mu.Lock()
	h, m, ok := sp.dreamAtLocked()
	sp.mu.Unlock()
	if !ok {
		return time.Time{}
	}
	slot := time.Date(now.Year(), now.Month(), now.Day(), h, m, 0, 0, now.Location())
	if now.Before(slot) {
		slot = slot.AddDate(0, 0, -1)
	}
	if now.After(slot.Add(18 * time.Hour)) {
		return time.Time{}
	}
	if !sp.lastDream().Before(slot) {
		return time.Time{}
	}
	return slot
}

func dreamRetryBackoff(failures int) time.Duration {
	switch {
	case failures <= 0:
		return 0
	case failures == 1:
		return 5 * time.Minute
	default:
		return 20 * time.Minute
	}
}

func (sp *Super) recordDreamFailureLocked(at time.Time) {
	slot := sp.dueDreamSlotForLocked(at)
	if !slot.IsZero() {
		if !sp.dreamFailSlot.Equal(slot) {
			sp.dreamFailSlot = slot
			sp.dreamFailures = 0
		}
	}
	sp.dreamFailures++
	sp.dreamFailAt = time.Now()
}

func (sp *Super) dueDreamSlotForLocked(now time.Time) time.Time {
	h, m, ok := sp.dreamAtLocked()
	if !ok {
		return time.Time{}
	}
	slot := time.Date(now.Year(), now.Month(), now.Day(), h, m, 0, 0, now.Location())
	if now.Before(slot) {
		slot = slot.AddDate(0, 0, -1)
	}
	return slot
}

// somethingHappenedLocked: was there any conversation or worker job since t?
func (sp *Super) somethingHappenedLocked(t time.Time) bool {
	for i := len(sp.st.Entries) - 1; i >= 0; i-- {
		e := sp.st.Entries[i]
		if e.At.Before(t) {
			break
		}
		if e.Role == "user" || e.Role == "collie" {
			return true
		}
	}
	for _, w := range sp.st.Workers {
		if w != nil && w.CreatedAt.After(t) {
			return true
		}
	}
	return false
}

// checkDream runs every tick: drives a dream in progress, or starts the nightly one.
func (sp *Super) checkDream(ctx context.Context, live map[string]liveAgent, queued bool) {
	sp.mu.Lock()
	d := sp.dream
	sp.mu.Unlock()
	if d != nil {
		sp.driveDream(ctx, d, live)
		return
	}
	now := time.Now()
	slot := sp.dueDreamSlot(now)
	if slot.IsZero() {
		return
	}
	a, alive := live[routerName]
	last := sp.lastDream()
	sp.mu.Lock()
	// Enforce retry backoff & per-slot cap so startup errors never tight-loop every tick!
	if sp.dreamFailSlot.Equal(slot) {
		if sp.dreamFailures >= 3 || time.Since(sp.dreamFailAt) < dreamRetryBackoff(sp.dreamFailures) {
			sp.mu.Unlock()
			return
		}
	}
	routerMach := sp.st.Settings.RouterMachine
	busy := sp.handover != nil || sp.st.Settings.Paused || queued || !sp.routerAskedAt.IsZero() ||
		(alive && a.Status != "idle" && a.Status != "done")
	happened := sp.somethingHappenedLocked(last)
	sp.mu.Unlock()
	if busy {
		return
	}
	if !happened {
		sp.setLastDream(now) // a quiet day: nothing to dream about
		return
	}
	// If Collie's configured Brain lives on a specific computer (e.g. Mac) that is
	// currently asleep/offline, quietly wait for it to reconnect rather than
	// failing or falling back to an unproxied relay Hub at 04:00 AM.
	if routerMach != "" {
		if _, err := sp.s.herdr.machine(routerMach); err != nil {
			return
		}
	}
	_ = sp.StartDream(ctx, "nightly")
}

// StartDream puts Collie to sleep and starts the dream session.
func (sp *Super) StartDream(ctx context.Context, reason string) error {
	sp.mu.Lock()
	if sp.dream != nil || sp.handover != nil {
		sp.mu.Unlock()
		return errors.New("Collie 正在整理记忆")
	}
	if reason == "manual" {
		sp.dreamFailures = 0
		sp.dreamFailAt = time.Time{}
	}
	sp.dream = &dreamRun{at: time.Now(), reason: reason}
	at := sp.dream.at
	st := sp.st.Settings
	entry := sp.addEntryLocked("event", mainThread, "Collie 睡一会儿，回顾最近的对话、整理记忆（做梦）", "", "info")
	sp.mu.Unlock()

	go func() {
		bg, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer cancel()
		fail := func(err error) {
			log.Printf("dream: %v", err)
			sp.mu.Lock()
			sp.dream = nil
			sp.recordDreamFailureLocked(at)
			sp.addEntryLocked("event", mainThread, "整理记忆没能开始："+err.Error(), "", "error")
			sp.mu.Unlock()
		}
		targetMachine, kind, resolveErr := sp.resolveRouterTarget(st)
		if resolveErr != nil {
			fail(resolveErr)
			return
		}
		machineID := targetMachine.ID
		sp.mu.Lock()
		if sp.dream != nil {
			sp.dream.machine = machineID
		}
		// Dream on the workers' model when they share Collie's agent: tidying
		// memory is judgement work that runs once a day with nobody waiting.
		model, effort := sp.st.Settings.RouterModel, sp.st.Settings.RouterEffort
		if sp.st.Settings.WorkerModel != "" && kinds[sp.st.Settings.WorkerKind] == kinds[kind] {
			model, effort = sp.st.Settings.WorkerModel, sp.st.Settings.WorkerEffort
		} else if kinds[kind] != kinds[sp.st.Settings.RouterKind] {
			model, effort = "", ""
		}
		args := append(append([]string{}, sp.st.Settings.RouterArgs...), modelArgs(kind, model, effort)...)
		args = withBypass(args, kind, sp.st.Settings.AskPermissions)
		sp.mu.Unlock()

		// Collie's current session ends here; its log is part of what gets reviewed.
		if live, ok := sp.liveAgents(bg); ok {
			if a, ok := live[routerName]; ok && a.Session != "" {
				k := a.Kind
				if k == "antigravity" {
					k = "agy"
				}
				_, rm := split(a.Pane)
				cwd := sp.routerDir()
				if rm != "" {
					_, _ = sp.pullRouterFromNode(bg, rm, "", "", "", 0)
					if mc, err := sp.s.herdr.machine(rm); err == nil {
						cwd = sp.routerDirOn(mc)
					}
				}
				e := &Ended{Kind: k, Machine: rm, Cwd: cwd, Name: routerName, Session: a.Session, Ended: time.Now(),
					Title: "Collie · 做梦前的会话（" + time.Now().Format("01-02 15:04") + "）"}
				sp.s.remember(e)
				sp.mu.Lock()
				entry.Ref = "h:" + e.ID
				sp.changed()
				sp.mu.Unlock()
			}
		}
		sp.closeWorkspaces(bg, routerLabel)
		sp.closeWorkspaces(bg, dreamLabel)
		if err := sp.writeRouterFilesFor(targetMachine); err != nil {
			log.Printf("router files: %v", err)
		}
		if err := sp.writeDreamInput(bg); err != nil {
			fail(err)
			return
		}
		os.MkdirAll(filepath.Join(sp.routerDir(), "dreams"), 0o700)
		rdir := sp.routerDir()
		if machineID != "" {
			var syncErr error
			if rdir, syncErr = sp.pushRouterToNode(bg, machineID); syncErr != nil {
				fail(syncErr)
				return
			}
		}
		paneID, _, err := sp.s.startAgent(bg, machineID, kinds[kind], dreamName, rdir, dreamLabel, args)
		if err != nil {
			var he *HerdrError
			if !(errors.As(err, &he) && (he.Code == "agent_not_ready" || he.Code == "agent_blocked")) {
				fail(err)
				return
			}
		}
		prompt := strings.ReplaceAll(dreamPrompt, "{{DATE}}", journalName(at))
		prompt = strings.ReplaceAll(prompt, "{{BIN}}", shellBin(sp.routerBinOn(targetMachine)))
		prompt = strings.ReplaceAll(prompt, "{{BUDGET}}", fmt.Sprint(upFrontBudget>>10))
		migrate := ""
		if sp.legacyMemory() {
			migrate = "\nFirst: " + migrateNote + "\n"
		}
		prompt = strings.ReplaceAll(prompt, "{{MIGRATE}}", migrate)
		deadline := time.Now().Add(90 * time.Second)
		promptSent := false
		var lastErr error
		for time.Now().Before(deadline) {
			// Wait until the newly launched dream agent finishes TUI boot
			// (transient startup "working"/"starting") and settles into "idle"
			// before sending its prompt; also auto-answer folder trust if needed.
			live, ok := sp.liveAgents(bg)
			if !ok {
				lastErr = errors.New("waiting for herdr agent list")
				time.Sleep(1500 * time.Millisecond)
				continue
			}
			a, alive := live[dreamName]
			if !alive {
				lastErr = errors.New("dream agent starting up")
				time.Sleep(1500 * time.Millisecond)
				continue
			}
			if a.Status == "blocked" {
				sp.trustOwnDir(bg, a.Pane)
				lastErr = errors.New("waiting for folder trust dialog")
				time.Sleep(1500 * time.Millisecond)
				continue
			}
			if a.Status != "idle" && a.Status != "done" {
				lastErr = fmt.Errorf("dream agent still %s during startup", a.Status)
				time.Sleep(1500 * time.Millisecond)
				continue
			}
			err := sp.s.herdr.Prompt(bg, dreamName, prompt)
			if err == nil {
				promptSent = true
				break
			}
			lastErr = err
			var he *HerdrError
			if errors.As(err, &he) && (he.Code == "agent_not_ready" || he.Code == "agent_not_found" || he.Code == "agent_blocked") {
				if paneID != "" {
					sp.trustOwnDir(bg, paneID)
				}
				time.Sleep(2 * time.Second)
				continue
			}
			break
		}
		if !promptSent {
			sp.closeWorkspaces(context.Background(), dreamLabel)
			if lastErr == nil {
				lastErr = errors.New("timed out waiting for dream agent to become idle")
			}
			fail(lastErr)
			return
		}
		sp.mu.Lock()
		if sp.dream != nil {
			sp.dream.started = true
		}
		sp.mu.Unlock()
	}()
	return nil
}

func (sp *Super) driveDream(ctx context.Context, d *dreamRun, live map[string]liveAgent) {
	sp.mu.Lock()
	started := d.started
	sp.mu.Unlock()
	if !started {
		if time.Since(d.at) > 5*time.Minute { // the launcher goroutine is stuck
			sp.finishDream(ctx, d, false, false)
		}
		return
	}
	a, alive := live[dreamName]
	if alive && a.Status == "blocked" {
		sp.trustOwnDir(ctx, a.Pane)
		sp.mu.Lock()
		if d.blockedAt.IsZero() {
			d.blockedAt = time.Now()
		} else if !d.told && time.Since(d.blockedAt) > time.Minute {
			d.told = true
			sp.addEntryLocked("event", mainThread, "Collie 整理记忆时停在一个确认上，点这里看看", dreamName, "blocked")
		}
		sp.mu.Unlock()
	} else {
		sp.mu.Lock()
		d.blockedAt = time.Time{}
		sp.mu.Unlock()
	}
	sp.mu.Lock()
	switch {
	case alive && a.Status == "working":
		d.worked, d.idleAt = true, time.Time{}
	case alive && (a.Status == "idle" || a.Status == "done") && d.idleAt.IsZero():
		d.idleAt = time.Now()
	}
	worked, idleAt := d.worked, d.idleAt
	sp.mu.Unlock()
	wait := time.Since(d.at)
	switch {
	case worked && !idleAt.IsZero() && time.Since(idleAt) > 6*time.Second:
		sp.finishDream(ctx, d, true, true)
	case !alive && worked:
		// Exited on its own after working: only treat as ok if the dream journal was written.
		sp.finishDream(ctx, d, false, true)
	case wait > 25*time.Minute, !worked && !idleAt.IsZero() && time.Since(idleAt) > 2*time.Minute:
		sp.finishDream(ctx, d, false, false)
	}
}

func (sp *Super) finishDream(ctx context.Context, d *dreamRun, cleanIdle, checkJournal bool) {
	if d.machine != "" {
		_, _ = sp.pullRouterFromNode(ctx, d.machine, "", "", "", 0)
	}
	sp.closeWorkspaces(ctx, dreamLabel)
	journal := filepath.Join(sp.routerDir(), "dreams", journalName(d.at)+".md")
	ok := cleanIdle || (checkJournal && isFile(journal))
	summary, skills, fixes := "", "", ""
	if ok {
		sp.setLastDream(time.Now())
		summary, skills, fixes = dreamSummary(journal), dreamLine(journal, dreamSkillsPrefix), dreamLine(journal, dreamFixPrefix)
	}
	sp.mu.Lock()
	sp.dream = nil
	sp.routerLaunchAt = time.Time{}
	if ok {
		sp.dreamFailures = 0
		sp.dreamFailAt = time.Time{}
	} else {
		sp.recordDreamFailureLocked(d.at)
	}
	switch {
	case !ok:
		sp.addEntryLocked("event", mainThread, "这次整理记忆没有完成，Collie 先醒过来了", "", "error")
	case summary != "":
		sp.addEntryLocked("event", mainThread, "Collie 醒了。整理记忆："+summary, "", "info")
	default:
		sp.addEntryLocked("event", mainThread, "Collie 醒了，记忆整理好了", "", "info")
	}
	if skills != "" {
		// Yours to decide, so it is said to you, not left in the journal.
		sp.addEntryLocked("collie", mainThread, "整理记忆时发现这几件事做熟了，可以做成 skill，以后哪个 agent 都能直接用："+skills+"。要做的话告诉我放在哪（你自己的 skills，还是某个项目的仓库）。", "", "")
	}
	if fixes != "" {
		sp.addEntryLocked("collie", mainThread, "整理记忆时发现已有的 skill 有地方不好用："+fixes+"。要改的话说一声，我派人去改。", "", "")
	}
	sp.mu.Unlock()
	sp.ensureRouter(ctx)
}

// dreamSummary is the journal's first line of prose.
// dreamSkillsPrefix starts the journal line naming how-tos ripe for a skill.
const dreamSkillsPrefix = "可做成 skill："

// dreamFixPrefix starts the line naming existing skills that need fixing.
const dreamFixPrefix = "可改进 skill："

// journalName names one dream's journal: one file per run, so the hub reads
// this run's summary, never an earlier one's from the same day.
func journalName(at time.Time) string { return at.Format("2006-01-02-1504") }

// dreamLine is what the journal's line starting with prefix lists, or "".
func dreamLine(path, prefix string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	for i, l := range strings.Split(string(b), "\n") {
		if i > 8 {
			break // it is up top, not in the reasons below
		}
		l = strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(l), ">-* "))
		if s, ok := strings.CutPrefix(l, prefix); ok {
			return strings.TrimRight(strings.TrimSpace(s), "。.")
		}
	}
	return ""
}

func dreamSummary(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	for _, l := range strings.Split(string(b), "\n") {
		if l = strings.TrimSpace(l); strings.HasPrefix(l, "#") || strings.HasPrefix(l, dreamSkillsPrefix) || strings.HasPrefix(l, dreamFixPrefix) {
			continue // the title; the skills, said on their own
		}
		l = strings.TrimSpace(strings.TrimLeft(l, ">-* "))
		if l != "" {
			if r := []rune(l); len(r) > 160 {
				l = string(r[:160]) + "…"
			}
			return l
		}
	}
	return ""
}

func (sp *Super) closeWorkspaces(ctx context.Context, label string) {
	wss, err := sp.s.herdr.Workspaces(ctx)
	if err != nil {
		return
	}
	for _, ws := range wss {
		if ws.Label == label {
			sp.s.herdr.Call(ctx, "workspace.close", map[string]any{"workspace_id": ws.ID}, nil)
		}
	}
}

// writeDreamInput condenses what happened since the last dream into dream/input.md.
func (sp *Super) writeDreamInput(ctx context.Context) error {
	since := sp.lastDream()
	var b strings.Builder
	fmt.Fprintf(&b, "# What happened since the last dream (%s)\n\n", func() string {
		if since.IsZero() {
			return "never"
		}
		return since.Format("2006-01-02 15:04")
	}())

	b.WriteString("## Chat with the human and Collie's event log\n\n")
	sp.mu.Lock()
	var lines []string
	for _, e := range sp.st.Entries {
		if e.At.Before(since) {
			continue
		}
		who := map[string]string{"user": "human", "collie": "Collie"}[e.Role]
		if who == "" {
			who = "event"
		}
		lines = append(lines, fmt.Sprintf("- %s %s: %s", e.At.Format("01-02 15:04"), who, clip(oneLine(e.Text), 600)))
	}
	sp.mu.Unlock()
	if len(lines) > 500 {
		lines = lines[len(lines)-500:]
	}
	b.WriteString(strings.Join(lines, "\n"))
	b.WriteString("\n\n## Collie's own sessions (its reasoning and the commands it ran)\n")

	history.Lock()
	sp.s.loadHistory()
	var sess []*Ended
	for _, h := range history.list {
		if h.Name == routerName && h.Ended.After(since) {
			sess = append(sess, h)
		}
	}
	history.Unlock()
	sort.Slice(sess, func(i, j int) bool { return sess[i].Ended.Before(sess[j].Ended) })
	const budget = 240 << 10
	var parts []string
	for _, h := range sess {
		var msgs []*Message
		if h.Machine != "" {
			if client, err := sp.s.herdr.Client(h.Machine); err == nil {
				q := "http://node/api/transcript?kind=" + h.Kind + "&session=" + h.Session
				if req, err := http.NewRequestWithContext(ctx, "GET", q, nil); err == nil {
					if resp, err := client.Do(req); err == nil {
						var r struct {
							Messages []*Message `json:"messages"`
						}
						json.NewDecoder(resp.Body).Decode(&r)
						resp.Body.Close()
						msgs = r.Messages
					}
				}
			}
		} else if path, format := sp.s.findTranscript(h.Kind, "id", h.Session, "", ""); path != "" {
			tr := newTranscript(path, format)
			tr.update()
			msgs = tr.msgs
		}
		if len(msgs) == 0 {
			continue
		}
		var p strings.Builder
		fmt.Fprintf(&p, "\n### %s (ended %s)\n\n", h.Title, h.Ended.Format("01-02 15:04"))
		for _, m := range msgs {
			switch m.Kind {
			case "user":
				fmt.Fprintf(&p, "IN: %s\n\n", clip(m.Text, 1500))
			case "assistant":
				fmt.Fprintf(&p, "COLLIE: %s\n\n", clip(m.Text, 1500))
			case "tool":
				fmt.Fprintf(&p, "TOOL %s: %s → %s\n\n", m.Name, clip(oneLine(m.Input), 300), clip(oneLine(m.Output), 300))
			}
		}
		parts = append(parts, p.String())
	}
	// Newest sessions matter most: drop the oldest when over budget.
	total := 0
	keep := 0
	for i := len(parts) - 1; i >= 0; i-- {
		if total+len(parts[i]) > budget && keep > 0 {
			break
		}
		total += len(parts[i])
		keep++
	}
	if keep < len(parts) {
		fmt.Fprintf(&b, "\n(%d older sessions left out for length.)\n", len(parts)-keep)
	}
	for _, p := range parts[len(parts)-keep:] {
		if len(p) > budget {
			p = "…(start cut)…\n" + p[len(p)-budget:]
		}
		b.WriteString(p)
	}
	if len(parts) == 0 {
		b.WriteString("\n(no session logs found)\n")
	}
	dir := filepath.Join(sp.routerDir(), "dream")
	os.MkdirAll(dir, 0o700)
	return os.WriteFile(filepath.Join(dir, "input.md"), []byte(b.String()), 0o600)
}

func oneLine(s string) string { return strings.Join(strings.Fields(s), " ") }

const dreamPrompt = `[collie] Dream. You are Collie's memory keeper, running while Collie sleeps. Collie is the agent described in ROUTER.md: read it for context and for the layout of memory/; your part is its memory. Your inputs, all in this directory:
- memory/: Collie's memory, laid out as ROUTER.md describes.
- dream/input.md: what happened since the last dream: the chat with the human and Collie's own session logs.
- dreams/: earlier dream journals, if any.
Run ` + "`{{BIN}} list`" + ` to see which agents are actually still around.
{{MIGRATE}}
Tidy memory/. Every session reads the up-front files (instructions.md, notes/index.md, open tasks) before anything else, so each line there has to earn its place: keep them under ~{{BUDGET}} KB together, and smaller is better.
1. Replace stale entries: tasks that are finished, abandoned or whose agents are gone go to tasks/done/ with a last line on how they ended; facts the logs show have changed get fixed.
2. Rewrite instructions.md line by line. Each line is one rule or preference, at most about 80 Chinese characters: what to do, not why, not the incidents behind it, not the steps. Move the steps, examples, dates and history into the note the line points to ("见 notes/x.md"). A routine a timer already runs keeps its how-to in the timer and its note, not here. Merge lines that say the same thing.
3. Look for patterns that only show across sessions: requests the human repeats, corrections they keep making, preferences they never stated outright, mistakes Collie made more than once. Write the ones that should change how Collie behaves into instructions.md (or a note), marked "(inferred)", in the same short form. Each is backed by the logs and seen more than once.
4. Finished work that taught something reusable (where data lives, the command or query that worked, a pitfall, where results are) belongs in notes/, filed by topic so the next similar job finds it; read the task files and the logs for it. Add what Collie missed; skip one-off details. Pointers (paths, thread ids, URLs), not copies; merge duplicates. Each note gets one line in notes/index.md. What the logs show about agents (which agent or model worked or failed on which computer, and at what) goes into notes/agents.md. Dated facts that are old enough to have changed: check them (` + "`{{BIN}} list`" + `, the files) and fix or drop them.
5. Skills. Find the ones that exist (notes/skills.md says where they live; look there). A note whose how-to is now a skill shrinks to a pointer to it.
   - A how-to in notes/ that three or more jobs have used, whose steps stopped changing and that no skill covers yet, could become one. The human decides about skills: list these on a line starting "可做成 skill：", separated by 、 (each a few words a human recognises, e.g. "Dorado 只读查表").
   - An existing skill the logs show agents working around, failing with, or correcting by hand needs fixing: list it on a line starting "可改进 skill：" as "name（what to fix, a few words）", separated by 、.
   Both lines go right under the journal's first line; the human gets them as messages from Collie. Leave a line out when it has nothing; a skill that already exists belongs on the second line or nowhere.
6. Keep every explicit instruction from the human unless a later one overrides it (shortening its wording is fine). memory/messages.md is the hub's to write; read it as input.

Then write a new file dreams/{{DATE}}.md. Its first line: one sentence in Chinese saying what you changed; the human sees it. Then the skill lines, if any. Then, in under 30 lines: what you changed and why, and patterns you noticed but didn't act on.

Your work is the files alone: when they are written, stop. Collie tells the human what you found.`
