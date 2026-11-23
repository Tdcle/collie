package collie

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// QuotaBucket represents a single metered model or rate-limit window bar.
type QuotaBucket struct {
	ID           string  `json:"id"`
	Label        string  `json:"label"`
	Model        string  `json:"model,omitempty"`
	RemainingPct float64 `json:"remaining_pct"`
	UsedPct      float64 `json:"used_pct"`
	WindowMins   int     `json:"window_mins,omitempty"`
	ResetsAt     string  `json:"resets_at,omitempty"`
	Note         string  `json:"note,omitempty"`
}

// AgentQuota represents remaining usage/quota for one agent CLI/App on one computer.
type AgentQuota struct {
	Kind         string        `json:"kind"`
	Status       string        `json:"status"` // "ok" | "balance" | "exhausted" | "api_key" | "unauthed" | "offline_app" | "unsupported" | "error"
	Plan         string        `json:"plan,omitempty"`
	Provider     string        `json:"provider,omitempty"`
	Model        string        `json:"model,omitempty"`
	Balance      string        `json:"balance,omitempty"`
	BalanceOK    *bool         `json:"balance_ok,omitempty"`
	ResetCredits int           `json:"reset_credits,omitempty"`
	Note         string        `json:"note,omitempty"`
	Buckets      []QuotaBucket `json:"buckets,omitempty"`
	Source       string        `json:"source,omitempty"`
	UpdatedAt    time.Time     `json:"updated_at"`
}

// MachineQuota groups all installed agents' quotas for one computer.
type MachineQuota struct {
	ID        string       `json:"id"`
	Name      string       `json:"name"`
	OS        string       `json:"os"`
	Online    bool         `json:"online"`
	Relay     bool         `json:"relay,omitempty"`
	Cached    bool         `json:"cached,omitempty"`
	UpdatedAt time.Time    `json:"updated_at"`
	Agents    []AgentQuota `json:"agents"`
}

var localQuotaCache struct {
	sync.Mutex
	at   time.Time
	data MachineQuota
}

var hubQuotaState = struct {
	sync.Mutex
	at         time.Time
	refreshing bool
	online     string
	list       []MachineQuota
	lastMap    map[string]MachineQuota
}{
	lastMap: map[string]MachineQuota{},
}

func clampPct(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	if v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	return math.Round(v*10) / 10
}

func agentStatusRank(st string) int {
	switch st {
	case "ok", "balance", "exhausted":
		return 1
	case "api_key":
		return 2
	case "offline_app", "unsupported", "error":
		return 3
	case "unauthed":
		return 4
	default:
		return 5
	}
}

var agentDisplayOrder = map[string]int{
	"codex":  0,
	"claude": 1,
	"agy":    2,
	"gemini": 3,
}

// nodeQuota serves GET /api/quota on a node (or local machine).
func (s *Server) nodeQuota(w http.ResponseWriter, r *http.Request) {
	fresh := r.URL.Query().Get("fresh") != ""
	mq := s.localMachineQuota(r.Context(), fresh)
	writeJSON(w, 200, mq)
}

func (s *Server) localMachineQuota(parent context.Context, fresh bool) MachineQuota {
	localQuotaCache.Lock()
	if !fresh && !localQuotaCache.at.IsZero() && time.Since(localQuotaCache.at) < 45*time.Second {
		cp := localQuotaCache.data
		localQuotaCache.Unlock()
		return cp
	}
	localQuotaCache.Unlock()

	agents := localAgents(s.home, fresh)
	results := make([]AgentQuota, len(agents))
	var wg sync.WaitGroup
	for i, kind := range agents {
		wg.Add(1)
		go func(idx int, k string) {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(parent, 8*time.Second)
			defer cancel()
			var q AgentQuota
			switch k {
			case "codex":
				q = s.collectCodexQuota(ctx)
			case "claude":
				q = s.collectClaudeQuota(ctx)
			case "agy":
				q = s.collectAgyQuota(ctx)
			case "gemini":
				q = s.collectGeminiQuota(ctx)
			default:
				q = AgentQuota{Kind: k, Status: "unsupported", UpdatedAt: time.Now()}
			}
			q.Kind = k
			if q.UpdatedAt.IsZero() {
				q.UpdatedAt = time.Now()
			}
			results[idx] = q
		}(i, kind)
	}
	wg.Wait()

	sort.SliceStable(results, func(i, j int) bool {
		ri, rj := agentStatusRank(results[i].Status), agentStatusRank(results[j].Status)
		if ri != rj {
			return ri < rj
		}
		return agentDisplayOrder[results[i].Kind] < agentDisplayOrder[results[j].Kind]
	})

	name := ""
	if s.herdr != nil && s.herdr.local != nil {
		name = s.herdr.local.Name
	}
	mq := MachineQuota{
		Name:      name,
		OS:        runtime.GOOS + "/" + runtime.GOARCH,
		Online:    true,
		UpdatedAt: time.Now(),
		Agents:    results,
	}

	localQuotaCache.Lock()
	localQuotaCache.at = mq.UpdatedAt
	localQuotaCache.data = mq
	localQuotaCache.Unlock()
	return mq
}

// listQuotas serves GET /api/quotas on the Hub, fanning out to all connected computers.
func (s *Server) listQuotas(w http.ResponseWriter, r *http.Request) {
	fresh := r.URL.Query().Get("fresh") != ""
	out, at := s.collectClusterQuotas(r.Context(), fresh)
	writeJSON(w, 200, map[string]any{"machines": out, "updated_at": at})
}

