package collie

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Message is one entry of the conversation view that wraps an agent terminal.
type Message struct {
	Kind string `json:"kind"` // user | assistant | tool | ask
	Text string `json:"text,omitempty"`
	Name string `json:"name,omitempty"`
	// ask: the agent's question to the human (Claude's AskUserQuestion, or
	// the Claude app's end-of-turn box); Options are its answers' labels,
	// Output the answer once given, Input a recap that came with it.
	Options []string `json:"options,omitempty"`
	Input   string   `json:"input,omitempty"`
	Output  string   `json:"output,omitempty"`
	Error   bool     `json:"error,omitempty"`
	at      int64    // where in the log its line starts
}

// transcript incrementally parses an agent's JSONL session log.
type transcript struct {
	path      string
	ancestors []string // older rollout segments before `path` (e.g. Codex forked/paginated rollouts)
	prefix    []*Message
	format    string // claude | codex | agy
	offset    int64
	msgs      []*Message
	tools     map[string]*Message
	pending     []*Message // agy: tool calls waiting for their output, in order
	pendingImgs []string   // codex: tool-generated images attached after the turn's reply if not linked there
	lastID      string
	dropped   int   // messages trimmed off the front, so positions stay stable
	partial   bool  // offset may be mid-line: skip to the next line first
	began     int64 // where reading started (0: the top of the log)
	lineAt    int64 // where the line being parsed starts
	limit     int64 // stop reading here (0: at the end)
}

const (
	maxMessages = 60 // what a viewer gets first; older ones load on demand
	maxOutput   = 1600
	maxInput    = 400
)

func newTranscript(path, format string) *transcript {
	if format == "agy" {
		// transcript.jsonl cuts long messages ("<truncated 3142 bytes>");
		// Antigravity keeps the whole of them, line for line, next to it.
		if full := strings.TrimSuffix(path, "transcript.jsonl") + "transcript_full.jsonl"; full != path && isFile(full) {
			path = full
		}
	}
	return &transcript{path: path, format: format, tools: map[string]*Message{}}
}

func (t *transcript) withAncestors(anc []string) *transcript {
	if len(anc) > 0 {
		t.ancestors = anc
	}
	return t
}

func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	cut := n
	for cut > 0 && (s[cut]&0xC0) == 0x80 { // stay on a UTF-8 boundary
		cut--
	}
	return s[:cut] + " …"
}

