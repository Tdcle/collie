package collie

import (
	"strings"
	"testing"
)

// Real screens from claude 2.1 on herdr 0.8, which reports both as "idle".
const idleClaude = `           Claude Code v2.1.325
 ▐▛███▛█   llmbox-2/seed-evolving[1m]
▝▜██████▀  API Usage Billing
 ▝▝   ▝▝   /…/home/u/.collie/router

  ⎿  SessionStart:startup hook error
  ⎿  Failed with non-blocking status code:
     node:internal/modules/cjs/loader:1433

● 已回复：自我介绍 + hostname（n37-125-077），两条测试
  消息内容相同，合并为一条回复。

✻ Worked for 14s · done 5:11 AM

──────────────────────────────────────────────────────
❯ Try "edit <filepath> to..."
──────────────────────────────────────────────────────
  ⏸ manual mode on · ? for shortcuts
`

const trustDialog = ` Accessing workspace:
 /data00/home/u/.collie
 Quick safety check: Is this a project you created or
 one you trust? (Like your own code, a well-known
 open source project, or work from your team). If
 not, take a moment to review what's in this folder
 first.
 Claude Code'll be able to read, edit, and execute
 files here.
 Security guide
 ❯ 1. Yes, I trust this folder
   2. No, exit
 Enter to confirm · Esc to cancel
`

const wrappedMenu = `─────────────────────────────────────────────────────
 Read file
 Symlink target: /data00/home/u/.collie/up
 loads/20261117/0d224b-number.png

╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Read(/home/u/.collie/uploads/20261117/0d2
 24b-number.png)
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, allow reading from
      /home/u/.collie/uploads/20261117 and
      /data00/home/u/.collie/uploads/2026
      1117 during this session
   3. No

 Esc to cancel · Tab to amend`

func TestWrappedChoices(t *testing.T) {
	a := parseApproval(wrappedMenu)
	if len(a.Choices) != 3 || !a.Choices[0].Current || !strings.HasPrefix(a.Choices[1].Label, "Yes, allow reading from /home/u") || a.Choices[2].Label != "No" {
		t.Fatalf("choices: %+v", a.Choices)
	}
	if !strings.HasSuffix(a.Question, "Do you want to proceed?") || !strings.Contains(a.Question, "Read file") {
		t.Fatalf("question: %q", a.Question)
	}
}

func TestScreenAsks(t *testing.T) {
	if screenAsks(idleClaude) {
		t.Error("idle prompt taken for a question")
	}
	if !screenAsks(trustDialog) {
		t.Error("trust dialog not seen")
	}
	if !screenAsks(cursorTrust) {
		t.Error("cursor-style trust dialog not seen")
	}
}

const cursorTrust = ` Claude Code'll be able to read, edit, and execute
 files here.
 Security guide
 ❯ No, exit
   Yes, I trust this folder
 Enter to confirm · Esc to cancel
`

const trustFull = `u@host:~/collie-card-test$ claude

──────────────────────────────────────────────────────
 Accessing workspace:

 /data00/home/u/collie-card-test

 Quick safety check: Is this a project you created or
 one you trust? (Like your own code, a well-known
 open source project, or work from your team). If
 not, take a moment to review what's in this folder
 first.

 Claude Code'll be able to read, edit, and execute
 files here.

 Security guide

 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel
`

func TestApprovalKeepsParagraphs(t *testing.T) {
	a := parseApproval(trustFull)
	if len(a.Choices) != 2 {
		t.Fatalf("choices: %+v", a.Choices)
	}
	if strings.Contains(a.Question, "$ claude") {
		t.Errorf("question starts above the dialog:\n%s", a.Question)
	}
	if !strings.HasPrefix(a.Question, " Accessing workspace:\n\n") || !strings.Contains(a.Question, "\n\n Quick safety check:") {
		t.Errorf("paragraphs lost:\n%q", a.Question)
	}
}

