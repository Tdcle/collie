package collie

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func parse(t *testing.T, format, data string) []*Message {
	t.Helper()
	p := filepath.Join(t.TempDir(), "s.jsonl")
	os.WriteFile(p, []byte(data), 0o600)
	tr := newTranscript(p, format)
	tr.update()
	return tr.view()
}

func TestClaudeTranscript(t *testing.T) {
	msgs := parse(t, "claude", `{"type":"mode","mode":"x"}
{"type":"user","message":{"content":"<command-name>/clear</command-name>"}}
{"type":"user","message":{"content":"fix the tests"}}
{"type":"assistant","message":{"id":"m1","content":[{"type":"thinking","thinking":"hm"}]}}
{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"Running them."}]}}
{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"go test ./..."}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok","is_error":false}]}}
{"type":"assistant","message":{"id":"m2","content":[{"type":"text","text":"All green."}]}}
{"type":"assistant","isSidechain":true,"message":{"id":"m3","content":[{"type":"text","text":"subagent"}]}}
`)
	want := []string{"user:fix the tests", "assistant:Running them.", "tool:Bash", "assistant:All green."}
	if len(msgs) != len(want) {
		t.Fatalf("got %d messages: %+v", len(msgs), msgs)
	}
	for i, m := range msgs {
		got := m.Kind + ":" + m.Text
		if m.Kind == "tool" {
			got = m.Kind + ":" + m.Name
			if m.Input != "go test ./..." || m.Output != "ok" {
				t.Errorf("tool = %+v", m)
			}
		}
		if got != want[i] {
			t.Errorf("msg %d = %q, want %q", i, got, want[i])
		}
	}
}

func TestCodexTranscript(t *testing.T) {
	msgs := parse(t, "codex", `{"type":"session_meta","payload":{}}
{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"sys"}]}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions"},{"type":"input_text","text":"<environment_context/>"}]}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"list files"}]}}
{"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"ls -la\"}","call_id":"c1"}}
{"type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"a\nb"}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Two files."}]}}
`)
	if len(msgs) != 3 || msgs[0].Text != "list files" || msgs[1].Input != "ls -la" || msgs[1].Output != "a\nb" || msgs[2].Text != "Two files." {
		t.Fatalf("unexpected: %+v %+v %+v", msgs[0], msgs[1], msgs[len(msgs)-1])
	}
}

func TestAgyTranscript(t *testing.T) {
	msgs := parse(t, "agy", `{"type":"USER_INPUT","source":"USER_EXPLICIT","content":"<USER_REQUEST>\nlist files\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>"}
{"type":"PLANNER_RESPONSE","source":"MODEL","tool_calls":[{"name":"run_command","args":{"CommandLine":"\"ls -la\"","toolSummary":"\"List files\""}}]}
{"type":"GENERIC","source":"MODEL","content":"Created At: x\nCommand exited with code 0.\n\nCommand output:\na b"}
{"type":"SYSTEM_MESSAGE","source":"SYSTEM","content":"noise"}
{"type":"PLANNER_RESPONSE","source":"MODEL","content":"Two files."}
`)
	if len(msgs) != 3 || msgs[0].Text != "list files" || msgs[1].Input != "ls -la" || msgs[1].Error ||
		!strings.Contains(msgs[1].Output, "a b") || strings.Contains(msgs[1].Output, "Created At") || msgs[2].Text != "Two files." {
		t.Fatalf("unexpected: %+v %+v %+v", msgs[0], msgs[1], msgs[len(msgs)-1])
	}
}

func TestApprovalNumbered(t *testing.T) {
	a := parseApproval("╭────╮\n│ Bash command\n│   git push origin main\n│ Do you want to proceed?\n│ ❯ 1. Yes\n│   2. Yes, and don't ask again\n│   3. No, and tell Claude what to do differently (esc)\n╰────╯")
	if len(a.Choices) != 3 || a.Choices[0].Text != "1" || !a.Choices[0].Current || a.Choices[1].Label != "Yes, and don't ask again" {
		t.Fatalf("choices = %+v", a.Choices)
	}
	if !strings.Contains(a.Question, "git push origin main") || !strings.Contains(a.Question, "proceed?") {
		t.Fatalf("question = %q", a.Question)
	}
}