// update reads any complete lines appended since the last call. It reports
// whether the conversation changed.
func (t *transcript) update() bool {
	f, err := os.Open(t.path)
	if err != nil {
		return false
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || fi.Size() == t.offset {
		return false
	}
	if fi.Size() < t.offset { // rewritten
		anc, pfx := t.ancestors, t.prefix
		*t = *newTranscript(t.path, t.format)
		t.ancestors, t.prefix = anc, pfx
	}
	f.Seek(t.offset, io.SeekStart)
	r := bufio.NewReaderSize(f, 1<<20)
	if t.partial {
		skip, err := r.ReadBytes('\n')
		if err != nil {
			return false
		}
		t.offset += int64(len(skip))
		t.partial = false
		t.began = t.offset
	}
	changed := false
	for t.limit == 0 || t.offset < t.limit {
		line, err := r.ReadBytes('\n')
		if err != nil { // incomplete trailing line: retry next tick
			break
		}
		t.lineAt = t.offset
		t.offset += int64(len(line))
		changed = t.line(line) || changed
	}
	if len(t.msgs) > maxMessages*2 && t.limit == 0 { // a bounded read keeps all it reads
		t.dropped += len(t.msgs) - maxMessages
		t.msgs = append([]*Message(nil), t.msgs[len(t.msgs)-maxMessages:]...)
	}
	return changed
}

// openTail reads only the end of a long log: enough of it to fill the view,
// growing the window when the last few megabytes hold too few messages. A
// 40 MB Claude session otherwise takes most of a second to open.
func (t *transcript) openTail() {
	fi, err := os.Stat(t.path)
	if err != nil {
		return
	}
	anc := t.ancestors
	for win := int64(1 << 20); ; win *= 4 {
		*t = *newTranscript(t.path, t.format)
		t.ancestors = anc
		if win >= fi.Size() {
			t.update()
			break
		}
		t.offset, t.partial = fi.Size()-win, true
		t.update()
		if len(t.msgs) >= maxMessages/2 {
			break
		}
	}
	if len(anc) > 0 && len(t.msgs) < maxMessages {
		need := maxMessages - len(t.msgs)
		var pfx []*Message
		for i := len(anc) - 1; i >= 0 && len(pfx) < need; i-- {
			at := newTranscript(anc[i], t.format)
			at.openTail()
			av := at.view()
			if len(av) > need-len(pfx) {
				av = av[len(av)-(need-len(pfx)):]
			}
			pfx = append(append([]*Message(nil), av...), pfx...)
		}
		t.prefix = pfx
	}
}

// msgSync sends a transcript to one viewer as patches: the first carries the
// whole view, later ones only the messages from the first one that changed
// (a tool call gets its output, a new message lands), so a long conversation
// is not sent again on every line.
type msgSync struct {
	sent map[int]string // position → the message as last sent
}

type msgPatch struct {
	Base    int        `json:"base"` // position of the first message in the view
	From    int        `json:"from"` // position of msgs[0]
	Msgs    []*Message `json:"msgs"`
	Earlier int64      `json:"earlier,omitempty"` // cursor for older messages (see earlier)
}

// patch: what changed since the last call, or nil.
func (m *msgSync) patch(t *transcript) *msgPatch {
	view := t.view()
	total := len(t.prefix) + len(t.msgs)
	base := t.dropped + total - len(view)
	enc := make([]string, len(view))
	for i, msg := range view {
		b, _ := json.Marshal(msg)
		enc[i] = string(b)
	}
	from := base + len(view)
	if m.sent == nil {
		from = base
	} else {
		for i, s := range enc {
			if m.sent[base+i] != s {
				from = base + i
				break
			}
		}
		if from == base+len(view) && len(m.sent) == len(view) {
			if _, ok := m.sent[base]; ok {
				return nil
			}
		}
	}
	m.sent = make(map[int]string, len(enc))
	for i, s := range enc {
		m.sent[base+i] = s
	}
	return &msgPatch{Base: base, From: from, Msgs: append([]*Message{}, view[from-base:]...), Earlier: t.earlierCursor()}
}

func (t *transcript) add(m *Message) { m.at = t.lineAt; t.msgs = append(t.msgs, m) }

// earlierCursor: where the messages before the view end, or 0 when the view
// starts at the top of the log.
func (t *transcript) earlierCursor() int64 {
	view := t.view()
	if len(view) == 0 || (len(t.prefix) == 0 && t.began == 0 && len(view) == len(t.msgs) && t.dropped == 0) {
		return 0
	}
	if view[0].at > 0 {
		return view[0].at
	}
	return 0
}

// earlierMessages reads the messages whose lines start before `before`: the
// last `want` of them, and the cursor for the ones before those (0: none).
// It reads a little past `before` too, so a tool call there gets its output.
func earlierMessages(path, format string, before int64, want int) ([]*Message, int64) {
	fi, err := os.Stat(path)
	if err != nil || before <= 0 {
		return nil, 0
	}
	end := min(fi.Size(), before+1<<20)
	for win := int64(4 << 20); ; win *= 4 {
		t := newTranscript(path, format)
		if start := before - win; start > 0 {
			t.offset, t.partial = start, true
		}
		t.limit = end
		t.update()
		all := t.msgs
		if len(t.pendingImgs) > 0 {
			all = append(append([]*Message(nil), t.msgs...), &Message{Kind: "assistant", Text: strings.Join(t.pendingImgs, "\n"), at: t.lineAt})
		}
		var keep []*Message
		for _, m := range all {
			if m.at < before {
				keep = append(keep, m)
			}
		}
		// Read from the top of the log: nothing is older than what we have.
		top := t.began == 0
		if len(keep) > want {
			keep = keep[len(keep)-want:]
			return keep, keep[0].at
		}
		if top {
			if t.dropped > 0 && len(keep) > 0 {
				return keep, keep[0].at
			}
			return keep, 0
		}
	}
}

// line parses one complete log line.
func (t *transcript) line(line []byte) bool {
	switch t.format {
	case "codex":
		return t.codexLine(line)
	case "agy":
		return t.agyLine(line)
	case "gemini":
		return t.geminiLine(line)
	}
	return t.claudeLine(line)
}

func (t *transcript) view() []*Message {
	msgs := t.msgs
	if len(t.pendingImgs) > 0 {
		msgs = append(append([]*Message(nil), t.msgs...), &Message{Kind: "assistant", Text: strings.Join(t.pendingImgs, "\n"), at: t.lineAt})
	}
	if len(t.prefix) == 0 {
		if len(msgs) > maxMessages {
			return msgs[len(msgs)-maxMessages:]
		}
		return msgs
	}
	all := make([]*Message, 0, len(t.prefix)+len(msgs))
	all = append(all, t.prefix...)
	all = append(all, msgs...)
	if len(all) > maxMessages {
		return all[len(all)-maxMessages:]
	}
	return all
}

var msgImageRefRe = regexp.MustCompile(`(?i)\.(?:png|jpe?g|gif|webp|svg|bmp)\b`)

// noise filters harness-injected text that isn't part of the human conversation.
func noise(s string) bool {
	s = strings.TrimSpace(s)
	return s == "" || strings.HasPrefix(s, "<") || strings.HasPrefix(s, "# AGENTS.md") ||
		strings.HasPrefix(s, "Caveat: ")
}

func toolSummary(name string, raw json.RawMessage) string {
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil {
		var s string
		if json.Unmarshal(raw, &s) == nil && json.Unmarshal([]byte(s), &m) != nil {
			return clip(s, maxInput)
		}
	}
	for _, k := range []string{"command", "cmd", "CommandLine", "file_path", "path", "Path", "AbsolutePath", "TargetFile", "pattern", "Query", "query", "url", "Url", "description", "prompt"} {
		switch v := m[k].(type) {
		case string:
			// agy encodes argument values as JSON strings ("\"ls -la\"").
			var inner string
			if json.Unmarshal([]byte(v), &inner) == nil {
				v = inner
			}
			return clip(v, maxInput)
		case []any:
			parts := make([]string, 0, len(v))
			for _, p := range v {
				if s, ok := p.(string); ok {
					parts = append(parts, s)
				}
			}
			return clip(strings.Join(parts, " "), maxInput)
		}
	}
	b, _ := json.Marshal(m)
	return clip(string(b), maxInput)
}

// textOf flattens string-or-blocks content into plain text, also extracting
// any embedded base64 / data-URL images as [image:...] tokens.
func textOf(raw json.RawMessage) string {
	text, _ := textAndImagesOf(raw)
	return text
}

func textAndImagesOf(raw json.RawMessage) (string, []string) {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s, nil
	}
	var blocks []struct {
		Type     string          `json:"type"`
		Text     string          `json:"text"`
		ImageURL json.RawMessage `json:"image_url"`
		Source   imageSource     `json:"source"`
	}
	if json.Unmarshal(raw, &blocks) != nil {
		return "", nil
	}
	var b strings.Builder
	var imgs []string
	for _, bl := range blocks {
		if bl.Text != "" {
			if b.Len() > 0 {
				b.WriteString("\n")
			}
			b.WriteString(bl.Text)
			continue
		}
		switch bl.Type {
		case "image":
			if tok := imageToken(bl.Source); strings.HasPrefix(tok, "[image:") {
				imgs = append(imgs, tok)
			} else if b.Len() == 0 {
				b.WriteString("[image]")
			}
		case "input_image", "output_image", "image_url":
			var u string
			if json.Unmarshal(bl.ImageURL, &u) != nil {
				var obj struct {
					URL string `json:"url"`
				}
				_ = json.Unmarshal(bl.ImageURL, &obj)
				u = obj.URL
			}
			if tok := imageDataURLToken(u); strings.HasPrefix(tok, "[image:") {
				imgs = append(imgs, tok)
			}
		}
	}
	return b.String(), imgs
}

