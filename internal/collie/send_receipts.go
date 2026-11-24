package collie

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var receiptID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$`)

// Local terminal IDs use a process ID (e.g. claude-12345). Other names like
// claude-review are ordinary workers and use the existing worker queue.
var externalPID = regexp.MustCompile(`^(codex|claude|agy|gemini)-[0-9]+$`)

type sidebarSend struct {
	To     string `json:"to"`
	Text   string `json:"text"`
	Thread string `json:"thread,omitempty"`
}

type sendReceipt struct {
	ID      string `json:"id"`
	To      string `json:"to"`
	Hash    string `json:"sha256"`
	Preview string `json:"preview"`
	Status  string `json:"status"`
	Detail  string `json:"detail,omitempty"`
}

// "unrouted" has never been forwarded. "legacy" is a durable one-shot claim:
// the old node has no way to distinguish a new request from a replay.
func (v sendReceipt) write(w http.ResponseWriter) {
	switch v.Status {
	case "legacy":
		v.Detail = firstNonEmpty(v.Detail, "older node: one send reserved; receiver receipt unavailable")
		v.Status = "unconfirmed"
	case "unrouted":
		v.Status = "unconfirmed"
	}
	writeJSON(w, 200, v)
}

func sidebarTarget(target string) bool {
	local, _ := split(target)
	return strings.Contains(local, ":") || externalTarget(target)
}

func externalTarget(target string) bool {
	local, _ := split(target)
	return externalPID.MatchString(local) || strings.HasPrefix(local, "cx-") ||
		strings.HasPrefix(local, "cl-") || strings.HasPrefix(local, "cd-") ||
		strings.HasPrefix(local, "ag-") || strings.HasPrefix(local, "gm-")
}

// Use the existing state file, with a FULL synchronous connection for the
// claim that must survive a crash before the non-transactional agent call.
func openSendReceipts(dir string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", sqliteURI(filepath.Join(dir, "herd.db"), "_pragma=busy_timeout(5000)&_pragma=synchronous(FULL)"))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS send_receipts (
		id TEXT PRIMARY KEY, target TEXT NOT NULL, digest TEXT NOT NULL, preview TEXT NOT NULL,
		status TEXT NOT NULL DEFAULT 'unconfirmed', detail TEXT NOT NULL DEFAULT '')`)
	if err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