func TestApprovalCursorMenu(t *testing.T) {
	a := parseApproval(" Quick safety check: Is this a project you trust?\n\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel")
	if len(a.Choices) != 2 || a.Choices[0].Label != "No, exit" || a.Choices[1].Label != "Yes, I trust this folder" {
		t.Fatalf("choices = %+v", a.Choices)
	}
	if got := strings.Join(a.Choices[1].Keys, ","); got != "down,enter" {
		t.Fatalf("keys = %s", got)
	}
	if !strings.Contains(a.Question, "trust?") || a.Hint == "" {
		t.Fatalf("question=%q hint=%q", a.Question, a.Hint)
	}
}

func TestTimerSpecs(t *testing.T) {
	now := time.Date(2026, 11, 17, 10, 0, 0, 0, time.Local)
	if n, _ := parseSpec("weekly sat,mon 09:00", now); n.Weekday() != time.Saturday && n.Weekday() != time.Monday {
		t.Fatalf("weekly = %v", n)
	}
	if n, _ := parseSpec("weekdays 09:00", now); n.Weekday() == time.Saturday || n.Weekday() == time.Sunday || !n.After(now) {
		t.Fatalf("weekdays = %v", n)
	}
	wt := &Timer{Spec: "weekdays 09:00", Enabled: true}
	wt.NextRun, _ = parseSpec(wt.Spec, now)
	for i := 0; i < 7; i++ {
		prev := wt.NextRun
		wt.advance(prev)
		if !wt.NextRun.After(prev) || wt.NextRun.Weekday() == time.Saturday || wt.NextRun.Weekday() == time.Sunday || wt.NextRun.Hour() != 9 {
			t.Fatalf("weekdays advance %v -> %v", prev, wt.NextRun)
		}
	}
	if _, err := parseSpec("weekly xyz 09:00", now); err == nil {
		t.Fatal("bad weekday accepted")
	}
	if n, _ := parseSpec("daily 09:00", now); n.Day() != 18 || n.Hour() != 9 {
		t.Fatalf("daily = %v", n)
	}
	if n, _ := parseSpec("every 30m", now); n.Sub(now) != 30*time.Minute {
		t.Fatalf("every = %v", n)
	}
	tm := &Timer{Spec: "in 5m", NextRun: now, Enabled: true}
	tm.advance(now)
	if tm.Enabled {
		t.Fatal("one-shot timer should disable after firing")
	}
	if _, err := parseSpec("every 10s", now); err == nil {
		t.Fatal("sub-minute intervals should be rejected")
	}
}

func TestMsgSyncPatches(t *testing.T) {
	p := filepath.Join(t.TempDir(), "s.jsonl")
	line := func(text string) string {
		return `{"type":"user","message":{"content":"` + text + `"}}` + "\n"
	}
	os.WriteFile(p, []byte(line("one")+line("two")), 0o600)
	tr := newTranscript(p, "claude")
	tr.update()
	var ms msgSync
	first := ms.patch(tr)
	if first == nil || first.From != first.Base || len(first.Msgs) != 2 {
		t.Fatalf("first patch = %+v", first)
	}
	if ms.patch(tr) != nil {
		t.Fatal("no change should send nothing")
	}
	f, _ := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString(line("three"))
	f.Close()
	tr.update()
	next := ms.patch(tr)
	if next == nil || next.From != 2 || len(next.Msgs) != 1 || next.Msgs[0].Text != "three" {
		t.Fatalf("append patch = %+v", next)
	}
	tr.msgs[0].Text = "changed" // a message filled in later (a tool's output)
	if p := ms.patch(tr); p == nil || p.From != 0 || len(p.Msgs) != 3 {
		t.Fatalf("change patch = %+v", p)
	}
}

