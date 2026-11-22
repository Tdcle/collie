/* Collie — web console + super-agent for herdr. No build step, no framework. */
(() => {
  "use strict";

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const store = {
    get(k, d) { try { const v = localStorage.getItem("collie." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("collie." + k, JSON.stringify(v)); } catch {} },
  };
  const narrow = () => matchMedia("(max-width: 760px)").matches;
  const AGENT_LABEL = { claude: "Claude Code", codex: "Codex", agy: "Antigravity", gemini: "Gemini CLI" };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const cleanPath = (p) => String(p || "").replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
  const tilde = (p, home) => {
    const s = cleanPath(p);
    if (!s) return "";
    const h = cleanPath(home);
    if (h && s.length >= h.length && s.slice(0, h.length).replace(/\//g, "\\").toLowerCase() === h.replace(/\//g, "\\").toLowerCase() && (!s[h.length] || s[h.length] === "/" || s[h.length] === "\\")) {
      return "~" + s.slice(h.length);
    }
    return s.replace(/^\/Users\/[^/]+|^\/home\/[^/]+|^\/root(?=$|\/)|^[A-Za-z]:[\\/]Users[\\/][^\\/]+/i, "~");
  };
  const hhmm = (t) => { const d = new Date(t); return isNaN(d) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); };
  // 21:52 today, 昨天 18:30, 11月18日 18:30 before that.
  const sepTime = (t) => {
    const d = new Date(t), now = new Date(), y = new Date(now - 86400e3);
    if (d.toDateString() === now.toDateString()) return hhmm(t);
    if (d.toDateString() === y.toDateString()) return "昨天 " + hhmm(t);
    return `${d.getMonth() + 1}月${d.getDate()}日 ${hhmm(t)}`;
  };
  const fullTime = (t) => new Date(t).toLocaleString([], { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const when = (t) => {
    const d = new Date(t); if (isNaN(d)) return "";
    const today = new Date().toDateString() === d.toDateString();
    return today ? hhmm(t) : d.toLocaleDateString([], { month: "numeric", day: "numeric" }) + " " + hhmm(t);
  };

  // ───────────────────────────── icons & labels (unified 24x24 monochrome icon suite)
  const GLYPHS = {
    claude: '<svg viewBox="0 0 24 24"><path d="M12 2.9v5.9M12 15.2v5.9M3.35 9.19l5.61 1.82M15.04 12.99l5.61 1.82M6.65 19.36l3.47-4.77M13.88 9.41l3.47-4.77M17.35 19.36l-3.47-4.77M10.12 9.41 6.65 4.64M3.35 14.81l5.61-1.82M15.04 11.01l5.61-1.82"/></svg>',
    codex: '<svg viewBox="0 0 24 24"><path d="M12 2.9 19.88 7.45v9.1L12 21.1 4.12 16.55v-9.1Z"/><path d="M12 8.2 15.29 10.1v3.8L12 15.8 8.71 13.9v-3.8Z"/><path d="M12 8.2 19.88 7.45M15.29 10.1 19.88 16.55M15.29 13.9 12 21.1M8.71 13.9 4.12 16.55M8.71 10.1 4.12 7.45M12 8.2V2.9"/></svg>',
    agy: '<svg viewBox="0 0 24 24"><path d="M12 3.4C15.1 3.4 17.1 12.8 19.9 17.9c.65 1.18-.58 2.25-1.72 1.48C15.7 17.7 14.3 13.9 12 13.9s-3.7 3.8-6.18 5.48c-1.14.77-2.37-.3-1.72-1.48C6.9 12.8 8.9 3.4 12 3.4Z"/></svg>',
    antigravity: '<svg viewBox="0 0 24 24"><path d="M12 3.4C15.1 3.4 17.1 12.8 19.9 17.9c.65 1.18-.58 2.25-1.72 1.48C15.7 17.7 14.3 13.9 12 13.9s-3.7 3.8-6.18 5.48c-1.14.77-2.37-.3-1.72-1.48C6.9 12.8 8.9 3.4 12 3.4Z"/></svg>',
    gemini: '<svg viewBox="0 0 24 24"><path d="M12 2.8C12.38 7.82 16.18 11.62 21.2 12 16.18 12.38 12.38 16.18 12 21.2 11.62 16.18 7.82 12.38 2.8 12 7.82 11.62 11.62 7.82 12 2.8Z"/></svg>',
    folder: '<svg viewBox="0 0 24 24"><path d="M3 6.5A2 2 0 0 1 5 4.5h4.2a2 2 0 0 1 1.56.75l1.18 1.5H19a2 2 0 0 1 2 2v8.75a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>',
    folderOpen: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4.2a2 2 0 0 1 1.55.74l1.2 1.51H19a2 2 0 0 1 2 2v1.25H6.6a2 2 0 0 0-1.92 1.45L3 18V7Z"/><path d="M4.68 12.95A2 2 0 0 1 6.6 11.5h13.75a1.3 1.3 0 0 1 1.25 1.66l-1.55 5.4A2 2 0 0 1 18.13 20H4.5a1.3 1.3 0 0 1-1.25-1.66Z"/></svg>',
    agent: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M9 11h.01M15 11h.01M9 15c1.8 1.3 4.2 1.3 6 0"/></svg>',
    shell: '<svg viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M7 10l3 2.3L7 14.6M11.5 15h5"/></svg>',
    collie: '<img src="/icon.svg" alt="" style="width:20px;height:20px">',
  };
  const OS_GLYPHS = {
    mac: '<svg class="svg-fill" viewBox="-1.8 -1.8 27.6 27.6"><path d="M16.365 1.43c0 1.14-.493 2.27-1.177 3.08-.744.9-1.99 1.57-2.987 1.57-.12 0-.23-.02-.3-.03-.01-.06-.04-.22-.04-.39 0-1.15.572-2.27 1.206-2.98.804-.94 2.142-1.64 3.248-1.68.03.13.05.28.05.43zm4.565 15.71c-.03.07-.463 1.58-1.518 3.12-.945 1.34-1.94 2.71-3.43 2.71-1.517 0-1.9-.88-3.63-.88-1.698 0-2.302.91-3.67.91-1.377 0-2.332-1.26-3.428-2.8-1.287-1.82-2.323-4.63-2.323-7.28 0-4.28 2.797-6.55 5.552-6.55 1.448 0 2.675.95 3.6.95.865 0 2.222-1.01 3.902-1.01.613 0 2.886.06 4.374 2.19-.13.09-2.383 1.37-2.383 4.19 0 3.26 2.854 4.42 2.955 4.45z"/></svg>',
    win: '<svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="7.3" height="7.3" rx="1.2"/><rect x="13.2" y="3.5" width="7.3" height="7.3" rx="1.2"/><rect x="3.5" y="13.2" width="7.3" height="7.3" rx="1.2"/><rect x="13.2" y="13.2" width="7.3" height="7.3" rx="1.2"/></svg>',
    linux: '<svg viewBox="0 0 24 24"><rect x="3.2" y="4.2" width="17.6" height="6.6" rx="1.8"/><rect x="3.2" y="13.2" width="17.6" height="6.6" rx="1.8"/><path d="M7.2 7.5h.01M7.2 16.5h.01M11.2 7.5h5.8M11.2 16.5h5.8"/></svg>',
    relay: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="18" r="2"/><path d="M6.7 7.3l3.1 2.7M17.3 7.3l-3.1 2.7M6.7 16.7l3.1-2.7M17.3 16.7l-3.1-2.7"/></svg>',
  };
  const osGlyph = (os, relay = false) => relay ? OS_GLYPHS.relay : /^darwin/i.test(os || "") ? OS_GLYPHS.mac : /^windows/i.test(os || "") ? OS_GLYPHS.win : OS_GLYPHS.linux;
  const KIND_LABEL = { claude: "claude", codex: "codex", agy: "antigravity", antigravity: "antigravity", gemini: "gemini" };
  const STATUS_LABEL = {
    idle: "空闲", working: "工作中", waiting: "在等后台任务", blocked: "等你确认", done: "已完成", unknown: "运行中", shell: "终端",
    asleep: "休眠中", starting: "启动中", gone: "已退出", failed: "启动失败",
  };
  const ROUTER = "collie";
  // Collie is one conversation to the human; the session behind it is an
  // implementation detail. "done" just means a turn ended: it is idle.
  const COLLIE_STATUS = { asleep: "休眠中", starting: "正在唤醒", working: "在想…", blocked: "等你确认", failed: "出错了", dreaming: "在做梦…" };
  const SOURCE_LABEL = { worker: "派出的 agent", chat: "对话", timer: "定时", system: "Collie" };
  const collieStatus = (s) => COLLIE_STATUS[s] || "空闲";
  const collieDot = (s) => (s === "done" || s === "unknown" ? "idle" : s === "dreaming" ? "starting" : s || "asleep");
  const glyph = (v) => v.name === ROUTER ? GLYPHS.collie : !v.is_agent ? GLYPHS.shell : (GLYPHS[v.kind] || GLYPHS.agent);

  // ───────────────────────────── api
  // A page left open keeps its old code after the hub is updated: when the
  // hub reports a different web app, offer a reload (once).
  let webBuild = null;
  function noteBuild(v) {
    if (!v) return;
    if (webBuild === null) { webBuild = v; return; }
    if (v === webBuild || document.getElementById("update-bar")) return;
    const bar = document.createElement("button");
    bar.id = "update-bar"; bar.type = "button";
    bar.textContent = "Collie 有新版本，点这里刷新";
    bar.onclick = () => location.reload();
    document.body.append(bar);
  }
  // ───────────────────────────── other hubs
  // Hubs on networks that can't reach each other (a devbox, a cloud
  // computer, a Mac mini at home) can all be reached from this browser.
  // Their sessions join this sidebar with every id tagged "!<key>"; any
  // request that names a tagged id goes straight to that hub, with its token.
  let hubs = [];              // [{ key, name, url, token }], kept on this hub
  const remote = new Map();   // key -> { state, ext, hist, online, es }
  const tagged = (v, k) => (v || "") + "!" + k;
  const hubMarks = (h) => ["!" + h.key, "%21" + h.key];
  const hubOf = (text) => hubs.find((h) => hubMarks(h).some((m) => text.includes(m))) || null;
  const untag = (text, h) => hubMarks(h).reduce((t, m) => t.split(m).join(""), text);
  const hubName = (k) => hubs.find((h) => h.key === k)?.name || "";
  function routeReq(path, body, hub) {
    const b = body === undefined ? undefined : JSON.stringify(body);
    const h = hub || hubOf(path + (b || ""));
    if (!h) return { url: path, body: b, hub: null };
    return { url: h.url + untag(path, h), body: b && untag(b, h), hub: h };
  }
  // Ids in a remote hub's answers get its tag, so follow-up requests route back.
  function tagIds(v, k, depth = 0) {
    if (depth > 3 || !v || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map((x) => tagIds(x, k, depth + 1));
    const out = { ...v };
    for (const f of ["pane_id", "workspace_id"]) if (typeof out[f] === "string" && out[f]) out[f] = tagged(out[f], k);
    if (typeof out.machine === "string") out.machine = tagged(out.machine, k);
    for (const [f, x] of Object.entries(out)) if (x && typeof x === "object") out[f] = tagIds(x, k, depth + 1);
    return out;
  }
  async function api(path, opts = {}) {
    const r = routeReq(path, opts.body, opts.hub);
    const headers = opts.body ? { "Content-Type": "application/json" } : {};
    if (r.hub) headers.Authorization = "Bearer " + r.hub.token;
    const res = await fetch(r.url, {
      method: opts.body ? "POST" : (opts.method || "GET"),
      headers, body: r.body,
      credentials: r.hub ? "omit" : "same-origin",
    });
    if (!r.hub) noteBuild(res.headers.get("X-Collie-Web"));
    let data = {};
    try { data = await res.json(); } catch {}
    if (res.status === 401) {
      if (r.hub) throw new Error(`${r.hub.name} 不认这个浏览器了，在「设备」里重新添加它`);
      showLogin(); throw new Error("unauthorized");
    }
    if (!res.ok) throw new Error(data.error || res.statusText);
    return r.hub ? tagIds(data, r.hub.key) : data;
  }
  // EventSource can't set headers: a remote hub takes its token in the URL.
  function openES(path, hub) {
    const r = routeReq(path, undefined, hub);
    if (!r.hub) return new EventSource(path);
    return new EventSource(r.url + (r.url.includes("?") ? "&" : "?") + "access_token=" + encodeURIComponent(r.hub.token));
  }
  const paneURL = (id, rest) => `/api/panes/${encodeURIComponent(id)}/${rest}`;
  // ───────────────────────────── pickers
  // Every <select> keeps its value (forms read it as before) but shows a quiet
  // button and a menu that matches the app; on a phone the menu is a sheet.
  // Options may carry data-glyph (agent icon), data-dot (status) and data-sub.
  const pickPop = document.createElement("div");
  pickPop.className = "pick-pop"; pickPop.hidden = true; pickPop.setAttribute("role", "listbox");
  const pickBack = document.createElement("div");
  pickBack.className = "pick-back"; pickBack.hidden = true;
  document.body.append(pickBack, pickPop);
  let pickOpen = null;
  const optIcon = (o) => o.dataset.glyph ? `<span class="pi">${GLYPHS[o.dataset.glyph] || ""}</span>`
    : o.dataset.os ? `<span class="pi">${OS_GLYPHS[o.dataset.os] || ""}</span>`
    : o.dataset.dot ? `<span class="pi"><span class="dot ${esc(o.dataset.dot)}"></span></span>` : "";
  function syncPick(sel) {
    const b = sel._pick;
    if (!b) return;
    const o = sel.selectedOptions[0];
    b.querySelector(".pv").innerHTML = o ? optIcon(o) + `<span class="pt">${esc(o.dataset.short || o.textContent)}</span>` : "";
    b.disabled = sel.disabled;
    b.hidden = sel.hidden || (sel.dataset.pick === "chip" && !o);
  }
  function enhance(sel) {
    if (sel._pick || "native" in sel.dataset) return;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pick" + (sel.dataset.pick ? " " + sel.dataset.pick : "");
    if (sel.title) b.title = sel.title;
    b.setAttribute("aria-haspopup", "listbox");
    b.innerHTML = `<span class="pv"></span><svg class="pc" viewBox="0 0 24 24"><path d="M7 10l5 5 5-5"/></svg>`;
    sel._pick = b;
    sel.classList.add("picked");
    sel.tabIndex = -1;
    sel.after(b);
    b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); pickOpen === sel ? closePick() : openPick(sel); });
    b.addEventListener("keydown", (e) => {
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && pickOpen !== sel) { e.preventDefault(); openPick(sel); }
    });
    syncPick(sel);
  }
  function openPick(sel) {
    closePick();
    pickOpen = sel;
    // A modal <dialog> sits in the top layer, above any z-index: the menu has
    // to live inside it to show.
    const host = sel.closest("dialog[open]") || document.body;
    if (pickPop.parentNode !== host) host.append(pickBack, pickPop);
    const row = (o) => `<button type="button" class="po${o.selected ? " on" : ""}" role="option" data-v="${esc(o.value)}" ${o.disabled ? "disabled" : ""}>
      ${optIcon(o)}<span class="pl"><span>${esc(o.textContent)}</span>${o.dataset.sub ? `<small>${esc(o.dataset.sub)}</small>` : ""}</span>
      <svg class="ck" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></button>`;
    let html = sel.dataset.title ? `<div class="ph">${esc(sel.dataset.title)}</div>` : "";
    for (const c of sel.children) {
      html += c.tagName === "OPTGROUP" ? `<div class="ph">${esc(c.label)}</div>` + [...c.children].map(row).join("") : row(c);
    }
    pickPop.innerHTML = html;
    const sheet = narrow();
    pickPop.classList.toggle("sheet", sheet);
    pickBack.hidden = !sheet;
    pickPop.hidden = false;
    sel._pick.setAttribute("aria-expanded", "true");
    if (sheet) {
      pickPop.style.cssText = "";
    } else {
      const r = sel._pick.getBoundingClientRect();
      pickPop.style.minWidth = Math.max(r.width, 180) + "px";
      const w = pickPop.offsetWidth, h = pickPop.offsetHeight;
      const left = Math.min(Math.max(8, r.left), innerWidth - w - 8);
      const below = innerHeight - r.bottom - 8;
      const top = below >= h + 6 || below > r.top ? r.bottom + 6 : r.top - h - 6;
      pickPop.style.left = left + "px";
      pickPop.style.top = Math.max(8, top) + "px";
    }
    ($(".po.on", pickPop) || $(".po", pickPop))?.focus({ preventScroll: true });
    $(".po.on", pickPop)?.scrollIntoView({ block: "nearest" });
  }
  function closePick(refocus) {
    if (!pickOpen) return;
    const sel = pickOpen;
    pickOpen = null;
    pickPop.hidden = true;
    pickBack.hidden = true;
    sel._pick.setAttribute("aria-expanded", "false");
    if (refocus) sel._pick.focus({ preventScroll: true });
  }
  pickPop.addEventListener("click", (e) => {
    const o = e.target.closest(".po");
    if (!o || !pickOpen) return;
    const sel = pickOpen;
    closePick(true);
    if (sel.value === o.dataset.v) return;
    sel.value = o.dataset.v;
    syncPick(sel);
    sel.dispatchEvent(new Event("input", { bubbles: true }));
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  pickPop.addEventListener("keydown", (e) => {
    const items = $$(".po:not([disabled])", pickPop);
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    } else if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); closePick(true); }
  });
  pickBack.addEventListener("click", () => closePick());
  document.addEventListener("mousedown", (e) => {
    if (pickOpen && !pickPop.contains(e.target) && !pickOpen._pick.contains(e.target)) closePick();
  });
  addEventListener("resize", () => closePick());
  document.addEventListener("scroll", (e) => { if (pickOpen && !pickPop.contains(e.target)) closePick(); }, true);
  document.addEventListener("change", (e) => { if (e.target.tagName === "SELECT") syncPick(e.target); });
  new MutationObserver((ms) => {
    for (const m of ms) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === "SELECT") enhance(n); else n.querySelectorAll?.("select").forEach(enhance);
      }
      const s = m.target.closest?.("select");
      if (s) syncPick(s);
    }
  }).observe(document.body, { childList: true, subtree: true });
  $$("select").forEach(enhance);


  function toast(msg, kind = "") {
    const t = document.createElement("div");
    t.className = "toast " + kind;
    t.textContent = msg;
    $("#toasts").append(t);
    setTimeout(() => t.remove(), kind === "attn" ? 5000 : 2600);
  }

  // ───────────────────────────── auth
  function showLogin() {
    $("#app").hidden = true;
    $("#login").hidden = false;
    setTimeout(() => $("#login-token").focus(), 50);
  }
  async function login(token) {
    const res = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
    if (!res.ok) throw new Error("bad token");
  }
  // A name the hub shows in its device list, e.g. "iPhone · Safari".
  function deviceName() {
    const ua = navigator.userAgent;
    const dev = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android"
      : /Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "设备";
    const br = /EdgA?\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "浏览器";
    return `${dev} · ${br}`;
  }
  async function pair(code) {
    const res = await fetch("/api/pair", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, kind: "browser", name: deviceName() }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "配对失败");
  }
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("#login-error").textContent = "";
    const v = $("#login-token").value.trim();
    try {
      if (/^[A-Z2-7]{8}$/i.test(v)) await pair(v); else await login(v);
      boot();
    } catch (err) { $("#login-error").textContent = /^[A-Z2-7]{8}$/i.test(v) ? err.message : "令牌不对"; }
  });
  $("#logout")?.addEventListener("click", async () => { await fetch("/api/logout", { method: "POST" }); location.reload(); });

  // ───────────────────────────── live state
  let state = { ok: false, agents: [], shells: [] };
  let localState = state;     // this hub's own; state adds the other hubs'
  function tagState(s, h, online) {
    const k = h.key;
    const fix = (a) => ({ ...a, hub: k, pane_id: tagged(a.pane_id, k), machine: tagged(a.machine, k),
      workspace_id: a.workspace_id ? tagged(a.workspace_id, k) : a.workspace_id,
      // Each hub has its own Collie; only this hub's is "Collie" here.
      ...(a.name === ROUTER ? { name: "Collie · " + h.name, topic: "Collie · " + h.name } : {}) });
    const ms = s.machines && s.machines.length ? s.machines : [{ id: "", name: h.name, local: true, online: s.ok !== false }];
    const projs = (s.projects || []).map((p) => ({ ...p, id: tagged(p.id, k), machine: tagged(p.machine || "", k), hub: k }));
    return {
      agents: (s.agents || []).map(fix), shells: (s.shells || []).map(fix),
      projects: projs,
      machines: ms.map((m) => ({ ...m, hub: k, id: tagged(m.id, k), local: false,
        name: m.local ? h.name : h.name + " · " + m.name,
        online: online && (m.local ? s.ok !== false : m.online) })),
    };
  }
  function mergedState() {
    const parts = [...remote.values()].map((r) => r.state).filter(Boolean);
    if (!parts.length) return localState;
    const meta = { ...(localState.session_meta || {}) };
    for (const p of parts) Object.assign(meta, p.session_meta || {});
    return { ...localState,
      session_meta: meta,
      projects: [...(localState.projects || []), ...parts.flatMap((p) => p.projects || [])],
      agents: [...(localState.agents || []), ...parts.flatMap((p) => p.agents)],
      shells: [...(localState.shells || []), ...parts.flatMap((p) => p.shells)],
      machines: [...(localState.machines && localState.machines.length ? localState.machines : [{ id: "", name: "本机", local: true, online: localState.ok }]),
        ...parts.flatMap((p) => p.machines)] };
  }
  function setLocalState(next) { localState = next; state = mergedState(); }
  function remoteChanged() {
    const m = mergedState();
    notifyTransitions(m);
    state = m;
    renderSide();
    if (view === "pane") renderHead();
  }
  function connectHub(h) {
    let r = remote.get(h.key);
    if (!r) { r = { state: tagState({}, h, false) }; remote.set(h.key, r); }
    r.es?.close();
    const es = r.es = openES("/api/events", h);
    let gone;
    es.addEventListener("state", (e) => {
      clearTimeout(gone);
      r.online = true; r.raw = JSON.parse(e.data);
      r.state = tagState(r.raw, h, true);
      remoteChanged();
    });
    es.onerror = () => {
      // A blip reconnects by itself; only a hub that stays away goes grey.
      clearTimeout(gone);
      gone = setTimeout(() => { r.online = false; r.state = tagState({ ...(r.raw || {}), agents: [], shells: [] }, h, false); remoteChanged(); }, 8000);
      if (es.readyState === EventSource.CLOSED && r.es === es) setTimeout(() => { if (r.es === es) connectHub(h); }, 5000);
    };
  }
  async function loadHubs() {
    try { hubs = (await api("/api/hubs")).hubs || []; } catch { return; }
    for (const [k, r] of remote) if (!hubs.some((h) => h.key === k)) { r.es?.close(); remote.delete(k); }
    for (const h of hubs) if (!remote.get(h.key)?.es || remote.get(h.key).url !== h.url) { connectHub(h); remote.get(h.key).url = h.url; }
    state = mergedState();
    renderSide();
  }
  let sup = { router: { status: "asleep" }, entries: [], workers: [], queued: 0 };
  let prevStatus = new Map();
  let view = null;     // "collie" | "auto" | "pane" | null
  let current = null;  // pane id when view === "pane"

  function connect() {
    const ev = new EventSource("/api/events");
    ev.addEventListener("super", (e) => {
      sup = normSup(JSON.parse(e.data));
      renderSide();
      if (view === "collie") renderSuper();
    });
    ev.addEventListener("state", (e) => {
      localState = JSON.parse(e.data);
      const next = mergedState();
      notifyTransitions(next);
      state = next;
      renderSide();
      if (view === "pane") renderHead();
      if (view === "collie") renderSuper();
    });
    ev.onopen = () => $("#conn").className = "conn on";
    ev.onerror = async () => {
      $("#conn").className = "conn off";
      try { await api("/api/session"); } catch {}
      // A restart can answer with an error status, which closes the stream
      // for good; open a new one or the page silently goes stale.
      if (ev.readyState === EventSource.CLOSED && liveEv === ev) setTimeout(() => { if (liveEv === ev) connect(); }, 2000);
    };
    liveEv = ev;
  }
  let liveEv = null;
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && liveEv?.readyState === EventSource.CLOSED) connect();
  });

  // A finished agent you have open here has been seen: the hub then shows
  // it as idle everywhere (herdr itself only counts its own terminal).
  const seenAt = new Map();
  function markSeen(v) {
    if (v.status !== "done" || document.hidden || Date.now() - (seenAt.get(v.pane_id) || 0) < 3000) return;
    seenAt.set(v.pane_id, Date.now());
    api("/api/seen", { body: { pane: v.pane_id } }).catch(() => {});
  }
  document.addEventListener("visibilitychange", () => { if (view === "pane" && find(current)) markSeen(find(current)); });

  function notifyTransitions(next) {
    for (const a of next.agents) {
      const before = prevStatus.get(a.pane_id);
      if (before && before !== a.status) {
        if (a.status === "blocked") ping(`${title(a)} 需要你确认`, a, "attn");
        else if (before === "working" && (a.status === "done" || a.status === "idle") && !isWorker(a.name) && a.name !== ROUTER) {
          ping(`${title(a)} 完成了`, a);
        }
      }
    }
    prevStatus = new Map(next.agents.map((a) => [a.pane_id, a.status]));
  }

  function ping(msg, a, kind) {
    if (a.pane_id !== current || document.hidden) {
      toast(msg, kind);
      if (document.hidden && prefs.notify() && "Notification" in window && Notification.permission === "granted") {
        const n = new Notification("Collie", { body: msg, icon: "/icon.svg", tag: a.pane_id });
        n.onclick = () => { focus(); location.hash = "#/p/" + encodeURIComponent(a.pane_id); };
      }
    }
  }

  // Tell the hub a page of Collie is in front of you: it holds back
  // notifications while you can see them here.
  const seen = () => { if (!document.hidden && document.hasFocus()) api("/api/super/seen", { body: { url: location.origin } }).catch(() => {}); };
  setInterval(seen, 30e3);
  document.addEventListener("visibilitychange", seen);
  addEventListener("focus", seen);

  function normSup(s) { s.entries ||= []; s.workers ||= []; s.router ||= { status: "asleep" }; return s; }
  const isWorker = (name) => sup.workers.some((w) => w.name === name && !w.ended);
  const paneOf = (name) => state.agents.find((a) => a.name === name)?.pane_id;
  // A worker's status as the sidebar shows it (which knows when it waits on
  // background work), else as Collie last saw it.
  const workerStatus = (w) => (!w.ended && state.agents.find((a) => a.name === w.name)?.status) || w.status;
  const workerBusy = (w) => !w.ended && ["working", "starting", "waiting"].includes(workerStatus(w));
  const find = (id) => state.agents.find((a) => a.pane_id === id) || state.shells.find((a) => a.pane_id === id);
  // What to call an agent: the session's own title; a handle like "agy-1" says
  // nothing, so until there's a title use the folder it works in.
  const autoName = (n) => /^(claude|codex|agy|antigravity|gemini)-[0-9a-f]+$/i.test(n || "");
  const base = (p) => cleanPath(p).replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "~";
  // A cloud Hub with neither herdr nor agents installed is a pure relay server:
  // don't count it as a runnable computer or offer it as an agent execution target.
  const isAgentlessHub = (m) => !!(m?.local && !m.online && Array.isArray(m.agents) && m.agents.length === 0);
  const runnableMachines = (keepId = "") => (state.machines || [{ id: "", name: "本机", local: true, online: state.ok }]).filter((m) => {
    if (m.hub) return false;
    if (m.id === keepId && (!isAgentlessHub(m) || !(state.machines || []).some((x) => !x.local))) return true;
    return m.local ? !isAgentlessHub(m) && m.online !== false : m.online;
  });
  // When no workstation has been explicitly selected yet and personal computers
  // (Mac / Win / Linux nodes) are connected, prefer an online workstation over a
  // cloud relay Hub (/root).
  function preferredWorkMachine(explicitId = "") {
    if (explicitId) return explicitId;
    const remotes = (state.machines || []).filter((m) => !m.local && !m.hub && m.online);
    if (!remotes.length) return "";
    const routerM = sup.router?.machine || "";
    if (routerM && remotes.some((m) => m.id === routerM)) return routerM;
    return remotes[0].id;
  }
  const normSessKind = (k) => (k === "antigravity" ? "agy" : (k || "").toLowerCase());
  const canonSessKey = (kind, machine, session) => session ? `s:${normSessKind(kind)}:${machine || ""}:${session}` : "";
  function getSessMeta(kind, machine, session, fallbackKey) {
    const map = state.session_meta || {};
    const ck = canonSessKey(kind, machine, session);
    const cm = ck && map[ck], fm = fallbackKey && map[fallbackKey];
    if (cm && fm) return { ...fm, ...cm, project_id: cm.project_id || fm.project_id || "" };
    return cm || fm || null;
  }
  function canonMachinePath(rawPath, machineId) {
    let s = cleanPath(rawPath).trim();
    if (!s) return "";
    const m = (state.machines || []).find((x) => (x.id || "") === (machineId || ""));
    const home = cleanPath(m?.home || "").replace(/\\/g, "/").replace(/\/+$/, "");
    s = s.replace(/\\/g, "/");
    if (home && (s === "~" || s.startsWith("~/"))) {
      s = home + s.slice(1);
    }
    if (s.length > 1 && !/^[A-Za-z]:\/$/.test(s)) s = s.replace(/\/+$/, "");
    const isWin = /^windows/i.test(m?.os || "") || /^[A-Za-z]:/.test(s);
    return isWin ? s.toLowerCase() : s;
  }
  function projectOfSession(kind, machine, session, cwd, fallbackKey) {
    const projs = state.projects || [];
    if (!projs.length) return null;
    const meta = getSessMeta(kind, machine, session, fallbackKey);
    if (meta?.project_id === "-") return null;
    if (meta?.project_id) {
      const explicit = projs.find((p) => p.id === meta.project_id);
      if (explicit) return explicit;
    }
    const mId = machine || "";
    const sp = canonMachinePath(cwd, mId);
    if (!sp) return null;
    const hp = canonMachinePath("~", mId);
    let best = null, bestLen = -1;
    for (const p of projs) {
      if ((p.machine || "") !== mId) continue;
      const candidates = [p.cwd, ...(Array.isArray(p.roots) ? p.roots : [])].filter(Boolean);
      for (const cand of candidates) {
        const pp = canonMachinePath(cand, mId);
        if (!pp) continue;
        const isRootLike = pp === "/" || pp === hp || /^[a-z]:\/?$/i.test(pp);
        const matched = isRootLike ? sp === pp : (sp === pp || sp.startsWith(pp + "/"));
        if (matched && pp.length > bestLen) {
          best = p;
          bestLen = pp.length;
        }
      }
    }
    return best;
  }
  const MORE_ICO = '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/></svg>';
  const PLUS_ICO = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
  const CHEV_RIGHT_ICO = '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>';

  function title(v) {
    if (!v) return "";
    if (v.name === ROUTER) return "Collie";
    const meta = getSessMeta(v.kind, v.machine, v.session, "p:" + v.pane_id);
    if (meta?.title) return meta.title;
    if (isWorker(v.name)) return v.name;
    return v.topic || (v.name && !autoName(v.name) ? v.name : base(tilde(v.cwd))) || v.pane_id;
  }

  // ───────────────────────────── sidebar
  const SHOW_SIDE_DOT = new Set(["working", "starting", "waiting", "blocked", "failed"]);
  function sideDotHTML(st, labelMap = STATUS_LABEL) {
    return SHOW_SIDE_DOT.has(st) ? `<span class="dot ${esc(st)}" title="${esc(labelMap[st] || st)}"></span>` : "";
  }
  function itemHTML(v) {
    const where = (state.machines || []).length > 1 ? machineName(v.machine) + " · " : "";
    const named = v.is_agent && v.name !== ROUTER && !isWorker(v.name) && v.name && !autoName(v.name) && v.topic && v.topic !== v.name ? v.name + " · " : "";
    const sub = v.name === ROUTER ? "Collie 停在一个对话框上"
      : v.is_agent ? `${named}${KIND_LABEL[v.kind] || v.kind} · ${where}${base(tilde(v.cwd))}` : where + tilde(v.cwd);
    const more = v.name !== ROUTER ? `<button type="button" class="item-more" data-smenu="p:${esc(v.pane_id)}" title="重命名 / 归属项目 / 归档 / 删除">${MORE_ICO}</button>` : "";
    const quiet = !SHOW_SIDE_DOT.has(v.status);
    return `<li class="s-li"><a class="item ${quiet ? "ended" : ""} ${view === "pane" && v.pane_id === current ? "active" : ""}" href="#/p/${encodeURIComponent(v.pane_id)}">
      <span class="glyph">${glyph(v)}</span>
      <span class="body"><div class="name">${isCollieOwned(v) && v.name !== ROUTER ? `<span class="nm">${esc(title(v))}</span><span class="by-collie">Collie 派出</span>` : esc(v.is_agent ? title(v) : v.workspace_label || base(tilde(v.cwd)))}</div><div class="sub">${esc(sub)}</div></span>
      ${sideDotHTML(v.status)}</a>${more}</li>`;
  }

  const machineName = (id) => (state.machines || []).find((m) => m.id === (id || ""))?.name || id || "本机";
  const isCollieOwned = (v) => v.name === ROUTER || isWorker(v.name);
  let sideMachine = null; // null = 全部; string = filter sidebar sessions to that machine id
  let sideStatus = null;  // null | "running" | "blocked" (mutually exclusive toggle)
  const osKey = (os) => /^darwin/i.test(os || "") ? "mac" : /^windows/i.test(os || "") ? "win" : "linux";

  $("#side-machine-sel")?.addEventListener("change", (e) => {
    sideMachine = e.target.value === "__all" ? null : e.target.value;
    renderSide();
  });
  $("#session-filter")?.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-sf]");
    if (!b) return;
    const v = b.dataset.sf;
    sideStatus = sideStatus === v ? null : v; // click once to select, click again to cancel; mutually exclusive
    renderSide();
  });

  function whenShort(at) {
    const d = new Date(at), hm = d.toTimeString().slice(0, 5);
    const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 864e5);
    return days === 0 ? hm : days === 1 ? "明天 " + hm : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  }
  function renderSide() {
    const allMachines = (state.machines || [{ id: "", name: "本机", local: true, online: state.ok }]);
    const workMachines = allMachines.filter((m) => !isAgentlessHub(m));
    const countMachines = workMachines.length ? workMachines : allMachines;
    if (sideMachine !== null && !workMachines.some((m) => m.id === sideMachine)) sideMachine = null;
    const matchSideMachine = (m) => sideMachine === null || (m || "") === sideMachine;

    const wrap = $("#sf-machine-wrap"), mSel = $("#side-machine-sel");
    if (wrap && mSel) {
      if (workMachines.length > 1) {
        const countFor = (id) => {
          const mm = (x) => id === null || (x || "") === id;
          const seen = new Set();
          let n = 0;
          for (const a of state.agents) {
            if (a.name === ROUTER || !mm(a.machine)) continue;
            const meta = getSessMeta(a.kind, a.machine, a.session, "p:" + a.pane_id);
            if (meta?.deleted || meta?.archived) continue;
            const ck = canonSessKey(a.kind, a.machine, a.session);
            if (ck) seen.add(ck);
            n++;
          }
          for (const e of ext) {
            if (!mm(e.machine)) continue;
            const meta = getSessMeta(e.kind, e.machine, e.session, "x:" + e.id);
            if (meta?.deleted || meta?.archived) continue;
            const ck = canonSessKey(e.kind, e.machine, e.session);
            if (ck && seen.has(ck)) continue;
            if (ck) seen.add(ck);
            n++;
          }
          for (const h of hist) {
            if (h.name === ROUTER || sup.workers.some((w) => w.name === h.name) || !mm(h.machine)) continue;
            const meta = getSessMeta(h.kind, h.machine, h.session, "h:" + h.id);
            if (meta?.deleted || meta?.archived) continue;
            const ck = canonSessKey(h.kind, h.machine, h.session);
            if (ck && seen.has(ck)) continue;
            if (ck) seen.add(ck);
            n++;
          }
          return n;
        };
        wrap.hidden = false;
        const val = sideMachine === null ? "__all" : sideMachine;
        const html = `<option value="__all" data-dot="online" data-short="全部电脑 (${countFor(null)})" ${val === "__all" ? "selected" : ""}>全部电脑 (${countFor(null)})</option>`
          + workMachines.map((m) => {
            const c = countFor(m.id);
            const on = m.local ? m.online !== false : m.online;
            return `<option value="${esc(m.id)}" data-os="${osKey(m.os)}" data-sub="${on ? "在线" : "离线"}${m.os ? " · " + esc(m.os) : ""}" data-short="${esc(m.name)} (${c})" ${val === m.id ? "selected" : ""}>${esc(m.name)} (${c})</option>`;
          }).join("");
        if (mSel._html !== html) { mSel._html = html; mSel.innerHTML = html; }
        mSel.value = val;
        enhance(mSel);
        syncPick(mSel);
      } else {
        wrap.hidden = true;
      }
    }

    const blockedAll = state.agents.filter((a) => a.status === "blocked" && !getSessMeta(a.kind, a.machine, a.session, "p:" + a.pane_id)?.deleted);
    void matchSideMachine;
    renderSessions();

    const online = countMachines.filter((m) => m.local ? m.online !== false && state.ok : m.online).length;
    $("#conn").className = "conn " + (online ? "on" : "off");
    $("#herdr-status").textContent = !online ? (allMachines.some((m) => !m.local) ? `0/${countMachines.length} 台电脑在线` : "herdr 不可用")
      : countMachines.length > 1 || allMachines.some((m) => !m.local) ? `${online}/${countMachines.length} 台电脑在线` : `${state.agents.length} 个 agent`;
    if (!state.ok && state.error) $("#herdr-status").title = state.error;
    document.title = blockedAll.length ? `(${blockedAll.length}) Collie` : "Collie";

    const r = sup.router || {};
    const active = sup.workers.filter((w) => !w.ended);
    const running = active.filter(workerBusy).length;
    const f = sup.follow;
    const stText = r.replied ? "在收尾" : collieStatus(r.status);
    $("#nav-collie-sub").textContent = stText + (running ? ` · ${running} 个任务在跑` : active.length ? ` · 派出 ${active.length} 个` : f?.next ? ` · ${whenShort(f.next)} 跟进` : "");
    $("#nav-collie-sub").title = f?.next ? `Collie 计划下次跟进：${whenShort(f.next)} · ${f.next_text || ""}` : "";
    $("#nav-collie-dot").className = "dot " + collieDot(r.status);
    $("#nav-queue").hidden = !sup.queued;
    $("#nav-queue").textContent = sup.queued;
    const tmrCount = $("#nav-timer-count");
    if (tmrCount) {
      tmrCount.hidden = !sup.timers;
      tmrCount.textContent = sup.timers || "";
    }
    $("#nav-collie").classList.toggle("active", view === "collie");
    $("#nav-trace")?.classList.toggle("active", view === "trace");
    $("#nav-memory")?.classList.toggle("active", view === "memory");
    $("#nav-timers")?.classList.toggle("active", view === "timers");
    $("#nav-hooks")?.classList.toggle("active", view === "hooks");
    $("#nav-devices").classList.toggle("active", view === "devices");
    $("#nav-settings")?.classList.toggle("active", view === "settings");
  }

  // Instant 0ms selection feedback on pointerdown before hashchange / async fetches run.
  $(".side")?.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest("a.nav-item, a.dock-btn, a.item");
    if (!a || !a.getAttribute("href")?.startsWith("#/")) return;
    $$(".side .nav-item.active, .side .dock-btn.active, .side .item.active").forEach((el) => el.classList.remove("active"));
    a.classList.add("active");
    $("#nav-devices").classList.remove("active");
    $("#nav-settings")?.classList.remove("active");
  });

  // ───────────────────────────── routing
  const PANEL_VIEWS = new Set(["trace", "memory", "timers", "hooks", "settings"]);
  function route() {
    const h = location.hash;
    if (h === "#/auto") {
      const legacyMap = { inbox: "#/trace", threads: "#/trace", memory: "#/memory", timers: "#/timers", hooks: "#/hooks", settings: "#/settings" };
      location.replace(legacyMap[store.get("autoTab", "inbox")] || "#/trace");
      return;
    }
    if (h === "#/prefs") {
      settingsTab = "local"; store.set("settingsTab", "local");
      location.replace("#/settings");
      return;
    }
    let next = null, id = null, subTab = null;
    if (h.startsWith("#/p/")) { next = "pane"; id = decodeURIComponent(h.slice(4)); }
    else if (h.startsWith("#/x/")) { next = "ext"; id = decodeURIComponent(h.slice(4)); }
    else if (h.startsWith("#/h/")) { next = "ext"; id = "h:" + decodeURIComponent(h.slice(4)); }
    else if (h === "#/collie") next = "collie";
    else if (h === "#/trace" || h.startsWith("#/trace/")) { next = "trace"; subTab = h.slice(8); if (subTab === "flow" || subTab === "events") { traceTab = subTab; store.set("traceTab", subTab); } }
    else if (h === "#/memory" || h.startsWith("#/memory/")) { next = "memory"; subTab = h.slice(9); if (["active", "notes", "archive"].includes(subTab)) { memTab = subTab; store.set("memTab", subTab); } }
    else if (h === "#/timers") next = "timers";
    else if (h === "#/hooks") next = "hooks";
    else if (h === "#/settings" || h.startsWith("#/settings/")) { next = "settings"; subTab = h.slice(11); if (subTab === "collie" || subTab === "local") { settingsTab = subTab; store.set("settingsTab", subTab); } }
    else if (h === "#/devices") next = "devices";
    else if (!narrow()) {
      // Desktop has no empty home: reopen where you were, else Collie.
      const last = store.get("last", "#/collie");
      const ok = last.startsWith("#/p/") ? !!find(decodeURIComponent(last.slice(4))) : /^#\/(collie|trace|memory|timers|hooks|settings|devices)(\/[a-z]+)?$/.test(last);
      location.replace(ok ? last : "#/collie");
      return;
    }
    if (next) store.set("last", h);
    if (next === view && id === (next === "ext" ? extCur : current)) {
      if (subTab && PANEL_VIEWS.has(next)) openPanel(next);
      return;
    }
    if (view === "ext" && (next !== "ext" || id !== extCur)) { closeExt(); }
    if (view === "pane" && (next !== "pane" || id !== current)) closeStream();
    if (PANEL_VIEWS.has(view) && next !== view) clearInterval(autoTimer);
    if (view === "devices" && next !== "devices") clearInterval(devTimer);
    view = next;
    current = next === "ext" ? null : id;
    extCur = next === "ext" ? id : null;
    document.body.classList.toggle("show-main", !!next);
    $("#v-collie").hidden = next !== "collie";
    $("#v-panel").hidden = !PANEL_VIEWS.has(next);
    $("#v-devices").hidden = next !== "devices";
    $("#v-ext").hidden = next !== "ext";
    $("#detail").hidden = next !== "pane";
    const activeViewEl = next === "collie" ? $("#v-collie") : PANEL_VIEWS.has(next) ? $("#v-panel") : next === "devices" ? $("#v-devices") : next === "ext" ? $("#v-ext") : next === "pane" ? $("#detail") : null;
    const slot = activeViewEl?.querySelector("[data-head-slot]"), topTools = $("#top-tools");
    if (slot && topTools && topTools.parentNode !== slot) slot.append(topTools);
    renderSide();
    if (next === "collie") { renderSuper(true); renderTarget(true); if (!narrow()) $("#super-input").focus(); }
    if (PANEL_VIEWS.has(next)) openPanel(next);
    if (next === "devices") openDevices();
    if (next === "ext") openExt(id);
    if (next === "pane") {
      $("#gone").hidden = true;
      resetChat();
      renderHead();
      openStream();
      if (!narrow()) $("#input").focus();
    }
  }
  addEventListener("hashchange", route);

  // ───────────────────────────── Collie (super-agent) view
  let superSig = "";
  const expandedEvents = new Set();
  const routerModelMachine = (r) => {
    if (r?.machine) return r.machine;
    const ms = runnableMachines();
    const rk = r?.kind === "antigravity" ? "agy" : r?.kind || "claude";
    return ms.find((m) => !m.agents || m.agents.includes(rk))?.id || ms[0]?.id || "";
  };
  // Which model Collie itself runs with, next to its status.
  async function renderRouterModel(r) {
    const el = $("#router-model");
    const rm = routerModelMachine(r);
    const key = [r.kind, rm, r.model, r.effort, r.pending].join("|");
    if (el._key === key) return;
    el._key = key;
    let model = r.model;
    if (!model && r.kind) model = (await modelsFor(r.kind === "antigravity" ? "agy" : r.kind, rm)).default || "";
    if (el._key !== key) return;
    const parts = [];
    if (model) parts.push(esc(model.split("/").pop()) + (r.model ? "" : "（默认）"));
    if (r.effort) parts.push("思考 " + esc(EFFORT_LABEL[r.effort] || r.effort));
    el.innerHTML = parts.join(" · ") + (r.pending ? ` <button type="button" class="pending" data-act="router-restart" title="Collie 的模型设置改过了，点这里重启 Collie">重启后生效</button>` : "");
    el.title = `Collie 自己用的模型${model ? "：" + model : ""}${r.effort ? "，思考强度 " + r.effort : ""}（点击可直接切换）`;
  }
  // A worker's comings and goings: its spawn line shows where it stands, and
  // a dialog waiting on the human shows as a card below. Reports and errors stay.
  const CHATTER = /\s(完成了一轮|等你确认|已停止|已退出|回来了（herdr 恢复了它的窗格）)$/;
  const workerChatter = (e) => e.ref && e.ref !== ROUTER && (e.tone === "done" || e.tone === "info" || e.tone === "blocked") && CHATTER.test(e.text);
  // Messages waiting for Collie itself (an older hub only counts them all).
  const routerQueued = () => sup.queued_router ?? sup.queued;
  // Messages you sent that the hub's stream hasn't shown yet.
  const pendingSays = [];
  // Older chat, loaded a page at a time when you ask: the hub only sends the
  // latest 200 lines. olderMore: whether there is more before that.
  let older = [], olderMore = null, olderBusy = false;
  function chatEntries() {
    const have = new Set(sup.entries.map((e) => e.id));
    for (let i = pendingSays.length - 1; i >= 0; i--) if (pendingSays[i].id && have.has(pendingSays[i].id)) pendingSays.splice(i, 1);
    const old = older.length ? older.filter((e) => !have.has(e.id)) : [];
    return old.length || pendingSays.length ? [...old, ...sup.entries, ...pendingSays] : sup.entries;
  }
  // More before what is shown? Until asked, guess from a full page.
  const canLoadOlder = () => olderMore ?? !!sup.earlier;
  async function loadOlder() {
    const first = chatEntries().find((e) => e.id);
    if (olderBusy || !first) return;
    olderBusy = true;
    renderSuper();
    const scroller = $("#super-thread").parentElement, fromBottom = scroller.scrollHeight - scroller.scrollTop;
    try {
      const r = await api(`/api/super/earlier?before=${encodeURIComponent(first.id)}`);
      older = [...(r.entries || []), ...older];
      olderMore = !!r.more;
    } catch (e) { toast(e.message, "attn"); }
    olderBusy = false;
    renderSuper();
    scroller.scrollTop = scroller.scrollHeight - fromBottom; // stay where you were reading
  }
  function renderSuper(force) {
    const r = sup.router || {};
    $("#router-kind").textContent = KIND_LABEL[r.kind] || r.kind || "claude";
    const whereEl = $("#router-where"), whereSep = $("#router-where-sep");
    const showWhere = r.machine ? machineName(r.machine) : ((state.machines || []).some((m) => !m.local) && !isAgentlessHub((state.machines || [])[0]) ? machineName("") : "");
    if (whereEl && whereSep) {
      whereEl.textContent = showWhere;
      whereEl.hidden = whereSep.hidden = !showWhere;
    }
    const st = $("#router-status");
    const showLive = !r.replied && (r.status === "working" || r.status === "starting" || r.status === "dreaming" || pendingSays.length > 0);
    st.className = "status " + collieDot(r.status);
    st.innerHTML = `<span class="dot ${esc(collieDot(r.status))}"></span>${esc(r.replied ? "在收尾" : collieStatus(r.status))}`;
    st.hidden = showLive && Boolean(sup.entries.length || pendingSays.length);
    $("#router-queue").textContent = sup.paused ? "已暂停投递" : routerQueued() ? `${routerQueued()} 条事件排队中` : "";
    const fl = $("#router-follow");
    if (fl) {
      if (sup.follow?.next) {
        fl.hidden = false;
        fl.textContent = `${whenShort(sup.follow.next)} 再看：${sup.follow.next_text || ""}`;
        fl.title = `Collie 设的下一次跟进（点击查看定时任务）：${sup.follow.next_text || ""}`;
      } else {
        fl.hidden = true;
      }
    }
    const cx = $("#router-ctx");
    if (r.handover) {
      cx.textContent = "正在交接记忆…";
    } else if (r.alive && r.context) {
      const pct = Math.min(100, Math.max(4, r.context));
      cx.innerHTML = `<span class="ctx-bar"><i style="width:${pct}%"></i></span>上下文 ${esc(r.context)}%`;
    } else {
      cx.textContent = "";
    }
    cx.classList.toggle("warn", !!r.handover || (r.rotate_at > 0 && r.context >= r.rotate_at - 10));
    cx.title = r.rotate_at > 0 ? `用到 ${r.rotate_at}% 时，Collie 会把要记住的事写进 memory/，然后换一个新会话` : "自动换会话已关闭（自动化 → 设置）";
    renderRouterModel(r);
    $$('[data-act="pause"]').forEach((b) => b.textContent = sup.paused ? "恢复投递" : "暂停投递");

    const active = sup.workers.filter((w) => !w.ended);
    if (view === "collie") renderTarget();
    const multiM = runnableMachines().length > 1 || (state.machines || []).some((m) => !m.local);
    $("#crew").innerHTML = active.length ? `<span class="crew-label">执行中</span>` + active.map((w) => {
      const pane = paneOf(w.name);
      const wWhere = multiM && w.machine ? `<span class="wm">@${esc(machineName(w.machine))}</span>` : "";
      const tip = [STATUS_LABEL[workerStatus(w)] || workerStatus(w), w.task || ""].filter(Boolean).join(" · ");
      return `<span class="chip-wrap"><a class="chip" ${pane ? `href="#/p/${encodeURIComponent(pane)}"` : ""} title="${esc(tip)}"><span class="dot ${esc(workerStatus(w))}"></span>${esc(w.name)}${wWhere}<span class="k">${esc(KIND_LABEL[w.kind] || w.kind)}</span></a><button type="button" class="chip-stop" data-stop-worker="${esc(w.name)}" title="停止 ${esc(w.name)}">×</button></span>`;
    }).join("") : "";

    const box = $("#super-thread");
    const scroller = box.parentElement;
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    let html = "", prevRole = "";
    if (!sup.entries.length && !pendingSays.length) {
      html = `<div class="hello"><img src="/icon.svg" alt="">
        <h3>一个总控台，调度所有电脑上的 Agent</h3>
        <p>直接把目标告诉 Collie。它会结合长期记忆理解上下文、拆解子任务，在你的 Mac、Windows 或开发机上并行调度 Claude、Codex 与 Antigravity，只在需要你拍板或验收时汇报。</p>
        <div class="ideas">
          <button data-idea="看一下最近改动最多的三个项目，各派一个 agent 检查有没有失败的测试，最后给我一句话总结。">并行检查多个仓库的测试与构建状态</button>
          <button data-idea="每天早上 9 点帮我看一下各台电脑上任务的进展，有卡住的就告诉我。">设置工作日常态化巡检与进度汇报</button>
          <button data-idea="以后 GitHub 上有人评论 @collie 的 issue，就派一个 agent 去复现，确认后再告诉我。">接入外部 Webhook 自动响应研发事件</button>
        </div></div>`;
    } else {
      let prev = "", lastAt = 0;
      let lastUser = "", sinceUser = 0, lastEvent = "", lastCollie = "", sinceCollie = 0, lastQuoted = "";
      const quote = (e) => {
        const q = e.re;
        if (!q) return "";
        if (q.entry && q.entry === lastUser && !sinceUser) return "";
        if (q.entry && q.entry === lastCollie && !sinceCollie) return "";
        if (q.entry && q.entry === lastQuoted) return "";
        if (q.worker && q.worker === lastEvent) return "";
        if (q.entry) lastQuoted = q.entry;
        const pane = q.worker && paneOf(q.worker), past = q.worker && !pane ? workerHist(q.worker, e.at) : null;
        const attr = q.entry ? `href="#" data-goto="${esc(q.entry)}"` : pane ? `href="#/p/${encodeURIComponent(pane)}"` : past ? `href="#/h/${encodeURIComponent(past.id)}"` : "";
        return `<a class="re" ${attr} title="${esc(q.text)}"><span class="re-who">${esc(q.who)}</span>${esc(plainLine(q.text))}</a>`;
      };
      const EV_BADGE = { spawn: "派出", done: "回报", blocked: "待确认", error: "异常" };
      for (const e of chatEntries()) {
        if (e.ref === ROUTER && e.tone === "info" && e.role !== "user" && e.role !== "collie") continue;
        if (e.role === "event" && workerChatter(e)) continue;
        const at = +new Date(e.at) || 0;
        const talk = e.role === "user" || e.role === "collie";
        const newDay = at && lastAt && new Date(at).toDateString() !== new Date(lastAt).toDateString();
        if (at && (newDay || (talk && (!lastAt || at - lastAt > 10 * 60e3)))) {
          html += `<div class="time-sep">${esc(sepTime(at))}</div>`;
          prev = "";
          lastQuoted = "";
        }
        if (at) lastAt = at;
        const cont = e.role === "collie" && prev === "collie";
        prev = prevRole = e.role;
        if (e.role === "user") {
          html += `<div class="mine"><div class="msg user" data-id="${esc(e.id)}"${at ? ` title="${esc(fullTime(at))}"` : ""}>${quote(e)}${userText(e.text)}</div>${mineActs(e, at)}</div>`;
          lastUser = e.id; sinceUser = 0; lastEvent = ""; sinceCollie++; lastQuoted = "";
        } else if (e.role === "collie") {
          html += `<div class="say${cont ? " cont" : ""}"><span class="avatar">${cont ? "" : `<img src="/icon.svg" alt="">`}</span><div class="msg assistant" data-id="${esc(e.id)}"${at ? ` title="${esc(fullTime(at))}"` : ""}>${quote(e)}${md(e.text)}${imagesIn(e.text)}${msgActs(e, at)}</div></div>`;
          sinceUser++; lastEvent = ""; lastCollie = e.id; sinceCollie = 0;
        } else {
          lastEvent = e.ref || "";
          const past = e.ref && e.ref !== ROUTER ? workerHist(e.ref, e.at) : null;
          const pane = !past && e.ref ? paneOf(e.ref) : null;
          const href = past ? `#/h/${encodeURIComponent(past.id)}` : pane ? `#/p/${encodeURIComponent(pane)}` : "";
          const w = e.tone === "spawn" ? sup.workers.find((x) => x.name === e.ref) : null;
          const busy = w && workerBusy(w);
          const stuck = w && !w.ended && w.status === "blocked";
          const isBlkReport = /\bBLOCKED:/i.test(e.text || "");
          const effTone = isBlkReport && e.tone === "done" ? "blocked" : e.tone;
          const tone = effTone === "blocked" ? "blocked" : effTone === "done" ? "done" : effTone === "spawn" ? (busy ? "working" : stuck ? "blocked" : "unknown") : effTone === "error" ? "failed" : "unknown";
          const wState = w ? (w.ended ? "已结束" : busy ? "运行中" : stuck ? "待确认" : "") : "";
          const badge = isBlkReport ? "受阻" : (EV_BADGE[effTone] || "轨迹");
          const toneCls = `tone-${esc(effTone || "info")}${effTone === "error" ? " error" : ""}`;
          const isLong = e.tone !== "error" && ((e.text || "").length > 62 || (e.text || "").includes("\n"));
          const isExp = isLong && expandedEvents.has(e.id);
          if (e.tone === "error" || isLong || !href) {
            const tail = `<span class="ev-tail">${wState ? `<span>${wState}</span>` : ""}${href ? `<a class="ev-open" href="${href}" title="查看完整会话">会话 →</a>` : isLong ? `<span>${isExp ? "收起" : "展开"}</span>` : ""}</span>`;
            html += `<div class="event ${toneCls}${isLong ? " expandable" : ""}${isExp ? " expanded" : ""}" ${isLong && e.id ? `data-ev-id="${esc(e.id)}"` : ""}><span class="dot ${tone}"></span><span class="when">${hhmm(e.at)}</span><span class="ev-badge">${badge}</span><span class="ev-text">${esc(e.text)}</span>${tail}</div>`;
          } else {
            const tail = `<span class="ev-tail">${wState ? `<span>${wState}</span>` : ""}<span class="ev-open">查看 →</span></span>`;
            html += `<a href="${href}" class="event ${toneCls}"><span class="dot ${tone}"></span><span class="when">${hhmm(e.at)}</span><span class="ev-badge">${badge}</span><span class="ev-text">${esc(e.text)}</span>${tail}</a>`;
          }
        }
      }
      if (!r.replied && (r.status === "working" || r.status === "starting" || r.status === "dreaming" || pendingSays.length)) {
        const liveLabel = r.status === "starting" ? "正在唤醒 Collie…" : r.status === "dreaming" ? "Collie 正在整理记忆，完成后自动醒来…" : "Collie 正在思考与编排…";
        const dotSt = collieDot(r.status === "idle" && pendingSays.length ? "working" : r.status);
        html += `<div class="collie-live"><span class="avatar"><img src="/icon.svg" alt=""></span><div class="collie-live-pill"><span class="dot ${esc(dotSt)}"></span><span>${liveLabel}</span></div></div>`;
      }
    }
    // Everything waiting on the human, in one place, answerable right here.
    const needs = state.agents.filter((a) => a.status === "blocked");
    if (needs.length) {
      html += `<div class="needs">` + needs.map((a) => {
        const got = superAsks.get(a.pane_id);
        if (!got || Date.now() - got.at > 4000) loadSuperAsk(a.pane_id);
        if (got?.a) return superAskHTML(got.a, a);
        return `<a class="need" href="#/p/${encodeURIComponent(a.pane_id)}">
        <span class="dot blocked"></span>
        <span class="body"><div class="name">${esc(title(a))} 等你确认</div><div class="sub">${esc(a.name === ROUTER ? "它停在一个对话框上，处理后才能继续" : (KIND_LABEL[a.kind] || a.kind) + " · " + tilde(a.cwd))}</div></span>
        <span class="go">处理 →</span></a>`;
      }).join("") + `</div>`;
    }
    if (olderBusy) html = `<div class="earlier-row">加载中…</div>` + html;
    if (html === superSig && !force) return;
    superSig = html;
    box.innerHTML = html;
    if (atBottom || force) scroller.scrollTop = scroller.scrollHeight;
  }
  $("#super-thread")._loadMore = () => canLoadOlder() && loadOlder();

  // The dialogs agents are stuck on, read from their screens (pane → {at, a}).
  const superAsks = new Map();
  async function loadSuperAsk(pane) {
    const prev = superAsks.get(pane);
    if (prev?.loading) return;
    superAsks.set(pane, { ...prev, at: Date.now(), loading: true });
    let a = null;
    try { const r = await api(paneURL(pane, "ask")); a = r.asking ? r.approval : null; } catch { a = prev?.a || null; }
    superAsks.set(pane, { at: Date.now(), a });
    if (JSON.stringify(a) !== JSON.stringify(prev?.a ?? null) && view === "collie") renderSuper();
  }
  setInterval(() => { if (view === "collie" && state.agents.some((x) => x.status === "blocked")) renderSuper(); }, 4000);
  function superAskHTML(a, agent) {
    const { q, blocks } = readDialog(a.question);
    const body = blocks.map((b) => b.code ? `<pre class="ctx-code">${esc(b.text)}</pre>` : `<p>${esc(b.text)}</p>`).join("");
    const choices = a.choices || [];
    return `<div class="ask" data-pane="${esc(agent.pane_id)}">
      <div class="ask-head"><span class="dot blocked"></span><span class="who">${esc(title(agent))}</span><span>需要你确认</span><span class="spacer"></span>
        <a href="#/p/${encodeURIComponent(agent.pane_id)}">打开 →</a></div>
      <div class="ask-q"><div class="q">${esc(q)}</div>${body ? `<div class="ctx">${body}</div>` : ""}</div>
      ${choices.length ? `<div class="choices">${choices.map((c, i) => `<button class="choice ${c.current ? "current" : ""}" data-choice="${i}">
          <span class="n">${esc(c.text || i + 1)}</span><span class="l">${esc(c.label)}${c.desc ? `<span class="d">${esc(c.desc)}</span>` : ""}</span></button>`).join("")}</div>
        <div class="ask-keys"><button data-k="esc">Esc 取消</button></div>`
      : `<div class="ask-keys"><button data-k="up">↑</button><button data-k="down">↓</button><button data-k="esc">Esc</button><button class="go" data-k="enter">确认 ↵</button></div>`}
    </div>`;
  }

  $("#crew")?.addEventListener("click", async (e) => {
    const stop = e.target.closest("[data-stop-worker]")?.dataset.stopWorker;
    if (!stop) return;
    e.preventDefault();
    if (!confirm(`停止任务「${stop}」？`)) return;
    try {
      await api("/api/super/stop", { body: { worker: stop } });
      toast(`已停止 ${stop}`);
    } catch (err) { toast(err.message, "attn"); }
  });

  $("#super-thread").addEventListener("click", (e) => {
    const idea = e.target.closest("[data-idea]")?.dataset.idea;
    if (idea) { $("#super-input").value = idea; grow($("#super-input")); $("#super-input").focus(); return; }
    const evRow = e.target.closest(".event.expandable[data-ev-id]");
    if (evRow && !e.target.closest("a")) {
      const eid = evRow.dataset.evId;
      if (expandedEvents.has(eid)) expandedEvents.delete(eid); else expandedEvents.add(eid);
      evRow.classList.toggle("expanded", expandedEvents.has(eid));
      const hint = evRow.querySelector(".ev-tail span:last-child");
      if (hint && !evRow.querySelector(".ev-open")) hint.textContent = expandedEvents.has(eid) ? "收起" : "展开";
      return;
    }
    // Answering a stuck agent from here.
    const b = e.target.closest("button"), card = b?.closest(".ask[data-pane]");
    if (!card) return;
    const pane = card.dataset.pane;
    const send = (kind, body) => api(paneURL(pane, kind), { body }).catch((err) => toast(err.message));
    if (b.dataset.choice != null) {
      const c = superAsks.get(pane)?.a?.choices?.[+b.dataset.choice];
      if (!c) return;
      if (c.text) send("text", { text: c.text }); else send("keys", { keys: c.keys || ["enter"] });
    } else if (b.dataset.k) send("keys", { keys: [b.dataset.k] });
    else return;
    card.style.opacity = ".5";
    superAsks.delete(pane);
  });

  // Models and thinking efforts each agent offers, per computer (asked once per page).
  const EFFORT_LABEL = { none: "关闭", minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "很高", max: "最高", ultra: "极致" };
  const modelInfo = {};
  async function modelsFor(kind, machine) {
    const key = kind + "@" + (machine || "");
    if (!modelInfo[key]) {
      const q = new URLSearchParams({ kind });
      if (machine) q.set("machine", machine);
      modelInfo[key] = api("/api/models?" + q).catch(() => ({ models: [], efforts: ["low", "medium", "high", "xhigh", "max"] }));
    }
    return modelInfo[key];
  }
  // Remember last selected model & effort per agent@machine across reloads.
  const modelMemKey = (kind, machine) => (kind === "antigravity" ? "agy" : kind || "claude") + "@" + (machine || "");
  const getSavedModel = (kind, machine) => store.get("lastModel", {})[modelMemKey(kind, machine)] || null;
  const saveLastModel = (kind, machine, model, effort) => {
    const map = { ...(store.get("lastModel", {}) || {}) };
    map[modelMemKey(kind, machine)] = { model: model || "", effort: effort || "" };
    store.set("lastModel", map);
  };

  // Inline header quick-switcher for Collie's own computer / agent / model / effort.
  async function toggleRouterPop(forceOpen) {
    const pop = $("#router-pop"), btn = $("#router-cfg-btn");
    if (!pop) return;
    const open = forceOpen === undefined ? pop.hidden : !!forceOpen;
    pop.hidden = !open;
    btn?.classList.toggle("open", open);
    if (!open) return;
    const f = $("#router-quick-form");
    let s;
    try { s = (await api("/api/super/settings")).settings; }
    catch (err) { toast(err.message, "attn"); pop.hidden = true; btn?.classList.remove("open"); return; }
    const ms = runnableMachines(s.router_machine || "");
    const mWrap = $("#rq-machine-wrap");
    const showM = ms.length > 1 || (state.machines || []).some((m) => !m.local);
    mWrap.hidden = !showM;
    $(".rp-grid", f)?.classList.toggle("three", !showM);
    f.router_machine.innerHTML = `<option value="" data-sub="优先选装了对应 agent 的在线电脑" ${!(s.router_machine || "") ? "selected" : ""}>自动选择</option>` +
      ms.map((m) => `<option value="${esc(m.id)}" data-os="${osKey(m.os)}" data-sub="${esc(m.local ? "hub" : m.os || "")}" ${m.id === (s.router_machine || "") ? "selected" : ""}>${esc(m.name)}</option>`).join("");
    const fillQuickKinds = () => {
      const selM = f.router_machine.value;
      const have = selM ? ms.find((m) => m.id === selM)?.agents
        : ms.length ? [...new Set(ms.flatMap((m) => Array.isArray(m.agents) ? m.agents : ["claude", "codex", "agy"]))] : null;
      const curK = f.router_kind.dataset.init ? f.router_kind.value : (s.router_kind || "claude");
      f.router_kind.dataset.init = "1";
      f.router_kind.innerHTML = [["claude", "Claude", "claude"], ["codex", "Codex", "codex"], ["antigravity", "Antigravity", "agy"], ["gemini", "Gemini", "gemini"]].map(([k, l, g]) => {
        const missing = Array.isArray(have) && !have.includes(g);
        return `<option value="${k}" data-glyph="${g}" ${missing ? 'data-sub="所选电脑未安装"' : ""} ${missing && k !== curK ? "disabled" : ""} ${k === curK ? "selected" : ""}>${l}</option>`;
      }).join("");
      if (f.router_kind.selectedOptions[0]?.disabled) {
        const okOpt = [...f.router_kind.options].find((o) => !o.disabled);
        if (okOpt) f.router_kind.value = okOpt.value;
      }
      syncPick(f.router_kind);
    };
    delete f.router_kind.dataset.init;
    fillQuickKinds();
    f.router_model.dataset.value = s.router_model || "";
    f.router_effort.dataset.value = s.router_effort || "";
    enhance(f.router_machine); enhance(f.router_kind); enhance(f.router_model); enhance(f.router_effort);
    syncPick(f.router_machine); syncPick(f.router_kind);
    await fillModels(f, "router");
    syncPick(f.router_model); syncPick(f.router_effort);
    if (!f._rqBound) {
      f._rqBound = true;
      f.router_machine.addEventListener("change", async () => { fillQuickKinds(); await fillModels(f, "router"); syncPick(f.router_model); syncPick(f.router_effort); });
      f.router_kind.addEventListener("change", async () => {
        const saved = getSavedModel(f.router_kind.value, f.router_machine.value);
        f.router_model.dataset.value = saved?.model || "";
        f.router_effort.dataset.value = saved?.effort || "";
        await fillModels(f, "router");
        syncPick(f.router_model); syncPick(f.router_effort);
      });
      f.router_model.addEventListener("change", () => setTimeout(() => { syncPick(f.router_model); syncPick(f.router_effort); }, 0));
    }
  }
  $("#router-cfg-btn")?.addEventListener("click", () => toggleRouterPop());
  $("#router-model")?.addEventListener("click", (e) => { if (!e.target.closest("[data-act]")) toggleRouterPop(); });
  $("#rq-cancel")?.addEventListener("click", () => toggleRouterPop(false));
  document.addEventListener("mousedown", (e) => {
    const pop = $("#router-pop");
    if (!pop || pop.hidden || pickOpen) return;
    if (!e.target.closest(".rp-card, #router-cfg-btn, #router-model, .pick-pop, [data-act='router-cfg']")) toggleRouterPop(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#router-pop")?.hidden && !pickOpen) toggleRouterPop(false);
  });
  $("#router-quick-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target, btn = $("#rq-save");
    btn.disabled = true; btn.textContent = "保存中…";
    try {
      const cur = (await api("/api/super/settings")).settings;
      const rModel = f.router_model.value === "__custom" ? "" : f.router_model.value;
      const rEffort = f.router_effort.value;
      const next = {
        ...cur,
        router_machine: f.router_machine.value,
        router_kind: f.router_kind.value,
        router_model: rModel,
        router_effort: rEffort,
      };
      if (f.sync_worker.checked) {
        next.worker_kind = f.router_kind.value;
        next.worker_model = rModel;
        next.worker_effort = rEffort;
        if (f.router_machine.value) next.worker_machine = f.router_machine.value;
        target = null;
        store.set("dispatchTarget", null);
      }
      saveLastModel(f.router_kind.value, f.router_machine.value, rModel, rEffort);
      const shouldRestart = !!(sup.router?.alive || sup.router?.status === "failed");
      const res = await api("/api/super/settings", { body: { settings: next, restart: shouldRestart } });
      sup.router = { ...sup.router, kind: next.router_kind, machine: next.router_machine || sup.router?.machine || "", model: next.router_model, effort: next.router_effort, pending: false };
      $("#router-model")._key = "";
      renderSuper(true);
      renderTarget(true);
      toggleRouterPop(false);
      toast(res.restarted ? "已切换，Collie 正在用新配置重启" : "已切换 Collie 的模型配置");
    } catch (err) { toast(err.message, "attn"); }
    finally { btn.disabled = false; btn.textContent = "保存并生效"; }
  });

  // "执行任务": where dispatched work runs. Remembers your last chosen computer,
  // agent, model, and effort across reloads, falling back to 自动化 → 设置 defaults.
  let target = store.get("dispatchTarget", null), targetDefault = null;
  const saveTarget = () => store.set("dispatchTarget", target && Object.keys(target).length ? target : null);
  async function renderTarget(fresh) {
    if (!targetDefault || fresh) {
      try {
        const s = (await api("/api/super/settings")).settings;
        targetDefault = { machine: s.worker_machine || "", kind: s.worker_kind === "antigravity" ? "agy" : s.worker_kind || "claude", model: s.worker_model || "", effort: s.worker_effort || "" };
      } catch { targetDefault ||= { machine: "", kind: "claude", model: "", effort: "" }; }
    }
    const effDefaultMachine = targetDefault.machine || preferredWorkMachine("");
    let ms = runnableMachines((target && target.machine) ?? effDefaultMachine);
    if (!ms.length) ms = state.machines || [{ id: "", name: "本机", local: true }];
    // Ensure target machine and agent are valid on available computers.
    let t = targetNow();
    if (!targetDefault.machine && !(target && "machine" in target) && effDefaultMachine) {
      t.machine = effDefaultMachine;
    }
    if (!ms.some((m) => m.id === t.machine)) {
      t.machine = ms[0]?.id || "";
    }
    const have = ms.find((m) => m.id === t.machine)?.agents;
    if (Array.isArray(have) && have.length && !have.includes(t.kind)) {
      const fallback = ["codex", "claude", "agy", "gemini"].find((k) => have.includes(k));
      if (fallback) t.kind = fallback;
    }
    const fill = (sel, html) => { if (sel._html !== html) { sel._html = html; sel.innerHTML = html; } };
    const mSel = $("#t-machine"), kSel = $("#t-kind");
    fill(mSel, ms.map((m) => `<option value="${esc(m.id)}" data-os="${osKey(m.os)}"
      data-sub="${m.local ? "hub" : m.os || ""}${m.id === targetDefault.machine ? " · 默认" : ""}" ${m.id === t.machine ? "selected" : ""}>${esc(m.name)}</option>`).join(""));
    fill(kSel, [["claude", "Claude"], ["codex", "Codex"], ["agy", "Antigravity"], ["gemini", "Gemini"]].map(([k, l]) => {
      const missing = Array.isArray(have) && !have.includes(k);
      const sub = [missing ? "这台电脑没装" : "", k === targetDefault.kind ? "默认" : ""].filter(Boolean).join(" · ");
      return `<option value="${k}" data-glyph="${k}" data-short="${KIND_LABEL[k]}" ${sub ? `data-sub="${sub}"` : ""} ${missing && k !== t.kind ? "disabled" : ""} ${k === t.kind ? "selected" : ""}>${l}</option>`;
    }).join(""));
    mSel.value = t.machine; kSel.value = t.kind;
    mSel.hidden = ms.length < 2;
    syncPick(mSel); syncPick(kSel);
    mSel._pick?.classList.toggle("changed", t.machine !== effDefaultMachine);
    kSel._pick?.classList.toggle("changed", t.kind !== targetDefault.kind);
    renderModelChips(t);
  }
  // Default model/effort for a given target: uses Settings default when on the
  // default agent, or your last remembered model for that agent@machine.
  const modelDefaults = (t) => t.kind === targetDefault.kind ? { model: targetDefault.model, effort: targetDefault.effort } : { model: "", effort: "" };
  const modelNow = (t) => {
    const d = modelDefaults(t);
    const mem = getSavedModel(t.kind, t.machine);
    return {
      model: t.model !== undefined ? t.model : (mem?.model ?? d.model),
      effort: t.effort !== undefined ? t.effort : (mem?.effort ?? d.effort),
      d,
    };
  };
  let chipSeq = 0;
  async function renderModelChips(resolvedT) {
    const seq = ++chipSeq, t = resolvedT || targetNow(), { model, effort, d } = modelNow(t);
    const mSel = $("#t-model"), eSel = $("#t-effort");
    const info = await modelsFor(t.kind, t.machine);
    if (seq !== chipSeq) return;
    const list = [...(info.models || [])];
    if (model && !list.some((m) => m.id === model)) list.unshift({ id: model });
    const short = (id) => id.split("/").pop();
    const mark = (v, dv) => (v === dv ? " · 默认" : "");
    const defShort = info.default ? short(info.default) : "默认模型";
    let html = `<option value="" data-short="${esc(defShort)}" data-sub="${esc(info.default ? "现在是 " + info.default + (d.model === "" ? " · 默认" : "") : "agent 自己的设置")}">默认${info.default ? "（" + esc(short(info.default)) + "）" : ""}</option>`;
    html += list.map((m) => `<option value="${esc(m.id)}" data-short="${esc(m.label && m.label.length <= 24 ? m.label : short(m.id))}" data-sub="${esc((m.label && m.label !== m.id ? m.id : "") + mark(m.id, d.model))}" ${m.id === model ? "selected" : ""}>${esc(m.label || m.id)}</option>`).join("");
    if (mSel._html !== html) { mSel._html = html; mSel.innerHTML = html; }
    mSel.value = model;
    const cur = list.find((m) => m.id === model);
    const effs = cur?.efforts?.length ? cur.efforts : (info.efforts || []);
    const eff = effs.includes(effort) ? effort : "";
    const defE = d.effort || info.default_effort || "";
    let ehtml = `<option value="" data-short="思考 · ${esc(EFFORT_LABEL[defE] || defE || "默认")}" data-sub="${esc(d.effort ? "派活默认" : "agent 自己的设置")}">默认（${esc(EFFORT_LABEL[defE] || defE || "agent 自己定")}）</option>`;
    ehtml += effs.map((e) => `<option value="${esc(e)}" data-short="思考 · ${esc(EFFORT_LABEL[e] || e)}" data-sub="${esc(e)}" ${e === eff ? "selected" : ""}>${esc(EFFORT_LABEL[e] || e)}</option>`).join("");
    if (eSel._html !== ehtml) { eSel._html = ehtml; eSel.innerHTML = ehtml; }
    eSel.value = eff === d.effort ? "" : eff;
    eSel.hidden = effs.length === 0;
    syncPick(mSel); syncPick(eSel);
    const mChanged = model !== d.model;
    const eChanged = eff !== d.effort && eff !== "";
    mSel._pick?.classList.toggle("changed", mChanged);
    eSel._pick?.classList.toggle("changed", eChanged);
    const effDefM = targetDefault.machine || preferredWorkMachine("");
    const anyChanged = t.machine !== effDefM || t.kind !== targetDefault.kind || mChanged || eChanged;
    const resetBtn = $("#t-reset");
    if (resetBtn) resetBtn.hidden = !anyChanged;
  }
  const pick = (o) => { target = { ...(target || {}), ...o }; saveTarget(); };
  $("#t-machine").addEventListener("change", (e) => {
    const m = e.target.value, k = $("#t-kind").value;
    const mem = getSavedModel(k, m);
    pick({ machine: m, model: mem?.model, effort: mem?.effort });
    renderTarget();
  });
  $("#t-kind").addEventListener("change", (e) => {
    const k = e.target.value, m = $("#t-machine").value;
    const mem = getSavedModel(k, m);
    pick({ kind: k, model: mem?.model, effort: mem?.effort });
    renderTarget();
  });
  $("#t-model").addEventListener("change", (e) => {
    const t = targetNow();
    const m = e.target.value;
    const { effort } = modelNow(t);
    saveLastModel(t.kind, t.machine, m, effort);
    pick({ machine: t.machine, kind: t.kind, model: m });
    renderModelChips();
  });
  $("#t-effort").addEventListener("change", (e) => {
    const t = targetNow();
    const { model } = modelNow(t);
    const ef = e.target.value || modelDefaults(t).effort;
    saveLastModel(t.kind, t.machine, model, ef);
    pick({ machine: t.machine, kind: t.kind, effort: ef });
    renderModelChips();
  });
  $("#t-reset")?.addEventListener("click", () => {
    target = null;
    saveTarget();
    const map = { ...(store.get("lastModel", {}) || {}) };
    if (targetDefault) delete map[modelMemKey(targetDefault.kind, targetDefault.machine)];
    store.set("lastModel", map);
    renderTarget();
  });
  const targetNow = () => {
    const d = targetDefault || { machine: "", kind: "claude", model: "", effort: "" };
    const t = { ...d };
    for (const [k, v] of Object.entries(target || {})) if (v !== undefined) t[k] = v;
    if (target && "kind" in target && t.kind !== d.kind) { t.model = target.model; t.effort = target.effort; }
    return t;
  };

  // Quoting one of Collie's messages: it rides along with what you send next.
  let replyTo = null;
  const setReply = (e) => {
    replyTo = e ? { entry: e.id, who: "Collie", text: e.text } : null;
    const box = $("#re-draft");
    box.hidden = !e;
    if (e) { $(".re-t", box).textContent = reLine(e.text); $("#super-input").focus(); }
  };
  const reLine = (t) => plainLine(t);
  $("#re-draft button").addEventListener("click", () => setReply(null));
  document.addEventListener("click", (ev) => {
    const b = ev.target.closest(".re-btn[data-re]");
    if (!b) return;
    const e = sup.entries.find((x) => x.id === b.dataset.re);
    if (e) setReply(e);
  });

  bindComposer($("#super-composer"), $("#super-input"), async (text) => {
    // Send whatever differs from Settings defaults (including remembered model/computer choices).
    const t = targetNow(), p = target || {}, d = targetDefault || { machine: "", kind: "claude", model: "", effort: "" };
    let ms = runnableMachines(t.machine);
    if (ms.length && !ms.some((m) => m.id === t.machine)) t.machine = ms[0].id;
    const have = ms.find((m) => m.id === t.machine)?.agents;
    if (Array.isArray(have) && have.length && !have.includes(t.kind)) {
      const fb = ["codex", "claude", "agy", "gemini"].find((k) => have.includes(k));
      if (fb) t.kind = fb;
    }
    const { model, effort, d: md } = modelNow(t);
    const sendMachine = ("machine" in p || t.machine !== d.machine) ? (t.machine || "local") : "";
    const sendKind = ("kind" in p || t.kind !== d.kind) ? t.kind : "";
    const sendModel = ("model" in p || sendKind || model !== md.model) ? model : "";
    const sendEffort = ("effort" in p || sendKind || effort !== md.effort) ? effort : "";
    const re = replyTo;
    setReply(null);
    // Your message shows at once; the hub's copy takes its place when it arrives.
    const mine = { id: "", role: "user", text, at: new Date().toISOString(), pending: true, re };
    pendingSays.push(mine);
    renderSuper(true);
    let r;
    try {
      r = await api("/api/super/say", { body: { text, re: re?.entry || "",
      machine: sendMachine,
      kind: sendKind,
      model: sendModel,
      effort: sendEffort } });
    } catch (err) {
      pendingSays.splice(pendingSays.indexOf(mine), 1);
      if (re && !replyTo) setReply(sup.entries.find((x) => x.id === re.entry));
      renderSuper(true);
      throw err;
    }
    // The hub's copy may already be here (its push beat the reply): swap now.
    mine.id = r?.entry || "";
    if (!mine.id || sup.entries.some((e) => e.id === mine.id)) { pendingSays.splice(pendingSays.indexOf(mine), 1); renderSuper(true); }
    if (!sup.router?.alive) toast("正在唤醒 Collie…");
  }, () => targetNow().machine);

  // ───────────────────────────── panel views (执行轨迹 / 长期记忆 / 定时任务 / 外部触发 / 设置)
  let traceTab = store.get("traceTab", "flow");     // "flow" | "events"
  let traceFilter = store.get("traceFilter", "all"); // "all" | "running" | "attn" | "done"
  let memTab = store.get("memTab", "active");       // "active" | "notes" | "archive"
  let settingsTab = store.get("settingsTab", "collie"); // "collie" | "local"
  const expandedTraceCards = new Set();
  let autoTimer;

  const PANEL_META = {
    trace: {
      name: "执行轨迹",
      sub: "还原每次派活从下发、跨机执行、回报到结束的完整任务流转链路",
      tabs: () => [["flow", "任务流转"], ["events", "底层事件流水"]],
      cur: () => traceTab,
      set: (t) => { traceTab = t; store.set("traceTab", t); },
    },
    memory: {
      name: "长期记忆",
      sub: "Collie 在新会话中自动继承的长期指令、进行中任务与经验笔记",
      tabs: () => [["active", "指令与在途任务"], ["notes", "经验笔记"], ["archive", "做梦整理与归档"]],
      cur: () => memTab,
      set: (t) => { memTab = t; store.set("memTab", t); },
    },
    timers: {
      name: "定时任务",
      sub: "周期巡检、每日提醒与延后跟进调度",
      tabs: null,
    },
    hooks: {
      name: "外部触发",
      sub: "接入 GitHub、飞书等外部 Webhook，并配置免唤醒过滤规则",
      tabs: null,
    },
    settings: {
      name: "设置",
      sub: "统一管理 Collie 全局中枢调度与当前设备的界面习惯",
      tabs: () => [["collie", "Collie 全局配置"], ["local", "本机界面与通知"]],
      cur: () => settingsTab,
      set: (t) => { settingsTab = t; store.set("settingsTab", t); },
    },
  };

  $("#panel-tabs").addEventListener("click", (e) => {
    const t = e.target.closest("button")?.dataset.tab;
    const meta = PANEL_META[view];
    if (!t || !meta?.tabs) return;
    meta.set(t);
    openPanel(view);
  });

  function openPanel(which = view) {
    const meta = PANEL_META[which];
    if (!meta) return;
    memEditing = false;
    const body = $("#panel-body");
    body._memSig = "";
    body._traceSig = "";
    body._timerSig = "";
    $("#panel-name").textContent = meta.name;
    $("#panel-sub").textContent = meta.sub;
    const tabsBar = $("#panel-tabs-bar"), tabsEl = $("#panel-tabs");
    if (meta.tabs) {
      const cur = meta.cur();
      tabsBar.hidden = false;
      tabsEl.innerHTML = meta.tabs().map(([k, l]) => `<button type="button" data-tab="${k}" class="${k === cur ? "on" : ""}">${l}</button>`).join("");
    } else {
      tabsBar.hidden = true;
      tabsEl.innerHTML = "";
    }
    clearInterval(autoTimer);
    loadPanel(which);
    if (which === "trace") autoTimer = setInterval(() => loadPanel("trace"), 3500);
    if (which === "memory") autoTimer = setInterval(() => { if (!memEditing) loadPanel("memory"); }, 5000);
    if (which === "timers") autoTimer = setInterval(() => {
      const f = $("#timer-form");
      if (!document.activeElement?.closest?.("#timer-form") && !f?.text?.value?.trim() && !(pickOpen && f?.contains(pickOpen))) loadPanel("timers");
    }, 8000);
  }

  async function loadPanel(which = view) {
    const body = $("#panel-body");
    if (!body || view !== which) return;
    try {
      if (which === "trace") {
        const r = await api("/api/super/triggers");
        if (view !== "trace") return;
        const triggers = r.triggers || [], threads = r.threads || [];
        const sig = traceTab + "|" + traceFilter + "|" + [...expandedTraceCards].join(",") + "|"
          + JSON.stringify(sup.workers.map((w) => [w.name, workerStatus(w), w.ended, w.last_report, w.report_at]))
          + "|" + triggers.slice(0, 40).map((t) => t.id + ":" + t.status).join(",");
        if (sig !== body._traceSig) {
          body._traceSig = sig;
          body.innerHTML = traceTab === "flow" ? traceFlowHTML(triggers, threads) : inboxHTML(triggers, threads);
        }
      } else if (which === "memory") {
        const r = await api("/api/super/memory");
        if (view !== "memory" || memEditing) return;
        const sig = memTab + "|" + JSON.stringify(r) + sup.workers.map((w) => w.name + ":" + workerStatus(w)).join();
        if (sig !== body._memSig) {
          const open = new Set([...body.querySelectorAll("details[open]")].map((d) => d.dataset.path || d.querySelector("summary")?.textContent));
          const first = !body._memSig;
          body._memSig = sig;
          body.innerHTML = memoryHTML(r, memTab);
          if (!first) body.querySelectorAll("details").forEach((d) => d.open = open.has(d.dataset.path || d.querySelector("summary")?.textContent));
        }
      } else if (which === "timers") {
        const r = await api("/api/super/timers");
        if (view !== "timers") return;
        const ts = r.timers || [];
        sup.timers = ts.filter((t) => t.enabled).length;
        renderSide();
        const sig = JSON.stringify(ts.map((t) => [t.id, t.enabled, t.next_run, t.spec, t.text, t.target])) + "|" + sup.workers.filter((w) => !w.ended).map((w) => w.name).join(",");
        if (sig !== body._timerSig) {
          body._timerSig = sig;
          body.innerHTML = timersHTML(ts);
        }
      } else if (which === "hooks") {
        const r = await api("/api/super/settings");
        if (view !== "hooks") return;
        body.innerHTML = hooksHTML(r);
      } else if (which === "settings") {
        if (settingsTab === "local") {
          body.innerHTML = prefsHTML();
        } else {
          const r = await api("/api/super/settings");
          if (view !== "settings" || settingsTab !== "collie") return;
          body.innerHTML = settingsHTML(r);
          api("/api/super/lark?fresh").then((l) => {
            const el = $("#lark-who");
            if (el) el.textContent = l.ready ? `发给 ${l.who || "lark-cli 登录的人"}（以机器人身份）` : `${l.problem}，所以不会发`;
          }).catch(() => {});
        }
      }
    } catch (err) { body.innerHTML = `<p class="panel-intro">${esc(err.message)}</p>`; }
  }

  function fmtDur(ms) {
    if (!(ms > 0)) return "";
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60), rs = s % 60;
    if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
    const h = Math.floor(m / 60), rm = m % 60;
    return rm ? `${h}h ${rm}m` : `${h}h`;
  }

  function traceFlowHTML(triggers, threads) {
    // Reconstruct every dispatched worker's full lifecycle from sup.workers + sup.entries + triggers.
    const workers = [...(sup.workers || [])].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const entriesAsc = [...(sup.entries || [])].sort((a, b) => new Date(a.at) - new Date(b.at));
    const trigsAsc = [...triggers].sort((a, b) => new Date(a.at) - new Date(b.at));

    const items = workers.map((w) => {
      const st = workerStatus(w);
      const createdMs = new Date(w.created_at).getTime();
      const pane = !w.ended && paneOf(w.name);
      const past = !pane && workerHist(w.name, w.created_at);
      const href = pane ? `#/p/${encodeURIComponent(pane)}` : past ? `#/h/${encodeURIComponent(past.id)}` : "";
      const isBlocked = st === "blocked" || /^BLOCKED:/i.test(w.last_report || "");
      const isFailed = st === "failed";
      const isLive = !w.ended && st !== "gone";
      const isWorking = isLive && (st === "working" || st === "starting" || st === "waiting" || st === "blocked");
      const hasOkReport = !!(w.last_report && !/^BLOCKED:/i.test(w.last_report));

      // Collect chronological lifecycle steps for this worker.
      const steps = [];
      // 1. Triggering user prompt right before spawn (within 5 minutes)
      const prevUser = [...entriesAsc].reverse().find((e) => e.role === "user" && new Date(e.at).getTime() <= createdMs + 2000 && createdMs - new Date(e.at).getTime() < 5 * 60 * 1000);
      if (prevUser) {
        steps.push({ cls: "", tag: "用户发起", text: plainLine(prevUser.text).slice(0, 140), at: prevUser.at });
      }
      // 2. Collie spawn step
      const targetStr = [KIND_LABEL[w.kind] || w.kind, w.model || (w.run && w.run[0]) || "默认模型"].filter(Boolean).join(" · ");
      steps.push({
        cls: "spawn",
        tag: "派发启动",
        text: `Collie 在 ${w.machine ? machineName(w.machine) : "本机"}（${tilde(w.cwd || "~")}）启动 ${w.name}（${targetStr}）`,
        at: w.created_at,
      });

      // 3. Intermediate triggers & events referencing this worker
      const seenTexts = new Set();
      let sawReport = false;
      for (const t of trigsAsc) {
        const tMs = new Date(t.at).getTime();
        if (tMs < createdMs - 1000) continue;
        const related = t.ref === w.name || t.from === w.name || (t.targets || []).includes(w.name);
        if (!related) continue;
        let body = String(t.text || "").replace(/^report from [^:]+:\s*/i, "").trim();
        if (!body || seenTexts.has(body.slice(0, 80))) continue;
        seenTexts.add(body.slice(0, 80));
        if (/is BLOCKED on a dialog in its terminal/i.test(body)) {
          const scrMatch = /Screen:\s*([\s\S]*?)(?:\nChoices:|\nIf the answer follows|$)/i.exec(body);
          const firstQ = (scrMatch ? scrMatch[1] : "").split("\n").map((l) => l.trim()).find(Boolean) || "终端弹出交互确认提示";
          steps.push({ cls: "blocked", tag: "终端待确认", text: firstQ, at: t.at });
        } else if (/^worker\s+\S+\s+exited\b/i.test(body) || /^worker\s+\S+\s+is back\b/i.test(body)) {
          continue;
        } else if (t.from === w.name || t.source === "worker") {
          const blk = /^BLOCKED:/i.test(body);
          sawReport = true;
          steps.push({ cls: blk ? "blocked" : "done", tag: blk ? "阻塞上报" : "结果回报", text: body, at: t.at });
        } else if ((t.targets || []).includes(w.name)) {
          if (/^You are worker\s/i.test(body)) continue;
          steps.push({ cls: "spawn", tag: "追加指令", text: body, at: t.at });
        }
      }

      // 4. Event entries (e.g., API error, crash, stop) from sup.entries
      for (const e of entriesAsc) {
        if (e.role !== "event" || e.ref !== w.name) continue;
        const eMs = new Date(e.at).getTime();
        if (eMs < createdMs - 1000) continue;
        if (/^派出\s/.test(e.text)) continue;
        const clean = e.text.trim();
        if (sawReport && /回报[:：]/.test(clean)) continue;
        if (/等你确认$/.test(clean) && steps.some((s) => s.tag === "终端待确认")) continue;
        if (seenTexts.has(clean.slice(0, 80))) continue;
        seenTexts.add(clean.slice(0, 80));
        const isBlkTxt = /\bBLOCKED:/i.test(clean);
        const cls = e.tone === "error" ? "err" : (e.tone === "blocked" || isBlkTxt) ? "blocked" : /回报/.test(clean) ? "done" : "";
        const tag = e.tone === "error" ? "运行异常" : e.tone === "blocked" ? "等待确认" : /已停止/.test(clean) ? "停止回收" : isBlkTxt ? "阻塞上报" : /回报/.test(clean) ? "结果回报" : "状态流转";
        if (/回报/.test(clean)) sawReport = true;
        steps.push({ cls, tag, text: clean.replace(new RegExp("^" + w.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*回报[:：]\\s*"), ""), at: e.at });
      }

      // Fallback if last_report wasn't already captured from triggers/events
      if (w.last_report && !sawReport && !seenTexts.has(w.last_report.trim().slice(0, 80))) {
        const blk = /^BLOCKED:/i.test(w.last_report);
        steps.push({ cls: blk ? "blocked" : "done", tag: blk ? "阻塞上报" : "结果回报", text: w.last_report.trim(), at: w.report_at && !w.report_at.startsWith("0001") ? w.report_at : w.created_at });
      }

      if (isWorking) {
        steps.push({ cls: st === "blocked" ? "blocked" : "work", tag: STATUS_LABEL[st] || "执行中", text: st === "blocked" ? "正在等待确认或外部输入…" : "正在目标电脑上执行…", at: new Date().toISOString(), live: true });
      } else if (isLive) {
        steps.push({ cls: "done", tag: "驻留待命", text: "本轮任务已跑完，会话仍在后台待命（可继续追问或点右上角停止回收）", at: new Date().toISOString(), live: true });
      }

      steps.sort((a, b) => new Date(a.at) - new Date(b.at));
      const endMs = isWorking ? Date.now() : Math.max(createdMs, ...steps.filter((s) => !s.live).map((s) => new Date(s.at).getTime()).filter((n) => !isNaN(n)));
      const dur = fmtDur(endMs - createdMs);
      const bucket = isWorking ? "running" : (isBlocked || isFailed) ? "attn" : "done";
      const badgeCls = isWorking ? "queued" : (isBlocked || isFailed) ? "candidate" : hasOkReport ? "" : "ignored";
      const badgeTxt = isWorking ? (STATUS_LABEL[st] || "执行中") : isFailed ? "执行异常" : isBlocked ? "阻塞结项" : isLive ? "已完成 · 待命" : hasOkReport ? "已回报结项" : "已结束";

      return { w, st, href, steps, dur, bucket, isLive, isWorking, isBlocked, isFailed, badgeCls, badgeTxt };
    });

    const counts = {
      all: items.length,
      running: items.filter((x) => x.bucket === "running").length,
      attn: items.filter((x) => x.bucket === "attn").length,
      done: items.filter((x) => x.bucket === "done").length,
    };
    const shown = traceFilter === "all" ? items : items.filter((x) => x.bucket === traceFilter);
    const customSubs = threads.filter((th) => th.subscribers?.length);

    return `
      <div class="trace-stats">
        <button type="button" class="trace-stat ${traceFilter === "all" ? "on" : ""}" data-tf="all">
          <span class="ts-num">${counts.all}</span><span class="ts-lab">全部任务轨迹</span>
        </button>
        <button type="button" class="trace-stat running ${traceFilter === "running" ? "on" : ""}" data-tf="running">
          <span class="ts-num">${counts.running}</span><span class="ts-lab"><span class="dot working"></span>正在执行</span>
        </button>
        <button type="button" class="trace-stat attn ${traceFilter === "attn" ? "on" : ""}" data-tf="attn">
          <span class="ts-num">${counts.attn}</span><span class="ts-lab"><span class="dot blocked"></span>异常 / 曾受阻</span>
        </button>
        <button type="button" class="trace-stat done ${traceFilter === "done" ? "on" : ""}" data-tf="done">
          <span class="ts-num">${counts.done}</span><span class="ts-lab"><span class="dot idle"></span>已结项</span>
        </button>
      </div>
      ${customSubs.length ? `<div class="card"><div class="card-h">活跃直连路由（外部会话绑定）</div><ul class="rows">${customSubs.map((th) => `<li class="row"><span class="badge queued">直达</span><div><div class="meta"><b>${esc(th.id)}</b><span>后续消息直达 → ${esc(th.subscribers.join(", "))}</span></div></div><span class="right">${when(th.last_at)}</span></li>`).join("")}</ul></div>` : ""}
      <div class="trace-list">
        ${shown.length ? shown.map(({ w, href, steps, dur, isLive, isWorking, isBlocked, isFailed, badgeCls, badgeTxt }) => {
          const key = w.name + "@" + w.created_at;
          const exp = expandedTraceCards.has(key);
          return `<article class="trace-card ${isWorking ? "is-live" : isFailed ? "is-failed" : isBlocked ? "is-blocked" : ""} ${exp ? "expanded" : ""}" data-tc="${esc(key)}">
            <header class="tc-head">
              <div class="tc-main">
                <div class="tc-title-row">
                  <span class="badge ${badgeCls}">${esc(badgeTxt)}</span>
                  <span class="tc-name">${esc(w.name)}</span>
                  <span class="tc-chip">${GLYPHS[w.kind === "antigravity" ? "agy" : w.kind] || ""}<span>${esc(KIND_LABEL[w.kind] || w.kind)}${w.model ? " · " + esc(w.model.split("/").pop()) : ""}</span></span>
                  <span class="tc-chip">${osGlyph((state.machines || []).find((m) => m.id === (w.machine || ""))?.os)}<span>${esc(w.machine ? machineName(w.machine) : "本机")}</span></span>
                </div>
                ${w.task ? `<div class="tc-task" title="点击展开/收起完整任务说明" data-act="tc-toggle">${esc(w.task)}</div>` : ""}
                <div class="tc-meta">
                  <span>目录 ${esc(tilde(w.cwd || "~"))}</span>
                  <span>发起于 ${when(w.created_at)}</span>
                  ${dur ? `<span>耗时 ${esc(dur)}</span>` : ""}
                  ${w.thread && w.thread !== "chat:main" ? `<span>来源 ${esc(w.thread)}</span>` : ""}
                </div>
              </div>
              <div class="tc-acts">
                ${w.task && w.task.length > 90 ? `<button type="button" class="btn ghost small" data-act="tc-toggle">${exp ? "收起指令" : "展开指令"}</button>` : ""}
                ${href ? `<a class="btn small" href="${href}">${isLive ? "查看实时对话 →" : "查看对话记录 →"}</a>` : ""}
                ${isLive ? `<button type="button" class="btn ghost small" data-stop-worker="${esc(w.name)}">停止</button>` : ""}
              </div>
            </header>
            <div class="tc-steps">
              ${steps.map((s) => `<div class="tc-step ${s.cls || ""}">
                <span class="s-dot"></span>
                <span class="s-tag">${esc(s.tag)}</span>
                <div class="s-body">${esc(s.text)}</div>
                <span class="s-time">${s.live ? "当前" : when(s.at)}</span>
              </div>`).join("")}
            </div>
          </article>`;
        }).join("") : `<div class="card"><div class="empty-state"><span class="es-ico"><svg viewBox="0 0 24 24"><circle cx="6" cy="6" r="2.2"/><circle cx="18" cy="12" r="2.2"/><circle cx="6" cy="18" r="2.2"/><path d="M8.2 6h4.3a3.5 3.5 0 0 1 3.5 3.5v.3M15.8 13.8v.7a3.5 3.5 0 0 1-3.5 3.5H8.2"/></svg></span><b>${items.length ? "当前筛选条件下暂无任务轨迹" : "还没有派发过跨机任务"}</b><span>${items.length ? "点击上方「全部任务轨迹」查看所有历史记录。" : "在「和 Collie 对话」中交代任务，这里会实时还原从拆解派发、跨机执行到结项回报的完整链路。"}</span></div></div>`}
      </div>`;
  }

  // ───────────────────────────── memory: what Collie keeps between sessions
  let memEditing = false;
  const kb = (n) => (n / 1024).toFixed(1) + " KB";
  const dayTime = (t) => {
    const d = new Date(t), today = new Date().toDateString(), tmr = new Date(Date.now() + 864e5).toDateString();
    const hm = d.toTimeString().slice(0, 5);
    return d.toDateString() === today ? "今天 " + hm : d.toDateString() === tmr ? "明天 " + hm : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  };
  const isDefaultSeedText = (name, text) => {
    const t = String(text || "").trim();
    if (name === "instructions.md") return !t || t === "# Instructions from the human";
    if (name === "notes/index.md") return !t || /^#\s*Notes\s+One line per file in this folder\.?$/i.test(t.replace(/\s+/g, " "));
    return !t;
  };
  function memoryHTML(r, tab = "active") {
    const files = r.files || [];
    const by = (f) => files.filter(f);
    const over = r.loaded > r.budget;
    const pct = Math.min(100, Math.max(2, Math.round(((r.loaded || 0) / Math.max(1, r.budget || 6144)) * 100)));
    const dreamSub = r.dreaming
      ? `<b>正在回顾近期对话并整合记忆…</b> 整理完成后自动恢复，期间发来的消息会安全排队。`
      : `上次整理：<b>${r.last_dream ? dayTime(r.last_dream) : "尚未执行"}</b> · 下次计划：<b>${r.next_dream ? dayTime(r.next_dream) : "已关闭"}</b>`;
    const firstLine = (t, dflt) => t.split("\n").filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/^[>*\-\s]+/, "").replace(/`|\*\*/g, "").trim()).find(Boolean) || dflt;
    const crew = (f) => {
      const latest = new Map();
      for (const w of sup.workers) if (!latest.has(w.name) || new Date(w.created_at) > new Date(latest.get(w.name).created_at)) latest.set(w.name, w);
      const ws = [...latest.values()].filter((w) => new RegExp(`(^|[^\\w-])${w.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(f.text));
      if (!ws.length) return "";
      return `<span class="mem-crew">${ws.map((w) => {
        const pane = !w.ended && paneOf(w.name), past = !pane && workerHist(w.name, w.created_at);
        const href = pane ? `#/p/${encodeURIComponent(pane)}` : past ? `#/h/${encodeURIComponent(past.id)}` : "";
        const st = workerStatus(w);
        return `<a ${href ? `href="${href}"` : ""} title="${esc((KIND_LABEL[w.kind] || w.kind) + " · " + (STATUS_LABEL[st] || st))}"><span class="dot ${esc(st)}"></span>${esc(w.name)}</a>`;
      }).join("")}</span>`;
    };
    const emptyIcon = '<svg viewBox="0 0 24 24"><path d="M5 4.5A2.5 2.5 0 0 1 7.5 2H19v18H7.5A2.5 2.5 0 0 0 5 22.5z"/><path d="M9 7h6M9 11h6"/></svg>';
    const card = (f, o = {}) => {
      const edit = !f.legacy && o.edit !== false;
      const seedOnly = isDefaultSeedText(f.name, f.text);
      const summarySub = seedOnly ? (o.seedHint || "尚未写入内容") : (o.sub ?? firstLine(f.text, ""));
      const viewBody = seedOnly
        ? `<div class="mem-seed-empty"><span>${esc(o.seedDesc || "尚未填写内容。点击右侧按钮即可直接编辑保存。")}</span>${edit ? `<button type="button" class="btn small" data-act="mem-edit">立即填写</button>` : ""}</div>`
        : md(f.text);
      return `<details class="mem-fold" ${o.open ? "open" : ""} data-path="${esc(f.name)}"><summary>
          <span class="mono mem-name">${esc(o.label || f.name)}</span><span class="grow">${esc(summarySub)}</span><span class="muted mono" style="font-size:11.5px">${kb(f.size)}</span></summary>
        <div class="mem-body msg assistant" data-view>${viewBody}</div>
        ${edit ? `<div class="mem-tools">${o.crew ? crew(f) : ""}<span class="muted grow">${esc(dayTime(f.mod))} 更新</span><button type="button" class="btn small" data-act="mem-edit">编辑</button></div>
        <form class="mem-edit" hidden><textarea name="text" spellcheck="false">${esc(f.text)}</textarea>
          <div class="form-actions"><span class="muted grow">保存后在 Collie 下次读取或开启新会话时立即生效。</span><button type="button" class="btn small" data-act="mem-cancel">取消</button><button class="btn primary small">保存修改</button></div></form>` : ""}
      </details>`;
    };
    const group = (title, note, list, o = {}) => list.length || o.always ? `<h4 class="mem-h">${title}<span class="muted">${note}</span></h4>
      <div class="card">${list.length ? list.map((f, i) => card(f, typeof o.card === "function" ? o.card(f, i) : o.card || {})).join("") : `<div class="empty-state"><span class="es-ico">${emptyIcon}</span><b>${esc(o.empty || "暂无记录")}</b>${o.emptySub ? `<span>${esc(o.emptySub)}</span>` : ""}</div>`}</div>` : "";
    const ins = by((f) => f.name === "instructions.md");
    const tasks = by((f) => /^tasks\/[^/]+\.md$/.test(f.name));
    const notes = by((f) => f.name.startsWith("notes/")).sort((a, b) => (a.name === "notes/index.md" ? -1 : b.name === "notes/index.md" ? 1 : a.name.localeCompare(b.name)));
    const done = by((f) => f.name.startsWith("tasks/done/")).sort((a, b) => new Date(b.mod) - new Date(a.mod));
    const msgs = by((f) => f.name === "messages.md");
    const legacy = by((f) => f.legacy);

    const statusBento = `<div class="mem-bento">
      <div class="mem-stat-card">
        <div class="mem-stat-top">
          <span class="mem-stat-label"><svg viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>夜间记忆整合（做梦）</span>
          <button type="button" class="btn small" data-act="dream-now" ${r.dreaming ? "disabled" : ""}>${r.dreaming ? "整理中…" : "立即整理记忆"}</button>
        </div>
        <div class="mem-stat-sub">${dreamSub}</div>
      </div>
      <div class="mem-stat-card">
        <div class="mem-stat-top">
          <span class="mem-stat-label"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M7 15h4M7 10h10"/></svg>新会话预载上下文预算</span>
          <span class="badge ${over ? "candidate" : "ok"}">${over ? "超出建议值" : "健康"}</span>
        </div>
        <div class="mem-meter-row"><span>${kb(r.loaded)} <small>/ 建议上限 ${kb(r.budget)}</small></span><small class="mono">${esc(tilde(r.dir))}/memory</small></div>
        <div class="mem-meter ${over ? "warn" : ""}"><i style="width:${pct}%"></i></div>
      </div>
    </div>`;

    if (tab === "notes") {
      return `<div class="panel-banner">
          <span class="pb-ico">${emptyIcon}</span>
          <div class="pb-body">
            <div class="pb-title">按需检索的经验知识库</div>
            <div class="pb-desc">沉淀各台电脑环境差异、常用仓库结构与排障经验。新会话启动仅加载目录索引 <code>index.md</code>，具体笔记按需读取，零多余 Token 开销。</div>
          </div>
          <span class="pb-pill">${notes.length} 篇笔记</span>
        </div>
        ${group("经验笔记", "index.md 为总索引，其余文件按主题归类", notes, { always: true, empty: "还没有沉淀的经验笔记", emptySub: "Collie 在跨机排障或执行长期任务后，会自动将值得复用的机器与项目经验归纳到这里。", card: (f) => ({ open: f.name === "notes/index.md", label: f.name.replace(/^notes\//, ""), seedHint: "目录索引为空", seedDesc: "当前还没有经验笔记条目。Collie 沉淀新笔记后会自动维护此目录索引，你也可以手动编写。" }) })}`;
    }
    if (tab === "archive") {
      return `${statusBento}
        ${r.dreams?.length ? `<h4 class="mem-h">做梦整理日记<span class="muted">每晚自动回顾对话、去重合并记忆的记录</span></h4><div class="card">${r.dreams.map((d, i) => `<details class="mem-fold" ${i === 0 ? "open" : ""}><summary><span class="mono mem-name">${esc(d.name.replace(/\.md$/, ""))}</span><span class="grow">${esc(firstLine(d.text, d.name))}</span></summary><div class="mem-body msg assistant">${md(d.text)}</div></details>`).join("")}</div>` : `<h4 class="mem-h">做梦整理日记<span class="muted">每晚自动回顾对话、去重合并记忆的记录</span></h4><div class="card"><div class="empty-state"><span class="es-ico"><svg viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg></span><b>还没有做梦整理记录</b><span>当天有新对话时，Collie 会在凌晨自动回顾对话并精简长期记忆，也可点击上方「立即整理记忆」手动触发。</span></div></div>`}
        ${group("已结项任务归档", "已完成或中止的历史任务记录", done, { always: true, empty: "暂无已归档任务", emptySub: "跨轮跟进的任务在结项后会自动移入此处留档备查。", card: (f) => ({ label: f.name.replace(/^tasks\/done\//, ""), crew: true }) })}
        ${group("最近回复摘录", "Hub 自动记录最近 10 条，新会话每次必读，避免重复汇报", msgs, { card: { edit: false, label: "messages.md" } })}`;
    }
    return `${statusBento}
      ${legacy.length ? group("旧版记忆", "等下次做梦或换会话时拆进 memory/", legacy, { card: { open: true } }) : ""}
      ${group("长期指令", "你的长期习惯、偏好与自动化规则，每次新会话必读", ins, { card: { open: true, label: "instructions.md", sub: "", seedHint: "尚未配置偏好指令", seedDesc: "尚未写入长期偏好指令。点击右侧可写下你的常用习惯（如默认语言、代码规范、某类事件的处理原则），Collie 每次开启新会话都会自动遵守。" }, always: true, empty: "还没有长期指令" })}
      ${group("进行中的任务", "跨多轮跟进的在途事项，每次新会话必读", tasks, { card: { label: undefined, crew: true }, always: true, empty: "当前没有跨会话跟进中的在途任务", emptySub: "当你向 Collie 交代需要多步跟进或跨电脑协作的复杂事项时，它会自动在此建立任务跟踪卡。" })}`;
  }

  function inboxHTML(ts, ths = []) {
    return `<div class="panel-banner">
        <span class="pb-ico"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg></span>
        <div class="pb-body">
          <div class="pb-title">底层触发器事件总线</div>
          <div class="pb-desc">按时间倒序记录聊天输入、子 Agent 回报、系统巡检与外部 Webhook 原始流水，用于诊断调度细节。</div>
        </div>
        <span class="pb-pill">${ts.length} 条记录</span>
      </div>
      <div class="card"><div class="card-h"><span class="card-h-main">最近触发事件</span><span class="card-h-sub">最新在前</span></div><ul class="rows">${ts.length ? ts.map((t) => `<li class="row">
        <span class="badge ${esc(t.status === "queued" ? "queued" : t.status === "ignored" ? "ignored" : t.action === "candidate" ? "candidate" : "")}">${esc({ queued: "排队", delivered: "已投递", ignored: "已忽略" }[t.status] || t.status)}</span>
        <div><div class="meta"><b>#${esc(t.id)}</b><span>${esc(SOURCE_LABEL[t.source] || t.source)}</span><span>${esc(t.thread)}</span>${t.from ? `<span>来自 ${esc(t.from === ROUTER ? "Collie" : t.from)}</span>` : ""}${t.targets?.length ? `<span>→ ${esc(t.targets.map((x) => x === ROUTER ? "Collie" : x).join(", "))}</span>` : ""}${t.action === "candidate" ? "<span>按需判断</span>" : ""}</div>
        <div class="text">${esc(t.text)}</div></div>
        <span class="right">${when(t.at)}</span></li>`).join("") : `<li class="empty-row">暂无事件记录</li>`}</ul></div>
      ${ths.length > 1 ? `<div class="card"><div class="card-h">会话路由通道（Threads）</div><ul class="rows">${ths.map((th) => `<li class="row">
        <span class="badge">${th.triggers?.length || 0} 条</span>
        <div><div class="meta"><b>${esc(th.id)}</b>${th.subscribers?.length ? `<span>直连订阅：${esc(th.subscribers.join(", "))}</span>` : "<span>默认交由 Collie 处理</span>"}</div></div>
        <span class="right">${when(th.last_at)}</span></li>`).join("")}</ul></div>` : ""}`;
  }

  // ───────────────────────────── timers: picked, not typed
  const WEEK = [["mon", "一"], ["tue", "二"], ["wed", "三"], ["thu", "四"], ["fri", "五"], ["sat", "六"], ["sun", "日"]];
  const UNIT = { m: "分钟", h: "小时" };
  // describeSpec turns "weekly mon,thu 09:00" into "每周一、四 09:00".
  function describeSpec(spec) {
    const f = String(spec || "").trim().split(/\s+/);
    const dur = (d) => {
      const m = /^(\d+(?:\.\d+)?)([mhs])$/.exec(d || "");
      if (!m) return d;
      const n = +m[1];
      if (m[2] === "h" && n >= 24 && n % 24 === 0) return `${n / 24} 天`;
      if (m[2] === "m" && n >= 60 && n % 60 === 0) return `${n / 60} 小时`;
      return `${n} ${UNIT[m[2]] || "秒"}`;
    };
    switch (f[0]) {
      case "daily": return `每天 ${f[1]}`;
      case "weekdays": return `工作日 ${f[1]}`;
      case "weekly": return `每周${(f[1] || "").split(",").map((d) => (WEEK.find((w) => w[0] === d) || [, d])[1]).join("、")} ${f[2] || ""}`;
      case "every": return `每隔 ${dur(f[1])}`;
      case "in": return `${dur(f[1])}后（一次）`;
      case "at": return `${f[1]} ${f[2] || ""}（一次）`;
    }
    return spec;
  }
  const pad2 = (n) => String(n).padStart(2, "0");
  const localStamp = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  // The spec the timer form describes, or an error to show.
  function timerSpec(f) {
    const mode = f.dataset.mode, clock = f.clock.value;
    if (["daily", "weekdays", "weekly"].includes(mode) && !/^\d\d:\d\d$/.test(clock)) return { err: "选一个时间" };
    if (mode === "daily") return { spec: `daily ${clock}` };
    if (mode === "weekdays") return { spec: `weekdays ${clock}` };
    if (mode === "weekly") {
      const days = [...f.querySelectorAll(".tm-days button.on")].map((b) => b.dataset.day);
      return days.length ? { spec: `weekly ${days.join(",")} ${clock}` } : { err: "选至少一天" };
    }
    if (mode === "every") {
      const n = Math.floor(+f.every_n.value);
      if (!(n >= 1)) return { err: "间隔至少 1" };
      const u = f.every_u.value;
      return { spec: u === "d" ? `every ${n * 24}h` : `every ${n}${u}` };
    }
    const at = f.at.value;
    if (!at) return { err: "选一个日期和时间" };
    if (new Date(at) <= new Date()) return { err: "这个时间已经过去了" };
    return { spec: `at ${at.replace("T", " ")}` };
  }
  function syncTimerForm(f) {
    const mode = f.dataset.mode;
    f.querySelectorAll(".tm-mode button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
    f.querySelectorAll("[data-show]").forEach((el) => { el.hidden = !el.dataset.show.split(" ").includes(mode); });
    const r = timerSpec(f), target = f.target.selectedOptions[0]?.textContent || "Collie";
    const sum = f.querySelector(".tm-sum");
    sum.textContent = r.err ? r.err : `${describeSpec(r.spec)} · 交给 ${target.replace(/（.*）/, "")}`;
    sum.classList.toggle("err", !!r.err);
  }

  function timersHTML(ts) {
    const soon = new Date(Date.now() + 60 * 60 * 1000); soon.setMinutes(0);
    setTimeout(() => { const f = $("#timer-form"); if (f) syncTimerForm(f); });
    const clockIco = '<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="8"/><path d="M12 9v4.2l2.8 1.8M9.5 2h5"/></svg>';
    const activeCnt = ts.filter((t) => t.enabled).length;
    return `<div class="panel-banner">
        <span class="pb-ico">${clockIco}</span>
        <div class="pb-body">
          <div class="pb-title">周期巡检与延后跟进调度</div>
          <div class="pb-desc">到点自动向 Collie（或指定运行中的子 Agent）投递提醒或巡检任务；Collie 在执行长耗时任务时也会自主创建跟进闹钟。</div>
        </div>
        <span class="pb-pill">${activeCnt ? `${activeCnt} 个启用中` : "空闲"}</span>
      </div>
      <div class="card">
        <div class="card-h"><span class="card-h-main">${clockIco}<span>新建定时调度</span></span><span class="card-h-sub">支持循环周期或单次延时</span></div>
        <div class="tm-presets">
          <span>常用模板：</span>
          <button type="button" class="tm-preset-btn" data-tm-preset="weekdays|09:00||检查各台电脑上进行中任务的进展，有卡住或报错的汇总告诉我">+ 工作日 09:00 晨间巡检</button>
          <button type="button" class="tm-preset-btn" data-tm-preset="every||2h|检查当前运行中的长耗时训练或构建任务是否正常，无异常则无需打扰">+ 每 2 小时检查长任务</button>
          <button type="button" class="tm-preset-btn" data-tm-preset="once||30|提醒我查看刚才派发任务的最新进展与结果">+ 30 分钟后提醒跟进</button>
        </div>
        <form class="form tm-form" id="timer-form" data-mode="weekdays">
          <div class="tm-row"><span class="tm-lab">触发频率</span>
            <div class="seg tm-mode">${[["daily", "每天"], ["weekdays", "工作日"], ["weekly", "每周"], ["every", "每隔"], ["once", "单次"]].map(([m, l]) => `<button type="button" data-mode="${m}">${l}</button>`).join("")}</div>
          </div>
          <div class="tm-row tm-when">
            <span class="tm-lab">执行时间</span>
            <div class="tm-days" data-show="weekly">${WEEK.map(([d, l], i) => `<button type="button" data-day="${d}" class="${i === 0 ? "on" : ""}">${l}</button>`).join("")}</div>
            <input type="time" name="clock" value="09:00" data-show="daily weekdays weekly">
            <span class="tm-every" data-show="every"><input type="number" name="every_n" min="1" value="2"><select name="every_u" data-title="时间单位"><option value="m">分钟</option><option value="h" selected>小时</option><option value="d">天</option></select></span>
            <span class="tm-once" data-show="once"><input type="datetime-local" name="at" value="${localStamp(soon)}">
              ${[["30 分钟后", 30], ["1 小时后", 60], ["明早 9 点", "am"]].map(([l, v]) => `<button type="button" class="chip-btn" data-at="${v}">${l}</button>`).join("")}</span>
          </div>
          <label class="tm-text"><span class="tm-lab">指令内容</span><textarea name="text" rows="2" placeholder="例如：检查各个项目任务的进展，有卡住或需要我确认的汇总告诉我" required></textarea></label>
          <div class="tm-foot">
            <label class="tm-target"><span class="tm-lab" style="width:auto">投递目标</span><select name="target" data-title="到点交给谁"><option value="" data-sub="由协调中枢决定如何拆解与执行">Collie</option>${sup.workers.filter((w) => !w.ended).map((w) => `<option value="${esc(w.name)}" data-sub="${esc(KIND_LABEL[w.kind] || w.kind)}">${esc(w.name)}</option>`).join("")}</select></label>
            <span class="tm-sum"></span>
            <button class="btn primary small">创建定时</button>
          </div>
        </form>
      </div>
      <div class="card">
        <div class="card-h"><span class="card-h-main">已配置的定时任务</span><span class="card-h-sub">${ts.length ? `共 ${ts.length} 项` : "暂无任务"}</span></div>
        ${ts.length ? `<ul class="rows">${ts.map((t) => `<li class="row">
          <span class="badge ${t.enabled ? "queued" : "ignored"}">${t.enabled ? "启用中" : "已结束"}</span>
          <div><div class="meta"><b title="${esc(t.spec)}">${esc(describeSpec(t.spec))}</b><span>→ ${esc(t.target || "Collie")}</span>${t.enabled ? `<span>下次触发：${when(t.next_run)}</span>` : ""}${t.owner ? `<span>${t.owner === "you" ? "手动创建" : esc(t.owner) + " 创建"}</span>` : ""}</div>
          <div class="text">${esc(t.text)}</div></div>
          <button class="btn ghost small" data-del-timer="${esc(t.id)}">删除</button></li>`).join("")}</ul>`
        : `<div class="empty-state"><span class="es-ico">${clockIco}</span><b>还没有配置定时任务</b><span>可在上方直接点击「常用模板」一键填入，或在聊天中直接对 Collie 说「每天早上 9 点帮我检查一次进展」。</span></div>`}
      </div>`;
  }
  // Timer form: mode, days, presets and quick times are buttons; everything re-describes the spec.
  $("#panel-body").addEventListener("click", (e) => {
    const presetBtn = e.target.closest("[data-tm-preset]");
    if (presetBtn) {
      const f = $("#timer-form");
      if (!f) return;
      const [mode, clock, extra, text] = presetBtn.dataset.tmPreset.split("|");
      f.dataset.mode = mode;
      if (clock) f.clock.value = clock;
      if (mode === "every" && extra) {
        const m = /^(\d+)([mhd])$/.exec(extra);
        if (m) { f.every_n.value = m[1]; f.every_u.value = m[2]; syncPick(f.every_u); }
      } else if (mode === "once" && extra) {
        const d = new Date(Date.now() + (+extra || 30) * 60000);
        f.at.value = localStamp(d);
      }
      f.text.value = text || "";
      syncTimerForm(f);
      f.text.focus();
      return;
    }
    const f = e.target.closest("#timer-form");
    if (!f) return;
    const b = e.target.closest("button[type=button]");
    if (!b) return;
    if (b.dataset.mode) f.dataset.mode = b.dataset.mode;
    if (b.dataset.day) {
      b.classList.toggle("on");
    }
    if (b.dataset.at) {
      let d = new Date();
      if (b.dataset.at === "am") { d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); }
      else d = new Date(d.getTime() + +b.dataset.at * 60000);
      f.at.value = localStamp(d);
    }
    syncTimerForm(f);
  });
  $("#panel-body").addEventListener("input", (e) => { const f = e.target.closest("#timer-form"); if (f) syncTimerForm(f); });
  $("#panel-body").addEventListener("change", (e) => { const f = e.target.closest("#timer-form"); if (f) syncTimerForm(f); });

  function hooksHTML(r) {
    const base = location.origin + "/hooks/";
    const url = (src) => `${base}${src}?key=${r.hook_key}`;
    const curlCmd = `curl -X POST '${url("ci")}' -H 'Content-Type: application/json' -d '{"thread":"build-42","text":"nightly build failed"}'`;
    const copySvg = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
    const linkIco = '<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.07 0l2.12-2.12a5 5 0 0 0-7.07-7.07L10.7 5.2"/><path d="M14 11a5 5 0 0 0-7.07 0L4.8 13.1a5 5 0 0 0 7.07 7.07l1.41-1.41"/></svg>';
    return `<div class="panel-banner">
        <span class="pb-ico">${linkIco}</span>
        <div class="pb-body">
          <div class="pb-title">外部事件网关与零 Token 噪音拦截</div>
          <div class="pb-desc">将 GitHub、飞书或自定义 CI 事件接入 Collie。所有请求入口毫秒级返回 <code>202 Accepted</code>，并在 Go 网关层先经过滤规则筛选，无关噪音不唤醒大模型。</div>
        </div>
        <span class="pb-pill">202 Fast-Ingress</span>
      </div>
      <div class="card">
        <div class="card-h"><span class="card-h-main">${linkIco}<span>Webhook 专属接入地址</span></span><span class="card-h-sub">附带独立鉴权密钥</span></div>
        <div class="hook-ep-list">
          <div class="hook-ep">
            <span class="hook-ep-ico"><svg viewBox="0 0 24 24"><circle cx="6" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="8" r="2.2"/><path d="M6 8.2v7.6M18 10.2v1.3a3.5 3.5 0 0 1-3.5 3.5H6"/></svg></span>
            <div class="hook-ep-main">
              <div class="hook-ep-head"><b>GitHub 仓库事件</b><span class="ep-tag">application/json</span><small>仓库 Settings → Webhooks 粘贴即可</small></div>
              <div class="code"><span>${esc(url("github"))}</span><button type="button" class="icon-btn" data-copy="${esc(url("github"))}" title="复制 GitHub Webhook 地址">${copySvg}</button></div>
            </div>
          </div>
          <div class="hook-ep">
            <span class="hook-ep-ico"><svg viewBox="0 0 24 24"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/></svg></span>
            <div class="hook-ep-main">
              <div class="hook-ep-head"><b>飞书 / Lark 事件订阅</b><span class="ep-tag">url_verification</span><small>开放平台事件订阅请求地址，自动通过握手校验</small></div>
              <div class="code"><span>${esc(url("feishu"))}</span><button type="button" class="icon-btn" data-copy="${esc(url("feishu"))}" title="复制飞书订阅地址">${copySvg}</button></div>
            </div>
          </div>
          <div class="hook-ep">
            <span class="hook-ep-ico"><svg viewBox="0 0 24 24"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg></span>
            <div class="hook-ep-main">
              <div class="hook-ep-head"><b>通用 HTTP / CI 脚本触发</b><span class="ep-tag">POST JSON</span><small>路径末尾名称（如 <code>ci</code>）自动作为事件 source</small></div>
              <div class="code"><span>${esc(curlCmd)}</span><button type="button" class="icon-btn" data-copy="${esc(curlCmd)}" title="复制 curl 示例命令">${copySvg}</button></div>
            </div>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-h"><span class="card-h-main"><svg viewBox="0 0 24 24"><path d="M3 5h18l-7 8.2V19l-4 2v-7.8Z"/></svg><span>事件过滤规则（免唤醒省 Token）</span></span><button type="button" class="btn small" id="add-policy">+ 添加规则</button></div>
        <div class="policy-presets">
          <span>快捷预设：</span>
          <button type="button" class="chip-btn" data-preset-source="webhook:github" data-preset-action="candidate">+ GitHub 按需判断</button>
          <button type="button" class="chip-btn" data-preset-source="webhook:feishu" data-preset-action="respond">+ 飞书消息必回</button>
          <button type="button" class="chip-btn" data-preset-source="webhook:ci" data-preset-action="ignore">+ 屏蔽 CI 噪音</button>
        </div>
        <div class="policy-cols"><span>事件来源（Source）</span><span>网关处理策略</span><span>发送人白名单（可选）</span><span></span></div>
        <div id="policies">${(r.policies || []).map(policyRow).join("")}</div>
        <div class="card-foot">
          <p><b>直接忽略</b> 在网关层直接丢弃（0 Token）；<b>按需判断</b> 仅在命中你的长期指令时才行动；<b>直接响应</b> 每次必唤醒 Collie 处理。</p>
          <button type="button" class="btn primary small" id="save-policies">保存过滤规则</button>
        </div>
      </div>`;
  }

  function policyRow(p = { source: "webhook:", action: "candidate", allow: [] }) {
    return `<div class="policy">
      <input data-f="source" class="mono" value="${esc(p.source)}" placeholder="webhook:github">
      <select data-f="action" data-title="网关处理策略">${["respond", "candidate", "ignore"].map((a) => `<option value="${a}" ${p.action === a ? "selected" : ""}>${{ respond: "直接响应（必唤醒）", candidate: "按需判断（省打扰）", ignore: "直接忽略（0 Token）" }[a]}</option>`).join("")}</select>
      <input data-f="allow" value="${esc((p.allow || []).join(", "))}" placeholder="白名单账号（逗号分隔，留空不限）">
      <button type="button" class="icon-btn" data-del-policy title="删除此规则"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>`;
  }

  // ───────────────────────────── settings: grouped by what they are about
  // Fills a model picker and its effort picker from what that agent offers.
  async function fillModels(form, who) {
    const kindSel = form[who + "_kind"], modelSel = form[who + "_model"], effSel = form[who + "_effort"];
    const kShort = kindSel.value === "antigravity" ? "agy" : kindSel.value;
    let machine = "";
    if (who === "worker" && form.worker_machine) {
      machine = form.worker_machine.value;
    } else if (who === "router") {
      machine = form.router_machine ? form.router_machine.value : "";
      if (!machine) {
        const ms = runnableMachines();
        machine = ms.find((m) => !m.agents || m.agents.includes(kShort))?.id || ms[0]?.id || "";
      }
    }
    const want = modelSel.dataset.value ?? modelSel.value, wantEff = effSel.dataset.value ?? effSel.value;
    modelSel.innerHTML = `<option value="">读取中…</option>`;
    syncPick(modelSel);
    const info = await modelsFor(kShort, machine);
    const list = [...(info.models || [])];
    if (want && !list.some((m) => m.id === want)) list.unshift({ id: want });
    const sub = (m) => [m.label && m.label !== m.id ? m.id : "", m.note && m.note !== m.id && !(m.label && m.note.startsWith(m.label)) ? m.note : ""].filter(Boolean).join(" · ");
    modelSel.innerHTML = `<option value="" data-sub="${esc(info.default ? "现在是 " + info.default : "用 agent 自己的设置")}">默认${info.default ? "（" + esc(info.default.split("/").pop()) + "）" : ""}</option>`
      + list.map((m) => `<option value="${esc(m.id)}" data-sub="${esc(sub(m))}" ${m.id === want ? "selected" : ""}>${esc(m.label || m.id)}</option>`).join("")
      + `<option value="__custom" data-sub="输入列表里没有的模型名">其他…</option>`;
    delete modelSel.dataset.value;
    const fillEffort = () => {
      const m = list.find((x) => x.id === modelSel.value);
      const effs = m?.efforts?.length ? m.efforts : (info.efforts || []);
      const cur = effSel.dataset.value ?? effSel.value;
      effSel.innerHTML = `<option value="" data-sub="${esc(info.default_effort ? "现在是 " + (EFFORT_LABEL[info.default_effort] || info.default_effort) : "用 agent 自己的设置")}">默认${info.default_effort ? "（" + esc(EFFORT_LABEL[info.default_effort] || info.default_effort) + "）" : ""}</option>`
        + effs.map((e) => `<option value="${esc(e)}" data-sub="${esc(e)}" ${e === cur ? "selected" : ""}>${esc(EFFORT_LABEL[e] || e)}</option>`).join("");
      delete effSel.dataset.value;
      effSel.disabled = effs.length === 0;
      syncPick(effSel);
    };
    fillEffort();
    syncPick(modelSel);
    modelSel.onchange = () => {
      if (modelSel.value === "__custom") {
        const v = (prompt("模型名（照 agent 的 --model 参数写）") || "").trim();
        if (v) modelSel.add(new Option(v, v, true, true), 1);
        else modelSel.value = "";
      }
      fillEffort();
      syncPick(modelSel);
    };
  }
  function bindSettings(form) {
    if (!form || form._bound) return;
    form._bound = true;
    for (const who of ["router", "worker"]) {
      fillModels(form, who);
      form[who + "_kind"].addEventListener("change", () => {
        const m = form[who + "_machine"] ? form[who + "_machine"].value : "";
        const mem = getSavedModel(form[who + "_kind"].value, m);
        form[who + "_model"].dataset.value = mem?.model || "";
        form[who + "_effort"].dataset.value = mem?.effort || "";
        fillModels(form, who);
      });
    }
    form.router_machine?.addEventListener("change", () => fillModels(form, "router"));
    form.worker_machine?.addEventListener("change", () => fillModels(form, "worker"));
  }

  function settingsHTML(r) {
    const s = r.settings;
    const kindOpts = (v, have) => [["claude", "Claude", "claude"], ["codex", "Codex", "codex"], ["antigravity", "Antigravity", "agy"], ["gemini", "Gemini", "gemini"]].map(([k, l, g]) => {
      const missing = Array.isArray(have) && !have.includes(g);
      return `<option value="${k}" data-glyph="${g}" ${missing ? 'data-sub="所选电脑未安装"' : ""} ${missing && v !== k ? "disabled" : ""} ${v === k ? "selected" : ""}>${l}</option>`;
    }).join("");
    const modelPick = (who, model, effort) => `
          <label>模型<select name="${who}_model" data-title="模型" data-value="${esc(model || "")}"><option value="${esc(model || "")}" selected>${esc(model || "默认")}</option></select></label>
          <label>思考强度<select name="${who}_effort" data-title="思考强度" data-value="${esc(effort || "")}"><option value="${esc(effort || "")}" selected>${esc(EFFORT_LABEL[effort] || effort || "默认")}</option></select></label>`;
    const rMachines = runnableMachines(s.router_machine || "");
    const wMachines = runnableMachines(s.worker_machine || "");
    const showRM = rMachines.length > 1 || (state.machines || []).some((m) => !m.local);
    const showWM = wMachines.length > 1 || (state.machines || []).some((m) => !m.local);
    const defWorkerM = s.worker_machine || preferredWorkMachine("");
    setTimeout(() => bindSettings($("#settings-form")));
    return `<form class="settings" id="settings-form">
      <section class="card set-sec">
        <header>
          <span class="set-ico"><svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/></svg></span>
          <div class="set-head-txt"><h4>Collie 协调大脑</h4><p>负责与你对话、理解意图、跨机拆解任务与汇总回报。手册与记忆保存在 <code>${esc(tilde(r.router_dir))}</code>，运行在其他电脑上时自动双向同步。</p></div>
        </header>
        <div class="set-grid ${showRM ? "" : "three"}">
          ${showRM ? `<label>运行电脑<select name="router_machine" data-title="Collie 自己运行在哪台电脑"><option value="" data-sub="优先选装了对应 agent 的在线电脑" ${!(s.router_machine || "") ? "selected" : ""}>自动选择</option>${rMachines.map((m) => `<option value="${esc(m.id)}" data-os="${osKey(m.os)}" ${m.id === (s.router_machine || "") ? "selected" : ""}>${esc(m.name)}${m.local ? "（hub）" : m.online ? "" : "（离线）"}</option>`).join("")}</select></label>` : ""}
          <label>Agent<select name="router_kind" data-title="Collie 自己用的 agent">${kindOpts(s.router_kind)}</select></label>
          ${modelPick("router", s.router_model, s.router_effort)}
        </div>
        <details class="set-adv" ${(s.router_args || []).length ? "open" : ""}><summary>更多启动参数</summary>
          <label><input name="router_args" class="mono" value="${esc((s.router_args || []).join(" "))}" placeholder="例如 --permission-mode plan"><small>原样附加在启动命令末尾，一般无需填写</small></label>
        </details>
      </section>

      <section class="card set-sec">
        <header>
          <span class="set-ico"><svg viewBox="0 0 24 24"><path d="M5 12h13M13 7l5 5-5 5"/><rect x="3" y="4" width="4" height="16" rx="1.5"/></svg></span>
          <div class="set-head-txt"><h4>默认派活目标</h4><p>Collie 派子 Agent 执行具体任务时的默认配置；你也可随时在聊天框底部快捷切换，或直接在对话中指定电脑与模型。</p></div>
        </header>
        <div class="set-grid three">
          <label>Agent<select name="worker_kind" data-title="派活默认用">${kindOpts(s.worker_kind)}</select></label>
          ${modelPick("worker", s.worker_model, s.worker_effort)}
        </div>
        <div class="set-grid three">
          ${showWM ? `<label>执行电脑<select name="worker_machine" data-title="派活默认在哪台电脑">${wMachines.map((m) => `<option value="${esc(m.id)}" data-os="${osKey(m.os)}" ${m.id === defWorkerM ? "selected" : ""}>${esc(m.name)}${m.local ? "（hub）" : m.online ? "" : "（离线）"}</option>`).join("")}</select></label>` : ""}
          <label class="${showWM ? "span2" : "span3"}">默认工作目录<input name="worker_cwd" class="mono" value="${esc(tilde(s.worker_cwd))}"></label>
        </div>
      </section>

      <section class="card set-sec">
        <header>
          <span class="set-ico"><svg viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg></span>
          <div class="set-head-txt"><h4>记忆轮转与夜间整理</h4><p>对话上下文较长时自动平滑交接至新会话，核心进展写入 <code>memory/</code> 继承；每晚自动回顾对话、去重压缩记忆。</p></div>
        </header>
        <div class="set-grid">
          <label>上下文达到多少时平滑换新会话<select name="rotate_pct" data-title="上下文达到多少时换新会话">${[50, 60, 70, 80, -1].map((p) => `<option value="${p}" ${(s.rotate_pct || 60) === p ? "selected" : ""}>${p < 0 ? "从不自动轮转" : p + "%"}</option>`).join("")}</select><small>按当前 Agent 模型的上下文窗口容量计算</small></label>
          <label>每晚自动整理记忆时间<select name="dream_at" data-title="每晚整理记忆时间">${["02:00", "04:00", "06:00", "off"].map((t) => `<option value="${t}" ${(s.dream_at || "04:00") === t ? "selected" : ""}>${t === "off" ? "关闭自动整理" : "每天 " + t}</option>`).join("")}</select><small>当天无新对话时自动跳过，不消耗额外 Token</small></label>
        </div>
      </section>

      <section class="card set-sec">
        <header>
          <span class="set-ico"><svg viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg></span>
          <div class="set-head-txt"><h4>外部消息通知</h4><p>当你不在网页前时，通过飞书机器人或自定义群 Webhook 推送任务汇报与待确认提醒。</p></div>
        </header>
        <div class="set-grid">
          <label class="check span3"><input type="checkbox" name="notify_lark" ${s.notify_lark ? "checked" : ""}> 使用 Hub 上的 lark-cli 发送飞书私聊提醒<small id="lark-who" class="muted">· 正在检测 Hub 上的 lark-cli 状态…</small></label>
          <label>群机器人 Webhook<input name="notify_webhook" value="${esc(s.notify_webhook || "")}" placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…"><small>支持飞书 / Lark 群机器人或 Slack Incoming Webhook</small></label>
          <label>推送触发时机<select name="notify_level" data-title="推送触发时机"><option value="quiet" ${s.notify_level === "quiet" ? "selected" : ""} data-sub="仅在任务阻塞、需要确认或报错时推送">仅在需要你介入时</option><option value="normal" ${s.notify_level === "normal" ? "selected" : ""} data-sub="包含任务完成后的总结汇报">包含任务完成汇报</option></select><small>当前浏览器前台打开 Collie 页面时自动静音免打扰</small></label>
        </div>
      </section>

      <section class="card set-sec">
        <header>
          <span class="set-ico"><svg viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/></svg></span>
          <div class="set-head-txt"><h4>执行策略与看门狗</h4><p>控制 Collie 回复篇幅、无进展超时检测与命令执行权限策略。</p></div>
        </header>
        <div class="set-grid">
          <label>日常回复字数目标<input name="reply_chars" type="number" min="40" step="20" value="${s.reply_chars || 200}"><small>日常简报的建议字数上限；当你要求详细展开时不受此限</small></label>
          <label>卡死巡检阈值（分钟）<input name="stall_minutes" type="number" min="0" value="${s.stall_minutes}"><small>子任务持续无输出超过该时长即提醒；填 0 关闭</small></label>
        </div>
        <label class="check"><input type="checkbox" name="bypass" ${s.ask_permissions ? "" : "checked"}> 免确认自动执行：Collie 与派出的子 Agent 直接运行命令和修改文件，不逐步中断询问（重启 Collie 及新派任务生效）</label>
        <label class="check"><input type="checkbox" name="paused" ${s.paused ? "checked" : ""}> 暂停事件投递：新消息与触发器照常入队暂存，恢复后再交给 Agent 处理</label>
      </section>

      <div class="set-actions">
        <button type="button" class="btn small" data-act="router-restart">重启 Collie</button>
        <span class="set-hint">保存后全局生效</span>
        <span class="grow"></span>
        <button class="btn primary small">保存全局设置</button>
      </div>
    </form>`;
  }

  $("#panel-body").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      if (f.id === "timer-form") {
        const r = timerSpec(f);
        if (r.err) { toast(r.err, "attn"); return; }
        await api("/api/super/timers", { body: { spec: r.spec, text: f.text.value, target: f.target.value, owner: "you" } });
        toast(`已添加：${describeSpec(r.spec)}`);
        $("#panel-body")._timerSig = "";
        loadPanel("timers");
      } else if (f.classList.contains("mem-edit")) {
        await api("/api/super/memory", { body: { path: f.closest("[data-path]").dataset.path, text: f.text.value } });
        memEditing = false;
        $("#panel-body")._memSig = "";
        toast("已保存");
        loadPanel("memory");
      } else if (f.id === "settings-form") {
        const cur = (await api("/api/super/settings")).settings;
        const s = {
          ...cur,
          router_machine: f.router_machine ? f.router_machine.value : (cur.router_machine || ""),
          router_kind: f.router_kind.value, router_args: f.router_args.value.split(/\s+/).filter(Boolean),
          router_model: f.router_model.value === "__custom" ? "" : f.router_model.value, router_effort: f.router_effort.value,
          worker_kind: f.worker_kind.value, worker_cwd: f.worker_cwd.value,
          worker_model: f.worker_model.value === "__custom" ? "" : f.worker_model.value, worker_effort: f.worker_effort.value,
          worker_machine: f.worker_machine ? f.worker_machine.value : (cur.worker_machine || ""),
          reply_chars: +f.reply_chars.value, stall_minutes: +f.stall_minutes.value,
          rotate_pct: +f.rotate_pct.value, dream_at: f.dream_at.value,
          notify_webhook: f.notify_webhook.value.trim(), notify_lark: f.notify_lark.checked, notify_level: f.notify_level.value, paused: f.paused.checked,
          ask_permissions: !f.bypass.checked,
        };
        saveLastModel(s.router_kind, s.router_machine, s.router_model, s.router_effort);
        saveLastModel(s.worker_kind, s.worker_machine, s.worker_model, s.worker_effort);
        const relaunch = s.router_machine !== (cur.router_machine || "") || s.router_kind !== cur.router_kind || s.router_model !== (cur.router_model || "") || s.router_effort !== (cur.router_effort || "") || s.router_args.join(" ") !== (cur.router_args || []).join(" ") || s.ask_permissions !== !!cur.ask_permissions;
        const shouldRestart = relaunch && !!(sup.router?.alive || sup.router?.status === "failed");
        const res = await api("/api/super/settings", { body: { settings: s, restart: shouldRestart } });
        renderTarget(true);
        toast(res.restarted ? "已保存，Collie 正在用新配置重启" : "已保存");
      }
    } catch (err) { toast(err.message, "attn"); }
  });

  $("#panel-body").addEventListener("click", async (e) => {
    // Execution trajectory filter cards & task text expand/collapse
    const tf = e.target.closest("[data-tf]")?.dataset.tf;
    if (tf) {
      traceFilter = tf; store.set("traceFilter", tf);
      $("#panel-body")._traceSig = "";
      loadPanel("trace");
      return;
    }
    if (e.target.closest("[data-act='tc-toggle']")) {
      const card = e.target.closest("[data-tc]");
      if (card) {
        const k = card.dataset.tc;
        if (expandedTraceCards.has(k)) expandedTraceCards.delete(k); else expandedTraceCards.add(k);
        card.classList.toggle("expanded", expandedTraceCards.has(k));
        const btn = card.querySelector("button[data-act='tc-toggle']");
        if (btn) btn.textContent = expandedTraceCards.has(k) ? "收起指令" : "展开指令";
      }
      return;
    }
    const stopW = e.target.closest("[data-stop-worker]")?.dataset.stopWorker;
    if (stopW) {
      if (!confirm(`停止正在执行的任务「${stopW}」？`)) return;
      try {
        await api(`/api/super/workers/${encodeURIComponent(stopW)}/stop`, { method: "POST", body: {} });
        toast(`已停止 ${stopW}`);
        $("#panel-body")._traceSig = "";
        loadPanel("trace");
      } catch (err) { toast(err.message, "attn"); }
      return;
    }

    // Local device preferences inside Settings -> 本机界面与通知
    const prefBtn = e.target.closest(".seg[data-pref] button, button.switch[data-pref]");
    if (prefBtn) {
      if (prefBtn.classList.contains("switch")) {
        const key = prefBtn.dataset.pref, on = prefBtn.getAttribute("aria-checked") !== "true";
        if (key === "notify" && on && "Notification" in window && Notification.permission !== "granted") {
          const p = await Notification.requestPermission();
          if (p !== "granted") { toast("浏览器没有允许通知", "attn"); loadPanel("settings"); return; }
        }
        store.set(key, on);
      } else {
        const key = prefBtn.closest("[data-pref]").dataset.pref, v = prefBtn.dataset.v;
        store.set(key, v);
        if (key === "theme" || key === "text" || key === "sendKey") applyLook();
      }
      loadPanel("settings");
      return;
    }

    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.act === "mem-edit" || t.dataset.act === "mem-cancel") {
      const box = t.closest("[data-path]");
      memEditing = t.dataset.act === "mem-edit";
      box.querySelector(".mem-edit").hidden = !memEditing;
      box.querySelector("[data-view]").hidden = memEditing;
      box.querySelector(".mem-tools").hidden = memEditing;
      if (memEditing) box.querySelector("textarea").focus();
      else { $("#panel-body")._memSig = ""; loadPanel("memory"); }
      return;
    }
    if (t.dataset.act === "dream-now") {
      t.disabled = true; t.textContent = "开始中…";
      try { await api("/api/super/dream", { body: {} }); toast("Collie 去做梦了"); }
      catch (err) { toast(err.message, "attn"); }
      $("#panel-body")._memSig = "";
      loadPanel("memory");
      return;
    }
    if (t.dataset.delTimer) {
      await api(`/api/super/timers/${t.dataset.delTimer}/delete`, { method: "POST", body: {} }).catch((err) => toast(err.message));
      $("#panel-body")._timerSig = "";
      loadPanel("timers");
    } else if (t.dataset.copy) {
      await copy(t.dataset.copy); toast("已复制");
    } else if (t.dataset.presetSource) {
      const src = t.dataset.presetSource, act = t.dataset.presetAction || "candidate";
      const existing = $$(".policy").find((row) => $("[data-f=source]", row)?.value.trim() === src);
      if (existing) {
        const sel = $("[data-f=action]", existing);
        if (sel) { sel.value = act; syncPick(sel); }
        toast(`已更新 ${src} 的处理策略`);
      } else {
        $("#policies")?.insertAdjacentHTML("beforeend", policyRow({ source: src, action: act, allow: [] }));
      }
    } else if (t.id === "add-policy") {
      $("#policies").insertAdjacentHTML("beforeend", policyRow());
    } else if (t.hasAttribute("data-del-policy")) {
      t.closest(".policy").remove();
    } else if (t.id === "save-policies") {
      const policies = $$(".policy").map((row) => ({
        source: $("[data-f=source]", row).value.trim(), action: $("[data-f=action]", row).value,
        allow: $("[data-f=allow]", row).value.split(",").map((x) => x.trim()).filter(Boolean),
      })).filter((p) => p.source);
      try { await api("/api/super/settings", { body: { policies } }); toast("过滤规则已保存"); } catch (err) { toast(err.message, "attn"); }
    }
  });

  // ───────────────────────────── agents in other terminals (outside herdr)
  let ext = [], extTimer, extStream = null, extCur = null;
  async function loadExternal() {
    if (document.hidden && ext.length) return;
    try { ext = (await api("/api/external")).sessions || []; } catch { return; }
    ext = ext.concat(...await fromHubs("/api/external", "ext"));
    renderSide();
    if (view === "ext") renderExtHead();
  }

  // The same list from every other hub, ids tagged; a hub that doesn't
  // answer keeps what it showed last until it is marked offline.
  async function fromHubs(path, field) {
    return Promise.all(hubs.map(async (h) => {
      const r = remote.get(h.key);
      if (!r) return [];
      if (!r.online) return (r[field] = []);
      try {
        const d = await api(path, { hub: h });
        r[field] = (d.sessions || []).map((e) => ({ ...tagIds(e, h.key), id: tagged(e.id, h.key), hub: h.key }));
      } catch {}
      return r[field] || [];
    }));
  }

  // ───────────────────────────── ended sessions: read them, continue them
  let hist = [];
  // workerHist: the ended session named name that a line at time at was
  // about: the first of that name to end after it.
  const workerHist = (name, at) => {
    const t = new Date(at);
    let best = null;
    for (const h of hist) if (h.name === name && new Date(h.ended) >= t && (!best || new Date(h.ended) < new Date(best.ended))) best = h;
    return best;
  };
  async function loadHistory() {
    try { hist = (await api("/api/history")).sessions || []; } catch { return; }
    hist = hist.concat(...await fromHubs("/api/history", "hist"));
    renderSide();
    if (view === "collie") renderSuper();
    if (view === "ext" && extCur?.startsWith("h:")) renderHistHead(extCur.slice(2));
  }
  const ago = (t) => {
    const s = (Date.now() - new Date(t)) / 1000;
    return s < 90 ? "刚刚" : s < 3600 ? Math.round(s / 60) + " 分钟前" : s < 86400 ? Math.round(s / 3600) + " 小时前" : Math.round(s / 86400) + " 天前";
  };
  const histName = (h) => getSessMeta(h.kind, h.machine, h.session, "h:" + h.id)?.title || h.title || (h.name && !autoName(h.name) ? h.name : base(tilde(h.cwd)));
  const histOnline = (h) => !h.machine || (state.machines || []).some((m) => m.id === h.machine && m.online);
  const renderHist = () => renderSessions();
  function renderHistHead(hid) {
    const h = hist.find((x) => x.id === hid);
    const on = !!(h && histOnline(h));
    const meta = h ? getSessMeta(h.kind, h.machine, h.session, "h:" + h.id) : null;
    $("#x-name").textContent = h ? histName(h) : "已结束的会话";
    $("#x-kind").textContent = h ? KIND_LABEL[h.kind] || h.kind : "";
    $("#x-tag").hidden = !meta?.archived;
    $("#x-tag").textContent = meta?.archived ? "已归档" : "";
    $("#x-status").className = "status ended";
    $("#x-status").textContent = h ? "上次对话 " + ago(h.ended) : "";
    $("#x-cwd").textContent = h ? (h.machine ? machineName(h.machine) + " · " : "") + tilde(h.cwd) : "";
    const ab = $("#ext-archive-btn");
    if (ab) ab.textContent = meta?.archived ? "移出归档" : "归档会话";
    const canResume = !!(h && on && h.session && RESUME[h.kind]);
    $("#x-composer").hidden = !h;
    $("#x-input").disabled = !canResume;
    $("#x-send").disabled = !canResume;
    $("#x-input").placeholder = !h ? "会话已不存在" : !on ? `${machineName(h.machine)} 当前离线，上线后可直接发消息继续…` : "输入消息直接继续对话，自动继承上下文…";
    $("#x-hint").textContent = canResume && h.machine ? machineName(h.machine) : "";
    renderExtChips(h?.kind, h?.machine, null, canResume && !h?.hub, "h:" + hid);
  }
  async function openHist(hid) {
    const el = $("#x-thread");
    resetEarlier(el, null); el._msgs = null;
    primeThread(el, "h:" + hid);
    if (!hist.some((h) => h.id === hid)) await loadHistory();
    renderHistHead(hid);
    const h = hist.find((x) => x.id === hid);
    if (!h) { el.innerHTML = ""; return; }
    try {
      const q = new URLSearchParams({ kind: h.kind, session: h.session, cwd: h.cwd });
      if (h.machine) q.set("machine", h.machine);
      const r = await api("/api/transcript?" + q);
      if (view === "ext" && extCur === "h:" + hid) {
        resetEarlier(el, (c) => `/api/transcript?${q}&before=${c}`);
        el._msgs = r.messages || []; el._liveEarlier = r.earlier || 0;
        keepThread("h:" + hid, el._msgs);
        el._redraw = () => { if (view === "ext" && extCur === "h:" + hid) drawThread(threadMsgs(el), el, "这个会话没有消息。"); };
        el._redraw();
      }
    } catch (err) {
      if (view === "ext" && extCur === "h:" + hid) el.innerHTML = `<div class="thread-empty">${esc(err.message)}</div>`;
    }
  }
  const RESUME = { claude: (s) => ["--resume", s], codex: (s) => ["resume", s], agy: (s) => ["--conversation", s], gemini: (s) => ["--resume", s] };
  const extDraftRun = new Map();
  let xChipSeq = 0;
  async function renderExtChips(kind, machine, baseRun, enabled, key) {
    const wrap = $("#x-chips"), mSel = $("#x-model-sel"), eSel = $("#x-effort-sel");
    if (!wrap || !mSel || !eSel) return;
    if (!kind || !enabled) { wrap.hidden = true; return; }
    const seq = ++xChipSeq;
    const saved = getSavedModel(kind, machine || "");
    const draft = extDraftRun.get(key || "") || {
      model: baseRun?.[0] ?? saved?.model ?? "",
      effort: baseRun?.[1] ?? saved?.effort ?? "",
    };
    const info = await modelsFor(kind, machine || "").catch(() => ({ models: [], efforts: [] }));
    if (seq !== xChipSeq) return;
    const list = [...(info.models || [])];
    if (draft.model && !list.some((m) => m.id === draft.model)) list.unshift({ id: draft.model });
    const short = (id) => id.split("/").pop();
    const defShort = info.default ? short(info.default) : "默认模型";
    let html = `<option value="" data-short="${esc(defShort)}" data-sub="${esc(info.default ? "现在是 " + info.default : "agent 自己的默认模型")}" ${!draft.model ? "selected" : ""}>默认${info.default ? "（" + esc(short(info.default)) + "）" : ""}</option>`;
    html += list.map((m) => `<option value="${esc(m.id)}" data-short="${esc(m.label && m.label.length <= 24 ? m.label : short(m.id))}" data-sub="${esc(m.note || (m.label && m.label !== m.id ? m.id : ""))}" ${m.id === draft.model ? "selected" : ""}>${esc(m.label || m.id)}</option>`).join("");
    if (mSel._html !== html) { mSel._html = html; mSel.innerHTML = html; }
    mSel.value = draft.model || "";
    const cur = list.find((m) => m.id === draft.model);
    const effs = cur?.efforts?.length ? cur.efforts : (info.efforts || []);
    const eff = effs.includes(draft.effort) ? draft.effort : "";
    const defE = info.default_effort || "";
    let ehtml = `<option value="" data-short="思考 · ${esc(EFFORT_LABEL[defE] || defE || "默认")}" data-sub="使用默认思考强度" ${!eff ? "selected" : ""}>默认${defE ? "（" + esc(EFFORT_LABEL[defE] || defE) + "）" : ""}</option>`;
    ehtml += effs.map((ef) => `<option value="${esc(ef)}" data-short="思考 · ${esc(EFFORT_LABEL[ef] || ef)}" data-sub="${esc(ef)}" ${ef === eff ? "selected" : ""}>${esc(EFFORT_LABEL[ef] || ef)}</option>`).join("");
    if (eSel._html !== ehtml) { eSel._html = ehtml; eSel.innerHTML = ehtml; }
    eSel.value = eff;
    eSel.hidden = effs.length === 0;
    wrap.hidden = false;
    wrap.dataset.key = key || "";
    wrap.dataset.kind = kind;
    wrap.dataset.machine = machine || "";
    enhance(mSel); enhance(eSel);
    syncPick(mSel); syncPick(eSel);
    mSel._pick?.classList.toggle("changed", !!draft.model);
    eSel._pick?.classList.toggle("changed", !!eff);
  }
  $("#x-model-sel")?.addEventListener("change", (ev) => {
    const wrap = $("#x-chips");
    const key = wrap?.dataset.key || "", kind = wrap?.dataset.kind || "", machine = wrap?.dataset.machine || "";
    const prev = extDraftRun.get(key) || { model: "", effort: $("#x-effort-sel")?.value || "" };
    const next = { model: ev.target.value, effort: prev.effort };
    extDraftRun.set(key, next);
    if (kind) saveLastModel(kind, machine, next.model, next.effort);
    renderExtHead();
  });
  $("#x-effort-sel")?.addEventListener("change", (ev) => {
    const wrap = $("#x-chips");
    const key = wrap?.dataset.key || "", kind = wrap?.dataset.kind || "", machine = wrap?.dataset.machine || "";
    const prev = extDraftRun.get(key) || { model: $("#x-model-sel")?.value || "", effort: "" };
    const next = { model: prev.model, effort: ev.target.value };
    extDraftRun.set(key, next);
    if (kind) saveLastModel(kind, machine, next.model, next.effort);
    renderExtHead();
  });
  function currentExtModelChoice() {
    return {
      model: $("#x-model-sel")?.value || "",
      effort: $("#x-effort-sel")?.value || "",
    };
  }
  async function sendInHist(hid, text) {
    const h = hist.find((x) => x.id === hid);
    if (!h || !RESUME[h.kind]) throw new Error("暂不支持继续这个会话");
    if (!histOnline(h)) throw new Error(`${machineName(h.machine)} 当前不在线`);
    const label = histName(h).slice(0, 48);
    const { model, effort } = currentExtModelChoice();
    addPendingThreadMsg($("#x-thread"), text);
    if (h.kind === "codex" && h.session) {
      try {
        await api("/api/codex/send", { body: {
          machine: h.machine || "", thread: h.session, text, model, effort,
        } });
        await loadExternal().catch(() => {});
        const matched = ext.find((x) => x.kind === "codex" && x.session === h.session && (x.machine || "") === (h.machine || ""));
        if (matched) {
          await api(`/api/history/${encodeURIComponent(h.id)}/delete`, { body: {} }).catch(() => {});
          hist = hist.filter((x) => x.id !== h.id);
          renderHist();
          location.hash = "#/x/" + encodeURIComponent(matched.id);
        } else {
          setTimeout(() => openHist(hid), 1200);
        }
        return;
      } catch {}
    }
    toast("正在连接会话并发送…");
    let r;
    try {
      r = await api("/api/agents", { body: {
        kind: h.kind, cwd: h.cwd, machine: h.machine || "", name: "", label,
        model, effort, args: RESUME[h.kind](h.session), prompt: text,
      } });
    } catch (err) {
      removePendingThreadMsg($("#x-thread"), text);
      throw err;
    }
    if (r.warning) toast(r.warning, "attn");
    await api(`/api/history/${encodeURIComponent(h.id)}/delete`, { body: {} }).catch(() => {});
    await api("/api/sessions/archive", { body: { kind: h.kind, machine: h.machine || "", session: h.session, hist_id: h.id, archived: false } }).catch(() => {});
    hist = hist.filter((x) => x.id !== h.id);
    renderHist();
    location.hash = "#/p/" + encodeURIComponent(r.pane_id);
  }
  const extName = (e) => getSessMeta(e.kind, e.machine, e.session, "x:" + e.id)?.title || e.title || (e.cwd ? cleanPath(e.cwd).split(/[\\/]/).filter(Boolean).pop() : "") || KIND_LABEL[e.kind] || e.kind;
  const extOnline = (e) => !e.machine || (state.machines || []).some((m) => m.id === e.machine && m.online);
  const RECENT_N = 10;
  let extAll = store.get("extAll", false);
  const EXT_STATE = { working: "工作中", waiting: "在等后台任务", idle: "空闲", blocked: "等待确认" };
  const isActivelyRunning = (st) => st === "working" || st === "starting" || st === "waiting";
  function renderExt() { renderSessions(); }
  $("#session-list")?.addEventListener("click", (ev) => {
    if (!ev.target.closest("[data-act=ext-more]")) return;
    ev.preventDefault();
    extAll = !extAll; store.set("extAll", extAll);
    renderSessions();
  });
  let projOpenMap = store.get("projOpen", {});
  function isProjOpen(id) { return projOpenMap[id] !== false; }
  function setProjOpen(id, open) {
    projOpenMap[id] = !!open;
    store.set("projOpen", projOpenMap);
  }

  function renderSessions() {
    const many = (state.machines || []).length > 1;
    const extRow = (e, inProj = false) => {
      const open = e.live && e.status === "idle";
      const where = [KIND_LABEL[e.kind] || e.kind, !inProj && many && e.machine ? machineName(e.machine) : "", e.live && !open ? "" : ago(e.updated || e.started)].filter(Boolean).join(" · ");
      const showDot = e.live && SHOW_SIDE_DOT.has(e.status);
      const dot = showDot ? sideDotHTML(e.status, EXT_STATE) : "";
      const attnCls = e.live && e.status === "blocked" ? "attn-row" : "";
      return `<li class="s-li ${attnCls}"><a class="item ${showDot ? "" : "ended"} ${view === "ext" && extCur === e.id ? "active" : ""}" href="#/x/${encodeURIComponent(e.id)}">
        <span class="glyph">${GLYPHS[e.kind] || GLYPHS.agent}</span>
        <span class="body"><div class="name">${esc(extName(e))}</div><div class="sub">${esc(where)}</div></span>${dot}</a>
        <button type="button" class="item-more" data-smenu="x:${esc(e.id)}" title="重命名 / 归属项目 / 归档 / 删除">${MORE_ICO}</button></li>`;
    };
    const histRow = (h, inProj = false) => {
      const sub = [KIND_LABEL[h.kind] || h.kind, !inProj && many ? machineName(h.machine) : "", ago(h.ended)].filter(Boolean).join(" · ");
      return `<li class="s-li"><a class="item ended ${view === "ext" && extCur === "h:" + h.id ? "active" : ""}" href="#/h/${encodeURIComponent(h.id)}">
        <span class="glyph">${GLYPHS[h.kind] || GLYPHS.agent}</span>
        <span class="body"><div class="name">${esc(histName(h))}</div><div class="sub">${esc(sub)}</div></span></a>
        <button type="button" class="item-more" data-smenu="h:${esc(h.id)}" title="重命名 / 归属项目 / 归档 / 删除">${MORE_ICO}</button></li>`;
    };
    const paneRow = (a, inProj = false, lastT = 0) => {
      if (!inProj) {
        const html = itemHTML(a);
        return a.status === "blocked" ? html.replace('<li class="s-li">', '<li class="s-li attn-row">') : html;
      }
      const named = a.is_agent && a.name !== ROUTER && !isWorker(a.name) && a.name && !autoName(a.name) && a.topic && a.topic !== a.name ? a.name + " · " : "";
      const quiet = !SHOW_SIDE_DOT.has(a.status);
      const whenPart = quiet && lastT ? " · " + ago(new Date(lastT).toISOString()) : "";
      const sub = a.is_agent ? `${named}${KIND_LABEL[a.kind] || a.kind}${whenPart}` : tilde(a.cwd);
      const more = a.name !== ROUTER ? `<button type="button" class="item-more" data-smenu="p:${esc(a.pane_id)}" title="重命名 / 归属项目 / 归档 / 删除">${MORE_ICO}</button>` : "";
      const attnCls = a.status === "blocked" ? "attn-row" : "";
      return `<li class="s-li ${attnCls}"><a class="item ${quiet ? "ended" : ""} ${view === "pane" && a.pane_id === current ? "active" : ""}" href="#/p/${encodeURIComponent(a.pane_id)}">
        <span class="glyph">${glyph(a)}</span>
        <span class="body"><div class="name">${isCollieOwned(a) && a.name !== ROUTER ? `<span class="nm">${esc(title(a))}</span><span class="by-collie">Collie 派出</span>` : esc(title(a))}</div><div class="sub">${esc(sub)}</div></span>
        ${sideDotHTML(a.status)}</a>${more}</li>`;
    };

    const matchM = (m) => sideMachine === null || (m || "") === sideMachine;
    const collieRan = (name) => name === ROUTER || sup.workers.some((w) => w.name === name);
    const extTimeMap = new Map();
    for (const e of ext) {
      const ck = canonSessKey(e.kind, e.machine, e.session);
      if (ck) extTimeMap.set(ck, +new Date(e.updated || e.started) || 0);
    }

    const seenKeys = new Set();
    const pool = [];

    for (const a of state.agents) {
      if (a.name === ROUTER && a.status !== "blocked") continue;
      if (!matchM(a.machine)) continue;
      const meta = getSessMeta(a.kind, a.machine, a.session, "p:" + a.pane_id);
      if (meta?.deleted) continue;
      const ck = canonSessKey(a.kind, a.machine, a.session);
      if (ck) seenKeys.add(ck);
      const isBlocked = a.status === "blocked";
      const isRunning = isActivelyRunning(a.status);
      const groupRank = isBlocked ? 0 : isRunning ? 1 : a.status === "failed" ? 2 : 3;
      const t = (ck && extTimeMap.get(ck)) || +new Date(meta?.updated_at || 0) || 0;
      const proj = projectOfSession(a.kind, a.machine, a.session, a.cwd, "p:" + a.pane_id);
      pool.push({
        key: "p:" + a.pane_id,
        proj,
        archived: !!meta?.archived && !isBlocked && !isRunning,
        isRunning, isBlocked, groupRank, t,
        active: view === "pane" && current === a.pane_id,
        html: paneRow(a, !!proj, t),
      });
    }

    for (const e of ext) {
      if (!matchM(e.machine)) continue;
      const meta = getSessMeta(e.kind, e.machine, e.session, "x:" + e.id);
      if (meta?.deleted) continue;
      const ck = canonSessKey(e.kind, e.machine, e.session);
      if (ck && seenKeys.has(ck)) continue;
      if (ck) seenKeys.add(ck);
      const isBlocked = !!(e.live && e.status === "blocked");
      const isRunning = !!(e.live && isActivelyRunning(e.status));
      const groupRank = isBlocked ? 0 : isRunning ? 1 : 3;
      const proj = projectOfSession(e.kind, e.machine, e.session, e.cwd, "x:" + e.id);
      pool.push({
        key: e.id,
        proj,
        archived: !!meta?.archived && !isBlocked && !isRunning,
        isRunning, isBlocked, groupRank,
        t: +new Date(e.updated || e.started) || 0,
        active: view === "ext" && extCur === e.id,
        html: extRow(e, !!proj),
      });
    }

    for (const h of hist) {
      if (collieRan(h.name) || !matchM(h.machine)) continue;
      const meta = getSessMeta(h.kind, h.machine, h.session, "h:" + h.id);
      if (meta?.deleted) continue;
      const ck = canonSessKey(h.kind, h.machine, h.session);
      if (ck && seenKeys.has(ck)) continue;
      if (ck) seenKeys.add(ck);
      const proj = projectOfSession(h.kind, h.machine, h.session, h.cwd, "h:" + h.id);
      pool.push({
        key: "h:" + h.id,
        proj,
        archived: !!meta?.archived,
        isRunning: false, isBlocked: false, groupRank: 3,
        t: +new Date(h.ended) || 0,
        active: view === "ext" && extCur === "h:" + h.id,
        html: histRow(h, !!proj),
      });
    }

    pool.sort((x, y) => (x.groupRank - y.groupRank) || (y.t - x.t));
    const unarchived = pool.filter((x) => !x.archived);
    const archived = pool.filter((x) => x.archived);

    const runCount = unarchived.filter((x) => x.isRunning).length;
    const blkCount = unarchived.filter((x) => x.isBlocked).length;
    const runCntEl = $("#sf-running-cnt"), blkCntEl = $("#sf-blocked-cnt");
    if (runCntEl) runCntEl.textContent = runCount || "";
    if (blkCntEl) blkCntEl.textContent = blkCount || "";
    $$("#session-filter button[data-sf]").forEach((b) => {
      const on = sideStatus === b.dataset.sf;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    });

    const matchStatus = (x) => sideStatus === "running" ? x.isRunning : sideStatus === "blocked" ? x.isBlocked : true;

    // 1. Pinned Projects Section (Fixed at Top)
    const allProjs = (state.projects || []).filter((p) => matchM(p.machine));
    const projGrp = $("#project-group"), projListEl = $("#project-list"), projCntEl = $("#project-count");
    if (projGrp && projListEl) {
      const byProj = new Map(allProjs.map((p) => [p.id, []]));
      for (const item of unarchived) {
        if (item.proj && byProj.has(item.proj.id) && matchStatus(item)) {
          byProj.get(item.proj.id).push(item);
        }
      }
      const visibleProjs = sideStatus ? allProjs.filter((p) => (byProj.get(p.id) || []).length > 0) : allProjs;
      projGrp.hidden = Boolean(sideStatus && !visibleProjs.length);
      if (projCntEl) projCntEl.textContent = visibleProjs.length || "";

      if (visibleProjs.length) {
        projListEl.innerHTML = visibleProjs.map((p) => {
          const items = byProj.get(p.id) || [];
          const hasActive = items.some((x) => x.active);
          const hasBlocked = items.some((x) => x.isBlocked);
          const hasRunning = items.some((x) => x.isRunning);
          const open = sideStatus ? true : (hasActive || isProjOpen(p.id));
          const where = many && sideMachine === null ? machineName(p.machine) : "";
          const badgeParts = [where, items.length ? String(items.length) : ""].filter(Boolean).join(" · ");
          const collapsedDot = !open && (hasBlocked || hasRunning)
            ? `<span class="dot ${hasBlocked ? "blocked" : "working"}"></span>` : "";
          const childHTML = open
            ? `<ul class="list proj-sessions">${items.length
                ? items.map((x) => x.html).join("")
                : `<li><button type="button" class="empty-proj-sess" data-proj-new="${esc(p.id)}">${PLUS_ICO}<span>在此项目新建会话</span></button></li>`
              }</ul>`
            : "";
          return `<div class="proj-node ${open ? "open" : ""}" data-proj-id="${esc(p.id)}">
            <div class="proj-row" data-proj-toggle="${esc(p.id)}" title="${esc(machineName(p.machine) + " · " + tilde(p.cwd))}">
              <span class="proj-chev">${CHEV_RIGHT_ICO}</span>
              <span class="proj-ico">${open ? GLYPHS.folderOpen : GLYPHS.folder}</span>
              <span class="proj-main">
                <span class="proj-name">${esc(p.name)}</span>
                ${badgeParts ? `<span class="proj-sub">${esc(badgeParts)}</span>` : ""}
              </span>
              ${collapsedDot}
              <span class="proj-acts">
                <button type="button" class="proj-act" data-proj-new="${esc(p.id)}" title="在「${esc(p.name)}」下新建会话">${PLUS_ICO}</button>
                <button type="button" class="proj-act" data-pmenu="${esc(p.id)}" title="项目管理">${MORE_ICO}</button>
              </span>
            </div>
            ${childHTML}
          </div>`;
        }).join("");
      } else {
        projListEl.innerHTML = `<button type="button" class="proj-empty-cta" data-open-launch="project">${GLYPHS.folder}<span>点击绑定常用项目目录，会话自动按项目归组</span></button>`;
      }
    }

    // 2. Standalone Sessions Section (Below Projects)
    const loose = unarchived.filter((x) => !x.proj && matchStatus(x));
    const sessTitleEl = $("#session-group-title"), sessCntEl = $("#session-count");
    if (sessTitleEl) sessTitleEl.textContent = (state.projects || []).length ? "独立会话" : "会话";
    if (sessCntEl) sessCntEl.textContent = loose.length || "";

    let shown = extAll ? loose : loose.slice(0, RECENT_N);
    const cur = !shown.some((x) => x.active) && loose.find((x) => x.active);
    if (cur) shown = [...shown, cur];

    const moreBtn = loose.length > RECENT_N
      ? `<li><button type="button" class="more-row ${extAll ? "open" : ""}" data-act="ext-more">
          <svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
          <span>${extAll ? "收起" : `展开其余 ${loose.length - RECENT_N} 个`}</span>
        </button></li>`
      : "";

    const emptyMsg = sideStatus === "running" ? "当前没有正在进行中的独立会话"
      : sideStatus === "blocked" ? "当前没有待审核的独立会话"
      : sideMachine !== null ? "这台电脑暂无独立会话"
      : "暂无独立会话，可点击上方「新建会话」或「新建项目」";

    const listEl = $("#session-list");
    if (listEl) {
      listEl.innerHTML = shown.length ? shown.map((x) => x.html).join("") + moreBtn : `<li class="empty-hint">${emptyMsg}</li>`;
    }

    const archGrp = $("#archived-group"), archList = $("#archived-list"), archCnt = $("#archived-count");
    if (archGrp && archList) {
      archGrp.hidden = !archived.length;
      if (archCnt) archCnt.textContent = archived.length || "";
      archList.innerHTML = archived.map((x) => x.html).join("");
      if (archived.some((x) => x.active)) archGrp.open = true;
    }
  }
  let extSoonT = null, extSoonN = 0;
  function extSoon() {
    if (extSoonT || extSoonN >= 15) return;
    extSoonN++;
    extSoonT = setTimeout(() => { extSoonT = null; if (view === "ext") loadExternal(); }, 1500);
  }
  function extWorking(gone) {
    const box = $("#x-working");
    const e = !gone && !extCur?.startsWith("h:") && ext.find((x) => x.id === extCur);
    const st = e && e.live ? e.status : "";
    const text = { working: "正在生成回复…", blocked: "正在等待确认…" }[st];
    if (!text) { box.hidden = true; return; }
    const was = nearBottom($("#x-thread"));
    box.className = "working-row " + st;
    box.innerHTML = `<span class="dot ${st}"></span>${esc(text)}`;
    box.hidden = false;
    stick($("#x-thread"), was);
  }
  function renderExtHead(gone) {
    extWorking(gone);
    if (extCur?.startsWith("h:")) return renderHistHead(extCur.slice(2));
    const e = ext.find((x) => x.id === extCur);
    if (!e) {
      $("#x-status").textContent = gone ? "会话已结束" : "正在读取会话…";
      $("#x-status").className = "status " + (gone ? "ended" : "unknown");
      $("#x-tag").hidden = true;
      $("#x-input").disabled = true;
      $("#x-send").disabled = true;
      if ($("#x-chips")) $("#x-chips").hidden = true;
      if (!gone) extSoon();
      return;
    }
    const meta = getSessMeta(e.kind, e.machine, e.session, "x:" + e.id);
    const on = extOnline(e);
    $("#x-name").textContent = extName(e);
    $("#x-kind").textContent = KIND_LABEL[e.kind] || e.kind;
    $("#x-tag").hidden = !meta?.archived;
    $("#x-tag").textContent = meta?.archived ? "已归档" : "";
    const ab = $("#ext-archive-btn");
    if (ab) ab.textContent = meta?.archived ? "移出归档" : "归档会话";
    $("#x-cwd").textContent = (e.machine ? machineName(e.machine) + " · " : "") + tilde(e.cwd);

    if (e.live && !gone) {
      const stLabel = { working: "工作中", waiting: "在等后台任务", idle: "在线空闲", blocked: "等待确认" }[e.status] || "在线";
      $("#x-status").textContent = stLabel + (e.app ? ` · ${e.app}` : "");
      $("#x-status").className = "status " + (e.status || "unknown");
    } else {
      $("#x-status").textContent = gone ? "已结束" : `上次对话 ${ago(e.updated || e.started)}`;
      $("#x-status").className = "status ended";
    }

    const busyElsewhere = !!(e.live && !e.can_send && e.status === "working");
    const canChat = !!(on && !busyElsewhere && (e.can_send || e.can_take_over || e.session));
    $("#x-composer").hidden = false;
    $("#x-input").disabled = !canChat;
    $("#x-send").disabled = !canChat;
    $("#x-input").placeholder = !on ? `${machineName(e.machine)} 当前离线，上线后可直接继续对话…`
      : busyElsewhere ? `正在 ${e.app || "原窗口"} 中执行，当前步骤完成后即可直接发消息…`
      : "输入消息继续对话…";
    $("#x-hint").textContent = canChat && e.machine ? machineName(e.machine) : "";
    renderExtChips(e.kind, e.machine, e.run, canChat && !e.hub, "x:" + e.id);
  }
  bindComposer($("#x-composer"), $("#x-input"), async (text) => {
    if (!text.trim()) return;
    if (extCur?.startsWith("h:")) {
      await sendInHist(extCur.slice(2), text);
      return;
    }
    const e = ext.find((x) => x.id === extCur);
    if (!e) throw new Error("找不到这个会话");
    const { model, effort } = currentExtModelChoice();
    const wantCustomRun = (e.run ? (model !== (e.run[0] || "") || effort !== (e.run[1] || "")) : Boolean(model || effort));
    addPendingThreadMsg($("#x-thread"), text);
    if (e.can_send && !(wantCustomRun && !e.live && e.can_take_over && e.kind !== "codex")) {
      try {
        const r = await api(`/api/external/${encodeURIComponent(e.id)}/send`, { body: { text, model, effort } });
        if (r.note) toast(r.note, "attn");
        return;
      } catch (err) {
        if (e.live || !e.session || /正在桌面端/.test(err.message || "")) {
          removePendingThreadMsg($("#x-thread"), text);
          throw err;
        }
        // Desktop IPC / shared daemon wasn't holding this thread: seamlessly resume via CLI below!
      }
    }
    toast("正在连接会话并发送…");
    let r;
    try {
      r = await api(`/api/external/${encodeURIComponent(e.id)}/takeover`, { body: { prompt: text, label: extName(e), model, effort } });
    } catch (err) {
      removePendingThreadMsg($("#x-thread"), text);
      throw err;
    }
    if (r.warning) toast(r.warning, "attn");
    await api("/api/sessions/archive", { body: { kind: e.kind, machine: e.machine || "", session: e.session, ext_id: e.id, archived: false } }).catch(() => {});
    ext = ext.filter((x) => x.id !== e.id);
    renderExt();
    location.hash = "#/p/" + encodeURIComponent(r.pane_id);
  }, () => {
    if (!extCur) return "";
    if (extCur.startsWith("h:")) {
      const h = hist.find((x) => x.id === extCur.slice(2));
      return h?.hub ? tagged(h.machine || "", h.hub) : h?.machine || "";
    }
    const e = ext.find((x) => x.id === extCur);
    return e?.hub ? tagged(e.machine || "", e.hub) : e?.machine || "";
  });
  function closeExt() { extStream?.close(); extStream = null; }
  async function openExt(id) {
    closeExt();
    extCur = id;
    if (id.startsWith("h:")) return openHist(id.slice(2));
    const el = $("#x-thread");
    el._msgs = null;
    primeThread(el, "x:" + id);
    resetEarlier(el, (c) => `/api/external/${encodeURIComponent(id)}/earlier?before=${c}`);
    extSoonN = 0;
    if (!ext.some((e) => e.id === id)) await loadExternal();
    renderExtHead();
    const mine = () => view === "ext" && extCur === id;
    // The stream drops when the hub restarts or the computer reconnects:
    // try again in a moment, keeping what is on screen.
    let tries = 0;
    const connect = () => {
      const es = extStream = openES(`/api/external/${encodeURIComponent(id)}/chat`);
      es.addEventListener("meta", (ev) => {
        tries = 0; extSoonN = 0;
        if (!ext.some((e) => e.id === id)) loadExternal();
        if (mine() && !JSON.parse(ev.data).structured) el.innerHTML = `<div class="thread-empty">还没有找到这个会话的记录。</div>`;
      });
      const show = (msgs) => { keepThread("x:" + id, msgs); if (mine()) { drawThread(msgs, el, "这个会话还没有消息。"); extWorking(); } };
      el._redraw = () => show(threadMsgs(el));
      es.addEventListener("patch", (ev) => mine() && show(applyPatch(el, JSON.parse(ev.data))));
      es.addEventListener("messages", (ev) => { el._msgs = null; el._older = null; show(JSON.parse(ev.data)); }); // an older computer
      es.addEventListener("gone", () => { closeExt(); if (mine()) renderExtHead(true); });
      es.onerror = () => {
        if (es.readyState !== EventSource.CLOSED || extStream !== es || !mine()) return;
        if (++tries > 20) { renderExtHead(true); return; }
        if (!el.querySelector(".msg")) el.innerHTML = `<div class="thread-empty">连不上那台电脑，正在重试…</div>`;
        setTimeout(() => { if (extStream === es && mine()) connect(); }, Math.min(1000 * tries, 5000));
      };
    };
    connect();
  }

  // ───────────────────────────── preferences (per device, in localStorage)
  const prefs = {
    theme: () => store.get("theme", "system"),
    text: () => store.get("text", "normal"),
    sendKey: () => store.get("sendKey", "enter"),
    notify: () => store.get("notify", true),
    fold: () => store.get("fold", true),
  };
  const darkMQ = matchMedia("(prefers-color-scheme: dark)");
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const THEME_ICONS = {
    light: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>',
    dark: '<svg viewBox="0 0 24 24"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z"/></svg>',
    system: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor" stroke="none"/></svg>',
  };
  function syncShortcutsUI() {
    const kbd = $("#cmdk-kbd");
    if (kbd) kbd.textContent = isMac ? "⌘K" : "Ctrl K";
    const sh = $("#super-send-hint");
    if (sh) sh.textContent = prefs.sendKey() === "mod" ? (isMac ? "⌘↵ 发送" : "Ctrl↵ 发送") : "↵ 发送";
  }
  function applyLook() {
    const root = document.documentElement;
    const t = prefs.theme(), x = prefs.text();
    if (t === "system") delete root.dataset.theme; else root.dataset.theme = t;
    if (x === "normal") delete root.dataset.text; else root.dataset.text = x;
    const dark = t === "dark" || (t === "system" && darkMQ.matches);
    $$('meta[name="theme-color"]').forEach((m) => { m.removeAttribute("media"); m.content = dark ? "#0d1016" : "#fcfcfd"; });
    const tb = $("#theme-btn");
    if (tb) {
      tb.innerHTML = THEME_ICONS[t] || THEME_ICONS.system;
      tb.title = `外观主题：${{ system: "跟随系统", light: "浅色模式", dark: "深色模式" }[t] || "跟随系统"}（点击切换）`;
    }
    syncShortcutsUI();
    dispatchEvent(new Event("collie:theme"));
  }
  darkMQ.addEventListener("change", applyLook);
  $("#theme-btn")?.addEventListener("click", () => {
    const order = ["system", "light", "dark"];
    const next = order[(order.indexOf(prefs.theme()) + 1) % order.length];
    store.set("theme", next);
    applyLook();
    if (view === "settings" && settingsTab === "local") loadPanel("settings");
    toast(`外观：${{ system: "跟随系统", light: "浅色模式", dark: "深色模式" }[next]}`);
  });
  applyLook();

  function prefsHTML() {
    const seg = (key, cur, opts) => `<div class="seg" data-pref="${key}">${opts.map(([v, label]) =>
      `<button type="button" data-v="${v}" class="${v === cur ? "on" : ""}">${label}</button>`).join("")}</div>`;
    const sw = (key, on) => `<button type="button" class="switch" role="switch" aria-checked="${on}" data-pref="${key}"></button>`;
    const row = (title, sub, ctl) => `<div class="pref"><div class="pl"><span class="pref-title">${title}</span>${sub ? `<small>${sub}</small>` : ""}</div>${ctl}</div>`;
    const perm = !("Notification" in window) ? "这个浏览器不支持通知（手机上通常要先添加到主屏幕）"
      : Notification.permission === "denied" ? "浏览器已拒绝通知，需要在浏览器的网站设置里打开"
      : "页面在后台时，agent 需要你确认或完成任务会弹通知";
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    return `<div class="settings prefs">
      <section class="card set-sec pref-sec">
        <header>
          <span class="set-ico"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg></span>
          <div class="set-head-txt"><h4>外观与排版</h4><p>仅保存在当前浏览器的本地存储中，不同电脑或手机可各自保持独立阅读偏好。</p></div>
        </header>
        <div class="pref-list">
          ${row("外观主题", "跟随系统时，设备切换深浅色模式会自动同步", seg("theme", prefs.theme(), [["system", '<span class="theme-swatch system"></span>跟随系统'], ["light", '<span class="theme-swatch light"></span>浅色'], ["dark", '<span class="theme-swatch dark"></span>深色']]))}
          ${row("对话文字字号", "调整聊天正文与输入框的阅读字号", seg("text", prefs.text(), [["small", "紧凑"], ["normal", "标准"], ["large", "大字号"]]))}
        </div>
      </section>
      <section class="card set-sec pref-sec">
        <header>
          <span class="set-ico"><svg viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="2.5"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M8 15h8"/></svg></span>
          <div class="set-head-txt"><h4>会话交互习惯</h4><p>定制消息发送按键与工具调用折叠展示方式。</p></div>
        </header>
        <div class="pref-list">
          ${row("发送消息快捷键", "另一种按键组合用于换行；Shift + Enter 始终换行", seg("sendKey", prefs.sendKey(), [["enter", "Enter"], ["mod", mac ? "⌘ Enter" : "Ctrl Enter"]]))}
          ${row("折叠连续的工具步骤", "连续工具调用超过 3 步时自动收拢，保持对话清爽", sw("fold", prefs.fold()))}
        </div>
      </section>
      <section class="card set-sec pref-sec">
        <header>
          <span class="set-ico"><svg viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg></span>
          <div class="set-head-txt"><h4>本机桌面通知</h4><p>当浏览器处于后台标签页时接收待审核与结项提醒。</p></div>
        </header>
        <div class="pref-list">
          ${row("浏览器通知提醒", esc(perm), sw("notify", prefs.notify() && (!("Notification" in window) || Notification.permission !== "denied")))}
        </div>
      </section>
    </div>`;
  }

  // ───────────────────────────── devices
  let devTimer;
  let devAddr = store.get("pairAddr", "");
  let pairing = { browser: null, machine: null }; // {code, expires}

  function openDevices() {
    clearInterval(devTimer);
    loadDevices();
    devTimer = setInterval(loadDevices, 5000);
  }

  async function newCode(kind) {
    const r = await api("/api/pair/new", { body: { kind } });
    pairing[kind] = { code: r.code, expires: new Date(r.expires).getTime() };
    return r;
  }

  const left = (p) => { const s = Math.max(0, Math.round((p.expires - Date.now()) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

  // A newer release: the footer says so, the devices page says where and how.
  const INSTALL_SH = "curl -fsSL https://raw.githubusercontent.com/Tdcle/collie/main/docs/install.sh | sh -s --";
  const INSTALL_PS1_URL = "https://raw.githubusercontent.com/Tdcle/collie/main/docs/install.ps1";
  const winCmd = (args) => `powershell -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm ${INSTALL_PS1_URL}))) ${args}"`;
  const installCmdFor = (os, args) => /^windows\b/i.test(os || "") ? winCmd(args) : `${INSTALL_SH} ${args}`;
  const isOld = (have, latest) => {
    const p = (v) => /^v\d+\.\d+\.\d+$/.test(v || "") ? v.slice(1).split(".").map(Number) : null;
    const a = p(have), b = p(latest);
    if (!a || !b) return false;
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
    return false;
  };
  async function checkUpdates() {
    try {
      const r = await api("/api/version");
      const n = $("#update-note");
      n.hidden = !r.outdated?.length;
      n.title = r.outdated?.length ? `Collie ${r.latest} 已发布，可以更新：${r.outdated.join("、")}（看「设备」页）` : "";
    } catch {}
  }
  checkUpdates();
  setInterval(checkUpdates, 30 * 60 * 1000);
  let pairOS = /Windows/i.test(navigator.userAgent) ? "win" : "unix";
  // Which agents a computer has: nothing when not known (an older node).
  const agentsTag = (list) => !Array.isArray(list) ? ""
    : list.length ? `<span class="agent-chips" title="这台电脑已安装的 Agent">${list.map((k) => `<span class="agent-chip">${GLYPHS[k] || ""}<span>${esc(AGENT_LABEL[k] || k)}</span></span>`).join("")}</span>`
    : `<span class="tag attn" title="找不到 claude、codex、agy 命令：安装后重连这台电脑">未装 Agent</span>`;
  const verTag = (have, latest, cmd) => !have ? "" : isOld(have, latest)
    ? `<span class="tag attn" title="${esc("更新：" + cmd)}">${esc(have)} → ${esc(latest)}</span>` : `<span class="mono">${esc(have)}</span>`;
  const updateRow = (have, latest, cmd, note, id, name) => isOld(have, latest)
    ? `<div class="update-cmd"><p class="pair-hint">发现新版本 <b>${esc(latest)}</b> <button class="btn small primary" data-update="${esc(id)}" data-name="${esc(name)}">一键升级到 ${esc(latest)}</button></p><p class="pair-hint muted">若在线升级未响应，可在该电脑终端执行${note ? "（" + esc(note) + "）" : ""}：</p><div class="code"><span>${esc(cmd)}</span><button class="icon-btn" data-copy="${esc(cmd)}" title="复制"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></button></div></div>` : "";

  async function loadDevices() {
    let r;
    try { r = await api("/api/devices"); } catch (err) { $("#devices-body").innerHTML = `<p class="panel-intro">${esc(err.message)}</p>`; return; }
    if (view !== "devices") return;
    const addrs = r.addresses || [];
    if (!addrs.includes(devAddr)) devAddr = addrs[0] || location.origin;
    const fresh = (k) => pairing[k] && pairing[k].expires - Date.now() > 15000;
    if (!fresh("browser")) await newCode("browser").catch(() => {});
    const pb = pairing.browser;
    const phoneURL = pb ? `${devAddr}/?pair=${pb.code}` : "";
    const pm = fresh("machine") ? pairing.machine : null;
    const nodeArgs = pm ? `node --hub ${devAddr} --code ${pm.code}` : "";
    const nodeCmd = pm ? `collie ${nodeArgs}` : "";
    const installCmd = pm ? `${INSTALL_SH} ${nodeArgs}` : "";
    const installWinCmd = pm ? winCmd(nodeArgs) : "";
    const hubCmd = installCmdFor(r.hub.os, "hub");
    const machines = r.devices.filter((d) => d.kind === "machine");
    const addrSel = addrs.length > 1 ? `<label class="addr-pick">使用这个接入地址<select id="dev-addr">${addrs.map((a) => `<option ${a === devAddr ? "selected" : ""}>${esc(a)}</option>`).join("")}</select></label>` : "";
    const keepOpen = document.activeElement?.id === "dev-addr" || document.activeElement?.closest?.("#add-hub");
    if (keepOpen) return;
    const typed = [...document.querySelectorAll("#add-hub input")].map((i) => i.value);
    const hubRelay = !r.hub.herdr && (!Array.isArray(r.hub.agents) || r.hub.agents.length === 0);
    const brainId = sup.router ? (sup.router.machine || "") : null;
    const activeCmd = pairOS === "win" ? installWinCmd : pairOS === "cli" ? nodeCmd : installCmd;
    const onlineNodes = machines.filter((d) => d.online).length + (r.hub.herdr || hubRelay ? 1 : 0);
    const totalNodes = machines.length + 1;

    $("#devices-body").innerHTML = `
      <div class="panel-banner">
        <span class="pb-ico">${OS_GLYPHS.relay}</span>
        <div class="pb-body">
          <div class="pb-title">跨网络多机互联拓扑</div>
          <div class="pb-desc">云端 Hub 常驻接收手机与网页访问；你的 Mac、Windows 或 Linux 电脑通过 <code>collie node</code> 主动加密外连，无需公网 IP、内网穿透或配置 SSH。</div>
        </div>
        <span class="pb-pill">${onlineNodes}/${totalNodes} 台在线</span>
      </div>

      <div class="pair-grid">
        <div class="card pair-card">
          <div class="card-h"><span class="card-h-main"><svg viewBox="0 0 24 24"><rect x="7" y="2" width="10" height="20" rx="2.5"/><path d="M11 18h2"/></svg><span>连接手机或平板</span></span><span class="card-h-sub">${pb ? left(pb) + " 内有效" : ""}</span></div>
          <div class="qr-wrap">${pb ? `<img class="qr" alt="配对二维码" src="/api/qr?text=${encodeURIComponent(phoneURL)}">` : ""}</div>
          <p class="pair-hint">手机相机扫码即可直接登录控制台，随后可「添加到主屏幕」作为原生应用使用。</p>
          <div class="code"><span>${esc(phoneURL)}</span><button class="icon-btn" data-copy="${esc(phoneURL)}" title="复制链接"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></button></div>
          ${addrSel}
        </div>

        <div class="card pair-card">
          <div class="card-h"><span class="card-h-main"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg><span>接入一台新电脑</span></span><span class="card-h-sub">支持 macOS / Win / Linux</span></div>
          <p class="pair-hint">在目标电脑终端运行一键命令，自动安装并注册系统级常驻服务：</p>
          ${pm ? `<div class="os-tabs" id="pair-os-tabs">
                 <button type="button" data-os="unix" class="${pairOS === "unix" ? "on" : ""}">macOS / Linux</button>
                 <button type="button" data-os="win" class="${pairOS === "win" ? "on" : ""}">Windows PowerShell</button>
                 <button type="button" data-os="cli" class="${pairOS === "cli" ? "on" : ""}">已装 Collie</button>
               </div>
               <div class="code big"><span>${esc(activeCmd)}</span><button class="icon-btn" data-copy="${esc(activeCmd)}" title="复制命令"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></button></div>
               <p class="pair-hint">一次性配对码在 <b>${left(pm)}</b> 内有效，绑定后断线或重启均自动免密重连。</p>`
             : `<div class="pair-perks">
                  <div><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg><span>支持 macOS、Windows 与 Linux 全平台原生接入</span></div>
                  <div><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg><span>节点主动外连 Hub，无需开放入站端口或配置 SSH</span></div>
                  <div><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg><span>系统级守护进程常驻，休眠唤醒或重启后自动重连</span></div>
                </div>
                <button class="btn primary block" id="new-node-code">生成一次性接入命令</button>`}
          <p class="pair-hint muted">只需目标电脑能访问 ${esc(devAddr)} 即可。</p>
        </div>
      </div>

      <div class="card"><div class="card-h"><span class="card-h-main">已接入的电脑与中枢</span><span class="card-h-sub">共 ${totalNodes} 台设备</span></div><ul class="rows">
        <li class="row dev-row">
          <span class="dev-ico">${osGlyph(r.hub.os, hubRelay)}<span class="dot ${r.hub.herdr || hubRelay ? "online" : "offline"}"></span></span>
          <div>
            <div class="meta"><b>${esc(r.hub.name)}</b><span class="tag">${hubRelay ? "Hub 中枢" : "Hub 服务"}</span>${hubRelay ? `<span class="tag relay">云端中继</span>` : ""}${brainId === "" ? `<span class="tag brain">Collie 大脑</span>` : ""}<span class="tag online-pill">在线</span>${r.hub.os ? `<span>${esc(r.hub.os)}</span>` : ""}${verTag(r.hub.version, r.latest, hubCmd)}</div>
            <div class="dev-sub"><span class="dev-path">${esc(tilde(r.hub.home))}</span>${hubRelay ? `<span class="muted" style="font-size:12px">负责消息路由与跨端同步</span>` : r.hub.herdr ? agentsTag(r.hub.agents) : `<span class="muted" style="font-size:12px">中枢转发服务（未启用本地会话守护）</span>`}</div>
            ${updateRow(r.hub.version, r.latest, hubCmd, "装 hub 时加过 --url 等参数的话照样带上", "", r.hub.name)}
          </div>
          <div class="dev-acts"><button class="btn ghost small" data-rename-dev="hub" data-name="${esc(r.hub.name)}">改名</button>${r.hub.herdr ? `<button class="btn small" data-launch-on="">+ 新建会话</button>` : `<span class="right">运行中</span>`}</div></li>
        ${machines.map((d) => { const dCmd = installCmdFor(d.os, "node"); return `<li class="row dev-row">
          <span class="dev-ico">${osGlyph(d.os)}<span class="dot ${d.online ? "online" : "offline"}"></span></span>
          <div>
            <div class="meta"><b>${esc(d.name)}</b>${brainId === d.id ? `<span class="tag brain">Collie 大脑</span>` : ""}${d.online ? `<span class="tag online-pill">在线</span>` : `<span class="tag">离线 · 上次 ${when(d.last_seen)}</span>`}<span>${esc(d.os || "")}</span>${verTag(d.version, r.latest, dCmd)}</div>
            <div class="dev-sub">${d.home ? `<span class="dev-path">${esc(tilde(d.home))}</span>` : ""}${d.online ? agentsTag(d.agents) : ""}</div>
            ${updateRow(d.version, r.latest, dCmd, "", d.id, d.name)}
          </div>
          <div class="dev-acts"><button class="btn ghost small" data-rename-dev="${esc(d.id)}" data-name="${esc(d.name)}">改名</button>${d.online ? `<button class="btn small" data-launch-on="${esc(d.id)}">+ 新建会话</button>` : ""}<button class="btn ghost small" data-del-dev="${esc(d.id)}" data-name="${esc(d.name)}">移除</button></div></li>`; }).join("")}
      </ul></div>

      <div class="card"><div class="card-h"><span class="card-h-main">联邦互联（其他 Hub）</span><span class="card-h-sub">可选</span></div>
        <p class="pair-hint">如果你在另一片独立网络还有一台 Collie Hub，粘贴它的配对链接即可在当前侧栏合并查看其全部会话。</p>
        <ul class="rows">${hubs.map((h) => { const on = remote.get(h.key)?.online; return `<li class="row dev-row">
          <span class="dot ${on ? "online" : "offline"}"></span>
          <div><div class="meta"><b>${esc(h.name)}</b><span>${on ? "在线" : "连不上"}</span></div><div class="text mono">${esc(h.url)}</div></div>
          <button class="btn ghost small" data-del-hub="${esc(h.key)}" data-name="${esc(h.name)}">移除</button></li>`; }).join("")}
        </ul>
        <form id="add-hub" class="hub-add">
          <input name="link" required autocomplete="off" placeholder="粘贴另一个 Hub「连接手机或平板」下方的配对链接">
          <input name="name" autocomplete="off" placeholder="显示名称（可选）">
          <button class="btn primary small" style="height:38px;padding:0 16px">添加</button>
        </form>
      </div>`;
    document.querySelectorAll("#add-hub input").forEach((i, n) => { i.value = typed[n] || ""; });
  }

  $("#devices-body").addEventListener("change", (e) => {
    if (e.target.id === "dev-addr") { devAddr = e.target.value; store.set("pairAddr", devAddr); e.target.blur(); loadDevices(); }
  });
  // Adding another hub: its phone link carries a one-time pairing code; trade
  // it for a token of its own (the cookie that link would set can't be used
  // from this page) and keep the token here, for every browser of this hub.
  $("#devices-body").addEventListener("submit", async (e) => {
    if (e.target.id !== "add-hub") return;
    e.preventDefault();
    const f = e.target, btn = f.querySelector("button");
    let u;
    try { u = new URL(f.link.value.trim()); } catch { toast("链接不对：要以 http:// 或 https:// 开头", "attn"); return; }
    const code = u.searchParams.get("pair");
    if (!code) { toast("链接里没有配对码（?pair=…），在那个 hub 的「设备」页复制「连接手机或平板」下面的链接", "attn"); return; }
    const url = (u.origin + u.pathname).replace(/\/+$/, "");
    if (url === location.origin) { toast("这就是当前这个 hub", "attn"); return; }
    if (location.protocol === "https:" && u.protocol === "http:") { toast("这个页面是 https，浏览器不让它连 http 的 hub", "attn"); return; }
    btn.disabled = true;
    try {
      let res;
      try {
        res = await fetch(url + "/api/pair", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "omit",
          body: JSON.stringify({ code, kind: "browser", name: "hub " + location.host, want_token: true }) });
      } catch { throw new Error("这个浏览器连不上 " + url + "（或者它还是旧版本，不允许跨站访问）"); }
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d.token) throw new Error(d.error || (res.ok ? "那个 hub 是旧版本，先升级到 v0.2.4" : res.statusText));
      const key = "h" + Math.random().toString(36).slice(2, 8);
      const name = f.name.value.trim().slice(0, 30) || u.hostname.split(".")[0];
      const next = [...hubs, { key, name, url, token: d.token }];
      hubs = (await api("/api/hubs", { body: { hubs: next } })).hubs;
      f.reset();
      toast(`已添加 ${name}`);
      await loadHubs();
      setTimeout(loadExternal, 1500);
      loadDevices();
    } catch (err) { toast(err.message, "attn"); }
    finally { btn.disabled = false; }
  });
  $("#devices-body").addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    try {
      if (b.dataset.os) { pairOS = b.dataset.os; loadDevices(); }
      else if (b.dataset.launchOn !== undefined) { openLauncher(b.dataset.launchOn); }
      else if (b.dataset.copy) { await copy(b.dataset.copy); toast("已复制"); }
      else if (b.id === "new-node-code") { await newCode("machine"); loadDevices(); }
      else if (b.dataset.update !== undefined) {
        const id = b.dataset.update;
        if (!confirm(`更新「${b.dataset.name}」上的 Collie？它会下载新版并重启，大约十几秒连不上${id ? "" : "（这是 hub，页面会短暂断开）"}；里面的 agent 不受影响。`)) return;
        b.disabled = true; b.textContent = "更新中…";
        const r = await api("/api/update?" + new URLSearchParams(id ? { machine: id } : {}), { body: {} });
        toast(r.latest ? "已经是最新版" : `已更新到 ${r.version}，正在重启`);
        setTimeout(() => { loadDevices(); checkUpdates(); }, 12000);
      }
      else if (b.dataset.delHub) {
        if (!confirm(`不再显示「${b.dataset.name}」的会话？那个 hub 本身不受影响。`)) return;
        hubs = (await api("/api/hubs", { body: { hubs: hubs.filter((h) => h.key !== b.dataset.delHub) } })).hubs;
        await loadHubs(); loadExternal(); loadHistory(); loadDevices();
      }
      else if (b.dataset.renameDev) {
        const id = b.dataset.renameDev;
        openRenameDialog({
          title: "修改设备名称",
          label: "设备显示名称",
          hint: "修改后在侧边栏筛选、派活列表和会话归属中同步生效。",
          value: b.dataset.name || "",
          onSave: async (newName) => {
            await api(`/api/devices/${encodeURIComponent(id)}/rename`, { body: { name: newName } });
            try { setLocalState(await api("/api/state")); renderSide(); renderTarget(true); } catch {}
            loadDevices();
            toast(`已改名为「${newName}」`);
          },
        });
      }
      else if (b.dataset.delDev) {
        if (!confirm(`移除「${b.dataset.name}」？它需要重新配对才能再连进来。`)) return;
        await api(`/api/devices/${encodeURIComponent(b.dataset.delDev)}/delete`, { body: {} });
        loadDevices();
      }
    } catch (err) { toast(err.message, "attn"); }
  });

  // Clipboard API needs a secure context; plain-http LAN addresses fall back.
  async function copy(text) {
    if (navigator.clipboard && isSecureContext) return navigator.clipboard.writeText(text);
    const t = document.createElement("textarea");
    t.value = text; t.style.position = "fixed"; t.style.opacity = "0";
    document.body.append(t); t.select(); document.execCommand("copy"); t.remove();
  }

  // ───────────────────────────── one agent: header
  function renderHead() {
    const v = find(current);
    if (!v) return;
    markSeen(v);
    $("#d-name").textContent = v.name === ROUTER ? "Collie" : v.is_agent ? title(v) : v.workspace_label || base(tilde(v.cwd));
    $("#d-name").title = v.is_agent && v.name && v.name !== ROUTER ? `会话代号：${v.name}` : "";
    $("#d-kind").textContent = v.is_agent ? (KIND_LABEL[v.kind] || v.kind) : "";
    const role = isWorker(v.name) ? "Collie 派出" : "";
    $("#d-worker").hidden = !role;
    $("#d-worker").textContent = role;
    const st = $("#d-status");
    st.className = "status " + v.status;
    st.innerHTML = `<span class="dot ${esc(v.status)}"></span>${esc(STATUS_LABEL[v.status] || v.status)}`;
    const busy = v.status === "working" || v.status === "starting";
    const stopBtn = $("#d-stop-btn");
    if (stopBtn) stopBtn.hidden = !busy;
    const menuInt = $("#menu-interrupt");
    if (menuInt) menuInt.hidden = !busy;
    const ms = state.machines || [];
    const home = ms.find((m) => m.id === (v.machine || ""))?.home;
    const rawCwd = v.cwd || "";
    const cwd = home && rawCwd.length >= home.length && rawCwd.slice(0, home.length).toLowerCase() === home.toLowerCase() && (!rawCwd[home.length] || rawCwd[home.length] === "/" || rawCwd[home.length] === "\\")
      ? "~" + rawCwd.slice(home.length)
      : tilde(rawCwd);
    $("#d-cwd").textContent = (ms.length > 1 ? machineName(v.machine) + " · " : "") + cwd;
    renderWorkerModel(v);
    renderPaneChips(v);
    $("#input").placeholder = `给 ${KIND_LABEL[v.kind] || v.kind || "Agent"} 发消息…`;
  }

  let dChipSeq = 0, dSwitching = false;
  async function renderPaneChips(v) {
    const wrap = $("#d-chips"), mSel = $("#d-model-sel"), eSel = $("#d-effort-sel");
    if (!wrap || !mSel || !eSel) return;
    if (!v || !v.is_agent || v.name === ROUTER || hubOf(v.pane_id)) {
      wrap.hidden = true;
      return;
    }
    const seq = ++dChipSeq;
    const w = !v.run && isWorker(v.name) ? sup.workers.find((x) => x.name === v.name && !x.ended) : null;
    const run = v.run || w?.run || ["", ""];
    const kind = v.kind === "antigravity" ? "agy" : v.kind;
    const machine = v.machine || "";
    const busy = v.status === "working" || v.status === "starting" || dSwitching;
    const info = await modelsFor(kind, machine).catch(() => ({ models: [], efforts: [] }));
    if (seq !== dChipSeq || find(current)?.pane_id !== v.pane_id) return;
    const curModel = run[0] || "";
    const curEffort = run[1] || "";
    const list = [...(info.models || [])];
    if (curModel && !list.some((m) => m.id === curModel)) list.unshift({ id: curModel });
    const short = (id) => id.split("/").pop();
    const defShort = info.default ? short(info.default) : "默认模型";
    let html = `<option value="" data-short="${esc(defShort)}" data-sub="${esc(info.default ? "现在是 " + info.default : "agent 自己的默认模型")}" ${!curModel ? "selected" : ""}>默认${info.default ? "（" + esc(short(info.default)) + "）" : ""}</option>`;
    html += list.map((m) => `<option value="${esc(m.id)}" data-short="${esc(m.label && m.label.length <= 24 ? m.label : short(m.id))}" data-sub="${esc(m.note || (m.label && m.label !== m.id ? m.id : ""))}" ${m.id === curModel ? "selected" : ""}>${esc(m.label || m.id)}</option>`).join("");
    if (mSel._html !== html) { mSel._html = html; mSel.innerHTML = html; }
    mSel.value = curModel;
    mSel.disabled = busy;
    mSel.title = busy ? "当前步骤执行完后可切换对话模型" : "切换这个会话使用的模型";
    const mObj = list.find((m) => m.id === curModel);
    const effs = mObj?.efforts?.length ? mObj.efforts : (info.efforts || []);
    const eff = effs.includes(curEffort) ? curEffort : "";
    const defE = info.default_effort || "";
    let ehtml = `<option value="" data-short="思考 · ${esc(EFFORT_LABEL[defE] || defE || "默认")}" data-sub="使用默认思考强度" ${!eff ? "selected" : ""}>默认${defE ? "（" + esc(EFFORT_LABEL[defE] || defE) + "）" : ""}</option>`;
    ehtml += effs.map((ef) => `<option value="${esc(ef)}" data-short="思考 · ${esc(EFFORT_LABEL[ef] || ef)}" data-sub="${esc(ef)}" ${ef === eff ? "selected" : ""}>${esc(EFFORT_LABEL[ef] || ef)}</option>`).join("");
    if (eSel._html !== ehtml) { eSel._html = ehtml; eSel.innerHTML = ehtml; }
    eSel.value = eff;
    eSel.hidden = effs.length === 0;
    eSel.disabled = busy;
    eSel.title = busy ? "当前步骤执行完后可调整思考强度" : "切换这个会话的思考强度";
    wrap.hidden = false;
    enhance(mSel); enhance(eSel);
    syncPick(mSel); syncPick(eSel);
    mSel._pick?.classList.toggle("changed", !!curModel);
    eSel._pick?.classList.toggle("changed", !!eff);
  }

  async function applyPaneModelSwitch(newModel, newEffort) {
    const v = find(current);
    if (!v || !v.is_agent || dSwitching) return;
    const kind = v.kind === "antigravity" ? "agy" : v.kind;
    saveLastModel(kind, v.machine || "", newModel, newEffort);
    dSwitching = true;
    renderPaneChips(v);
    toast("正在切换模型并无缝续接会话…");
    try {
      const r = await api("/api/sessions/model", { body: {
        pane_id: v.pane_id,
        workspace_id: v.workspace_id,
        kind: v.kind,
        machine: v.machine || "",
        session: v.session || "",
        cwd: v.cwd || "",
        label: title(v),
        name: v.name || "",
        model: newModel,
        effort: newEffort,
      } });
      if (r.warning) toast(r.warning, "attn");
      else toast("模型与思考强度已更新");
      const oldMsgs = threadCache.get("p:" + v.pane_id);
      if (oldMsgs && r.pane_id) keepThread("p:" + r.pane_id, oldMsgs);
      try { setLocalState(await api("/api/state")); renderSide(); } catch {}
      if (r.pane_id && r.pane_id !== current) {
        location.hash = "#/p/" + encodeURIComponent(r.pane_id);
      } else {
        renderHead();
      }
    } catch (err) {
      toast(err.message, "attn");
    } finally {
      dSwitching = false;
      const curV = find(current);
      if (curV) renderPaneChips(curV);
    }
  }
  $("#d-model-sel")?.addEventListener("change", (ev) => {
    applyPaneModelSwitch(ev.target.value, $("#d-effort-sel")?.value || "");
  });
  $("#d-effort-sel")?.addEventListener("change", (ev) => {
    applyPaneModelSwitch($("#d-model-sel")?.value || "", ev.target.value);
  });

  // What model an agent was started with, recorded when Collie (the launcher
  // or a spawn) started it. Agents started by hand elsewhere show nothing.
  async function renderWorkerModel(v) {
    const el = $("#d-model");
    const w = !v.run && isWorker(v.name) ? sup.workers.find((x) => x.name === v.name && !x.ended) : null;
    const run = v.run || w?.run;
    const kind = v.run ? v.kind : w?.kind === "antigravity" ? "agy" : w?.kind;
    const machine = v.run ? v.machine : w?.machine;
    const key = run ? [v.pane_id, kind, machine, ...run].join("|") : "";
    if (el._key === key) return;
    el._key = key;
    if (!key) { el.hidden = true; el.textContent = ""; return; }
    let [model, effort] = run;
    const own = !model;
    const info = hubOf(v.pane_id) ? {} : await modelsFor(kind, machine || "").catch(() => ({}));
    if (own) model = info.default || "";
    if (el._key !== key) return;
    // The model list's own name ("Gemini 4 Neon (XHigh)"), its bracket read
    // as the thinking level when the id carries one, as Antigravity's do.
    let name = (info.models || []).find((m) => m.id === model)?.label || model.split("/").pop();
    const b = name.match(/^(.*\S)\s*\(([^)]+)\)$/);
    if (b && EFFORT_LABEL[b[2].toLowerCase()]) { name = b[1]; effort ||= b[2].toLowerCase(); }
    const parts = [model ? name + (own ? "（默认）" : "") : "默认模型"];
    if (effort) parts.push("思考 " + (EFFORT_LABEL[effort] || effort));
    el.textContent = parts.join(" · ");
    el.title = `启动时用的模型：${model || "agent 自己的设置"}${effort ? "，思考强度 " + effort : ""}（之后在 agent 里换过的话这里不会变）`;
    el.hidden = false;
  }

  // ───────────────────────────── one agent: pure chat stream
  let stream = null;
  function openStream() {
    $("#viewer").dataset.mode = "chat";
    $("#detail").classList.add("chat-mode");
    openChat(current);
  }
  function closeStream() { stream?.close(); stream = null; }

  // ───────────────────────────── one agent: conversation
  let showRaw = false;
  function resetChat() {
    $("#thread").innerHTML = "";
    $("#thread").classList.remove("asking");
    $("#live").hidden = true;
    $("#live").innerHTML = "";
    $("#thread")._sig = ""; $("#thread")._msgs = null; $("#thread")._pending = null; $("#thread")._blocks = null; $("#thread")._older = null; showRaw = false;
  }
  function openChat(id) {
    stream = openES(paneURL(id, "chat"));
    const alive = () => id === current && view === "pane";
    stream.addEventListener("reset", () => alive() && resetChat());
    const th = $("#thread");
    resetEarlier(th, (c) => paneURL(id, "earlier") + "?before=" + c);
    th._redraw = () => alive() && drawThread(threadMsgs(th));
    if (!th._msgs) primeThread(th, "p:" + id);
    const showPane = (msgs) => { keepThread("p:" + id, msgs); drawThread(msgs); };
    stream.addEventListener("patch", (e) => alive() && showPane(applyPatch(th, JSON.parse(e.data))));
    stream.addEventListener("messages", (e) => alive() && drawThread(JSON.parse(e.data)));
    stream.addEventListener("log", (e) => alive() && drawFallback(JSON.parse(e.data).text));
    stream.addEventListener("live", (e) => alive() && drawLive(JSON.parse(e.data)));
    stream.addEventListener("gone", () => { $("#gone").hidden = false; closeStream(); });
  }
  // Threads on a .viewer.chatbg scroll the viewer around them.
  const scroller = (el) => el.closest(".viewer.chatbg") || el;
  const nearBottom = (el) => { const s = scroller(el); return s.scrollHeight - s.scrollTop - s.clientHeight < 80; };
  const stick = (el, was) => {
    if (!was) return;
    const s = scroller(el);
    s.scrollTop = s.scrollHeight;
    requestAnimationFrame(() => { s.scrollTop = s.scrollHeight; }); // after images and code lay out
  };

  // A stream sends {base, from, msgs}: the first (and every reconnect) has
  // from === base and carries the whole view; later ones replace the
  // messages from position `from` on, and `base` moves when old ones fall off.
  function applyPatch(el, p) {
    let list = el._msgs, base = el._base;
    if (!list || p.from === p.base || p.from < base || p.from > base + list.length) {
      list = []; base = p.from;
      el._older = null; // a fresh view: what was loaded before may not join it
    }
    list = list.slice(0, p.from - base).concat(p.msgs);
    if (p.base > base) {
      if (el._older) el._older = el._older.concat(list.slice(0, p.base - base));
      list = list.slice(p.base - base); base = p.base;
    }
    el._msgs = list; el._base = base; el._liveEarlier = p.earlier || 0;
    reconcilePendingThreadMsgs(el);
    return threadMsgs(el);
  }
  const normMsgText = (t) => String(t || "").trim().replace(/\r\n/g, "\n");
  function reconcilePendingThreadMsgs(el) {
    if (!el._pending?.length) return;
    const now = Date.now();
    const seenUser = new Set((el._msgs || []).filter((m) => m.kind === "user").map((m) => normMsgText(m.text)));
    el._pending = el._pending.filter((p) => !seenUser.has(normMsgText(p.text)) && now - p.at < 45000);
  }
  function addPendingThreadMsg(el, text) {
    if (!el || !String(text || "").trim()) return;
    el._pending = [...(el._pending || []), { kind: "user", text, pending: true, at: Date.now() }];
    el._redraw ? el._redraw() : drawThread(threadMsgs(el), el);
  }
  function removePendingThreadMsg(el, text) {
    if (!el || !el._pending?.length) return;
    const want = normMsgText(text);
    const idx = el._pending.findIndex((p) => normMsgText(p.text) === want);
    if (idx >= 0) el._pending.splice(idx, 1);
    el._redraw ? el._redraw() : drawThread(threadMsgs(el), el);
  }
  // A thread's messages: the older ones loaded on request, then the live view, plus optimistic pending sends.
  const threadMsgs = (el) => {
    reconcilePendingThreadMsgs(el);
    return (el._older || []).concat(el._msgs || []).concat(el._pending || []);
  };
  const earlierCursor = (el) => (el._older ? el._olderEarlier : el._liveEarlier) || 0;
  function resetEarlier(el, url) {
    el._older = null; el._olderEarlier = 0; el._liveEarlier = 0; el._earlierURL = url;
    el._loadMore = url && (() => { el._earlierFailed = false; if (earlierCursor(el) > 0) loadEarlier(el); });
  }

  // Scrolled to the top of a conversation: fetch the page before the oldest
  // message shown, keeping the reader's place.
  async function loadEarlier(el) {
    if (el._loadingEarlier || !el._earlierURL) return;
    const cursor = earlierCursor(el);
    if (!cursor) return;
    el._loadingEarlier = true;
    el._redraw?.();
    try {
      const r = await api(el._earlierURL(cursor));
      if (el._earlierURL && earlierCursor(el) === cursor) {
        el._older = (r.messages || []).concat(el._older || []);
        el._olderEarlier = r.earlier || 0;
      }
    } catch (err) {
      el._earlierFailed = true; // scrolling up tries again; nothing loops on its own
      toast(err.message, "attn");
    }
    el._loadingEarlier = false;
    const s = scroller(el), fromBottom = s.scrollHeight - s.scrollTop;
    el._redraw?.();
    s.scrollTop = s.scrollHeight - fromBottom;
  }
  // Any conversation scrolled to its top brings in the page before: each
  // thread says how (_loadMore), this one listener notices.
  document.addEventListener("scroll", (ev) => {
    const s = ev.target;
    if (!(s instanceof Element) || s.scrollTop >= 40 || s.scrollHeight <= s.clientHeight + 100) return;
    const el = s._loadMore ? s : [...s.querySelectorAll(".thread")].find((t) => t._loadMore && (t.parentElement === s || scroller(t) === s));
    el?._loadMore();
  }, { capture: true, passive: true });

  // Opening a thread: what was on screen last time shows at once and the live
  // stream updates it; a thread never opened shows a skeleton of a
  // conversation, so nothing jumps when the messages land.
  const threadCache = new Map();
  const SKELETON = `<div class="thread-skel" aria-label="读取中">${["user", "a", "a short", "tools", "user short", "a", "a short"].map((c) => `<div class="sk ${c}"></div>`).join("")}</div>`;
  function primeThread(el, key) {
    el._sig = ""; el._blocks = null; el._fresh = true;
    const got = key && threadCache.get(key);
    if (got) { drawThread(got, el); el._fresh = true; } else el.innerHTML = SKELETON;
  }
  function keepThread(key, msgs) {
    if (!key || !msgs || !msgs.length) return;
    threadCache.delete(key);
    threadCache.set(key, msgs.slice(-120));
    while (threadCache.size > 20) threadCache.delete(threadCache.keys().next().value);
  }

  document.addEventListener("click", async (ev) => {
    const b = ev.target.closest("[data-act=ask-reveal]");
    if (!b || !extCur) return;
    b.disabled = true;
    try { await api(`/api/external/${encodeURIComponent(extCur)}/reveal`, { body: {} }); toast("已在电脑上的 Claude 桌面版打开这个会话"); }
    catch (err) { toast(err.message, "attn"); }
    finally { b.disabled = false; }
  });
  // An end-of-turn button answers by sending its label from this view's composer.
  document.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-act=ask-reply]");
    if (!b) return;
    const form = b.closest("section.view")?.querySelector("form.composer:not([hidden])");
    const input = form?.querySelector("textarea");
    if (!form || !input) { toast("这里没法发消息，去电脑上回答", "attn"); return; }
    input.value = b.dataset.text;
    form.requestSubmit();
  });
  function drawThread(msgs, el = $("#thread"), empty = "还没有对话。发一条消息开始吧。") {
    // Just opened: start at the latest message.
    const was = el._fresh || nearBottom(el) || !el.childElementCount;
    if (msgs.length) el._fresh = false;
    const open = new Set($$("details.tool[open], details.toolrun[open]", el).map((d) => d.dataset.i));
    if (!msgs.length) { el.innerHTML = `<div class="thread-empty">${empty}</div>`; el._sig = ""; el._blocks = null; return; }
    const blocks = [];
    let html = "", i = 0;
    const cut = () => { blocks.push(html); html = ""; };
    while (i < msgs.length) {
      const m = msgs[i];
      if (m.kind === "tool") {
        // A run of tool calls reads as one quiet line; long runs fold away,
        // keeping only the latest step in view.
        const start = i;
        while (i < msgs.length && msgs[i].kind === "tool") i++;
        const run = msgs.slice(start, i);
        const row = (t, k) => {
          const cls = t.error ? "err" : (t.output ? "" : "pending");
          return `<details class="tool ${cls}" data-i="${k}" ${open.has(String(k)) ? "open" : ""}>`
            + `<summary><span class="tname">${esc(t.name)}</span><span class="targ">${esc(t.input)}</span></summary>`
            + (t.output ? `<pre>${esc(t.output)}</pre>` : "") + `</details>`;
        };
        if (run.length <= 3 || !prefs.fold()) {
          html += `<div class="tools">${run.map((t, k) => row(t, start + k)).join("")}</div>`;
          cut();
          continue;
        }
        const key = "run" + start;
        const names = [...new Set(run.map((t) => t.name))].slice(0, 4).join("、");
        const errs = run.filter((t) => t.error).length;
        html += `<div class="tools"><details class="toolrun" data-i="${key}" ${open.has(key) ? "open" : ""}>
          <summary><span class="n">${run.length} 个步骤</span><span class="targ">${esc(names)}${errs ? ` · <b class="errs">${errs} 个出错</b>` : ""}</span></summary>
          <div class="toolrun-body">${run.slice(0, -1).map((t, k) => row(t, start + k)).join("")}</div>
        </details>${row(run[run.length - 1], i - 1)}</div>`;
        cut();
        continue;
      }
      if (m.kind === "ask" && m.name === "recap") {
        html += `<div class="recap-note">${esc(m.input)}</div>`;
        cut();
        i++;
        continue;
      }
      if (m.kind === "ask") {
        // A question to you: AskUserQuestion is answered in the app it runs
        // in; the Claude app's end-of-turn buttons just send their label.
        const later = msgs.slice(i + 1).some((x) => x.kind === "user");
        const box = m.name === "wrap_up";
        const open = box ? !later : !m.output;
        const opts = (m.options || []).map((o) => box && open
          ? `<button type="button" class="btn small" data-act="ask-reply" data-text="${esc(o)}">${esc(o)}</button>`
          : `<span class="opt">${esc(o)}</span>`).join("");
        html += `<div class="ask-card ${open ? "open" : ""}">`
          + (m.input ? `<div class="recap">${esc(m.input)}</div>` : "")
          + `<div class="q"><span class="dot ${open ? "blocked" : "unknown"}"></span>${esc(m.text)}</div>`
          + (opts ? `<div class="opts">${opts}</div>` : "")
          + (m.output ? `<div class="answer">${esc(m.output)}</div>`
            : open && !box ? (el.id === "x-thread" && /^cd-/.test(extCur || "")
              ? `<div class="where"><button type="button" class="btn small" data-act="ask-reveal">去 Claude 桌面版回答</button><span>这个对话框只能在电脑上答</span></div>`
              : el.id === "thread" ? "" : `<div class="where">在电脑上的会话里回答</div>`) : "")
          + `</div>`;
        cut();
        i++;
        continue;
      }
      if (m.kind === "user") {
        html += `<div class="msg user${m.pending ? " pending" : ""}">${userText(m.text)}</div>`;
      } else {
        const rendered = md(m.text);
        const extraImgs = imagesIn(m.text);
        html += `<div class="msg assistant">${rendered}${extraImgs}</div>`;
      }
      cut();
      i++;
    }
    if (el._loadingEarlier) blocks.unshift(`<div class="earlier-row">加载中…</div>`);
    const sig = blocks.join("");
    if (sig === el._sig) return;
    el._sig = sig;
    const old = el._blocks;
    if (old && el.children.length === old.length && el.lastElementChild === el._last) {
      // Keep what did not change (and its open/closed state); redraw from
      // the first block that did.
      let k = 0;
      while (k < old.length && k < blocks.length && old[k] === blocks[k]) k++;
      while (el.children.length > k) el.lastElementChild.remove();
      el.insertAdjacentHTML("beforeend", blocks.slice(k).join(""));
    } else {
      el.innerHTML = sig;
    }
    el._blocks = blocks; el._last = el.lastElementChild;
    stick(el, was);
    // Too short to scroll, with more before it: there is no top to scroll
    // to, so bring the earlier page in now.
    if (el._earlierURL && !el._loadingEarlier && !el._earlierFailed && earlierCursor(el) > 0) {
      const s = scroller(el);
      if (s.scrollHeight <= s.clientHeight + 100) setTimeout(() => loadEarlier(el));
    }
  }

  function cleanFallbackLog(s) {
    return String(s || "")
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      .replace(/\r/g, "")
      .trim();
  }

  function drawFallback(text) {
    const el = $("#thread");
    const was = nearBottom(el) || !el.childElementCount;
    const v = find(current);
    const cleaned = cleanFallbackLog(text);
    const locked = /This conversation is open in another app/i.test(cleaned);
    const note = locked
      ? "这个对话当前也在电脑上的桌面端窗口里打开着；你直接在这里发消息即可无缝续聊"
      : v && v.is_agent ? `${esc(KIND_LABEL[v.kind] || v.kind)} 还没有生成结构化记录，以下为最近会话输出` : "会话输出";
    const body = locked ? cleaned.replace(/\n*■ This conversation is read-only[\s\S]*$/i, "").trim() : cleaned;
    el.innerHTML = `<div class="fallback-note">${note}</div>${body ? `<pre class="termcard">${esc(body)}</pre>` : ""}`;
    stick(el, was);
  }

  let lastLive = null;
  function drawLive(l) {
    lastLive = l;
    $("#thread").classList.toggle("asking", l.status === "blocked" && !!l.approval);
    const box = $("#live");
    const th = $("#thread");
    const was = nearBottom(th);
    let html = "";
    if (l.status === "working" && l.tail) {
      html = `<div class="live-working"><span class="dot working"></span><pre>${esc(l.tail)}</pre><span class="meta"></span></div>`;
    } else if (l.status === "blocked" && l.approval) {
      const v = find(current);
      html = askHTML(l.approval, v ? title(v) : "agent");
    }
    // Live updates arrive every second (the agent's clock ticks); redrawing
    // an unchanged card would replay its entrance and make it jump.
    if (html !== box._html) {
      box._html = html;
      box.innerHTML = html;
    }
    // The counters tick every second: only their text changes.
    const meta = box.querySelector(".live-working .meta");
    if (meta && meta.textContent !== (l.meta || "")) meta.textContent = l.meta || "";
    box.hidden = !html;
    stick(th, was);
  }

  // Terminal dialogs arrive hard-wrapped at the terminal's width. Rebuild the
  // paragraphs so the card can use its own width, and find the real question.
  const CJK = /[　-鿿＀-￯]/;
  function readDialog(text) {
    const raw = (text || "").split("\n");
    const ind = (l) => l.match(/^ */)[0].length;
    const filled = raw.filter((l) => l.trim());
    const base = filled.length ? Math.min(...filled.map(ind)) : 0;
    const paras = [];
    let cur = [];
    for (const l of raw) {
      if (l.trim()) cur.push(l);
      else if (cur.length) { paras.push(cur); cur = []; }
    }
    if (cur.length) paras.push(cur);
    // A line that ends mid-word and is followed by a capitalised line is a real
    // line break ("This command requires approval" / "Do you want…"), not a wrap.
    const split = [];
    for (const p of paras) {
      let part = [p[0]];
      for (let k = 1; k < p.length; k++) {
        const prev = p[k - 1].trim(), next = p[k].trim();
        if (ind(p[k]) === ind(p[k - 1]) && /[A-Za-z0-9]$/.test(prev) && /^[A-Z]/.test(next)) { split.push(part); part = []; }
        part.push(p[k]);
      }
      split.push(part);
    }
    let blocks = split.map((p) => {
      const t0 = p[0].trim();
      // Indented deeper than the dialog's text, or a lone path: show as-is.
      if (p.every((l) => ind(l) > base) || (p.length === 1 && /^[~/.][^\s]*$/.test(t0))) {
        const cut = Math.min(...p.map(ind));
        return { code: true, text: p.map((l) => l.slice(cut)).join("\n") };
      }
      let t = "";
      for (const l of p.map((x) => x.trim())) t += !t ? l : (CJK.test(t.slice(-1)) && CJK.test(l[0]) ? "" : " ") + l;
      return { code: false, text: t };
    });
    // Terminal chrome that means nothing in a card.
    // Claude's question box heads itself with tabs ("☐ Color  ✔ Submit").
    blocks = blocks.filter((b) => !/^(←\s*)?[☐☒✔]\s/.test(b.text.trim()));
    blocks = blocks.filter((b, i) => b.code || !(/^tip:/i.test(b.text) ||
      (i === blocks.length - 1 && b.text.split(/\s+/).length <= 3 && !/[.:?？。：]/.test(b.text))));
    // The question is the last sentence ending in "?"; it becomes the title.
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.code) continue;
      const ms = [...b.text.matchAll(/[^.!?。！？]*[?？]/g)];
      if (!ms.length) continue;
      const m = ms[ms.length - 1];
      const rest = (b.text.slice(0, m.index) + b.text.slice(m.index + m[0].length)).trim();
      const out = blocks.slice();
      if (rest) out[i] = { code: false, text: rest }; else out.splice(i, 1);
      // "Quick safety check: Is this…" → the label adds nothing to a title.
      const q = m[0].trim().replace(/^[^:：?？]{1,24}[:：]\s*(?=\S)/, "");
      return { q, blocks: out };
    }
    const last = blocks.map((b) => !b.code).lastIndexOf(true);
    if (last < 0) return { q: "要继续吗？", blocks };
    return { q: blocks[last].text, blocks: blocks.filter((_, k) => k !== last) };
  }

  // A calm decision sheet: the question as the title, the dialog's text
  // reflowed under it, the choices as a list.
  function askHTML(a, who) {
    const { q, blocks } = readDialog(a.question);
    const choices = a.choices || [];
    const body = blocks.map((b) => b.code ? `<pre class="ctx-code">${esc(b.text)}</pre>` : `<p>${esc(b.text)}</p>`).join("");
    return `<div class="ask">
      <div class="ask-head"><span class="dot blocked"></span><span class="who">${esc(who)}</span><span>需要你确认</span><span class="spacer"></span>
        <button data-raw>${showRaw ? "收起终端" : "查看终端"}</button></div>
      <div class="ask-q"><div class="q">${esc(q)}</div>${body ? `<div class="ctx">${body}</div>` : ""}</div>
      ${showRaw ? `<pre class="ask-raw">${esc(a.screen)}</pre>` : ""}
      ${choices.length ? `<div class="choices">${choices.map((c, i) => `<button class="choice ${c.current ? "current" : ""}" data-choice="${i}">
          <span class="n">${esc(c.text || i + 1)}</span><span class="l">${esc(c.label)}${c.desc ? `<span class="d">${esc(c.desc)}</span>` : ""}</span></button>`).join("")}</div>
        <div class="ask-keys"><button data-k="esc">Esc 取消</button></div>`
      : `<div class="ask-keys"><button data-k="up">↑</button><button data-k="down">↓</button><button data-k="esc">Esc</button><button class="go" data-k="enter">确认 ↵</button></div>`}
    </div>`;
  }

  $("#live").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || !current) return;
    if (b.hasAttribute("data-raw")) { showRaw = !showRaw; if (lastLive) drawLive(lastLive); return; }
    if (b.dataset.choice != null) {
      const c = lastLive?.approval?.choices?.[+b.dataset.choice];
      if (!c) return;
      if (c.text) sendText(c.text); else sendKeys(c.keys || ["enter"]);
      b.closest(".ask").style.opacity = ".5";
      return;
    }
    if (b.dataset.k) sendKeys([b.dataset.k]);
  });

  // A file path in a message: ~/…, /…, or C:\… / C:/…, ending in a name with an extension.
  // It runs on escaped text, so it never meets a raw quote or tag.
  const FILE_RE = /(^|[\s(（：，、；>;])((?:(?:~|\/)[\w.\-+@%~\/\\]*|[A-Za-z]:[\\/][\w.\-+@%~\/\\]*)[\\/][\w.\-+@%~]+\.[A-Za-z0-9]{1,8})(?![\w\/\\])/g;

  // ───────────────────────────── file viewer
  // A file an agent mentions opens here, read-only, from the computer it is on.
  const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;
  const MD_EXT = /\.(md|markdown|mdx)$/i;
  const IMG_TYPE = { svg: "image/svg+xml", jpg: "image/jpeg", jpeg: "image/jpeg", ico: "image/x-icon" };
  function fileContextMachine() {
    if (view === "pane") return find(current)?.machine;
    if (view === "ext") {
      const id = extCur || "";
      return (id.startsWith("h:") ? hist.find((h) => h.id === id.slice(2)) : ext.find((x) => x.id === id))?.machine;
    }
  }
  async function fetchFile(path, machine) {
    const q = `/api/file?path=${encodeURIComponent(path)}${machine ? "&machine=" + encodeURIComponent(machine) : ""}${IMG_EXT.test(path) ? "&as=image" : ""}`;
    const r = routeReq(q);
    const res = await fetch(r.url, { headers: r.hub ? { Authorization: "Bearer " + r.hub.token } : {}, credentials: r.hub ? "omit" : "same-origin" });
    if (res.status === 404) return null;
    if (!res.ok) { let e = {}; try { e = await res.json(); } catch {} throw new Error(e.error || "打不开这个文件"); }
    return { kind: res.headers.get("X-File-Kind"), size: +res.headers.get("X-File-Size") || 0,
      path: decodeURIComponent(res.headers.get("X-File-Path") || path), blob: await res.blob(), machine };
  }
  // Where the message came from first, then the hub, then every other computer.
  const fileTries = () => {
    const ms = (state.machines || []).filter((m) => !m.hub && (m.local || m.online)).map((m) => m.local ? "" : m.id);
    return [...new Set([fileContextMachine() ?? "", "", ...ms])];
  };
  async function findFile(path, tries = fileTries()) {
    for (const m of tries) { const f = await fetchFile(path, m); if (f) return f; }
    return null;
  }
  let fileUrl = "", fileSeq = 0;
  let lbUrl = "", lbSeq = 0;
  function closeImageModal() {
    const dlg = $("#img-lightbox");
    if (!dlg) return;
    lbSeq++;
    if (dlg.open) dlg.close();
    const img = $("#ilb-img");
    if (img) { img.removeAttribute("src"); img.hidden = true; img.classList.remove("zoomed"); }
    if (lbUrl) { URL.revokeObjectURL(lbUrl); lbUrl = ""; }
  }
  async function openImageModal(path) {
    const dlg = $("#img-lightbox"), img = $("#ilb-img"), note = $("#ilb-note"), dl = $("#ilb-dl");
    if (!dlg || !img) return;
    const seq = ++lbSeq;
    const isHttp = /^https?:\/\//i.test(path);
    const fname = (path.split(/[?#]/)[0].split(/[\\/]/).pop() || "image.png");
    $("#ilb-name").textContent = fname;
    $("#ilb-info").textContent = isHttp ? path : tilde(path);
    img.classList.remove("zoomed");
    dl.hidden = true;
    if (lbUrl) { URL.revokeObjectURL(lbUrl); lbUrl = ""; }

    if (isHttp) {
      note.hidden = true;
      img.src = path;
      img.hidden = false;
      dl.href = path;
      dl.download = fname;
      dl.hidden = false;
      if (!dlg.open) dlg.showModal();
      return;
    }

    const cached = thumbs.get(path);
    if (cached) {
      note.hidden = true;
      img.src = cached;
      img.hidden = false;
      dl.href = cached;
      dl.download = fname;
      dl.hidden = false;
    } else {
      img.removeAttribute("src");
      img.hidden = true;
      note.textContent = "正在加载原图…";
      note.hidden = false;
    }
    if (!dlg.open) dlg.showModal();

    const tries = fileTries();
    try {
      const f = await findFile(path, tries);
      if (seq !== lbSeq) return;
      if (!f || f.kind !== "image") {
        if (!cached) {
          note.textContent = f ? "这个文件无法作为图片预览。" : `在${tries.length > 1 ? "各台电脑" : "这台电脑"}上都没找到这张图片。`;
          note.hidden = false;
        }
        return;
      }
      const where = (state.machines || []).length > 1 ? machineName(f.machine) + " · " : "";
      $("#ilb-info").textContent = where + f.path + (f.size ? " · " + fmtSize(f.size) : "");
      const ext = fname.split(".").pop().toLowerCase();
      lbUrl = URL.createObjectURL(new Blob([f.blob], { type: IMG_TYPE[ext] || "image/" + ext }));
      note.hidden = true;
      img.src = lbUrl;
      img.hidden = false;
      dl.href = lbUrl;
      dl.download = fname;
      dl.hidden = false;
    } catch (err) {
      if (seq !== lbSeq || cached) return;
      note.textContent = err.message || "原图读取失败";
      note.hidden = false;
    }
  }
  $("#img-lightbox")?.addEventListener("click", (ev) => {
    if (ev.target.closest("[data-ilb-close]")) { closeImageModal(); return; }
    if (ev.target.id === "ilb-img") { ev.target.classList.toggle("zoomed"); return; }
    if (ev.target === $("#img-lightbox") || ev.target.hasAttribute("data-ilb-backdrop")) closeImageModal();
  });
  $("#img-lightbox")?.addEventListener("close", () => {
    lbSeq++;
    if (lbUrl) { URL.revokeObjectURL(lbUrl); lbUrl = ""; }
  });

  async function openFile(path) {
    if (IMG_EXT.test((path || "").split(/[?#]/)[0])) {
      return openImageModal(path);
    }
    const body = $("#fv-body"), seq = ++fileSeq;
    $("#fv-name").textContent = path.split(/[\\/]/).pop();
    $("#fv-path").textContent = path;
    body.innerHTML = `<p class="fv-note muted">读取中…</p>`;
    showFilePane();
    const tries = fileTries();
    let f = null;
    try {
      f = await findFile(path, tries);
    } catch (e) { body.innerHTML = `<p class="fv-note">${esc(e.message)}</p>`; return; }
    if (seq !== fileSeq) return;
    if (!f) { body.innerHTML = `<p class="fv-note">在${tries.length > 1 ? "各台电脑" : "这台电脑"}上都没找到这个文件。</p>`; return; }
    const where = (state.machines || []).length > 1 ? machineName(f.machine) + " · " : "";
    $("#fv-path").textContent = where + f.path + " · " + fmtSize(f.size);
    if (fileUrl) URL.revokeObjectURL(fileUrl), fileUrl = "";
    if (f.kind === "image") {
      const ext = path.split(".").pop().toLowerCase();
      fileUrl = URL.createObjectURL(new Blob([f.blob], { type: IMG_TYPE[ext] || "image/" + ext }));
      body.innerHTML = `<div class="fv-img"><img src="${fileUrl}" alt=""></div>`;
      return;
    }
    if (f.kind !== "text") { body.innerHTML = `<p class="fv-note">这个文件不是文本${f.size > 20 << 20 ? "，也太大了" : ""}，没法在这里预览。</p>`; return; }
    const text = await f.blob.text();
    const cut = f.size > f.blob.size ? `<p class="fv-note muted">文件有 ${fmtSize(f.size)}，这里只显示前 1 MB。</p>` : "";
    body.innerHTML = MD_EXT.test(path) ? `<div class="msg assistant fv-md">${mdRender(text)}</div>${cut}` : `<pre class="fv-pre">${esc(text)}</pre>${cut}`;
  }
  // Images a message carries ("[image:~/.collie/images/….png]" or any local
  // Windows/Unix image path) show inline; tap to open the full viewer panel.
  const IMG_TOKEN = /\[image:((?:~[\\/]|\/|[A-Za-z]:[\\/])[^\]\r\n]+\.(?:png|jpe?g|gif|webp|svg|bmp))\]\n?/gi;
  const thumbs = new Map(); // path -> object URL, kept so redraws don't refetch
  const IMG_RUN = /(?:\[image:(?:~[\\/]|\/|[A-Za-z]:[\\/])[^\]\r\n]+\.(?:png|jpe?g|gif|webp|svg|bmp)\]\n?)+/gi;
  const thumbBtn = (p, cls = "") => `<button type="button" class="thumb${cls ? " " + cls : ""}" data-img="${esc(p)}" aria-label="点击查看大图"><img alt=""${thumbs.get(p) ? ` src="${thumbs.get(p)}"` : ""}></button>`;
  const withImages = (html, cls = "") => html.includes("[image:") ? html.replace(IMG_RUN, (run) => `<span class="thumbs${cls ? " " + cls : ""}">${run.replace(IMG_TOKEN, (_, p) => thumbBtn(p, cls))}</span>`) : html;
  async function loadThumb(img) {
    const p = img.parentElement.dataset.img;
    if (thumbs.get(p)) { img.src = thumbs.get(p); return; }
    if (thumbs.has(p)) return; // on its way; it fills every copy when it lands
    thumbs.set(p, "");
    try {
      const f = await findFile(p);
      if (!f || f.kind !== "image") throw 0;
      const u = URL.createObjectURL(new Blob([f.blob], { type: IMG_TYPE[p.split(".").pop()] || "image/" + p.split(".").pop() }));
      thumbs.set(p, u);
      for (const el of document.querySelectorAll(".thumb[data-img] img")) if (el.parentElement.dataset.img === p) el.src = u;
    } catch { thumbs.delete(p); img.parentElement.classList.add("broken"); }
  }
  // Under each Collie message, on hover: copy, quote, and when it was said.
  const ICON_COPY = `<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>`;
  const ICON_QUOTE = `<svg viewBox="0 0 24 24"><path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/></svg>`;
  const msgActs = (e, at) => e.id ? `<div class="msg-acts">
      <button type="button" data-copy="${esc(e.id)}" title="复制">${ICON_COPY}</button>
      <button type="button" class="re-btn" data-re="${esc(e.id)}" title="引用回复">${ICON_QUOTE}</button>
      ${at ? `<span class="t">${esc(sepTime(at))}</span>` : ""}</div>` : "";
  // Under your own message, at its right edge: when you said it, and copy.
  const mineActs = (e, at) => e.id ? `<div class="msg-acts">${at ? `<span class="t">${esc(sepTime(at))}</span>` : ""}
      <button type="button" data-copy="${esc(e.id)}" title="复制">${ICON_COPY}</button></div>` : "";
  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); return true; } catch {}
    // http pages have no clipboard API: the old way still works there
    const ta = Object.assign(document.createElement("textarea"), { value: t });
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.append(ta); ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
  document.addEventListener("click", async (ev) => {
    const cc = ev.target.closest("[data-copy-code]");
    if (cc) {
      const raw = cc.closest(".codeblock")?.querySelector("code")?.textContent || "";
      if (await copyText(raw)) {
        const sp = cc.querySelector("span");
        cc.classList.add("copied");
        if (sp) sp.textContent = "已复制 ✓";
        clearTimeout(cc._t);
        cc._t = setTimeout(() => { cc.classList.remove("copied"); if (sp) sp.textContent = "复制"; }, 1600);
      }
      return;
    }
    const b = ev.target.closest("[data-copy]");
    if (!b) return;
    const e = sup.entries.find((x) => x.id === b.dataset.copy);
    if (e) toast(await copyText(e.text) ? "已复制" : "复制失败", "");
  });
  // A reply's quote of your message: take you to it.
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a.re[data-goto]");
    if (!a) return;
    e.preventDefault();
    const m = document.querySelector(`#v-collie .msg[data-id="${CSS.escape(a.dataset.goto)}"]`);
    if (!m) return toast("这条消息太早了，已经不在这里");
    m.scrollIntoView({ block: "center", behavior: "smooth" });
    m.classList.remove("flash"); void m.offsetWidth; m.classList.add("flash");
  });
  // No hover on a phone: tap a Collie chat message to see when it was said.
  document.addEventListener("click", (e) => {
    if (!matchMedia("(hover: none)").matches) return;
    const m = e.target.closest("#v-collie .msg[data-time], #v-collie .say .msg, #v-collie .mine .msg");
    if (m && e.target.closest("a, button, .thumb")) return;
    for (const x of document.querySelectorAll("#v-collie .msg.show-time")) if (x !== m) x.classList.remove("show-time");
    m?.classList.toggle("show-time");
  });
  new MutationObserver(() => {
    for (const img of document.querySelectorAll(".thumb img:not([src])")) if (!img.dataset.asked) { img.dataset.asked = 1; loadThumb(img); }
  }).observe(document.body, { childList: true, subtree: true });

  document.addEventListener("click", (e) => {
    const t = e.target.closest(".thumb[data-img]");
    if (t) { e.preventDefault(); openImageModal(t.dataset.img); return; }
    const a = e.target.closest("a.fpath");
    if (!a) return;
    e.preventDefault();
    openFile(a.dataset.path);
  });
  // Wide screens: a panel to the right of the conversation, which stays
  // usable; its width is dragged and remembered. Narrow ones: full screen.
  const pane = $("#file-view");
  const setFileW = (w) => document.documentElement.style.setProperty("--file-w", Math.round(w) + "px");
  // The widest the panel may be: the conversation keeps at least 420px.
  const fileMax = () => innerWidth - $(".side").offsetWidth - 420;
  let paneTimer;
  function showFilePane() {
    clearTimeout(paneTimer);
    // Until it has been dragged: a little under half the window.
    setFileW(Math.max(Math.min(store.get("fileW", 0) || innerWidth * 0.45, fileMax()), 360));
    if (pane.hidden) { pane.hidden = false; pane.offsetWidth; }
    $("#app").classList.add("has-file");
  }
  function closeFilePane() {
    $("#app").classList.remove("has-file");
    fileSeq++;
    clearTimeout(paneTimer);
    paneTimer = setTimeout(() => {
      pane.hidden = true;
      if (fileUrl) URL.revokeObjectURL(fileUrl), fileUrl = "";
    }, 360);
  }
  pane.addEventListener("click", (e) => { if (e.target.closest("[data-fv-close]")) closeFilePane(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !pane.hidden && !document.querySelector("dialog[open]")) closeFilePane(); });
  $("#fv-grip").addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const grip = e.currentTarget;
    grip.setPointerCapture(e.pointerId);
    document.body.classList.add("dragging");
    const max = fileMax();
    const move = (ev) => setFileW(Math.max(Math.min(innerWidth - ev.clientX, max), 360));
    const up = () => {
      grip.removeEventListener("pointermove", move);
      document.body.classList.remove("dragging");
      store.set("fileW", parseInt(getComputedStyle(document.documentElement).getPropertyValue("--file-w")) || 520);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up, { once: true });
  });

  // Minimal, safe Markdown: escape first, then add a little structure.
  const mdCache = new Map();
  function md(src) {
    const key = String(src || "");
    let out = mdCache.get(key);
    if (out === undefined) {
      out = mdRender(key);
      if (mdCache.size > 3000) mdCache.delete(mdCache.keys().next().value);
      mdCache.set(key, out);
    }
    return out;
  }
  function mdRender(src) {
    const blocks = [];
    let text = String(src || "").replace(/```([^\n`]*)\n([\s\S]*?)(```|$)/g, (_, lang, code) => {
      const l = (lang || "").trim().split(/\s+/)[0];
      blocks.push(`<div class="codeblock"><div class="code-bar"><span class="code-lang">${esc(l || "code")}</span><button type="button" class="code-copy" data-copy-code>${ICON_COPY}<span>复制</span></button></div><pre><code>${esc(code.replace(/\n$/, ""))}</code></pre></div>`);
      return `\u0000${blocks.length - 1}\u0000`;
    });
    text = esc(text);
    const URL_RE = /(?<![="'>\w\/])https?:\/\/[^\s<>"，。；：、！？）」』】（「『【]+/g;
    const urlLabel = (u) => {
      const raw = u.replace(/&amp;/g, "&").replace(/^https?:\/\//, "").replace(/\/$/, "");
      return esc(raw.length > 42 ? raw.slice(0, 40) + "…" : raw);
    };
    const inline = (s) => {
      const spans = [];
      const hold = (h) => `\u0001${spans.push(h) - 1}\u0001`;
      return s
        .replace(/`([^`\n]+)`/g, (_, c) => hold(`<code>${c}</code>`))
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\[image:((?:~[\\/]|\/|[A-Za-z]:[\\/])[^\]\r\n]+\.(?:png|jpe?g|gif|webp|svg|bmp))\]/gi, (_, p) => {
          const raw = p.replace(/&amp;/g, "&");
          return hold(`<span class="thumbs">${thumbBtn(raw)}</span>`);
        })
        .replace(/!\[([^\]\n]*)\]\((https?:\/\/[^)\s"]+)\)/g, (_, alt, u) => hold(`<span class="thumbs"><button type="button" class="thumb" data-img="${u}" aria-label="点击查看原图"><img src="${u}" alt="${alt}"></button></span>`))
        .replace(/!\[([^\]\n]*)\]\((?:file:\/\/\/?)?((?:\/|~[\\/]|[A-Za-z]:[\\/])[^)\s"#]+\.(?:png|jpe?g|gif|webp|svg|bmp))(?:#[^)\s"]*)?\)/gi, (_, alt, p) => {
          let raw = p.replace(/&amp;/g, "&");
          try { raw = decodeURI(raw); } catch {}
          return hold(`<span class="thumbs">${thumbBtn(raw)}</span>`);
        })
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s"]+)\)/g, (_, l, u) => hold(`<a href="${u}" target="_blank" rel="noopener noreferrer">${l}</a>`))
        // [MergeStatus.tsx](file:///…/MergeStatus.tsx#L67-L84): the name, opening the file.
        .replace(/\[([^\]\n]+)\]\((?:file:\/\/\/?)?((?:\/|~[\\/]|[A-Za-z]:[\\/])[^)\s"#]+)(?:#[^)\s"]*)?\)/g, (_, label, p) => {
          p = p.replace(/:\d+(?:[-:]\d+)?$/, "");
          try { p = decodeURI(p); } catch {}
          return hold(`<a class="fpath" href="#" data-path="${p}" title="${p}">${label}</a>`);
        })
        .replace(FILE_RE, (_, pre, p) => pre + hold(`<a class="fpath" href="#" data-path="${p}" title="打开这个文件">${p}</a>`))
        .replace(URL_RE, (u) => {
          let tail = u.match(/(?:&quot;|&#39;|[.,;:!?'\]]+)+$/)?.[0] || "";
          u = u.slice(0, u.length - tail.length);
          if (u.endsWith(")") && !u.includes("(")) { u = u.slice(0, -1); tail = ")" + tail; }
          return `<a class="url" href="${u}" target="_blank" rel="noopener noreferrer" title="${u}">${urlLabel(u)}</a>${tail}`;
        })
        .replace(/\u0001(\d+)\u0001/g, (_, i) => spans[+i]);
    };
    const out = [];
    let list = null, para = [];
    const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join("<br>"))}</p>`); para = []; } };
    const flushList = () => { if (list) { out.push(`<${list.tag}${list.start > 1 ? ` start="${list.start}"` : ""}>${list.items.map((x) => `<li>${inline(x)}</li>`).join("")}</${list.tag}>`); list = null; } };
    // A GFM table: a | row, a |---| row, then more | rows.
    const cells = (row) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
    const isSep = (row) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(row) && row.includes("-");
    const lines = text.split("\n");
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      let m;
      if (line.includes("|") && li + 1 < lines.length && isSep(lines[li + 1]) && lines[li + 1].includes("|")) {
        flushPara(); flushList();
        const head = cells(line);
        const align = cells(lines[li + 1]).map((c) => c.endsWith(":") ? (c.startsWith(":") ? "center" : "right") : "");
        const td = (tag, c, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ""}>${inline(c)}</${tag}>`;
        let body = "";
        li += 2;
        while (li < lines.length && lines[li].includes("|") && lines[li].trim()) {
          const r = cells(lines[li]);
          body += `<tr>${head.map((_, k) => td("td", r[k] || "", k)).join("")}</tr>`;
          li++;
        }
        li--;
        out.push(`<div class="md-table"><table><thead><tr>${head.map((c, k) => td("th", c, k)).join("")}</tr></thead><tbody>${body}</tbody></table></div>`);
        continue;
      }
      if (/^\u0000\d+\u0000$/.test(line.trim())) { flushPara(); flushList(); out.push(line.trim()); continue; }
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flushPara(); flushList(); out.push("<hr>"); continue; }
      if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { flushPara(); flushList(); const h = Math.min(m[1].length + 1, 4); out.push(`<h${h}>${inline(m[2])}</h${h}>`); continue; }
      if ((m = line.match(/^\s*[-*•]\s+(.*)$/)) || (m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
        const tag = /^\s*\d/.test(line) ? "ol" : "ul";
        flushPara();
        // "2." after a few bullets carries on the numbering, as the agent wrote it.
        if (!list || list.tag !== tag) { flushList(); list = { tag, items: [], start: parseInt(line) || 1 }; }
        list.items.push(m[1]);
        continue;
      }
      if ((m = line.match(/^&gt;\s?(.*)$/))) { flushPara(); flushList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
      if (!line.trim()) { flushPara(); flushList(); continue; }
      flushList();
      para.push(line);
    }
    flushPara(); flushList();
    return out.join("").replace(/\u0000(\d+)\u0000/g, (_, n) => blocks[+n]);
  }

  // ───────────────────────────── input
  const SEQ = {
    "\r": "enter", "\x7f": "backspace", "\b": "backspace", "\t": "tab", "\x1b": "esc",
    "\x1b[A": "up", "\x1b[B": "down", "\x1b[C": "right", "\x1b[D": "left", "\x1b[Z": "shift+tab",
    "\x1b[H": "home", "\x1b[F": "end", "\x1b[3~": "delete", "\x1b[5~": "pageup", "\x1b[6~": "pagedown",
    "\x1bOA": "up", "\x1bOB": "down", "\x1bOC": "right", "\x1bOD": "left",
  };
  function typeIntoPane(data) {
    if (!current) return;
    if (SEQ[data]) return sendKeys([SEQ[data]]);
    if (data.length === 1 && data.charCodeAt(0) < 27) return sendKeys(["ctrl+" + String.fromCharCode(data.charCodeAt(0) + 96)]);
    sendText(data);
  }
  // Keystrokes go out one request at a time, in order; text typed while one
  // is on its way rides along in the next.
  let sendChain = Promise.resolve(), sendTail = null;
  function sendToPane(kind, body) {
    if (!current) return;
    const url = paneURL(current, kind);
    if (kind === "text" && sendTail && sendTail.url === url && !sendTail.started) {
      sendTail.body.text += body.text;
      return sendTail.done;
    }
    const op = { url, body, started: false };
    op.done = sendChain = sendChain.then(() => {
      op.started = true;
      if (sendTail === op) sendTail = null;
      return api(url, { body: op.body });
    }).catch((e) => toast(e.message));
    sendTail = kind === "text" ? op : null;
    return op.done;
  }
  const sendKeys = (keys) => sendToPane("keys", { keys });
  const sendText = (text) => sendToPane("text", { text });

  function grow(el) { el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, innerHeight * 0.4) + "px"; }
  // Files go to the machine where the agent runs, then their paths ride
  // along in the message (agents read images and files by path).
  const fmtSize = (n) => n < 1024 ? n + " B" : n < 1 << 20 ? Math.round(n / 1024) + " KB" : (n / 1048576).toFixed(1) + " MB";
  function bindFiles(form, machine) {
    const box = $(".files", form), picker = $('input[type="file"]', form);
    form._files = [];
    const draw = () => {
      box.hidden = !form._files.length;
      box.innerHTML = form._files.map((f, i) => `<span class="file ${f.err ? "err" : f.path ? "" : "busy"}" title="${esc(f.err || f.path || "上传中…")}">
        ${f.thumb ? `<img src="${f.thumb}" alt="">` : `<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>`}
        <span class="fn">${esc(f.name)}</span><span class="fs">${f.err ? "失败" : f.path ? fmtSize(f.size) : "上传中"}</span>
        <button type="button" data-rm="${i}" title="移除">×</button></span>`).join("");
    };
    const add = (list) => {
      for (const file of list) {
        const f = { name: file.name || "粘贴的图片.png", size: file.size, thumb: file.type.startsWith("image/") ? URL.createObjectURL(file) : "" };
        const m = machine();
        const up = routeReq(`/api/uploads?name=${encodeURIComponent(f.name)}${m ? "&machine=" + encodeURIComponent(m) : ""}`);
        f.done = fetch(up.url, {
          method: "POST", body: file, credentials: up.hub ? "omit" : "same-origin",
          headers: up.hub ? { Authorization: "Bearer " + up.hub.token } : {},
        }).then(async (res) => {
          const d = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(d.error || res.statusText);
          f.path = d.path;
        }).catch((err) => { f.err = err.message; toast(`${f.name}：${err.message}`, "attn"); }).finally(draw);
        form._files.push(f);
      }
      draw();
    };
    $(".attach", form).addEventListener("click", () => picker.click());
    picker.addEventListener("change", () => { add([...picker.files]); picker.value = ""; });
    box.addEventListener("click", (e) => {
      const i = e.target.closest("[data-rm]")?.dataset.rm;
      if (i == null) return;
      const [f] = form._files.splice(+i, 1);
      if (f?.thumb) URL.revokeObjectURL(f.thumb);
      draw();
    });
    const ta = $("textarea", form);
    ta.addEventListener("paste", (e) => {
      const files = [...(e.clipboardData?.files || [])];
      if (files.length) { e.preventDefault(); add(files); }
    });
    form.addEventListener("dragover", (e) => { if (e.dataTransfer?.types?.includes("Files")) { e.preventDefault(); form.classList.add("drop"); } });
    form.addEventListener("dragleave", () => form.classList.remove("drop"));
    form.addEventListener("drop", (e) => {
      form.classList.remove("drop");
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault(); add([...e.dataTransfer.files]);
    });
    form._clearFiles = () => { form._files.forEach((f) => f.thumb && URL.revokeObjectURL(f.thumb)); form._files = []; draw(); };
  }
  async function withFiles(form, text) {
    const files = form._files || [];
    if (!files.length) return text;
    await Promise.all(files.map((f) => f.done));
    if (files.some((f) => f.err)) throw new Error("有文件没传上去，移除后再发");
    return (text.trim() ? text.trim() + "\n\n" : "") + "附件：\n" + files.map((f) => f.path).join("\n");
  }
  // Images a Collie or agent message points at (including Markdown file links)
  // show as compact thumbnails under the message, without duplicating inline [image:...].
  const IMG_PATH = /(?:^|[\s(（`"'：:])(?:file:\/\/\/?)?((?:~[\\/]|\/|[A-Za-z]:[\\/])[^\s`"'()（）<>\]]*\.(?:png|jpe?g|gif|webp|svg|bmp))(?=$|[\s)）`"'，。,;；#\]])/gim;
  function imagesIn(t) {
    const cleaned = String(t || "").replace(IMG_RUN, "").replace(/!\[[^\]\n]*\]\([^)\n]+\)/g, "");
    const ps = [...new Set([...cleaned.matchAll(IMG_PATH)].map((m) => {
      let p = m[1];
      try { p = decodeURI(p); } catch {}
      return p;
    }))].slice(0, 6);
    return ps.length ? `<span class="thumbs">${ps.map((p) => thumbBtn(p)).join("")}</span>` : "";
  }
  // Markdown as one plain line, for quotes: no marks, list dashes or breaks.
  const plainLine = (t) => (t || "").split("\n").map((l) => l.replace(/^\s*(?:[-*+]|\d+\.|#+|>)\s+/, "").trim()).filter(Boolean).join(" ")
    .replace(/\*\*|__|`/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // A user message's attachments: images as thumbnails, other files by name
  // (not server paths).
  function userText(t) {
    const i = t.lastIndexOf("附件：\n");
    if (i < 0) return withImages(esc(t));
    const paths = t.slice(i + 4).split("\n").map((p) => p.trim()).filter(Boolean);
    const imgs = paths.filter((p) => IMG_EXT.test(p)), rest = paths.filter((p) => !IMG_EXT.test(p));
    const name = (p) => p.split(/[\\/]/).pop().replace(/^[0-9a-f]{6}-/, "");
    return withImages(esc(t.slice(0, i).trimEnd()))
      + (imgs.length ? `<span class="thumbs">${imgs.map((p) => thumbBtn(p)).join("")}</span>` : "")
      + (rest.length ? `<span class="att">${rest.map((p) => `<span>📎 ${esc(name(p))}</span>`).join("")}</span>` : "");
  }

  function bindComposer(form, input, send, machine) {
    if (machine) bindFiles(form, machine);
    input.addEventListener("input", () => grow(input));
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.keyCode === 229) return;
      const mod = e.metaKey || e.ctrlKey;
      // "mod": Enter makes a new line and ⌘/Ctrl+Enter sends.
      if (prefs.sendKey() === "mod" ? mod : !mod) { e.preventDefault(); form.requestSubmit(); }
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = $(".send", form);
      btn.disabled = true;
      const rawDraft = input.value;
      try {
        const text = await withFiles(form, rawDraft);
        input.value = ""; grow(input);
        await send(text);
        form._clearFiles?.();
      }
      catch (err) {
        if (!input.value) { input.value = rawDraft; grow(input); }
        toast(err.message, "attn");
      }
      finally { btn.disabled = false; }
    });
  }

  bindComposer($("#composer"), $("#input"), async (text) => {
    if (!current) return;
    let v = find(current);
    if (!v) {
      // The page may be behind (e.g. the hub restarted); look again before giving up.
      try { setLocalState(await api("/api/state")); renderSide(); } catch {}
      v = find(current) || { pane_id: current, is_agent: false };
    }
    if (!text.trim()) { sendKeys(["enter"]); return; }
    const th = $("#thread");
    if (v.is_agent) addPendingThreadMsg(th, text);
    try {
      if (v.is_agent) await api(`/api/agents/${encodeURIComponent(current)}/prompt`, { body: { text } });
      else await api(paneURL(current, "text"), { body: { text, enter: true } });
    } catch (err) {
      if (v.is_agent) removePendingThreadMsg(th, text);
      throw new Error(err.message.includes("blocked") ? "agent 正在等你确认，先处理上面的确认卡片" : err.message);
    }
  }, () => (current || "").includes("@") ? current.slice(current.lastIndexOf("@") + 1) : "");

  // ───────────────────────────── rename dialog & session lifecycle actions
  const renameDlg = $("#rename-dlg");
  let renameSaveFn = null;
  function openRenameDialog({ title, label, hint, value, onSave }) {
    $("#rename-title").textContent = title || "重命名";
    $("#rename-label").textContent = label || "新名称";
    $("#rename-hint").textContent = hint || "";
    const inp = $("#rename-input");
    inp.value = value || "";
    renameSaveFn = onSave;
    renameDlg.showModal();
    setTimeout(() => { inp.focus(); inp.select(); }, 20);
  }
  $("#rename-form")?.addEventListener("submit", async (e) => {
    if (e.submitter?.value !== "ok") return;
    e.preventDefault();
    const val = $("#rename-input").value.trim();
    if (!val || !renameSaveFn) return;
    try {
      await renameSaveFn(val);
      renameDlg.close();
    } catch (err) { toast(err.message, "attn"); }
  });

  function resolveSessionTarget(token) {
    if (!token) {
      if (view === "pane" && current) token = "p:" + current;
      else if (view === "ext" && extCur) token = extCur.startsWith("h:") ? extCur : "x:" + extCur;
    }
    if (!token) return null;
    if (token.startsWith("p:")) {
      const pid = token.slice(2), v = find(pid);
      if (!v) return null;
      return {
        token, type: "pane", pane_id: v.pane_id, workspace_id: v.workspace_id,
        kind: v.kind, machine: v.machine || "", session: v.session || "", cwd: v.cwd || "",
        title: title(v), name: v.name || "", archived: false, activeNow: view === "pane" && current === v.pane_id,
      };
    }
    if (token.startsWith("x:")) {
      const eid = token.slice(2), e = ext.find((x) => x.id === eid);
      if (!e) return null;
      const meta = getSessMeta(e.kind, e.machine, e.session, "x:" + e.id);
      return {
        token, type: "ext", ext_id: e.id,
        kind: e.kind, machine: e.machine || "", session: e.session || "", cwd: e.cwd || "",
        title: extName(e), name: "", archived: !!meta?.archived, live: !!e.live, activeNow: view === "ext" && extCur === e.id,
      };
    }
    if (token.startsWith("h:")) {
      const hid = token.slice(2), h = hist.find((x) => x.id === hid);
      if (!h) return null;
      const meta = getSessMeta(h.kind, h.machine, h.session, "h:" + h.id);
      return {
        token, type: "hist", hist_id: h.id,
        kind: h.kind, machine: h.machine || "", session: h.session || "", cwd: h.cwd || "",
        title: histName(h), name: h.name || "", archived: !!meta?.archived, activeNow: view === "ext" && extCur === "h:" + h.id,
      };
    }
    return null;
  }

  async function refreshSessionMeta() {
    try { setLocalState(await api("/api/state")); } catch {}
    renderSide();
    if (view === "pane") renderHead();
    if (view === "ext") renderExtHead();
  }

  function promptRenameSession(target) {
    if (!target) return;
    openRenameDialog({
      title: "重命名会话",
      label: "会话标题",
      hint: "自定义标题在会话运行、归档与后续继续对话时都会保留。",
      value: target.title || "",
      onSave: async (newTitle) => {
        await api("/api/sessions/rename", { body: {
          pane_id: target.pane_id || "", workspace_id: target.workspace_id || "",
          ext_id: target.ext_id || "", hist_id: target.hist_id || "",
          kind: target.kind || "", machine: target.machine || "", session: target.session || "",
          title: newTitle,
        } });
        await refreshSessionMeta();
        toast("已重命名");
      },
    });
  }

  async function toggleArchiveSession(target) {
    if (!target) return;
    const nextArch = !target.archived;
    if (target.type === "pane" && nextArch && !confirm(`归档「${target.title}」？\n\n如果它正在运行，会先安全结束当前进程并移入侧边栏底部的「已归档」，随时可点击恢复对话。`)) return;
    await api("/api/sessions/archive", { body: {
      pane_id: target.pane_id || "", workspace_id: target.workspace_id || "",
      ext_id: target.ext_id || "", hist_id: target.hist_id || "",
      kind: target.kind || "", machine: target.machine || "", session: target.session || "",
      cwd: target.cwd || "", title: target.title || "", name: target.name || "",
      archived: nextArch,
    } });
    if (target.type === "pane" && nextArch) {
      await loadHistory();
      if (target.activeNow) location.hash = "#/collie";
    }
    await refreshSessionMeta();
    toast(nextArch ? "已归档到侧边栏底部" : "已移出归档");
  }

  async function removeSession(target) {
    if (!target) return;
    if (!confirm(`删除会话「${target.title}」？${target.type === "pane" ? "\n\n当前正在运行的会话将被关闭并从列表中移除。" : "\n\n该会话将从列表中移除。"}`)) return;
    await api("/api/sessions/delete", { body: {
      pane_id: target.pane_id || "", workspace_id: target.workspace_id || "",
      ext_id: target.ext_id || "", hist_id: target.hist_id || "",
      kind: target.kind || "", machine: target.machine || "", session: target.session || "",
    } });
    if (target.ext_id) ext = ext.filter((x) => x.id !== target.ext_id);
    if (target.hist_id) hist = hist.filter((x) => x.id !== target.hist_id);
    await refreshSessionMeta();
    if (target.activeNow) location.hash = "#/collie";
    toast("已删除会话");
  }

  // Session-to-project assignment dialog
  const sessProjDlg = $("#sess-proj-dlg"), sessProjSel = $("#sess-proj-sel");
  let sessProjTarget = null;
  function openAssignSessionProject(target) {
    if (!target || !sessProjDlg) return;
    const mProjs = (state.projects || []).filter((p) => (p.machine || "") === (target.machine || ""));
    if (!mProjs.length) {
      toast(`${machineName(target.machine)} 还没有创建项目，可先点击左侧「新建项目」`);
      return;
    }
    sessProjTarget = target;
    $("#sess-proj-label").textContent = `将会话「${target.title}」归属到：`;
    const meta = getSessMeta(target.kind, target.machine, target.session, target.token);
    const curProj = projectOfSession(target.kind, target.machine, target.session, target.cwd, target.token);
    const curVal = meta?.project_id || curProj?.id || "-";
    sessProjSel.innerHTML = `<option value="-" data-sub="从项目分组中移出，显示在下方独立会话列表中" ${curVal === "-" ? "selected" : ""}>不归属项目（独立会话）</option>`
      + `<option value="" data-sub="根据工作目录自动归入匹配的项目" ${curVal === "" ? "selected" : ""}>自动按目录匹配</option>`
      + mProjs.map((p) => `<option value="${esc(p.id)}" data-sub="${esc(tilde(p.cwd))}" ${curVal === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("");
    enhance(sessProjSel);
    syncPick(sessProjSel);
    sessProjDlg.showModal();
  }
  $("#sess-proj-form")?.addEventListener("submit", async (e) => {
    if (e.submitter?.value !== "ok" || !sessProjTarget) return;
    e.preventDefault();
    const target = sessProjTarget;
    const pid = sessProjSel.value;
    try {
      await api("/api/sessions/project", { body: {
        key: target.token || "",
        pane_id: target.pane_id || "", ext_id: target.ext_id || "", hist_id: target.hist_id || "",
        kind: target.kind || "", machine: target.machine || "", session: target.session || "",
        project_id: pid,
      } });
      sessProjDlg.close();
      await refreshSessionMeta();
      toast(pid === "-" ? "已移出项目" : pid ? "已归属到项目" : "已恢复自动匹配");
    } catch (err) { toast(err.message, "attn"); }
  });

  async function removeProject(proj) {
    if (!proj) return;
    if (!confirm(`移除项目「${proj.name}」？\n\n仅从侧栏顶部移除该项目分组，项目目录下的文件与已有对话记录都会保留。`)) return;
    await api(`/api/projects/${encodeURIComponent(proj.id)}/delete`, { method: "POST", body: {} });
    await refreshSessionMeta();
    toast("已移除项目");
  }

  $("#btn-sync-projects")?.addEventListener("click", async (ev) => {
    const btn = ev.currentTarget;
    if (btn.classList.contains("spinning")) return;
    btn.classList.add("spinning");
    try {
      const r = await api("/api/projects/sync", { method: "POST", body: {} });
      await refreshSessionMeta();
      toast(r.added > 0 ? `已从宿主机同步 ${r.added} 个新项目` : "宿主机项目已是最新");
    } catch (err) {
      toast(err.message, "attn");
    } finally {
      btn.classList.remove("spinning");
    }
  });

  // Floating sidebar session & project context menus
  const sessPopMenu = $("#sess-pop-menu"), projPopMenu = $("#proj-pop-menu");
  let sessPopToken = null, sessPopBtn = null;
  let projPopId = null, projPopBtn = null;
  function closeSessPop() {
    if (sessPopMenu) sessPopMenu.hidden = true;
    sessPopBtn?.classList.remove("open");
    sessPopBtn = null; sessPopToken = null;
  }
  function closeProjPop() {
    if (projPopMenu) projPopMenu.hidden = true;
    projPopBtn?.classList.remove("open");
    projPopBtn = null; projPopId = null;
  }
  function closeSideMenus() { closeSessPop(); closeProjPop(); }

  document.addEventListener("click", (e) => {
    const openLaunchBtn = e.target.closest("[data-open-launch]");
    if (openLaunchBtn) {
      e.preventDefault();
      openLauncher({ mode: openLaunchBtn.dataset.openLaunch === "project" ? "project" : "session" });
      return;
    }
    const projNewBtn = e.target.closest("[data-proj-new]");
    if (projNewBtn) {
      e.preventDefault(); e.stopPropagation();
      const proj = (state.projects || []).find((p) => p.id === projNewBtn.dataset.projNew);
      if (proj) openLauncher({ mode: "project-session", project: proj });
      return;
    }
    const pb = e.target.closest("[data-pmenu]");
    if (pb) {
      e.preventDefault(); e.stopPropagation();
      $$(".menu").forEach((m) => { if (m !== projPopMenu) m.hidden = true; });
      closeSessPop();
      if (projPopBtn === pb && !projPopMenu.hidden) { closeProjPop(); return; }
      closeProjPop();
      projPopId = pb.dataset.pmenu;
      projPopBtn = pb; pb.classList.add("open");
      projPopMenu.hidden = false;
      const r = pb.getBoundingClientRect();
      projPopMenu.style.left = Math.min(innerWidth - 172, Math.max(8, r.right - 144)) + "px";
      projPopMenu.style.top = (r.bottom + 130 > innerHeight ? Math.max(8, r.top - 120) : r.bottom + 4) + "px";
      return;
    }
    const pact = e.target.closest("#proj-pop-menu [data-pact]")?.dataset.pact;
    if (pact) {
      const proj = (state.projects || []).find((p) => p.id === projPopId);
      closeProjPop();
      if (proj) {
        if (pact === "new-sess") openLauncher({ mode: "project-session", project: proj });
        if (pact === "edit") openLauncher({ mode: "project", editProject: proj });
        if (pact === "delete") removeProject(proj).catch((err) => toast(err.message, "attn"));
      }
      return;
    }
    const projToggle = e.target.closest("[data-proj-toggle]");
    if (projToggle && !e.target.closest("button")) {
      const pid = projToggle.dataset.projToggle;
      const node = projToggle.closest(".proj-node");
      const nextOpen = !node?.classList.contains("open");
      setProjOpen(pid, nextOpen);
      renderSessions();
      return;
    }
    const mb = e.target.closest("[data-smenu]");
    if (mb) {
      e.preventDefault(); e.stopPropagation();
      $$(".menu").forEach((m) => { if (m !== sessPopMenu) m.hidden = true; });
      closeProjPop();
      if (sessPopBtn === mb && !sessPopMenu.hidden) { closeSessPop(); return; }
      closeSessPop();
      const target = resolveSessionTarget(mb.dataset.smenu);
      if (!target) return;
      sessPopToken = mb.dataset.smenu;
      sessPopBtn = mb; mb.classList.add("open");
      $("#spm-archive").textContent = target.archived ? "移出归档" : "归档会话";
      const spmProj = $("#spm-project");
      if (spmProj) {
        const curP = projectOfSession(target.kind, target.machine, target.session, target.cwd, target.token);
        spmProj.textContent = curP ? "更改 / 移出项目…" : "归属到项目…";
      }
      sessPopMenu.hidden = false;
      const r = mb.getBoundingClientRect();
      const left = Math.min(innerWidth - 176, Math.max(8, r.right - 148));
      const top = r.bottom + 165 > innerHeight ? Math.max(8, r.top - 152) : r.bottom + 4;
      sessPopMenu.style.left = left + "px";
      sessPopMenu.style.top = top + "px";
      return;
    }
    const sact = e.target.closest("#sess-pop-menu [data-sact]")?.dataset.sact;
    if (sact) {
      const target = resolveSessionTarget(sessPopToken);
      closeSessPop();
      if (sact === "rename") promptRenameSession(target);
      if (sact === "project") openAssignSessionProject(target);
      if (sact === "archive") toggleArchiveSession(target).catch((err) => toast(err.message, "attn"));
      if (sact === "delete") removeSession(target).catch((err) => toast(err.message, "attn"));
      return;
    }
    closeSideMenus();
    const opener = e.target.closest("[data-menu]");
    $$(".menu:not(#sess-pop-menu):not(#proj-pop-menu)").forEach((m) => { if (!opener || m.id !== opener.dataset.menu) m.hidden = true; });
    if (opener) { const m = $("#" + opener.dataset.menu); m.hidden = !m.hidden; }
  });
  $(".side-scroll")?.addEventListener("scroll", closeSideMenus, { passive: true });

  document.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    try {
      if (act === "interrupt") { sendKeys(["ctrl+c"]); toast("已发送中断信号"); }
      if (act === "sess-rename") promptRenameSession(resolveSessionTarget());
      if (act === "sess-project") openAssignSessionProject(resolveSessionTarget());
      if (act === "sess-archive") await toggleArchiveSession(resolveSessionTarget());
      if (act === "sess-delete") await removeSession(resolveSessionTarget());
      if (act === "router-cfg") {
        if (view !== "collie") location.hash = "#/collie";
        toggleRouterPop(true);
      }
      if (act === "router-restart") {
        if (!confirm("重启 Collie？它会读自己的记忆恢复上下文，排队的消息不会丢。")) return;
        await api("/api/super/router/restart", { method: "POST", body: {} });
        toast("Collie 正在重启");
      }
      if (act === "pause") {
        const cur = (await api("/api/super/settings")).settings;
        await api("/api/super/settings", { body: { settings: { ...cur, paused: !cur.paused } } });
        toast(cur.paused ? "已恢复投递" : "已暂停投递");
      }
      if (act === "trace") location.hash = "#/trace";
      if (act === "settings") { settingsTab = "collie"; store.set("settingsTab", "collie"); location.hash = "#/settings"; if (view === "settings") openPanel("settings"); }
    } catch (err) { toast(err.message, "attn"); }
  });

  // ───────────────────────────── launcher (Project / Project-Session / Standalone Session + File Tree)
  const sheet = $("#launch");
  const cwdInput = $("#l-cwd");
  const nameInput = $("#l-name");
  const projNameInput = $("#l-proj-name");
  let nameTouched = false, projNameTouched = false;
  let launchMode = "session"; // "session" | "project" | "project-session"
  let activeLaunchProj = null;
  let editingProj = null;
  let projSubdirOpen = false;

  function suggestProjectNameFromCwd(p) {
    if (projNameTouched && projNameInput.value.trim()) return;
    const s = cleanPath(p || "").replace(/[\\/]+$/, "");
    if (!s || s === "~" || s === "/") { projNameInput.value = "主目录"; return; }
    if (/^[A-Za-z]:$/.test(s)) { projNameInput.value = s.toUpperCase(); return; }
    projNameInput.value = s.split(/[\\/]/).pop() || s;
  }

  function suggestName() {
    if (!nameTouched) nameInput.value = "";
    fillLaunchModels();
  }
  let launchSeq = 0;
  async function fillLaunchModels(presetModel, presetEffort) {
    const seq = ++launchSeq, kind = $("input[name=kind]:checked")?.value;
    const mSel = $("#l-model");
    const keep = { model: mSel.value, effort: $("#l-effort").value, key: mSel._key };
    const info = await modelsFor(kind, pickMachine);
    if (seq !== launchSeq) return;
    const same = presetModel === undefined && keep.key === kind + "@" + pickMachine;
    const mem = getSavedModel(kind, pickMachine);
    mSel._key = kind + "@" + pickMachine;
    const list = [...(info.models || [])];
    const wantModel = presetModel !== undefined ? presetModel : same ? keep.model : (mem?.model || "");
    const wantEffort = presetEffort !== undefined ? presetEffort : same ? keep.effort : (mem?.effort || "");
    if (wantModel && !list.some((m) => m.id === wantModel)) list.unshift({ id: wantModel });
    const def = info.default ? info.default.split("/").pop() : "";
    mSel.innerHTML = `<option value="" data-short="默认模型" data-sub="${esc(info.default ? "现在是 " + info.default : "agent 自己的设置")}">默认${def ? "（" + esc(def) + "）" : ""}</option>` +
      list.map((m) => `<option value="${esc(m.id)}" data-sub="${esc(m.label && m.label !== m.id ? m.id : "")}">${esc(m.label || m.id)}</option>`).join("");
    mSel.value = wantModel && list.some((m) => m.id === wantModel) ? wantModel : "";
    fillLaunchEfforts(info, wantEffort);
    syncPick(mSel);
  }
  function fillLaunchEfforts(info, want) {
    const eSel = $("#l-effort");
    const cur = (info.models || []).find((m) => m.id === $("#l-model").value);
    const effs = cur?.efforts?.length ? cur.efforts : (info.efforts || []);
    const defE = info.default_effort || "";
    eSel.innerHTML = `<option value="" data-short="思考 · ${esc(EFFORT_LABEL[defE] || defE || "默认")}">默认（${esc(EFFORT_LABEL[defE] || defE || "agent 自己定")}）</option>` +
      effs.map((e) => `<option value="${esc(e)}" data-short="思考 · ${esc(EFFORT_LABEL[e] || e)}">${esc(EFFORT_LABEL[e] || e)}</option>`).join("");
    eSel.value = effs.includes(want) ? want : "";
    eSel.hidden = effs.length === 0;
    syncPick(eSel);
  }
  $("#l-model").addEventListener("change", async () => {
    const kind = $("input[name=kind]:checked").value;
    await fillLaunchEfforts(await modelsFor(kind, pickMachine), $("#l-effort").value);
    saveLastModel(kind, pickMachine, $("#l-model").value, $("#l-effort").value);
  });
  $("#l-effort").addEventListener("change", () => {
    const kind = $("input[name=kind]:checked").value;
    saveLastModel(kind, pickMachine, $("#l-model").value, $("#l-effort").value);
  });

  let pickMachine = "";
  const recentKey = () => "recentDirs" + (pickMachine ? ":" + pickMachine : "");
  function renderMachinePick() {
    const ms = runnableMachines(pickMachine);
    $("#l-machine-field").hidden = launchMode === "project-session" || ms.length < 2;
    if (launchMode !== "project-session" && !ms.some((m) => m.id === pickMachine)) pickMachine = ms[0]?.id || "";
    $("#l-machines").innerHTML = ms.map((m) => `<button type="button" class="${m.id === pickMachine ? "on" : ""}" data-m="${esc(m.id)}">
      ${osGlyph(m.os)}${esc(m.name)}${m.local ? "<small>hub</small>" : ""}</button>`).join("");
    markKinds();
  }
  function markKinds() {
    const have = (state.machines || []).find((m) => m.id === pickMachine)?.agents;
    for (const r of $$("input[name=kind]")) {
      const k = r.value === "antigravity" ? "agy" : r.value;
      const card = r.closest(".kind-card"), small = card.querySelector("small");
      small.dataset.cmd ||= small.textContent;
      const missing = Array.isArray(have) && k in AGENT_LABEL && !have.includes(k);
      r.disabled = missing;
      card.classList.toggle("missing", missing);
      card.title = missing ? "这台电脑上没装 " + AGENT_LABEL[k] : "";
      small.textContent = missing ? "未安装" : small.dataset.cmd;
    }
    if ($("input[name=kind]:checked")?.disabled) {
      const first = $$("input[name=kind]").find((r) => !r.disabled);
      if (first) { first.checked = true; first.dispatchEvent(new Event("change")); }
    }
  }

  // ── Multi-level Expandable Directory Tree (DirTree) ──
  const treeCache = new Map();     // "machine::normKey" -> { path, display, parent, home, sep, drives, dirs }
  const treeExpanded = new Set();  // set of normKeys currently expanded
  const treeLoading = new Set();
  let treeMeta = { home: "", sep: "/", drives: [] };
  let treeRoot = "~";              // active top root path ("~", "/", or "C:\\", "D:\\")
  let treeReqSeq = 0;

  function treeNormKey(p) {
    let s = cleanPath(p || "").trim();
    if (!s || s === "~") return "~";
    const sep = treeMeta.sep || (s.includes("\\") || /^[A-Za-z]:/.test(s) ? "\\" : "/");
    if (treeMeta.home) {
      const hm = cleanPath(treeMeta.home).replace(/\\/g, "/").replace(/\/+$/, "");
      const sn = s.replace(/\\/g, "/");
      if (sn.toLowerCase() === hm.toLowerCase()) return "~";
      if (sn.toLowerCase().startsWith(hm.toLowerCase() + "/")) {
        s = "~/" + sn.slice(hm.length + 1);
      }
    }
    s = s.replace(/\\/g, "/");
    if (/^[A-Za-z]:$/.test(s)) s += "/";
    if (s.length > 1 && !/^[A-Za-z]:\/$/.test(s)) s = s.replace(/\/+$/, "");
    void sep;
    return treeMeta.drives?.length || /^[A-Za-z]:/.test(s) ? s.toLowerCase() : s;
  }

  function joinChildPath(parentPath, childName) {
    if (/^[A-Za-z]:[\\/]?$/.test(childName)) {
      return childName.replace(/\//g, "\\").replace(/\\?$/, "\\");
    }
    const isWin = Boolean(treeMeta.drives?.length) || parentPath.includes("\\") || /^[A-Za-z]:/.test(parentPath);
    const sep = isWin && !parentPath.startsWith("~") ? "\\" : "/";
    const baseP = parentPath.replace(/[\\/]+$/, "");
    if (!baseP || baseP === "/") return "/" + childName;
    if (/^[A-Za-z]:$/.test(baseP)) return baseP + "\\" + childName;
    return baseP + sep + childName;
  }

  async function fetchDirNode(p, force = false) {
    const raw = (p || "~").trim() || "~";
    const prelimKey = pickMachine + "::" + treeNormKey(raw);
    if (!force && treeCache.has(prelimKey)) return treeCache.get(prelimKey);
    const r = await api("/api/dirs?path=" + encodeURIComponent(raw) + (pickMachine ? "&machine=" + encodeURIComponent(pickMachine) : ""));
    if (r.home) treeMeta.home = r.home;
    if (r.sep) treeMeta.sep = r.sep;
    if (Array.isArray(r.drives)) treeMeta.drives = r.drives;
    const canonical = r.display && r.display.startsWith("~") ? r.display.replace(/\\/g, "/") : r.path;
    const nk = treeNormKey(canonical);
    const entry = { ...r, canonical, nk };
    treeCache.set(pickMachine + "::" + nk, entry);
    treeCache.set(prelimKey, entry);
    return entry;
  }

  function inferRootAndChain(targetPath) {
    const s = cleanPath(targetPath || "~").trim() || "~";
    const norm = s.replace(/\\/g, "/");
    if (treeMeta.home) {
      const hm = cleanPath(treeMeta.home).replace(/\\/g, "/").replace(/\/+$/, "");
      if (norm === "~" || norm.startsWith("~/") || norm.toLowerCase() === hm.toLowerCase() || norm.toLowerCase().startsWith(hm.toLowerCase() + "/")) {
        const rel = (norm === "~" || norm.toLowerCase() === hm.toLowerCase())
          ? ""
          : norm.startsWith("~/") ? norm.slice(2) : norm.slice(hm.length + 1);
        const parts = rel.split("/").filter(Boolean);
        const chain = ["~"];
        let acc = "~";
        for (const pt of parts) { acc += "/" + pt; chain.push(acc); }
        return { root: "~", chain };
      }
    } else if (norm === "~" || norm.startsWith("~/")) {
      const parts = norm.slice(2).split("/").filter(Boolean);
      const chain = ["~"];
      let acc = "~";
      for (const pt of parts) { acc += "/" + pt; chain.push(acc); }
      return { root: "~", chain };
    }
    if (/^[A-Za-z]:/.test(norm)) {
      const drv = norm.slice(0, 2).toUpperCase() + "\\";
      const rest = norm.slice(2).replace(/^\/+/, "");
      const parts = rest ? rest.split("/").filter(Boolean) : [];
      const chain = [drv];
      let acc = drv.slice(0, 2);
      for (const pt of parts) { acc += "\\" + pt; chain.push(acc); }
      return { root: drv, chain };
    }
    const parts = norm.replace(/^\/+/, "").split("/").filter(Boolean);
    const chain = ["/"];
    let acc = "";
    for (const pt of parts) { acc += "/" + pt; chain.push(acc); }
    return { root: "/", chain };
  }

  function renderDirToolbar() {
    const rootsEl = $("#dir-roots");
    const crumbsEl = $("#dir-crumbs");
    const curKey = treeNormKey(cwdInput.value);
    const roots = [{ label: "主目录 ~", path: "~" }];
    if (treeMeta.drives?.length) {
      for (const d of treeMeta.drives) roots.push({ label: d.replace(/\\$/, ""), path: d });
    } else {
      roots.push({ label: "根目录 /", path: "/" });
    }
    if (rootsEl) {
      rootsEl.innerHTML = roots.map((rt) => {
        const on = treeNormKey(treeRoot) === treeNormKey(rt.path);
        return `<button type="button" class="dir-root-btn ${on ? "on" : ""}" data-root="${esc(rt.path)}">${esc(rt.label)}</button>`;
      }).join("");
    }
    const { chain } = inferRootAndChain(cwdInput.value);
    if (crumbsEl) {
      crumbsEl.innerHTML = chain.map((cp, idx) => {
        const label = idx === 0 ? (cp === "~" ? "~" : cp.replace(/\\$/, "")) : cp.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
        const isCur = idx === chain.length - 1;
        return `${idx ? '<span class="dt-sep">›</span>' : ""}<button type="button" class="dt-crumb ${isCur ? "cur" : ""}" data-crumb="${esc(cp)}">${esc(label)}</button>`;
      }).join("");
      crumbsEl.scrollLeft = crumbsEl.scrollWidth;
    }
    const upBtn = $("#dir-up");
    if (upBtn) {
      const atTop = curKey === "/" || (curKey === "~" && !treeMeta.home);
      upBtn.disabled = atTop;
    }
  }

  function renderDirTreeDOM() {
    renderDirToolbar();
    const box = $("#dir-tree");
    if (!box) return;
    const selKey = treeNormKey(cwdInput.value);

    const renderBranch = (nodePath, label, isRoot = false, depth = 0) => {
      if (depth > 18) return "";
      const nk = treeNormKey(nodePath);
      const cached = treeCache.get(pickMachine + "::" + nk);
      const expanded = treeExpanded.has(nk);
      const selected = nk === selKey;
      const loading = treeLoading.has(nk);
      const knownEmpty = Boolean(cached && Array.isArray(cached.dirs) && cached.dirs.length === 0);
      const chevCls = knownEmpty && !isRoot ? "leaf" : expanded ? "open" : "";
      let kidsHTML = "";
      if (expanded) {
        if (loading && !cached) {
          kidsHTML = `<div class="dt-empty">加载中…</div>`;
        } else if (cached) {
          if (cached.dirs.length) {
            kidsHTML = `<ul class="dt-ul nested">${cached.dirs.map((d) => renderBranch(joinChildPath(cached.canonical || nodePath, d), d, false, depth + 1)).join("")}</ul>`;
          } else {
            kidsHTML = `<div class="dt-empty">没有子文件夹</div>`;
          }
        }
      }
      return `<li class="dt-li">
        <div class="dt-row ${selected ? "selected" : ""}" data-dt-path="${esc(cached?.canonical || nodePath)}">
          <button type="button" class="dt-chev ${chevCls}" data-dt-toggle="${esc(cached?.canonical || nodePath)}" tabindex="-1" aria-label="展开或收起">${CHEV_RIGHT_ICO}</button>
          <span class="dt-ico">${expanded || selected ? GLYPHS.folderOpen : GLYPHS.folder}</span>
          <span class="dt-label">${esc(label)}</span>
          ${selected ? '<span class="dt-badge">当前目录</span>' : ""}
        </div>
        ${kidsHTML}
      </li>`;
    };

    const rootLabel = treeRoot === "~" ? `~ (${tilde(treeMeta.home || "~") === "~" && treeMeta.home ? cleanPath(treeMeta.home) : "主目录"})` : treeRoot;
    box.innerHTML = `<ul class="dt-ul">${renderBranch(treeRoot, rootLabel, true, 0)}</ul>`;
  }

  async function navigateTreeTo(targetPath, { scrollIntoView = true } = {}) {
    const seq = ++treeReqSeq;
    const raw = (targetPath || "~").trim() || "~";
    try {
      await fetchDirNode("~");
      if (seq !== treeReqSeq) return;
      const node = await fetchDirNode(raw);
      if (seq !== treeReqSeq) return;
      const disp = node.display && node.display.startsWith("~") ? node.display : node.path;
      cwdInput.value = disp;
      if (launchMode === "project") suggestProjectNameFromCwd(disp);
      const { root, chain } = inferRootAndChain(disp);
      treeRoot = root;
      for (const step of chain) {
        const snk = treeNormKey(step);
        treeExpanded.add(snk);
        await fetchDirNode(step).catch(() => {});
        if (seq !== treeReqSeq) return;
      }
      renderDirTreeDOM();
      if (scrollIntoView) {
        requestAnimationFrame(() => {
          $("#dir-tree .dt-row.selected")?.scrollIntoView({ block: "nearest" });
        });
      }
    } catch (err) {
      if (seq !== treeReqSeq) return;
      renderDirTreeDOM();
      $("#launch-error").textContent = "读取目录失败：" + err.message;
    }
  }

  function renderRecentDirs() {
    const recent = store.get(recentKey(), []);
    const mProjs = launchMode === "session" ? (state.projects || []).filter((p) => (p.machine || "") === (pickMachine || "")) : [];
    const chips = [
      ...mProjs.map((p) => ({ label: "📁 " + p.name, path: p.cwd })),
      ...recent.filter((d) => !mProjs.some((p) => p.cwd === d)).slice(0, 5).map((d) => ({ label: d, path: d })),
    ];
    const recEl = $("#recent");
    if (!recEl) return;
    recEl.hidden = chips.length === 0;
    recEl.innerHTML = chips.length
      ? `<span class="dr-lab">常用：</span>` + chips.map((c) => `<button type="button" data-d="${esc(c.path)}">${esc(c.label)}</button>`).join("")
      : "";
  }

  function resetDir(initialPath) {
    treeMeta = { home: "", sep: "/", drives: [] };
    treeExpanded.clear();
    const recent = store.get(recentKey(), []);
    const start = initialPath || recent[0] || "~";
    cwdInput.value = start;
    renderRecentDirs();
    navigateTreeTo(start);
  }

  $("#dir-roots")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-root]");
    if (!b) return;
    $("#launch-error").textContent = "";
    treeRoot = b.dataset.root;
    navigateTreeTo(b.dataset.root);
  });
  $("#dir-crumbs")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-crumb]");
    if (!b) return;
    $("#launch-error").textContent = "";
    navigateTreeTo(b.dataset.crumb);
  });
  $("#dir-tree")?.addEventListener("click", async (e) => {
    const tog = e.target.closest("[data-dt-toggle]");
    if (tog) {
      e.stopPropagation();
      const p = tog.dataset.dtToggle, nk = treeNormKey(p);
      if (treeExpanded.has(nk)) {
        treeExpanded.delete(nk);
        renderDirTreeDOM();
      } else {
        treeExpanded.add(nk);
        treeLoading.add(nk);
        renderDirTreeDOM();
        await fetchDirNode(p).catch(() => {});
        treeLoading.delete(nk);
        renderDirTreeDOM();
      }
      return;
    }
    const row = e.target.closest("[data-dt-path]");
    if (!row) return;
    $("#launch-error").textContent = "";
    const p = row.dataset.dtPath, nk = treeNormKey(p);
    cwdInput.value = p;
    if (launchMode === "project") suggestProjectNameFromCwd(p);
    if (!treeExpanded.has(nk)) {
      treeExpanded.add(nk);
      treeLoading.add(nk);
      renderDirTreeDOM();
      await fetchDirNode(p).catch(() => {});
      treeLoading.delete(nk);
    }
    renderDirTreeDOM();
  });

  $("#dir-up")?.addEventListener("click", () => {
    $("#launch-error").textContent = "";
    const curNk = treeNormKey(cwdInput.value);
    const cached = treeCache.get(pickMachine + "::" + curNk);
    let up = cached?.parent || "";
    if (!up || up === "/") {
      const v = cwdInput.value.replace(/[\\/]+$/, "");
      if (/^[A-Za-z]:$/.test(v)) {
        if (treeMeta.drives?.length > 1) return;
        up = v + "\\";
      } else {
        const i = Math.max(v.lastIndexOf("/"), v.lastIndexOf("\\"));
        up = i > 0 ? v.slice(0, i) : i === 0 ? "/" : "~";
        if (/^[A-Za-z]:$/.test(up)) up += "\\";
      }
    }
    navigateTreeTo(up);
  });

  $("#dir-edit-btn")?.addEventListener("click", () => {
    const row = $("#dir-path-row");
    row.hidden = !row.hidden;
    if (!row.hidden) { cwdInput.focus(); cwdInput.select(); }
  });
  $("#dir-go-btn")?.addEventListener("click", () => {
    $("#launch-error").textContent = "";
    navigateTreeTo(cwdInput.value);
  });
  cwdInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      $("#launch-error").textContent = "";
      navigateTreeTo(cwdInput.value);
    }
  });

  $("#dir-mkdir-btn")?.addEventListener("click", () => {
    const row = $("#dir-mkdir-row"), inp = $("#dir-mkdir-input");
    row.hidden = !row.hidden;
    if (!row.hidden) { inp.value = ""; inp.focus(); }
  });
  $("#dir-mkdir-cancel")?.addEventListener("click", () => { $("#dir-mkdir-row").hidden = true; });
  async function submitMkdir() {
    const inp = $("#dir-mkdir-input"), name = inp.value.trim();
    if (!name) return;
    $("#launch-error").textContent = "";
    const parent = cwdInput.value.trim() || "~";
    try {
      const r = await api("/api/dirs" + (pickMachine ? "?machine=" + encodeURIComponent(pickMachine) : ""), { body: { parent, name } });
      $("#dir-mkdir-row").hidden = true;
      inp.value = "";
      await fetchDirNode(parent, true);
      const nextP = r.display && r.display.startsWith("~") ? r.display : r.path;
      await navigateTreeTo(nextP);
      toast(`已创建文件夹「${name}」`);
    } catch (err) { $("#launch-error").textContent = err.message; }
  }
  $("#dir-mkdir-ok")?.addEventListener("click", submitMkdir);
  $("#dir-mkdir-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submitMkdir(); }
  });

  $("#l-proj-subdir-btn")?.addEventListener("click", () => {
    projSubdirOpen = !projSubdirOpen;
    $("#l-dir-field").hidden = !projSubdirOpen;
    $("#l-proj-subdir-btn").textContent = projSubdirOpen ? "收起目录树" : "选择子目录";
    if (projSubdirOpen) resetDir(cwdInput.value);
  });

  $("#l-machines").addEventListener("click", (e) => {
    const b = e.target.closest("[data-m]");
    if (!b) return;
    pickMachine = b.dataset.m;
    store.set("machine", pickMachine);
    renderMachinePick();
    resetDir();
    suggestName();
  });

  function syncLaunchModeUI() {
    const isProj = launchMode === "project";
    const isProjSess = launchMode === "project-session";
    $("#launch-title").textContent = isProj ? (editingProj ? "编辑项目设置" : "新建项目")
      : isProjSess ? `在「${activeLaunchProj?.name || "项目"}」下新建会话` : "新建独立会话";
    $("#launch-note").textContent = isProj
      ? "先选择电脑与默认 Agent，再在目录树中选中代码库文件夹。项目会固定在左侧顶部，后续一键开启绑定目录的新对话。"
      : isProjSess
      ? "已自动绑定该项目的电脑与工作目录，选择本次要用的 Agent 即可开始对话。"
      : "先选择目标电脑与 Agent，再在目录树中选择工作目录启动一个独立对话会话。";
    $("#l-kind-label").textContent = isProj ? "默认 Agent" : "Agent";
    $("#l-model-label").innerHTML = (isProj ? "默认模型与思考强度" : "模型与思考强度") + ' <span class="muted">可选</span>';
    $("#l-dir-label").textContent = isProj ? "选择项目目录（点击展开子目录）" : "工作目录（点击展开子目录）";

    $("#l-proj-banner").hidden = !isProjSess;
    if (isProjSess && activeLaunchProj) {
      $("#l-proj-banner-name").textContent = activeLaunchProj.name;
      $("#l-proj-banner-machine").textContent = machineName(activeLaunchProj.machine);
      $("#l-proj-banner-cwd").textContent = tilde(activeLaunchProj.cwd);
      $("#l-proj-subdir-btn").textContent = projSubdirOpen ? "收起目录树" : "选择子目录";
    }
    $("#l-dir-field").hidden = isProjSess && !projSubdirOpen;
    $("#l-proj-name-field").hidden = !isProj;
    $("#l-prompt-field").hidden = isProj;
    $("#l-adv-field").hidden = isProj;
    $("#dir-path-row").hidden = true;
    $("#dir-mkdir-row").hidden = true;

    const projStartBtn = $("#launch-proj-start"), goBtn = $("#launch-go");
    projStartBtn.hidden = !(isProj && !editingProj);
    goBtn.textContent = isProj ? (editingProj ? "保存修改" : "创建项目") : "启动会话";
  }

  function openLauncher(opts = {}) {
    if (typeof opts === "string") opts = { mode: "session", machine: opts };
    launchMode = opts.mode || "session";
    activeLaunchProj = opts.project || null;
    editingProj = opts.editProject || null;
    projSubdirOpen = false;
    nameTouched = false;
    projNameTouched = Boolean(editingProj);
    $("#launch-error").textContent = "";
    $("#l-prompt").value = "";
    nameInput.value = "";

    const savedM = store.get("machine", null);
    const defaultM = sideMachine !== null ? sideMachine : (savedM !== null ? savedM : preferredWorkMachine(""));
    pickMachine = editingProj ? (editingProj.machine || "")
      : activeLaunchProj ? (activeLaunchProj.machine || "")
      : typeof opts.machine === "string" ? opts.machine : defaultM;

    syncLaunchModeUI();
    renderMachinePick();

    const wantKind = editingProj?.kind || activeLaunchProj?.kind || store.get("kind", "claude");
    const kindVal = wantKind === "agy" ? "antigravity" : wantKind;
    const radio = $(`input[name=kind][value="${kindVal}"]`);
    if (radio && !radio.disabled) radio.checked = true;
    markKinds();

    const presetModel = editingProj ? (editingProj.model || "") : activeLaunchProj?.model ? activeLaunchProj.model : undefined;
    const presetEffort = editingProj ? (editingProj.effort || "") : activeLaunchProj?.effort ? activeLaunchProj.effort : undefined;
    fillLaunchModels(presetModel, presetEffort);

    if (editingProj) {
      projNameInput.value = editingProj.name || "";
      resetDir(editingProj.cwd || "~");
    } else if (activeLaunchProj) {
      cwdInput.value = activeLaunchProj.cwd || "~";
    } else {
      projNameInput.value = "";
      resetDir(opts.cwd || "");
    }
    sheet.showModal();
  }

  $("#btn-new-project")?.addEventListener("click", () => openLauncher({ mode: "project" }));
  $("#btn-new-session")?.addEventListener("click", () => openLauncher({ mode: "session" }));
  $$("input[name=kind]").forEach((r) => r.addEventListener("change", () => suggestName()));
  nameInput.addEventListener("input", () => { nameTouched = true; });
  projNameInput?.addEventListener("input", () => { projNameTouched = true; });
  $("#recent").addEventListener("click", (e) => {
    const d = e.target.closest("button")?.dataset.d;
    if (d) { $("#launch-error").textContent = ""; navigateTreeTo(d); }
  });

  $("#launch-form").addEventListener("submit", async (e) => {
    const action = e.submitter?.value;
    if (action !== "go" && action !== "proj-go") return;
    e.preventDefault();
    const rawKind = $("input[name=kind]:checked").value;
    const kind = rawKind === "antigravity" ? "agy" : rawKind;
    const cwd = cwdInput.value.trim() || "~";
    const model = $("#l-model").value;
    const effort = $("#l-effort").value;
    const go = $("#launch-go"), projGo = $("#launch-proj-start");
    go.disabled = true; projGo.disabled = true;
    const prevText = go.textContent;
    go.textContent = launchMode === "project" && action === "go" ? "保存中…" : "启动中…";
    $("#launch-error").textContent = "";
    try {
      if (launchMode === "project") {
        const projBody = {
          name: projNameInput.value.trim(),
          machine: pickMachine,
          cwd,
          kind,
          model,
          effort,
        };
        let savedProj;
        if (editingProj) {
          savedProj = (await api(`/api/projects/${encodeURIComponent(editingProj.id)}/update`, { body: projBody })).project;
          toast("已更新项目设置");
        } else {
          savedProj = (await api("/api/projects", { body: projBody })).project;
          if (savedProj) setProjOpen(savedProj.id, true);
        }
        store.set("kind", rawKind);
        store.set("machine", pickMachine);
        saveLastModel(rawKind, pickMachine, model, effort);
        store.set(recentKey(), [cwd, ...store.get(recentKey(), []).filter((d) => d !== cwd)].slice(0, 8));
        await refreshSessionMeta();
        if (action === "proj-go" && savedProj) {
          const r = await api("/api/agents", { body: {
            kind: rawKind, name: "", cwd: savedProj.cwd, prompt: "", machine: pickMachine,
            model, effort, project_id: savedProj.id,
          } });
          sheet.close();
          if (r.warning) toast(r.warning, "attn");
          location.hash = "#/p/" + encodeURIComponent(r.pane_id);
        } else {
          sheet.close();
          if (!editingProj) toast(`已创建项目「${savedProj?.name || projBody.name}」`);
        }
        return;
      }

      const body = {
        kind: rawKind,
        name: nameInput.value.trim(),
        cwd,
        prompt: $("#l-prompt").value,
        machine: pickMachine,
        model,
        effort,
        project_id: launchMode === "project-session" && activeLaunchProj ? activeLaunchProj.id : "",
      };
      const r = await api("/api/agents", { body });
      store.set("kind", rawKind);
      store.set("machine", pickMachine);
      saveLastModel(rawKind, pickMachine, model, effort);
      store.set(recentKey(), [cwd, ...store.get(recentKey(), []).filter((d) => d !== cwd)].slice(0, 8));
      if (activeLaunchProj) setProjOpen(activeLaunchProj.id, true);
      sheet.close();
      if (r.warning) toast(r.warning, "attn");
      location.hash = "#/p/" + encodeURIComponent(r.pane_id);
    } catch (err) { $("#launch-error").textContent = err.message; }
    finally { go.disabled = false; projGo.disabled = false; go.textContent = prevText; }
  });

  // ───────────────────────────── viewport (mobile keyboard)
  function setVH() {
    const v = window.visualViewport;
    const root = document.documentElement.style;
    const pinned = [...document.querySelectorAll(".viewer")].filter((el) => el.offsetParent && el.scrollHeight - el.scrollTop - el.clientHeight < 80);
    root.setProperty("--vh", (v ? v.height : innerHeight) + "px");
    pinned.forEach((el) => { el.scrollTop = el.scrollHeight; });
    root.setProperty("--vtop", (v ? Math.max(0, v.offsetTop) : 0) + "px");
  }
  window.visualViewport?.addEventListener("resize", setVH);
  window.visualViewport?.addEventListener("scroll", setVH);
  addEventListener("resize", setVH);
  setVH();

  // ───────────────────────────── boot
  async function boot() {
    const q = new URLSearchParams(location.search);
    const t = q.get("t"), code = q.get("pair");
    if (t || code) {
      try { if (code) await pair(code); else await login(t); }
      catch (err) { if (code) { $("#login-error").textContent = err.message; } }
      history.replaceState(null, "", location.pathname + location.hash);
    }
    try { await api("/api/session"); } catch { return; }
    try { sup = normSup(await api("/api/super")); } catch {}
    try { setLocalState(await api("/api/state")); } catch {}
    await loadHubs();
    $("#login").hidden = true;
    $("#app").hidden = false;
    connect();
    view = undefined;
    route();
    loadExternal();
    clearInterval(extTimer);
    loadHistory();
    // The hub answers the list from its own copy, so this is cheap.
    let tick = 0;
    extTimer = setInterval(() => { loadExternal(); if (++tick % 3 === 0) loadHistory(); }, 3000);
    offerLocalApp();
  }

  // On a computer that serves Collie at 127.0.0.1 (a node, or the hub's own
  // machine), offer to switch there: Chrome installs and opens it as an app
  // only on a secure origin, which the LAN address is not.
  async function offerLocalApp() {
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname);
    if (local || !matchMedia("(pointer: fine)").matches || store.get("local-app-off", false)) return;
    let r;
    try { r = await api("/api/local-app"); } catch { return; }
    if (!r.url) return;
    $("#local-app").hidden = false;
    $("#local-app-open").title = r.url;
    $("#local-app-open").onclick = async (e) => {
      e.preventDefault();
      try {
        // A one-time code signs the new address in, like scanning a QR code.
        const p = await api("/api/pair/new", { body: { kind: "browser" } });
        location.href = `${r.url}/?pair=${encodeURIComponent(p.code)}${location.hash}`;
      } catch (err) { toast(err.message, "attn"); }
    };
    $("#local-app-x").onclick = () => { store.set("local-app-off", true); $("#local-app").hidden = true; };
  }
  // ───────────────────────────── command palette (⌘K / Ctrl+K)
  const cmdk = $("#cmdk"), cmdkInput = $("#cmdk-input"), cmdkList = $("#cmdk-list");
  let cmdkItems = [], cmdkIdx = 0;
  function buildCmdkItems(q) {
    const needle = (q || "").trim().toLowerCase();
    const match = (...parts) => !needle || parts.some((p) => String(p || "").toLowerCase().includes(needle));
    const groups = [];

    const projItems = (state.projects || []).map((p) => ({
      ico: GLYPHS.folder,
      title: `${p.name} · 新建会话`,
      sub: `${machineName(p.machine)} · ${tilde(p.cwd)} · 默认 ${KIND_LABEL[p.kind] || p.kind}`,
      meta: "项目",
      run: () => openLauncher({ mode: "project-session", project: p }),
    })).filter((x) => match(x.title, x.sub, x.meta));

    const navActs = [
      { ico: GLYPHS.collie, title: "和 Collie 对话", sub: "回到主协调对话界面", meta: "视图", run: () => { location.hash = "#/collie"; } },
      { ico: GLYPHS.folder, title: "新建项目", sub: "绑定某台电脑上的代码库目录，在左侧顶部固定管理", meta: "操作", run: () => openLauncher({ mode: "project" }) },
      { ico: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>', title: "新建独立会话", sub: "在指定电脑与目录启动独立 Agent 对话", meta: "操作", run: () => openLauncher({ mode: "session" }) },
      ...runnableMachines().map((m) => ({
        ico: osGlyph(m.os), title: `在 ${m.name} 上新建会话`, sub: `${m.os || "本地"} · ${tilde(m.home || "~")}`, meta: "电脑",
        run: () => openLauncher(m.id),
      })),
      { ico: '<svg viewBox="0 0 24 24"><circle cx="6" cy="6" r="2.2"/><circle cx="18" cy="12" r="2.2"/><circle cx="6" cy="18" r="2.2"/><path d="M8.2 6h4.3a3.5 3.5 0 0 1 3.5 3.5v.3M15.8 13.8v.7a3.5 3.5 0 0 1-3.5 3.5H8.2"/></svg>', title: "执行轨迹", sub: "查看每次派活从下发、跨机执行到汇报的完整任务流转链路", meta: "导航", run: () => { traceTab = "flow"; store.set("traceTab", "flow"); location.hash = "#/trace"; if (view === "trace") openPanel("trace"); } },
      { ico: '<svg viewBox="0 0 24 24"><path d="M5 4.5A2.5 2.5 0 0 1 7.5 2H19v18H7.5A2.5 2.5 0 0 0 5 22.5z"/><path d="M9 7h6M9 11h6"/></svg>', title: "长期记忆", sub: "按分栏查看或编辑 Collie 的长期指令、经验笔记与归档", meta: "导航", run: () => { location.hash = "#/memory"; } },
      { ico: '<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="8"/><path d="M12 9v4.2l2.8 1.8M9.5 2h5"/></svg>', title: "定时任务", sub: "创建或管理每日巡检与延后提醒", meta: "导航", run: () => { location.hash = "#/timers"; } },
      { ico: '<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.07 0l2.12-2.12a5 5 0 0 0-7.07-7.07L10.7 5.2"/><path d="M14 11a5 5 0 0 0-7.07 0L4.8 13.1a5 5 0 0 0 7.07 7.07l1.41-1.41"/></svg>', title: "外部触发（Webhook 与过滤）", sub: "管理 GitHub / 飞书 Webhook 与免唤醒过滤规则", meta: "导航", run: () => { location.hash = "#/hooks"; } },
      { ico: OS_GLYPHS.relay, title: "设备与节点连接", sub: "管理接入电脑、配对二维码与版本升级", meta: "导航", run: () => { location.hash = "#/devices"; } },
      { ico: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1"/></svg>', title: "设置 · Collie 全局配置", sub: "切换 Collie 大脑、默认派活电脑与飞书通知", meta: "设置", run: () => { settingsTab = "collie"; store.set("settingsTab", "collie"); location.hash = "#/settings"; if (view === "settings") openPanel("settings"); } },
      { ico: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1"/></svg>', title: "设置 · 本机界面与通知", sub: "主题外观、字号、默认视图、快捷键与浏览器通知", meta: "设置", run: () => { settingsTab = "local"; store.set("settingsTab", "local"); location.hash = "#/settings"; if (view === "settings") openPanel("settings"); } },
      { ico: THEME_ICONS[prefs.theme()] || THEME_ICONS.system, title: "切换外观主题（浅色 / 深色 / 跟随系统）", sub: `当前：${{ system: "跟随系统", light: "浅色", dark: "深色" }[prefs.theme()]}`, meta: "快捷", run: () => $("#theme-btn")?.click() },
    ].filter((x) => match(x.title, x.sub, x.meta));

    const cmdkSeen = new Set();
    const liveItems = [
      ...state.agents.filter((a) => a.name !== ROUTER && SHOW_SIDE_DOT.has(a.status) && !getSessMeta(a.kind, a.machine, a.session, "p:" + a.pane_id)?.deleted).map((a) => {
        const ck = canonSessKey(a.kind, a.machine, a.session);
        if (ck) cmdkSeen.add(ck);
        return {
          ico: glyph(a), title: title(a), sub: `${KIND_LABEL[a.kind] || a.kind} · ${machineName(a.machine)} · ${tilde(a.cwd)}`,
          meta: STATUS_LABEL[a.status] || a.status, dot: a.status,
          run: () => { location.hash = "#/p/" + encodeURIComponent(a.pane_id); },
        };
      }),
      ...ext.filter((e) => e.live && SHOW_SIDE_DOT.has(e.status) && !getSessMeta(e.kind, e.machine, e.session, "x:" + e.id)?.deleted).map((e) => {
        const ck = canonSessKey(e.kind, e.machine, e.session);
        if (ck) cmdkSeen.add(ck);
        return {
          ico: GLYPHS[e.kind] || GLYPHS.agent, title: extName(e), sub: `${KIND_LABEL[e.kind] || e.kind} · ${machineName(e.machine)}`,
          meta: EXT_STATE[e.status] || "运行中", dot: e.status || "unknown",
          run: () => { location.hash = "#/x/" + encodeURIComponent(e.id); },
        };
      }),
    ].filter((x) => match(x.title, x.sub, x.meta));

    const collieRan = (name) => name === ROUTER || sup.workers.some((w) => w.name === name);
    const extUpdatedMap = new Map();
    for (const e of ext) {
      const ck = canonSessKey(e.kind, e.machine, e.session);
      if (ck) extUpdatedMap.set(ck, +new Date(e.updated || e.started) || 0);
    }
    const recentItems = [
      ...state.agents.filter((a) => a.name !== ROUTER && !SHOW_SIDE_DOT.has(a.status) && !getSessMeta(a.kind, a.machine, a.session, "p:" + a.pane_id)?.deleted).map((a) => {
        const ck = canonSessKey(a.kind, a.machine, a.session);
        if (ck) cmdkSeen.add(ck);
        const ts = (ck && extUpdatedMap.get(ck)) || Date.now();
        return {
          t: new Date(ts), ico: glyph(a), title: title(a),
          sub: `${KIND_LABEL[a.kind] || a.kind} · ${machineName(a.machine)} · ${tilde(a.cwd)}`, meta: ago(new Date(ts).toISOString()),
          run: () => { location.hash = "#/p/" + encodeURIComponent(a.pane_id); },
        };
      }),
      ...ext.filter((e) => !(e.live && SHOW_SIDE_DOT.has(e.status)) && !getSessMeta(e.kind, e.machine, e.session, "x:" + e.id)?.deleted).flatMap((e) => {
        const ck = canonSessKey(e.kind, e.machine, e.session);
        if (ck && cmdkSeen.has(ck)) return [];
        if (ck) cmdkSeen.add(ck);
        return [{
          t: new Date(e.updated || e.started), ico: GLYPHS[e.kind] || GLYPHS.agent, title: extName(e),
          sub: `${KIND_LABEL[e.kind] || e.kind} · ${machineName(e.machine)} · ${tilde(e.cwd)}`, meta: ago(e.updated || e.started),
          run: () => { location.hash = "#/x/" + encodeURIComponent(e.id); },
        }];
      }),
      ...hist.filter((h) => !collieRan(h.name) && !getSessMeta(h.kind, h.machine, h.session, "h:" + h.id)?.deleted).flatMap((h) => {
        const ck = canonSessKey(h.kind, h.machine, h.session);
        if (ck && cmdkSeen.has(ck)) return [];
        if (ck) cmdkSeen.add(ck);
        return [{
          t: new Date(h.ended), ico: GLYPHS[h.kind] || GLYPHS.agent, title: histName(h),
          sub: `${KIND_LABEL[h.kind] || h.kind} · ${machineName(h.machine)} · ${tilde(h.cwd)}`, meta: ago(h.ended),
          run: () => { location.hash = "#/h/" + encodeURIComponent(h.id); },
        }];
      }),
    ].sort((a, b) => b.t - a.t).filter((x) => match(x.title, x.sub, x.meta)).slice(0, needle ? 20 : 8);

    if (projItems.length) groups.push(["项目快捷新建", projItems]);
    if (liveItems.length) groups.push(["进行中的会话", liveItems]);
    if (navActs.length) groups.push(["导航与快捷操作", navActs]);
    if (recentItems.length) groups.push(["最近会话", recentItems]);
    return groups;
  }
  function renderCmdk() {
    const groups = buildCmdkItems(cmdkInput.value);
    cmdkItems = [];
    let html = "";
    for (const [sec, list] of groups) {
      html += `<div class="cmdk-sec">${esc(sec)}</div>`;
      for (const it of list) {
        const idx = cmdkItems.length;
        cmdkItems.push(it);
        html += `<button type="button" class="cmdk-item${idx === cmdkIdx ? " on" : ""}" data-ci="${idx}">
          <span class="ci-ico">${it.ico}</span>
          <span class="ci-main"><div class="ci-title">${esc(it.title)}</div><div class="ci-sub">${esc(it.sub)}</div></span>
          <span class="ci-meta">${it.dot ? `<span class="dot ${esc(it.dot)}"></span>` : ""}${esc(it.meta || "")}</span>
        </button>`;
      }
    }
    cmdkList.innerHTML = html || `<div class="cmdk-empty">没有找到匹配的会话或操作</div>`;
    cmdkList.querySelector(".cmdk-item.on")?.scrollIntoView({ block: "nearest" });
  }
  function openCmdk() {
    if (!cmdk || !$("#app") || $("#app").hidden) return;
    if (cmdk.open) { cmdk.close(); return; }
    closePick();
    cmdkInput.value = "";
    cmdkIdx = 0;
    renderCmdk();
    cmdk.showModal();
    cmdkInput.focus();
  }
  $("#cmdk-btn")?.addEventListener("click", openCmdk);
  $("#cmdk-close")?.addEventListener("click", () => cmdk?.close());
  cmdk?.addEventListener("click", (e) => {
    if (e.target === cmdk) { cmdk.close(); return; }
    const b = e.target.closest(".cmdk-item[data-ci]");
    if (!b) return;
    const it = cmdkItems[+b.dataset.ci];
    cmdk.close();
    it?.run();
  });
  cmdkInput?.addEventListener("input", () => { cmdkIdx = 0; renderCmdk(); });
  cmdk?.addEventListener("keydown", (e) => {
    if (!cmdkItems.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      cmdkIdx = (cmdkIdx + (e.key === "ArrowDown" ? 1 : -1) + cmdkItems.length) % cmdkItems.length;
      renderCmdk();
    } else if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      const it = cmdkItems[cmdkIdx];
      cmdk.close();
      it?.run();
    }
  });
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      openCmdk();
    }
  });

  boot();
})();
