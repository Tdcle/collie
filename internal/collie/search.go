package collie

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// SearchHit represents one conversation matching a full-text keyword query.
type SearchHit struct {
	ID      string    `json:"id"`
	Title   string    `json:"title"`
	Kind    string    `json:"kind"`
	Machine string    `json:"machine,omitempty"`
	Cwd     string    `json:"cwd,omitempty"`
	Hash    string    `json:"hash"`
	Snippet string    `json:"snippet"`
	Updated time.Time `json:"updated"`
}

// nodeSearch searches local sessions (active herdr panes + external/desktop
// sessions) on this machine for `q`.
func (s *Server) nodeSearch(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if utf8.RuneCountInString(q) < 2 {
		writeJSON(w, 200, map[string]any{"results": []SearchHit{}})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3500*time.Millisecond)
	defer cancel()
	hits := s.searchLocalMachine(ctx, q, "")
	writeJSON(w, 200, map[string]any{"results": hits})
}

// searchAll searches Collie's own super-agent chat + all connected computers'
// sessions in parallel and returns unified ranked hits for ⌘K.
func (s *Server) searchAll(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if utf8.RuneCountInString(q) < 2 {
		writeJSON(w, 200, map[string]any{"results": []SearchHit{}})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 4500*time.Millisecond)
	defer cancel()

	var mu sync.Mutex
	var all []SearchHit
	var wg sync.WaitGroup

	// 1. Collie main conversation entries on Hub.
	if s.sup != nil {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if hit, ok := s.sup.searchEntries(q); ok {
				mu.Lock()
				all = append(all, hit)
				mu.Unlock()
			}
		}()
	}

	// 2. Hub's own local sessions (if any).
	wg.Add(1)
	go func() {
		defer wg.Done()
		got := s.searchLocalMachine(ctx, q, "")
		if len(got) > 0 {
			mu.Lock()
			all = append(all, got...)
			mu.Unlock()
		}
	}()

	// 3. Connected remote computers in parallel.
	if s.herdr != nil {
		for _, m := range s.herdr.Machines() {
			if m.Local || !m.Online || m.ID == "" {
				continue
			}
			wg.Add(1)
			go func(machineID string) {
				defer wg.Done()
				client, err := s.herdr.Client(machineID)
				if err != nil {
					return
				}
				req, err := http.NewRequestWithContext(ctx, "GET", "http://node/api/search/node?q="+url.QueryEscape(q), nil)
				if err != nil {
					return
				}
				res, err := client.Do(req)
				if err != nil {
					return
				}
				defer res.Body.Close()
				var out struct {
					Results []SearchHit `json:"results"`
				}
				if res.StatusCode == 200 && json.NewDecoder(io.LimitReader(res.Body, 512<<10)).Decode(&out) == nil {
					metaSnap := s.sessionMetaSnapshot()
					for i := range out.Results {
						h := &out.Results[i]
						h.Machine = machineID
						if strings.HasPrefix(h.Hash, "#/p/") {
							local := strings.TrimPrefix(h.Hash, "#/p/")
							localDec, _ := url.PathUnescape(local)
							full := join(localDec, machineID)
							h.Hash = "#/p/" + url.PathEscape(full)
						} else if strings.HasPrefix(h.Hash, "#/x/") {
							local := strings.TrimPrefix(h.Hash, "#/x/")
							localDec, _ := url.PathUnescape(local)
							full := join(localDec, machineID)
							h.Hash = "#/x/" + url.PathEscape(full)
						}
						if ck := canonicalSessionKey(h.Kind, machineID, h.ID); ck != "" {
							if meta := metaSnap[ck]; meta != nil {
								if meta.Deleted {
									h.Hash = ""
									continue
								}
								if strings.TrimSpace(meta.Title) != "" {
									h.Title = strings.TrimSpace(meta.Title)
								}
							}
						}
					}
					mu.Lock()
					for _, h := range out.Results {
						if h.Hash != "" {
							all = append(all, h)
						}
					}
					mu.Unlock()
				}
			}(m.ID)
		}
	}
	wg.Wait()

	// Deduplicate by canonical (machine, sessionID) or hash, keeping newest.
	sort.SliceStable(all, func(i, j int) bool { return all[i].Updated.After(all[j].Updated) })
	seen := map[string]bool{}
	dedup := make([]SearchHit, 0, len(all))
	for _, h := range all {
		key := h.Hash
		if h.ID != "" && h.Hash != "#/collie" {
			key = h.Machine + "|" + h.Kind + "|" + h.ID
		}
		if seen[key] {
			continue
		}
		seen[key] = true
		dedup = append(dedup, h)
		if len(dedup) >= 24 {
			break
		}
	}
	writeJSON(w, 200, map[string]any{"results": dedup})
}

func (sp *Super) searchEntries(q string) (SearchHit, bool) {
	qLow := strings.ToLower(q)
	sp.mu.Lock()
	defer sp.mu.Unlock()
	for i := len(sp.st.Entries) - 1; i >= 0; i-- {
		e := sp.st.Entries[i]
		if e.Role != "user" && e.Role != "collie" {
			continue
		}
		txt := humanText(e.Text)
		if strings.Contains(strings.ToLower(txt), qLow) {
			return SearchHit{
				ID:      "collie",
				Title:   "和 Collie 对话",
				Kind:    "collie",
				Hash:    "#/collie",
				Snippet: extractMatchSnippet(txt, qLow),
				Updated: e.At,
			}, true
		}
	}
	return SearchHit{}, false
}

