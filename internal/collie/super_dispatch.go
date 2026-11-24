package collie

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"
)

var workerNameRe = regexp.MustCompile(`[^a-z0-9_-]+`)

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

// machineCanRun checks whether computer `m` is online, has `wantKind` (or any
// supported agent if `wantKind == ""`), and — when `checkQuota` is true — skips
// agents known to be exhausted, in arrears, or unauthenticated.
func (sp *Super) machineCanRun(m *Machine, wantKind string, checkQuota ...bool) (bool, string) {
	if m == nil || !m.Online {
		return false, ""
	}
	strictQuota := len(checkQuota) == 0 || checkQuota[0]
	have := m.Agents
	if m.Local {
		have = localAgents(sp.s.home, false)
		if len(have) == 0 {
			return false, ""
		}
	} else if have != nil && len(have) == 0 {
		return false, ""
	}
	if wantKind != "" {
		canon, ok := kinds[wantKind]
		if !ok {
			return false, ""
		}
		if have != nil && !slices.Contains(have, canon) {
			return false, ""
		}
		if strictQuota && sp.s != nil {
			if bad, _ := sp.s.isAgentUnusableForDispatch(m.ID, canon); bad {
				return false, ""
			}
		}
		return true, wantKind
	}
	if have == nil {
		return true, "codex"
	}
	for _, cand := range []string{"codex", "claude", "agy", "gemini"} {
		if slices.Contains(have, cand) {
			if strictQuota && sp.s != nil {
				if bad, _ := sp.s.isAgentUnusableForDispatch(m.ID, cand); bad {
					continue
				}
			}
			return true, cand
		}
	}
	return false, ""
}

// healthyFallbackKindOn picks an installed, non-exhausted agent on `m` when the
// originally chosen agent is out of quota or in arrears.
func (sp *Super) healthyFallbackKindOn(m *Machine, skipKind string) string {
	if m == nil {
		return ""
	}
	have := m.Agents
	if m.Local {
		have = localAgents(sp.s.home, false)
	}
	skipCanon := kinds[skipKind]
	for _, cand := range []string{"codex", "claude", "agy", "gemini"} {
		if cand == skipCanon || (have != nil && !slices.Contains(have, cand)) {
			continue
		}
		if sp.s != nil {
			if bad, _ := sp.s.isAgentUnusableForDispatch(m.ID, cand); bad {
				continue
			}
		}
		return cand
	}
	return ""
}

// resolveAutoWorkerTarget implements Tiers 3 & 4 of dispatch routing when
// `--machine` was omitted: prefer the configured default worker computer when
// online & quota-healthy, and automatically fall back to another online
// computer or healthy agent when offline or out of quota.
func (sp *Super) resolveAutoWorkerTarget(requestedKind string) (machineID, resolvedKind string) {
	sp.mu.Lock()
	defM := sp.st.Settings.WorkerMachine
	defK := sp.st.Settings.WorkerKind
	routerM := sp.st.Settings.RouterMachine
	sp.mu.Unlock()

	wantK := requestedKind
	if wantK == "" {
		wantK = defK
	}
	if wantK == "" {
		wantK = "codex"
	}

	// Tier 4: Settings default computer if online and quota-healthy for wantK.
	if dm, err := sp.s.herdr.machine(defM); err == nil {
		if ok, rk := sp.machineCanRun(dm, wantK, true); ok {
			return dm.ID, rk
		}
		// If kind wasn't explicitly requested, try another healthy agent on the default computer first.
		if requestedKind == "" {
			if ok, rk := sp.machineCanRun(dm, "", true); ok {
				return dm.ID, rk
			}
		}
	}

	// Tier 3: Live availability & quota-healthy fallback across connected computers.
	all := sp.s.herdr.Machines()
	var cands []*Machine
	if routerM != "" {
		for i := range all {
			if all[i].ID == routerM {
				cands = append(cands, &all[i])
			}
		}
	}
	for i := range all {
		if !all[i].Local && all[i].ID != routerM {
			cands = append(cands, &all[i])
		}
	}
	for i := range all {
		if all[i].Local {
			cands = append(cands, &all[i])
		}
	}

	for _, m := range cands {
		if ok, rk := sp.machineCanRun(m, wantK, true); ok {
			return m.ID, rk
		}
	}
	if requestedKind == "" {
		for _, m := range cands {
			if ok, rk := sp.machineCanRun(m, "", true); ok {
				return m.ID, rk
			}
		}
	}
	// Last resort without strict quota filter so an unprobed setup still runs.
	for _, m := range cands {
		if ok, rk := sp.machineCanRun(m, wantK, false); ok {
			return m.ID, rk
		}
	}
	if requestedKind == "" {
		for _, m := range cands {
			if ok, rk := sp.machineCanRun(m, "", false); ok {
				return m.ID, rk
			}
		}
	}
	return defM, wantK
}