func (t *transcript) claudeLine(line []byte) bool {
	var e struct {
		Type      string `json:"type"`
		IsMeta    bool   `json:"isMeta"`
		Sidechain bool   `json:"isSidechain"`
		Message   struct {
			ID      string          `json:"id"`
			Content json.RawMessage `json:"content"`
		} `json:"message"`
		Origin *struct {
			Kind string `json:"kind"`
			Name string `json:"name"`
			Body string `json:"body"`
		} `json:"origin"`
		Attachment *struct {
			Type   string          `json:"type"`
			Prompt json.RawMessage `json:"prompt"`
			Origin *struct {
				Kind string `json:"kind"`
				Name string `json:"name"`
			} `json:"origin"`
		} `json:"attachment"`
	}
	if json.Unmarshal(line, &e) != nil || e.Sidechain {
		return false
	}
	// What the human typed while the agent was busy is logged as a queued
	// command once the agent takes it, not as a user line.
	if a := e.Attachment; e.Type == "attachment" && a != nil && a.Type == "queued_command" {
		kind := ""
		if a.Origin != nil {
			kind = a.Origin.Kind
		}
		text := promptText(a.Prompt)
		if body, ok := collieBody(text); ok {
			text, kind = body, "human"
		}
		if kind != "human" || strings.TrimSpace(text) == "" || noise(text) {
			return false
		}
		t.add(&Message{Kind: "user", Text: strings.TrimSpace(text)})
		t.lastID = ""
		return true
	}
	if len(e.Message.Content) == 0 {
		return false
	}
	if e.IsMeta {
		// A message Collie delivered through the peer inbox is logged as meta; it is the human's.
		if e.Type != "user" || e.Origin == nil || e.Origin.Kind != "peer" || e.Origin.Name != "Collie" {
			return false
		}
		body := stripPeerHead(e.Origin.Body)
		if body == "" {
			return false
		}
		t.add(&Message{Kind: "user", Text: body})
		t.lastID = ""
		return true
	}
	switch e.Type {
	case "user":
		var s string
		if json.Unmarshal(e.Message.Content, &s) == nil {
			if body, ok := collieBody(s); ok {
				s = body // a message Collie delivered through the peer inbox
			}
			if noise(s) {
				return false
			}
			t.add(&Message{Kind: "user", Text: s})
			t.lastID = ""
			return true
		}
		var blocks []struct {
			Type      string          `json:"type"`
			Text      string          `json:"text"`
			ToolUseID string          `json:"tool_use_id"`
			Content   json.RawMessage `json:"content"`
			IsError   bool            `json:"is_error"`
			Source    imageSource     `json:"source"`
		}
		json.Unmarshal(e.Message.Content, &blocks)
		changed := false
		var text []string
		for _, b := range blocks {
			switch b.Type {
			case "tool_result":
				if m := t.tools[b.ToolUseID]; m != nil {
					m.Output = clip(textOf(b.Content), maxOutput)
					m.Error = b.IsError
					changed = true
				}
			case "text":
				if !noise(b.Text) {
					text = append(text, b.Text)
				}
			case "image":
				text = append(text, imageToken(b.Source))
			}
		}
		if len(text) > 0 {
			t.add(&Message{Kind: "user", Text: strings.Join(text, "\n")})
			t.lastID = ""
			changed = true
		}
		return changed
	case "assistant":
		var blocks []struct {
			Type  string          `json:"type"`
			Text  string          `json:"text"`
			ID    string          `json:"id"`
			Name  string          `json:"name"`
			Input json.RawMessage `json:"input"`
		}
		json.Unmarshal(e.Message.Content, &blocks)
		changed := false
		for _, b := range blocks {
			switch b.Type {
			case "text":
				if strings.TrimSpace(b.Text) == "" {
					continue
				}
				// Claude Code streams one API message as several entries; merge them.
				if n := len(t.msgs); n > 0 && t.lastID == e.Message.ID && t.msgs[n-1].Kind == "assistant" {
					t.msgs[n-1].Text += "\n\n" + b.Text
				} else {
					t.add(&Message{Kind: "assistant", Text: b.Text})
				}
				changed = true
			case "tool_use":
				if m := askOf(b.Name, b.Input); m != nil {
					if m.Name == "AskUserQuestion" {
						t.tools[b.ID] = m // its result is the answer
					}
					t.add(m)
					changed = true
					continue
				}
				m := &Message{Kind: "tool", Name: b.Name, Input: toolSummary(b.Name, b.Input)}
				t.tools[b.ID] = m
				t.add(m)
				changed = true
			}
		}
		t.lastID = e.Message.ID
		return changed
	}
	return false
}

func (t *transcript) codexLine(line []byte) bool {
	var e struct {
		Type    string `json:"type"`
		Payload struct {
			Type      string          `json:"type"`
			Role      string          `json:"role"`
			Content   json.RawMessage `json:"content"`
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
			Input     json.RawMessage `json:"input"`
			CallID    string          `json:"call_id"`
			Output    json.RawMessage `json:"output"`
		} `json:"payload"`
	}
	if json.Unmarshal(line, &e) != nil || e.Type != "response_item" {
		return false
	}
	p := e.Payload
	switch p.Type {
	case "message":
		if p.Role != "user" && p.Role != "assistant" {
			return false
		}
		var blocks []struct {
			Type     string          `json:"type"`
			Text     string          `json:"text"`
			ImageURL json.RawMessage `json:"image_url"`
			Source   imageSource     `json:"source"`
		}
		json.Unmarshal(p.Content, &blocks)
		var parts []string
		for _, b := range blocks {
			switch b.Type {
			case "input_image", "output_image", "image_url":
				var u string
				if json.Unmarshal(b.ImageURL, &u) != nil {
					var obj struct {
						URL string `json:"url"`
					}
					_ = json.Unmarshal(b.ImageURL, &obj)
					u = obj.URL
				}
				if tok := imageDataURLToken(u); tok != "" {
					parts = append(parts, tok)
				}
				continue
			case "image":
				if tok := imageToken(b.Source); tok != "" {
					parts = append(parts, tok)
				}
				continue
			}
			if p.Role == "assistant" || !noise(b.Text) {
				if strings.TrimSpace(b.Text) != "" {
					parts = append(parts, b.Text)
				}
			}
		}
		if len(parts) == 0 {
			return false
		}
		joined := strings.Join(parts, "\n\n")
		if p.Role == "user" && len(t.pendingImgs) > 0 {
			t.add(&Message{Kind: "assistant", Text: strings.Join(t.pendingImgs, "\n")})
			t.pendingImgs = nil
		} else if p.Role == "assistant" && len(t.pendingImgs) > 0 {
			if strings.Contains(joined, "[image:") || msgImageRefRe.MatchString(joined) {
				t.pendingImgs = nil
			} else {
				joined += "\n\n" + strings.Join(t.pendingImgs, "\n")
				t.pendingImgs = nil
			}
		}
		t.add(&Message{Kind: p.Role, Text: joined})
		return true
	case "image_generation_call":
		var ig struct {
			Result string `json:"result"`
		}
		if json.Unmarshal(line, &struct {
			Payload *struct {
				Result string `json:"result"`
			} `json:"payload"`
		}{Payload: &ig}) == nil && strings.TrimSpace(ig.Result) != "" {
			tok := imageDataURLToken(ig.Result)
			if tok == "" {
				tok = imageToken(imageSource{Type: "base64", MediaType: "image/png", Data: ig.Result})
			}
			if strings.HasPrefix(tok, "[image:") {
				t.pendingImgs = append(t.pendingImgs, tok)
				return true
			}
		}
	case "function_call", "custom_tool_call", "local_shell_call":
		args := p.Arguments
		if len(args) == 0 {
			args = p.Input
		}
		m := &Message{Kind: "tool", Name: p.Name, Input: toolSummary(p.Name, args)}
		if m.Name == "" {
			m.Name = "shell"
		}
		t.tools[p.CallID] = m
		t.add(m)
		return true
	case "function_call_output", "custom_tool_call_output":
		txt, imgs := textAndImagesOf(p.Output)
		changed := false
		isViewOnly := false
		if m := t.tools[p.CallID]; m != nil {
			m.Output = clip(txt, maxOutput)
			inp := strings.ToLower(m.Input)
			isViewOnly = m.Name == "view_image" || (strings.Contains(inp, "view_image") && !strings.Contains(inp, "imagegen") && !strings.Contains(inp, "image_gen"))
			changed = true
		}
		if len(imgs) > 0 && (!isViewOnly || strings.Contains(txt, "Generated images are saved")) {
			t.pendingImgs = append(t.pendingImgs, imgs...)
			changed = true
		}
		return changed
	}
	return false
}

