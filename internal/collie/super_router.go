package collie

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

func (sp *Super) routerDir() string { return filepath.Join(sp.dir, "router") }

func (sp *Super) ensureRouter(ctx context.Context) {
	if sp.s == nil || sp.s.herdr == nil {
		return
	}
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

		// Inspect any stale Router pane before closing it so if the previous
		// Router crashed at startup (e.g. auth/network timeout), the human sees
		// the exact reason instead of silent repeated wakeups.
		sp.inspectAndCloseStaleRouterWorkspaces(context.Background())
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
		sp.routerActiveMachine = machineID
		where := kind
		if !targetMachine.Local && targetMachine.Name != "" {
			where = kind + " @ " + targetMachine.Name
		}
		if st.RouterMachine != "" && machineID != st.RouterMachine && !(st.RouterMachine == "hub" && machineID == "") {
			primaryName := st.RouterMachine
			for _, km := range sp.s.allMachines() {
				if km.ID == st.RouterMachine && km.Name != "" {
					primaryName = km.Name
					break
				}
			}
			sp.addEntryLocked("event", mainThread, fmt.Sprintf("首选电脑 %s 当前离线，Collie 已自动漂移至在线电脑 %s（%s）响应", primaryName, firstNonEmpty(targetMachine.Name, "Hub"), kind), routerName, "info")
		} else {
			sp.addEntryLocked("event", mainThread, "Collie 已唤醒（"+where+"）", routerName, "info")
		}
	}()
}

// maybeSwitchBackRouter migrates Collie's Router cleanly back to the configured
// primary RouterMachine once that machine returns online and the temporary
// failover Router is idle, pulling back any memory updates first.
func (sp *Super) maybeSwitchBackRouter(ctx context.Context, cur liveAgent, hasPending bool) {
	if hasPending || sp.handingOver() || sp.dreaming() {
		return
	}
	_, curM := split(cur.Pane)
	sp.mu.Lock()
	wantM := sp.st.Settings.RouterMachine
	busy := sp.routerLaunching || !sp.routerAskedAt.IsZero()
	sp.mu.Unlock()
	if busy || wantM == "" {
		return
	}
	wantNorm := wantM
	if wantNorm == "hub" {
		wantNorm = ""
	}
	if curM == wantNorm {
		return
	}
	// Check whether primary RouterMachine is now online & usable.
	target, _, err := sp.resolveRouterTarget(sp.settings())
	if err != nil || target == nil || target.ID != wantNorm {
		return
	}
	// Primary is back! Pull memory written during failover, close temporary
	// failover Router workspace, and clear routerActiveMachine so next turn wakes on primary.
	if curM != "" {
		_, _ = sp.pullRouterFromNode(ctx, curM, "", "", "", 0)
	}
	var p Pane
	if sp.s.herdr.Call(ctx, "pane.get", map[string]any{"pane_id": cur.Pane}, &struct {
		Pane *Pane `json:"pane"`
	}{&p}) == nil && p.WorkspaceID != "" {
		_ = sp.s.herdr.Call(ctx, "workspace.close", map[string]any{"workspace_id": p.WorkspaceID}, nil)
	}
	sp.mu.Lock()
	sp.routerActiveMachine = ""
	sp.routerLaunchAt = time.Time{}
	sp.mu.Unlock()
	log.Printf("router: primary machine %s is back online; released temporary failover on %s", firstNonEmpty(target.Name, "hub"), firstNonEmpty(curM, "hub"))
}

