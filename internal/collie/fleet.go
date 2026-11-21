package collie

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

// A Machine is one computer whose herdr Collie can drive: the hub's own
// machine, or a computer whose node has dialed in (see node.go).
type Machine struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	OS   string `json:"os,omitempty"`
	// Version of collie it runs; "" for nodes from before v0.2.5.
	Version string `json:"version,omitempty"`
	// Agents it has installed (herdr kinds); nil when not known.
	Agents []string  `json:"agents"`
	Home   string    `json:"home,omitempty"`
	Bin    string    `json:"-"`
	Local  bool      `json:"local"`
	Online bool      `json:"online"`
	Since  time.Time `json:"since,omitempty"`

	conn   *herdrConn
	client *http.Client // remote only: the node's own API, through the tunnel
	ip     string       // remote only: where it connects from
	ui     string       // remote only: its local web UI (http://127.0.0.1:port), if any
	close  func()
}

// Herdr is the herdr API across every connected machine. It speaks herdr's
// own protocol, so callers never care where a pane lives:
//
//   - IDs on remote machines carry a suffix: pane "w1:p1" on machine "mac"
//     is "w1:p1@mac". IDs on the hub's own machine stay bare.
//   - Calls that name a pane, workspace or agent go to that machine, with the
//     suffix removed; IDs in the result get the suffix added back.
//   - List calls fan out to every machine and merge.
//   - workspace.create takes an extra "_machine" parameter.
type Herdr struct {
	mu       sync.RWMutex
	local    *Machine
	remote   map[string]*Machine
	names    map[string]string // agent name → its pane id, suffixed on remote machines
	onChange func()

	// named remembers the names Collie gave the agents it started. herdr 0.8
	// drops an agent's name once the launch is confirmed; newer versions keep
	// it, and their answer wins.
	named     map[string]string // pane id → name
	saveNames func(map[string]string)

	// runs: the model and effort Collie started an agent with ("" = the
	// agent's own default), by pane id. What it runs now may differ if the
	// human switched models inside the agent.
	runs     map[string][2]string
	saveRuns func(map[string][2]string)

	asks map[string]askCheck // pane → recent look at an "idle" screen
}

func newHerdr(socket, hostname, home string) *Herdr {
	return &Herdr{
		local:  &Machine{ID: "", Name: hostname, Home: home, Local: true, conn: &herdrConn{dial: unixDialer(socket)}},
		remote: map[string]*Machine{},
		names:  map[string]string{},
		named:  map[string]string{},
		runs:   map[string][2]string{},
		asks:   map[string]askCheck{},
	}
}

type askCheck struct {
	at   time.Time
	asks bool
}

// idleButAsking corrects herdr's "idle" for a pane whose screen shows a
// question (herdr 0.8 misses some dialogs, like claude's folder trust).
func (h *Herdr) idleButAsking(ctx context.Context, pane string) bool {
	h.mu.RLock()
	c, ok := h.asks[pane]
	h.mu.RUnlock()
	if ok && time.Since(c.at) < 3*time.Second {
		return c.asks
	}
	asks := h.ScreenAsks(ctx, pane)
	h.mu.Lock()
	h.asks[pane] = askCheck{time.Now(), asks}
	h.mu.Unlock()
	return asks
}

// fixStatus rewrites agent_status "idle" to "blocked" where the screen asks.
func (h *Herdr) fixStatus(ctx context.Context, item map[string]any) bool {
	pane, _ := item["pane_id"].(string)
	if st, _ := item["agent_status"].(string); st != "idle" || pane == "" || item["agent"] == nil {
		return false
	}
	if h.idleButAsking(ctx, pane) {
		item["agent_status"] = "blocked"
		return true
	}
	return false
}

// LoadNames restores remembered agent names and sets how to persist them.
func (h *Herdr) LoadNames(m map[string]string, save func(map[string]string)) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for k, v := range m {
		h.named[k] = v
	}
	h.saveNames = save
}

// Remember records the name of an agent Collie started in pane.
func (h *Herdr) Remember(pane, name string) {
	if pane == "" || name == "" {
		return
	}
	h.mu.Lock()
	h.named[pane] = name
	h.names[name] = pane
	h.persistNamesLocked()
	h.mu.Unlock()
}

// LoadRuns restores the recorded launch models and sets how to persist them.
func (h *Herdr) LoadRuns(m map[string][2]string, save func(map[string][2]string)) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for k, v := range m {
		h.runs[k] = v
	}
	h.saveRuns = save
}

