package collie

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestServeReleaseLatestAndArtifactClassification(t *testing.T) {
	oldVer := version
	version = "v0.2.52"
	defer func() { version = oldVer }()

	s := &Server{home: t.TempDir()}

	// 1. GET /dl/latest returns current Hub release tag cleanly.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/dl/latest", nil)
	s.serveReleaseLatest(rec, req)
	if rec.Code != 200 || strings.TrimSpace(rec.Body.String()) != "v0.2.52" {
		t.Fatalf("serveReleaseLatest = (%d, %q), want (200, v0.2.52)", rec.Code, rec.Body.String())
	}

	// 2. readFile classifies PDF, CSV, Office, Archive, and Markdown properly + meta=1.
	pdfPath := filepath.Join(s.home, "paper_revision.pdf")
	if err := os.WriteFile(pdfPath, []byte("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	csvPath := filepath.Join(s.home, "metrics.csv")
	if err := os.WriteFile(csvPath, []byte("epoch,loss,acc\n1,0.42,0.89\n2,0.21,0.95\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	docxPath := filepath.Join(s.home, "response_letter.docx")
	if err := os.WriteFile(docxPath, []byte{'P', 'K', 0x03, 0x04, 0x00, 0x01, 0x02}, 0o600); err != nil {
		t.Fatal(err)
	}

	// PDF inline preview
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/api/file?path="+pdfPath+"&as=pdf", nil)
	s.readFile(rec, req)
	if rec.Code != 200 || rec.Header().Get("Content-Type") != "application/pdf" || rec.Header().Get("X-File-Kind") != "pdf" {
		t.Fatalf("PDF readFile = (%d, ct=%q, kind=%q)", rec.Code, rec.Header().Get("Content-Type"), rec.Header().Get("X-File-Kind"))
	}

	// CSV text preview
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/api/file?path="+csvPath, nil)
	s.readFile(rec, req)
	if rec.Code != 200 || rec.Header().Get("X-File-Kind") != "csv" || !strings.Contains(rec.Body.String(), "epoch,loss,acc") {
		t.Fatalf("CSV readFile = (%d, kind=%q, body=%q)", rec.Code, rec.Header().Get("X-File-Kind"), rec.Body.String())
	}

	// Office binary metadata without download=1 returns kind=office and empty body; with download=1 returns raw bytes!
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/api/file?path="+docxPath, nil)
	s.readFile(rec, req)
	if rec.Header().Get("X-File-Kind") != "office" || rec.Body.Len() != 0 {
		t.Fatalf("DOCX preview = (kind=%q, len=%d), want (office, 0)", rec.Header().Get("X-File-Kind"), rec.Body.Len())
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/api/file?path="+docxPath+"&download=1", nil)
	s.readFile(rec, req)
	if rec.Header().Get("X-File-Kind") != "download" || rec.Body.Len() != 7 {
		t.Fatalf("DOCX download = (kind=%q, len=%d), want (download, 7)", rec.Header().Get("X-File-Kind"), rec.Body.Len())
	}
}

func TestExternalListHashShortCircuit(t *testing.T) {
	home := t.TempDir()
	codexDir := filepath.Join(home, ".codex", "sessions", "2026", "11", "23")
	if err := os.MkdirAll(codexDir, 0o755); err != nil {
		t.Fatal(err)
	}
	rollout := filepath.Join(codexDir, "rollout-2026-11-23T12-00-00-019a1234-5678-7abc-8def-0123456789ab.jsonl")
	content := `{"timestamp":"2026-11-23T12:00:00Z","type":"session_meta","payload":{"id":"019a1234-5678-7abc-8def-0123456789ab","cwd":"/tmp/proj"}}` + "\n" +
		`{"timestamp":"2026-11-23T12:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"优化 Transformer 实验结果表格"}]}}` + "\n" +
		`{"timestamp":"2026-11-23T12:00:05Z","type":"response_item","payload":{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"已完成表格重排并生成 ablation_results.pdf"}]}}` + "\n"
	if err := os.WriteFile(rollout, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	stateDB := filepath.Join(home, ".codex", "state_5.sqlite")
	db, err := sql.Open("sqlite", sqliteURI(stateDB, ""))
	if err != nil {
		t.Fatal(err)
	}
	nowSec := time.Now().Unix()
	_, err = db.Exec(`CREATE TABLE threads (
		id TEXT PRIMARY KEY, name TEXT, title TEXT, first_user_message TEXT, cwd TEXT, rollout_path TEXT,
		created_at INTEGER, created_at_ms INTEGER, updated_at INTEGER, updated_at_ms INTEGER,
		archived INTEGER, source TEXT, originator TEXT, model TEXT, reasoning_effort TEXT
	);
	INSERT INTO threads VALUES (
		'019a1234-5678-7abc-8def-0123456789ab', '', '实验表格重排', '优化 Transformer 实验结果表格', '/tmp/proj', ?,
		?, ?, ?, ?, 0, 'vscode', 'Codex Desktop', 'gpt-5.4', 'high'
	);`, rollout, nowSec-60, (nowSec-60)*1000, nowSec, nowSec*1000)
	_ = db.Close()
	if err != nil {
		t.Fatal(err)
	}
	desktopCache.Lock()
	desktopCache.at = time.Time{}
	desktopCache.Unlock()

	s := &Server{home: home, herdr: newHerdr("", "hub", home)}

	// First request returns full sessions + hash.
	rec1 := httptest.NewRecorder()
	req1 := httptest.NewRequest("GET", "/api/external", nil)
	s.listExternal(rec1, req1)
	var out1 struct {
		Sessions  []External `json:"sessions"`
		Hash      string     `json:"hash"`
		Unchanged bool       `json:"unchanged"`
	}
	if err := json.Unmarshal(rec1.Body.Bytes(), &out1); err != nil {
		t.Fatal(err)
	}
	if len(out1.Sessions) != 1 || out1.Hash == "" || out1.Unchanged {
		t.Fatalf("first listExternal = %+v", out1)
	}

	// Second request with matching ?hash= short-circuits with {"unchanged": true}.
	rec2 := httptest.NewRecorder()
	req2 := httptest.NewRequest("GET", "/api/external?hash="+out1.Hash, nil)
	s.listExternal(rec2, req2)
	var out2 struct {
		Sessions  []External `json:"sessions"`
		Hash      string     `json:"hash"`
		Unchanged bool       `json:"unchanged"`
	}
	if err := json.Unmarshal(rec2.Body.Bytes(), &out2); err != nil {
		t.Fatal(err)
	}
	if !out2.Unchanged || len(out2.Sessions) != 0 || out2.Hash != out1.Hash {
		t.Fatalf("second listExternal with matching hash = %+v, want unchanged=true", out2)
	}

	// Full-text search finds the keyword inside the rollout transcript!
	recS := httptest.NewRecorder()
	reqS := httptest.NewRequest("GET", "/api/search/node?q=ablation_results", nil)
	s.nodeSearch(recS, reqS)
	var searchOut struct {
		Results []SearchHit `json:"results"`
	}
	if err := json.Unmarshal(recS.Body.Bytes(), &searchOut); err != nil {
		t.Fatal(err)
	}
	if len(searchOut.Results) != 1 || !strings.Contains(searchOut.Results[0].Snippet, "ablation_results.pdf") {
		t.Fatalf("nodeSearch results = %+v, want 1 hit mentioning ablation_results.pdf", searchOut.Results)
	}
}

func TestQuotaAwareDispatchAndRouterFailover(t *testing.T) {
	dir := t.TempDir()
	home := t.TempDir()
	hr := newHerdr("", "hub", home)
	s := &Server{home: home, herdr: hr}
	sp, err := newSuper(s, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer sp.db.Close()
	s.sup = sp

	// Register two remote computers: Mac (currently offline) and Win (online with claude + codex).
	hr.mu.Lock()
	hr.remote["mac"] = &Machine{
		ID: "mac", Name: "Mac", Home: "/Users/mac", Online: false, Agents: []string{"codex", "claude"},
	}
	hr.remote["win"] = &Machine{
		ID: "win", Name: "Win", Home: `C:\Users\win`, Online: true, Agents: []string{"claude", "codex"},
	}
	hr.mu.Unlock()

	// Seed cached quota telemetry: Win's Claude (DeepSeek) is exhausted (-2.17), Win's Codex is 100% healthy!
	f := false
	hubQuotaState.Lock()
	hubQuotaState.at = time.Now()
	hubQuotaState.lastMap["win"] = MachineQuota{
		ID: "win", Name: "Win", Online: true,
		Agents: []AgentQuota{
			{Kind: "claude", Status: "exhausted", Provider: "deepseek", Balance: "¥ -2.17", BalanceOK: &f, Note: "余额不足"},
			{Kind: "codex", Status: "ok", Buckets: []QuotaBucket{{ID: "secondary", Label: "每周限额", RemainingPct: 100}}},
		},
	}
	hubQuotaState.Unlock()
	defer func() {
		hubQuotaState.Lock()
		delete(hubQuotaState.lastMap, "win")
		hubQuotaState.Unlock()
	}()

	// 1. Default worker is configured as claude on Mac (offline). Auto-dispatch should
	// skip offline Mac AND skip Win's exhausted claude, picking Win + codex!
	sp.mu.Lock()
	sp.st.Settings.RouterMachine = "mac"
	sp.st.Settings.RouterKind = "codex"
	sp.st.Settings.WorkerMachine = "mac"
	sp.st.Settings.WorkerKind = "claude"
	sp.mu.Unlock()

	gotM, gotK := sp.resolveAutoWorkerTarget("")
	if gotM != "win" || gotK != "codex" {
		t.Fatalf("resolveAutoWorkerTarget() = (%q, %q), want (\"win\", \"codex\")", gotM, gotK)
	}

	// 2. Router auto-failover: when RouterMachine (mac) is asleep/offline,
	// resolveRouterTarget picks online Win + codex instead of failing!
	rm, rk, rerr := sp.resolveRouterTarget(sp.settings())
	if rerr != nil || rm == nil || rm.ID != "win" || rk != "codex" {
		t.Fatalf("resolveRouterTarget during Mac sleep = (%+v, %q, %v), want Win + codex", rm, rk, rerr)
	}

	// 3. `collie list` surfaces live quota status including UNAVAILABLE(¥ -2.17) and codex=100%.
	listOut := sp.List()
	if !strings.Contains(listOut, "claude=UNAVAILABLE(¥ -2.17)") || !strings.Contains(listOut, "codex=100%") {
		t.Fatalf("Super.List() missing quota brief:\n%s", listOut)
	}

	// 4. Feishu deep-link card preserves per-notice hash & button label.
	cardJSON := larkCard([]notice{{
		tone:     "blocked",
		title:    "Win · 论文返修 · 需要你确认",
		text:     "请选择实验对比基线",
		hash:     "/#/x/cx-123%40win",
		btnLabel: "前往处理提问",
	}}, "https://101.200.80.58")
	if !strings.Contains(cardJSON, "https://101.200.80.58/?lk_mobile_jump_to_browser=true&lk_jump_to_browser=true#/x/cx-123%40win") || !strings.Contains(cardJSON, "前往处理提问") {
		t.Fatalf("larkCard missing deep link or custom button label: %s", cardJSON)
	}
	_ = context.Background()
}
