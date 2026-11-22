package collie

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestAskOf(t *testing.T) {
	m := askOf("AskUserQuestion", json.RawMessage(`{"questions":[{"question":"Which?","header":"H","options":[{"label":"A"},{"label":"B"}],"multiSelect":false}]}`))
	if m == nil || m.Kind != "ask" || m.Text != "Which?" || len(m.Options) != 2 {
		t.Fatalf("AskUserQuestion: %+v", m)
	}
	m = askOf("mcp__ccd_turn__wrap_up", json.RawMessage(`{"recap":"R","ask":"Go?","actions":[{"label":"Yes"},{"action":"commit","label":"x"}]}`))
	if m == nil || m.Name != "wrap_up" || m.Text != "Go?" || m.Input != "R" || len(m.Options) != 1 || m.Options[0] != "Yes" {
		t.Fatalf("wrap_up: %+v", m)
	}
	if m := askOf("mcp__ccd_turn__wrap_up", json.RawMessage(`{"recap":"R"}`)); m == nil || m.Name != "recap" || m.Input != "R" {
		t.Fatalf("recap only: %+v", m)
	}
	// Codex Desktop request_user_input_async (JSON-encoded string arguments, string options)
	codexAsyncArgs, _ := json.Marshal(`{"questions":[{"title":"这台 Hub 希望怎么访问？","options":["HTTPS 直连","SSH 隧道"]}]}`)
	cm := askOf("request_user_input_async", codexAsyncArgs)
	if cm == nil || cm.Kind != "ask" || cm.Name != "request_user_input_async" || cm.Text != "这台 Hub 希望怎么访问？" || len(cm.Options) != 2 || cm.Options[0] != "HTTPS 直连" {
		t.Fatalf("Codex request_user_input_async: %+v", cm)
	}
}