var agyRequestRe = regexp.MustCompile(`(?s)<USER_REQUEST>\s*(.*?)\s*</USER_REQUEST>`)

// agyLine parses Antigravity CLI's brain/<id>/.system_generated/logs/transcript.jsonl.
func (t *transcript) agyLine(line []byte) bool {
	var e struct {
		Type      string `json:"type"`
		Source    string `json:"source"`
		Content   string `json:"content"`
		ToolCalls []struct {
			Name string          `json:"name"`
			Args json.RawMessage `json:"args"`
		} `json:"tool_calls"`
	}
	if json.Unmarshal(line, &e) != nil {
		return false
	}
	switch e.Type {
	case "USER_INPUT":
		text := e.Content
		if m := agyRequestRe.FindStringSubmatch(text); m != nil {
			text = m[1]
		} else if noise(text) {
			return false
		}
		if strings.TrimSpace(text) == "" {
			return false
		}
		t.add(&Message{Kind: "user", Text: text})
		return true
	case "PLANNER_RESPONSE":
		changed := false
		if strings.TrimSpace(e.Content) != "" {
			t.add(&Message{Kind: "assistant", Text: e.Content})
			changed = true
		}
		for _, c := range e.ToolCalls {
			m := &Message{Kind: "tool", Name: c.Name, Input: agyToolSummary(c.Args)}
			t.add(m)
			t.pending = append(t.pending, m)
			changed = true
		}
		return changed
	case "GENERIC":
		if len(t.pending) == 0 {
			return false
		}
		m := t.pending[0]
		t.pending = t.pending[1:]
		m.Output = clip(agyOutput(e.Content), maxOutput)
		m.Error = strings.Contains(e.Content, "exited with code") && !strings.Contains(e.Content, "exited with code 0")
		return true
	case "ERROR_MESSAGE":
		if strings.TrimSpace(e.Content) == "" {
			return false
		}
		t.add(&Message{Kind: "assistant", Text: "⚠ " + e.Content})
		return true
	}
	return false
}

func agyToolSummary(raw json.RawMessage) string {
	var m map[string]string
	if json.Unmarshal(raw, &m) == nil {
		if s, ok := m["toolSummary"]; ok {
			var inner string
			if json.Unmarshal([]byte(s), &inner) == nil && inner != "" {
				// prefer the concrete command/path, fall back to the summary
				if c := toolSummary("", raw); c != "" && !strings.HasPrefix(c, "{") {
					return c
				}
				return clip(inner, maxInput)
			}
		}
	}
	return toolSummary("", raw)
}

// agyOutput drops agy's timing preamble from a tool result.
func agyOutput(s string) string {
	lines := strings.Split(strings.ReplaceAll(s, "\r\n", "\n"), "\n")
	out := lines[:0]
	for _, l := range lines {
		if strings.HasPrefix(l, "Created At:") || strings.HasPrefix(l, "Completed At:") {
			continue
		}
		out = append(out, l)
	}
	return strings.TrimSpace(strings.Join(out, "\n"))
}

// geminiLine parses Gemini CLI's ~/.gemini/tmp/*/chats/session-*.jsonl logs.
func (t *transcript) geminiLine(line []byte) bool {
	type geminiMsg struct {
		Type      string          `json:"type"`
		Content   json.RawMessage `json:"content"`
		ToolCalls []struct {
			ID     string          `json:"id"`
			Name   string          `json:"name"`
			Args   json.RawMessage `json:"args"`
			Result json.RawMessage `json:"result"`
			Status string          `json:"status"`
		} `json:"toolCalls"`
	}
	addOne := func(gm geminiMsg) bool {
		changed := false
		txt := strings.TrimSpace(textOf(gm.Content))
		switch gm.Type {
		case "user":
			if txt != "" && !noise(txt) {
				t.add(&Message{Kind: "user", Text: txt})
				changed = true
			}
		case "gemini", "model", "assistant":
			if txt != "" {
				t.add(&Message{Kind: "assistant", Text: txt})
				changed = true
			}
			for _, tc := range gm.ToolCalls {
				m := &Message{Kind: "tool", Name: tc.Name, Input: toolSummary(tc.Name, tc.Args)}
				if len(tc.Result) > 0 && string(tc.Result) != "null" {
					m.Output = clip(textOf(tc.Result), maxOutput)
				}
				m.Error = tc.Status == "error"
				t.add(m)
				changed = true
			}
		}
		return changed
	}
	var env struct {
		Set *struct {
			Messages []geminiMsg `json:"messages"`
		} `json:"$set"`
		Push *struct {
			Messages json.RawMessage `json:"messages"`
		} `json:"$push"`
		Type    string          `json:"type"`
		Content json.RawMessage `json:"content"`
	}
	if json.Unmarshal(line, &env) != nil {
		return false
	}
	if env.Set != nil && len(env.Set.Messages) > 0 {
		t.msgs = nil
		changed := false
		for _, gm := range env.Set.Messages {
			changed = addOne(gm) || changed
		}
		return changed
	}
	if env.Push != nil && len(env.Push.Messages) > 0 {
		var many []geminiMsg
		if json.Unmarshal(env.Push.Messages, &many) == nil {
			changed := false
			for _, gm := range many {
				changed = addOne(gm) || changed
			}
			return changed
		}
		var one geminiMsg
		if json.Unmarshal(env.Push.Messages, &one) == nil {
			return addOne(one)
		}
	}
	if env.Type != "" {
		return addOne(geminiMsg{Type: env.Type, Content: env.Content})
	}
	return false
}

