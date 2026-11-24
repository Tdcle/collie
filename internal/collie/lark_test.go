package collie

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// A fake lark-cli: says who is logged in, and writes what it was asked to send.
func fakeLark(t *testing.T) string {
	dir := t.TempDir()
	sent := filepath.Join(dir, "sent")
	if runtime.GOOS == "windows" {
		src := filepath.Join(dir, "fake_lark.go")
		code := `package main
import ("fmt"; "os")
func main() {
	if len(os.Args) > 1 && os.Args[1] == "auth" {
		fmt.Println("{\"identities\":{\"bot\":{\"available\":true},\"user\":{\"openId\":\"ou_test\",\"userName\":\"T\"}}}")
		return
	}
	f, err := os.OpenFile(` + fmtSprintfGoString(sent) + `, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil { os.Exit(1) }
	for _, a := range os.Args[1:] { fmt.Fprintln(f, a) }
	f.Close()
}
`
		if err := os.WriteFile(src, []byte(code), 0o600); err != nil {
			t.Fatal(err)
		}
		if out, err := exec.Command("go", "build", "-o", filepath.Join(dir, "lark-cli.exe"), src).CombinedOutput(); err != nil {
			t.Fatalf("build fake lark-cli: %v\n%s", err, out)
		}
	} else {
		script := `#!/bin/sh
if [ "$1" = auth ]; then echo '{"identities":{"bot":{"available":true},"user":{"openId":"ou_test","userName":"T"}}}'; exit 0; fi
printf '%s\n' "$@" >> "` + sent + `"
`
		if err := os.WriteFile(filepath.Join(dir, "lark-cli"), []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	binCache.Delete("lark-cli")
	lark.get(true)
	t.Cleanup(func() { binCache.Delete("lark-cli"); lark.get(true) })
	return sent
}

func fmtSprintfGoString(s string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s) + `"`
}

func TestLarkNotify(t *testing.T) {
	sent := fakeLark(t)
	sp := &Super{st: &State{Settings: Settings{NotifyLark: true, NotifyLevel: "normal"}}}

	// Looking at Collie: held back.
	sp.Seen("http://hub:7788")
	sp.queueNotifyLocked("collie", "做完了", "", nil, false)
	sp.sendNotifications()
	if _, err := os.Stat(sent); err == nil {
		t.Fatal("sent while you were looking")
	}

	// Away: sent, as the bot, to the logged-in user, with a link.
	sp.seenAt = time.Now().Add(-5 * time.Minute)
	sp.notifyAt = time.Time{}
	sp.queueNotifyLocked("collie", "报告：都好了", "", nil, false)
	sp.sendNotifications()
	b, err := os.ReadFile(sent)
	if err != nil {
		t.Fatal("nothing sent")
	}
	got := strings.ReplaceAll(string(b), "\r\n", "\n")
	for _, want := range []string{"--as\nbot", "--user-id\nou_test", "--msg-type\ninteractive", `"schema":"2.0"`, "报告：都好了", `"default_url":"http://hub:7788/?lk_mobile_jump_to_browser=true&lk_jump_to_browser=true#/collie"`} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in\n%s", want, got)
		}
	}
	if strings.Contains(got, "做完了") {
		t.Error("the held-back message went out later")
	}
}

func TestCardSummary(t *testing.T) {
	got := cardSummary([]notice{{text: "写完了"}, {tone: "blocked", text: "测试：**fix-flaky-test** 在等你批准 `go test`"}, {text: "### 后面的"}})
	if want := "测试：fix-flaky-test 在等你批准 go test"; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
	if got := cardSummary([]notice{{text: "\n- **完成**：好了"}}); got != "完成：好了" {
		t.Errorf("got %q", got)
	}
}

