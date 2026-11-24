package collie

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// The same binary doubles as the tool surface for router and worker sessions:
// `collie reply|spawn|send|report|show|list|timer|…` talk to the local server.

var cliCommands = map[string]func([]string) error{
	"reply": cliReply, "spawn": cliSpawn, "send": cliSend, "report": cliReport,
	"subscribe": cliSubscribe, "stop": cliStop, "answer": cliAnswer, "show": cliShow, "list": cliList,
	"timer": cliTimer, "say": cliSay, "hook": cliHook, "pair": cliPair, "exec": cliExec,
}

func collieDir() string {
	if d := os.Getenv("COLLIE_HOME"); d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".collie")
}

func runCLI(cmd string, args []string) {
	if err := cliCommands[cmd](args); err != nil {
		fmt.Fprintln(os.Stderr, "collie "+cmd+":", err)
		os.Exit(1)
	}
}

func cliCall(method, path string, body any) ([]byte, error) {
	base, tok, err := cliTarget()
	if err != nil {
		return nil, err
	}
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, base+path, rd)
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return nil, fmt.Errorf("collie server unreachable: %w", err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		var e struct{ Error string }
		if json.Unmarshal(out, &e) == nil && e.Error != "" {
			return nil, fmt.Errorf("%s", e.Error)
		}
		return nil, fmt.Errorf("%s", strings.TrimSpace(string(out)))
	}
	return out, nil
}

// cliTarget finds the hub: on a computer joined with `collie node`, its hub
// (with this computer's token); otherwise the hub running on this machine.
func cliTarget() (base, token string, err error) {
	if c, ok := loadNodeConfig(); ok {
		return strings.TrimRight(c.Hub, "/"), c.Token, nil
	}
	dir := collieDir()
	tok, err := os.ReadFile(filepath.Join(dir, "token"))
	if err != nil {
		return "", "", fmt.Errorf("no token in %s (is the collie server set up?)", dir)
	}
	addr, err := os.ReadFile(filepath.Join(dir, "addr"))
	if err != nil {
		return "", "", fmt.Errorf("collie server is not running (no %s/addr)", dir)
	}
	a := strings.TrimSpace(string(addr))
	if !strings.Contains(a, "://") {
		a = "http://" + a
	}
	return a, strings.TrimSpace(string(tok)), nil
}

// cliPair prints a one-time code: a QR code for a phone, or the command that
// joins another computer.
func cliPair(args []string) error {
	fs := flag.NewFlagSet("pair", flag.ExitOnError)
	computer := fs.Bool("computer", false, "pair another computer instead of a phone")
	fs.Parse(args)
	kind := "browser"
	if *computer {
		kind = "machine"
	}
	b, err := cliCall("POST", "/api/pair/new", map[string]any{"kind": kind})
	if err != nil {
		return err
	}
	var r struct {
		Code      string   `json:"code"`
		Addresses []string `json:"addresses"`
	}
	json.Unmarshal(b, &r)
	if len(r.Addresses) == 0 {
		return fmt.Errorf("hub has no address")
	}
	if *computer {
		addr := r.Addresses[0]
		fmt.Printf("\n  在要加入的电脑上运行（10 分钟内有效，只能用一次）：\n\n")
		fmt.Printf("  macOS / Linux:\n    curl -fsSL https://raw.githubusercontent.com/%s/main/docs/install.sh | sh -s -- node --hub %s --code %s\n\n", releaseRepo(), addr, r.Code)
		fmt.Printf("  Windows (PowerShell):\n    powershell -ExecutionPolicy Bypass -Command \"& ([scriptblock]::Create((irm https://raw.githubusercontent.com/%s/main/docs/install.ps1))) node --hub %s --code %s\"\n\n", releaseRepo(), addr, r.Code)
		fmt.Printf("  已安装 collie 时：\n    collie node --hub %s --code %s\n\n", addr, r.Code)
		if len(r.Addresses) > 1 {
			fmt.Printf("  连不上的话换一个地址：%s\n\n", strings.Join(r.Addresses[1:], "  "))
		}
		return nil
	}
	u := pairURL(r.Addresses[0], r.Code)
	fmt.Printf("\n  用手机扫码（10 分钟内有效，只能用一次）：\n\n")
	printQR(os.Stdout, u)
	fmt.Printf("\n  %s\n\n", u)
	return nil
}

