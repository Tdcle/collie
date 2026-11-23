// Runtime smoke test for Collie's zero-build frontend (highlight.js + quota.js + artifacts.js + app.js).
// Catches Temporal Dead Zone (TDZ) ReferenceErrors, missing globals, CSS class collisions,
// and render crashes across login, #/collie, CSV/PDF artifact cards, quick-reply options,
// pending confirmation bar, offline syntax highlighting, and quota popover.
import fs from "node:fs";
import vm from "node:vm";

function runScenario(authed) {
  const listeners = new Map();
  const makeEl = (id = "") => {
    const el = {
      id, hidden: true, value: "", textContent: "", innerHTML: "", title: "", href: "", open: false,
      dataset: {}, style: { setProperty() {} },
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      children: [], childElementCount: 0, scrollTop: 0, scrollHeight: 0, clientHeight: 600, offsetWidth: 260,
      selectedOptions: [],
      addEventListener(ev, fn) {
        const k = `${id}:${ev}`;
        if (!listeners.has(k)) listeners.set(k, []);
        listeners.get(k).push(fn);
      },
      removeEventListener() {}, append() {}, after() {}, remove() {}, insertAdjacentHTML() {},
      setAttribute() {}, removeAttribute() {}, focus() {}, select() {}, click() {},
      scrollTo() {},
      getBoundingClientRect() { return { left: 0, top: 0, right: 900, bottom: 40, width: 80, height: 32 }; },
      querySelector: (s) => getEl(s),
      querySelectorAll: () => [],
      closest: () => null,
      showModal() { this.open = true; },
      close() { this.open = false; },
    };
    el.parentElement = el;
    el.parentNode = el;
    return el;
  };
  const els = new Map();
  const getEl = (s) => {
    if (!els.has(s)) els.set(s, makeEl(s));
    return els.get(s);
  };

  const ctx = {
    console,
    setTimeout: (fn) => { Promise.resolve().then(fn); return 1; },
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    requestAnimationFrame: (fn) => { fn(); return 1; },
    cancelAnimationFrame() {},
    URL, URLSearchParams, Blob, TextEncoder, TextDecoder, CSS: { escape: (s) => s },
    innerWidth: 1280, innerHeight: 800, isSecureContext: true,
    navigator: { platform: "MacIntel", clipboard: { writeText: async () => {} } },
    localStorage: { getItem: () => null, setItem() {} },
    location: {
      href: "https://101.200.80.58/#/collie?quotas=1",
      origin: "https://101.200.80.58",
      pathname: "/",
      search: "",
      hash: "#/collie?quotas=1",
      hostname: "101.200.80.58",
      protocol: "https:",
      replace(h) { this.hash = h; },
      reload() {},
    },
    history: { replaceState() {} },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    MutationObserver: class { observe() {} },
    EventSource: class { addEventListener() {} close() {} },
    Event: class { constructor(t) { this.type = t; } },
    dispatchEvent() {},
    addEventListener() {},
    document: {
      hidden: false, title: "Collie", body: makeEl("body"), documentElement: makeEl("html"), activeElement: null,
      hasFocus: () => true,
      getElementById: (id) => getEl("#" + id),
      querySelector: (s) => getEl(s),
      querySelectorAll: () => [],
      createElement: (t) => makeEl(t),
      addEventListener() {},
    },
    fetch: async (u) => {
      if (!authed && String(u).includes("/api/session")) {
        return { ok: false, status: 401, statusText: "Unauthorized", headers: { get: () => "" }, json: async () => ({ error: "unauthorized" }) };
      }
      if (String(u).includes("/api/quotas")) {
        return {
          ok: true, status: 200, headers: { get: () => "" },
          json: async () => ({
            updated_at: new Date().toISOString(),
            machines: [{
              id: "mac", name: "Mac", os: "darwin/arm64", online: true,
              agents: [{ kind: "codex", status: "ok", provider: "OpenAI", plan: "Pro Lite", reset_credits: 2, buckets: [{ id: "w", label: "每周额度", remaining_pct: 100 }] }],
            }],
          }),
        };
      }
      if (String(u).includes("/api/super")) {
        const now = new Date().toISOString();
        return {
          ok: true, status: 200, headers: { get: () => "" },
          json: async () => ({
            router: { alive: true, status: "idle", kind: "codex", machine: "mac" },
            entries: [
              { id: "e1", role: "user", text: "看看上游新更新了什么，还有 https://arxiv.org/abs/2405.06803 这篇\n\n参考链接：\n- [Comparing main...lihuanyu0w0:collie:main · Tdcle/collie](https://github.com/Tdcle/collie/compare/main...lihuanyu0w0%3Acollie%3Amain)", at: now },
              { id: "e1a", role: "collie", interim: true, text: "已派 **sfd-eval** 去拉取对比，跑完向你汇总。", at: now },
              { id: "e1b", role: "event", tone: "spawn", ref: "sfd-eval", text: "sfd-eval 启动：检查上游更新", at: now },
              { id: "e1c", role: "event", tone: "done", ref: "sfd-eval", text: "sfd-eval 回报：已完成对比", at: now },
              {
                id: "e2",
                role: "collie",
                text: "**结论：共 3 项核心更新**。\n\n| 模块 | 变化 |\n|---|---|\n| 路由 | 纯原型加速 |\n\n推理时，若第 \\(d\\) 个域的距离为 \\(r_{d1},r_{d2},r_{d3}\\)，则按下式选域：\n\n\\[\na_d=\\frac{1}{3}\\sum_{j=1}^{3}\\frac{1}{r_{dj}+10^{-6}},\\qquad p_d=\\frac{a_d}{\\sum_b a_b},\\qquad \\hat d=\\arg\\max_d p_d.\n\\]\n\n已生成报告 ~/Desktop/ablation_report.pdf 和 [逐轮数据快照](<C:/Users/26422/Documents/SFD-Net 2/epochs.csv>)\n```go\nfunc main() { return }\n```\n是否继续启动评估？",
                options: ["继续启动", "先不跑"],
                at: now,
              },
            ],
            pending: [
              { id: "e2", at: now, summary: "是否继续启动评估？", options: ["继续启动", "先不跑"] },
            ],
            workers: [],
          }),
        };
      }
      return {
        ok: true, status: 200, headers: { get: () => "" },
        json: async () => ({
          ok: true,
          machines: [{ id: "mac", name: "Mac", os: "darwin/arm64", online: true, agents: ["codex"] }],
          agents: [], shells: [], projects: [], sessions: [], hubs: [], results: [],
        }),
      };
    },
  };
  ctx.window = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync("web/highlight.js", "utf8"), ctx, { filename: "web/highlight.js" });
  vm.runInContext(fs.readFileSync("web/math.js", "utf8"), ctx, { filename: "web/math.js" });
  vm.runInContext(fs.readFileSync("web/quota.js", "utf8"), ctx, { filename: "web/quota.js" });
  vm.runInContext(fs.readFileSync("web/artifacts.js", "utf8"), ctx, { filename: "web/artifacts.js" });
  vm.runInContext(fs.readFileSync("web/app.js", "utf8"), ctx, { filename: "web/app.js" });
  return { getEl };
}