func (sp *Super) Spawn(kind, cwd, task, thread, name, by, machine, model, effort string, extraArgs []string, subscribe bool, resume string, explicitMachine ...bool) (*Worker, <-chan error, error) {
	isExplicit := len(explicitMachine) > 0 && explicitMachine[0]
	origKind := kind
	if !isExplicit && resume == "" {
		autoM, autoK := sp.resolveAutoWorkerTarget(kind)
		machine = autoM
		if kind == "" {
			kind = autoK
		}
	}
	m, err := sp.s.herdr.machine(machine)
	if err != nil {
		for _, km := range sp.s.allMachines() {
			if km.ID == machine && !km.Local && !km.Online {
				return nil, nil, fmt.Errorf("machine %s (%s) is currently offline", km.Name, km.ID)
			}
		}
		return nil, nil, fmt.Errorf("machine %q is not connected", machine)
	}
	if !m.Local && !m.Online {
		return nil, nil, fmt.Errorf("machine %s (%s) is currently offline", m.Name, m.ID)
	}
	if m.Local && !m.Online && len(localAgents(sp.s.home, false)) == 0 {
		return nil, nil, fmt.Errorf("hub is relay-only (no local herdr/agents); pick an online computer from `collie list`")
	}

	sp.mu.Lock()
	if kind == "" {
		kind = sp.st.Settings.WorkerKind
	}
	if _, ok := kinds[kind]; !ok {
		sp.mu.Unlock()
		return nil, nil, fmt.Errorf("unknown kind %q (claude, codex, antigravity, gemini)", kind)
	}
	have := m.Agents
	if m.Local {
		have = localAgents(sp.s.home, false)
	}
	if have != nil && !slices.Contains(have, kinds[kind]) {
		// If kind wasn't explicitly specified, fall back to an installed healthy agent on m.
		if origKind == "" {
			if alt := sp.healthyFallbackKindOn(m, kind); alt != "" {
				kind, model, effort = alt, "", ""
			}
		}
		if have != nil && !slices.Contains(have, kinds[kind]) {
			sp.mu.Unlock()
			return nil, nil, fmt.Errorf("%s has no %s installed (it has: %s); pick another computer or kind", m.Name, kind, strings.Join(append(have, "none")[:max(len(have), 1)], ", "))
		}
	}

	// Quota-aware protection: if the chosen agent on `m` is known to be exhausted,
	// in arrears (e.g. DeepSeek negative balance), or unauthenticated, automatically
	// switch to a healthy agent on `m` (when available) so the task succeeds!
	var quotaRerouteNote string
	if resume == "" && sp.s != nil {
		if bad, why := sp.s.isAgentUnusableForDispatch(m.ID, kinds[kind]); bad {
			if alt := sp.healthyFallbackKindOn(m, kind); alt != "" {
				oldKind := kind
				kind, model, effort = alt, "", ""
				quotaRerouteNote = fmt.Sprintf("%s 上的 %s 当前不可用（%s），已自动改派给额度正常的 %s", firstNonEmpty(m.Name, "本机"), oldKind, why, alt)
			} else if origKind != "" {
				sp.mu.Unlock()
				return nil, nil, fmt.Errorf("%s on %s is currently unavailable (%s); recharge/sign in or pick another computer", kind, firstNonEmpty(m.Name, "hub"), why)
			}
		}
	}

	if cwd == "" {
		if m.ID == sp.st.Settings.WorkerMachine || (m.Local && sp.st.Settings.WorkerMachine == "") {
			cwd = sp.st.Settings.WorkerCwd
		} else {
			cwd = "~"
		}
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
	w := &Worker{Name: name, Kind: kind, Model: model, Effort: effort, Machine: m.ID, Cwd: dir, Task: task, Thread: thread, CreatedBy: by, CreatedAt: time.Now(), Status: "waiting", FirstTurn: "queued", Session: resume}
	sp.st.Workers[name] = w
	sp.st.recordWorkerStart(w, "starting", "")
	if subscribe {
		th := sp.threadLocked(thread)
		if !contains(th.Subscribers, name) {
			th.Subscribers = append(th.Subscribers, name)
		}
	}
	if quotaRerouteNote != "" {
		sp.addEntryLocked("event", thread, quotaRerouteNote, name, "info")
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
		args := append(resumeArgs(kinds[kind], resume), wargs...)
		if kinds[kind] == "claude" {
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
			sp.st.recordWorkerStart(w, "failed", w.Note)
			sp.addEntryLocked("event", thread, name+" 启动失败："+err.Error(), name, "error")
			sp.mu.Unlock()
			if !tell(err) {
				sp.Ingest("worker", thread, name, fmt.Sprintf("worker %s failed to start: %v", name, err), "", "", name)
			}
			return
		}
		w.Status = "waiting"
		sp.st.recordWorkerStart(w, "started", "")
		if blocked {
			w.Status = "blocked"
			sp.st.recordWorkerStart(w, "blocked", err.Error())
		}
		sp.ingestLocked("system", thread, routerName, workerBrief(bin, w), "", name, name)
		sp.mu.Unlock()
		tell(nil)
	}()
	return w, started, nil
}

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

func (w *Worker) briefHeader() string {
	return fmt.Sprintf("You are worker %q, managed by Collie (thread %s, dispatched %s). Your task:", w.Name, w.Thread, w.CreatedAt.UTC().Format(time.RFC3339Nano))
}

func workerBrief(bin string, w *Worker) string {
	return fmt.Sprintf(`%s

%s

How this works:
- Collie relays between you and the human, through %s report "…".
- When the task is done, report the outcome: what you found or changed, and where the details are.
- When you need what only the human can give (a decision, access), or the same failure keeps coming back after a few different approaches, report "BLOCKED: <what you need> · tried: <what you tried> · I'd pick: <your choice>". Collie decides or asks them, and tells you.
- Follow-ups for your thread arrive as messages starting with [collie].`, w.briefHeader(), strings.TrimSpace(w.Task), shellBin(bin))
}

func (sp *Super) Report(name, text string) error {
	sp.mu.Lock()
	defer sp.mu.Unlock()
	w := sp.st.Workers[name]
	if w == nil {
		return fmt.Errorf("unknown worker %s", name)
	}
	delete(sp.workerAskedAt, name)
	if w.FirstTurn != "" {
		w.FirstTurn = "reported"
	}
	w.LastReport, w.ReportAt = text, time.Now()
	sp.st.recordWorkerStart(w, "replied", "")
	sp.ingestLocked("worker", w.Thread, name, fmt.Sprintf("report from %s:\n%s", name, text), "", "", name)
	tone := "done"
	if strings.HasPrefix(strings.ToUpper(strings.TrimSpace(text)), "BLOCKED:") {
		tone = "blocked"
	}
	sp.addEntryLocked("event", w.Thread, name+" 回报："+clip(text, 160), name, tone)
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

// Keep the latest dispatch for each machine and agent even when a worker name is reused.
func (st *State) recordWorkerStart(w *Worker, result, detail string) {
	starts := st.WorkerStarts[w.Machine]
	if starts == nil {
		starts = map[string]workerStart{}
		st.WorkerStarts[w.Machine] = starts
	}
	kind := kinds[w.Kind]
	prev := starts[kind]
	if prev.At.After(w.CreatedAt) || (prev.At.Equal(w.CreatedAt) && prev.Result == "replied") {
		return
	}
	starts[kind] = workerStart{Name: w.Name, At: w.CreatedAt, Result: result, Detail: clip(strings.Join(strings.Fields(detail), " "), 140)}
}
