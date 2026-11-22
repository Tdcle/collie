package collie

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"time"
)

// herdr says "done" (finished, not looked at yet) until its own TUI focuses
// the pane. Opening it in Collie is looking at it too, so the hub keeps that
// here: a pane that finished before you last opened it reads "idle". Asking
// herdr to focus it instead would move your terminal's focus.

type seenPanes struct {
	mu        sync.Mutex
	at        map[string]time.Time // pane → when you last had it open in Collie
	doneSince map[string]time.Time // pane → when it turned "done"
}

// status is what to show for a pane herdr reports as status.
func (sp *seenPanes) status(pane, status string) string {
	sp.mu.Lock()
	defer sp.mu.Unlock()
	if sp.doneSince == nil {
		sp.at, sp.doneSince = map[string]time.Time{}, map[string]time.Time{}
	}
	if status != "done" {
		delete(sp.doneSince, pane)
		return status
	}
	since, ok := sp.doneSince[pane]
	if !ok {
		since = time.Now()
		sp.doneSince[pane] = since
	}
	if seen := sp.at[pane]; !seen.IsZero() && !seen.Before(since) {
		return "idle"
	}
	return status
}

func (sp *seenPanes) mark(pane string) {
	sp.mu.Lock()
	defer sp.mu.Unlock()
	if sp.at == nil {
		sp.at, sp.doneSince = map[string]time.Time{}, map[string]time.Time{}
	}
	sp.at[pane] = time.Now()
}

// seenPane: the page has this pane (or Codex session) open in front of you.
func (s *Server) seenPane(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Pane    string `json:"pane"`
		Kind    string `json:"kind"`
		Machine string `json:"machine"`
		Session string `json:"session"`
	}
	if !decode(w, r, &body) {
		return
	}
	if body.Pane != "" {
		s.seen.mark(body.Pane)
	}
	if kinds[body.Kind] == "codex" && strings.TrimSpace(body.Session) != "" {
		go s.markCodexReadOn(context.Background(), body.Machine, strings.TrimSpace(body.Session))
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}
