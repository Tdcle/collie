package collie

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// RouterSync lets Collie's Router run on any connected computer (node), not
// only on the Hub itself. The Hub stays the canonical store for router/
// (ROUTER.md, memory/, dreams/, .claude/settings.json); before launching or
// prompting on a remote machine it pushes router/ there, and after a Router or
// Dream turn settles it pulls back memory/ and dreams/ so Web UI edits,
// handovers, and machine failovers stay seamlessly in sync.

type routerSyncItem struct {
	Path string `json:"path"` // slash-separated path relative to routerDir()
	Text string `json:"text"`
}

func isSafeRouterRel(rel string) bool {
	if rel == "" || strings.HasPrefix(rel, "/") || strings.Contains(rel, `\`) {
		return false
	}
	clean := filepath.ToSlash(filepath.Clean(filepath.FromSlash(rel)))
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") {
		return false
	}
	return true
}

func collectRouterTree(root string, allow func(rel string) bool) []routerSyncItem {
	var out []routerSyncItem
	filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		rel, rerr := filepath.Rel(root, p)
		if rerr != nil || rel == "." {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if d.IsDir() {
			if strings.HasPrefix(rel, ".git") {
				return filepath.SkipDir
			}
			return nil
		}
		if allow != nil && !allow(rel) {
			return nil
		}
		fi, err := d.Info()
		if err != nil || fi.Size() > 512<<10 {
			return nil
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return nil
		}
		out = append(out, routerSyncItem{Path: rel, Text: string(b)})
		return nil
	})
	return out
}

func applyRouterTree(root string, files []routerSyncItem, cleanSubdirs []string, allow func(rel string) bool) error {
	if err := os.MkdirAll(root, 0o700); err != nil {
		return err
	}
	keep := map[string]bool{}
	for _, it := range files {
		if !isSafeRouterRel(it.Path) || (allow != nil && !allow(it.Path)) {
			continue
		}
		clean := filepath.ToSlash(filepath.Clean(filepath.FromSlash(it.Path)))
		keep[clean] = true
		dst := filepath.Join(root, filepath.FromSlash(clean))
		if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
			return err
		}
		if prev, err := os.ReadFile(dst); err == nil && string(prev) == it.Text {
			continue
		}
		if err := os.WriteFile(dst, []byte(it.Text), 0o600); err != nil {
			return err
		}
	}
	for _, sub := range cleanSubdirs {
		base := filepath.Join(root, filepath.FromSlash(sub))
		filepath.WalkDir(base, func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil
			}
			rel, rerr := filepath.Rel(root, p)
			if rerr != nil {
				return nil
			}
			rel = filepath.ToSlash(rel)
			if strings.HasSuffix(rel, "/.keep") || rel == "memory/messages.md" {
				return nil
			}
			if !keep[rel] && (allow == nil || allow(rel)) {
				_ = os.Remove(p)
			}
			return nil
		})
	}
	return nil
}

func routerEditableRel(rel string) bool {
	if rel == "memory/messages.md" {
		return false
	}
	return strings.HasPrefix(rel, "memory/") || strings.HasPrefix(rel, "dreams/") || rel == "memory.md" || rel == "memory-archive.md"
}

func (s *Server) nodeRouterDir() string {
	return filepath.Join(collieDir(), "router")
}

// routerSync is the node-side endpoint (`GET/POST /api/router-sync`) used by
// the Hub when Router or Dream runs on this node.
func (s *Server) routerSync(w http.ResponseWriter, r *http.Request) {
	dir := s.nodeRouterDir()
	if r.Method == http.MethodGet {
		q := r.URL.Query()
		resp := map[string]any{
			"dir":   dir,
			"files": collectRouterTree(dir, routerEditableRel),
		}
		if sess := q.Get("session"); sess != "" {
			kind := q.Get("kind")
			if kind == "antigravity" {
				kind = "agy"
			}
			win, _ := fmt.Sscanf(q.Get("window"), "%d")
			_ = win
			var cwin int
			fmt.Sscanf(q.Get("window"), "%d", &cwin)
			if path, format := s.findTranscript(kind, "id", sess, q.Get("pane"), dir); path != "" {
				u := contextUsage(path, format, cwin)
				resp["usage"] = u
			}
		}
		writeJSON(w, 200, resp)
		return
	}
	var body struct {
		Files []routerSyncItem `json:"files"`
	}
	if !decode(w, r, &body) {
		return
	}
	if err := applyRouterTree(dir, body.Files, []string{"memory", "dreams", "dream"}, nil); err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "dir": dir})
}

func (sp *Super) routerDirOn(m *Machine) string {
	if m == nil || m.Local {
		return sp.routerDir()
	}
	return expandIn(m.Home, "~/.collie/router")
}

func (sp *Super) routerBinOn(m *Machine) string {
	if m == nil || m.Local {
		return sp.bin
	}
	if m.Bin != "" {
		return m.Bin
	}
	return "collie"
}

func (sp *Super) pushRouterToNode(ctx context.Context, machine string) (string, error) {
	if machine == "" {
		return sp.routerDir(), nil
	}
	client, err := sp.s.herdr.Client(machine)
	if err != nil {
		return "", err
	}
	files := collectRouterTree(sp.routerDir(), nil)
	b, _ := json.Marshal(map[string]any{"files": files})
	cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(cctx, "POST", "http://node/api/router-sync", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return "", fmt.Errorf("node router-sync (%d): %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	var out struct {
		Dir string `json:"dir"`
	}
	json.NewDecoder(resp.Body).Decode(&out)
	if out.Dir != "" {
		return out.Dir, nil
	}
	if mc, err := sp.s.herdr.machine(machine); err == nil {
		return sp.routerDirOn(mc), nil
	}
	return "~/.collie/router", nil
}

func (sp *Super) pullRouterFromNode(ctx context.Context, machine, kind, session, pane string, window int) (ctxUsage, error) {
	if machine == "" {
		return ctxUsage{}, nil
	}
	client, err := sp.s.herdr.Client(machine)
	if err != nil {
		return ctxUsage{}, err
	}
	q := url.Values{}
	if session != "" {
		q.Set("session", session)
		q.Set("kind", kind)
		q.Set("pane", pane)
		if window > 0 {
			q.Set("window", fmt.Sprint(window))
		}
	}
	u := "http://node/api/router-sync"
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(cctx, "GET", u, nil)
	resp, err := client.Do(req)
	if err != nil {
		return ctxUsage{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return ctxUsage{}, fmt.Errorf("node router-sync status %d", resp.StatusCode)
	}
	var out struct {
		Files []routerSyncItem `json:"files"`
		Usage ctxUsage         `json:"usage"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return ctxUsage{}, err
	}
	_ = applyRouterTree(sp.routerDir(), out.Files, []string{"memory", "dreams"}, routerEditableRel)
	sp.writeMessages()
	return out.Usage, nil
}

