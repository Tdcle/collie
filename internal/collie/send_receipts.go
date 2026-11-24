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
		if !sidebarTarget(body.To) || strings.Contains(local, "@") || body.To != join(local, machine) || (s.node && machine != "") || stripLeadingTriggerRef(body.Text) == "" {
			writeJSON(w, 400, map[string]string{"error": "expected a sidebar session ID and nonempty text"})
			return
		}
		hash = fmt.Sprintf("%x", sha256.Sum256([]byte(body.Text)))
		res, err := s.receipts.Exec(`INSERT INTO send_receipts(id,target,digest,preview) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING`,
			id, body.To, hash, clip(oneLine(stripLeadingTriggerRef(body.Text)), 120))
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
	if v.Status != "unconfirmed" || (machine == "" && !fresh) {
		writeJSON(w, 200, v)
		return
	}
	if fresh && s.sup != nil {
		s.sup.noteRouterStep("正在向会话 " + v.To + " 发送指令…")
	}

	if machine != "" {
		body.To = local
		remote, err := s.remoteReceipt(r.Context(), machine, r.Method, id, body)
		if err != nil {
			v.Detail = err.Error()
			writeJSON(w, 200, v)
			return
		}
		if remote.ID != id || remote.To != local || remote.Hash != v.Hash {
			v.Detail = "node receipt does not match this request"
			writeJSON(w, 200, v)
			return
		}
		v.Status, v.Detail = remote.Status, remote.Detail
		if v.Status == "unconfirmed" {
			writeJSON(w, 200, v)
			return
		}
	} else {
		v.Status, v.Detail = s.submitSidebar(r.Context(), body)
	}

	res, err := s.receipts.Exec(`UPDATE send_receipts SET status=?,detail=? WHERE id=? AND status='unconfirmed'`, v.Status, v.Detail, id)
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
	writeJSON(w, 200, v)
}

// Finish the receiver's attempt even if the CLI or tunnel disconnects.
func (s *Server) submitSidebar(parent context.Context, body sidebarSend) (string, string) {
	// Preserve worker-first resolution for a local name that is also a sidebar ID.
	if s.sup != nil && nameRe.MatchString(body.To) {
		if trigger := s.sup.queueWorker(body.To, body.Text, body.Thread); trigger != "" {
			if err := s.sup.flush(); err != nil {
				return "unconfirmed", err.Error()
			}
			return "queued", trigger
		}
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(parent), 30*time.Second)
	defer cancel()
	text := stripLeadingTriggerRef(body.Text)
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

func (s *Server) remoteReceipt(ctx context.Context, machine, method, id string, body sidebarSend) (sendReceipt, error) {
	var v sendReceipt
	client, err := s.herdr.Client(machine)
	if err != nil {
		return v, err
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	var payload io.Reader
	if method == "PUT" {
		raw, _ := json.Marshal(body)
		payload = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, "http://node/api/sidebar/sends/"+id, payload)
	if err != nil {
		return v, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
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