func (s *Server) searchLocalMachine(ctx context.Context, q, machineTag string) []SearchHit {
	qLow := strings.ToLower(q)
	needleBytes := []byte(qLow)
	type cand struct {
		sessID  string
		title   string
		kind    string
		cwd     string
		hash    string
		path    string
		format  string
		updated time.Time
	}
	var cands []cand
	seenSess := map[string]bool{}

	// 1. Active herdr panes on this machine.
	if s.herdr != nil && s.herdr.local != nil && s.herdr.local.conn != nil {
		if raw, err := s.herdr.local.conn.call(ctx, "agent.list", nil); err == nil {
			var list struct {
				Agents []Agent `json:"agents"`
			}
			_ = json.Unmarshal(raw, &list)
			for _, a := range list.Agents {
				if a.Name != nil && *a.Name == routerName {
					continue
				}
				k := ""
				if a.Agent != nil {
					k = kinds[*a.Agent]
				}
				if k == "" {
					continue
				}
				sessKind, val := "", ""
				if a.Session != nil {
					sessKind, val = a.Session.Kind, a.Session.Value
				}
				if val == "" {
					if rem := s.herdr.SessionOf(a.PaneID); rem != "" {
						sessKind, val = "id", rem
					}
				}
				cwd := deref(a.Cwd)
				path, format := s.findTranscript(k, sessKind, val, a.PaneID, cwd)
				if path == "" {
					continue
				}
				sid := sessionID(sessKind, val)
				if sid != "" {
					seenSess[sid] = true
				}
				lbl := strings.TrimSpace(a.TerminalTitle)
				if lbl == "" && a.Name != nil {
					lbl = *a.Name
				}
				if lbl == "" && cwd != "" {
					lbl = baseOfPath(cwd)
				}
				var mod time.Time
				if fi, err := os.Stat(path); err == nil {
					mod = fi.ModTime()
				}
				cands = append(cands, cand{
					sessID: sid, title: lbl, kind: k, cwd: cwd,
					hash: "#/p/" + url.PathEscape(a.PaneID), path: path, format: format, updated: mod,
				})
			}
		}
	}

	// 2. External & desktop sessions on this machine.
	for _, e := range s.externalSessions() {
		if e.path == "" || (e.Session != "" && seenSess[e.Session]) {
			continue
		}
		if e.Session != "" {
			seenSess[e.Session] = true
		}
		title := strings.TrimSpace(e.Title)
		if title == "" && e.Cwd != "" {
			title = baseOfPath(e.Cwd)
		}
		if title == "" {
			title = e.Kind
		}
		cands = append(cands, cand{
			sessID: e.Session, title: title, kind: e.Kind, cwd: e.Cwd,
			hash: "#/x/" + url.PathEscape(e.ID), path: e.path, format: e.format, updated: e.Updated,
		})
	}

	sort.SliceStable(cands, func(i, j int) bool { return cands[i].updated.After(cands[j].updated) })
	if len(cands) > 60 {
		cands = cands[:60]
	}

	var hits []SearchHit
	for _, c := range cands {
		if ctx.Err() != nil {
			break
		}
		if snip, ok := s.searchTranscriptFile(c.path, c.format, qLow, needleBytes); ok {
			hits = append(hits, SearchHit{
				ID:      c.sessID,
				Title:   c.title,
				Kind:    c.kind,
				Machine: machineTag,
				Cwd:     c.cwd,
				Hash:    c.hash,
				Snippet: snip,
				Updated: c.updated,
			})
			if len(hits) >= 15 {
				break
			}
		}
	}
	return hits
}

func (s *Server) searchTranscriptFile(path, format, qLow string, needleLow []byte) (string, bool) {
	f, err := os.Open(path)
	if err != nil {
		return "", false
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || fi.Size() == 0 {
		return "", false
	}
	const maxScan = 2 << 20
	if fi.Size() > maxScan {
		_, _ = f.Seek(fi.Size()-maxScan, io.SeekStart)
	}
	raw, err := io.ReadAll(f)
	if err != nil || len(raw) == 0 {
		return "", false
	}
	if !bytes.Contains(bytes.ToLower(raw), needleLow) {
		return "", false
	}
	tr := newTranscript(path, format)
	for _, line := range bytes.Split(raw, []byte("\n")) {
		if len(line) > 0 {
			tr.line(line)
		}
	}
	msgs := tr.view()
	for i := len(msgs) - 1; i >= 0; i-- {
		m := msgs[i]
		if m.Phase == "reasoning" {
			continue
		}
		txt := strings.TrimSpace(m.Text)
		if txt == "" && len(m.Options) > 0 {
			txt = strings.Join(m.Options, " / ")
		}
		if txt != "" && strings.Contains(strings.ToLower(txt), qLow) {
			return extractMatchSnippet(txt, qLow), true
		}
	}
	return "", false
}

func extractMatchSnippet(text, qLow string) string {
	clean := strings.Join(strings.Fields(text), " ")
	runes := []rune(clean)
	lowRunes := []rune(strings.ToLower(clean))
	qRunes := []rune(qLow)
	idx := -1
	if len(qRunes) > 0 && len(lowRunes) >= len(qRunes) {
		for i := 0; i <= len(lowRunes)-len(qRunes); i++ {
			match := true
			for j := range qRunes {
				if lowRunes[i+j] != qRunes[j] {
					match = false
					break
				}
			}
			if match {
				idx = i
				break
			}
		}
	}
	if idx < 0 {
		if len(runes) > 84 {
			return string(runes[:84]) + "…"
		}
		return clean
	}
	start := max(0, idx-24)
	end := min(len(runes), idx+len(qRunes)+46)
	prefix, suffix := "", ""
	if start > 0 {
		prefix = "…"
	}
	if end < len(runes) {
		suffix = "…"
	}
	return prefix + string(runes[start:end]) + suffix
}