// ---------------------------------------------------------------- locating

type agentDetail struct {
	Agent   *string `json:"agent"`
	Status  string  `json:"agent_status"`
	Cwd     *string `json:"cwd"`
	Session *struct {
		Kind  string `json:"kind"`
		Value string `json:"value"`
	} `json:"agent_session"`
}

var claimed = struct {
	sync.Mutex
	m map[string]string // transcript path → pane
}{m: map[string]string{}}

// transcriptFor resolves (and caches) the transcript for the agent in a pane.
func (s *Server) transcriptFor(key, pane string, a agentDetail, cache map[string]*transcript) *transcript {
	kind := deref(a.Agent)
	sessKind, value := "", ""
	if a.Session != nil {
		sessKind, value = a.Session.Kind, a.Session.Value
	}
	cwd := deref(a.Cwd)
	if kind == "codex" && value != "" {
		local, _ := split(pane)
		if f := s.herdr.Forked(local); f != "" {
			sessKind, value = "id", f
		}
	}
	ck := key + "|" + kind + "|" + sessKind + ":" + value
	if tr := cache[ck]; tr != nil {
		return tr
	}
	path, format := s.findTranscript(kind, sessKind, value, pane, cwd)
	if path == "" {
		return nil
	}
	tr := s.newChainedTranscript(path, format)
	cache[ck] = tr
	return tr
}

func (s *Server) newChainedTranscript(path, format string) *transcript {
	tr := newTranscript(path, format)
	if format == "codex" {
		if chain := s.codexRolloutChain(path); len(chain) > 1 {
			tr.withAncestors(chain[:len(chain)-1])
		}
	}
	return tr
}

func newestRegularFile(paths []string) string {
	var best string
	var bestAt time.Time
	for _, p := range paths {
		if fi, err := os.Stat(p); err == nil && fi.Mode().IsRegular() && (best == "" || fi.ModTime().After(bestAt)) {
			best, bestAt = p, fi.ModTime()
		}
	}
	return best
}

func (s *Server) findTranscript(kind, sessKind, value, pane, cwd string) (path, format string) {
	format = kind
	if kind != "codex" && kind != "agy" && kind != "gemini" {
		format = "claude"
	}
	if sessKind == "path" {
		if isFile(value) {
			return value, format
		}
		// If the path does not exist directly (or rotated), extract its session UUID and search below.
		value = sessionID("path", value)
	}
	if strings.ContainsAny(value, `/\*?[`) {
		return "", ""
	}
	switch kind {
	case "claude":
		if value == "" {
			return "", ""
		}
		root := envOr("CLAUDE_CONFIG_DIR", filepath.Join(s.home, ".claude"))
		if m, _ := filepath.Glob(filepath.Join(root, "projects", "*", value+".jsonl")); len(m) > 0 {
			return newestRegularFile(m), "claude"
		}
	case "codex":
		if value == "" {
			return "", ""
		}
		root := envOr("CODEX_HOME", filepath.Join(s.home, ".codex"))
		// Codex names resumed or desktop-app rollouts either `rollout-*-<session>.jsonl`
		// or `rollout-*-<session>_<segment>.jsonl`; match both and pick the newest segment.
		var matches []string
		for _, pat := range []string{
			filepath.Join(root, "sessions", "*", "*", "*", "rollout-*"+value+".jsonl"),
			filepath.Join(root, "sessions", "*", "*", "*", "rollout-*"+value+"_*.jsonl"),
		} {
			if m, _ := filepath.Glob(pat); len(m) > 0 {
				matches = append(matches, m...)
			}
		}
		if best := newestRegularFile(matches); best != "" {
			return best, "codex"
		}
		if dbPath := s.codexRolloutFromStateDB(value); dbPath != "" {
			return dbPath, "codex"
		}
	case "agy":
		brain := filepath.Join(s.agyCLIHome(), "brain")
		if value != "" {
			for _, b := range []string{brain, filepath.Join(s.home, ".gemini", "antigravity", "brain")} {
				if p := filepath.Join(b, value, ".system_generated", "logs", "transcript.jsonl"); isFile(p) {
					return p, "agy"
				}
			}
		}
		return s.guessAgy(brain, pane, cwd), "agy"
	case "gemini":
		root := filepath.Join(s.home, ".gemini", "tmp")
		if value != "" {
			prefix := value
			if i := strings.IndexByte(prefix, '-'); i > 0 {
				prefix = prefix[:i]
			}
			if m, _ := filepath.Glob(filepath.Join(root, "*", "chats", "session-*"+prefix+"*.jsonl")); len(m) > 0 {
				return newestRegularFile(m), "gemini"
			}
		}
		if cwd != "" {
			if dirs, _ := filepath.Glob(filepath.Join(root, "*")); len(dirs) > 0 {
				var matches []string
				for _, d := range dirs {
					if b, err := os.ReadFile(filepath.Join(d, ".project_root")); err == nil && samePath(strings.TrimSpace(string(b)), cwd) {
						if m, _ := filepath.Glob(filepath.Join(d, "chats", "session-*.jsonl")); len(m) > 0 {
							matches = append(matches, m...)
						}
					}
				}
				if best := newestRegularFile(matches); best != "" {
					return best, "gemini"
				}
			}
		}
	}
	return "", ""
}