func TestCodexAsyncQuestionTranscriptAndOpenStatus(t *testing.T) {
	dir := t.TempDir()
	rollout := filepath.Join(dir, "rollout-test.jsonl")

	lUser := `{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"现在有打包 zip 的功能，需要加上多选的功能。\n"}]}}`
	lAsk := `{"type":"response_item","payload":{"type":"function_call","name":"request_user_input_async","arguments":"{\"questions\":[{\"title\":\"用于部署的阿里云控制台现在停在登录页。请在已打开的页面完成登录，然后告诉我；我会继续发布到原网址。\"}]}","call_id":"call_ask_1"}}`
	lAskOut := `{"type":"response_item","payload":{"type":"function_call_output","call_id":"call_ask_1","output":"{\"accepted\":true}"}}`
	lAsyncMsg := `{"type":"response_item","payload":{"type":"function_call","name":"send_message_to_user_async","arguments":"{\"message\":\"本地测试已全部通过，等待登录确认。\"}","call_id":"call_msg_1"}}`
	lTaskDone := `{"type":"event_msg","payload":{"type":"task_complete","turn_id":"t1"}}`

	if err := os.WriteFile(rollout, []byte(lUser+"\n"+lAsk+"\n"+lAskOut+"\n"+lAsyncMsg+"\n"+lTaskDone+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// 1. Transcript must surface ask card (open, Output=="") and async assistant message, NOT hide them in tool steps.
	tr := newTranscript(rollout, "codex")
	tr.openTail()
	msgs := tr.view()
	if len(msgs) != 3 {
		t.Fatalf("expected 3 messages (user, ask, assistant), got %d: %+v", len(msgs), msgs)
	}
	if msgs[1].Kind != "ask" || msgs[1].Name != "request_user_input_async" || msgs[1].Output != "" {
		t.Fatalf("expected unanswered ask card (Output empty despite accepted:true), got %+v", msgs[1])
	}
	if msgs[2].Kind != "assistant" || msgs[2].Text != "本地测试已全部通过，等待登录确认。" {
		t.Fatalf("expected send_message_to_user_async as assistant message, got %+v", msgs[2])
	}

	// 2. Rollout open-question detector must report true while unanswered (even after task_complete!).
	if !codexHasOpenQuestion(rollout) {
		t.Fatal("expected codexHasOpenQuestion=true while request_user_input_async has no user reply")
	}

	// 3. User answers via Codex Desktop card (<send_user_message_question_reply>):
	// must NOT be dropped as XML noise and must clear codexHasOpenQuestion!
	lCardReply := `{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<send_user_message_question_reply>\n[{\"questionItemId\":\"[\\\"request_user_input_async\\\",\\\"call_ask_1\\\",0]\",\"question\":\"用于部署的阿里云控制台现在停在登录页...\",\"answer\":\"已登录\"}]\n</send_user_message_question_reply>\n"}]}}`
	f, err := os.OpenFile(rollout, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.WriteString(lCardReply + "\n")
	f.Close()

	if !tr.update() {
		t.Fatal("expected tr.update()=true on <send_user_message_question_reply>")
	}
	msgs = tr.view()
	if len(msgs) != 4 || msgs[3].Kind != "user" || msgs[3].Text != "已登录" {
		t.Fatalf("expected clean user reply '已登录', got %+v", msgs)
	}
	if codexHasOpenQuestion(rollout) {
		t.Fatal("expected codexHasOpenQuestion=false after user answered")
	}
}

func TestQueuedCommand(t *testing.T) {
	tr := newTranscript("", "claude")
	if !tr.claudeLine([]byte(`{"type":"attachment","attachment":{"type":"queued_command","prompt":"还有些消息看不到","origin":{"kind":"human"}}}`)) {
		t.Fatal("human queued command not taken")
	}
	tr.claudeLine([]byte(`{"type":"attachment","attachment":{"type":"queued_command","prompt":[{"type":"image","source":{}},{"type":"text","text":"看图"}],"origin":{"kind":"human"}}}`))
	if tr.claudeLine([]byte(`{"type":"attachment","attachment":{"type":"queued_command","prompt":"x","origin":{"kind":"task-notification"}}}`)) {
		t.Fatal("non-human queued command shown")
	}
	if len(tr.msgs) != 2 || tr.msgs[0].Text != "还有些消息看不到" || tr.msgs[1].Text != "[image]\n看图" {
		t.Fatalf("%+v %+v", tr.msgs[0], tr.msgs[len(tr.msgs)-1])
	}
}

func TestCodexPhaseSeparationAndReasoningSummary(t *testing.T) {
	dir := t.TempDir()
	rollout := filepath.Join(dir, "rollout-phase.jsonl")

	lines := []string{
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"帮我检查部署状态"}]}}`,
		`{"type":"response_item","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"**Checking systemd units**"}]}}`,
		`{"type":"response_item","payload":{"type":"message","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"我先查看一下服务器上的服务状态。"}]}}`,
		`{"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"systemctl status collie-hub\"}","call_id":"c1"}}`,
		`{"type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"active (running)"}}`,
		`{"type":"response_item","payload":{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"服务运行正常，当前处于 active 状态。"}]}}`,
	}
	if err := os.WriteFile(rollout, []byte(joinLines(lines)), 0o644); err != nil {
		t.Fatal(err)
	}

	tr := newTranscript(rollout, "codex")
	tr.openTail()
	msgs := tr.view()
	if len(msgs) != 5 {
		t.Fatalf("expected 5 messages, got %d: %+v", len(msgs), msgs)
	}
	if msgs[1].Phase != "reasoning" || msgs[1].Text != "**Checking systemd units**" {
		t.Fatalf("expected reasoning summary message, got %+v", msgs[1])
	}
	if msgs[2].Phase != "commentary" || msgs[2].Text != "我先查看一下服务器上的服务状态。" {
		t.Fatalf("expected commentary phase on intermediate assistant message, got %+v", msgs[2])
	}
	if msgs[3].Kind != "tool" || msgs[3].Output != "active (running)" {
		t.Fatalf("expected tool step, got %+v", msgs[3])
	}
	if msgs[4].Phase != "final_answer" || msgs[4].Text != "服务运行正常，当前处于 active 状态。" {
		t.Fatalf("expected final_answer phase on conclusion message, got %+v", msgs[4])
	}
}

func joinLines(ls []string) string {
	out := ""
	for _, l := range ls {
		out += l + "\n"
	}
	return out
}