func TestOpenTail(t *testing.T) {
	p := filepath.Join(t.TempDir(), "s.jsonl")
	var b strings.Builder
	pad := strings.Repeat("x", 60000)
	for i := 0; b.Len() < 9<<20; i++ {
		b.WriteString(`{"type":"user","message":{"content":"m` + strings.Repeat("0", 6-len(itoa(i))) + itoa(i) + ` ` + pad + `"}}` + "\n")
	}
	os.WriteFile(p, []byte(b.String()), 0o600)
	full := newTranscript(p, "claude")
	full.update()
	tail := newTranscript(p, "claude")
	tail.openTail()
	if tail.offset != full.offset {
		t.Fatalf("tail stopped at %d, file ends at %d", tail.offset, full.offset)
	}
	fv, tv := full.view(), tail.view()
	if len(tv) < maxMessages/2 || fv[len(fv)-1].Text != tv[len(tv)-1].Text {
		t.Fatalf("tail view %d msgs, last %q", len(tv), tv[len(tv)-1].Text[:8])
	}
	for _, m := range tv {
		if !strings.HasPrefix(m.Text, "m") {
			t.Fatalf("partial line parsed: %q", m.Text[:20])
		}
	}
}

func itoa(i int) string { return strconv.Itoa(i) }

func TestEarlierMessagesWalkBack(t *testing.T) {
	p := filepath.Join(t.TempDir(), "s.jsonl")
	var b strings.Builder
	pad := strings.Repeat("y", 3000)
	n := 0
	for ; b.Len() < 9<<20; n++ {
		b.WriteString(`{"type":"user","message":{"content":"m` + fmt.Sprintf("%06d", n) + ` ` + pad + `"}}` + "\n")
	}
	os.WriteFile(p, []byte(b.String()), 0o600)

	tr := newTranscript(p, "claude")
	tr.openTail()
	var got []string
	for _, m := range tr.view() {
		got = append(got, m.Text[:7])
	}
	cursor := tr.earlierCursor()
	for pages := 0; cursor > 0; pages++ {
		if pages > 100 {
			t.Fatal("never reached the top")
		}
		msgs, next := earlierMessages(p, "claude", cursor, earlierPage)
		if len(msgs) == 0 || next >= cursor {
			t.Fatalf("page %d: %d msgs, cursor %d → %d", pages, len(msgs), cursor, next)
		}
		var page []string
		for _, m := range msgs {
			page = append(page, m.Text[:7])
		}
		got, cursor = append(page, got...), next
	}
	if len(got) != n {
		t.Fatalf("walked back %d messages, the log has %d", len(got), n)
	}
	for i, s := range got {
		if s != fmt.Sprintf("m%06d", i) {
			t.Fatalf("message %d is %q", i, s)
		}
	}
}

func TestEarlierCursorShortLog(t *testing.T) {
	p := filepath.Join(t.TempDir(), "s.jsonl")
	os.WriteFile(p, []byte(`{"type":"user","message":{"content":"hi"}}`+"\n"), 0o600)
	tr := newTranscript(p, "claude")
	tr.openTail()
	if c := tr.earlierCursor(); c != 0 {
		t.Fatalf("a short log has nothing earlier, got cursor %d", c)
	}
}