func isFile(p string) bool { fi, err := os.Stat(p); return err == nil && fi.Mode().IsRegular() }

// ---------------------------------------------------------------- approvals

type Choice struct {
	Label   string   `json:"label"`
	Keys    []string `json:"keys,omitempty"`
	Text    string   `json:"text,omitempty"`
	Desc    string   `json:"desc,omitempty"` // a line under the option that explains it
	Current bool     `json:"current,omitempty"`
}

type Approval struct {
	Title    string   `json:"title"`
	Question string   `json:"question"`
	Choices  []Choice `json:"choices"`
	Hint     string   `json:"hint,omitempty"`
	Screen   string   `json:"screen"`
	after    int      // lines of other text below the menu
}

var (
	numberedRe = regexp.MustCompile(`^\s*([❯›>▸●➜→]\s*)?(\d)[.)]\s+(.{1,90}?)\s*$`)
	cursorRe   = regexp.MustCompile(`^\s*[❯›>▸●➜→]\s+(.{1,90}?)\s*$`)
	hintRe     = regexp.MustCompile(`(?i)(enter|esc|↑|↓|tab)\b.*(confirm|cancel|select|navigate|continue)`)
	frameRe    = regexp.MustCompile(`^[\s│┃|╭╮╰╯─━═┌┐└┘╌┄┈]*$`)
	ruleRe     = regexp.MustCompile(`[─━═]{12,}`)
)

// parseApproval turns the bottom of a blocked agent's screen into a question
// and a set of choices. Numbered menus answer with the digit; cursor menus
// ("❯ Yes / No") answer by moving the cursor and pressing Enter.
func parseApproval(screen string) Approval {
	// Blank and frame lines become paragraph breaks (""), so the card can
	// reflow the dialog's text; a long rule marks where the dialog begins.
	var lines []string
	top, width := 0, 0
	for _, l := range strings.Split(screen, "\n") {
		width = max(width, cells(strings.TrimRight(l, " ")))
		l = strings.TrimRight(strings.Trim(strings.TrimRight(l, " "), "│┃"), " ")
		if frameRe.MatchString(l) {
			if ruleRe.MatchString(l) {
				top = len(lines)
			}
			if len(lines) > 0 && lines[len(lines)-1] != "" {
				lines = append(lines, "")
			}
			continue
		}
		lines = append(lines, l)
	}
	a := Approval{Screen: strings.Join(tailSlice(lines, 18), "\n")}

	// Find the menu block: the last run of numbered or cursor-style options.
	end := -1
	for i := len(lines) - 1; i >= 0; i-- {
		if numberedRe.MatchString(lines[i]) || cursorRe.MatchString(lines[i]) {
			end = i
			break
		}
		if hintRe.MatchString(lines[i]) && a.Hint == "" {
			a.Hint = strings.TrimSpace(lines[i])
		}
	}
	if end < 0 {
		a.Question = strings.Join(tailSlice(trimBlank(lines), 6), "\n")
		return a
	}
	start := end
	numbered := numberedRe.MatchString(lines[end])
	// A narrow pane wraps long options onto deeper-indented lines.
	wrapped := func(l string) bool {
		return strings.TrimSpace(l) != "" && len(l)-len(strings.TrimLeft(l, " ")) >= 4 && !numberedRe.MatchString(l)
	}
	digit := func(l string) int {
		if m := numberedRe.FindStringSubmatch(l); m != nil {
			return int(m[2][0] - '0')
		}
		return -1
	}
	first := digit(lines[end]) // the lowest option number found so far
	for start > 0 {
		prev := lines[start-1]
		if numbered && (numberedRe.MatchString(prev) || wrapped(prev)) {
			if d := digit(prev); d >= 0 {
				first = d
			}
			start--
			continue
		}
		// Claude's question box sets its last options apart with a rule
		// ("4. Type something." ── "5. Chat about this"): one menu if the
		// numbers carry on across the break.
		if numbered && prev == "" && start >= 2 {
			j := start - 2
			for j > 0 && wrapped(lines[j]) {
				j--
			}
			if d := digit(lines[j]); d >= 0 && d == first-1 {
				start--
				continue
			}
		}
		// cursor menus: siblings are indented plain lines next to the ❯ line
		if !numbered && strings.TrimSpace(prev) != "" && (cursorRe.MatchString(prev) || strings.HasPrefix(prev, "  ")) &&
			len(strings.TrimSpace(prev)) <= 90 && !strings.HasSuffix(strings.TrimSpace(prev), "?") && !strings.HasSuffix(strings.TrimSpace(prev), "？") {
			start--
			continue
		}
		break
	}
	for numbered && start < end && !numberedRe.MatchString(lines[start]) {
		start++
	}
	// Cursor menus may continue below the ❯ line.
	for !numbered && end+1 < len(lines) && strings.HasPrefix(lines[end+1], "  ") && strings.TrimSpace(lines[end+1]) != "" &&
		!hintRe.MatchString(lines[end+1]) {
		end++
	}
	for _, l := range lines[end+1:] {
		if strings.TrimSpace(l) != "" && !hintRe.MatchString(l) {
			a.after++
		}
	}

	cur := -1
	opts := lines[start : end+1]
	for i, l := range opts {
		if t := strings.TrimSpace(l); t != "" && (cursorRe.MatchString(l) || strings.ContainsAny(t[:1], "❯›>▸●➜→")) {
			cur = i
		}
	}
	for i, l := range opts {
		if numbered {
			m := numberedRe.FindStringSubmatch(l)
			if m == nil {
				if n := len(a.Choices); n > 0 && wrapped(l) {
					// The terminal wraps a line only when the next word does
					// not fit; a line that would have fit explains the option.
					c, t := &a.Choices[n-1], strings.TrimSpace(l)
					above := strings.TrimRight(opts[i-1], " ")
					switch {
					case c.Desc != "":
						c.Desc += " " + t
					case cells(above)+1+cells(strings.Fields(t)[0]) <= width:
						c.Desc = t
					default:
						c.Label += " " + t
					}
				}
				continue
			}
			a.Choices = append(a.Choices, Choice{Label: m[3], Text: m[2], Current: m[1] != ""})
			continue
		}
		label := strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(l), "❯›>▸●➜→"))
		if label == "" {
			continue
		}
		var keys []string
		if cur >= 0 {
			for d := cur; d < i; d++ {
				keys = append(keys, "down")
			}
			for d := cur; d > i; d-- {
				keys = append(keys, "up")
			}
		}
		keys = append(keys, "enter")
		a.Choices = append(a.Choices, Choice{Label: label, Keys: keys, Current: i == cur})
	}
	if len(a.Choices) < 2 || len(a.Choices) > 9 {
		a.Choices = nil
	}
	from := start - 18
	if top > from && top < start {
		from = top
	}
	if from < 0 {
		from = 0
	}
	a.Question = strings.Join(trimBlank(lines[from:start]), "\n")
	return a
}

