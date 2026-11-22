// Collie demo mode: the real web app, driven by made-up data in the browser.
// It replaces fetch("/api/…") and EventSource before app.js loads, so every
// screen works without a hub. Nothing leaves the page.
(() => {
  "use strict";
  const now = Date.now();
  const ago = (min) => new Date(now - min * 60000).toISOString();
  const later = (min) => new Date(Date.now() + min * 60000).toISOString();

  // ───────────────────────────── the scene
  const machines = [
    { id: "", name: "devbox", os: "linux/amd64", home: "/home/alex", local: true, online: true, agents: ["claude", "codex", "agy", "gemini"] },
    { id: "macbook", name: "Mac", os: "darwin/arm64", home: "/Users/alex", online: true, version: "v0.2.30", agents: ["claude", "codex", "gemini"] },
    { id: "winbox", name: "Win", os: "windows/amd64", home: "C:\\Users\\alex", online: true, version: "v0.2.30", agents: ["claude", "codex"] },
  ];
  const projects = [
    { id: "prj_1", name: "shop-api", machine: "", cwd: "~/code/shop-api", kind: "codex" },
    { id: "prj_2", name: "shop-web", machine: "macbook", cwd: "~/code/shop-web", kind: "claude" },
  ];
  const sessionMeta = {};
  const agent = (o) => ({ workspace_label: o.name, title: "", is_agent: true, machine: o.pane_id.includes("@") ? o.pane_id.split("@")[1] : "", ...o });
  const agents = [
    agent({ pane_id: "w1:p1", workspace_id: "w1", name: "collie", kind: "claude", status: "idle", cwd: "/home/alex/.collie/router" }),
    agent({ pane_id: "w2:p1@macbook", workspace_id: "w2@macbook", name: "claude-1", kind: "claude", status: "working", cwd: "/Users/alex/code/shop-web", topic: "首页加暗色模式", run: ["opus", "high"] }),
    agent({ pane_id: "w3:p1", workspace_id: "w3", name: "codex-1", kind: "codex", status: "blocked", cwd: "/home/alex/code/shop-api", topic: "修复 /orders 分页的边界问题", run: ["gpt-6.1-sol", "high"] }),
    agent({ pane_id: "w4:p1", workspace_id: "w4", name: "agy-1", kind: "agy", status: "waiting", cwd: "/home/alex/code/infra", topic: "整理数据库迁移脚本", run: ["", ""] }),
    agent({ pane_id: "w5:p1", workspace_id: "w5", name: "fix-flaky-test", kind: "codex", status: "working", cwd: "/home/alex/code/shop-api", run: ["gpt-6.1-sol", "medium"] }),
    agent({ pane_id: "w6:p1@macbook", workspace_id: "w6@macbook", name: "release-notes", kind: "claude", status: "done", cwd: "/Users/alex/code/shop-web", run: ["sonnet", "low"] }),
  ];
  const shells = [
    { pane_id: "w7:p1", workspace_id: "w7", workspace_label: "logs", name: "logs", kind: "", status: "shell", cwd: "/home/alex/code/shop-api", title: "", is_agent: false, machine: "" },
  ];
  const state = () => ({ ok: true, agents, shells, machines, projects, session_meta: sessionMeta });

  const workers = [
    { name: "fix-flaky-test", kind: "codex", cwd: "/home/alex/code/shop-api", task: "找出 TestOrdersPagination 偶发失败的原因并修好", thread: "chat:main", pane_id: "w5:p1", workspace_id: "w5", machine: "", created_by: "collie", created_at: ago(14), status: "working", run: ["gpt-6.1-sol", "medium"] },
    { name: "release-notes", kind: "claude", cwd: "/Users/alex/code/shop-web", task: "根据 v1.3..main 的提交写 v1.4 发布说明", thread: "chat:main", pane_id: "w6:p1@macbook", workspace_id: "w6@macbook", machine: "macbook", created_by: "collie", created_at: ago(14), status: "done", last_report: "CHANGELOG 已更新：6 条改动，2 条需要注意的升级事项。", report_at: ago(6), run: ["sonnet", "low"] },
  ];
  let seq = 100;
  const entry = (role, text, o = {}) => ({ id: "e" + (++seq), role, thread: "chat:main", text, at: o.at || new Date().toISOString(), ...o });
  const entries = [
    entry("user", "订单接口的分页测试偶尔会挂，帮我查一下。顺便把 v1.4 的发布说明写了。\n\n附件：\n/home/alex/.collie/uploads/20261119/a1b2c3-ci-failure.png", { at: ago(15) }),
    entry("collie", "好，分两路并行：\n\n- **fix-flaky-test**（Codex · devbox）查 `TestOrdersPagination` 为什么偶发失败\n- **release-notes**（Claude · macbook）按 v1.3 以来的提交写发布说明\n\n有结果我再告诉你。", { at: ago(14.5) }),
    entry("event", "派出 fix-flaky-test（codex · devbox）", { tone: "spawn", ref: "fix-flaky-test", at: ago(14) }),
    entry("event", "派出 release-notes（claude · macbook）", { tone: "spawn", ref: "release-notes", at: ago(14) }),
    entry("event", "release-notes 回报：CHANGELOG 已更新：6 条改动，2 条需要注意的升级事项。", { tone: "done", ref: "release-notes", at: ago(6) }),
    entry("user", "另外首页首屏好像有点慢，有空看看。", { at: ago(5.8) }),
    entry("collie", "发布说明写好了：6 条改动，其中 **配置项改名** 和 **Node 22 起步** 需要在升级说明里提醒。要我直接开 PR 吗？详见 ~/code/shop-web/CHANGELOG.md\n\n分页测试那边还在跑，初步看是按 `created_at` 排序时同一秒内的订单顺序不稳定。首屏慢的事等它跑完我再派人看。", { at: ago(5.5), re: { worker: "release-notes", who: "release-notes", text: "根据 v1.3..main 的提交写 v1.4 发布说明" } }),
  ];
  const sup = () => ({
    router: { alive: true, status: routerStatus, pane_id: "w1:p1", kind: "claude", context: 23, rotate_at: 70, model: "sonnet" },
    entries, workers, queued: 0, queued_router: 0, paused: false, earlier: true,
    follow: { next: later(16), next_text: "看一下 fix-flaky-test 跑完没有" },
  });
  let routerStatus = "idle";

  // Conversations, by pane. Tool steps read as one quiet line in the app.
  const tool = (name, input, output, error) => ({ kind: "tool", name, input, output, error });
  const chats = {
    "w2:p1@macbook": [
      { kind: "user", text: "[image:~/.collie/images/0d3a9e5c71b2f4e8a6c1.png]\n首页加一个暗色模式：跟随系统，右上角可以手动切换，记住用户的选择。参考这张图的配色。" },
      { kind: "assistant", text: "先看看现在的样式是怎么组织的。" },
      tool("Read", "src/styles/theme.css", "48 lines"),
      tool("Grep", "color: #", "src/components/Header.tsx:12\nsrc/components/Card.tsx:31\nsrc/pages/Home.tsx:77"),
      tool("Read", "src/components/Header.tsx", "64 lines"),
      { kind: "assistant", text: "颜色大多已经走 CSS 变量，只有三处写死了。计划：\n\n1. `theme.css` 里补一套 `[data-theme=dark]` 变量，并在 `prefers-color-scheme: dark` 下默认启用\n2. 三处硬编码颜色改成变量\n3. Header 加一个切换按钮，选择存进 `localStorage`" },
      tool("Edit", "src/styles/theme.css", "+31 −2"),
      tool("Edit", "src/components/Card.tsx", "+1 −1"),
      tool("Edit", "src/pages/Home.tsx", "+2 −2"),
    ],
    "w3:p1": [
      { kind: "user", text: "/orders?page=N 在最后一页会多返回一条重复记录，修一下并补测试。" },
      tool("Read", "internal/orders/list.go", "112 lines"),
      tool("Read", "internal/orders/list_test.go", "86 lines"),
      { kind: "assistant", text: "找到了：`offset` 用的是 `page * size`，但 `page` 从 1 开始，最后一页会和前一页重叠一条。改成 `(page-1) * size`，再加一个跨页不重复的测试。" },
      tool("Edit", "internal/orders/list.go", "+3 −1"),
      tool("Edit", "internal/orders/list_test.go", "+24"),
      { kind: "assistant", text: "改好了，跑一下测试确认。" },
    ],
    "w4:p1": [
      { kind: "user", text: "migrations/ 里有不少重复和废弃的脚本，整理一下，保证从空库能一路升到最新。" },
      tool("Bash", "ls migrations | wc -l", "41"),
      tool("Bash", "make db-reset && make migrate", "ok: 41 migrations applied"),
      tool("Edit", "migrations/README.md", "+18"),
      { kind: "assistant", text: "整理完了：\n\n- 合并了 6 个只加索引的小脚本，删掉 3 个从没在生产跑过的回滚脚本\n- 从空库升级到最新验证通过（41 → 33 个文件）\n- `migrations/README.md` 写了命名规则和怎么加新脚本" },
    ],
    "w5:p1": [
      { kind: "user", text: "[collie] 找出 TestOrdersPagination 偶发失败的原因并修好。完成后 collie report。" },
      tool("Bash", "go test -run TestOrdersPagination -count=50 ./internal/orders", "--- FAIL: 3 of 50"),
      tool("Read", "internal/orders/list.go", "112 lines"),
      { kind: "assistant", text: "50 次里挂 3 次。测试在同一秒内插入多条订单，而查询只按 `created_at` 排序，同一秒的顺序数据库不保证。加上 `id` 作为第二排序键。" },
      tool("Edit", "internal/orders/list.go", "+1 −1"),
      tool("Bash", "go test -run TestOrdersPagination -count=200 ./internal/orders"),
    ],
    "w6:p1@macbook": [
      { kind: "user", text: "[collie] 根据 v1.3..main 的提交写 v1.4 发布说明。完成后 collie report。" },
      tool("Bash", "git log --oneline v1.3..main", "27 commits"),
      tool("Edit", "CHANGELOG.md", "+38"),
      { kind: "assistant", text: "CHANGELOG 已更新：6 条改动，2 条需要注意的升级事项（配置项 `api_url` 改名为 `api_base`；最低 Node 版本升到 22）。" },
    ],
    "w1:p1": [
      { kind: "user", text: "[collie] 1 个事件 · 对话 · 订单接口的分页测试偶尔会挂……" },
      tool("Bash", "collie spawn -kind codex -name fix-flaky-test \"…\"", "spawned fix-flaky-test on devbox"),
      tool("Bash", "collie spawn -kind claude -machine macbook -name release-notes \"…\"", "spawned release-notes on macbook"),
      tool("Bash", "collie reply \"好，分两路并行……\"", "ok"),
    ],
  };
  const lives = {
    "w2:p1@macbook": { status: "working", tail: "Editing src/components/Header.tsx…", meta: "42s · ↓ 1.8k tokens" },
    "w5:p1": { status: "working", tail: "Running go test -run TestOrdersPagination -count=200 ./internal/orders", meta: "18s" },
  };
  const approvals = {
    "w3:p1": {
      title: "codex 想运行一条命令",
      question: "Codex 想在 shop-api 里跑一遍测试。\n\n    go test ./internal/orders/...\n\n允许运行这条命令吗？",
      choices: [{ label: "允许", keys: ["1"] }, { label: "允许，这个会话里不再问", keys: ["2"] }, { label: "不允许，告诉它怎么做", keys: ["3"] }],
      hint: "",
      screen: "  Would you like to run the following command?\n\n  $ go test ./internal/orders/...\n\n› 1. Yes, proceed\n  2. Yes, and don't ask again for this command\n  3. No, and tell Codex what to do differently",
    },
  };
  const screens = {
    "w2:p1@macbook": "╭───────────────────────────────────────────────╮\n│ ✻ Claude Code                                 │\n│   ~/code/shop-web                             │\n╰───────────────────────────────────────────────╯\n\n> 首页加一个暗色模式：跟随系统，右上角可以手动切换，记住用户的选择。\n\n● 颜色大多已经走 CSS 变量，只有三处写死了。\n\n● Update(src/styles/theme.css)\n  ⎿  Updated with 31 additions and 2 removals\n\n● Update(src/components/Card.tsx)\n  ⎿  Updated with 1 addition and 1 removal\n\n✻ Editing src/components/Header.tsx… (42s · ↓ 1.8k tokens)\n\n╭───────────────────────────────────────────────╮\n│ >                                             │\n╰───────────────────────────────────────────────╯\n  ? for shortcuts                    opus · high",
    "w7:p1": "alex@devbox:~/code/shop-api$ tail -f logs/api.log\n12:01:44 GET /orders?page=3 200 18ms\n12:01:45 GET /orders?page=4 200 21ms\n12:01:51 POST /orders 201 34ms\n12:02:03 GET /health 200 1ms\n",
  };
  const screenOf = (id) => screens[id] || (chats[id] || []).filter((m) => m.kind !== "tool").map((m) => (m.kind === "user" ? "> " : "● ") + m.text).join("\n\n");

  const external = [
    { id: "x1", kind: "claude", pid: 4242, cwd: "/Users/alex/code/notes", app: "iTerm", started: ago(90), session: "s1", title: "周报草稿", updated: ago(20), machine: "macbook", status: "idle", can_send: false, live: true },
    { id: "cd-2", kind: "claude", pid: 4310, cwd: "/Users/alex/code/shop-web", app: "Claude 桌面版", started: ago(240), session: "s2", title: "重构购物车状态管理", updated: ago(55), machine: "macbook", status: "idle", can_send: true, live: true },
  ];
  const history = [
    { id: "h1", kind: "codex", cwd: "/home/alex/code/infra", name: "codex-3", session: "s3", ended: ago(60 * 20), title: "升级 Go 到 1.25" },
    { id: "h2", kind: "claude", cwd: "/Users/alex/code/design", name: "claude-4", session: "s4", ended: ago(60 * 30), title: "图片懒加载方案评审", machine: "macbook" },
    { id: "h3", kind: "gemini", cwd: "/Users/alex/code/docs", name: "gemini-1", session: "s5", ended: ago(60 * 48), title: "整理多语种 API 文档", machine: "macbook" },
    { id: "h4", kind: "codex", cwd: "D:\\Paper\\ieee-rev", name: "codex-4", session: "s6", ended: ago(60 * 65), title: "论文返修实验补充", machine: "winbox" },
    { id: "h5", kind: "claude", cwd: "/Users/alex/code/mobile", name: "claude-5", session: "s7", ended: ago(60 * 90), title: "优化移动端结账弹层", machine: "macbook" },
    { id: "h6", kind: "agy", cwd: "/home/alex/code/bench", name: "agy-2", session: "s8", ended: ago(60 * 120), title: "压测库存扣减并发锁" },
    { id: "h7", kind: "gemini", cwd: "/Users/alex/code/tokens", name: "gemini-2", session: "s9", ended: ago(60 * 150), title: "提炼设计系统 Token", machine: "macbook" },
  ];
  const extChats = {
    x1: [{ kind: "user", text: "根据这周的 commit 帮我写周报，分成已完成、进行中、下周计划。" }, { kind: "assistant", text: "**已完成**\n- 订单列表分页修复\n- 迁移脚本整理（41 → 33）\n\n**进行中**\n- 首页暗色模式\n\n**下周计划**\n- v1.4 发布" }],
    "cd-2": [{ kind: "user", text: "购物车的状态现在分散在三个 context 里，合并成一个 store。" }, { kind: "assistant", text: "合并完成，三个 context 换成了一个 `useCart` store，组件改动 9 处，测试全部通过。" }],
  };

  const triggers = [
    { id: "t31", source: "chat", thread: "chat:main", from: "you", action: "respond", status: "delivered", text: entries[0].text, at: ago(15), targets: ["collie"] },
    { id: "t32", source: "worker", thread: "chat:main", from: "release-notes", action: "respond", status: "delivered", text: "report from release-notes: CHANGELOG 已更新", at: ago(6), targets: ["collie"] },
    { id: "t33", source: "github", thread: "github:alex/shop-api#58", from: "octo-dev", action: "candidate", status: "delivered", text: "issue_comment: 分页最后一页有重复数据，能看一下吗？@collie", at: ago(40), targets: ["collie"] },
    { id: "t34", source: "timer", thread: "chat:main", from: "", action: "respond", status: "delivered", text: "每天 9 点：检查各个任务的进展，有卡住的告诉我", at: ago(60 * 3), targets: ["collie"] },
  ];
  const threads = [
    { id: "chat:main", triggers: triggers.filter((t) => t.thread === "chat:main"), subscribers: [], last_at: ago(6) },
    { id: "github:alex/shop-api#58", triggers: [triggers[2]], subscribers: ["codex-1"], last_at: ago(40) },
  ];
  const timers = [
    { id: "tm1", spec: "weekdays 09:00", text: "检查各个任务的进展，有卡住的告诉我", target: "", enabled: true, next_run: later(60 * 18), owner: "you" },
    { id: "tm2", spec: "in 30m", text: "看一下 fix-flaky-test 跑完没有", target: "", enabled: true, next_run: later(16), owner: "collie" },
  ];
  const memFile = (name, text, min) => ({ name, text, size: text.length * 2, mod: ago(min) });
  const memory = {
    dir: "~/.collie", loaded: 5200, budget: 8192, dreaming: false, last_dream: ago(60 * 9), next_dream: later(60 * 15), dreams: [
      { name: "2026-11-18.md", text: "从 fix-flaky-test 里记下了分页测试的坑，写进 shop-api.md；合并了两条重复的笔记\n\n- shop-api.md：同一秒内的订单按 created_at 排序不稳定，要加 id 兜底\n- agents.md：Codex 在 devbox 上跑 shop-api 的测试更稳\n- 你更喜欢先在 devbox 上跑测试，再在 Mac 上看界面（inferred）" },
    ],
    files: [
      memFile("instructions.md", "# 指令\n- 发布说明用中文，每条一句话\n- 跑测试优先用 devbox，界面相关的活放 macbook\n- 动生产数据库前先问我", 60 * 24),
      memFile("tasks/v1.4-release.md", "# v1.4 发布\n- [x] 发布说明\n- [ ] 分页测试修复（fix-flaky-test）\n- [ ] 开 PR", 6),
      memFile("notes/index.md", "# 笔记索引\n- shop-api.md：订单服务，怎么跑测试、分页的坑\n- shop-web.md：前端，怎么起、发布说明放哪\n- agents.md：哪个 agent 在哪台电脑上好用\n- machines.md：devbox 和 macbook 各装了什么", 60 * 30),
      memFile("notes/shop-api.md", "# shop-api\n- 仓库 ~/code/shop-api（devbox），Go 1.25，测试 `make test`\n- 分页测试偶发失败：同一秒内的订单按 `created_at` 排序不稳定，排序要加 `id` 兜底（fix-flaky-test 查出来的）\n- 测试数据库用 docker 起，`make db`；跑完 `make db-down`\n- CI 只跑 `./internal/...`（截至 11-18）", 60 * 9),
      memFile("notes/shop-web.md", "# shop-web\n- 仓库 ~/code/shop-web（macbook），Vite + React，`pnpm dev`\n- 发布说明写在 CHANGELOG.md，按「需要注意 / 改动」两段", 60 * 30),
      memFile("notes/agents.md", "# agent 经验\n- Codex 在 devbox 上跑 shop-api 的测试更稳，Claude 偶尔会改错测试本身\n- 界面相关的活给 macbook 上的 Claude\n- macbook 上没装 Antigravity", 60 * 9),
      memFile("notes/machines.md", "# 电脑\n- devbox：Linux，claude / codex / agy 都有\n- macbook：claude、codex；周末常关机", 60 * 24 * 3),
      memFile("messages.md", "最近说过的话（自动记录）", 5),
    ],
  };
  const settings = {
    bin: "collie", hook_key: "demo-key", router_dir: "~/.collie/router",
    policies: [{ source: "chat", action: "respond" }, { source: "github", action: "candidate" }, { source: "timer", action: "respond" }],
    settings: { router_kind: "claude", router_model: "sonnet", worker_model: "", worker_effort: "", worker_kind: "codex", worker_cwd: "~/code", worker_machine: "", notify_level: "normal", stall_minutes: 20, reply_chars: 400, rotate_pct: 70, dream_at: "04:00", ask_permissions: false },
  };
  const models = {
    claude: { models: [{ id: "opus", label: "Opus", efforts: ["low", "medium", "high", "max"] }, { id: "sonnet", label: "Sonnet", efforts: ["low", "medium", "high"] }, { id: "haiku", label: "Haiku" }], default: "sonnet", efforts: ["low", "medium", "high", "max"], default_effort: "" },
    codex: { models: [{ id: "gpt-6.1-sol", label: "GPT-6.1-Sol", efforts: ["low", "medium", "high", "xhigh"] }, { id: "gpt-6.1-mini", label: "GPT-6.1-Mini" }], default: "gpt-6.1-sol", efforts: ["low", "medium", "high", "xhigh"], default_effort: "medium" },
    agy: { models: [{ id: "gemini-4-pro", label: "Gemini 4 Pro" }], default: "gemini-4-pro", efforts: [] },
    gemini: { models: [{ id: "gemini-2.5-pro", label: "gemini-2.5-pro" }, { id: "gemini-3.5-flash", label: "gemini-3.5-flash" }], default: "auto", efforts: [] },
  };

  // ───────────────────────────── streams
  const streams = new Set();
  class FakeES {
    constructor(url) {
      this.url = String(url); this.readyState = 0; this.ls = {}; this.onopen = null; this.onerror = null; this.onmessage = null;
      streams.add(this);
      setTimeout(() => { if (this.readyState === 2) return; this.readyState = 1; this.onopen?.({}); this.prime(); }, 30);
    }
    addEventListener(t, f) { (this.ls[t] ||= []).push(f); }
    removeEventListener(t, f) { this.ls[t] = (this.ls[t] || []).filter((x) => x !== f); }
    close() { this.readyState = 2; streams.delete(this); }
    emit(t, data) { if (this.readyState !== 1) return; const e = { type: t, data: JSON.stringify(data) }; (this.ls[t] || []).forEach((f) => f(e)); }
    get path() { return new URL(this.url, location.href).pathname.replace(/^.*?\/api\//, "/api/"); }
    prime() {
      const p = this.path, m = /^\/api\/(panes|external)\/([^/]+)\/(chat|stream)$/.exec(p);
      if (p === "/api/events") { this.emit("state", state()); this.emit("super", sup()); return; }
      if (!m) return;
      const id = decodeURIComponent(m[2]);
      if (m[1] === "external") { this.emit("patch", { base: 0, from: 0, msgs: extChats[id] || [] }); return; }
      if (m[3] === "chat") { this.emit("patch", { base: 0, from: 0, msgs: chats[id] || [] }); this.emit("live", liveOf(id)); return; }
      this.emit("frame", { cols: 96, rows: 30, text: screenOf(id) });
    }
  }
  FakeES.CONNECTING = 0; FakeES.OPEN = 1; FakeES.CLOSED = 2;
  window.EventSource = FakeES;
  const liveOf = (id) => {
    const a = agents.find((x) => x.pane_id === id);
    if (a?.status === "blocked" && approvals[id]) return { status: "blocked", approval: approvals[id] };
    return { status: a?.status || "idle", ...(a?.status === "working" ? lives[id] || {} : {}) };
  };
  const pushAll = () => {
    for (const s of streams) {
      if (s.path === "/api/events") { s.emit("state", state()); s.emit("super", sup()); }
      const m = /^\/api\/panes\/([^/]+)\/chat$/.exec(s.path);
      if (m) { const id = decodeURIComponent(m[1]); s.emit("patch", { base: 0, from: 0, msgs: chats[id] || [] }); s.emit("live", liveOf(id)); }
    }
  };
  const setStatus = (id, st) => { const a = agents.find((x) => x.pane_id === id); if (a) a.status = st; const w = workers.find((x) => x.pane_id === id); if (w) w.status = st; };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // ───────────────────────────── scripted replies
  let demoN = 0;
  function collieSay(text, re) {
    const q = re && entries.find((e) => e.id === re);
    const mine = entry("user", text, q ? { re: { entry: q.id, who: "Collie", text: q.text } } : {});
    entries.push(mine); routerStatus = "working"; pushAll(); collieAnswer(text);
    return mine.id;
  }
  async function collieAnswer(text) {
    await wait(1400);
    const name = "task-" + ["deps", "tests", "docs", "perf"][demoN++ % 4];
    entries.push(entry("collie", `收到。这件事我交给 **${name}**（Codex · devbox）去做，它会在 \`~/code/shop-api\` 里动手；有结果或需要你拍板时我再说。`));
    const pane = "w" + (20 + demoN) + ":p1";
    agents.push(agent({ pane_id: pane, workspace_id: pane.split(":")[0], name, kind: "codex", status: "working", cwd: "/home/alex/code/shop-api", run: ["gpt-6.1-sol", "medium"] }));
    workers.push({ name, kind: "codex", cwd: "/home/alex/code/shop-api", task: text, thread: "chat:main", pane_id: pane, workspace_id: pane.split(":")[0], machine: "", created_by: "collie", created_at: new Date().toISOString(), status: "working", run: ["gpt-6.1-sol", "medium"] });
    chats[pane] = [{ kind: "user", text: "[collie] " + text }, tool("Bash", "rg -n TODO --stats", "37 matches in 12 files")];
    lives[pane] = { status: "working", tail: "Reading the code", meta: "12s" };
    entries.push(entry("event", `派出 ${name}（codex · devbox）`, { tone: "spawn", ref: name }));
    routerStatus = "idle"; pushAll();
    await wait(5000);
    chats[pane].push({ kind: "assistant", text: "看完了，结论和改动已经写进报告。" });
    setStatus(pane, "done");
    workers.find((w) => w.name === name).last_report = "完成：发现 2 处问题，已修复并补了测试。";
    entries.push(entry("event", `${name} 回报：完成：发现 2 处问题，已修复并补了测试。`, { tone: "done", ref: name }));
    routerStatus = "working"; pushAll();
    await wait(1200);
    entries.push(entry("collie", `${name} 做完了：发现 2 处问题，都已修复并补了测试，改动在 \`shop-api\` 的工作区里。要我开 PR 吗？`));
    routerStatus = "idle"; pushAll();
  }
  async function promptPane(id, text) {
    (chats[id] ||= []).push({ kind: "user", text });
    setStatus(id, "working"); lives[id] = { status: "working", tail: "Thinking…", meta: "3s" }; pushAll();
    await wait(1800);
    chats[id].push(tool("Read", "README.md", "52 lines"));
    pushAll();
    await wait(1600);
    chats[id].push({ kind: "assistant", text: "好的，已经按你说的改好了。这是演示模式，真实环境里这里会是 agent 的回答。" });
    setStatus(id, "done"); pushAll();
  }
  async function answerApproval(id) {
    delete approvals[id];
    setStatus(id, "working"); lives[id] = { status: "working", tail: "Running go test ./internal/orders/...", meta: "4s" };
    chats[id].push(tool("Bash", "go test ./internal/orders/...", "ok  \tshop-api/internal/orders\t0.412s"));
    pushAll();
    await wait(2600);
    chats[id].push({ kind: "assistant", text: "测试全部通过。改动：`list.go` 的 offset 修正，`list_test.go` 加了跨页不重复的用例。" });
    setStatus(id, "done"); pushAll();
  }

  const changelog = "# v1.4\n\n## 需要注意\n\n- **配置项改名**：`cart.ttl` 改为 `cart.expire_after`，旧名字还能用，下个版本移除。\n- **Node 22 起步**：构建和运行都需要 Node 22 以上。\n\n## 改动\n\n- 订单列表支持按状态筛选\n- 结算页显示预计送达时间\n- 修复优惠券在购物车为空时报错\n- 商品图片改为懒加载，首屏快了约 30%\n- 搜索框支持拼音\n- 依赖升级：react 19.2、vite 7\n";

  // ───────────────────────────── the API
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const u = new URL(typeof input === "string" ? input : input.url, location.href);
    const i = u.pathname.indexOf("/api/");
    if (i < 0) return realFetch(input, init);
    const p = u.pathname.slice(i), q = u.searchParams, method = (init.method || "GET").toUpperCase();
    let body = {};
    try { body = init.body ? JSON.parse(init.body) : {}; } catch {}
    await wait(60);
    let m;
    if (p === "/api/session") return json({ ok: true });
    if (p === "/api/state") return json(state());
    if (p === "/api/super") return json(sup());
    if (p === "/api/super/settings") return json(settings);
    if (p === "/api/super/seen") return json({ ok: true });
    if (p === "/api/super/earlier") { // yesterday's chat, made up
      const y = (h, m) => { const d = new Date(Date.now() - 864e5); d.setHours(h, m, 0, 0); return d.toISOString(); };
      return json({ more: false, entries: [
        { id: "e0a", role: "user", thread: "chat:main", text: "明天早上提醒我看一下 v1.4 的发布清单。", at: y(18, 20) },
        { id: "e0b", role: "collie", thread: "chat:main", text: "好，明早 9:00 提醒你。", at: y(18, 20) },
      ] });
    }
    if (p === "/api/super/lark") return json({ ready: true, who: "Alex" });
    if (p === "/api/super/triggers") return json({ triggers, threads });
    if (p === "/api/super/timers") {
      if (method === "POST") timers.push({ id: "tm" + (++seq), spec: body.spec, text: body.text, target: body.target, enabled: true, next_run: later(60), owner: "you" });
      return json({ timers });
    }
    if (p === "/api/super/memory") return json(memory);
    if (p === "/api/super/say") return json({ ok: true, entry: collieSay(body.text || "", body.re) });
    if (p === "/api/external") return json({ sessions: external });
    if (p === "/api/history") return json({ sessions: history });
    if (p === "/api/hubs") return json({ hubs: [] });
    if (p === "/api/version") return json({ version: "v0.2.5", latest: "v0.2.5", outdated: [] });
    if (p === "/api/local-app") return json({ url: "" });
    if (p === "/api/models") return json(models[q.get("kind")] || { models: [], efforts: [] });
    if (p === "/api/file" && /images\/0d3a9e5c71b2f4e8a6c1\.png$|uploads\/.*\.png$/.test(q.get("path") || "")) {
      const b = await (await realFetch(new URL("../img/hero-dark.png", location.href))).blob();
      return new Response(b, { headers: { "X-File-Kind": "image", "X-File-Size": String(b.size), "X-File-Path": encodeURIComponent(q.get("path")) } });
    }
    if (p === "/api/file") {
      if (q.get("machine") !== "macbook" || !/CHANGELOG\.md$/.test(q.get("path") || "")) return json({ error: "找不到这个文件" }, 404);
      return new Response(changelog, { headers: { "X-File-Kind": "text", "X-File-Size": String(new Blob([changelog]).size), "X-File-Path": encodeURIComponent("~/code/shop-web/CHANGELOG.md") } });
    }
    if (p === "/api/dirs") {
      const mId = q.get("machine") || "";
      const isWin = mId === "winbox";
      const home = isWin ? "C:\\Users\\alex" : mId === "macbook" ? "/Users/alex" : "/home/alex";
      if (method === "POST") {
        const par = (body.parent || "~").replace(/[\\/]+$/, "");
        const disp = (par === "/" ? "" : par) + (isWin && !par.startsWith("~") ? "\\" : "/") + body.name;
        return json({ ok: true, path: disp.replace(/^~/, home), display: disp, name: body.name });
      }
      const raw = (q.get("path") || "~").trim();
      const tree = isWin
        ? { "~": ["Desktop", "Documents", "Projects"], "C:\\": ["Users", "Program Files", "Work"], "D:\\": ["Paper", "Datasets"], "D:\\Paper": ["ieee-rev", "figures"] }
        : { "~": ["code", "docs", "scripts"], "~/code": ["shop-api", "shop-web", "infra", "notes"], "~/code/shop-api": ["cmd", "internal", "migrations"], "~/code/shop-web": ["src", "public"], "/": ["home", "opt", "var"] };
      const disp = raw.startsWith(home) ? "~" + raw.slice(home.length) : raw;
      const dirs = tree[disp] || tree[raw] || [];
      const parent = disp === "~" ? (isWin ? "C:\\Users" : mId === "macbook" ? "/Users" : "/home") : disp.includes("/") ? disp.slice(0, disp.lastIndexOf("/")) || "/" : "/";
      return json({ path: disp.replace(/^~/, home), display: disp, parent, home, sep: isWin ? "\\" : "/", drives: isWin ? ["C:\\", "D:\\"] : [], dirs });
    }
    if (p === "/api/projects") {
      if (method === "POST") {
        const np = { id: "prj_" + (++seq), name: body.name || (body.cwd || "").split(/[\\/]/).pop() || "新项目", machine: body.machine || "", cwd: body.cwd || "~", kind: body.kind || "claude" };
        projects.push(np);
        pushAll();
        return json({ ok: true, project: np });
      }
      return json({ projects });
    }
    if (p === "/api/projects/sync") {
      return json({ ok: true, added: 0, projects });
    }
    if ((m = /^\/api\/projects\/([^/]+)\/update$/.exec(p))) {
      const prj = projects.find((x) => x.id === decodeURIComponent(m[1]));
      if (prj) Object.assign(prj, body);
      pushAll();
      return json({ ok: true, project: prj });
    }
    if ((m = /^\/api\/projects\/([^/]+)\/delete$/.exec(p))) {
      const idx = projects.findIndex((x) => x.id === decodeURIComponent(m[1]));
      if (idx >= 0) projects.splice(idx, 1);
      pushAll();
      return json({ ok: true });
    }
    if (p === "/api/devices") return json({
      devices: [
        { id: "macbook", kind: "machine", name: "Mac", os: "darwin/arm64", online: true, home: "/Users/alex", version: "v0.2.34", agents: ["claude", "codex", "gemini"], created_at: ago(60 * 24 * 3), last_seen: ago(0) },
        { id: "winbox", kind: "machine", name: "Win", os: "windows/amd64", online: true, home: "C:\\Users\\alex", version: "v0.2.34", agents: ["claude", "codex"], created_at: ago(60 * 24 * 2), last_seen: ago(0) },
      ],
      hub: { name: "devbox", home: "/home/alex", os: "linux/amd64", herdr: true, version: "v0.2.34", agents: ["claude", "codex", "agy", "gemini"] }, addresses: ["http://192.168.1.20:7788"], latest: "v0.2.34",
    });
    if (p === "/api/pair/new") return json({ code: "DEMO2026", expires: new Date(Date.now() + 600000).toISOString(), kind: body.kind });
    if ((m = /^\/api\/panes\/([^/]+)\/ask$/.exec(p))) { const id = decodeURIComponent(m[1]); return json(approvals[id] && agents.find((a) => a.pane_id === id)?.status === "blocked" ? { asking: true, approval: approvals[id] } : { asking: false }); }
    if ((m = /^\/api\/panes\/([^/]+)\/(keys|text)$/.exec(p))) {
      const id = decodeURIComponent(m[1]);
      if (approvals[id]) answerApproval(id); else if (m[2] === "text" && body.text) promptPane(id, body.text);
      return json({ ok: true });
    }
    if ((m = /^\/api\/agents\/([^/]+)\/prompt$/.exec(p))) {
      const t = decodeURIComponent(m[1]), id = agents.find((a) => a.pane_id === t || a.name === t)?.pane_id || t;
      promptPane(id, body.text || body.prompt || ""); return json({ ok: true });
    }
    if ((m = /^\/api\/panes\/([^/]+)\/(earlier|last)$/.exec(p))) return json({ messages: [], earlier: 0, text: "" });
    if (p === "/api/agents" && method === "POST") {
      const n = agents.length + 10, pane = `w${n}:p1${body.machine ? "@" + body.machine : ""}`;
      const kind = body.kind === "antigravity" ? "agy" : body.kind;
      agents.push(agent({ pane_id: pane, workspace_id: pane.split(":")[0], name: body.name || `${kind}-${n}`, kind, status: body.prompt ? "working" : "idle", cwd: (body.cwd || "~/code").replace(/^~/, body.machine ? "/Users/alex" : "/home/alex"), run: [body.model || "", body.effort || ""] }));
      chats[pane] = [];
      if (body.prompt) promptPane(pane, body.prompt); else pushAll();
      return json({ pane_id: pane, workspace_id: pane.split(":")[0] });
    }
    if (method === "POST") return json({ ok: true });
    return json({});
  };

  // The demo opens light unless this visitor picked a theme in 偏好设置.
  try { if (localStorage.getItem("collie.theme") === null) { localStorage.setItem("collie.theme", JSON.stringify("light")); document.documentElement.dataset.theme = "light"; } } catch {}

  // A demo has nothing to notify about: never ask for the permission.
  try { if (window.Notification) Object.defineProperty(Notification, "permission", { get: () => "denied" }); Notification.requestPermission = async () => "denied"; } catch {}

  // ───────────────────────────── a quiet badge: this is a demo
  if (!/[?&]clean\b/.test(location.search)) {
    addEventListener("DOMContentLoaded", () => {
      const b = document.createElement("a");
      b.href = "../"; b.className = "demo-badge"; b.textContent = "演示 · 数据是虚构的 · 返回主页";
      document.body.append(b);
    });
  }
})();