func (sp *Super) recordRouterLaunchErrorLocked(err error) {
	msg := "Collie 启动失败：" + err.Error()
	if strings.Contains(err.Error(), "没装") {
		msg += "。装上它，或在页面顶部 / 设置 → Collie 全局配置 里换一个电脑或 agent"
	}
	for i := len(sp.st.Entries) - 1; i >= 0 && i >= len(sp.st.Entries)-6; i-- {
		e := sp.st.Entries[i]
		if e.Role == "user" || e.Role == "collie" {
			break
		}
		if e.Text == msg && time.Since(e.At) < 10*time.Minute {
			return
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
	sp.closeStaleRouterWorkspaces(ctx)
	sp.mu.Lock()
	sp.routerLaunchAt = time.Time{}
	sp.routerActiveMachine = ""
	sp.routerAskedAt = time.Time{}
	sp.routerFresh = false
	sp.routerRetries = 0
	sp.routerNudged = false
	sp.mu.Unlock()
	sp.ensureRouter(ctx)
	return nil
}

const routerReadFile = ".router-read.md"

func (sp *Super) routerDocChanged(dir string, doc []byte) {
	read, err := os.ReadFile(filepath.Join(dir, routerReadFile))
	if err != nil || bytes.Equal(read, doc) {
		return
	}
	os.WriteFile(filepath.Join(dir, routerReadFile), doc, 0o600)
	sp.mu.Lock()
	defer sp.mu.Unlock()
	if t := sp.rereadTrig; t != nil && t.Status == "queued" {
		return
	}
	sp.rereadTrig = sp.ingestLocked("system", mainThread, "collie", "ROUTER.md changed (a new Collie build or new settings). Re-read it now and work by it from here on. Nothing to tell the human.", "", "", "")
}

func (sp *Super) followLocked() *followView {
	var f *followView
	for _, t := range sp.st.Timers {
		if t.Enabled && t.Owner != "you" && (strings.HasPrefix(t.Spec, "in ") || strings.HasPrefix(t.Spec, "at ")) && t.NextRun.After(time.Now()) {
			if f == nil || t.NextRun.Before(f.Next) {
				f = &followView{Next: t.NextRun, NextText: clip(firstLine(t.Text), 80)}
			}
		}
	}
	return f
}

func (sp *Super) routerReadsFresh() {
	dir := sp.routerDir()
	if b, err := os.ReadFile(filepath.Join(dir, "ROUTER.md")); err == nil {
		os.WriteFile(filepath.Join(dir, routerReadFile), b, 0o600)
	}
	sp.mu.Lock()
	if t := sp.rereadTrig; t != nil && t.Status == "queued" {
		t.Status = "ignored"
	}
	sp.rereadTrig = nil
	sp.mu.Unlock()
}

func (sp *Super) writeRouterFiles() error {
	sp.mu.Lock()
	st := sp.st.Settings
	sp.mu.Unlock()
	m, _, _ := sp.resolveRouterTarget(st)
	if st.RouterMachine != "" && (m == nil || m.ID != st.RouterMachine) {
		return nil
	}
	if sp.s != nil && sp.s.herdr != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		live, ok := sp.liveAgents(ctx)
		cancel()
		if ok {
			if _, alive := live[routerName]; !alive {
				_ = os.Remove(filepath.Join(sp.routerDir(), routerReadFile))
			}
		}
	}
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
	doc := strings.NewReplacer("{{LAYOUT}}", layout, "{{BIN}}", shellBin(rbin), "{{WORDS}}", fmt.Sprint(words), "{{WKIND}}", wkind, "{{WCWD}}", wcwd, "{{BUDGET}}", fmt.Sprint(upFrontBudget>>10)).Replace(routerDoc)
	for _, name := range []string{"ROUTER.md", "CLAUDE.md", "AGENTS.md", "GEMINI.md"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(doc), 0o600); err != nil {
			return err
		}
	}
	sp.routerDocChanged(dir, []byte(doc))
	perms, _ := json.MarshalIndent(map[string]any{"permissions": map[string]any{
		"allow": collieAllow(rbin, append(memoryRules(rdirOn),
			"Bash(herdr agent read:*)", "Bash(herdr agent list:*)", "Bash(herdr agent get:*)", "Bash(herdr pane read:*)")...),
	}}, "", "  ")
	os.MkdirAll(filepath.Join(dir, ".claude"), 0o700)
	if err := os.WriteFile(filepath.Join(dir, ".claude", "settings.json"), perms, 0o600); err != nil {
		return err
	}
	sp.ensureMemory()
	return nil
}

func (sp *Super) trustOwnDir(ctx context.Context, pane string) {
	if sp.s != nil && sp.s.herdr != nil {
		_ = sp.s.herdr.unlockCodexPane(ctx, pane)
	}
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
	rr, err := sp.s.herdr.Read(ctx, pane, "detection", "text", 0)
	if err != nil || !trustDialogFor(rr.Text, dir, tld) {
		return false
	}
	for _, c := range parseApproval(rr.Text).Choices {
		if isTrustChoice(c.Label) {
			if sp.choose(ctx, pane, c) == nil {
				sp.mu.Lock()
				sp.noteAnsweredLocked(pane)
				sp.mu.Unlock()
				return true
			}
			return false
		}
	}
	return false
}

func isTrustChoice(label string) bool {
	l := strings.ToLower(strings.TrimSpace(label))
	if strings.HasPrefix(l, "yes") && strings.Contains(l, "trust") {
		return true
	}
	return strings.HasPrefix(l, "trust and continue") || l == "trust"
}