// RememberRun records what model and effort an agent in pane was started with.
func (h *Herdr) RememberRun(pane, model, effort string) {
	if pane == "" {
		return
	}
	h.mu.Lock()
	h.runs[pane] = [2]string{model, effort}
	h.persistRunsLocked()
	h.mu.Unlock()
}

// Run returns what RememberRun recorded for pane.
func (h *Herdr) Run(pane string) (*[2]string, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	r, ok := h.runs[pane]
	if !ok {
		return nil, false
	}
	return &r, true
}

// pruneRuns forgets panes that are gone (herdr reuses pane ids), on the
// machines it has a full list from.
func (h *Herdr) pruneRuns(alive map[string]bool, listed func(machine string) bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := len(h.runs)
	for p := range h.runs {
		if _, m := split(p); !alive[p] && listed(m) {
			delete(h.runs, p)
		}
	}
	if len(h.runs) != n {
		h.persistRunsLocked()
	}
}

func (h *Herdr) persistRunsLocked() {
	if h.saveRuns == nil {
		return
	}
	cp := make(map[string][2]string, len(h.runs))
	for k, v := range h.runs {
		cp[k] = v
	}
	h.saveRuns(cp)
}

func (h *Herdr) persistNamesLocked() {
	if h.saveNames == nil {
		return
	}
	cp := make(map[string]string, len(h.named))
	for k, v := range h.named {
		cp[k] = v
	}
	h.saveNames(cp)
}

// split turns "w1:p1@mac" into ("w1:p1", "mac").
func split(id string) (local, machine string) {
	if i := strings.LastIndexByte(id, '@'); i >= 0 {
		return id[:i], id[i+1:]
	}
	return id, ""
}

func join(id, machine string) string {
	if machine == "" || id == "" {
		return id
	}
	return id + "@" + machine
}

func (h *Herdr) machine(id string) (*Machine, error) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if id == "" {
		return h.local, nil
	}
	m := h.remote[id]
	if m == nil || !m.Online {
		return nil, &HerdrError{Code: "machine_offline", Message: fmt.Sprintf("machine %q is not connected", id)}
	}
	return m, nil
}

// Machines lists the hub's machine first, then the others by name.
func (h *Herdr) Machines() []Machine {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := []Machine{*h.local}
	out[0].Agents = localAgents(h.local.Home, false)
	var rs []Machine
	for _, m := range h.remote {
		rs = append(rs, *m)
	}
	sort.Slice(rs, func(i, j int) bool { return rs[i].Name < rs[j].Name })
	return append(out, rs...)
}

func (h *Herdr) attach(m *Machine) {
	h.mu.Lock()
	if old := h.remote[m.ID]; old != nil && old.close != nil {
		old.close()
	}
	h.remote[m.ID] = m
	cb := h.onChange
	h.mu.Unlock()
	if cb != nil {
		cb()
	}
}

func (h *Herdr) RenameMachine(id, name string) {
	name = strings.TrimSpace(name)
	if name == "" {
		return
	}
	h.mu.Lock()
	if id == "" || id == "hub" {
		h.local.Name = name
	} else if m := h.remote[id]; m != nil {
		m.Name = name
	}
	cb := h.onChange
	h.mu.Unlock()
	if cb != nil {
		cb()
	}
}

func (h *Herdr) detach(id string, m *Machine) {
	h.mu.Lock()
	if cur := h.remote[id]; cur == m || m == nil {
		if cur != nil {
			cur.Online = false
			if cur.close != nil && m == nil {
				cur.close()
			}
		}
		if m == nil {
			delete(h.remote, id)
		}
	}
	cb := h.onChange
	h.mu.Unlock()
	if cb != nil {
		cb()
	}
}

// Client returns the HTTP client for a remote machine's node API.
func (h *Herdr) Client(machine string) (*http.Client, error) {
	m, err := h.machine(machine)
	if err != nil {
		return nil, err
	}
	if m.client == nil {
		return nil, fmt.Errorf("machine %q has no node API", machine)
	}
	return m.client, nil
}

var routeKeys = []string{"pane_id", "workspace_id", "tab_id", "target"}

// Call routes one herdr request and decodes its result into out.
func (h *Herdr) Call(ctx context.Context, method string, params any, out any) error {
	raw, err := h.call(ctx, method, params)
	if err != nil || out == nil {
		return err
	}
	return json.Unmarshal(raw, out)
}