// resolveRouterTarget picks the (machine, kind) Collie itself should run on.
// Explicit settings win when that computer is online and has the chosen agent;
// otherwise (e.g. a lightweight cloud Hub with no herdr/agents, or default
// "claude" when the user only installed "codex") it falls back smoothly to an
// available online machine and installed agent.
func (sp *Super) resolveRouterTarget(st Settings) (m *Machine, kind string, err error) {
	wantKind := st.RouterKind
	if _, ok := kinds[wantKind]; !ok {
		wantKind = "claude"
	}
	wantHK := kinds[wantKind]
	wantMachine := st.RouterMachine

	ms := sp.s.herdr.Machines()
	localHerdrOK := func() bool {
		ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
		defer cancel()
		_, e := sp.s.herdr.local.conn.call(ctx, "workspace.list", nil)
		return e == nil
	}
	machineUsable := func(mc Machine) (usable bool, have []string) {
		if mc.Local {
			have = localAgents(mc.Home, true)
			if len(have) == 0 && !localHerdrOK() {
				return false, have
			}
			return localHerdrOK(), have
		}
		if !mc.Online {
			return false, nil
		}
		return true, mc.Agents
	}
	hasKind := func(have []string, hk string) bool {
		return have == nil || slices.Contains(have, hk)
	}
	pickKindOn := func(have []string) string {
		if hasKind(have, wantHK) {
			return wantKind
		}
		if wk := kinds[st.WorkerKind]; wk != "" && hasKind(have, wk) {
			return st.WorkerKind
		}
		for _, k := range []string{"codex", "claude", "antigravity"} {
			if hasKind(have, kinds[k]) {
				return k
			}
		}
		return ""
	}

	// 1. Try the explicitly configured RouterMachine (or WorkerMachine if RouterMachine is unset and Hub is agentless).
	candidates := []string{wantMachine}
	if wantMachine == "" && st.WorkerMachine != "" {
		candidates = append(candidates, st.WorkerMachine)
	}
	for _, id := range candidates {
		for _, mc := range ms {
			if mc.ID != id {
				continue
			}
			ok, have := machineUsable(mc)
			if !ok {
				break
			}
			if k := pickKindOn(have); k != "" {
				cp := mc
				return &cp, k, nil
			}
		}
	}

	// 2. If RouterMachine was explicitly set to a remote computer that is offline, report that clearly instead of silently jumping elsewhere unless it has no agents.
	if wantMachine != "" {
		for _, mc := range ms {
			if mc.ID == wantMachine && !mc.Online {
				return nil, wantKind, fmt.Errorf("运行 Collie 的电脑 %s 当前不在线", mc.Name)
			}
		}
	}

	// 3. Auto-select any online computer that has wantKind first, then any online computer with any supported agent.
	for pass := 0; pass < 2; pass++ {
		for _, mc := range ms {
			ok, have := machineUsable(mc)
			if !ok {
				continue
			}
			if pass == 0 {
				if hasKind(have, wantHK) {
					cp := mc
					return &cp, wantKind, nil
				}
			} else if k := pickKindOn(have); k != "" {
				cp := mc
				return &cp, k, nil
			}
		}
	}

	return nil, wantKind, fmt.Errorf("没有找到能运行 Collie 的在线电脑（需要在已连接的电脑上安装 herdr，并至少安装 Claude Code、Codex 或 Antigravity 之一）")
}
