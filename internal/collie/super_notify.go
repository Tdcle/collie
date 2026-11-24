package collie

import (
	"context"
	"crypto/sha1"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode"
)

// ---------------------------------------------------------------- watchdog

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
		h := progressHash(res.Text)
		sp.mu.Lock()
		m := sp.lastScreen[w.Name]
		if m.hash != h {
			sp.lastScreen[w.Name] = screenMark{hash: h, since: time.Now()}
			sp.mu.Unlock()
			continue
		}
		fire := !m.flag && stall > 0 && time.Since(m.since) > stall
		if fire {
			m.flag = true
			sp.lastScreen[w.Name] = m
		}
		sp.mu.Unlock()
		if fire {
			sp.Ingest("system", w.Thread, "watchdog",
				fmt.Sprintf("watchdog: worker %s has shown no visible progress for %d min while 'working'. Inspect with `collie show %s`; send guidance, stop it, or tell the human.", w.Name, int(stall.Minutes()), w.Name), "", "", w.Name)
		}
	}
	sp.watchRouter(ctx, live, stall)
}

func (sp *Super) watchRouter(ctx context.Context, live map[string]liveAgent, stall time.Duration) {
	a, ok := live[routerName]
	if !ok || stall <= 0 || a.Status != "working" {
		sp.mu.Lock()
		delete(sp.lastScreen, routerName)
		if ok && (a.Status == "done" || a.Status == "idle") {
			sp.routerNudged = false
		}
		sp.mu.Unlock()
		return
	}
	res, err := sp.s.herdr.Read(ctx, a.Pane, "detection", "text", 0)
	if err != nil {
		return
	}
	h := progressHash(res.Text)
	sp.mu.Lock()
	m := sp.lastScreen[routerName]
	if m.hash != h {
		sp.lastScreen[routerName] = screenMark{hash: h, since: time.Now()}
		sp.mu.Unlock()
		return
	}
	if m.flag || time.Since(m.since) < stall {
		sp.mu.Unlock()
		return
	}
	m.flag = true
	sp.lastScreen[routerName] = m
	mins := int(time.Since(m.since).Minutes())
	if sp.routerNudged {
		sp.addEntryLocked("event", mainThread, fmt.Sprintf("Collie 连续卡住（%d 分钟没有响应，自动打断重试后仍未恢复）；可在顶部点击大脑配置切换模型/Agent，或在「设置」中重启 Collie", mins), routerName, "error")
		sp.mu.Unlock()
		return
	}
	sp.routerNudged = true
	sp.addEntryLocked("event", mainThread, fmt.Sprintf("Collie 卡住了 %d 分钟没有动静，已自动打断让它继续", mins), "", "info")
	sp.mu.Unlock()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		sp.s.herdr.Call(ctx, "pane.send_keys", map[string]any{"pane_id": a.Pane, "keys": []string{"esc"}}, nil)
		time.Sleep(2 * time.Second)
		if err := sp.s.herdr.Prompt(ctx, routerName, fmt.Sprintf("%s: nothing on your screen changed for %d min, so Collie interrupted it. Carry on with what you were doing; the events you had are still yours to handle. A command that hangs is a job for a worker: hand it over.", routerRetryMark, mins)); err != nil {
			log.Printf("router nudge: %v", err)
			return
		}
		sp.mu.Lock()
		if sp.routerAskedAt.IsZero() {
			sp.routerAskedAt = time.Now()
		}
		sp.mu.Unlock()
	}()
}

func progressHash(screen string) string {
	var b strings.Builder
	for _, l := range strings.Split(screen, "\n") {
		if strings.Contains(strings.ToLower(l), "esc to interrupt") || strings.Contains(strings.ToLower(l), "esc to cancel") {
			continue
		}
		b.WriteString(strings.Map(func(r rune) rune {
			if unicode.IsDigit(r) {
				return -1
			}
			return r
		}, l))
		b.WriteByte('\n')
	}
	return fmt.Sprintf("%x", sha1.Sum([]byte(b.String())))
}