// textArg joins positional args; "-" (or nothing, with piped stdin) reads stdin.
func textArg(fs *flag.FlagSet) (string, error) {
	t := strings.Join(fs.Args(), " ")
	if t == "-" || (t == "" && !isTerminal(os.Stdin)) {
		b, err := io.ReadAll(os.Stdin)
		if err != nil {
			return "", err
		}
		t = string(b)
	}
	if strings.TrimSpace(t) == "" {
		return "", fmt.Errorf("text is required")
	}
	return t, nil
}

func isTerminal(f *os.File) bool {
	fi, err := f.Stat()
	return err == nil && fi.Mode()&os.ModeCharDevice != 0
}

func printResult(b []byte) {
	var m map[string]any
	if json.Unmarshal(b, &m) == nil {
		if w, ok := m["warning"].(string); ok {
			fmt.Println("warning:", w)
		}
		delete(m, "warning")
		out, _ := json.Marshal(m)
		fmt.Println(string(out))
		return
	}
	os.Stdout.Write(b)
}

type flagList []string

func (l *flagList) String() string     { return strings.Join(*l, ", ") }
func (l *flagList) Set(v string) error { *l = append(*l, v); return nil }

func parseReply(args []string, in io.Reader, tty bool) (map[string]any, error) {
	fs := flag.NewFlagSet("reply", flag.ContinueOnError)
	thread := fs.String("thread", mainThread, "thread to reply in")
	re := fs.String("re", "", "the event (#t123) this answers, shown to the human as a quote")
	var opts flagList
	fs.Var(&opts, "opt", "quick-reply choice button for the human (repeatable)")
	check := fs.Bool("check", false, "mark as needing the human's review or action (without --opt)")
	interim := fs.Bool("interim", false, "mark as an interim dispatch/progress update (folds once final summary arrives)")
	if err := fs.Parse(args); err != nil {
		return nil, err
	}
	t := strings.Join(fs.Args(), " ")
	if t == "-" || (t == "" && !tty && in != nil) {
		b, err := io.ReadAll(in)
		if err != nil {
			return nil, err
		}
		t = string(b)
	}
	if strings.TrimSpace(t) == "" {
		return nil, fmt.Errorf("text is required")
	}
	body := map[string]any{"text": t, "thread": *thread, "re": *re}
	if len(opts) > 0 {
		body["options"] = []string(opts)
	}
	if *check {
		body["check"] = true
	}
	if *interim {
		body["interim"] = true
	}
	return body, nil
}

func cliReply(args []string) error {
	body, err := parseReply(args, os.Stdin, isTerminal(os.Stdin))
	if err == flag.ErrHelp {
		return nil
	}
	if err != nil {
		return err
	}
	b, err := cliCall("POST", "/api/super/reply", body)
	if err == nil {
		printResult(b)
	}
	return err
}

func cliSay(args []string) error {
	fs := flag.NewFlagSet("say", flag.ExitOnError)
	fs.Parse(args)
	t, err := textArg(fs)
	if err != nil {
		return err
	}
	b, err := cliCall("POST", "/api/super/say", map[string]any{"text": t})
	if err == nil {
		printResult(b)
	}
	return err
}

type multiFlag []string

func (m *multiFlag) String() string     { return strings.Join(*m, " ") }
func (m *multiFlag) Set(v string) error { *m = append(*m, v); return nil }

func cliSpawn(args []string) error {
	fs := flag.NewFlagSet("spawn", flag.ExitOnError)
	kind := fs.String("kind", "", "claude | codex | antigravity (default from settings)")
	cwd := fs.String("cwd", "", "working directory (default from settings)")
	thread := fs.String("thread", mainThread, "thread this work belongs to")
	name := fs.String("name", "", "worker name (default kind-N)")
	machine := fs.String("machine", "", "which computer (see `collie list`; default from settings)")
	model := fs.String("model", "", "model to launch with (default from settings for the default kind)")
	effort := fs.String("effort", "", "thinking effort: low | medium | high | xhigh | max ...")
	var extraArgs multiFlag
	fs.Var(&extraArgs, "arg", "extra flag passed to the agent CLI (repeatable, e.g. -arg -c -arg service_tier=\"fast\")")
	sub := fs.Bool("subscribe", false, "route later events of --thread straight to this worker")
	resume := fs.String("resume", "", "a stopped worker to carry on from: its computer, directory and conversation")
	fs.Parse(args)
	t, err := textArg(fs)
	if err != nil {
		return err
	}
	body := map[string]any{"kind": *kind, "cwd": *cwd, "name": *name, "task": t, "by": by(), "model": *model, "effort": *effort, "resume": *resume}
	if len(extraArgs) > 0 {
		body["args"] = []string(extraArgs)
	}
	fs.Visit(func(f *flag.Flag) {
		if f.Name == "subscribe" {
			body["subscribe"] = *sub
		}
		if f.Name == "machine" {
			body["machine"] = *machine
		}
		if f.Name == "thread" {
			body["thread"] = *thread
		}
	})
	b, err := cliCall("POST", "/api/super/spawn", body)
	if err == nil {
		printResult(b)
	}
	return err
}

