package collie

import (
	"context"
	"errors"
	"fmt"
	"log"
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

// nextDream is when the nightly dream is due next (zero when off).
func (sp *Super) nextDream(now time.Time) time.Time {
	sp.mu.Lock()
	h, m, ok := sp.dreamAtLocked()
	sp.mu.Unlock()
	if !ok {
		return time.Time{}
	}
	t := time.Date(now.Year(), now.Month(), now.Day(), h, m, 0, 0, now.Location())
	if !sp.lastDream().Before(t) || now.After(t.Add(3*time.Hour)) {
		t = t.AddDate(0, 0, 1)
	}
	return t
}

// somethingHappenedLocked: was there any conversation since t?
func (sp *Super) somethingHappenedLocked(t time.Time) bool {
	for i := len(sp.st.Entries) - 1; i >= 0; i-- {
		e := sp.st.Entries[i]
		if e.At.Before(t) {
			return false
		}
		if e.Role == "user" || e.Role == "collie" {
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
	next := sp.nextDream(now)
	if next.IsZero() || now.Before(next) || now.After(next.Add(3*time.Hour)) {
		return
	}
	a, alive := live[routerName]
	sp.mu.Lock()
	busy := sp.handover != nil || sp.st.Settings.Paused || queued || !sp.routerAskedAt.IsZero() ||
		(alive && a.Status != "idle" && a.Status != "done")
	happened := sp.somethingHappenedLocked(sp.lastDream())
	sp.mu.Unlock()
	if busy {
		return
	}
	if !happened {
		sp.setLastDream(now) // a quiet day: nothing to dream about
		return
	}
	sp.StartDream(ctx, "nightly")
}

// StartDream puts Collie to sleep and starts the dream session.
func (sp *Super) StartDream(ctx context.Context, reason string) error {
	sp.mu.Lock()
	if sp.dream != nil || sp.handover != nil {
		sp.mu.Unlock()
		return errors.New("Collie 正在整理记忆")
	}
	sp.dream = &dreamRun{at: time.Now(), reason: reason}
	kind := sp.st.Settings.RouterKind
	args := sp.routerArgsLocked()
	sp.addEntryLocked("event", mainThread, "Collie 睡一会儿，回顾最近的对话、整理记忆（做梦）", "", "info")
	sp.mu.Unlock()

	go func() {
		bg, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer cancel()
		fail := func(err error) {
			log.Printf("dream: %v", err)
			sp.mu.Lock()
			sp.dream = nil
			sp.addEntryLocked("event", mainThread, "整理记忆没能开始："+err.Error(), "", "error")
			sp.mu.Unlock()
		}
		// Collie's current session ends here; its log is part of what gets reviewed.
		if live, ok := sp.liveAgents(bg); ok {
			if a, ok := live[routerName]; ok && a.Session != "" {
				k := a.Kind
				if k == "antigravity" {
					k = "agy"
				}
				sp.s.remember(&Ended{Kind: k, Cwd: sp.routerDir(), Name: routerName, Session: a.Session, Ended: time.Now(),
					Title: "Collie · 做梦前的会话（" + time.Now().Format("01-02 15:04") + "）"})
			}
		}
		sp.closeWorkspaces(bg, routerLabel)
		sp.closeWorkspaces(bg, dreamLabel)
		if err := sp.writeRouterFiles(); err != nil {
			log.Printf("router files: %v", err)
		}
		if err := sp.writeDreamInput(); err != nil {
			fail(err)
			return
		}
		os.MkdirAll(filepath.Join(sp.routerDir(), "dreams"), 0o700)
		if _, _, err := sp.s.startAgent(bg, "", kinds[kind], dreamName, sp.routerDir(), dreamLabel, args); err != nil {
			var he *HerdrError
			if !(errors.As(err, &he) && he.Code == "agent_not_ready") {
				fail(err)
				return
			}
		}
		prompt := strings.ReplaceAll(dreamPrompt, "{{DATE}}", time.Now().Format("2006-01-02"))
		prompt = strings.ReplaceAll(prompt, "{{BIN}}", shellBin(sp.bin))
		migrate := ""
		if sp.legacyMemory() {
			migrate = "\nFirst: " + migrateNote + "\n"
		}
		prompt = strings.ReplaceAll(prompt, "{{MIGRATE}}", migrate)
		deadline := time.Now().Add(90 * time.Second)
		for {
			err := sp.s.herdr.Prompt(bg, dreamName, prompt)
			var he *HerdrError
			if err == nil {
				break
			}
			if !errors.As(err, &he) || (he.Code != "agent_not_ready" && he.Code != "agent_not_found") || time.Now().After(deadline) {
				sp.closeWorkspaces(context.Background(), dreamLabel)
				fail(err)
				return
			}
			time.Sleep(2 * time.Second)
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
			sp.finishDream(ctx, d, false)
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
		sp.finishDream(ctx, d, true)
	case !alive && worked, wait > 25*time.Minute, !worked && !idleAt.IsZero() && time.Since(idleAt) > 2*time.Minute:
		sp.finishDream(ctx, d, worked)
	}
}

func (sp *Super) finishDream(ctx context.Context, d *dreamRun, ok bool) {
	sp.closeWorkspaces(ctx, dreamLabel)
	summary, skills := "", ""
	if ok {
		sp.setLastDream(time.Now())
		journal := filepath.Join(sp.routerDir(), "dreams", d.at.Format("2006-01-02")+".md")
		summary, skills = dreamSummary(journal), dreamSkills(journal)
	}
	sp.mu.Lock()
	sp.dream = nil
	sp.routerLaunchAt = time.Time{}
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
	sp.mu.Unlock()
	sp.ensureRouter(ctx)
}

// dreamSummary is the journal's first line of prose.
// dreamSkillsPrefix starts the journal line naming how-tos ripe for a skill.
const dreamSkillsPrefix = "可做成 skill："

// dreamSkills is what that line lists, or "".
func dreamSkills(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	for i, l := range strings.Split(string(b), "\n") {
		if i > 8 {
			break // it is up top, not in the reasons below
		}
		l = strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(l), ">-* "))
		if s, ok := strings.CutPrefix(l, dreamSkillsPrefix); ok {
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
		if l = strings.TrimSpace(l); strings.HasPrefix(l, "#") || strings.HasPrefix(l, dreamSkillsPrefix) {
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
		if _, m := split(ws.ID); ws.Label == label && m == "" {
			sp.s.herdr.Call(ctx, "workspace.close", map[string]any{"workspace_id": ws.ID}, nil)
		}
	}
}

// writeDreamInput condenses what happened since the last dream into dream/input.md.
func (sp *Super) writeDreamInput() error {
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
		path, format := sp.s.findTranscript(h.Kind, "id", h.Session, "", "")
		if path == "" {
			continue
		}
		tr := newTranscript(path, format)
		tr.update()
		var p strings.Builder
		fmt.Fprintf(&p, "\n### %s (ended %s)\n\n", h.Title, h.Ended.Format("01-02 15:04"))
		for _, m := range tr.msgs {
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

const dreamPrompt = `[collie] Dream. You are Collie's memory keeper, running while Collie sleeps. Collie is the agent described in ROUTER.md (read it for context and for the layout of memory/; don't do its job). Your inputs, all in this directory:
- memory/: Collie's memory, laid out as ROUTER.md describes.
- dream/input.md: what happened since the last dream: the chat with the human and Collie's own session logs.
- dreams/: earlier dream journals, if any.
Run ` + "`{{BIN}} list`" + ` to see which agents are actually still around.
{{MIGRATE}}
Tidy memory/:
1. Replace stale entries: tasks that are finished, abandoned or whose agents are gone go to tasks/done/ with a last line on how they ended; facts the logs show have changed get fixed.
2. Merge duplicates and tighten wording. Pointers (paths, thread ids, URLs), not copies. Keep the up-front files (instructions.md, notes/index.md, open tasks) under ~6 KB together; move detail into notes/ files and list each in notes/index.md.
3. Look for patterns that only show across sessions: requests the human repeats, corrections they keep making, preferences they never stated outright, mistakes Collie made more than once. Write the ones that should change how Collie behaves into instructions.md (or a note), marked "(inferred)". Each must be backed by the logs; never invent.
4. Finished work that taught something reusable (where data lives, the command or query that worked, a pitfall, where results are) belongs in notes/, filed by topic so the next similar job finds it; read the task files and the logs for it. Add what Collie missed; skip one-off details. What the logs show about agents (which agent or model worked or failed on which computer, and at what) goes into notes/agents.md. Dated facts that are old enough to have changed: check them (` + "`{{BIN}} list`" + `, the files) and fix or drop them.
5. A how-to in notes/ that three or more jobs have used and whose steps stopped changing could become a skill, which every agent can use. Don't write skills: name them on the journal's second line, which starts "可做成 skill：" and lists them separated by 、 (each a few words a human recognises, e.g. "Dorado 只读查表"); the human gets it as a message from Collie. Leave the line out when there are none. Say why below.
6. Keep every explicit instruction from the human unless a later one overrides it. Don't edit memory/messages.md (the hub writes it).

Then write dreams/{{DATE}}.md (append if it exists). Its first line: one sentence in Chinese saying what you changed; the human sees it. After that: what you changed and why, and patterns you noticed but didn't act on.

Don't message the human and don't start agents. When the files are written, stop.`