// cells: how many terminal columns s takes (CJK and full-width take two).
func cells(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x1100 && (r <= 0x115f || (r >= 0x2e80 && r <= 0xa4cf) || (r >= 0xac00 && r <= 0xd7a3) ||
			(r >= 0xf900 && r <= 0xfaff) || (r >= 0xfe30 && r <= 0xfe4f) || (r >= 0xff00 && r <= 0xff60) || (r >= 0xffe0 && r <= 0xffe6)) {
			n += 2
		} else {
			n++
		}
	}
	return n
}

func trimBlank(ls []string) []string {
	for len(ls) > 0 && strings.TrimSpace(ls[0]) == "" {
		ls = ls[1:]
	}
	for len(ls) > 0 && strings.TrimSpace(ls[len(ls)-1]) == "" {
		ls = ls[:len(ls)-1]
	}
	return ls
}

func tailSlice(ls []string, n int) []string {
	if len(ls) > n {
		return ls[len(ls)-n:]
	}
	return ls
}

func tailLines(s string, n int) string {
	var keep []string
	for _, l := range strings.Split(s, "\n") {
		l = strings.TrimRight(l, " \t")
		if strings.TrimSpace(strings.Trim(l, "─━═│╭╮╰╯")) == "" {
			continue
		}
		keep = append(keep, l)
	}
	return strings.Join(tailSlice(keep, n), "\n")
}

// activityLine is what a working agent says it is doing ("Thinking…",
// "Running tests…"): the bottom of its screen without the input box, the
// key hints and the spinner, which mean nothing outside the terminal. The
// status line's own counters ("42s · ↓ 1.8k tokens") come back as meta.
var (
	liveHint    = regexp.MustCompile(`\s*[(（][^()（）]*(esc to (interrupt|cancel)|ctrl\+c)[^()（）]*[)）]`)
	liveParen   = regexp.MustCompile(`\s*[(（]([^()（）]*)[)）]\s*$`)
	liveKey     = regexp.MustCompile(`(?i)\besc\b|ctrl\+|to (interrupt|cancel|expand)`)
	liveDigit   = regexp.MustCompile(`\d`)
	liveChrome  = regexp.MustCompile(`(?i)esc to (interrupt|cancel)|shift\+tab|for shortcuts|auto mode|bypass permissions|accept edits|plan mode|ctrl\+[a-z] to |^[❯>›]( |$)|^[⏵▸►»⏎]|⏎ send`)
	liveBullet  = regexp.MustCompile(`^[✻✽✢✶✳✺✹✸✷·*•◐◓◑◒◔◕○●⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]+\s*`)
	liveSpinner = regexp.MustCompile(`^[✻✽✢✶✳✺✹✸✷·*◐◓◑◒◔◕⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]`) // animated: a status line
)

func activityLine(screen string) (text, meta string) {
	var keep []string
	status, statusMeta := "", ""
	for _, l := range strings.Split(screen, "\n") {
		l = strings.TrimSpace(strings.Trim(strings.TrimSpace(l), "│┃|"))
		hinted := liveHint.MatchString(l)
		m := ""
		if liveSpinner.MatchString(l) || hinted {
			l, m = splitCounters(l)
		}
		l = strings.TrimSpace(liveHint.ReplaceAllString(l, ""))
		if l == "" || strings.Trim(l, "─━═╭╮╰╯ ") == "" || liveChrome.MatchString(l) {
			continue
		}
		spun := liveSpinner.MatchString(l)
		l = strings.TrimSpace(liveBullet.ReplaceAllString(l, ""))
		if hinted || spun {
			status, statusMeta = l, m // the agent's own status line wins
		}
		keep = append(keep, l)
	}
	if status != "" {
		return status, statusMeta
	}
	return strings.Join(tailSlice(keep, 2), "\n"), ""
}

// splitCounters takes a status line's closing parenthetical apart:
// "Thinking… (42s · ↓ 1.8k tokens · esc to interrupt)" is "Thinking…" with
// "42s · ↓ 1.8k tokens"; the key hints go.
func splitCounters(l string) (string, string) {
	m := liveParen.FindStringSubmatchIndex(l)
	if m == nil {
		return l, ""
	}
	var counters []string
	for _, p := range strings.FieldsFunc(l[m[2]:m[3]], func(r rune) bool { return r == '·' || r == '•' }) {
		p = strings.TrimSpace(p)
		switch {
		case p == "" || liveKey.MatchString(p):
		case liveDigit.MatchString(p):
			counters = append(counters, p)
		default:
			return l, "" // words, not counters: leave the line as it is
		}
	}
	return strings.TrimSpace(l[:m[0]]), strings.Join(counters, " · ")
}

// ---------------------------------------------------------------- streaming