func (sp *Super) noteAnsweredLocked(pane string) {
	if pane == "" {
		return
	}
	if sp.lastAnswer == nil {
		sp.lastAnswer = map[string]time.Time{}
	}
	sp.lastAnswer[pane] = time.Now()
}

func (sp *Super) choose(ctx context.Context, pane string, c Choice) error {
	if len(c.Keys) > 0 {
		return sp.s.herdr.Call(ctx, "pane.send_keys", map[string]any{"pane_id": pane, "keys": c.Keys}, nil)
	}
	if c.Text != "" {
		return sp.s.herdr.Call(ctx, "pane.send_text", map[string]any{"pane_id": pane, "text": c.Text}, nil)
	}
	return sp.s.herdr.Call(ctx, "pane.send_keys", map[string]any{"pane_id": pane, "keys": []string{"enter"}}, nil)
}

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

func (sp *Super) inspectAndCloseStaleRouterWorkspaces(ctx context.Context) {
	wss, err := sp.s.herdr.Workspaces(ctx)
	if err != nil {
		return
	}
	var staleWS []string
	for _, ws := range wss {
		if ws.Label == routerLabel {
			staleWS = append(staleWS, ws.ID)
		}
	}
	if len(staleWS) == 0 {
		return
	}
	panes, _ := sp.s.herdr.Panes(ctx)
	for _, p := range panes {
		if !contains(staleWS, p.WorkspaceID) || p.Agent != nil {
			continue
		}
		if res, err := sp.s.herdr.Read(ctx, p.ID, "recent_unwrapped", "text", 30); err == nil {
			if why := deathReason(res.Text); why != "" {
				sp.mu.Lock()
				sp.recordRouterLaunchErrorLocked(errors.New(why))
				sp.mu.Unlock()
			}
		}
	}
	for _, wsID := range staleWS {
		sp.s.herdr.Call(ctx, "workspace.close", map[string]any{"workspace_id": wsID}, nil)
	}
}

var agentErrRe = regexp.MustCompile(`(?i)(api error|please run /login|invalid api key|quota exceeded|daily limit|rate.?limit(ed)?\b|overloaded|unauthori[sz]ed|credit balance|unexpected status \d{3}|^[\W]*(⚠|■|error\b|error:))`)

func (sp *Super) routerSettled(ctx context.Context, pane string) {
	sp.mu.Lock()
	asked := sp.routerAskedAt
	if asked.IsZero() || time.Since(asked) < 4*time.Second {
		sp.mu.Unlock()
		return
	}
	sp.routerAskedAt = time.Time{}
	sp.lastRouter = nil
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
		if n := sp.routerRetries; n < len(routerRetryWait) {
			sp.routerRetries++
			wait := routerRetryWait[n]
			sp.addEntryLocked("event", mainThread, fmt.Sprintf("Collie 遇到 API 错误（%s），%s后自动重试", clip(msg, 80), waitText(wait)), "", "info")
			sp.mu.Unlock()
			go sp.retryRouter(wait, msg)
			return
		}
		sp.routerRetries = 0
		text := "Collie 出错了：" + msg + "（自动重试了 " + fmt.Sprint(len(routerRetryWait)) + " 次都没好；可以在顶部大脑配置里换一个电脑或 agent）"
		for i := len(sp.st.Entries) - 1; i >= 0 && i >= len(sp.st.Entries)-6; i-- {
			if e := sp.st.Entries[i]; e.Text == text && time.Since(e.At) < 10*time.Minute {
				sp.mu.Unlock()
				return
			}
		}
		sp.addEntryLocked("event", mainThread, text, routerName, "error")
		sp.mu.Unlock()
		return
	}
	sp.mu.Lock()
	sp.routerRetries = 0
	sp.mu.Unlock()
}

var routerRetryWait = []time.Duration{20 * time.Second, time.Minute, 3 * time.Minute}

const routerRetryMark = "[collie] Your last turn stopped"

func waitText(d time.Duration) string {
	if d < time.Minute {
		return fmt.Sprintf("%d 秒", int(d.Seconds()))
	}
	return fmt.Sprintf("%d 分钟", int(d.Minutes()))
}

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
		sp.routerAskedAt = time.Now()
	}
	sp.mu.Unlock()
}

func (sp *Super) routerArgsLocked() []string {
	st := sp.st.Settings
	args := append(append([]string{}, st.RouterArgs...), modelArgs(st.RouterKind, st.RouterModel, st.RouterEffort)...)
	return withBypass(args, st.RouterKind, st.AskPermissions)
}

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