func (s *Server) collectClusterQuotas(parent context.Context, fresh bool) ([]MachineQuota, time.Time) {
	machines := map[string]Machine{}
	var onlineSigParts []string
	if s.herdr != nil {
		for _, m := range s.herdr.Machines() {
			machines[m.ID] = m
			if m.ID != "" {
				onlineSigParts = append(onlineSigParts, fmt.Sprintf("%s:%v:%s", m.ID, m.Online, m.Name))
			}
		}
	}
	sort.Strings(onlineSigParts)
	onlineSig := strings.Join(onlineSigParts, "|")

	hubQuotaState.Lock()
	if !fresh && !hubQuotaState.at.IsZero() && time.Since(hubQuotaState.at) < 30*time.Second && hubQuotaState.online == onlineSig {
		list := hubQuotaState.list
		at := hubQuotaState.at
		hubQuotaState.Unlock()
		return list, at
	}
	hubQuotaState.Unlock()

	var paired []Device
	if s.auths != nil {
		for _, d := range s.auths.list() {
			if d.Kind == "machine" {
				paired = append(paired, d)
			}
		}
	}

	// Include Hub itself if it runs herdr locally or if there are no paired remote machines.
	herdrOK := false
	if s.herdr != nil && s.herdr.local != nil && s.herdr.local.conn != nil {
		hCtx, cancel := context.WithTimeout(parent, 1200*time.Millisecond)
		_, err := s.herdr.local.conn.call(hCtx, "workspace.list", nil)
		cancel()
		herdrOK = err == nil
	}
	includeHub := herdrOK || len(paired) == 0

	type slot struct {
		mq MachineQuota
		ok bool
	}
	total := len(paired)
	if includeHub {
		total++
	}
	slots := make([]slot, total)
	var wg sync.WaitGroup
	offset := 0
	if includeHub {
		offset = 1
		wg.Add(1)
		go func() {
			defer wg.Done()
			hCtx := parent
			var cancel context.CancelFunc
			if len(paired) > 0 {
				hCtx, cancel = context.WithTimeout(parent, 2200*time.Millisecond)
				defer cancel()
			}
			mq := s.localMachineQuota(hCtx, fresh)
			mq.ID = "hub"
			if mq.Name == "" {
				mq.Name = "Hub"
			}
			mq.Relay = !herdrOK
			hubQuotaState.Lock()
			hubQuotaState.lastMap["hub"] = mq
			hubQuotaState.Unlock()
			if len(paired) > 0 {
				routerOnHub := false
				if s.sup != nil {
					s.sup.mu.Lock()
					routerOnHub = s.sup.st.Settings.RouterMachine == "hub"
					s.sup.mu.Unlock()
				}
				hasConfigured := false
				for _, a := range mq.Agents {
					if a.Status == "ok" || a.Status == "balance" || a.Status == "exhausted" || a.Status == "api_key" {
						hasConfigured = true
						break
					}
				}
				if !routerOnHub && !hasConfigured {
					return
				}
			}
			slots[0] = slot{mq: mq, ok: true}
		}()
	}

	for i, dev := range paired {
		idx := offset + i
		m, known := machines[dev.ID]
		isOnline := known && m.Online
		wg.Add(1)
		go func(slotIdx int, d Device, mInfo Machine, online bool) {
			defer wg.Done()
			osName := d.OS
			if osName == "" {
				osName = "unknown"
			}
			if online && s.herdr != nil {
				if mq, err := s.fetchRemoteQuota(parent, d.ID, fresh); err == nil {
					mq.ID = d.ID
					mq.Name = d.Name
					if mq.OS == "" {
						mq.OS = osName
					}
					mq.Online = true
					mq.Cached = false
					if mq.UpdatedAt.IsZero() {
						mq.UpdatedAt = time.Now()
					}
					hubQuotaState.Lock()
					hubQuotaState.lastMap[d.ID] = mq
					hubQuotaState.Unlock()
					slots[slotIdx] = slot{mq: mq, ok: true}
					return
				}
			}
			hubQuotaState.Lock()
			cached, hasCached := hubQuotaState.lastMap[d.ID]
			hubQuotaState.Unlock()
			if hasCached {
				cached.ID = d.ID
				cached.Name = d.Name
				if cached.OS == "" {
					cached.OS = osName
				}
				cached.Online = online
				cached.Cached = true
				slots[slotIdx] = slot{mq: cached, ok: true}
				return
			}
			var ags []AgentQuota
			for _, k := range mInfo.Agents {
				ags = append(ags, AgentQuota{
					Kind:   k,
					Status: "offline_machine",
					Note:   "电脑当前离线",
				})
			}
			slots[slotIdx] = slot{
				mq: MachineQuota{
					ID:     d.ID,
					Name:   d.Name,
					OS:     osName,
					Online: online,
					Agents: ags,
				},
				ok: true,
			}
		}(idx, dev, m, isOnline)
	}
	wg.Wait()

	out := make([]MachineQuota, 0, total)
	for _, sl := range slots {
		if sl.ok {
			if sl.mq.Agents == nil {
				sl.mq.Agents = []AgentQuota{}
			}
			out = append(out, sl.mq)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Online != out[j].Online {
			return out[i].Online
		}
		return false
	})

	now := time.Now()
	hubQuotaState.Lock()
	hubQuotaState.at = now
	hubQuotaState.online = onlineSig
	hubQuotaState.list = out
	hubQuotaState.Unlock()
	return out, now
}

func (s *Server) ensureQuotaWarmAsync() {
	if s == nil || s.node {
		return
	}
	hubQuotaState.Lock()
	stale := hubQuotaState.at.IsZero() || time.Since(hubQuotaState.at) > 5*time.Minute
	busy := hubQuotaState.refreshing
	if stale && !busy {
		hubQuotaState.refreshing = true
	}
	hubQuotaState.Unlock()
	if stale && !busy {
		go func() {
			defer func() {
				hubQuotaState.Lock()
				hubQuotaState.refreshing = false
				hubQuotaState.Unlock()
			}()
			ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
			defer cancel()
			s.collectClusterQuotas(ctx, false)
		}()
	}
}

// isAgentUnusableForDispatch reports whether cached quota/auth telemetry shows
// that `kind` on `machineID` is exhausted, in arrears, or unauthenticated.
func (s *Server) isAgentUnusableForDispatch(machineID, kind string) (bool, string) {
	if s == nil {
		return false, ""
	}
	canon := kinds[kind]
	if canon == "" {
		canon = kind
	}
	key := machineID
	if key == "" {
		key = "hub"
	}
	s.ensureQuotaWarmAsync()
	hubQuotaState.Lock()
	mq, ok := hubQuotaState.lastMap[key]
	hubQuotaState.Unlock()
	if !ok {
		return false, ""
	}
	for _, a := range mq.Agents {
		if a.Kind != canon {
			continue
		}
		if a.Status == "exhausted" || (a.BalanceOK != nil && !*a.BalanceOK) {
			why := strings.TrimSpace(a.Note)
			if a.Balance != "" {
				if why != "" {
					why = a.Balance + "（" + why + "）"
				} else {
					why = "余额不足 " + a.Balance
				}
			} else if why == "" {
				why = "配额已耗尽"
			}
			return true, why
		}
		if a.Status == "unauthed" {
			return true, firstNonEmpty(a.Note, "尚未登录")
		}
		for _, b := range a.Buckets {
			if b.RemainingPct <= 0 {
				return true, b.Label + " 剩余 0%"
			}
		}
	}
	return false, ""
}

// machineQuotaBrief formats a compact one-line quota summary for `collie list`
// so Collie's Router sees live remaining quotas and arrears before dispatching.
func (s *Server) machineQuotaBrief(machineID string) string {
	if s == nil {
		return ""
	}
	key := machineID
	if key == "" {
		key = "hub"
	}
	s.ensureQuotaWarmAsync()
	hubQuotaState.Lock()
	mq, ok := hubQuotaState.lastMap[key]
	hubQuotaState.Unlock()
	if !ok || len(mq.Agents) == 0 {
		return ""
	}
	var parts []string
	for _, a := range mq.Agents {
		switch {
		case a.Status == "exhausted" || (a.BalanceOK != nil && !*a.BalanceOK):
			if a.Balance != "" {
				parts = append(parts, fmt.Sprintf("%s=UNAVAILABLE(%s)", a.Kind, a.Balance))
			} else {
				parts = append(parts, fmt.Sprintf("%s=EXHAUSTED", a.Kind))
			}
		case len(a.Buckets) > 0:
			minRem := a.Buckets[0].RemainingPct
			for _, b := range a.Buckets[1:] {
				if b.RemainingPct < minRem {
					minRem = b.RemainingPct
				}
			}
			parts = append(parts, fmt.Sprintf("%s=%.0f%%", a.Kind, minRem))
		case a.Balance != "":
			parts = append(parts, fmt.Sprintf("%s=%s", a.Kind, strings.ReplaceAll(a.Balance, " ", "")))
		case a.Status == "api_key":
			parts = append(parts, fmt.Sprintf("%s=api_key", a.Kind))
		case a.Status == "unauthed":
			parts = append(parts, fmt.Sprintf("%s=unauthed", a.Kind))
		}
	}
	return strings.Join(parts, ",")
}