// streamChat wraps an agent terminal as a conversation: structured messages
// from the agent's own transcript, plus a live card with what the terminal is
// showing right now (progress, or the question it is blocked on).
func (s *Server) streamChat(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	sse, ok := newSSE(w)
	if !ok {
		return
	}
	cache := map[string]*transcript{}
	var (
		tr                *transcript
		lastLive, lastLog string
		lastMeta          string
		beat              = time.Now()
		ms                msgSync
	)
	send := func(ev string, v any) bool {
		b, _ := json.Marshal(v)
		beat = time.Now()
		return sse.send(ev, b) == nil
	}
	for {
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		var info struct {
			Agent agentDetail `json:"agent"`
		}
		err := s.herdr.Call(ctx, "agent.get", map[string]any{"target": id}, &info)
		kind, status := "", "shell"
		if err == nil && info.Agent.Agent != nil {
			kind, status = *info.Agent.Agent, info.Agent.Status
			// herdr says "idle" while a startup dialog is up (Codex's hooks
			// review, a folder trust); the header already shows it as needing
			// you, and the card with its choices belongs here too.
			if status == "idle" && s.herdr.idleButAsking(ctx, id) {
				status = "blocked"
			}
		} else if err != nil {
			if _, e := s.herdr.Read(ctx, id, "visible", "text", 1); e != nil {
				cancel()
				send("gone", map[string]any{"error": e.Error()})
				return
			}
		}

		if err == nil && kind != "" {
			if next := s.transcriptFor(id, id, info.Agent, cache); next != tr && next != nil {
				tr, lastLog = next, ""
				if !send("reset", map[string]any{}) {
					cancel()
					return
				}
			}
		}
		meta := kind + "|" + status + "|" + boolStr(tr != nil)
		if meta != lastMeta {
			lastMeta = meta
			if !send("meta", map[string]any{"kind": kind, "status": status, "structured": tr != nil}) {
				cancel()
				return
			}
		}
		if tr != nil {
			if lastLog == "" {
				tr.openTail()
				ms = msgSync{}
			}
			if tr.update() || lastLog == "" {
				lastLog = "-"
				if p := ms.patch(tr); p != nil && !send("patch", p) {
					cancel()
					return
				}
			}
		} else if res, e := s.herdr.Read(ctx, id, "recent_unwrapped", "text", 400); e == nil && res.Text != lastLog {
			// No transcript (plain shell, unknown agent): fall back to the terminal log.
			lastLog = res.Text
			if !send("log", map[string]any{"text": res.Text}) {
				cancel()
				return
			}
		}

		// Live card: progress while working, the question while blocked.
		live := map[string]any{"status": status}
		if status == "working" || status == "blocked" {
			if res, e := s.herdr.Read(ctx, id, "detection", "text", 0); e == nil {
				if status == "blocked" {
					live["approval"] = parseApproval(res.Text)
				} else {
					live["tail"], live["meta"] = activityLine(res.Text)
				}
			}
		}
		cancel()
		if b, _ := json.Marshal(live); string(b) != lastLive {
			lastLive = string(b)
			if sse.send("live", b) != nil {
				return
			}
			beat = time.Now()
		}

		if time.Since(beat) > 15*time.Second {
			sse.comment()
			beat = time.Now()
		}
		select {
		case <-r.Context().Done():
			return
		case <-time.After(700 * time.Millisecond):
		}
	}
}

func boolStr(b bool) string {
	if b {
		return "1"
	}
	return "0"
}

// lastMessage returns the agent's latest reply (or its screen), for the hub's
// worker summaries.
func (s *Server) lastMessage(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var info struct {
		Agent agentDetail `json:"agent"`
	}
	if s.herdr.Call(r.Context(), "agent.get", map[string]any{"target": id}, &info) == nil {
		if tr := s.transcriptFor("last:"+id, id, info.Agent, map[string]*transcript{}); tr != nil {
			tr.update()
			msgs := tr.view()
			for i := len(msgs) - 1; i >= 0; i-- {
				if msgs[i].Kind == "assistant" {
					writeJSON(w, 200, map[string]any{"text": msgs[i].Text})
					return
				}
			}
		}
	}
	if res, err := s.herdr.Read(r.Context(), id, "detection", "text", 0); err == nil {
		writeJSON(w, 200, map[string]any{"text": tailLines(res.Text, 14)})
		return
	}
	writeJSON(w, 404, map[string]any{"error": "pane not found"})
}

// paneAsk: the dialog a pane is showing, if any, so it can be answered from
// Collie's conversation without opening the pane.
func (s *Server) paneAsk(w http.ResponseWriter, r *http.Request) {
	res, err := s.herdr.Read(r.Context(), r.PathValue("id"), "detection", "text", 0)
	if err != nil {
		fail(w, err)
		return
	}
	if !screenAsks(res.Text) {
		writeJSON(w, 200, map[string]any{"asking": false})
		return
	}
	writeJSON(w, 200, map[string]any{"asking": true, "approval": parseApproval(res.Text)})
}

// askOf turns a question to the human into an ask item: Claude's
// AskUserQuestion, or the Claude app's end-of-turn box (its wrap_up tool,
// whose buttons just send their label back as the human's reply).
func askOf(name string, raw json.RawMessage) *Message {
	switch {
	case name == "AskUserQuestion":
		var in struct {
			Questions []struct {
				Question string `json:"question"`
				Header   string `json:"header"`
				Options  []struct {
					Label string `json:"label"`
				} `json:"options"`
			} `json:"questions"`
		}
		if json.Unmarshal(raw, &in) != nil || len(in.Questions) == 0 {
			return nil
		}
		m := &Message{Kind: "ask", Name: name}
		var qs []string
		for _, q := range in.Questions {
			qs = append(qs, q.Question)
		}
		m.Text = strings.Join(qs, "\n")
		if len(in.Questions) == 1 {
			for _, o := range in.Questions[0].Options {
				m.Options = append(m.Options, o.Label)
			}
		}
		return m
	case strings.HasSuffix(name, "__wrap_up"):
		var in struct {
			Recap   string `json:"recap"`
			Ask     string `json:"ask"`
			Actions []struct {
				Label  string `json:"label"`
				Action string `json:"action"`
			} `json:"actions"`
		}
		if json.Unmarshal(raw, &in) != nil || (in.Ask == "" && in.Recap == "") {
			return nil
		}
		if in.Ask == "" {
			return &Message{Kind: "ask", Name: "recap", Input: in.Recap} // where the turn left things
		}
		m := &Message{Kind: "ask", Name: "wrap_up", Text: in.Ask, Input: in.Recap}
		for _, a := range in.Actions {
			if a.Action == "" && a.Label != "" {
				m.Options = append(m.Options, a.Label)
			}
		}
		return m
	}
	return nil
}

// promptText reads a queued prompt: a string, or blocks of text and images.
func promptText(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var blocks []struct {
		Type   string      `json:"type"`
		Text   string      `json:"text"`
		Source imageSource `json:"source"`
	}
	json.Unmarshal(raw, &blocks)
	var out []string
	for _, b := range blocks {
		switch b.Type {
		case "text":
			if !noise(b.Text) {
				out = append(out, b.Text)
			}
		case "image":
			out = append(out, imageToken(b.Source))
		}
	}
	return strings.Join(out, "\n")
}
