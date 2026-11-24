package collie

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Talking to agents that run outside herdr, where they are, without taking
// them over:
//
//   - Claude Code (2.1.29x+) gives every interactive session a peer inbox: a
//     unix socket named in ~/.claude/sessions/<pid>.json. One JSON line there
//     is queued as a message from "another session". This covers the Claude
//     desktop app's sessions as well as any terminal.
//   - Codex (0.163+) runs a shared app-server daemon that its terminal UI is a
//     client of. Collie joins as one more client and starts (or steers) a turn.
//
// Both are messages only: approvals and questions stay on that computer.

// ---------------------------------------------------------------- Claude

type claudeReg struct {
	PID        int    `json:"pid"`
	SessionID  string `json:"sessionId"`
	Cwd        string `json:"cwd"`
	Entrypoint string `json:"entrypoint"`
	Status     string `json:"status"`
	WaitingFor string `json:"waitingFor"`
	Name       string `json:"name"`
	Socket     string `json:"messagingSocketPath"`
	Protocol   int    `json:"peerProtocol"`
	dir        string
}

// claudeRegs reads the live claudes' registrations, by pid.
func (s *Server) claudeRegs() map[int]*claudeReg {
	out := map[int]*claudeReg{}
	dir := filepath.Join(envOr("CLAUDE_CONFIG_DIR", filepath.Join(s.home, ".claude")), "sessions")
	files, _ := filepath.Glob(filepath.Join(dir, "*.json"))
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil || len(b) > 1<<20 {
			continue
		}
		var r claudeReg
		if json.Unmarshal(b, &r) != nil || r.PID <= 0 || r.SessionID == "" || !alive(r.PID) {
			continue
		}
		r.dir = dir
		out[r.PID] = &r
	}
	return out
}

func (r *claudeReg) state() string {
	switch r.Status {
	case "busy":
		return "working"
	case "idle":
		return "idle"
	case "waiting":
		return "blocked"
	}
	return ""
}