// checkQuotaAlerts periodically checks connected computers' quotas and pushes a
// one-time Feishu/Webhook warning card per reset window when an agent drops
// <= 15% remaining or enters negative/zero API balance.
func (sp *Super) checkQuotaAlerts(parent context.Context) {
	if sp == nil || sp.s == nil || sp.db == nil {
		return
	}
	sp.mu.Lock()
	enabled := sp.st.Settings.NotifyWebhook != "" || sp.st.Settings.NotifyLark
	due := sp.quotaAlertAt.IsZero() || time.Since(sp.quotaAlertAt) >= 10*time.Minute
	if enabled && due {
		sp.quotaAlertAt = time.Now()
	}
	sp.mu.Unlock()
	if !enabled || !due {
		return
	}

	ctx, cancel := context.WithTimeout(parent, 12*time.Second)
	defer cancel()
	list, _ := sp.s.collectClusterQuotas(ctx, false)
	if len(list) == 0 {
		return
	}

	sent := map[string]string{}
	var raw string
	if sp.db.QueryRow(`SELECT v FROM kv WHERE k='quota_alerts_sent'`).Scan(&raw) == nil && raw != "" {
		_ = json.Unmarshal([]byte(raw), &sent)
	}
	changed := false
	activeKeys := map[string]bool{}
	var alerts []notice

	for _, m := range list {
		if !m.Online {
			continue
		}
		mName := firstNonEmpty(m.Name, m.ID)
		for _, a := range m.Agents {
			agLabel := map[string]string{"codex": "Codex", "claude": "Claude Code", "agy": "Antigravity", "gemini": "Gemini CLI"}[a.Kind]
			if agLabel == "" {
				agLabel = a.Kind
			}
			// 1. Negative / depleted gateway balance
			if a.Balance != "" && ((a.BalanceOK != nil && !*a.BalanceOK) || a.Status == "exhausted") {
				dedupKey := fmt.Sprintf("bal|%s|%s|%s", m.ID, a.Kind, a.Provider)
				activeKeys[dedupKey] = true
				if sent[dedupKey] != a.Balance {
					sent[dedupKey] = a.Balance
					changed = true
					alerts = append(alerts, notice{
						tone:     "error",
						title:    fmt.Sprintf("%s · %s 余额预警", mName, agLabel),
						text:     fmt.Sprintf("**%s** 上的 **%s**（%s）当前余额为 **%s**，%s。\nCollie 自动派活已自动避开该账户，请及时充值或切换配置。", mName, agLabel, firstNonEmpty(a.Provider, "API"), a.Balance, firstNonEmpty(a.Note, "可用余额不足")),
						hash:     "/#/collie?quotas=1",
						btnLabel: "打开控制台查看用量",
					})
				}
			}
			// 2. Low remaining percentage window (<= 15%)
			for _, b := range a.Buckets {
				if b.RemainingPct > 15 {
					continue
				}
				cycle := firstNonEmpty(b.ResetsAt, "current")
				tier := "low15"
				tone := "blocked"
				if b.RemainingPct <= 0 {
					tier = "zero"
					tone = "error"
				}
				dedupKey := fmt.Sprintf("pct|%s|%s|%s|%s", m.ID, a.Kind, b.ID, cycle)
				activeKeys[dedupKey] = true
				if sent[dedupKey] == "zero" || sent[dedupKey] == tier {
					continue
				}
				sent[dedupKey] = tier
				changed = true
				alerts = append(alerts, notice{
					tone:     tone,
					title:    fmt.Sprintf("%s · %s 配额剩余 %.0f%%", mName, agLabel, b.RemainingPct),
					text:     fmt.Sprintf("**%s** 上的 **%s**（%s）当前剩余 **%.0f%%**%s。", mName, agLabel, b.Label, b.RemainingPct, func() string { if a.ResetCredits > 0 { return fmt.Sprintf("（另有 %d 次免费重置额度可用）", a.ResetCredits) }; return "" }()),
					hash:     "/#/collie",
					btnLabel: "打开控制台查看用量",
				})
			}
		}
	}

	// Prune stale keys from old billing cycles so kv stays tiny.
	for k := range sent {
		if !activeKeys[k] && len(sent) > 64 {
			delete(sent, k)
			changed = true
		}
	}
	if changed {
		if b, err := json.Marshal(sent); err == nil {
			_, _ = sp.db.Exec(`INSERT INTO kv(k,v) VALUES('quota_alerts_sent',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, string(b))
		}
	}
	if len(alerts) > 0 {
		sp.mu.Lock()
		sp.notifyBuf = append(sp.notifyBuf, alerts...)
		sp.mu.Unlock()
	}
}

func (s *Server) fetchRemoteQuota(parent context.Context, machine string, fresh bool) (MachineQuota, error) {
	var mq MachineQuota
	client, err := s.herdr.Client(machine)
	if err != nil {
		return mq, err
	}
	u := "http://node/api/quota"
	if fresh {
		u += "?fresh=1"
	}
	ctx, cancel := context.WithTimeout(parent, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return mq, err
	}
	res, err := client.Do(req)
	if err != nil {
		return mq, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return mq, fmt.Errorf("node quota HTTP %d", res.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&mq); err != nil {
		return mq, err
	}
	return mq, nil
}

// ---------------------------------------------------------------- 1. Codex Quota

type codexRateWindow struct {
	UsedPercent        float64 `json:"usedPercent"`
	UsedPercentSnake   float64 `json:"used_percent"`
	WindowDurationMins *int    `json:"windowDurationMins"`
	WindowMinutesSnake *int    `json:"window_minutes"`
	ResetsAt           *int64  `json:"resetsAt"`
	ResetsAtSnake      *int64  `json:"resets_at"`
}

func (w codexRateWindow) used() float64 {
	if w.UsedPercent != 0 {
		return w.UsedPercent
	}
	return w.UsedPercentSnake
}

func (w codexRateWindow) mins() int {
	if w.WindowDurationMins != nil {
		return *w.WindowDurationMins
	}
	if w.WindowMinutesSnake != nil {
		return *w.WindowMinutesSnake
	}
	return 0
}

func (w codexRateWindow) resetISO() string {
	var ts int64
	if w.ResetsAt != nil {
		ts = *w.ResetsAt
	} else if w.ResetsAtSnake != nil {
		ts = *w.ResetsAtSnake
	}
	if ts <= 0 {
		return ""
	}
	return time.Unix(ts, 0).UTC().Format(time.RFC3339)
}

type codexRateSnapshot struct {
	LimitID             string           `json:"limitId"`
	LimitIDSnake        string           `json:"limit_id"`
	LimitName           string           `json:"limitName"`
	LimitNameSnake      string           `json:"limit_name"`
	NormalModelSlug     string           `json:"normalModelSlug"`
	Primary             *codexRateWindow `json:"primary"`
	Secondary           *codexRateWindow `json:"secondary"`
	PlanType            string           `json:"planType"`
	PlanTypeSnake       string           `json:"plan_type"`
	SpendControlReached *bool            `json:"spendControlReached"`
	Credits             *struct {
		HasCredits bool   `json:"hasCredits"`
		Unlimited  bool   `json:"unlimited"`
		Balance    string `json:"balance"`
	} `json:"credits"`
}

func (sn codexRateSnapshot) id() string {
	if sn.LimitID != "" {
		return sn.LimitID
	}
	return sn.LimitIDSnake
}

func (sn codexRateSnapshot) name() string {
	if sn.LimitName != "" {
		return sn.LimitName
	}
	if sn.LimitNameSnake != "" {
		return sn.LimitNameSnake
	}
	if sn.NormalModelSlug != "" {
		return sn.NormalModelSlug
	}
	return ""
}

func (sn codexRateSnapshot) plan() string {
	p := sn.PlanType
	if p == "" {
		p = sn.PlanTypeSnake
	}
	return formatCodexPlan(p)
}

func formatCodexPlan(p string) string {
	switch strings.ToLower(strings.TrimSpace(p)) {
	case "prolite", "pro_lite":
		return "Pro Lite"
	case "pro":
		return "Pro"
	case "plus":
		return "Plus"
	case "team":
		return "Team"
	case "business":
		return "Business"
	case "enterprise":
		return "Enterprise"
	case "edu":
		return "Edu"
	case "free":
		return "Free"
	default:
		if p == "" {
			return ""
		}
		return strings.ToUpper(p[:1]) + p[1:]
	}
}

func formatWindowLabel(mins int, prefix string) string {
	var w string
	switch {
	case mins == 300:
		w = "5 小时窗口"
	case mins == 1440:
		w = "每日额度"
	case mins == 10080:
		w = "每周额度"
	case mins > 0 && mins%1440 == 0:
		w = fmt.Sprintf("%d 天窗口", mins/1440)
	case mins > 0 && mins%60 == 0:
		w = fmt.Sprintf("%d 小时窗口", mins/60)
	case mins > 0:
		w = fmt.Sprintf("%d 分钟窗口", mins)
	default:
		w = "当前窗口"
	}
	if prefix != "" && !strings.EqualFold(prefix, "codex") {
		return prefix + " · " + w
	}
	return w
}

func (s *Server) collectCodexQuota(ctx context.Context) AgentQuota {
	q := AgentQuota{Kind: "codex", Provider: "OpenAI", UpdatedAt: time.Now()}
	codexHome := s.codexHome()

	// 1. Try live RPC via app-server socket or short-lived `codex app-server`.
	if raw := s.readCodexRateLimitsRPC(ctx); len(raw) > 0 {
		if parsed, ok := parseCodexRateLimitsResponse(raw); ok {
			parsed.Source = "live"
			parsed.UpdatedAt = time.Now()
			return parsed
		}
	}

	// 2. Fallback: scan latest rollout-*.jsonl in ~/.codex/sessions for `rate_limits`.
	if snap, ts, ok := readLatestCodexRolloutRateLimits(codexHome); ok {
		out := buildCodexQuotaFromSnapshots([]codexRateSnapshot{snap}, nil, 0)
		out.Source = "session_log"
		if !ts.IsZero() {
			out.UpdatedAt = ts
		} else {
			out.UpdatedAt = time.Now()
		}
		return out
	}

	// 3. Inspect auth.json / config.toml to distinguish API-key vs unauthenticated.
	authPath := filepath.Join(codexHome, "auth.json")
	if b, err := os.ReadFile(authPath); err == nil {
		var auth struct {
			APIKey string          `json:"OPENAI_API_KEY"`
			Tokens json.RawMessage `json:"tokens"`
		}
		if json.Unmarshal(b, &auth) == nil {
			if strings.TrimSpace(auth.APIKey) != "" {
				q.Status = "api_key"
				q.Plan = "API Key"
				q.Note = "使用 OpenAI API Key 按量计费"
				return q
			}
			if len(auth.Tokens) > 2 && string(auth.Tokens) != "null" {
				q.Status = "error"
				q.Note = "暂时无法连接 Codex 用量服务"
				return q
			}
		}
	}
	if os.Getenv("OPENAI_API_KEY") != "" {
		q.Status = "api_key"
		q.Plan = "API Key"
		q.Note = "使用 OpenAI API Key 按量计费"
		return q
	}
	q.Status = "unauthed"
	q.Note = "尚未登录 Codex 账号"
	return q
}

func parseCodexRateLimitsResponse(raw json.RawMessage) (AgentQuota, bool) {
	var resp struct {
		OrdinaryUsageAllowed *bool                        `json:"ordinaryUsageAllowed"`
		RateLimits           *codexRateSnapshot           `json:"rateLimits"`
		ByID                 map[string]codexRateSnapshot `json:"rateLimitsByLimitId"`
		ResetCredits         *struct {
			AvailableCount int `json:"availableCount"`
		} `json:"rateLimitResetCredits"`
	}
	if json.Unmarshal(raw, &resp) != nil {
		return AgentQuota{}, false
	}
	var snaps []codexRateSnapshot
	if len(resp.ByID) > 0 {
		keys := make([]string, 0, len(resp.ByID))
		for k := range resp.ByID {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool {
			if keys[i] == "codex" {
				return true
			}
			if keys[j] == "codex" {
				return false
			}
			return keys[i] < keys[j]
		})
		for _, k := range keys {
			sn := resp.ByID[k]
			if sn.LimitID == "" && sn.LimitIDSnake == "" {
				sn.LimitID = k
			}
			snaps = append(snaps, sn)
		}
	} else if resp.RateLimits != nil {
		snaps = append(snaps, *resp.RateLimits)
	}
	if len(snaps) == 0 {
		return AgentQuota{}, false
	}
	resetCnt := 0
	if resp.ResetCredits != nil {
		resetCnt = resp.ResetCredits.AvailableCount
	}
	out := buildCodexQuotaFromSnapshots(snaps, resp.OrdinaryUsageAllowed, resetCnt)
	return out, len(out.Buckets) > 0 || out.Balance != "" || out.Plan != ""
}

func buildCodexQuotaFromSnapshots(snaps []codexRateSnapshot, allowed *bool, resetCredits int) AgentQuota {
	q := AgentQuota{
		Kind:         "codex",
		Status:       "ok",
		Provider:     "OpenAI",
		ResetCredits: resetCredits,
		UpdatedAt:    time.Now(),
	}
	exhausted := allowed != nil && !*allowed
	for _, sn := range snaps {
		if q.Plan == "" {
			q.Plan = sn.plan()
		}
		if sn.SpendControlReached != nil && *sn.SpendControlReached {
			exhausted = true
		}
		prefix := sn.name()
		if prefix == "" && len(snaps) > 1 {
			prefix = sn.id()
		}
		addWin := func(tag string, w *codexRateWindow) {
			if w == nil {
				return
			}
			used := clampPct(w.used())
			rem := clampPct(100 - used)
			if rem <= 0 {
				exhausted = true
			}
			q.Buckets = append(q.Buckets, QuotaBucket{
				ID:           strings.Trim(sn.id()+"-"+tag, "-"),
				Label:        formatWindowLabel(w.mins(), prefix),
				Model:        sn.NormalModelSlug,
				RemainingPct: rem,
				UsedPct:      used,
				WindowMins:   w.mins(),
				ResetsAt:     w.resetISO(),
			})
		}
		addWin("primary", sn.Primary)
		addWin("secondary", sn.Secondary)
		if sn.Credits != nil && sn.Credits.HasCredits {
			if sn.Credits.Unlimited {
				q.Balance = "Unlimited Credits"
			} else if sn.Credits.Balance != "" && sn.Credits.Balance != "0" && sn.Credits.Balance != "0.00" {
				q.Balance = "$" + strings.TrimPrefix(sn.Credits.Balance, "$")
			}
		}
	}
	if exhausted {
		q.Status = "exhausted"
	}
	return q
}

func (s *Server) readCodexRateLimitsRPC(ctx context.Context) json.RawMessage {
	rpcCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	// Try running local daemon socket first on Unix for sub-50ms response.
	if runtime.GOOS != "windows" {
		sock := filepath.Join(s.codexHome(), "run", "app-server-control.sock")
		if _, err := os.Lstat(sock); err == nil {
			var d net.Dialer
			if conn, err := d.DialContext(rpcCtx, "unix", sock); err == nil {
				res := exchangeCodexRateLimits(rpcCtx, conn, conn)
				conn.Close()
				if len(res) > 0 {
					return res
				}
			}
		}
	}

	bin := findBin("codex", s.home)
	if bin == "" {
		return nil
	}
	cmd := exec.CommandContext(rpcCtx, bin, "-c", "check_for_update_on_startup=false", "app-server")
	hideCmd(cmd)
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil
	}
	if cmd.Start() != nil {
		return nil
	}
	defer func() {
		in.Close()
		if cmd.Process != nil {
			cmd.Process.Kill()
		}
		cmd.Wait()
	}()
	return exchangeCodexRateLimits(rpcCtx, in, out)
}

func exchangeCodexRateLimits(ctx context.Context, w io.Writer, r io.Reader) json.RawMessage {
	done := make(chan json.RawMessage, 1)
	go func() {
		send := func(v any) error {
			_, err := w.Write(append(jsonNoEscape(v), '\n'))
			return err
		}
		sc := bufio.NewScanner(r)
		sc.Buffer(make([]byte, 0, 64<<10), 4<<20)
		wait := func(id int) (json.RawMessage, bool) {
			for sc.Scan() {
				var m struct {
					ID     *int            `json:"id"`
					Method string          `json:"method"`
					Result json.RawMessage `json:"result"`
					Error  json.RawMessage `json:"error"`
				}
				if json.Unmarshal(sc.Bytes(), &m) == nil && m.ID != nil && *m.ID == id && m.Method == "" {
					if len(m.Error) > 0 && string(m.Error) != "null" {
						return nil, false
					}
					return m.Result, true
				}
			}
			return nil, false
		}
		if send(map[string]any{
			"id":     1,
			"method": "initialize",
			"params": map[string]any{
				"clientInfo":   map[string]any{"name": "collie", "version": "1.0"},
				"capabilities": map[string]any{"experimentalApi": true},
			},
		}) != nil {
			done <- nil
			return
		}
		if _, ok := wait(1); !ok {
			done <- nil
			return
		}
		_ = send(map[string]any{"method": "initialized", "params": map[string]any{}})
		if send(map[string]any{"id": 2, "method": "account/rateLimits/read", "params": map[string]any{}}) != nil {
			done <- nil
			return
		}
		res, _ := wait(2)
		done <- res
	}()
	select {
	case res := <-done:
		return res
	case <-ctx.Done():
		return nil
	}
}

func readLatestCodexRolloutRateLimits(codexHome string) (codexRateSnapshot, time.Time, bool) {
	sessDir := filepath.Join(codexHome, "sessions")
	type fmeta struct {
		path string
		mod  time.Time
	}
	var files []fmeta
	_ = filepath.WalkDir(sessDir, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(d.Name(), ".jsonl") {
			return nil
		}
		if info, err := d.Info(); err == nil {
			files = append(files, fmeta{path: path, mod: info.ModTime()})
		}
		return nil
	})
	sort.Slice(files, func(i, j int) bool { return files[i].mod.After(files[j].mod) })
	if len(files) > 4 {
		files = files[:4]
	}
	for _, fm := range files {
		f, err := os.Open(fm.path)
		if err != nil {
			continue
		}
		st, err := f.Stat()
		if err != nil {
			f.Close()
			continue
		}
		const tailBytes = 256 << 10
		if st.Size() > tailBytes {
			_, _ = f.Seek(st.Size()-tailBytes, io.SeekStart)
		}
		raw, _ := io.ReadAll(f)
		f.Close()
		lines := bytes.Split(raw, []byte("\n"))
		for i := len(lines) - 1; i >= 0; i-- {
			line := bytes.TrimSpace(lines[i])
			if len(line) == 0 || !bytes.Contains(line, []byte(`"rate_limits"`)) {
				continue
			}
			var ev struct {
				Timestamp string `json:"timestamp"`
				Payload   struct {
					RateLimits *codexRateSnapshot `json:"rate_limits"`
				} `json:"payload"`
			}
			if json.Unmarshal(line, &ev) == nil && ev.Payload.RateLimits != nil && (ev.Payload.RateLimits.Primary != nil || ev.Payload.RateLimits.Secondary != nil) {
				ts, _ := time.Parse(time.RFC3339Nano, ev.Timestamp)
				return *ev.Payload.RateLimits, ts, true
			}
		}
	}
	return codexRateSnapshot{}, time.Time{}, false
}

// ---------------------------------------------------------------- 2. Claude Code Quota

func (s *Server) collectClaudeQuota(ctx context.Context) AgentQuota {
	q := AgentQuota{Kind: "claude", Provider: "Anthropic", UpdatedAt: time.Now()}
	cfg := s.readClaudeSettings()

	baseURL := strings.TrimSpace(cfg.env("ANTHROPIC_BASE_URL"))
	authTok := strings.TrimSpace(cfg.env("ANTHROPIC_AUTH_TOKEN"))
	apiKey := strings.TrimSpace(cfg.env("ANTHROPIC_API_KEY"))
	cfgModel := strings.TrimSpace(cfg.Model)
	if cfgModel == "" {
		cfgModel = strings.TrimSpace(cfg.env("ANTHROPIC_MODEL"))
	}
	if cfgModel == "" {
		cfgModel = strings.TrimSpace(cfg.env("ANTHROPIC_DEFAULT_SONNET_MODEL"))
	}

	// Case A: Custom gateway / API key (e.g. DeepSeek, Moonshot, SiliconFlow, OpenRouter, custom proxy).
	if baseURL != "" || apiKey != "" {
		tok := authTok
		if tok == "" {
			tok = apiKey
		}
		if gq, handled := queryGatewayBalance(ctx, baseURL, tok, cfgModel); handled {
			return gq
		}
		host := "Anthropic API"
		if baseURL != "" {
			if u, err := url.Parse(baseURL); err == nil && u.Host != "" {
				host = u.Host
			} else {
				host = baseURL
			}
		}
		q.Status = "api_key"
		q.Provider = host
		q.Plan = "API Key"
		q.Model = cfgModel
		q.Note = "按量计费接口（无固定配额窗口）"
		return q
	}

	// Case B: Official Claude.ai OAuth subscription (Pro / Max / Team).
	oauthTok, subType := s.readClaudeOAuthToken(ctx, cfg)
	if oauthTok != "" {
		if uq, err := fetchAnthropicOAuthUsage(ctx, oauthTok, subType); err == nil {
			return uq
		} else {
			q.Status = "error"
			q.Plan = formatClaudeSub(subType)
			q.Note = "无法读取 Claude 用量：" + err.Error()
			return q
		}
	}

	q.Status = "unauthed"
	q.Note = "尚未登录账号或配置 API Key"
	return q
}

func queryGatewayBalance(ctx context.Context, baseURL, token, model string) (AgentQuota, bool) {
	q := AgentQuota{
		Kind:      "claude",
		Model:     model,
		Source:    "live",
		UpdatedAt: time.Now(),
	}
	if token == "" || baseURL == "" {
		return q, false
	}
	u, err := url.Parse(baseURL)
	if err != nil || u.Host == "" {
		return q, false
	}
	host := strings.ToLower(u.Host)
	origin := u.Scheme + "://" + u.Host

	switch {
	case strings.Contains(host, "deepseek.com"):
		q.Provider = "DeepSeek"
		q.Plan = "API 余额"
		reqCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		req, _ := http.NewRequestWithContext(reqCtx, "GET", origin+"/user/balance", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			q.Status = "api_key"
			q.Note = "DeepSeek 接口（暂无法查询余额）"
			return q, true
		}
		defer res.Body.Close()
		if res.StatusCode != 200 {
			q.Status = "api_key"
			q.Note = fmt.Sprintf("DeepSeek 接口（HTTP %d）", res.StatusCode)
			return q, true
		}
		var body struct {
			IsAvailable  bool `json:"is_available"`
			BalanceInfos []struct {
				Currency     string `json:"currency"`
				TotalBalance string `json:"total_balance"`
			} `json:"balance_infos"`
		}
		if json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&body) != nil || len(body.BalanceInfos) == 0 {
			q.Status = "api_key"
			q.Note = "DeepSeek 按量计费"
			return q, true
		}
		bi := body.BalanceInfos[0]
		sym := bi.Currency + " "
		if bi.Currency == "CNY" {
			sym = "¥ "
		} else if bi.Currency == "USD" {
			sym = "$ "
		}
		val, _ := strconv.ParseFloat(bi.TotalBalance, 64)
		avail := body.IsAvailable && val > 0
		q.Balance = sym + bi.TotalBalance
		q.BalanceOK = &avail
		if !avail {
			q.Status = "exhausted"
			if val < 0 {
				q.Note = "账户已欠费，请充值后使用"
			} else {
				q.Note = "账户可用余额不足"
			}
		} else {
			q.Status = "balance"
			if model != "" {
				q.Note = "默认模型 " + model
			}
		}
		return q, true

	case strings.Contains(host, "moonshot.cn") || strings.Contains(host, "moonshot.ai"):
		q.Provider = "Moonshot"
		q.Plan = "API 余额"
		reqCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		req, _ := http.NewRequestWithContext(reqCtx, "GET", origin+"/v1/users/me/balance", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		res, err := http.DefaultClient.Do(req)
		if err == nil {
			defer res.Body.Close()
			var body struct {
				Data struct {
					AvailableBalance float64 `json:"available_balance"`
				} `json:"data"`
			}
			if res.StatusCode == 200 && json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&body) == nil {
				avail := body.Data.AvailableBalance > 0
				q.Balance = fmt.Sprintf("¥ %.2f", body.Data.AvailableBalance)
				q.BalanceOK = &avail
				if avail {
					q.Status = "balance"
				} else {
					q.Status = "exhausted"
					q.Note = "账户可用余额不足"
				}
				return q, true
			}
		}
		return q, false

	case strings.Contains(host, "siliconflow.cn") || strings.Contains(host, "siliconflow.com"):
		q.Provider = "SiliconFlow"
		q.Plan = "API 余额"
		reqCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		req, _ := http.NewRequestWithContext(reqCtx, "GET", origin+"/v1/user/info", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		res, err := http.DefaultClient.Do(req)
		if err == nil {
			defer res.Body.Close()
			var body struct {
				Data struct {
					TotalBalance string `json:"totalBalance"`
				} `json:"data"`
			}
			if res.StatusCode == 200 && json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&body) == nil && body.Data.TotalBalance != "" {
				val, _ := strconv.ParseFloat(body.Data.TotalBalance, 64)
				avail := val > 0
				q.Balance = "¥ " + body.Data.TotalBalance
				q.BalanceOK = &avail
				if avail {
					q.Status = "balance"
				} else {
					q.Status = "exhausted"
				}
				return q, true
			}
		}
		return q, false

	case strings.Contains(host, "openrouter.ai"):
		q.Provider = "OpenRouter"
		q.Plan = "API 余额"
		reqCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		req, _ := http.NewRequestWithContext(reqCtx, "GET", "https://openrouter.ai/api/v1/credits", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		res, err := http.DefaultClient.Do(req)
		if err == nil {
			defer res.Body.Close()
			var body struct {
				Data struct {
					TotalCredits float64 `json:"total_credits"`
					TotalUsage   float64 `json:"total_usage"`
				} `json:"data"`
			}
			if res.StatusCode == 200 && json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&body) == nil {
				rem := body.Data.TotalCredits - body.Data.TotalUsage
				avail := rem > 0
				q.Balance = fmt.Sprintf("$ %.2f", rem)
				q.BalanceOK = &avail
				if avail {
					q.Status = "balance"
				} else {
					q.Status = "exhausted"
				}
				return q, true
			}
		}
		return q, false
	}

	return q, false
}

func formatClaudeSub(s string) string {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "max", "claude_max":
		return "Max"
	case "pro", "claude_pro":
		return "Pro"
	case "team", "claude_team":
		return "Team"
	case "enterprise":
		return "Enterprise"
	default:
		if s == "" {
			return "OAuth"
		}
		return s
	}
}

func (s *Server) readClaudeOAuthToken(ctx context.Context, cfg claudeSettings) (string, string) {
	if tok := strings.TrimSpace(cfg.env("CLAUDE_CODE_OAUTH_TOKEN")); tok != "" {
		return tok, ""
	}
	parseCreds := func(raw []byte) (string, string) {
		var doc struct {
			ClaudeAiOauth *struct {
				AccessToken      string `json:"accessToken"`
				SubscriptionType string `json:"subscriptionType"`
			} `json:"claudeAiOauth"`
		}
		if json.Unmarshal(raw, &doc) == nil && doc.ClaudeAiOauth != nil && doc.ClaudeAiOauth.AccessToken != "" {
			return doc.ClaudeAiOauth.AccessToken, doc.ClaudeAiOauth.SubscriptionType
		}
		return "", ""
	}
	root := envOr("CLAUDE_CONFIG_DIR", filepath.Join(s.home, ".claude"))
	for _, fn := range []string{".credentials.json", "credentials.json"} {
		if b, err := os.ReadFile(filepath.Join(root, fn)); err == nil {
			if tok, sub := parseCreds(b); tok != "" {
				return tok, sub
			}
		}
	}
	if runtime.GOOS == "darwin" {
		kCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		cmd := exec.CommandContext(kCtx, "security", "find-generic-password", "-s", "Claude Code-credentials", "-w")
		if out, err := cmd.Output(); err == nil {
			if tok, sub := parseCreds(bytes.TrimSpace(out)); tok != "" {
				return tok, sub
			}
		}
	}
	return "", ""
}

func fetchAnthropicOAuthUsage(ctx context.Context, token, subType string) (AgentQuota, error) {
	reqCtx, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, "GET", "https://api.anthropic.com/api/oauth/usage", nil)
	if err != nil {
		return AgentQuota{}, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("anthropic-beta", "oauth-2025-04-20")
	req.Header.Set("User-Agent", "claude-code/2.1.0")
	req.Header.Set("Accept", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return AgentQuota{}, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return AgentQuota{}, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	type win struct {
		Utilization *float64 `json:"utilization"`
		ResetsAt    string   `json:"resets_at"`
	}
	var body struct {
		FiveHour       *win `json:"five_hour"`
		SevenDay       *win `json:"seven_day"`
		SevenDaySonnet *win `json:"seven_day_sonnet"`
		SevenDayOpus   *win `json:"seven_day_opus"`
		ExtraUsage     *struct {
			IsEnabled    bool     `json:"is_enabled"`
			MonthlyLimit *float64 `json:"monthly_limit"`
			UsedCredits  *float64 `json:"used_credits"`
			Utilization  *float64 `json:"utilization"`
		} `json:"extra_usage"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 128<<10)).Decode(&body); err != nil {
		return AgentQuota{}, err
	}
	q := AgentQuota{
		Kind:      "claude",
		Status:    "ok",
		Provider:  "Anthropic",
		Plan:      formatClaudeSub(subType),
		Source:    "live",
		UpdatedAt: time.Now(),
	}
	exhausted := false
	add := func(id, label string, mins int, w *win) {
		if w == nil || w.Utilization == nil {
			return
		}
		used := clampPct(*w.Utilization)
		rem := clampPct(100 - used)
		if rem <= 0 && (id == "five_hour" || id == "seven_day") {
			exhausted = true
		}
		q.Buckets = append(q.Buckets, QuotaBucket{
			ID:           id,
			Label:        label,
			RemainingPct: rem,
			UsedPct:      used,
			WindowMins:   mins,
			ResetsAt:     w.ResetsAt,
		})
	}
	add("five_hour", "5 小时窗口", 300, body.FiveHour)
	add("seven_day", "每周总额度", 10080, body.SevenDay)
	add("seven_day_sonnet", "Sonnet 每周额度", 10080, body.SevenDaySonnet)
	add("seven_day_opus", "Opus 每周额度", 10080, body.SevenDayOpus)
	if body.ExtraUsage != nil && body.ExtraUsage.IsEnabled && body.ExtraUsage.MonthlyLimit != nil && body.ExtraUsage.UsedCredits != nil && *body.ExtraUsage.MonthlyLimit > 0 {
		remDollar := (*body.ExtraUsage.MonthlyLimit - *body.ExtraUsage.UsedCredits) / 100.0
		q.Balance = fmt.Sprintf("Extra $%.2f", math.Max(0, remDollar))
	}
	if exhausted {
		q.Status = "exhausted"
	}
	return q, nil
}

// ---------------------------------------------------------------- 3. Antigravity Quota

type agyModelConfig struct {
	Label        string `json:"label"`
	ModelOrAlias *struct {
		Model string `json:"model"`
	} `json:"modelOrAlias"`
	QuotaInfo *struct {
		RemainingFraction *float64 `json:"remainingFraction"`
		ResetTime         string   `json:"resetTime"`
	} `json:"quotaInfo"`
}

func (s *Server) collectAgyQuota(ctx context.Context) AgentQuota {
	q := AgentQuota{Kind: "agy", Provider: "Google", UpdatedAt: time.Now()}
	ls := agyDesktopServer()
	if ls == nil {
		q.Status = "offline_app"
		q.Note = "打开 Antigravity 桌面端后可读取实时模型配额"
		return q
	}
	raw, err := ls.call(ctx, "GetUserStatus", map[string]any{
		"metadata": map[string]any{"ideName": "antigravity", "extensionName": "antigravity"},
	})
	if err != nil {
		forgetAgyServer()
		q.Status = "offline_app"
		q.Note = "无法读取 Antigravity 语言服务状态"
		return q
	}
	parsed, ok := parseAgyUserStatus(raw)
	if !ok {
		q.Status = "error"
		q.Note = "未获取到模型配额信息"
		return q
	}
	return parsed
}

func parseAgyUserStatus(raw json.RawMessage) (AgentQuota, bool) {
	var resp struct {
		UserStatus struct {
			PlanStatus *struct {
				PlanInfo *struct {
					PlanName string `json:"planName"`
				} `json:"planInfo"`
			} `json:"planStatus"`
			UserTier *struct {
				Name string `json:"name"`
			} `json:"userTier"`
			G1Tier                 string `json:"g1Tier"`
			CascadeModelConfigData *struct {
				ClientModelConfigs []agyModelConfig `json:"clientModelConfigs"`
			} `json:"cascadeModelConfigData"`
		} `json:"userStatus"`
	}
	if json.Unmarshal(raw, &resp) != nil {
		return AgentQuota{}, false
	}
	q := AgentQuota{
		Kind:      "agy",
		Status:    "ok",
		Provider:  "Google",
		Source:    "live",
		UpdatedAt: time.Now(),
	}
	if resp.UserStatus.UserTier != nil && resp.UserStatus.UserTier.Name != "" {
		q.Plan = resp.UserStatus.UserTier.Name
	} else if resp.UserStatus.PlanStatus != nil && resp.UserStatus.PlanStatus.PlanInfo != nil && resp.UserStatus.PlanStatus.PlanInfo.PlanName != "" {
		q.Plan = resp.UserStatus.PlanStatus.PlanInfo.PlanName
	} else if resp.UserStatus.G1Tier != "" {
		q.Plan = resp.UserStatus.G1Tier
	}

	var cfgs []agyModelConfig
	if resp.UserStatus.CascadeModelConfigData != nil {
		cfgs = resp.UserStatus.CascadeModelConfigData.ClientModelConfigs
	}
	if len(cfgs) == 0 {
		return q, q.Plan != ""
	}

	// Group models sharing identical (family, remainingPct, resetTime) so shared pools stay clean.
	type poolKey struct {
		family string
		rem    float64
		reset  string
	}
	type pool struct {
		key    poolKey
		labels []string
	}
	var order []poolKey
	pools := map[poolKey]*pool{}
	allZero := true
	for _, mc := range cfgs {
		if mc.QuotaInfo == nil || mc.QuotaInfo.RemainingFraction == nil {
			continue
		}
		lbl := strings.TrimSpace(mc.Label)
		if lbl == "" && mc.ModelOrAlias != nil {
			lbl = mc.ModelOrAlias.Model
		}
		if lbl == "" {
			continue
		}
		rem := clampPct(*mc.QuotaInfo.RemainingFraction * 100)
		if rem > 0 {
			allZero = false
		}
		fam := agyModelFamily(lbl)
		pk := poolKey{family: fam, rem: rem, reset: mc.QuotaInfo.ResetTime}
		p, exists := pools[pk]
		if !exists {
			p = &pool{key: pk}
			pools[pk] = p
			order = append(order, pk)
		}
		p.labels = append(p.labels, lbl)
	}
	for i, pk := range order {
		p := pools[pk]
		title := pk.family
		if len(p.labels) == 1 {
			title = p.labels[0]
		}
		q.Buckets = append(q.Buckets, QuotaBucket{
			ID:           fmt.Sprintf("agy-%d", i),
			Label:        title,
			RemainingPct: pk.rem,
			UsedPct:      clampPct(100 - pk.rem),
			ResetsAt:     pk.reset,
		})
	}
	if len(q.Buckets) > 0 && allZero {
		q.Status = "exhausted"
	}
	return q, len(q.Buckets) > 0 || q.Plan != ""
}

func agyModelFamily(label string) string {
	l := strings.ToLower(label)
	switch {
	case strings.Contains(l, "claude"):
		return "Claude 系列"
	case strings.Contains(l, "flash"):
		return "Gemini Flash"
	case strings.Contains(l, "gemini") && strings.Contains(l, "pro"):
		return "Gemini Pro"
	case strings.Contains(l, "gpt"):
		return "GPT 系列"
	default:
		return label
	}
}

// ---------------------------------------------------------------- 4. Gemini CLI Quota

var (
	geminiOAuthOnce   sync.Once
	geminiClientIDVal string
	geminiClientSec   string
	geminiCIDRe       = regexp.MustCompile(`OAUTH_CLIENT_ID\s*=\s*"([^"]+)"`)
	geminiCSecRe      = regexp.MustCompile(`OAUTH_CLIENT_SECRET\s*=\s*"([^"]+)"`)
)

// discoverGeminiOAuthClient inspects the locally installed @google/gemini-cli
// bundle at runtime so no OAuth client identifiers are embedded in Collie's repo.
func discoverGeminiOAuthClient(home string) (string, string) {
	geminiOAuthOnce.Do(func() {
		bin := findBin("gemini", home)
		if bin == "" {
			return
		}
		realPath, err := filepath.EvalSymlinks(bin)
		if err != nil {
			realPath = bin
		}
		var dirs []string
		dirs = append(dirs, filepath.Dir(realPath))
		// On Windows npm installs gemini.cmd next to node_modules/@google/gemini-cli/bundle
		dirs = append(dirs, filepath.Join(filepath.Dir(realPath), "node_modules", "@google", "gemini-cli", "bundle"))
		for _, dir := range dirs {
			entries, err := os.ReadDir(dir)
			if err != nil {
				continue
			}
			for _, e := range entries {
				if e.IsDir() || !strings.HasSuffix(e.Name(), ".js") {
					continue
				}
				b, err := os.ReadFile(filepath.Join(dir, e.Name()))
				if err != nil {
					continue
				}
				if geminiClientIDVal == "" {
					if m := geminiCIDRe.FindSubmatch(b); len(m) == 2 {
						geminiClientIDVal = string(m[1])
					}
				}
				if geminiClientSec == "" {
					if m := geminiCSecRe.FindSubmatch(b); len(m) == 2 {
						geminiClientSec = string(m[1])
					}
				}
				if geminiClientIDVal != "" && geminiClientSec != "" {
					return
				}
			}
		}
	})
	return geminiClientIDVal, geminiClientSec
}

func (s *Server) collectGeminiQuota(ctx context.Context) AgentQuota {
	q := AgentQuota{Kind: "gemini", Provider: "Google", UpdatedAt: time.Now()}
	gemDir := filepath.Join(s.home, ".gemini")
	credsPath := filepath.Join(gemDir, "oauth_creds.json")

	rawCreds, err := os.ReadFile(credsPath)
	if err != nil {
		if os.Getenv("GEMINI_API_KEY") != "" || os.Getenv("GOOGLE_API_KEY") != "" {
			q.Status = "api_key"
			q.Plan = "API Key"
			q.Note = "使用 Gemini API Key 按量计费"
			return q
		}
		q.Status = "unauthed"
		q.Note = "尚未登录 Google 账号"
		return q
	}

	var creds struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiryDate   int64  `json:"expiry_date"`
	}
	if json.Unmarshal(rawCreds, &creds) != nil || (creds.AccessToken == "" && creds.RefreshToken == "") {
		q.Status = "unauthed"
		q.Note = "Google 登录凭证无效"
		return q
	}

	token := creds.AccessToken
	if (token == "" || creds.ExpiryDate < (time.Now().Unix()+60)*1000) && creds.RefreshToken != "" {
		if refreshed, err := refreshGoogleOAuth(ctx, s.home, creds.RefreshToken); err == nil && refreshed != "" {
			token = refreshed
		}
	}
	if token == "" {
		q.Status = "unauthed"
		q.Note = "Google OAuth 令牌已过期，请重新登录"
		return q
	}

	proj := strings.TrimSpace(os.Getenv("GOOGLE_CLOUD_PROJECT"))
	if proj == "" {
		proj = strings.TrimSpace(os.Getenv("GOOGLE_CLOUD_PROJECT_ID"))
	}
	if proj == "" {
		if sb, err := os.ReadFile(filepath.Join(gemDir, "settings.json")); err == nil {
			var gs struct {
				Project string            `json:"project"`
				Env     map[string]string `json:"env"`
			}
			if json.Unmarshal(sb, &gs) == nil {
				if gs.Project != "" {
					proj = gs.Project
				} else if gs.Env["GOOGLE_CLOUD_PROJECT"] != "" {
					proj = gs.Env["GOOGLE_CLOUD_PROJECT"]
				}
			}
		}
	}

	var tierName string
	if lca, err := callCloudCodeAPI(ctx, token, "loadCodeAssist", map[string]any{
		"metadata": map[string]any{"ideType": "GEMINI_CLI", "platform": "PLATFORM_UNSPECIFIED", "pluginType": "GEMINI"},
	}); err == nil {
		var lcaRes struct {
			Project     string `json:"cloudaicompanionProject"`
			CurrentTier *struct {
				Name string `json:"name"`
				ID   string `json:"id"`
			} `json:"currentTier"`
			IneligibleTiers []struct {
				ReasonCode    string `json:"reasonCode"`
				ReasonMessage string `json:"reasonMessage"`
			} `json:"ineligibleTiers"`
		}
		if json.Unmarshal(lca, &lcaRes) == nil {
			if proj == "" && lcaRes.Project != "" {
				proj = lcaRes.Project
			}
			if lcaRes.CurrentTier != nil {
				tierName = lcaRes.CurrentTier.Name
				if tierName == "" {
					tierName = lcaRes.CurrentTier.ID
				}
			}
			if proj == "" && len(lcaRes.IneligibleTiers) > 0 {
				q.Status = "unsupported"
				q.Plan = "Google OAuth"
				if lcaRes.IneligibleTiers[0].ReasonCode == "UNSUPPORTED_CLIENT" {
					q.Note = "免费个人版需配置 GOOGLE_CLOUD_PROJECT 或改用 Antigravity"
				} else {
					q.Note = lcaRes.IneligibleTiers[0].ReasonMessage
				}
				return q
			}
		}
	}

	if proj == "" {
		q.Status = "unsupported"
		q.Plan = "Google OAuth"
		q.Note = "未绑定 Google Cloud 项目（GOOGLE_CLOUD_PROJECT）"
		return q
	}

	rqRaw, err := callCloudCodeAPI(ctx, token, "retrieveUserQuota", map[string]any{"project": proj})
	if err != nil {
		q.Status = "error"
		q.Plan = tierName
		q.Note = "无法读取 Gemini 配额：" + err.Error()
		return q
	}
	parsed, ok := parseGeminiQuotaResponse(rqRaw, tierName)
	if !ok {
		q.Status = "ok"
		q.Plan = tierName
		q.Note = "已连接项目 " + proj
		return q
	}
	return parsed
}