// ---------------------------------------------------------------- outbox & notifications

func (sp *Super) queueNotifyLocked(role, text, tone string, re *Quote, check bool, opts ...string) {
	if sp.st.Settings.NotifyWebhook == "" && !sp.st.Settings.NotifyLark {
		return
	}
	if sp.st.Settings.NotifyLevel == "quiet" && role == "collie" && len(opts) == 0 && !check {
		return
	}
	hash := "/#/collie"
	btnLabel := "打开 Collie 对话"
	needsYou := tone == "blocked" || len(opts) > 0 || check
	if re != nil && re.Worker != "" {
		if w := sp.st.Workers[re.Worker]; w != nil && w.PaneID != "" && !w.Ended {
			hash = "/#/p/" + url.PathEscape(w.PaneID)
			if tone == "blocked" {
				btnLabel = "前往处理待确认提问"
			} else {
				btnLabel = "打开该任务会话"
			}
		}
	} else if needsYou {
		btnLabel = "前往处理确认"
	}
	sp.notifyBuf = append(sp.notifyBuf, notice{tone: tone, text: text, re: re, options: opts, check: check, hash: hash, btnLabel: btnLabel})
}

type notice struct {
	tone, text string
	re         *Quote
	options    []string
	check      bool
	title      string
	hash       string
	btnLabel   string
}