func (h *Herdr) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	switch method {
	case "workspace.list", "pane.list", "agent.list":
		return h.fanOut(ctx, method)
	}
	p := map[string]any{}
	if params != nil {
		b, _ := json.Marshal(params)
		json.Unmarshal(b, &p)
	}
	target, found := "", false
	if v, ok := p["_machine"].(string); ok {
		target, found = v, true
		delete(p, "_machine")
	}
	for _, k := range routeKeys {
		v, ok := p[k].(string)
		if !ok || v == "" {
			continue
		}
		if k == "target" && !strings.Contains(v, ":") {
			// An agent name. Older herdr (0.8) only resolves pane ids, and
			// the name may live on another machine: resolve it here.
			if pane := h.paneOfName(ctx, v); pane != "" {
				v = pane
			}
		}
		id, m := split(v)
		if found && m != target {
			return nil, &HerdrError{Code: "cross_machine", Message: "ids from different machines in one call"}
		}
		target, found = m, true
		p[k] = id
	}
	mc, err := h.machine(target)
	if err != nil {
		return nil, err
	}
	raw, err := mc.conn.call(ctx, method, p)
	if err != nil {
		return raw, err
	}
	if target != "" {
		raw = suffixIDs(raw, target)
	}
	if method == "agent.get" || method == "pane.get" {
		key := map[string]string{"agent.get": "agent", "pane.get": "pane"}[method]
		var body map[string]map[string]any
		if json.Unmarshal(raw, &body) == nil && body[key] != nil {
			changed := h.fixStatus(ctx, body[key])
			if pane, _ := body[key]["pane_id"].(string); body[key]["name"] == nil && h.namedFor(pane) != "" {
				body[key]["name"], changed = h.namedFor(pane), true
			}
			if changed {
				raw, _ = json.Marshal(body)
			}
		}
	}
	return raw, nil
}

func (h *Herdr) namedFor(pane string) string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.named[pane]
}

func (h *Herdr) paneOfName(ctx context.Context, name string) string {
	h.mu.RLock()
	p, ok := h.names[name]
	h.mu.RUnlock()
	if ok {
		return p
	}
	h.Agents(ctx) // refreshes the name index
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.names[name]
}

// fanOut runs a list call on every online machine and merges the results.
// The hub's machine failing is reported only when nothing else answered.
func (h *Herdr) fanOut(ctx context.Context, method string) (json.RawMessage, error) {
	key := map[string]string{"workspace.list": "workspaces", "pane.list": "panes", "agent.list": "agents"}[method]
	ms := h.Machines()
	type res struct {
		id    string
		items []json.RawMessage
		err   error
	}
	ch := make(chan res, len(ms))
	n := 0
	for _, m := range ms {
		if !m.Local && !m.Online {
			continue
		}
		n++
		go func(m Machine) {
			mc, err := h.machine(m.ID)
			if err != nil {
				ch <- res{id: m.ID, err: err}
				return
			}
			raw, err := mc.conn.call(ctx, method, nil)
			if err != nil {
				ch <- res{id: m.ID, err: err}
				return
			}
			if m.ID != "" {
				raw = suffixIDs(raw, m.ID)
			}
			var body map[string][]json.RawMessage
			json.Unmarshal(raw, &body)
			ch <- res{id: m.ID, items: body[key]}
		}(m)
	}
	merged := []json.RawMessage{}
	var localErr error
	ok := 0
	byMachine := map[string][]json.RawMessage{}
	for i := 0; i < n; i++ {
		r := <-ch
		if r.err != nil {
			if r.id == "" {
				localErr = r.err
			}
			continue
		}
		ok++
		byMachine[r.id] = r.items
	}
	h.mu.Lock()
	h.local.Online = localErr == nil
	h.mu.Unlock()
	if ok == 0 && localErr != nil {
		return nil, localErr
	}
	for _, m := range ms { // stable order: hub machine first
		merged = append(merged, byMachine[m.ID]...)
	}
	if method == "agent.list" || method == "pane.list" {
		for i, it := range merged {
			var a map[string]any
			if json.Unmarshal(it, &a) == nil && h.fixStatus(ctx, a) {
				merged[i], _ = json.Marshal(a)
			}
		}
	}
	if method == "agent.list" {
		names := map[string]string{}
		h.mu.Lock()
		for i, it := range merged {
			var a map[string]any
			if json.Unmarshal(it, &a) != nil {
				continue
			}
			pane, _ := a["pane_id"].(string)
			name, _ := a["name"].(string)
			if name == "" && h.named[pane] != "" {
				name = h.named[pane]
				a["name"] = name
				merged[i], _ = json.Marshal(a)
			}
			if name != "" && pane != "" {
				names[name] = pane
			}
		}
		h.names = names
		h.mu.Unlock()
	}
	if method == "pane.list" {
		// Forget names of panes that are gone, on machines that answered.
		live := map[string]bool{}
		for _, it := range merged {
			var p struct {
				ID string `json:"pane_id"`
			}
			if json.Unmarshal(it, &p) == nil {
				live[p.ID] = true
			}
		}
		h.mu.Lock()
		changed := false
		for pane := range h.named {
			if _, ok := byMachine[machineOf(pane)]; ok && !live[pane] {
				delete(h.named, pane)
				changed = true
			}
		}
		if changed {
			h.persistNamesLocked()
		}
		h.mu.Unlock()
	}
	return json.Marshal(map[string]any{key: merged})
}