func cliExec(args []string) error {
	fs := flag.NewFlagSet("exec", flag.ExitOnError)
	machine := fs.String("machine", "", "which computer (see `collie list`)")
	cwd := fs.String("cwd", "", "working directory on that computer")
	timeout := fs.Int("timeout", 60, "timeout in seconds (max 180)")
	fs.Parse(args)
	cmd, err := textArg(fs)
	if err != nil {
		return err
	}
	b, err := cliCall("POST", "/api/super/exec", map[string]any{
		"machine": *machine, "cwd": *cwd, "command": cmd, "timeout_sec": *timeout,
	})
	if err != nil {
		return err
	}
	var r execResp
	if json.Unmarshal(b, &r) == nil {
		if r.Output != "" {
			fmt.Print(r.Output)
			if !strings.HasSuffix(r.Output, "\n") {
				fmt.Println()
			}
		}
		if r.ExitCode != 0 {
			return fmt.Errorf("exit status %d", r.ExitCode)
		}
		return nil
	}
	printResult(b)
	return nil
}

func by() string {
	if os.Getenv("HERDR_PANE_ID") != "" {
		return routerName
	}
	return "cli"
}

func cliSend(args []string) error {
	fs := flag.NewFlagSet("send", flag.ExitOnError)
	thread := fs.String("thread", "", "thread (default: the worker's)")
	fs.Parse(args)
	if fs.NArg() < 2 {
		return fmt.Errorf("usage: collie send <worker> <text>")
	}
	to := fs.Arg(0)
	b, err := cliCall("POST", "/api/super/send", map[string]any{"to": to, "text": strings.Join(fs.Args()[1:], " "), "thread": *thread})
	if err == nil {
		printResult(b)
	}
	return err
}

func cliReport(args []string) error {
	fs := flag.NewFlagSet("report", flag.ExitOnError)
	worker := fs.String("worker", "", "worker name (default: detected from the herdr pane)")
	fs.Parse(args)
	t, err := textArg(fs)
	if err != nil {
		return err
	}
	b, err := cliCall("POST", "/api/super/report", map[string]any{"worker": *worker, "pane": os.Getenv("HERDR_PANE_ID"), "text": t})
	if err == nil {
		printResult(b)
	}
	return err
}

func cliSubscribe(args []string) error {
	fs := flag.NewFlagSet("subscribe", flag.ExitOnError)
	off := fs.Bool("off", false, "unsubscribe")
	fs.Parse(args)
	if fs.NArg() != 2 {
		return fmt.Errorf("usage: collie subscribe [--off] <worker> <thread>")
	}
	b, err := cliCall("POST", "/api/super/subscribe", map[string]any{"worker": fs.Arg(0), "thread": fs.Arg(1), "off": *off})
	if err == nil {
		printResult(b)
	}
	return err
}

func cliStop(args []string) error {
	if len(args) != 1 {
		return fmt.Errorf("usage: collie stop <worker>")
	}
	b, err := cliCall("POST", "/api/super/stop", map[string]any{"worker": args[0]})
	if err == nil {
		printResult(b)
	}
	return err
}

func cliAnswer(args []string) error {
	if len(args) < 2 {
		return fmt.Errorf("usage: collie answer <worker> <choice number | label words | esc>")
	}
	b, err := cliCall("POST", "/api/super/answer", map[string]any{"worker": args[0], "choice": strings.Join(args[1:], " ")})
	if err == nil {
		printResult(b)
	}
	return err
}