func parseGeminiQuotaResponse(raw json.RawMessage, tier string) (AgentQuota, bool) {
	var resp struct {
		Buckets []struct {
			ModelID           string   `json:"modelId"`
			RemainingFraction *float64 `json:"remainingFraction"`
			ResetTime         string   `json:"resetTime"`
			TokenType         string   `json:"tokenType"`
		} `json:"buckets"`
	}
	if json.Unmarshal(raw, &resp) != nil || len(resp.Buckets) == 0 {
		return AgentQuota{}, false
	}
	q := AgentQuota{
		Kind:      "gemini",
		Status:    "ok",
		Provider:  "Google",
		Plan:      tier,
		Source:    "live",
		UpdatedAt: time.Now(),
	}
	if q.Plan == "" {
		q.Plan = "Code Assist"
	}
	seen := map[string]bool{}
	allZero := true
	for _, b := range resp.Buckets {
		if b.ModelID == "" || b.RemainingFraction == nil || strings.HasSuffix(b.ModelID, "_vertex") {
			continue
		}
		if seen[b.ModelID] {
			continue
		}
		seen[b.ModelID] = true
		rem := clampPct(*b.RemainingFraction * 100)
		if rem > 0 {
			allZero = false
		}
		q.Buckets = append(q.Buckets, QuotaBucket{
			ID:           b.ModelID,
			Label:        b.ModelID,
			Model:        b.ModelID,
			RemainingPct: rem,
			UsedPct:      clampPct(100 - rem),
			ResetsAt:     b.ResetTime,
		})
	}
	if len(q.Buckets) > 0 && allZero {
		q.Status = "exhausted"
	}
	return q, len(q.Buckets) > 0
}

func refreshGoogleOAuth(ctx context.Context, home, refreshToken string) (string, error) {
	cid, csec := discoverGeminiOAuthClient(home)
	if cid == "" || csec == "" {
		return "", fmt.Errorf("gemini cli oauth client not found")
	}
	reqCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	form := url.Values{
		"client_id":     {cid},
		"client_secret": {csec},
		"refresh_token": {refreshToken},
		"grant_type":    {"refresh_token"},
	}
	req, err := http.NewRequestWithContext(reqCtx, "POST", "https://oauth2.googleapis.com/token", strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return "", fmt.Errorf("oauth HTTP %d", res.StatusCode)
	}
	var out struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&out); err != nil {
		return "", err
	}
	return out.AccessToken, nil
}

func callCloudCodeAPI(ctx context.Context, token, method string, body any) (json.RawMessage, error) {
	reqCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	b, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(reqCtx, "POST", "https://cloudcode-pa.googleapis.com/v1internal:"+method, bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 256<<10))
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	return raw, nil
}
