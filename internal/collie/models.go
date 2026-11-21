package collie

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Which models (and thinking efforts) each agent can run here, so the human can
// pick from a list instead of typing launch flags. Each agent is asked in its
// own way: Claude Code's settings (a gateway lists its models and what they
// support), Codex's app-server model/list, `agy models`.

type ModelOpt struct {
	ID      string   `json:"id"`
	Label   string   `json:"label,omitempty"`
	Note    string   `json:"note,omitempty"`
	Efforts []string `json:"efforts,omitempty"` // empty: the kind's efforts
}

type ModelInfo struct {
	Kind          string     `json:"kind"`
	Models        []ModelOpt `json:"models"`
	Efforts       []string   `json:"efforts"`
	Default       string     `json:"default,omitempty"` // what the agent uses when nothing is chosen
	DefaultEffort string     `json:"default_effort,omitempty"`
}

var allEfforts = []string{"low", "medium", "high", "xhigh", "max"}

// modelArgs are the launch flags for a model and effort ("" = the agent's own default).
func modelArgs(kind, model, effort string) []string {
	var a []string
	switch kinds[kind] {
	case "codex":
		if model != "" {
			a = append(a, "-m", model)
		}
		if effort != "" {
			a = append(a, "-c", "model_reasoning_effort="+strconvQuote(effort))
		}
	case "claude", "agy":
		if model != "" {
			a = append(a, "--model", model)
		}
		if effort != "" {
			a = append(a, "--effort", effort)
		}
	}
	return a
}

// bypassArgs: the launch flag that turns off an agent's permission prompts.
func bypassArgs(kind string) []string {
	switch kinds[kind] {
	case "claude", "agy":
		return []string{"--dangerously-skip-permissions"}
	case "codex":
		return []string{"--dangerously-bypass-approvals-and-sandbox"}
	}
	return nil
}

// withBypass adds bypassArgs to args unless permissions are asked for or the
// flag is already there.
func withBypass(args []string, kind string, ask bool) []string {
	if ask {
		return args
	}
	for _, f := range bypassArgs(kind) {
		if !contains(args, f) {
			args = append(args, f)
		}
	}
	return args
}

func strconvQuote(s string) string { b, _ := json.Marshal(s); return string(b) }

var modelCache = struct {
	sync.Mutex
	m map[string]modelMark
}{m: map[string]modelMark{}}

type modelMark struct {
	at   time.Time
	info *ModelInfo
}

func (s *Server) listModels(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("kind")
	if q == "agy" { // the web app's short name
		q = "antigravity"
	}
	kind := kinds[q]
	if kind == "" {
		writeJSON(w, 400, map[string]any{"error": "unknown agent kind"})
		return
	}
	modelCache.Lock()
	mk := modelCache.m[kind]
	modelCache.Unlock()
	if mk.info == nil || time.Since(mk.at) > 10*time.Minute || r.URL.Query().Get("refresh") != "" {
		ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
		defer cancel()
		info := &ModelInfo{Kind: kind, Efforts: allEfforts}
		switch kind {
		case "claude":
			s.claudeModels(info)
		case "codex":
			s.codexModels(ctx, info)
		case "agy":
			s.agyModels(ctx, info)
		}
		if info.Models == nil {
			info.Models = []ModelOpt{}
		}
		mk = modelMark{at: time.Now(), info: info}
		modelCache.Lock()
		modelCache.m[kind] = mk
		modelCache.Unlock()
	}
	writeJSON(w, 200, mk.info)
}

// claudeSettings is the part of Claude Code's settings.json that matters here.
type claudeSettings struct {
	Model  string            `json:"model"`
	Effort string            `json:"effortLevel"`
	Env    map[string]string `json:"env"`
}

func (s *Server) readClaudeSettings() claudeSettings {
	var c claudeSettings
	root := envOr("CLAUDE_CONFIG_DIR", filepath.Join(s.home, ".claude"))
	if b, err := os.ReadFile(filepath.Join(root, "settings.json")); err == nil {
		json.Unmarshal(b, &c)
	}
	return c
}

// claudeEnv is a variable from Claude's settings, else the process environment.
func (c claudeSettings) env(k string) string {
	if v := c.Env[k]; v != "" {
		return v
	}
	return os.Getenv(k)
}

func (s *Server) claudeModels(info *ModelInfo) {
	cfg := s.readClaudeSettings()
	info.Default, info.DefaultEffort = cfg.Model, cfg.Effort
	seen := map[string]bool{}
	add := func(o ModelOpt) {
		if o.ID != "" && !seen[o.ID] {
			seen[o.ID] = true
			info.Models = append(info.Models, o)
		}
	}
	// Aliases first, showing what each points to when a gateway remaps them.
	for _, a := range []struct{ id, env string }{{"opus", "ANTHROPIC_DEFAULT_OPUS_MODEL"}, {"sonnet", "ANTHROPIC_DEFAULT_SONNET_MODEL"}, {"haiku", "ANTHROPIC_DEFAULT_HAIKU_MODEL"}} {
		add(ModelOpt{ID: a.id, Label: strings.Title(a.id), Note: cfg.env(a.env)})
	}
	// A gateway declares its models and what they support:
	// "model=effort,xhigh_effort,max_effort;other=effort".
	var gw []ModelOpt
	for _, part := range strings.Split(cfg.env("CLAUDE_CODE_MODEL_CAPABILITIES"), ";") {
		id, caps, _ := strings.Cut(strings.TrimSpace(part), "=")
		if id == "" {
			continue
		}
		o := ModelOpt{ID: id, Efforts: []string{}}
		for _, c := range strings.Split(caps, ",") {
			switch strings.TrimSpace(c) {
			case "effort":
				o.Efforts = append(o.Efforts, "low", "medium", "high")
			case "xhigh_effort":
				o.Efforts = append(o.Efforts, "xhigh")
			case "max_effort":
				o.Efforts = append(o.Efforts, "max")
			}
		}
		gw = append(gw, o)
	}
	sort.SliceStable(gw, func(i, j int) bool { return gw[i].ID < gw[j].ID })
	for _, o := range gw {
		add(o)
	}
	add(ModelOpt{ID: cfg.Model})
}

