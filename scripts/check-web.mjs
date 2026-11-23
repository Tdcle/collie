// Runtime smoke test for Collie's zero-build frontend (quota.js + artifacts.js + app.js).
// Catches Temporal Dead Zone (TDZ) ReferenceErrors, missing globals, and render crashes
// across login, #/collie, artifact cards, quota popover, and ⌘K search.
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
    requestAnimationFrame: (fn) => fn(),
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
      hidden: false, body: makeEl("body"), documentElement: makeEl("html"), activeElement: null,
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
        return {
          ok: true, status: 200, headers: { get: () => "" },
          json: async () => ({
            router: { alive: true, status: "idle", kind: "codex", machine: "mac" },
            entries: [
              { id: "e1", role: "user", text: "生成实验报告", at: new Date().toISOString() },
              { id: "e2", role: "collie", text: "已生成报告 ~/Desktop/ablation_report.pdf 和指标表 D:\\Paper\\metrics.csv，请查收。", at: new Date().toISOString() },
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

// 2. Authenticated user on #/collie?quotas=1 must see #app, #v-collie, artifact cards, and #quota-pop!
const auth = runScenario(true);
await new Promise((r) => setTimeout(r, 50));
if (auth.getEl("#app").hidden !== false || auth.getEl("#v-collie").hidden !== false) {
  throw new Error("Expected #app and #v-collie to be visible when authenticated");
}
if (!auth.getEl("#super-thread").innerHTML.includes("artifact-cards")) {
  throw new Error("Expected artifact-cards to render inside #super-thread");
}
if (!auth.getEl("#quota-pop").innerHTML.includes("模型剩余用量")) {
  throw new Error("Expected #quota-pop to render quota summary");
}
console.log("Frontend runtime smoke test passed (login + #/collie + artifacts + quotas).");