// 1. Unauthenticated visitor must see #login!
const unauth = runScenario(false);
await new Promise((r) => setTimeout(r, 30));
if (unauth.getEl("#login").hidden !== false) {
  throw new Error("Expected #login to be visible when /api/session returns 401");
}

// 2. Authenticated user on #/collie?quotas=1 must see #app, #v-collie, non-colliding is-table CSV badge,
//    syntax-highlighted Go codeblock, quick-reply buttons, pending bar, and #quota-pop!
const auth = runScenario(true);
await new Promise((r) => setTimeout(r, 50));
if (auth.getEl("#app").hidden !== false || auth.getEl("#v-collie").hidden !== false) {
  throw new Error("Expected #app and #v-collie to be visible when authenticated");
}
const threadHTML = auth.getEl("#super-thread").innerHTML;
if (!threadHTML.includes("artifact-cards") || !threadHTML.includes("art-badge is-table")) {
  throw new Error("Expected artifact-cards with non-colliding 'art-badge is-table' for CSV");
}
if (threadHTML.includes("art-badge sheet")) {
  throw new Error("Regression: 'art-badge sheet' collides with dialog.sheet!");
}
if (!threadHTML.includes("hl-k") || !threadHTML.includes('data-lang="go"')) {
  throw new Error("Expected offline syntax highlighting in Markdown fenced codeblocks");
}
if (!threadHTML.includes("reply-opts") || !threadHTML.includes('data-opt="继续启动"')) {
  throw new Error("Expected quick-reply --opt buttons in #super-thread");
}
if (auth.getEl("#pending-wrap").hidden !== false || !auth.getEl("#pending-bar").innerHTML.includes("待你确认")) {
  throw new Error("Expected #pending-bar to be visible for unanswered --opt message");
}
if (!auth.getEl("#quota-pop").innerHTML.includes("模型剩余用量")) {
  throw new Error("Expected #quota-pop to render quota summary");
}
if (!threadHTML.includes("u-link-card") || !threadHTML.includes("u-url-pill")) {
  throw new Error("Expected smart user link card (u-link-card) and inline URL pill (u-url-pill)");
}
if (!threadHTML.includes('class="math-block"') || !threadHTML.includes('class="math-inline"') || !threadHTML.includes("<mfrac>") || !threadHTML.includes("<munderover>") || !threadHTML.includes('<mover accent="true">')) {
  throw new Error("Expected LaTeX display/inline MathML rendering (<mfrac>, <munderover>, <mover>)");
}
if (!threadHTML.includes("collie-proc") || !threadHTML.includes("1 条中间进展 · 2 条调度轨迹") || !threadHTML.includes("md-table")) {
  throw new Error("Expected settled Collie turn to fold interim replies & events into .collie-proc and render GFM md-table in final summary");
}
const cssText = fs.readFileSync("web/app.css", "utf8");
if (/\.item\.active\s*>\s*\.dot[^{]*\{[^}]*opacity:\s*0/.test(cssText)) {
  throw new Error("Regression: active sidebar session item must NOT hide working spinner (.dot)!");
}
console.log("Frontend runtime smoke test passed (login + #/collie + CSV is-table + syntax highlight + smart link cards + active dot + pending --opt + quotas).");