func (q *Quote) line() string {
	t := strings.Join(strings.Fields(q.Text), " ")
	return q.Who + "：" + clip(t, 60)
}

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
	if w := sp.st.Workers[id]; w != nil {
		return &Quote{Worker: w.Name, Who: w.Name, Text: w.Task}
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

func (sp *Super) collieQuoteLocked(id string) *Quote {
	if id == "" {
		return nil
	}
	for i := len(sp.st.Entries) - 1; i >= 0; i-- {
		if e := sp.st.Entries[i]; e.ID == id && e.Role == "collie" {
			return &Quote{Entry: e.ID, Who: "Collie", Text: clip(e.Text, 600)}
		}
	}
	if sp.db != nil {
		var raw string
		var e Entry
		if sp.db.QueryRow(`SELECT data FROM entries WHERE id = ?`, id).Scan(&raw) == nil &&
			json.Unmarshal([]byte(raw), &e) == nil && e.Role == "collie" {
			return &Quote{Entry: e.ID, Who: "Collie", Text: clip(e.Text, 600)}
		}
	}
	return nil
}

// pendingMaxAge bounds unanswered quick-option or --check prompts so forgotten
// topics from past weeks never pile up as stale badges.
const pendingMaxAge = 7 * 24 * time.Hour

// PendingItem is one Collie message in chat:main (--opt or --check) still
// awaiting the human's answer, review or dismissal.
type PendingItem struct {
	ID      string    `json:"id"`
	At      time.Time `json:"at"`
	Summary string    `json:"summary"`
	Options []string  `json:"options,omitempty"`
	Check   bool      `json:"check,omitempty"`
}

// Dismiss marks one pending message as handled/ignored by the human and persists it.
func (sp *Super) Dismiss(id string) {
	id = strings.TrimSpace(id)
	if id == "" {
		return
	}
	sp.mu.Lock()
	if sp.st.Dismissed == nil {
		sp.st.Dismissed = map[string]bool{}
	}
	changed := !sp.st.Dismissed[id]
	if changed {
		sp.st.Dismissed[id] = true
		sp.changed()
	}
	hasDB := sp.db != nil
	sp.mu.Unlock()
	if changed && hasDB {
		sp.flush()
	}
}

// pendingLocked computes unanswered --opt and --check Collie messages in chat:main.
func (sp *Super) pendingLocked(now time.Time) []PendingItem {
	es := sp.st.Entries
	var out []PendingItem
	for i, e := range es {
		if e.Role != "collie" || (e.Thread != "" && e.Thread != mainThread) || e.ID == "" {
			continue
		}
		if len(e.Options) == 0 && !e.Check {
			continue
		}
		if sp.st.Dismissed[e.ID] {
			continue
		}
		if !now.IsZero() && !e.At.IsZero() && now.Sub(e.At) > pendingMaxAge {
			continue
		}
		opts := cleanOptions(e.Options)
		if len(opts) == 0 && !e.Check {
			continue
		}
		resolved, otherCollie := false, false
		for j := i + 1; j < len(es); j++ {
			next := es[j]
			if next.Thread != "" && next.Thread != mainThread {
				continue
			}
			switch next.Role {
			case "user":
				reID := ""
				if next.Re != nil {
					reID = next.Re.Entry
				}
				if reID == e.ID || (reID == "" && !otherCollie) {
					resolved = true
				}
			case "collie":
				otherCollie = true
			}
			if resolved {
				break
			}
		}
		if !resolved {
			out = append(out, PendingItem{
				ID:      e.ID,
				At:      e.At,
				Summary: pendingSummary(e.Text, opts),
				Options: opts,
				Check:   len(opts) == 0 && e.Check,
			})
		}
	}
	return out
}

var (
	pendingFenceRe = regexp.MustCompile("(?s)```.*?```")
	pendingImgRe   = regexp.MustCompile(`\[image:[^\]]+\]`)
	pendingLinkRe  = regexp.MustCompile(`\[([^\]\n]+)\]\([^)\n]+\)`)
	pendingListRe  = regexp.MustCompile(`^\s*(?:[#>*•\-]+|\d+[.)])\s+`)
)

func pendingSummary(text string, opts []string) string {
	s := pendingFenceRe.ReplaceAllString(text, " ")
	s = pendingImgRe.ReplaceAllString(s, " ")
	s = pendingLinkRe.ReplaceAllString(s, "$1")
	var parts []string
	for _, l := range strings.Split(s, "\n") {
		l = strings.TrimSpace(pendingListRe.ReplaceAllString(l, ""))
		l = strings.TrimSpace(mdMarks.Replace(l))
		if l != "" {
			parts = append(parts, l)
		}
	}
	out := oneLine(strings.Join(parts, " "))
	if out == "" {
		out = strings.Join(opts, " / ")
	}
	return clip(out, 120)
}

func humanText(t string) string {
	if i := strings.Index(t, "\n\n[The human picked"); i >= 0 {
		t = t[:i]
	}
	if i := strings.Index(t, "\n\n[Project context"); i >= 0 {
		t = t[:i]
	}
	if i := strings.LastIndex(t, "附件：\n"); i >= 0 {
		t = strings.TrimSpace(t[:i]) + " 📎"
	}
	return strings.TrimSpace(t)
}

func (n notice) needsYou() bool {
	return n.tone == "blocked" || len(n.options) > 0 || n.check
}

func (n notice) label() string {
	if n.title != "" {
		return n.title
	}
	switch {
	case n.needsYou():
		return "Collie · 需要你"
	case n.tone == "error":
		return "Collie · 出错了"
	}
	return "Collie"
}

func noticesText(ns []notice) string {
	var parts []string
	for _, n := range ns {
		p := n.label() + "：" + clip(n.text, 400)
		if n.re != nil {
			p = "↩ " + n.re.line() + "\n" + p
		}
		if len(n.options) > 0 {
			p += "\n可选：" + strings.Join(n.options, " / ")
		}
		parts = append(parts, p)
	}
	return strings.Join(parts, "\n\n")
}

func (sp *Super) Seen(url string) {
	sp.mu.Lock()
	sp.seenAt = time.Now()
	if url != "" {
		sp.seenURL = url
	}
	sp.mu.Unlock()
}

func (sp *Super) SeenAway(url string) {
	sp.mu.Lock()
	sp.seenAt = time.Time{}
	if url != "" && sp.seenURL == "" {
		sp.seenURL = url
	}
	sp.mu.Unlock()
}

func (sp *Super) noteExternalSent(extID string) {
	if extID == "" {
		return
	}
	sp.mu.Lock()
	if sp.extSentAt == nil {
		sp.extSentAt = map[string]time.Time{}
	}
	sp.extSentAt[extID] = time.Now()
	sp.mu.Unlock()
}

func isLoopbackURL(u string) bool {
	low := strings.ToLower(u)
	return strings.Contains(low, "://127.0.0.1") || strings.Contains(low, "://localhost") || strings.Contains(low, "://[::1]")
}

func (sp *Super) notifyBaseURLLocked() string {
	if sp.seenURL != "" && !isLoopbackURL(sp.seenURL) {
		return strings.TrimRight(sp.seenURL, "/")
	}
	if sp.s != nil {
		for _, u := range sp.s.publicURLs {
			if u = strings.TrimSpace(u); u != "" {
				return strings.TrimRight(u, "/")
			}
		}
	}
	return strings.TrimRight(sp.seenURL, "/")
}

func (sp *Super) sendNotifications() {
	sp.mu.Lock()
	if len(sp.notifyBuf) == 0 || time.Since(sp.notifyAt) < 20*time.Second {
		sp.mu.Unlock()
		return
	}
	notices := sp.notifyBuf
	webhookURL, toLark := sp.st.Settings.NotifyWebhook, sp.st.Settings.NotifyLark
	looking := time.Since(sp.seenAt) < 75*time.Second
	base := sp.notifyBaseURLLocked()
	sp.notifyBuf, sp.notifyAt = nil, time.Now()
	sp.mu.Unlock()
	if looking {
		return
	}
	if toLark {
		if err := larkSend(notices, base); err != nil {
			log.Printf("notify lark: %v", err)
		}
	}
	if webhookURL != "" {
		if err := webhookSend(webhookURL, notices, base); err != nil {
			log.Printf("notify webhook: %v", err)
		}
	}
}

func (sp *Super) machineLabel(id string) string {
	if id == "" || sp.s == nil {
		return ""
	}
	for _, m := range sp.s.herdr.Machines() {
		if m.ID == id && m.Name != "" {
			return m.Name
		}
	}
	return id
}

func (sp *Super) manyMachines() bool {
	if sp.s == nil {
		return false
	}
	return len(sp.s.herdr.Machines()) > 1
}

func userQuoteOrNil(userText string) *Quote {
	clean := humanText(userText)
	if clean == "" {
		return nil
	}
	return &Quote{Who: "你", Text: clean}
}

func (sp *Super) paneLastReply(ctx context.Context, paneID string) (reply, userQ string) {
	if sp.s == nil || paneID == "" {
		return "", ""
	}
	qctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if pane, machine := split(paneID); machine != "" {
		if c, err := sp.s.herdr.Client(machine); err == nil {
			req, _ := http.NewRequestWithContext(qctx, "GET", "http://node/api/panes/"+url.PathEscape(pane)+"/last", nil)
			if resp, err := c.Do(req); err == nil {
				var out struct {
					Text string `json:"text"`
					User string `json:"user"`
				}
				json.NewDecoder(resp.Body).Decode(&out)
				resp.Body.Close()
				return out.Text, out.User
			}
		}
		return "", ""
	}
	var info struct {
		Agent agentDetail `json:"agent"`
	}
	if sp.s.herdr.Call(qctx, "agent.get", map[string]any{"target": paneID}, &info) == nil {
		if tr := sp.s.transcriptFor("notify:"+paneID, paneID, info.Agent, map[string]*transcript{}); tr != nil {
			tr.openTail()
			tr.update()
			msgs := tr.view()
			for i := len(msgs) - 1; i >= 0; i-- {
				if reply == "" && msgs[i].Kind == "assistant" {
					reply = msgs[i].Text
				} else if reply != "" && msgs[i].Kind == "user" {
					userQ = msgs[i].Text
					break
				}
			}
			if reply != "" {
				return reply, userQ
			}
		}
	}
	if res, err := sp.s.herdr.Read(qctx, paneID, "detection", "text", 0); err == nil {
		return tailLines(res.Text, 10), ""
	}
	return "", ""
}

func (sp *Super) externalLastReply(ctx context.Context, extID string) (reply, userQ string) {
	if sp.s == nil || extID == "" {
		return "", ""
	}
	qctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	local, machine := split(extID)
	if machine != "" {
		if c, err := sp.s.herdr.Client(machine); err == nil {
			req, _ := http.NewRequestWithContext(qctx, "GET", "http://node/api/external/"+url.PathEscape(local)+"/last", nil)
			if resp, err := c.Do(req); err == nil {
				var out struct {
					Text string `json:"text"`
					User string `json:"user"`
				}
				json.NewDecoder(resp.Body).Decode(&out)
				resp.Body.Close()
				return out.Text, out.User
			}
		}
		return "", ""
	}
	if e := sp.s.viewableByID(local); e != nil && e.path != "" {
		tr := sp.s.newChainedTranscript(e.path, e.format)
		tr.openTail()
		tr.update()
		msgs := tr.view()
		for i := len(msgs) - 1; i >= 0; i-- {
			if reply == "" && msgs[i].Kind == "assistant" {
				reply = msgs[i].Text
			} else if reply != "" && msgs[i].Kind == "user" {
				userQ = msgs[i].Text
				break
			}
		}
	}
	return reply, userQ
}

func (sp *Super) watchStandaloneSessions(ctx context.Context) {
	if sp.s == nil {
		return
	}
	sp.mu.Lock()
	enabled := sp.st.Settings.NotifyWebhook != "" || sp.st.Settings.NotifyLark
	level := sp.st.Settings.NotifyLevel
	due := time.Since(sp.sessionScanAt) >= 4*time.Second
	if enabled && due {
		sp.sessionScanAt = time.Now()
	}
	sp.mu.Unlock()
	if !enabled || !due {
		return
	}

	many := sp.manyMachines()
	metaSnap := sp.s.sessionMetaSnapshot()
	findMeta := func(kind, machine, session, fallback string) *SessionMeta {
		if ck := canonicalSessionKey(kind, machine, session); ck != "" {
			if m := metaSnap[ck]; m != nil {
				return m
			}
		}
		if fallback != "" {
			return metaSnap[fallback]
		}
		return nil
	}

	st := sp.s.state(ctx)
	var newNotices []notice
	if st.OK {
		sp.mu.Lock()
		seenMachines := map[string]bool{}
		for _, a := range st.Agents {
			seenMachines[a.Machine] = true
			if a.Name == routerName {
				continue
			}
			if w := sp.st.Workers[a.Name]; w != nil && !w.Ended {
				continue
			}
			meta := findMeta(a.Kind, a.Machine, a.Session, "p:"+a.PaneID)
			if meta != nil && meta.Deleted {
				continue
			}
			if !sp.panePrimed[a.Machine] {
				sp.paneWatch[a.PaneID] = a.Status
				continue
			}
			prev, ok := sp.paneWatch[a.PaneID]
			sp.paneWatch[a.PaneID] = a.Status

			name := strings.TrimSpace(a.Topic)
			if meta != nil && strings.TrimSpace(meta.Title) != "" {
				name = strings.TrimSpace(meta.Title)
			}
			if name == "" {
				name = firstNonEmpty(strings.TrimSpace(a.WorkspaceLabel), firstNonEmpty(a.Name, a.Kind))
			}
			prefix := name
			if many && a.Machine != "" {
				prefix = sp.machineLabel(a.Machine) + " · " + name
			}
			hash := "/#/p/" + url.PathEscape(a.PaneID)

			if a.Status == "blocked" && (!ok || prev != "blocked") {
				sp.mu.Unlock()
				reply, userQ := sp.paneLastReply(ctx, a.PaneID)
				sp.mu.Lock()
				body := formatSessionNoticeText(reply)
				if strings.TrimSpace(reply) == "" {
					body = "该会话正在等待你的确认或输入，点击下方按钮直达该会话处理。"
				}
				newNotices = append(newNotices, notice{
					tone: "blocked", title: prefix + " · 需要你确认",
					text: body, re: userQuoteOrNil(userQ), hash: hash, btnLabel: "前往处理提问",
				})
			} else if ok && (prev == "working" || prev == "starting") && (a.Status == "done" || a.Status == "idle") && level == "normal" {
				sp.mu.Unlock()
				reply, userQ := sp.paneLastReply(ctx, a.PaneID)
				sp.mu.Lock()
				newNotices = append(newNotices, notice{
					tone: "done", title: prefix + " · 已完成",
					text: formatSessionNoticeText(reply), re: userQuoteOrNil(userQ), hash: hash, btnLabel: "直达该会话",
				})
			}
		}
		for m := range seenMachines {
			sp.panePrimed[m] = true
		}
		sp.mu.Unlock()
	}

	extList := sp.s.collectAllExternal(true)
	sp.mu.Lock()
	seenExtMachines := map[string]bool{"": true}
	for _, m := range sp.s.herdr.Machines() {
		if !m.Local && m.Online {
			seenExtMachines[m.ID] = true
		}
	}
	for _, e := range extList {
		meta := findMeta(e.Kind, e.Machine, e.Session, "x:"+e.ID)
		if meta != nil && meta.Deleted {
			continue
		}
		curSt := "idle"
		if e.Live {
			curSt = firstNonEmpty(e.Status, "working")
		}
		if !sp.extPrimed[e.Machine] {
			sp.extWatch[e.ID] = extWatchSnap{status: curSt, updated: e.Updated}
			continue
		}
		prev, ok := sp.extWatch[e.ID]
		sp.extWatch[e.ID] = extWatchSnap{status: curSt, updated: e.Updated}

		sentAt, wasSent := sp.extSentAt[e.ID]
		if wasSent && time.Since(sentAt) > 30*time.Minute {
			delete(sp.extSentAt, e.ID)
			wasSent = false
		}
		if curSt == "working" && wasSent {
			delete(sp.extSentAt, e.ID)
		}

		name := strings.TrimSpace(e.Title)
		if meta != nil && strings.TrimSpace(meta.Title) != "" {
			name = strings.TrimSpace(meta.Title)
		}
		if name == "" && e.Cwd != "" {
			name = baseOfPath(e.Cwd)
		}
		if name == "" {
			name = e.Kind
		}
		prefix := name
		if many && e.Machine != "" {
			prefix = sp.machineLabel(e.Machine) + " · " + name
		}
		hash := "/#/x/" + url.PathEscape(e.ID)

		fastCompleted := wasSent && curSt == "idle" && e.Updated.After(sentAt.Add(-2*time.Second)) && (!ok || e.Updated.After(prev.updated))
		if curSt == "blocked" && (!ok || prev.status != "blocked") {
			delete(sp.extSentAt, e.ID)
			sp.mu.Unlock()
			reply, userQ := sp.externalLastReply(ctx, e.ID)
			sp.mu.Lock()
			body := formatSessionNoticeText(reply)
			if strings.TrimSpace(reply) == "" {
				body = "该会话正在向你提问或等待确认，点击下方按钮直达该会话回复。"
			}
			newNotices = append(newNotices, notice{
				tone: "blocked", title: prefix + " · 需要你确认",
				text: body, re: userQuoteOrNil(userQ), hash: hash, btnLabel: "前往处理提问",
			})
		} else if ((ok && prev.status == "working" && (curSt == "idle" || curSt == "done")) || fastCompleted) && level == "normal" {
			delete(sp.extSentAt, e.ID)
			sp.mu.Unlock()
			reply, userQ := sp.externalLastReply(ctx, e.ID)
			sp.mu.Lock()
			newNotices = append(newNotices, notice{
				tone: "done", title: prefix + " · 已完成",
				text: formatSessionNoticeText(reply), re: userQuoteOrNil(userQ), hash: hash, btnLabel: "直达该会话",
			})
		}
	}
	for m := range seenExtMachines {
		sp.extPrimed[m] = true
	}
	if len(newNotices) > 0 {
		sp.notifyBuf = append(sp.notifyBuf, newNotices...)
	}
	sp.mu.Unlock()
}