func TestActivityLine(t *testing.T) {
	cases := map[string]string{
		// counters without a key hint (newer Claude)
		"✻ Pondering… (42s · ↓ 1.8k tokens)\n❯ ": "Pondering…|42s · ↓ 1.8k tokens",
		// Claude being interrupted (the screenshot)
		"✻ Interrupting Claude…\n\n────────\n❯ \n────────\n  ⏵⏵ auto mode on · esc to interrupt": "Interrupting Claude…",
		// Claude thinking, with the timing parenthetical
		"● Earlier output line\n\n✶ Thinking… (12s · ↓ 1.2k tokens · esc to interrupt)\n\n╭──────╮\n│ > draft │\n╰──────╯\n  ? for shortcuts": "Thinking…|12s · ↓ 1.2k tokens",
		// Codex
		// agy (from a real screen)
		"● Explored 2 files (index.md, df-check.md) (ctrl+o to expand)\n⣻  Memory structure appears clean. Creating a note file...\n────\n> Auto mode: edits & safe commands auto-approved (shift+tab to cycle)\n────\nesc to cancel        auto · Gemini 4 Carbon · high": "Memory structure appears clean. Creating a note file...",
		"• Working (5s • esc to interrupt)\n\n› Ask Codex to do anything\n\n  ⏎ send   ⇧⏎ newline": "Working|5s",
		// a parenthetical of words stays in the text
		"✻ Reading (src/main.go)\n❯ ": "Reading (src/main.go)",
	}
	for in, want := range cases {
		text, meta, _, _ := activityLine(in)
		got := text
		if meta != "" {
			got += "|" + meta
		}
		if got != want {
			t.Errorf("activityLine(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestExtractStreamingBubble(t *testing.T) {
	screen := "› Write a poem\n\n── Worked for 12s ──\n• All night the maple loosens its red leaves.\n  By dawn they blur the edges of the street.\n  A sparrow\n\n› Ask Codex to do anything\n  GPT-6.2-Astra high · /private/tmp\n"
	text, _, streaming, phase := activityLine(screen)
	if text != "" {
		t.Fatalf("expected streaming text to go into streaming bubble rather than status tail, got tail=%q", text)
	}
	want := "All night the maple loosens its red leaves.\nBy dawn they blur the edges of the street.\nA sparrow"
	if streaming != want || phase != "final_answer" {
		t.Fatalf("unexpected streaming bubble:\ngot:  %q (phase=%q)\nwant: %q (phase=final_answer)", streaming, phase, want)
	}

	// Regression: Completed Codex TUI tool cells (`• Ran ... \n └ 4309`, `• Edited ...`)
	// above a bottom spinner must NEVER leak into `streaming`!
	toolScreen := strings.Join([]string{
		"› 续接 SFD-Net 息肉数据准备",
		"• Ran python revision/polyp_splits_20261123/make_splits.py --verify …",
		"  └   4309",
		"    + 5 lines (ctrl+t to expand)",
		"• Comparing local progress · 2 background terminals running · /ps to view · /stop to close (1m 10s • esc to interrupt)",
		"  └ Tip: Use /theme to choose a syntax highlighting theme.",
		"› Ask Codex to do anything",
		"  GPT-6.2-Astra high · ~\\Documents\\ChatGPT\\SFD-Net 2 · 论文返修",
	}, "\n")
	tail2, meta2, streaming2, _ := activityLine(toolScreen)
	if streaming2 != "" {
		t.Fatalf("expected tool cell `Ran ...` NOT to leak into streaming bubble, got %q", streaming2)
	}
	if strings.Contains(tail2, "/ps to view") || strings.Contains(tail2, "/stop to close") {
		t.Fatalf("expected slash hints to be stripped from status tail, got %q", tail2)
	}
	if meta2 != "1m 10s" {
		t.Fatalf("expected meta 1m 10s, got %q", meta2)
	}
}

func TestUnwrapCodexJsReplToolAndLinkMeta(t *testing.T) {
	rawExec := []byte("\"text(await tools.exec_command({cmd: `python revision/make_splits.py --verify`}))\"")
	name1, in1 := unwrapCodexTool("js_repl", rawExec)
	if name1 != "bash" || !strings.Contains(in1, "python revision/make_splits.py --verify") {
		t.Fatalf("unexpected js_repl exec unwrap: name=%q in=%q", name1, in1)
	}
	name2, in2 := unwrapCodexTool("js_repl", []byte(`"text(await tools.apply_patch('*** Begin Patch ***\n*** Add File: revision/verify_cpu.py\n+import os\n*** End Patch ***'))"`))
	if name2 != "patch" || in2 != "revision/verify_cpu.py" {
		t.Fatalf("unexpected js_repl patch unwrap: name=%q in=%q", name2, in2)
	}

	title, site := parseHTMLTitleAndSite(`<html><head><meta property="og:site_name" content="GitHub"><meta property="og:title" content="Comparing main...lihuanyu0w0:collie:main · Tdcle/collie"><title>Fallback</title></head></html>`)
	if title != "Comparing main...lihuanyu0w0:collie:main · Tdcle/collie" || site != "GitHub" {
		t.Fatalf("unexpected parsed HTML meta: title=%q site=%q", title, site)
	}
}