func machineOf(id string) string { _, m := split(id); return m }

// suffixIDs appends "@machine" to every id-like string in a herdr result.
func suffixIDs(raw json.RawMessage, machine string) json.RawMessage {
	var v any
	if json.Unmarshal(raw, &v) != nil {
		return raw
	}
	var walk func(any) any
	walk = func(x any) any {
		switch t := x.(type) {
		case map[string]any:
			for k, val := range t {
				if s, ok := val.(string); ok && s != "" && (k == "pane_id" || k == "workspace_id" || k == "tab_id") {
					t[k] = join(s, machine)
				} else {
					t[k] = walk(val)
				}
			}
		case []any:
			for i := range t {
				t[i] = walk(t[i])
			}
		}
		return x
	}
	b, _ := json.Marshal(walk(v))
	return b
}

// streamDialer opens a fresh multiplexed stream for one purpose on a node.
func streamDialer(open func() (net.Conn, error), kind string) func(ctx context.Context) (net.Conn, error) {
	return func(ctx context.Context) (net.Conn, error) {
		c, err := open()
		if err != nil {
			return nil, err
		}
		if _, err := c.Write([]byte(kind + "\n")); err != nil {
			c.Close()
			return nil, err
		}
		return c, nil
	}
}

// Prompt submits text to an agent. herdr 0.8 refuses agent.prompt while it
// still marks the agent launch_pending, which can stick for good; once herdr
// reports the agent idle the terminal is ready, so paste into the pane and
// press enter instead.
func (h *Herdr) Prompt(ctx context.Context, target, text string) error {
	err := h.Call(ctx, "agent.prompt", map[string]any{"target": target, "text": text}, nil)
	var he *HerdrError
	if err == nil || !errors.As(err, &he) || (he.Code != "agent_not_found" && he.Code != "agent_not_ready") {
		return err
	}
	pane := target
	if !strings.Contains(pane, ":") {
		if pane = h.paneOfName(ctx, target); pane == "" {
			return err
		}
	}
	var info struct {
		Agent struct {
			Status string `json:"agent_status"`
		} `json:"agent"`
	}
	if h.Call(ctx, "agent.get", map[string]any{"target": pane}, &info) != nil {
		return err
	}
	switch info.Agent.Status {
	case "idle", "done":
	case "working", "blocked":
		return &HerdrError{Code: "agent_blocked", Message: "agent is " + info.Agent.Status}
	default:
		return err // still starting: let the caller retry
	}
	// herdr 0.8 also says "idle" while a dialog (folder trust, a permission
	// question) is up; pasting there would answer it. Look first.
	if h.ScreenAsks(ctx, pane) {
		return &HerdrError{Code: "agent_blocked", Message: "agent is showing a question"}
	}
	// Bracketed paste keeps multi-line text in one message.
	if e := h.Call(ctx, "pane.send_text", map[string]any{"pane_id": pane, "text": "\x1b[200~" + text + "\x1b[201~"}, nil); e != nil {
		return e
	}
	time.Sleep(300 * time.Millisecond)
	return h.Call(ctx, "pane.send_keys", map[string]any{"pane_id": pane, "keys": []string{"enter"}}, nil)
}

// ScreenAsks reports whether a pane's screen shows a question with choices.
func (h *Herdr) ScreenAsks(ctx context.Context, pane string) bool {
	res, err := h.Read(ctx, pane, "detection", "text", 0)
	if err != nil {
		return false
	}
	return screenAsks(res.Text)
}

// screenAsks: a menu with a key hint ("Enter to confirm · Esc to cancel") or
// numbered options, at the bottom of the screen. An idle prompt ("❯ Try …")
// over a status line is neither, and nor is a dialog an agent quoted in its
// transcript, which has more conversation and the input box below it.
func screenAsks(screen string) bool {
	a := parseApproval(screen)
	return len(a.Choices) >= 2 && (a.Hint != "" || a.Choices[0].Text != "") && a.after <= maxBelowMenu
}

// maxBelowMenu: a live dialog has at most a footer or status line or two
// under its options (agy: "auto · Gemini 4 Carbon · high").
const maxBelowMenu = 4
