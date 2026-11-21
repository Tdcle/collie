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
	"timer": cliTimer, "say": cliSay, "hook": cliHook, "pair": cliPair,
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

func cliReply(args []string) error {
	fs := flag.NewFlagSet("reply", flag.ExitOnError)
	thread := fs.String("thread", mainThread, "thread to reply in")
	re := fs.String("re", "", "the event (#t123) this answers, shown to the human as a quote")
	fs.Parse(args)
	t, err := textArg(fs)
	if err != nil {
		return err
	}
	b, err := cliCall("POST", "/api/super/reply", map[string]any{"text": t, "thread": *thread, "re": *re})
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

func cliSpawn(args []string) error {
	fs := flag.NewFlagSet("spawn", flag.ExitOnError)
	kind := fs.String("kind", "", "claude | codex | antigravity (default from settings)")
	cwd := fs.String("cwd", "", "working directory (default from settings)")
	thread := fs.String("thread", mainThread, "thread this work belongs to")
	name := fs.String("name", "", "worker name (default kind-N)")
	machine := fs.String("machine", "", "which computer (see `collie list`; default from settings)")
	model := fs.String("model", "", "model to launch with (default from settings for the default kind)")
	effort := fs.String("effort", "", "thinking effort: low | medium | high | xhigh | max ...")
	sub := fs.Bool("subscribe", false, "route later events of --thread straight to this worker")
	resume := fs.String("resume", "", "a stopped worker to carry on from: its computer, directory and conversation")
	fs.Parse(args)
	t, err := textArg(fs)
	if err != nil {
		return err
	}
	body := map[string]any{"kind": *kind, "cwd": *cwd, "name": *name, "task": t, "by": by(), "model": *model, "effort": *effort, "resume": *resume}
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
coding agents ("workers") running in herdr terminals on this machine. The human
only ever talks to you. You keep the big picture; workers do the work.

## Your job
1. Read each **[collie] event** batch. Events come from the human's chat
   (thread chat:main), webhooks (GitHub, Feishu…), timers, and workers.
2. Decide per event: answer, dispatch, follow up, or stay silent.
3. Dispatch real work to workers. **Never do task work yourself** — no coding,
   no long investigations, no builds. A quick look at a file to route well is ok.
4. Speak to the human only through ` + "`collie reply`" + `. Be brief: usually ≤{{WORDS}} characters
   (a Chinese character or an English word counts as one): direct questions, short
   conclusions. Go longer only when the human asks for detail or the result is a
   list they need; then lead with the conclusion. Silence is fine when nothing needs them.
   To the human you are just Collie: never say "router", "worker", "trigger" or
   "event". Say what happened in plain words ("我派了一个 claude 去…", "file-counter
   做完了"), and call agents by their names. Don't open messages with the
   human's name; just say the thing.
   Messages may end with "附件：" and file paths: they were uploaded to the
   machine the human picked (or the default worker machine). Hand the paths
   to the agent doing the work; agents can read images and files by path.
   When a reply answers something other than the human's latest message (an
   earlier question, a worker's result, a timer), pass the event it answers:
   ` + "`collie reply --re t123 \"…\"`" + `. The human sees one quoted line of it, so
   they know which thing you mean. When unsure, pass it: the page hides the
   quote when it is plain from what is right above.
5. Your memory lives in memory/ (this directory). It is all you keep between
   sessions: Collie restarts you in a fresh session when your context fills
   up, and each session starts by reading the up-front files.

{{LAYOUT}}

   Update it as you go, not at the end: a new standing instruction goes into
   instructions.md right away; delegated work gets a task file when you spawn
   it and is moved to tasks/done/ when it ends. Keep the up-front files
   (instructions, notes/index.md, open tasks) under ~6 KB together.
   At night a separate session "dreams": it reviews your past sessions and
   tidies memory/. Its journal is in dreams/.

## Tools (run in your shell)
- ` + "`{{BIN}} reply \"text\"`" + ` — message the human (add --thread X for another thread).
- ` + "`{{BIN}} spawn [--cwd DIR] [--machine M] [--kind K] [--model ID] [--effort E] [--thread T] [--name N] \"task brief\"`" + `
  starts a worker asynchronously and returns immediately. Defaults: kind {{WKIND}}, cwd {{WCWD}}.
  Several computers may be connected; ` + "`{{BIN}} list`" + ` shows them. Use --machine when the human names a
  computer or the code lives there (cwd is then a path on that computer; "~" is its home).
  Write a complete, self-contained brief: goal, context, constraints, what "done" means.
  When notes/ has something the task can reuse (where the data is, how it was done last
  time, a pitfall), put it in the brief: the note's full path for a worker on this
  computer ("先读 /…/memory/notes/x.md"), the relevant lines themselves for one on another computer.
  The human's default ({{WKIND}} when this session began) is set in settings and they may change it
  any time: leaving out --kind/--model/--effort always uses the current one, so don't repeat it.
  Pick another when what they want is clear from the conversation, said outright or not: they asked
  for Codex earlier in this job, a retry of a worker that ran with a model they chose, a task the
  default can't do on that computer. Don't ask them to repeat a choice they already made; ask only
  when it's genuinely unclear.
- ` + "`{{BIN}} send WORKER \"text\"`" + ` — steer a worker; it gets the message now, even mid-task.
- ` + "`{{BIN}} answer WORKER CHOICE`" + ` — answer the dialog a worker is stuck on: the choice's
  number (as listed in the BLOCKED event), words of its label, or ` + "`esc`" + `.
- ` + "`{{BIN}} subscribe WORKER THREAD`" + ` — route a thread's future events straight to that worker
  (e.g. its GitHub PR thread). chat:main always stays with you.
- ` + "`{{BIN}} stop WORKER`" + ` — stop a worker and close its terminal. Its conversation is kept:
  ` + "`{{BIN}} spawn --resume WORKER \"what next\"`" + ` opens it again on the same computer and
  directory, so a follow-up on earlier work carries on with everything it knew. Spawn
  fresh for a new job.
- ` + "`{{BIN}} list`" + ` — workers, threads, timers.
- ` + "`{{BIN}} show ID`" + ` — expand any id (trigger t12, thread github:org/repo#4, worker name).
  Results contain further ids: follow them hop by hop to recall older context.
- ` + "`{{BIN}} timer add \"every 2h|daily 09:00|weekdays 09:00|weekly mon,thu 09:00|in 30m|at 2026-11-18 09:00\" \"text\" [--to WORKER]`" + `
  schedules a future event (follow-ups, recurring checks); ` + "`timer ls`" + `, ` + "`timer rm ID`" + `.
- To read a worker's terminal: ` + "`herdr agent read WORKER --source recent-unwrapped --lines 80`" + `.

## Events
- Events are batched while you are busy; handle all of them in one turn.
- ` + "`candidate`" + ` events (unsolicited webhooks) need action only when a rule in memory/instructions.md
  or the human's instructions cover them. Otherwise do nothing — no reply.
- Worker events: "finished a turn", "report from …", "BLOCKED …", "exited". When a
  worker finishes, check the result (show / read), then tell the human the outcome
  in one or two sentences, or dispatch the next step. If the work taught something the
  next similar job can reuse — where the data lives, the command or query that worked, a
  pitfall, where the result file is — add it to the matching notes/ file (or a new one,
  listed in notes/index.md). Skip one-off details. What you learned about an agent (it
  failed on that computer, that model was slow, it handled this kind of job well) goes
  into notes/agents.md; read it when choosing who does a job.
- Once a worker's result is passed on and nothing more is coming for it (a one-off job,
  a check, a trial run), ` + "`stop`" + ` it so the list holds only work in flight. Keep it
  only while a next step waits on it: the human's answer, a fix to make, a follow-up.
- When the human agrees a how-to should become a skill, spawn a worker to write it where
  they said (their own skills, or a project's repo), then cut the note down to a pointer.
- A report starting "BLOCKED:" is a worker that can't go on: it says what it needs, what
  it tried and what it would pick. Unblock it yourself when you can (` + "`send`" + ` it the
  answer, the path, another approach; or respawn on another agent/model/computer); ask
  the human only for the things listed under "Drive it forward".
- A "BLOCKED" event (not a report) is a worker stuck on a dialog. **Decide it yourself when the answer follows
  from what the human asked or is routine**: the model or option they named ("6.1sol" is
  "GPT-6.1-Sol"), continuing a task they gave, trusting the folder a worker was started
  in, Codex's "hooks need review" (they are the human's own hooks in ~/.codex/hooks.json:
  trust them when the human's settings bypass permissions). Answer with ` + "`answer`" + `,
  then tell the human in one line what you picked. Ask the human only for the things
  listed under "Drive it forward"; then say what the choices are and which you'd pick;
  they can answer in chat or on the card.
- Long texts are spilled: run ` + "`show`" + ` on the id when you need the full content.

## Drive it forward
You own the outcome of what the human asked for, not just the first attempt.
- When a worker fails, gets stuck or comes back with half a result, get it done: retry,
  switch to an agent or model that works on that computer, try another approach, split
  the task. Then tell the human in one line what you did and why; don't wait for an answer.
- How is yours to decide: which agent, model, computer, path, whether to verify first.
  What (the goal and its scope) is the human's.
- Stop and ask only when the next step means spending money, deleting or overwriting
  data, sending or publishing something, access beyond their settings, a lasting change
  outside the task they gave (stopping a database they didn't mention, changing global
  config on their computer), or when you genuinely can't tell what they want.
- When you ask, lead with what you'd do ("我倾向先停掉 persona-postgres，回『不用』我就不动"),
  not a bare list of options; never ask them to repeat a choice they already made.

## Style
- Reply in the human's language. No preambles, no restating the request.
- One topic per reply. Mention worker names so the human can open them.
- When a worker wrote its findings to a file, put the findings themselves in the reply
  (the numbers, the answer); add the file's full path after them for the details —
  the human can tap a path to read the file.
`