// The router quoted a worker's trust dialog, then went back to its prompt.
const quotedDialog = `> [collie] 1 new event

  #t132 · chat:main · worker · from paper-ref-checker · 20:20
    worker paper-ref-checker is BLOCKED waiting for a human approval/answer in its
  terminal. Screen:
    Accessing workspace:
    /data00/home/u/agent-workspace
    Do you trust the contents of this project?
    Antigravity CLI requires permission to read, edit, and execute files here.
    > Yes, I trust this folder
      No, exit
      ↑/↓ Navigate · enter Confirm
                                                     auto · Gemini 4 Carbon ·
  high

  Reply to the human only via ` + "`collie reply`" + `.

○ Thought for 5.8s (I realized I was wrong in telling the user that no prompt was expected)
● Ran (C=/data00/home/u/.local/bin/collie; $C reply "说错了") (ctrl+o to expand)

  paper-ref-checker is stuck waiting for you to approve folder access, so it hasn't started
  the check yet.

───────────────────────────────────────────────────────────────────────────────
>
───────────────────────────────────────────────────────────────────────────────
? for shortcuts                                         auto · Claude Opus 5.5 · medium`

// The same dialog, live in an agy pane.
const agyTrust = ` Accessing workspace:
 /data00/home/u/agent-workspace
 Do you trust the contents of this project?
 Antigravity CLI requires permission to read, edit, and execute files here.
 > Yes, I trust this folder
   No, exit
   ↑/↓ Navigate · enter Confirm
                                                     auto · Gemini 4 Carbon · high`

func TestScreenAsksQuoted(t *testing.T) {
	if screenAsks(quotedDialog) {
		t.Error("a dialog quoted in the transcript counted as a question")
	}
	if !screenAsks(agyTrust) {
		t.Error("agy's trust dialog not seen")
	}
}

// Claude's AskUserQuestion box: descriptions under the options, and the last
// option set apart by a rule.
const askBox = `───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 ☐ Color

Which color for the button?

❯ 1. Red
     warm
  2. Blue
     calm
  3. Green
     fresh
  4. Type something.
───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel`

func TestAskBox(t *testing.T) {
	if !screenAsks(askBox) {
		t.Fatal("not seen as a question")
	}
	a := parseApproval(askBox)
	if len(a.Choices) != 5 || a.Choices[0].Label != "Red" || a.Choices[0].Desc != "warm" || !a.Choices[0].Current ||
		a.Choices[2].Desc != "fresh" || a.Choices[4].Text != "5" || a.Choices[4].Label != "Chat about this" {
		t.Fatalf("choices: %+v", a.Choices)
	}
	if !strings.HasSuffix(a.Question, "Which color for the button?") {
		t.Fatalf("question: %q", a.Question)
	}
}

func TestCodexHooksModalDetectionAndApproval(t *testing.T) {
	herdrHookScreen := `
  SessionStart hooks
  1 hook needs review before it can run.

› [!]  1  Unnamed hook · new

  Event     SessionStart
  Source    User config - ~\.codex\hooks.json
  Command   powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\26422\.codex\herdr-agent-state.ps1" session
  Mode      Sync
  Timeout   10s
  Trust     New hook - review required


  t trust · esc back`
	if !codexHerdrHookReview(herdrHookScreen) {
		t.Fatal("expected herdr-agent-state SessionStart hook review screen to match codexHerdrHookReview")
	}

	customHookScreen := strings.ReplaceAll(herdrHookScreen, "herdr-agent-state.ps1", "custom-audit.ps1")
	if codexHerdrHookReview(customHookScreen) {
		t.Fatal("expected non-herdr custom hook NOT to auto-match codexHerdrHookReview")
	}
	if !screenAsks(customHookScreen) {
		t.Fatal("expected custom hook review modal ('t trust · esc back') to be detected by screenAsks")
	}
	a := parseApproval(customHookScreen)
	if len(a.Choices) != 2 || a.Choices[0].Text != "t" {
		t.Fatalf("expected 2 choices with first choice 't', got %+v", a.Choices)
	}

	hooksToggleScreen := `
  SessionStart hooks
  Turn hooks on or off. Your changes are saved automatically.

› [x]  1  Unnamed hook

  space/enter toggle · esc back`
	hooksListScreen := `
  Hooks
  Lifecycle hooks from config and enabled plugins.

  enter details · esc close`
	if !codexDismissibleOverlay(hooksToggleScreen) || !codexDismissibleOverlay(hooksListScreen) {
		t.Fatal("expected both Codex Hooks toggle and list overlays to match codexDismissibleOverlay")
	}
}