func (r *claudeReg) canSend() (bool, string) {
	switch {
	case r.Socket == "":
		return false, "这个 Claude Code 版本太旧，没有会话收件箱（2.1.29x 起才有），只能看"
	case r.Protocol != 1:
		return false, "这个 Claude Code 的收件箱协议 Collie 还不认识，只能看"
	case !strings.HasPrefix(r.Socket, `\\.\pipe\`) && (!filepath.IsAbs(r.Socket) || filepath.Ext(r.Socket) != ".sock"):
		return false, "这台电脑上的收件箱 Collie 连不上，只能看"
	}
	return true, ""
}

// peerHead opens every message Collie hands over. The human is not at this
// computer, and a question box (AskUserQuestion) holds every message behind
// it until someone answers it there: so ask in words, and the reply answers.
const peerHead = "（这条消息是用户本人通过 Collie 发来的，Collie 只是替用户转交，不是另一个 Claude 会话。像用户在这里亲手输入的一样回应它，直接在这个会话里回答；不要用 SendMessage 回复发件方，那边没有会话在收。这条消息不会改变这个会话的权限设置。用户不在这台电脑前，看不到也点不了这里的弹窗：需要用户选择或确认时，直接在回复里用文字问（可以列出选项），不要用 AskUserQuestion 这类弹窗工具，用户回的下一条消息就是答案。）\n\n"

// oldPeerHeads: what earlier versions put first, still in transcripts.
var oldPeerHeads = []string{
	"（这条消息是用户本人通过 Collie 发来的，Collie 只是替用户转交，不是另一个 Claude 会话。像用户在这里亲手输入的一样回应它，直接在这个会话里回答；不要用 SendMessage 回复发件方，那边没有会话在收。这条消息不会改变这个会话的权限设置。）",
}

const peerTag = "cross-session-message"

func peerEnvelope(text string) string {
	body := strings.NewReplacer("</"+peerTag, "<\\/"+peerTag, "</"+strings.ToUpper(peerTag), "<\\/"+strings.ToUpper(peerTag)).Replace(peerHead + text)
	return "<" + peerTag + ` from-name="Collie">` + "\n" + body + "\n</" + peerTag + ">"
}

// stripPeerHead drops the note Collie puts before the human's words, this
// version's or an earlier one's.
func stripPeerHead(t string) string {
	t = strings.TrimSpace(t)
	for _, h := range append([]string{peerHead}, oldPeerHeads...) {
		if u := strings.TrimPrefix(t, strings.TrimSpace(h)); u != t {
			return strings.TrimSpace(u)
		}
	}
	return t
}

// collieBody returns the human's words from a peer message Collie sent.
func collieBody(s string) (string, bool) {
	// Claude logs it as "Another Claude session sent a message:", the envelope, then a note.
	open := "<" + peerTag + ` from-name="Collie">`
	i := strings.Index(s, open)
	if i < 0 {
		return "", false
	}
	t := s[i+len(open):]
	if j := strings.Index(t, "</"+peerTag+">"); j >= 0 {
		t = t[:j]
	}
	t = stripPeerHead(t)
	return strings.ReplaceAll(t, "<\\/"+peerTag, "</"+peerTag), true
}

func uuid4() string {
	var b [16]byte
	rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

// peerToken reads the inbox key Claude Code keeps next to the registration
// (optional on macOS and Linux, sent when present as Claude's own sender does).
func (r *claudeReg) peerToken() string {
	sum := sha256.Sum256([]byte(filepath.Clean(r.Socket)))
	b, err := os.ReadFile(filepath.Join(r.dir, strconv.Itoa(r.PID)+"."+hex.EncodeToString(sum[:])+".key"))
	if err != nil {
		return ""
	}
	var k struct {
		PeerToken string `json:"peerToken"`
	}
	json.Unmarshal(b, &k)
	if len(k.PeerToken) == 32 {
		return k.PeerToken
	}
	return ""
}

func jsonNoEscape(v any) []byte {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.Encode(v)
	return bytes.TrimRight(b.Bytes(), "\n")
}

func (r *claudeReg) send(ctx context.Context, text string) error {
	var buf []byte
	if tok := r.peerToken(); tok != "" {
		buf = append(jsonNoEscape(map[string]string{"type": "auth", "token": tok}), '\n')
	}
	buf = append(buf, jsonNoEscape(map[string]any{
		"type":       "user",
		"message":    map[string]string{"role": "user", "content": peerEnvelope(text)},
		"priority":   "next",
		"msgV":       1,
		"msg_id":     uuid4(),
		"session_id": r.SessionID,
	})...)
	buf = append(buf, '\n')
	if len(buf) > 1<<20 {
		return errors.New("消息太长了")
	}
	dctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	conn, err := dialLocalSocket(dctx, r.Socket)
	if err != nil {
		return fmt.Errorf("连不上这个会话的收件箱：%w", err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := conn.Write(buf); err != nil {
		return err
	}
	// The inbox closes its end once it has read the line.
	if cw, ok := conn.(interface{ CloseWrite() error }); ok {
		cw.CloseWrite()
	}
	io.Copy(io.Discard, io.LimitReader(conn, 4<<10))
	return nil
}

// peerTaken watches the transcript past offset for the session taking the
// message: a queue-operation or a peer line carrying its words.
func peerTaken(path string, offset int64, text string, wait time.Duration) bool {
	needle := peerEnvelope(text)
	deadline := time.Now().Add(wait)
	for time.Now().Before(deadline) {
		if f, err := os.Open(path); err == nil {
			f.Seek(offset, io.SeekStart)
			br := bufio.NewReaderSize(f, 64<<10)
			for {
				l, err := br.ReadBytes('\n')
				if len(l) > 0 && (bytes.Contains(l, []byte(`queue-operation`)) || bytes.Contains(l, []byte(`"peer"`))) {
					var e struct {
						Content string `json:"content"`
						Message struct {
							Content json.RawMessage `json:"content"`
						} `json:"message"`
					}
					json.Unmarshal(l, &e)
					if strings.Contains(e.Content, needle) || strings.Contains(promptText(e.Message.Content), needle) {
						f.Close()
						return true
					}
				}
				if err != nil {
					break
				}
			}
			f.Close()
		}
		time.Sleep(300 * time.Millisecond)
	}
	return false
}

// ---------------------------------------------------------------- Codex

func (s *Server) codexHome() string { return envOr("CODEX_HOME", filepath.Join(s.home, ".codex")) }

func (s *Server) codexDaemonSock() string {
	p := filepath.Join(s.codexHome(), "app-server-control", "app-server-control.sock")
	fi, err := os.Lstat(p)
	if err != nil {
		return ""
	}
	// On macOS/Linux, app-server-control.sock is a symlink to the daemon's socket;
	// on Windows, it is an NTFS AF_UNIX reparse point where os.Stat may fail.
	if fi.Mode()&os.ModeSymlink != 0 {
		if _, err := os.Stat(p); err != nil {
			return ""
		}
	}
	return p
}

type codexRPC struct {
	ws      *websocket.Conn
	ctx     context.Context
	mu      sync.Mutex
	next    int64
	pending map[int64]chan codexReply
	onNotif func(method string, params json.RawMessage)
}

type codexReply struct {
	Result json.RawMessage
	Err    *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	}
}

func dialCodex(ctx context.Context, sock string) (*codexRPC, error) {
	hc := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return dialLocalSocket(ctx, sock)
	}}}
	ws, _, err := websocket.Dial(ctx, "ws://localhost/", &websocket.DialOptions{HTTPClient: hc})
	if err != nil {
		return nil, fmt.Errorf("连不上 Codex 后台：%w", err)
	}
	ws.SetReadLimit(64 << 20)
	c := &codexRPC{ws: ws, ctx: ctx, pending: map[int64]chan codexReply{}}
	go func() {
		for {
			_, b, err := ws.Read(ctx)
			if err != nil {
				c.mu.Lock()
				for id, ch := range c.pending {
					close(ch)
					delete(c.pending, id)
				}
				c.mu.Unlock()
				return
			}
			var m struct {
				ID     *int64          `json:"id"`
				Method string          `json:"method"`
				Params json.RawMessage `json:"params"`
				Result json.RawMessage `json:"result"`
				Error  *struct {
					Code    int    `json:"code"`
					Message string `json:"message"`
				} `json:"error"`
			}
			if json.Unmarshal(b, &m) != nil {
				continue
			}
			if m.ID == nil && m.Method != "" {
				c.mu.Lock()
				fn := c.onNotif
				c.mu.Unlock()
				if fn != nil {
					fn(m.Method, m.Params)
				}
				continue
			}
			if m.ID == nil || m.Method != "" {
				continue // server requests: not ours to answer
			}
			c.mu.Lock()
			ch := c.pending[*m.ID]
			delete(c.pending, *m.ID)
			c.mu.Unlock()
			if ch != nil {
				ch <- codexReply{Result: m.Result, Err: m.Error}
			}
		}
	}()
	var init json.RawMessage
	if err := c.call("initialize", map[string]any{"clientInfo": map[string]any{"name": "collie", "title": "Collie", "version": "1"}, "capabilities": map[string]any{"experimentalApi": true}}, &init); err != nil {
		ws.Close(websocket.StatusNormalClosure, "")
		return nil, err
	}
	c.notify("initialized", map[string]any{})
	return c, nil
}

func (c *codexRPC) close() { c.ws.Close(websocket.StatusNormalClosure, "") }

func (c *codexRPC) notify(method string, params any) error {
	return c.ws.Write(c.ctx, websocket.MessageText, jsonNoEscape(map[string]any{"jsonrpc": "2.0", "method": method, "params": params}))
}

func (c *codexRPC) call(method string, params, out any) error {
	c.mu.Lock()
	c.next++
	id := c.next
	ch := make(chan codexReply, 1)
	c.pending[id] = ch
	c.mu.Unlock()
	if err := c.ws.Write(c.ctx, websocket.MessageText, jsonNoEscape(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})); err != nil {
		return err
	}
	select {
	case r, ok := <-ch:
		if !ok {
			return errors.New("Codex 后台断开了")
		}
		if r.Err != nil {
			return fmt.Errorf("Codex：%s (%d)", r.Err.Message, r.Err.Code)
		}
		if out != nil && len(r.Result) > 0 {
			return json.Unmarshal(r.Result, out)
		}
		return nil
	case <-c.ctx.Done():
		return c.ctx.Err()
	}
}

func (c *codexRPC) loaded() (map[string]bool, error) {
	ids := map[string]bool{}
	cursor := ""
	for i := 0; i < 50; i++ {
		var page struct {
			Data       []string `json:"data"`
			NextCursor *string  `json:"nextCursor"`
		}
		p := map[string]any{"limit": 100}
		if cursor != "" {
			p["cursor"] = cursor
		}
		if err := c.call("thread/loaded/list", p, &page); err != nil {
			return nil, err
		}
		for _, id := range page.Data {
			ids[id] = true
		}
		if page.NextCursor == nil || *page.NextCursor == "" || *page.NextCursor == cursor {
			break
		}
		cursor = *page.NextCursor
	}
	return ids, nil
}

// codexLoaded is which threads the shared daemon runs right now (cached briefly).
var codexLoadedCache struct {
	sync.Mutex
	at  time.Time
	ids map[string]bool
	err error
}

func (s *Server) codexLoaded() (map[string]bool, error) {
	codexLoadedCache.Lock()
	defer codexLoadedCache.Unlock()
	if time.Since(codexLoadedCache.at) < 8*time.Second {
		return codexLoadedCache.ids, codexLoadedCache.err
	}
	codexLoadedCache.at = time.Now()
	codexLoadedCache.ids, codexLoadedCache.err = nil, errors.New("这个 Codex 没有连在共享后台上（旧版本，或在桌面 App 里），只能看")
	sock := s.codexDaemonSock()
	if sock == "" {
		return nil, codexLoadedCache.err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, err := dialCodex(ctx, sock)
	if err != nil {
		return nil, codexLoadedCache.err
	}
	defer c.close()
	ids, err := c.loaded()
	if err != nil {
		return nil, codexLoadedCache.err
	}
	codexLoadedCache.ids, codexLoadedCache.err = ids, nil
	return ids, nil
}

func (s *Server) codexSend(ctx context.Context, thread, text, model, effort string) error {
	return s.codexDaemonSend(ctx, thread, text, model, effort, false)
}

// codexBgSend continues a Codex App thread in the shared daemon when nothing
// else runs it: the new App keeps its own app-server private, so this is the
// way in. The App locks only the thread it has open; the daemon takes the
// lock for the turn and lets go about a minute after it ends.
func (s *Server) codexBgSend(ctx context.Context, thread, text, model, effort string) error {
	return s.codexDaemonSend(ctx, thread, text, model, effort, true)
}

var codexCollieStarted struct {
	sync.Mutex
	m map[string]time.Time
}

func noteCollieCodexTurn(thread string) {
	if thread == "" {
		return
	}
	codexCollieStarted.Lock()
	if codexCollieStarted.m == nil {
		codexCollieStarted.m = map[string]time.Time{}
	}
	codexCollieStarted.m[thread] = time.Now()
	for k, t := range codexCollieStarted.m {
		if time.Since(t) > 6*time.Hour {
			delete(codexCollieStarted.m, k)
		}
	}
	codexCollieStarted.Unlock()
}

func consumeCollieCodexTurn(thread string) bool {
	codexCollieStarted.Lock()
	defer codexCollieStarted.Unlock()
	if t, ok := codexCollieStarted.m[thread]; ok {
		delete(codexCollieStarted.m, thread)
		return time.Since(t) <= 6*time.Hour
	}
	return false
}

// codexMarkThreadRead clears `first_unread_turn` in Codex's shared app-server
// (`thread_read_receipts`) so turns executed or viewed from Collie do not leave
// a stuck unread/completed indicator in Codex Desktop App.
func (s *Server) codexMarkThreadRead(ctx context.Context, thread string) {
	thread = strings.TrimSpace(thread)
	if thread == "" {
		return
	}
	sock := s.codexDaemonSock()
	if sock == "" {
		return
	}
	rctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	c, err := dialCodex(rctx, sock)
	if err != nil {
		return
	}
	defer c.close()
	var read struct {
		ReadState *struct {
			FirstUnread json.RawMessage `json:"firstUnread"`
			Revision    string          `json:"revision"`
		} `json:"readState"`
	}
	if err := c.call("thread/read", map[string]any{"threadId": thread, "includeTurns": false}, &read); err != nil {
		return
	}
	if read.ReadState == nil || read.ReadState.Revision == "" {
		return
	}
	fu := strings.TrimSpace(string(read.ReadState.FirstUnread))
	if fu == "" || fu == "null" {
		return
	}
	_ = c.call("thread/readState/update", map[string]any{
		"threadId":         thread,
		"expectedRevision": read.ReadState.Revision,
		"operation":        map[string]any{"type": "read"},
	}, nil)
}

type codexStreamBuf struct {
	mu      sync.Mutex
	text    string
	phase   string
	itemID  string
	updated time.Time
	doneAt  time.Time
}

var codexStreamHub = struct {
	sync.Mutex
	byThread map[string]*codexStreamBuf
}{byThread: map[string]*codexStreamBuf{}}

func getCodexStreamSnapshot(thread string) (text, phase string) {
	codexStreamHub.Lock()
	buf := codexStreamHub.byThread[thread]
	codexStreamHub.Unlock()
	if buf == nil {
		return "", ""
	}
	buf.mu.Lock()
	defer buf.mu.Unlock()
	if !buf.doneAt.IsZero() && time.Since(buf.doneAt) > 3*time.Second {
		return "", ""
	}
	if time.Since(buf.updated) > 2*time.Minute {
		return "", ""
	}
	return buf.text, buf.phase
}

func clearCodexStream(thread string) {
	codexStreamHub.Lock()
	delete(codexStreamHub.byThread, thread)
	codexStreamHub.Unlock()
}

func settleCodexStream(thread string) {
	codexStreamHub.Lock()
	buf := codexStreamHub.byThread[thread]
	codexStreamHub.Unlock()
	if buf == nil {
		return
	}
	buf.mu.Lock()
	buf.doneAt = time.Now()
	buf.mu.Unlock()
}

func appendCodexStreamDelta(thread, itemID, delta, phase string) {
	if thread == "" || delta == "" {
		return
	}
	codexStreamHub.Lock()
	buf := codexStreamHub.byThread[thread]
	if buf == nil {
		buf = &codexStreamBuf{}
		codexStreamHub.byThread[thread] = buf
	}
	codexStreamHub.Unlock()

	buf.mu.Lock()
	if itemID != "" && itemID != buf.itemID {
		buf.itemID = itemID
		buf.text = ""
	}
	buf.doneAt = time.Time{}
	if phase != "" {
		buf.phase = phase
	}
	buf.text += delta
	buf.updated = time.Now()
	buf.mu.Unlock()
}

func attachCodexDeltaCapture(c *codexRPC, wantThread string) {
	c.mu.Lock()
	c.onNotif = func(method string, params json.RawMessage) {
		switch method {
		case "item/started":
			var p struct {
				ThreadID string `json:"threadId"`
				Item     struct {
					ID    string `json:"id"`
					Type  string `json:"type"`
					Phase string `json:"phase"`
				} `json:"item"`
			}
			if json.Unmarshal(params, &p) == nil && (wantThread == "" || p.ThreadID == wantThread) && p.Item.Type == "agentMessage" {
				codexStreamHub.Lock()
				buf := codexStreamHub.byThread[p.ThreadID]
				if buf == nil {
					buf = &codexStreamBuf{}
					codexStreamHub.byThread[p.ThreadID] = buf
				}
				codexStreamHub.Unlock()
				buf.mu.Lock()
				buf.itemID = p.Item.ID
				buf.phase = p.Item.Phase
				buf.text = ""
				buf.doneAt = time.Time{}
				buf.updated = time.Now()
				buf.mu.Unlock()
			}
		case "item/agentMessage/delta":
			var p struct {
				ThreadID string `json:"threadId"`
				ItemID   string `json:"itemId"`
				Delta    string `json:"delta"`
			}
			if json.Unmarshal(params, &p) == nil && (wantThread == "" || p.ThreadID == wantThread) {
				appendCodexStreamDelta(p.ThreadID, p.ItemID, p.Delta, "")
			}
		case "item/completed", "turn/completed":
			var p struct {
				ThreadID string `json:"threadId"`
				Item     struct {
					Type string `json:"type"`
				} `json:"item"`
			}
			if json.Unmarshal(params, &p) == nil && (wantThread == "" || p.ThreadID == wantThread) {
				if method == "turn/completed" || p.Item.Type == "agentMessage" {
					settleCodexStream(p.ThreadID)
				}
			}
		}
	}
	c.mu.Unlock()
}

func (s *Server) watchCodexBgTurnCompletion(thread, path string, streamConn *codexRPC) {
	go func() {
		if streamConn != nil {
			defer streamConn.close()
		}
		defer clearCodexStream(thread)
		// Wait briefly for the turn to appear in the rollout, then wait until it finishes.
		deadline := time.Now().Add(45 * time.Minute)
		sawRunning := false
		for i := 0; time.Now().Before(deadline); i++ {
			time.Sleep(800 * time.Millisecond)
			if path == "" {
				path, _ = s.findCodexRolloutSingle(thread)
			}
			running := path != "" && codexTurnRunning(path)
			if running {
				sawRunning = true
				continue
			}
			if sawRunning || i >= 4 {
				if consumeCollieCodexTurn(thread) {
					s.codexMarkThreadRead(context.Background(), thread)
				}
				// Unsubscribe once idle so the shared daemon releases the thread-writer-lock
				// and the Desktop App can also open it freely.
				if sock := s.codexDaemonSock(); sock != "" {
					uctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
					if c, err := dialCodex(uctx, sock); err == nil {
						_ = c.call("thread/unsubscribe", map[string]any{"threadId": thread}, nil)
						c.close()
					}
					cancel()
				}
				s.invalidateExternalCaches()
				return
			}
		}
	}()
}

func (s *Server) codexDaemonSend(ctx context.Context, thread, text, model, effort string, idle bool) error {
	sock := s.codexDaemonSock()
	if sock == "" {
		return errors.New("这台电脑上没有运行 Codex 后台")
	}
	// Use a background context for the WebSocket connection so it stays open
	// while the turn runs and streams token deltas into codexStreamHub!
	bgCtx, bgCancel := context.WithTimeout(context.Background(), 46*time.Minute)
	c, err := dialCodex(bgCtx, sock)
	if err != nil {
		bgCancel()
		return err
	}
	keepOpen := false
	defer func() {
		if !keepOpen {
			c.close()
			bgCancel()
		}
	}()
	attachCodexDeltaCapture(c, thread)
	ids, err := c.loaded()
	if err != nil {
		return err
	}
	headless := idle && !ids[thread]
	if !ids[thread] && !headless {
		return errors.New("这个 Codex 会话没有在共享后台里运行，只能看")
	}
	resumeParams := map[string]any{"threadId": thread, "excludeTurns": true}
	if model != "" {
		resumeParams["model"] = model
	}
	if err := c.call("thread/resume", resumeParams, nil); err != nil {
		if strings.Contains(err.Error(), "active writer") || strings.Contains(err.Error(), "live local writer") {
			if s.tryClearCodexWriterLock(thread) {
				err = c.call("thread/resume", resumeParams, nil)
			}
		}
		if err != nil {
			if strings.Contains(err.Error(), "active writer") || strings.Contains(err.Error(), "live local writer") {
				return errors.New("这个对话正在桌面端 Codex 里打开着：请先在桌面端切到别的对话再发，或直接在桌面端里说")
			}
			return err
		}
	}
	var read struct {
		Thread struct {
			Path  string `json:"path"`
			Turns []struct {
				ID     string `json:"id"`
				Status string `json:"status"`
			} `json:"turns"`
		} `json:"thread"`
	}
	c.call("thread/read", map[string]any{"threadId": thread, "includeTurns": true}, &read)
	running := ""
	for _, t := range read.Thread.Turns {
		if t.Status == "inProgress" {
			running = t.ID
		}
	}
	input := []map[string]any{{"type": "text", "text": text, "text_elements": []any{}}}
	if running != "" {
		noteCollieCodexTurn(thread)
		if err := c.call("turn/steer", map[string]any{"threadId": thread, "input": input, "expectedTurnId": running}, nil); err != nil {
			return err
		}
		s.invalidateExternalCaches()
		return nil
	}
	turnParams := map[string]any{"threadId": thread, "input": input}
	if model != "" {
		turnParams["model"] = model
	}
	if effort != "" {
		turnParams["effort"] = effort
	}
	if !headless {
		noteCollieCodexTurn(thread)
		if err := c.call("turn/start", turnParams, nil); err != nil {
			return err
		}
		keepOpen = true
		s.watchCodexBgTurnCompletion(thread, read.Thread.Path, c)
		s.invalidateExternalCaches()
		return nil
	}
	turnParams["approvalPolicy"] = "never"
	noteCollieCodexTurn(thread)
	if err := c.call("turn/start", turnParams, nil); err != nil {
		return err
	}
	// Keep the thread loaded and the WebSocket open while its turn runs so
	// token-by-token `item/agentMessage/delta` streaming, mid-turn steering
	// (`turn/steer`) and interruption (`turn/interrupt`) all work seamlessly!
	keepOpen = true
	s.watchCodexBgTurnCompletion(thread, read.Thread.Path, c)
	s.invalidateExternalCaches()
	return nil
}

func (s *Server) invalidateExternalCaches() {
	forgetDesktopRows()
	externalCache.Lock()
	externalCache.at = time.Time{}
	externalCache.Unlock()
	codexLoadedCache.Lock()
	codexLoadedCache.at = time.Time{}
	codexLoadedCache.Unlock()
}

// codexInterrupt stops the turn a Codex thread is running in the shared
// daemon. Closing its terminal is not enough: the turn lives in the daemon,
// not in the window, and carries on without it.
func (s *Server) codexInterrupt(ctx context.Context, thread string) error {
	sock := s.codexDaemonSock()
	if sock == "" {
		return errors.New("这台电脑上没有运行共享 Codex 后台")
	}
	c, err := dialCodex(ctx, sock)
	if err != nil {
		return err
	}
	defer c.close()
	ids, err := c.loaded()
	if err != nil {
		return err
	}
	if !ids[thread] {
		return errors.New("当前步骤由桌面端 Codex 私有窗口直接启动，请在桌面端窗口点击停止")
	}
	var read struct {
		Thread struct {
			Turns []struct {
				ID     string `json:"id"`
				Status string `json:"status"`
			} `json:"turns"`
		} `json:"thread"`
	}
	if err := c.call("thread/read", map[string]any{"threadId": thread, "includeTurns": true}, &read); err != nil {
		var turns struct {
			Data []struct {
				ID     string `json:"id"`
				Status string `json:"status"`
			} `json:"data"`
		}
		if err2 := c.call("thread/turns/list", map[string]any{"threadId": thread, "limit": 5, "sortDirection": "desc", "itemsView": "notLoaded"}, &turns); err2 == nil {
			for _, t := range turns.Data {
				if t.Status == "inProgress" {
					err3 := c.call("turn/interrupt", map[string]any{"threadId": thread, "turnId": t.ID}, nil)
					s.invalidateExternalCaches()
					return err3
				}
			}
			return nil
		}
		return err
	}
	for _, t := range read.Thread.Turns {
		if t.Status == "inProgress" {
			err := c.call("turn/interrupt", map[string]any{"threadId": thread, "turnId": t.ID}, nil)
			s.invalidateExternalCaches()
			return err
		}
	}
	return nil
}

// interruptCodex: POST /api/codex/interrupt {thread}, on the computer the
// thread runs on.
func (s *Server) interruptCodex(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Thread string `json:"thread"`
	}
	if !decode(w, r, &body) {
		return
	}
	if err := s.codexInterrupt(r.Context(), body.Thread); err != nil {
		writeJSON(w, 502, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// sendCodexSession: POST /api/codex/send {thread, text, model, effort} continues
// a Codex conversation directly inside the shared app-server daemon without
// spawning a persistent CLI TUI pane (so it never holds a permanent thread lock).
func (s *Server) sendCodexSession(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Thread string `json:"thread"`
		Text   string `json:"text"`
		Model  string `json:"model"`
		Effort string `json:"effort"`
	}
	if !decode(w, r, &body) {
		return
	}
	if !modelNameRe.MatchString(body.Model) || !modelNameRe.MatchString(body.Effort) {
		writeJSON(w, 400, map[string]any{"error": "invalid model or effort"})
		return
	}
	thread := strings.TrimSpace(body.Thread)
	text := strings.TrimSpace(body.Text)
	if thread == "" || text == "" {
		writeJSON(w, 400, map[string]any{"error": "missing thread or text"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	if err := s.codexBgSend(ctx, thread, text, body.Model, body.Effort); err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// stopCodexTurn interrupts a Codex thread's turn on whichever computer has it.
func (s *Server) stopCodexTurn(ctx context.Context, machine, thread string) error {
	if machine == "" {
		return s.codexInterrupt(ctx, thread)
	}
	c, err := s.herdr.Client(machine)
	if err != nil {
		return err
	}
	b, _ := json.Marshal(map[string]any{"thread": thread})
	req, _ := http.NewRequestWithContext(ctx, "POST", "http://node/api/codex/interrupt", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 500))
		return fmt.Errorf("interrupt: %s %s", resp.Status, msg)
	}
	return nil
}

func (s *Server) markCodexReadNode(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Thread string `json:"thread"`
	}
	if !decode(w, r, &body) {
		return
	}
	s.codexMarkThreadRead(r.Context(), body.Thread)
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) markCodexReadOn(ctx context.Context, machine, thread string) {
	if thread == "" {
		return
	}
	if machine == "" {
		s.codexMarkThreadRead(ctx, thread)
		return
	}
	c, err := s.herdr.Client(machine)
	if err != nil {
		return
	}
	rctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	b, _ := json.Marshal(map[string]any{"thread": thread})
	req, _ := http.NewRequestWithContext(rctx, "POST", "http://node/api/codex/read", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.Do(req)
	if err == nil {
		resp.Body.Close()
	}
}

// ---------------------------------------------------------------- HTTP

func (s *Server) sendExternal(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Text   string `json:"text"`
		Model  string `json:"model"`
		Effort string `json:"effort"`
	}
	if !decode(w, r, &body) {
		return
	}
	code, detail := s.sendExternalText(r.Context(), r.PathValue("id"), body.Text, body.Model, body.Effort)
	if code >= 400 {
		writeJSON(w, code, map[string]any{"error": detail})
		return
	}
	result := map[string]any{"ok": true}
	if detail != "" {
		result["note"] = detail
	}
	writeJSON(w, code, result)
}

func (s *Server) sendExternalText(ctx context.Context, id, text, model, effort string) (int, string) {
	if !modelNameRe.MatchString(model) || !modelNameRe.MatchString(effort) {
		return 400, "invalid model or effort"
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return 400, "空消息"
	}
	if strings.HasPrefix(text, "/") {
		return 400, "斜杠命令只能在那台电脑上输入"
	}
	e := s.externalByID(id)
	if e == nil {
		return 404, "这个会话已经结束了"
	}
	if !e.CanSend {
		return 409, e.ReadOnly
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	switch e.Kind {
	case "claude":
		reg := e.reg
		offset := int64(-1)
		if fi, err := os.Stat(e.path); err == nil {
			offset = fi.Size()
		}
		if err := reg.send(ctx, text); err != nil {
			return 502, err.Error()
		}
		if offset < 0 || !peerTaken(e.path, offset, text, 6*time.Second) {
			return 202, "已写入 Claude 收件箱，会话是否接收尚未确认"
		}
	case "codex":
		var err error
		switch e.via {
		case "app":
			err = s.codexAppSend(ctx, e.Session, text)
			if (errors.Is(err, errCodexNotLoaded) || errors.Is(err, errCodexAppOffline)) && s.codexDaemonSock() != "" {
				err = s.codexBgSend(ctx, e.Session, text, model, effort)
			}
		case "bg":
			err = s.codexBgSend(ctx, e.Session, text, model, effort)
		default:
			err = s.codexSend(ctx, e.Session, text, model, effort)
		}
		if err != nil {
			return 502, err.Error()
		}
	case "agy":
		if e.via != "app" {
			return 409, "这个 Antigravity 会话还不能从这里发消息"
		}
		if err := s.agyAppSend(ctx, e.Session, text); err != nil {
			return 502, err.Error()
		}
	default:
		return 409, "这种 agent 还不能从这里发消息"
	}
	return 200, ""
}

// interruptExternal: POST /api/external/{id}/interrupt stops the currently
// running turn of an external or desktop conversation without deleting history.
func (s *Server) interruptExternal(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	e := s.externalByID(id)
	if e == nil {
		writeJSON(w, 404, map[string]any{"error": "找不到这个正在运行的会话"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	switch e.Kind {
	case "codex":
		if e.Session != "" {
			if err := s.codexInterrupt(ctx, e.Session); err == nil {
				writeJSON(w, 200, map[string]any{"ok": true})
				return
			} else {
				if e.via == "app" {
					if s.codexAppInterrupt(ctx, e.Session) == nil {
						writeJSON(w, 200, map[string]any{"ok": true})
						return
					}
				}
				if !e.desktop && e.PID > 0 && interruptProcess(e.PID) == nil {
					s.invalidateExternalCaches()
					writeJSON(w, 200, map[string]any{"ok": true})
					return
				}
				writeJSON(w, 409, map[string]any{"error": err.Error()})
				return
			}
		}
	case "agy":
		if e.desktop && e.Session != "" {
			if err := s.agyAppInterrupt(ctx, e.Session); err != nil {
				fail(w, err)
				return
			}
			writeJSON(w, 200, map[string]any{"ok": true})
			return
		}
	}

	if !e.desktop && e.PID > 0 {
		if err := interruptProcess(e.PID); err == nil {
			s.invalidateExternalCaches()
			writeJSON(w, 200, map[string]any{"ok": true})
			return
		}
	}
	writeJSON(w, 409, map[string]any{"error": "该会话当前由桌面应用私有进程运行，请切回对应桌面窗口停止"})
}
