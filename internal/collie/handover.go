package collie

import (
	"context"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
	"time"
)

// Collie's own session grows with every event it handles. Before it fills up,
// Collie hands over: it writes what matters into memory/, then the hub
// starts it again in a fresh session that begins by reading it. The
// old session stays readable under "最近结束".

// What a session reads up front from memory/. upFrontBudget covers the files
// Collie writes (instructions, notes/index.md, open tasks) and is the number
// every prompt names; memoryBudget adds messages.md, which the hub writes, for
// the memory page.
const (
	upFrontBudget = 6 << 10
	memoryBudget  = upFrontBudget + 2<<10
)

type handover struct {
	at      time.Time
	kind    string
	machine string
	session string
	pct     int
	worked  bool // the router picked up the flush prompt
}

func (sp *Super) handingOver() bool {
	sp.mu.Lock()
	defer sp.mu.Unlock()
	return sp.handover != nil
}

// rotateAtLocked is the usage (percent) that triggers a handover; 0 = never.
func (sp *Super) rotateAtLocked() int {
	switch p := sp.st.Settings.RotatePct; {
	case p < 0:
		return 0
	case p == 0:
		return 60
	default:
		return p
	}
}

// claudeWindow is the context window Claude Code compacts against. Its logs
// don't record it: a setup can say so (CLAUDE_CODE_AUTO_COMPACT_WINDOW, or
// CLAUDE_CODE_MAX_CONTEXT_TOKENS, in settings.json's env); otherwise 1M for a
// "[1m]" model, 200k for the rest.
func (s *Server) claudeWindow(args []string) int {
	cfg := s.readClaudeSettings()
	for _, k := range []string{"CLAUDE_CODE_AUTO_COMPACT_WINDOW", "CLAUDE_CODE_MAX_CONTEXT_TOKENS"} {
		if n, err := strconv.Atoi(strings.TrimSpace(cfg.env(k))); err == nil && n >= 8000 {
			return n
		}
	}
	model := cfg.Model
	for i, a := range args {
		if a == "--model" && i+1 < len(args) {
			model = args[i+1]
		} else if strings.HasPrefix(a, "--model=") {
			model = strings.TrimPrefix(a, "--model=")
		}
	}
	if model == "" {
		model = os.Getenv("ANTHROPIC_MODEL")
	}
	if strings.Contains(strings.ToLower(model), "[1m]") {
		return 1000000
	}
	return 200000
}

func (sp *Super) checkHandover(ctx context.Context, live map[string]liveAgent, queued bool) {
	a, alive := live[routerName]
	sp.mu.Lock()
	h := sp.handover
	if !alive || sp.dream != nil {
		sp.routerUsage = ctxUsage{}
		sp.mu.Unlock()
		return
	}
	window := sp.s.claudeWindow(sp.routerArgsLocked())
	at := sp.rotateAtLocked()
	paused := sp.st.Settings.Paused
	launched, asked := sp.routerLaunchAt, sp.routerAskedAt
	sp.mu.Unlock()

	kind := a.Kind
	if kind == "antigravity" {
		kind = "agy"
	}
	localPane, machine := split(a.Pane)
	var u ctxUsage
	if a.Session != "" || kind == "agy" {
		if machine != "" {
			u, _ = sp.pullRouterFromNode(ctx, machine, kind, a.Session, localPane, window)
		} else if path, format := sp.s.findTranscript(kind, "id", a.Session, a.Pane, sp.routerDir()); path != "" {
			u = contextUsage(path, format, window)
		}
	}
	sp.mu.Lock()
	sp.routerUsage = u
	sp.mu.Unlock()

	idle := a.Status == "idle" || a.Status == "done"
	if h != nil {
		sp.mu.Lock()
		if a.Status == "working" {
			h.worked = true
		}
		worked := h.worked
		sp.mu.Unlock()
		wait := time.Since(h.at)
		if (worked && idle && wait > 5*time.Second) || (!worked && idle && wait > 90*time.Second) || wait > 5*time.Minute {
			sp.finishHandover(ctx, h)
		}
		return
	}
	// Only between conversations: nothing queued, the last batch answered, and
	// not right after a (re)start.
	if at <= 0 || paused || !idle || queued || !asked.IsZero() || u.Pct() < at || time.Since(launched) < 5*time.Minute || a.Session == "" {
		return
	}
	prompt := fmt.Sprintf(`[collie] Handover. Your context window is %d%% full, so Collie will restart you in a fresh session as soon as you finish this. Nothing from this conversation carries over except memory/ (layout in ROUTER.md), so bring it up to date now:
- instructions.md: every standing instruction or preference the human gave; merge duplicates.
- tasks/: one file per piece of open work, saying where it stands and the next step. Move finished ones to tasks/done/.
- notes/: what you learned that will matter later; keep notes/index.md in step.
Keep the up-front files (instructions, notes/index.md, open tasks) under ~%d KB together.%s
This turn is for the files alone: edit them, then stop. Your next session handles the human and the workers.`, u.Pct(), upFrontBudget/1024, func() string {
		if sp.legacyMemory() {
			return "\n" + migrateNote
		}
		return ""
	}())
	if err := sp.writeRouterFiles(); err != nil {
		log.Printf("router files: %v", err)
	}
	if machine != "" {
		_, _ = sp.pushRouterToNode(ctx, machine)
	}
	if err := sp.s.herdr.Prompt(ctx, routerName, prompt); err != nil {
		log.Printf("handover prompt: %v", err)
		return
	}
	sp.mu.Lock()
	sp.handover = &handover{at: time.Now(), kind: kind, machine: machine, session: a.Session, pct: u.Pct()}
	sp.addEntryLocked("event", mainThread, fmt.Sprintf("Collie 的上下文用了 %d%%，正在把要记住的事写进记忆，马上换一个新会话", u.Pct()), "", "info")
	sp.mu.Unlock()
}

func (sp *Super) finishHandover(ctx context.Context, h *handover) {
	cwd := sp.routerDir()
	if h.machine != "" {
		_, _ = sp.pullRouterFromNode(ctx, h.machine, "", "", "", 0)
		if mc, err := sp.s.herdr.machine(h.machine); err == nil {
			cwd = sp.routerDirOn(mc)
		}
	}
	sp.s.remember(&Ended{
		Kind: h.kind, Machine: h.machine, Cwd: cwd, Name: routerName, Session: h.session, Ended: time.Now(),
		Title: "Collie · 交接前的会话（" + h.at.Format("01-02 15:04") + "）",
	})
	if err := sp.RestartRouter(ctx); err != nil {
		log.Printf("handover restart: %v", err)
	}
	sp.mu.Lock()
	sp.handover = nil
	sp.routerUsage = ctxUsage{}
	sp.addEntryLocked("event", mainThread, "Collie 换了一个新会话，记忆已交接。之前的对话在「最近结束」里可以翻看", "", "info")
	sp.mu.Unlock()
}
