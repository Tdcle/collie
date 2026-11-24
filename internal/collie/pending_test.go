package collie

import (
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseReplyOptionsAndCheck(t *testing.T) {
	body, err := parseReply([]string{"--re", "t42", "--opt", "停掉它", "--opt", "不用", "要不要先停掉服务？"}, nil, true)
	if err != nil {
		t.Fatalf("parseReply failed: %v", err)
	}
	if body["re"] != "t42" || body["text"] != "要不要先停掉服务？" {
		t.Fatalf("unexpected body: %#v", body)
	}
	opts, _ := body["options"].([]string)
	if len(opts) != 2 || opts[0] != "停掉它" || opts[1] != "不用" {
		t.Fatalf("unexpected options: %#v", body["options"])
	}

	cbody, err := parseReply([]string{"--check", "报告已出，请审阅确认"}, nil, true)
	if err != nil {
		t.Fatalf("parseReply --check failed: %v", err)
	}
	if cbody["check"] != true {
		t.Fatalf("expected check=true, got %#v", cbody)
	}

	ibody, err := parseReply([]string{"--interim", "已派给论文返修执行"}, nil, true)
	if err != nil || ibody["interim"] != true {
		t.Fatalf("expected interim=true, got %#v (err=%v)", ibody, err)
	}
	if got := stripLeadingTriggerRef("t214 用户已定方向：纯原型方案"); got != "用户已定方向：纯原型方案" {
		t.Fatalf("stripLeadingTriggerRef failed: got %q", got)
	}
}

func TestRouterActivityNeverLeaksStaleTerminalTitleAndRecordsSidebarDispatch(t *testing.T) {
	dir := t.TempDir()
	srv := &Server{home: dir}
	sp, err := newSuper(srv, dir)
	if err != nil {
		t.Fatalf("newSuper: %v", err)
	}
	defer sp.db.Close()
	srv.sup = sp

	// Simulate a user prompt followed by an interim progress ack and a live step:
	// `Replied` must remain false while Interim is true or routerStep is newer!
	sp.mu.Lock()
	sp.routerAskedAt = time.Now().Add(-5 * time.Second)
	sp.addEntryLocked("user", mainThread, "检查中转站重命名框问题", "", "")
	sp.mu.Unlock()

	ie, _ := sp.ReplyWithInterim(mainThread, "我去查中转站的重命名框为什么会自动收起。", "", nil, false, true)
	if !ie.Interim {
		t.Fatalf("expected Interim=true")
	}
	sp.noteRouterStep("正在查看在线电脑与会话状态…")
	sp.recordSidebarDispatch("cx-01a1fcb4@dv4gh6w2pm", "复现并修复重命名框自动退出问题")

	sp.mu.Lock()
	defer sp.mu.Unlock()
	if sp.routerStep != "正在查看在线电脑与会话状态…" {
		t.Fatalf("unexpected routerStep: %q", sp.routerStep)
	}
	last := sp.st.Entries[len(sp.st.Entries)-1]
	if last.Role != "event" || last.Ref != "x:cx-01a1fcb4@dv4gh6w2pm" || last.Tone != "spawn" {
		t.Fatalf("expected sidebar dispatch event entry with ref x:..., got %#v", last)
	}
}

func TestPendingResolutionDismissAndPersistence(t *testing.T) {
	dir := t.TempDir()
	srv := &Server{home: dir}
	sp, err := newSuper(srv, dir)
	if err != nil {
		t.Fatalf("newSuper: %v", err)
	}
	defer sp.db.Close()

	// 1. Reply with --opt creates a pending item.
	e1, _ := sp.Reply(mainThread, "选择部署环境？", "", []string{"预发环境", "生产环境", "预发环境"}, true)
	if e1.Check {
		t.Fatalf("--opt should suppress check flag")
	}
	// 2. Reply with --check creates a check-only pending item.
	e2, _ := sp.Reply(mainThread, "请确认迁移方案", "", nil, true)
	if !e2.Check {
		t.Fatalf("expected e2.Check=true")
	}

	sp.mu.Lock()
	pend := sp.pendingLocked(time.Now())
	sp.mu.Unlock()
	if len(pend) != 2 || pend[0].ID != e1.ID || pend[1].ID != e2.ID || !pend[1].Check {
		t.Fatalf("expected 2 pending items [e1, e2], got %#v", pend)
	}

	// 3. Unquoted user message right after e2 resolves e2, while e1 stays pending
	// because another collie message (e2) intervened!
	sp.mu.Lock()
	sp.addEntryLocked("user", mainThread, "方案没问题，继续", "", "")
	pend = sp.pendingLocked(time.Now())
	sp.mu.Unlock()
	if len(pend) != 1 || pend[0].ID != e1.ID {
		t.Fatalf("expected only e1 pending after unquoted user reply to e2, got %#v", pend)
	}

	// 4. Dismissing e1 persists across reload from SQLite.
	sp.Dismiss(e1.ID)
	sp2, err := newSuper(srv, filepath.Clean(dir))
	if err != nil {
		t.Fatalf("reload newSuper: %v", err)
	}
	defer sp2.db.Close()
	sp2.mu.Lock()
	pend2 := sp2.pendingLocked(time.Now())
	sp2.mu.Unlock()
	if len(pend2) != 0 {
		t.Fatalf("expected 0 pending items after reload, got %#v", pend2)
	}
}

func TestParseApprovalCursorNumberedAndTrustChoice(t *testing.T) {
	screen := strings.Join([]string{
		"Hooks need review in ~/.codex/hooks.json",
		"  1. Cancel",
		"› 2. Trust and continue",
		"  3. Open config",
		"↑/↓ navigate · Enter choose · Esc cancel",
	}, "\n")
	a := parseApproval(screen)
	if len(a.Choices) != 3 {
		t.Fatalf("expected 3 choices, got %#v", a.Choices)
	}
	// Cursor is on index 1 ("2. Trust and continue"), so index 0 moves up+enter, index 1 enter, index 2 down+enter!
	if !a.Choices[1].Current || len(a.Choices[1].Keys) != 1 || a.Choices[1].Keys[0] != "enter" {
		t.Fatalf("unexpected choice[1]: %#v", a.Choices[1])
	}
	if len(a.Choices[0].Keys) != 2 || a.Choices[0].Keys[0] != "up" || a.Choices[0].Keys[1] != "enter" {
		t.Fatalf("unexpected choice[0] keys: %#v", a.Choices[0].Keys)
	}
	if !isTrustChoice(a.Choices[1].Label) {
		t.Fatalf("expected %q to match isTrustChoice", a.Choices[1].Label)
	}
}

func TestSortedTimersOrder(t *testing.T) {
	now := time.Now()
	t1 := now.Add(-10 * time.Minute)
	t2 := now.Add(-2 * time.Minute)
	in := []*Timer{
		{ID: "tm1", Enabled: false, LastRun: &t1},
		{ID: "tm2", Enabled: true, NextRun: now.Add(30 * time.Minute)},
		{ID: "tm3", Enabled: false, LastRun: &t2},
		{ID: "tm4", Enabled: true, NextRun: now.Add(5 * time.Minute)},
	}
	got := sortedTimers(in)
	want := []string{"tm4", "tm2", "tm3", "tm1"}
	for i, w := range want {
		if got[i].ID != w {
			t.Fatalf("sortedTimers[%d] = %s, want %s", i, got[i].ID, w)
		}
	}
}

func TestLarkCardNeedsYouWithOptions(t *testing.T) {
	ns := []notice{{
		text:     "要先停掉测试容器吗？",
		options:  []string{"停掉", "保留"},
		hash:     "/#/collie",
		btnLabel: "前往处理确认",
	}}
	card := larkCard(ns, "https://101.200.80.58")
	if !strings.Contains(card, `"template":"orange"`) || !strings.Contains(card, "Collie · 需要你") || !strings.Contains(card, "「停掉」") {
		t.Fatalf("unexpected larkCard output: %s", card)
	}
}

func TestIsUnacceptedCollieDraftAndInterruptDrain(t *testing.T) {
	draft := ">_ OpenAI Codex (v0.171.0)\n  ~\\Documents\\ChatGPT\\SFD-Net 2\n› [collie] 1 new event#t139 · chat:main · system · from collie · 20:25  You are worker \"sfd-splits\""
	if !isUnacceptedCollieDraft(draft) {
		t.Fatalf("expected startup buffered draft to match isUnacceptedCollieDraft")
	}
	if isUnacceptedCollieDraft("已完成四组数据集划分，所有 SHA-256 校验通过。") {
		t.Fatalf("normal assistant reply must not match isUnacceptedCollieDraft")
	}
}

func TestCodexStreamDeltaCapture(t *testing.T) {
	thread := "test-stream-thread-001"
	clearCodexStream(thread)
	appendCodexStreamDelta(thread, "item-1", "第一句流式输出，", "final_answer")
	appendCodexStreamDelta(thread, "item-1", "第二句接着来。", "")
	txt, phase := getCodexStreamSnapshot(thread)
	if txt != "第一句流式输出，第二句接着来。" || phase != "final_answer" {
		t.Fatalf("unexpected stream snapshot: txt=%q phase=%q", txt, phase)
	}
	// New item ID resets the buffer cleanly
	appendCodexStreamDelta(thread, "item-2", "新一轮片段", "commentary")
	txt2, phase2 := getCodexStreamSnapshot(thread)
	if txt2 != "新一轮片段" || phase2 != "commentary" {
		t.Fatalf("unexpected reset snapshot: txt=%q phase=%q", txt2, phase2)
	}
	clearCodexStream(thread)
	if txt3, _ := getCodexStreamSnapshot(thread); txt3 != "" {
		t.Fatalf("expected empty snapshot after clear, got %q", txt3)
	}
}