func (s *Server) codexModels(ctx context.Context, info *ModelInfo) {
	home := s.codexHome()
	// The configured default (config.toml's top-level model / model_reasoning_effort).
	if b, err := os.ReadFile(filepath.Join(home, "config.toml")); err == nil {
		for _, l := range strings.Split(string(b), "\n") {
			l = strings.TrimSpace(l)
			if strings.HasPrefix(l, "[") {
				break
			}
			k, v, ok := strings.Cut(l, "=")
			if !ok {
				continue
			}
			v = strings.Trim(strings.TrimSpace(v), `"'`)
			switch strings.TrimSpace(k) {
			case "model":
				info.Default = v
			case "model_reasoning_effort":
				info.DefaultEffort = v
			}
		}
	}
	bin := findBin("codex", s.home)
	if bin != "" {
		for _, m := range codexModelList(ctx, bin) {
			info.Models = append(info.Models, m)
		}
	}
	if info.Default != "" {
		found := false
		for _, m := range info.Models {
			found = found || m.ID == info.Default
		}
		if !found {
			info.Models = append([]ModelOpt{{ID: info.Default, Note: "当前默认"}}, info.Models...)
		}
	}
	union := map[string]bool{}
	for _, m := range info.Models {
		for _, e := range m.Efforts {
			union[e] = true
		}
	}
	if len(union) > 0 {
		info.Efforts = nil
		for _, e := range []string{"minimal", "low", "medium", "high", "xhigh", "max", "ultra"} {
			if union[e] {
				info.Efforts = append(info.Efforts, e)
			}
		}
	}
}

// codexModelList asks a short-lived `codex app-server` (stdio, JSON lines).
func codexModelList(ctx context.Context, bin string) []ModelOpt {
	cmd := exec.CommandContext(ctx, bin, "app-server")
	hideCmd(cmd)
	in, _ := cmd.StdinPipe()
	out, _ := cmd.StdoutPipe()
	if cmd.Start() != nil {
		return nil
	}
	defer func() { in.Close(); cmd.Process.Kill(); cmd.Wait() }()
	send := func(v any) { in.Write(append(jsonNoEscape(v), '\n')) }
	sc := bufio.NewScanner(out)
	sc.Buffer(make([]byte, 0, 1<<20), 16<<20)
	wait := func(id int) json.RawMessage {
		for sc.Scan() {
			var m struct {
				ID     *int            `json:"id"`
				Method string          `json:"method"`
				Result json.RawMessage `json:"result"`
			}
			if json.Unmarshal(sc.Bytes(), &m) == nil && m.ID != nil && *m.ID == id && m.Method == "" {
				return m.Result
			}
		}
		return nil
	}
	send(map[string]any{"id": 1, "method": "initialize", "params": map[string]any{"clientInfo": map[string]any{"name": "collie", "version": "1"}}})
	if wait(1) == nil {
		return nil
	}
	send(map[string]any{"method": "initialized", "params": map[string]any{}})
	send(map[string]any{"id": 2, "method": "model/list", "params": map[string]any{}})
	var res struct {
		Data []struct {
			ID      string `json:"id"`
			Model   string `json:"model"`
			Display string `json:"displayName"`
			Desc    string `json:"description"`
			Hidden  bool   `json:"hidden"`
			Efforts []struct {
				Effort string `json:"reasoningEffort"`
			} `json:"supportedReasoningEfforts"`
		} `json:"data"`
	}
	json.Unmarshal(wait(2), &res)
	var list []ModelOpt
	for _, d := range res.Data {
		if d.Hidden {
			continue
		}
		id := d.Model
		if id == "" {
			id = d.ID
		}
		o := ModelOpt{ID: id, Label: d.Display, Note: d.Desc, Efforts: []string{}}
		for _, e := range d.Efforts {
			o.Efforts = append(o.Efforts, e.Effort)
		}
		list = append(list, o)
	}
	return list
}

var agyModelRe = regexp.MustCompile(`^(\S+)\t(.+)$`)

func (s *Server) agyModels(ctx context.Context, info *ModelInfo) {
	bin := findBin("agy", s.home)
	if bin == "" {
		return
	}
	cmd := exec.CommandContext(ctx, bin, "models")
	hideCmd(cmd)
	out, err := cmd.Output()
	if err != nil {
		return
	}
	for _, l := range strings.Split(string(out), "\n") {
		if m := agyModelRe.FindStringSubmatch(strings.TrimSpace(l)); m != nil {
			info.Models = append(info.Models, ModelOpt{ID: m[1], Label: m[2]})
		}
	}
}

// findBin locates an agent's program: PATH, the usual install places, then
// the user's login shell / registry PATH.
var binCache sync.Map

func findBin(name, home string) string {
	if v, ok := binCache.Load(name); ok {
		return v.(string)
	}
	found := ""
	if p, err := exec.LookPath(name); err == nil {
		found = p
	}
	if found == "" {
		found = findBinPlatform(name, home)
	}
	if found != "" {
		binCache.Store(name, found)
	}
	return found
}