func TestQuote(t *testing.T) {
	sp := &Super{st: &State{Workers: map[string]*Worker{"rn": {Name: "rn", Task: "写发布说明"}}}}
	sp.st.Entries = []*Entry{{ID: "e1", Role: "user", Text: "查一下分页\n\n附件：\n/x/a.png\n\n[The human picked where this runs: spawn with --kind codex]"}}
	sp.st.Triggers = []*Trigger{
		{ID: "t1", Source: "chat", Ref: "e1"},
		{ID: "t2", Source: "worker", From: "rn", Ref: "rn"},
		{ID: "t3", Source: "timer", Text: "每天看一眼 CI"},
	}
	cases := map[string]string{"#t1": "你：查一下分页 📎", "e1": "你：查一下分页 📎", "t2": "rn：写发布说明", "t3": "定时：每天看一眼 CI"}
	for id, want := range cases {
		q := sp.quoteLocked(id)
		if q == nil || q.line() != want {
			t.Errorf("%s: got %+v, want %q", id, q, want)
		}
	}
	if sp.quoteLocked("t99") != nil || sp.quoteLocked("") != nil {
		t.Error("unknown ids should give no quote")
	}
}

func TestCollieQuote(t *testing.T) {
	sp := &Super{st: &State{Entries: []*Entry{{ID: "e1", Role: "collie", Text: "要我开 PR 吗？"}, {ID: "e2", Role: "user", Text: "x"}}}}
	if q := sp.collieQuoteLocked("e1"); q == nil || q.line() != "Collie：要我开 PR 吗？" {
		t.Errorf("got %+v", q)
	}
	if sp.collieQuoteLocked("e2") != nil || sp.collieQuoteLocked("") != nil {
		t.Error("only Collie's messages are quoted")
	}
}

func TestFeishuBotWebhookAndTestNotifyEndpoint(t *testing.T) {
	var received []map[string]any
	feishuSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var m map[string]any
		_ = json.Unmarshal(raw, &m)
		received = append(received, m)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":0,"msg":"success"}`))
	}))
	defer feishuSrv.Close()

	// Treat our local test server as a feishu.cn webhook URL via query marker? Wait:
	// webhookSend checks host substring; test both generic fallback AND feishu card JSON directly:
	ns := []notice{{
		tone:     "done",
		title:    "Win · 论文返修 · 已完成",
		text:     formatSessionNoticeText("![局部图](<C:/Users/26422/SFD-Net 2/fig.png>)\n\n已完成修改，打开 [Visio 原稿](<C:/Users/26422/SFD-Net 2/fig.vsdx>) 查看。"),
		re:       &Quote{Who: "你", Text: "修改右下角流程图"},
		hash:     "/#/x/cx-01a20149%40wlc",
		btnLabel: "打开会话",
	}}
	cardJSON := larkCard(ns, "https://101.200.80.58")
	for _, want := range []string{
		`"Win · 论文返修 · 已完成"`,
		`"template":"green"`,
		`"打开会话"`,
		`"https://101.200.80.58/?lk_mobile_jump_to_browser=true&lk_jump_to_browser=true#/x/cx-01a20149%40wlc"`,
		"`局部图`",
		"`Visio 原稿`",
		"↩ 你：修改右下角流程图",
	} {
		if !strings.Contains(cardJSON, want) {
			t.Fatalf("expected card JSON to contain %s, got:\n%s", want, cardJSON)
		}
	}

	// Verify /api/super/notify/test sends immediately even while Seen is active and auto-saves webhook!
	dir := t.TempDir()
	srv := &Server{herdr: newHerdr("", "hub", dir), home: dir, publicURLs: []string{"https://101.200.80.58"}}
	sp, err := newSuper(srv, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer sp.db.Close()
	srv.sup = sp
	sp.Seen("https://101.200.80.58") // user is looking right at Settings page!

	reqBody, _ := json.Marshal(map[string]any{
		"notify_webhook": feishuSrv.URL,
		"notify_lark":    false,
		"notify_level":   "normal",
		"url":            "https://101.200.80.58",
	})
	req := httptest.NewRequest("POST", "/api/super/notify/test", bytes.NewReader(reqBody))
	rec := httptest.NewRecorder()
	srv.superTestNotify(rec, req)
	if rec.Code != 200 {
		t.Fatalf("expected 200 from superTestNotify, got %d: %s", rec.Code, rec.Body.String())
	}
	if len(received) != 1 {
		t.Fatalf("expected 1 webhook delivery during test, got %d", len(received))
	}
	if sp.st.Settings.NotifyWebhook != feishuSrv.URL || sp.st.Settings.NotifyLevel != "normal" {
		t.Fatalf("expected superTestNotify to auto-persist webhook & level, got %+v", sp.st.Settings)
	}
}