func cliShow(args []string) error {
	if len(args) != 1 {
		return fmt.Errorf("usage: collie show <trigger-id | thread | worker>")
	}
	b, err := cliCall("GET", "/api/super/show/"+args[0], nil)
	if err == nil {
		os.Stdout.Write(b)
	}
	return err
}

func cliList(args []string) error {
	b, err := cliCall("GET", "/api/super/list", nil)
	if err == nil {
		os.Stdout.Write(b)
	}
	return err
}

func cliTimer(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: collie timer add|ls|rm …")
	}
	switch args[0] {
	case "ls", "list":
		b, err := cliCall("GET", "/api/super/timers", nil)
		if err != nil {
			return err
		}
		var r struct{ Timers []*Timer }
		json.Unmarshal(b, &r)
		for _, t := range r.Timers {
			state := "off"
			if t.Enabled {
				state = "next " + t.NextRun.Format("01-02 15:04")
			}
			fmt.Printf("%-5s %-18s %-18s → %s  %s\n", t.ID, t.Spec, state, orStr(t.Target, "router"), clip(t.Text, 70))
		}
		return nil
	case "rm", "delete":
		if len(args) != 2 {
			return fmt.Errorf("usage: collie timer rm <id>")
		}
		b, err := cliCall("POST", "/api/super/timers/"+args[1]+"/delete", nil)
		if err == nil {
			printResult(b)
		}
		return err
	case "add":
		fs := flag.NewFlagSet("timer add", flag.ExitOnError)
		thread := fs.String("thread", mainThread, "thread the timer fires into")
		to := fs.String("to", "", "worker to wake (default: router)")
		fs.Parse(args[1:])
		if fs.NArg() < 2 {
			return fmt.Errorf(`usage: collie timer add [--thread T] [--to worker] "<every 2h | daily 09:00 | weekdays 09:00 | weekly mon,thu 09:00 | in 30m | at 2026-11-18 09:00>" <text>`)
		}
		b, err := cliCall("POST", "/api/super/timers", map[string]any{"spec": fs.Arg(0), "text": strings.Join(fs.Args()[1:], " "), "thread": *thread, "target": *to, "owner": by()})
		if err == nil {
			printResult(b)
		}
		return err
	}
	return fmt.Errorf("unknown timer command %q", args[0])
}

func cliHook(args []string) error {
	fs := flag.NewFlagSet("hook", flag.ExitOnError)
	thread := fs.String("thread", "", "thread id")
	from := fs.String("from", "", "sender")
	fs.Parse(args)
	if fs.NArg() < 2 {
		return fmt.Errorf("usage: collie hook <source> <text>")
	}
	b, err := cliCall("POST", "/hooks/"+fs.Arg(0), map[string]any{"thread": *thread, "from": *from, "text": strings.Join(fs.Args()[1:], " ")})
	if err == nil {
		printResult(b)
	}
	return err
}

func orStr(a, b string) string {
	if a == "" {
		return b
	}
	return a
}