// GET only reads/reconciles. PUT binds the ID at the hub, and at the receiving
// machine only the INSERT winner may enter the underlying send operation.
func (s *Server) sidebarReceipt(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !receiptID.MatchString(id) {
		writeJSON(w, 400, map[string]string{"error": "invalid send receipt ID"})
		return
	}
	if s.receipts == nil {
		writeJSON(w, 503, map[string]string{"error": "send receipt storage unavailable"})
		return
	}

	var body sidebarSend
	fresh := false
	var hash string
	if r.Method == "PUT" {
		if !decode(w, r, &body) {
			return
		}
		body.To = strings.TrimSpace(body.To)

		local, machine := split(body.To)
		validTarget := sidebarTarget(body.To) || (!s.node && nameRe.MatchString(body.To))
		if !validTarget || strings.Contains(local, "@") || body.To != join(local, machine) || (s.node && machine != "") || strings.TrimSpace(body.Text) == "" {
			writeJSON(w, 400, map[string]string{"error": "expected a worker or session ID and nonempty text"})
			return
		}
		hash = fmt.Sprintf("%x", sha256.Sum256([]byte(body.Text)))
		status := "unconfirmed"
		if machine != "" {
			status = "unrouted"
		}
		res, err := s.receipts.Exec(`INSERT INTO send_receipts(id,target,digest,preview,status) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
			id, body.To, hash, clip(oneLine(stripLeadingTriggerRef(body.Text)), 120), status)
		if err != nil {
			fail(w, err)
			return
		}
		n, _ := res.RowsAffected()
		fresh = n == 1
	}

	v := sendReceipt{ID: id}
	err := s.receipts.QueryRow(`SELECT target,digest,preview,status,detail FROM send_receipts WHERE id=?`, id).
		Scan(&v.To, &v.Hash, &v.Preview, &v.Status, &v.Detail)
	if errors.Is(err, sql.ErrNoRows) {
		writeJSON(w, 404, map[string]string{"error": "unconfirmed: no receipt recorded for " + id})
		return
	}
	if err != nil {
		fail(w, err)
		return
	}
	if r.Method == "PUT" && (body.To != v.To || hash != v.Hash) {
		writeJSON(w, 409, map[string]string{"error": "receipt ID already bound to different target or text"})
		return
	}
	local, machine := split(v.To)
	if (v.Status != "unconfirmed" && v.Status != "unrouted") || (machine == "" && !fresh) {
		v.write(w)
		return
	}
	if fresh && s.sup != nil {
		s.sup.noteRouterStep("正在向会话 " + v.To + " 发送指令…")
	}

	before := v.Status
	if machine == "" {
		v.Status, v.Detail = s.submitSidebar(r.Context(), body)
	} else {
		if before == "unrouted" && r.Method != "PUT" {
			v.write(w)
			return
		}
		m, err := s.herdr.machine(machine)
		if err != nil {
			v.Detail = err.Error()
			v.write(w)
			return
		}
		if m.client == nil {
			v.Detail = "node API unavailable"
			v.write(w)
			return
		}
		if before == "unrouted" {
			route := "unconfirmed" // only the receipt endpoint may ever see this ID
			if !m.sendReceipts {
				route = "legacy"
			}
			res, err := s.receipts.Exec(`UPDATE send_receipts SET status=? WHERE id=? AND status='unrouted'`, route, id)
			if err != nil {
				fail(w, err)
				return
			}
			n, _ := res.RowsAffected()
			if n == 0 { // another caller chose the route and owns the first attempt
				v.write(w)
				return
			}
			before = route
		}
		body.To = local
		if before == "legacy" {
			v.Status, v.Detail = legacyNodeSend(r.Context(), m.client, body)
		} else {
			remote, err := remoteReceipt(r.Context(), m.client, r.Method, id, body)
			if err != nil {
				v.Detail = err.Error()
				v.write(w)
				return
			}
			if remote.ID != id || remote.To != local || remote.Hash != v.Hash {
				v.Detail = "node receipt does not match this request"
				v.write(w)
				return
			}
			v.Status, v.Detail = remote.Status, remote.Detail
			if v.Status == "unconfirmed" {
				v.write(w)
				return
			}
		}
	}

	res, err := s.receipts.Exec(`UPDATE send_receipts SET status=?,detail=? WHERE id=? AND status=?`, v.Status, v.Detail, id, before)
	if err != nil {
		fail(w, err)
		return
	}
	n, _ := res.RowsAffected()
	if n == 1 && s.sup != nil && v.Status == "accepted" {
		if !strings.Contains(local, ":") {
			s.sup.noteExternalSent(v.To)
		}
		s.sup.recordSidebarDispatch(v.To, v.Preview)
	}
	v.write(w)
}

// Finish the receiver's attempt even if the CLI or tunnel disconnects.
func (s *Server) submitSidebar(parent context.Context, body sidebarSend) (string, string) {
	// Preserve worker-first resolution for a local name that is also a sidebar ID.
	if s.sup != nil {
		if trigger := s.sup.queueWorker(body.To, body.Text, body.Thread); trigger != "" {
			if err := s.sup.flush(); err != nil {
				return "unconfirmed", err.Error()
			}
			return "queued", trigger
		}
	}
	if !sidebarTarget(body.To) {
		return "rejected", "no running worker or session named " + body.To
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(parent), 30*time.Second)
	defer cancel()
	text := stripLeadingTriggerRef(body.Text)
	if text == "" {
		return "rejected", "empty prompt"
	}
	if strings.Contains(body.To, ":") {
		if err := s.herdr.prompt(ctx, body.To, text, false); err != nil {
			return "unconfirmed", err.Error()
		}
		return "accepted", ""
	}
	code, detail := s.sendExternalText(ctx, body.To, text, "", "")
	switch {
	case code == 200:
		return "accepted", detail
	case code >= 400 && code < 500:
		return "rejected", detail
	default:
		return "unconfirmed", detail
	}
}

func nodeSendRequest(ctx context.Context, client *http.Client, method, path string, body any) (*http.Response, error) {
	var payload io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		payload = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, "http://node"+path, payload)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	return client.Do(req)
}

func legacyNodeSend(parent context.Context, client *http.Client, body sidebarSend) (string, string) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(parent), 30*time.Second)
	defer cancel()
	path := "/api/external/" + url.PathEscape(body.To) + "/send"
	if strings.Contains(body.To, ":") {
		path = "/api/agents/" + url.PathEscape(body.To) + "/prompt"
	}
	text := stripLeadingTriggerRef(body.Text)
	if text == "" {
		return "rejected", "empty prompt"
	}
	resp, err := nodeSendRequest(ctx, client, "POST", path, map[string]string{"text": text})
	if err != nil {
		return "legacy", err.Error()
	}
	defer resp.Body.Close()
	_, status, detail := legacySendResult(resp, body.To)
	if status == "accepted" {
		return status, detail
	}
	return "legacy", detail
}

// Pre-receipt APIs return a queued worker trigger, a successful submission,
// or an ambiguous backend result. A successful HTTP exchange alone is insufficient.
func legacySendResult(resp *http.Response, target string) (raw []byte, status, detail string) {
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, "unconfirmed", err.Error()
	}
	var result struct {
		OK             bool
		Trigger, Error string
	}
	if json.Unmarshal(raw, &result) != nil {
		return nil, "unconfirmed", resp.Status
	}
	if resp.StatusCode == http.StatusAccepted && result.Trigger != "" {
		return raw, "queued", result.Trigger
	}
	if resp.StatusCode == http.StatusOK && result.OK {
		// A legacy Claude inbox could return 200 after a write without a transcript ack.
		local, _ := split(target)
		if strings.HasPrefix(local, "claude-") || strings.HasPrefix(local, "cl-") || strings.HasPrefix(local, "cd-") {
			return raw, "unconfirmed", "legacy Claude inbox write; session acceptance unconfirmed"
		}
		return raw, "accepted", ""
	}
	return raw, "unconfirmed", firstNonEmpty(result.Error, resp.Status)
}

func remoteReceipt(parent context.Context, client *http.Client, method, id string, body sidebarSend) (sendReceipt, error) {
	var v sendReceipt
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	defer cancel()
	var payload any
	if method == "PUT" {
		payload = body
	}
	resp, err := nodeSendRequest(ctx, client, method, "/api/sidebar/sends/"+id, payload)
	if err != nil {
		return v, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		var e struct{ Error string }
		if json.NewDecoder(resp.Body).Decode(&e) == nil && e.Error != "" {
			return v, errors.New(e.Error)
		}
		return v, fmt.Errorf("node returned %s (receipt support requires an updated node)", resp.Status)
	}
	if err := json.NewDecoder(resp.Body).Decode(&v); err != nil {
		return v, err
	}
	switch v.Status {
	case "accepted", "rejected", "unconfirmed":
		return v, nil
	}
	return v, errors.New("invalid node receipt")
}

// A storage failure disables tracked sends only. The legacy routes remain usable.
func (s *Server) initReceipts(dir string) {
	var err error
	if s.receipts, err = openSendReceipts(dir); err != nil {
		log.Printf("send receipts unavailable: %v", err)
	}
}