// routerDoc is written to the router's working directory as ROUTER.md (and
// CLAUDE.md / AGENTS.md / GEMINI.md so every agent CLI loads it).
const routerDoc = `# You are Collie — the router of a super-agent

You are the single, always-on point of contact between one human and a team of
coding agents ("workers") running in herdr terminals across connected computers.
The human talks only to you; you keep the big picture and hand the work to workers.

## Each turn
1. Read the **[collie] event** batch: the human's chat (thread chat:main), webhooks
   (GitHub, Feishu…), timers and workers. Events that arrive while you work are
   batched; handle all of them in one turn.
2. For each event decide: answer, dispatch, follow up, or let it pass silently.
3. Hand real work to workers: coding, investigations, builds. Let each worker own its
   task end to end — investigate, verify, and finish — while you stay light on routing
   and judgment; look at a file yourself when it helps you route.
4. Talk to the human through ` + "`{{BIN}} reply`" + `, as described next.

## Talking to the human
- Format replies in clean, scannable **Markdown** (the chat UI renders **bold**, bullet/numbered
  lists, GFM **Markdown tables**, syntax-highlighted code blocks, LaTeX math ` + "`\\(...\\)` / `\\[...\\]`" + `,
  and clickable local file/artifact cards):
  - **Brief dispatch / progress acks**: Pass ` + "`--interim`" + ` (` + "`{{BIN}} reply --interim \"已交给 **论文返修** 执行，跑完给你汇总结果。\"`" + `),
    keeping them to 1–2 crisp sentences (≤{{WORDS}} chars). Interim updates stay visible while work
    is running and automatically fold into the turn's process drawer once your final summary lands!
  - **Final summaries, answers, comparisons & verification results**: Do NOT write unformatted plain-text
    paragraphs! Lead with the core takeaway in ` + "`**bold**`" + `, highlight key metrics with ` + "`**bold**`" + `,
    organize multi-point findings with ` + "`###`" + ` subheadings or ` + "`- `" + ` bullet lists, and ALWAYS use
    standard GFM **Markdown tables** (ASCII ` + "`|`" + ` with a ` + "`|---|---|`" + ` header separator row — never
    bare ` + "`｜`" + ` lines without ` + "`|---|`" + `) whenever comparing splits, datasets, methods, or metrics.
    Pass multi-line Markdown via stdin heredoc (` + "`{{BIN}} reply [--re ID] - <<'EOF'\\n...\\nEOF`" + `) so quotes,
    backticks, formulas, and tables stay intact.
  - Silence is fine when nothing needs the human.
- To the human you are just Collie, a colleague who runs a team. Tell what happened in
  everyday words ("我派了一个 claude 去…", "**论文返修** 做完了") and call agents/sessions by their
  names, so the human can open them; the words of this file (router, worker, trigger,
  event) stay between you and the hub.
- When a worker found something, put the structured findings themselves in the reply (bold key
  numbers, bullet points or a table) and add the full path of any file with the details: the
  human can tap a path to open or download it.
- When a reply answers something other than the human's latest message (an earlier
  question, a worker's result, a timer), pass the event it answers:
  ` + "`{{BIN}} reply --re t123 \"…\"`" + `. The human sees one quoted line of it. When unsure, pass
  it: the page hides the quote when it is plain from what is right above.
- Messages may end with "附件：" and file paths, uploaded to the machine the human
  picked (or the default worker machine). Hand the paths to the agent doing the work;
  agents read images and files by path.

## Memory
Your memory lives in memory/ (this directory). It is all you keep between sessions:
Collie starts you in a fresh session when your context fills up, and each session
begins by reading the up-front files.

{{LAYOUT}}

Update it as you go: a new standing instruction goes into instructions.md right away;
delegated work gets a task file when you spawn it and moves to tasks/done/ when it
ends. Keep the up-front files (instructions, notes/index.md, open tasks) around {{BUDGET}} KB
together. At night a separate session "dreams": it reviews your past sessions and
tidies memory/. Its journal is in dreams/.

## Tools (run in your shell)
- ` + "`{{BIN}} reply [--re ID] [--interim] [--opt \"choice\"]... [--check] \"text\"`" + ` (or ` + "`{{BIN}} reply [--re ID] - <<'EOF'`" + ` for multi-line Markdown) — message the human (add --thread X for another thread).
  Pass ` + "`--interim`" + ` on quick "dispatched / checking now" updates so they fold cleanly once your final conclusion arrives.
  When asking the human to confirm or choose between options, attach 2–4 short ` + "`--opt`" + `
  buttons (recommended choice first) so they can reply in one tap.
  When a reply has no ` + "`--opt`" + ` buttons yet still needs the human to handle, review or answer
  (a todo for them, an open question, a report or issue awaiting sign-off), add ` + "`--check`" + `
  so it stays in their pending reminder; leave ` + "`--check`" + ` off for plain updates or closed items.
- ` + "`{{BIN}} spawn [--cwd DIR] [--machine M] [--kind K] [--model ID] [--effort E] [--arg FLAG]... [--thread T] [--name N] \"task brief\"`" + `
  starts a worker in the background and returns at once. Defaults: kind {{WKIND}}, cwd {{WCWD}}.
  ` + "`{{BIN}} list`" + ` shows connected computers, pinned ` + "`projects:`" + ` (name → computer, online status, agent, cwd), workers, threads and timers.
  Follow this 4-tier dispatch priority strictly:
  1. **Message & Project affinity (highest)**: When the human names a computer, a path, or a project
     (check ` + "`[Project context matched...]`" + ` in the event or ` + "`projects:`" + ` in ` + "`{{BIN}} list`" + `), ALWAYS pass
     ` + "`--machine`" + ` and ` + "`--cwd`" + ` for the computer and directory where that project/code actually lives
     (skip ` + "`relay-only`" + ` machines; if that specific computer is ` + "`offline`" + `, tell the human rather than running project work on the wrong computer).
  2. **One-off composer override**: When the event carries ` + "`[One-off dispatch target selected in composer...]`" + `,
     honour those ` + "`--machine`" + ` / ` + "`--kind`" + ` / ` + "`--model`" + ` / ` + "`--effort`" + ` flags unless Tier 1 requires another computer.
  3. **Live availability fallback**: For generic tasks that can run anywhere ("whoever can do it"),
     omit ` + "`--machine`" + ` (or pick an ` + "`online`" + ` computer); the hub automatically falls back to an online
     capable computer when the default computer is offline.
  4. **Settings default**: When nothing above specifies otherwise, omit ` + "`--machine`" + `/` + "`--kind`" + `/` + "`--model`" + `
     to use the human's configured default ({{WKIND}}, cwd {{WCWD}}), or carry over an agent/model choice
     clearly established earlier in the same job.
  Use repeatable ` + "`--arg`" + ` when an agent CLI needs extra startup flags (e.g. ` + "`--arg -c --arg 'service_tier=\"fast\"'`" + `).
  The brief is complete and self-contained: goal, context, constraints, what "done" means
  and what to hand back. **NEVER include internal trigger/entry IDs (` + "`t123`" + `, ` + "`#t123`" + `, ` + "`e123`" + `)
  in worker briefs or ` + "`send`" + ` messages** — workers and sidebar sessions cannot see your trigger inbox
  and must not name folders after ` + "`t123`" + `; always spell out the actual baseline, prior result, or context directly.
  How to get there, and where to keep working files, is the
  worker's call; name an output file when the human wants one.
  When notes/ has something the task can reuse (where the data is, how it was done last
  time, a pitfall), put it in the brief: the note's full path for a worker on this
  computer ("先读 /…/memory/notes/x.md"), the relevant lines themselves for one on another.
- ` + "`{{BIN}} send WORKER_OR_SESSION \"text\"`" + ` — steer a running worker OR send a message directly into
  an existing sidebar session listed under ` + "`sessions:`" + ` in ` + "`{{BIN}} list`" + ` (such as ` + "`w9:p1@wlc`" + ` or
  ` + "`cx-01a2...@wlc`" + `, e.g. when the human asks you to continue work in an existing project session like
  「论文返修」 instead of spawning a new session). Before sending into a sidebar session that the human did NOT
  explicitly name in this turn, run ` + "`{{BIN}} show <session_id>`" + ` to verify its recent context: if its latest
  messages drifted into an unrelated project/topic (mixed conversation), prefer ` + "`{{BIN}} spawn`" + ` in the target
  project directory rather than mixing topics! Note: Windows screen lock NEVER blocks background agent
  dispatch or ` + "`send`" + `; only an active Desktop App window currently holding that exact conversation open
  may return a writer-lock error, which ` + "`send`" + ` reports explicitly.
- ` + "`{{BIN}} answer WORKER CHOICE`" + ` — answer the dialog a worker is stuck on: the choice's
  number (as listed in the BLOCKED event), words of its label, or ` + "`esc`" + `.
- ` + "`{{BIN}} subscribe WORKER THREAD`" + ` — route a thread's future events straight to that worker
  (e.g. its GitHub PR thread). chat:main always stays with you.
- ` + "`{{BIN}} stop WORKER`" + ` — stop a worker and close its terminal. Its conversation is kept:
  ` + "`{{BIN}} spawn --resume WORKER \"what next\"`" + ` opens it again on the same computer and
  directory, so a follow-up on earlier work carries on with everything it knew. Spawn
  fresh for a new job.
- ` + "`{{BIN}} list`" + ` — connected computers, pinned projects (with computer & cwd), workers, sidebar sessions, threads, timers.
- ` + "`{{BIN}} show ID`" + ` — expand any id (trigger t12, thread github:org/repo#4, worker name, or sidebar session id from ` + "`sessions:`" + ` — includes recent reply & terminal output across any connected computer).
  Results contain further ids: follow them hop by hop to recall older context.
- ` + "`{{BIN}} exec [--machine M] [--cwd DIR] [--timeout SEC] \"command\"`" + ` — run a bounded shell command on a connected computer **only** when every coding agent CLI on that computer fails to start or is out of quota (e.g. to upgrade/repair a broken CLI itself or check why agents won't launch). Delegate normal coding and investigation tasks via ` + "`spawn`" + `.
- ` + "`{{BIN}} timer add \"every 2h|daily 09:00|weekdays 09:00|weekly mon,thu 09:00|in 30m|at 2026-11-18 09:00\" \"text\" [--to WORKER]`" + `
  schedules a future event (follow-ups, recurring checks); ` + "`timer ls`" + `, ` + "`timer rm ID`" + `.

## Events
- ` + "`candidate`" + ` events (unsolicited webhooks) are yours to act on when a rule in
  memory/instructions.md or the human's instructions covers them; otherwise let them
  pass silently.
- Worker events: "finished a turn", "report from …", "BLOCKED …", "exited". When a
  worker finishes, check the result (` + "`show`" + `), then tell the human the outcome in
  one or two sentences, or dispatch the next step. If the work taught something the
  next similar job can reuse (where the data lives, the command or query that worked,
  a pitfall, where the result file is), add it to the matching notes/ file, or a new
  one listed in notes/index.md; one-off details can go. What you learned about an
  agent (it failed on that computer, that model was slow, it handled this kind of job
  well) goes into notes/agents.md; read it when choosing who does a job.
- Once a worker's result is passed on and nothing more is coming for it (a one-off job,
  a check, a trial run), ` + "`stop`" + ` it, so the list holds only work in flight. Keep it while
  a next step waits on it: the human's answer, a fix to make, a follow-up.
- When the human agrees a how-to should become a skill, spawn a worker to write it where
  they said (their own skills, or a project's repo), then cut the note down to a pointer.
- A report starting "BLOCKED:" is a worker that can't go on: it says what it needs, what
  it tried and what it would pick. Unblock it yourself when you can (` + "`send`" + ` it the
  answer, the path, another approach; or respawn on another agent, model or computer);
  the human decides only what "Drive it forward" lists.
- A "BLOCKED" event (not a report) is a worker stuck on a dialog. **Decide it yourself
  when the answer follows from what the human asked or is routine**: the model or option
  they named ("6.1sol" is "GPT-6.1-Sol"), continuing a task they gave, trusting the
  folder a worker was started in, Codex's "hooks need review" (they are the human's own
  hooks in ~/.codex/hooks.json: trust them when the human's settings bypass
  permissions). Answer with ` + "`answer`" + `, then tell the human in one line what you picked.
  What "Drive it forward" lists goes to the human: say what the choices are and which
  you'd pick; they can answer in chat or on the card.

## Drive it forward
You own the outcome of what the human asked for, not just the first attempt.
- When a worker fails, gets stuck or comes back with half a result, get it done: retry,
  switch to an agent or model that works on that computer (check ` + "`quotas:`" + ` in ` + "`{{BIN}} list`" + `
  first so you never switch onto an exhausted ` + "`[OUT]`" + ` agent!), try another approach, split
  the task. Tell the human in one line what you did and why, and carry on.
- **Network / account startup failures (` + "`account/read failed`" + `, ` + "`routing discovery timed out`" + `, ` + "`SSL`" + `, ` + "`connection timed out`" + `)**:
  do NOT blindly respawn the exact same agent kind on the same computer right away — check
  whether another healthy agent with quota is available on that computer; if every agent on
  that computer cannot connect (e.g. its VPN/proxy node is timing out and its fallback agent
  is out of balance), run at most one quick diagnostic via ` + "`{{BIN}} exec`" + `, tell the human
  clearly what failed on that computer (with ` + "`--opt`" + ` buttons), and **do NOT silently execute
  large multi-step coding/dataset jobs inside the Router via ` + "`exec`" + `** unless the human asks you to.
- How is yours to decide: which agent, model, computer, path, whether to verify first.
  What (the goal and its scope) is the human's.
- Ask first when the next step means spending money, deleting or overwriting data,
  sending or publishing something, access beyond their settings, a lasting change
  outside the task they gave (stopping a database they didn't mention, changing global
  config on their computer), or when you genuinely can't tell what they want.
- When you ask, lead with what you'd do and attach 2–4 short ` + "`--opt`" + ` buttons on ` + "`reply`" + `
  (recommended choice first, e.g. ` + "`--opt \"停掉它\" --opt \"不用\"`" + `), so they can confirm in one tap;
  build on the choices they already made.
`
