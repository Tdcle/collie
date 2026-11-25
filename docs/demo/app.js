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
  const unesc = (s) => String(s ?? "").replace(/&(amp|lt|gt|quot|#39);/g, (_, k) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" }[k] || _));
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
  const fmtSize = (n) => n < 1024 ? n + " B" : n < 1 << 20 ? Math.round(n / 1024) + " KB" : (n / 1048576).toFixed(1) + " MB";
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
    collie: '<img src="icon.svg" alt="" style="width:20px;height:20px">',
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
    if (!document.hidden) loadExternal();
  });

  // A finished agent you have open here has been seen: the hub then shows
  // it as idle everywhere (herdr itself only counts its own terminal).
  const seenAt = new Map();
  function markSeen(v) {
    if (!v || document.hidden || Date.now() - (seenAt.get(v.pane_id) || 0) < 3000) return;
    if (v.status !== "done" && !(v.kind === "codex" && v.session)) return;
    seenAt.set(v.pane_id, Date.now());
    api("/api/seen", { body: { pane: v.pane_id, kind: v.kind || "", machine: v.machine || "", session: v.session || "" } }).catch(() => {});
  }
  function markExtSeen(e) {
    if (!e || e.kind !== "codex" || !e.session || document.hidden) return;
    if (e.live && e.status === "working") return;
    const key = "x:" + e.id;
    if (Date.now() - (seenAt.get(key) || 0) < 3000) return;
    seenAt.set(key, Date.now());
    api("/api/seen", { body: { kind: e.kind, machine: e.machine || "", session: e.session } }).catch(() => {});
  }
  document.addEventListener("visibilitychange", () => {
    if (view === "pane" && find(current)) markSeen(find(current));
    if (view === "ext" && extCur && !extCur.startsWith("h:")) markExtSeen(ext.find((x) => x.id === extCur));
  });

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

  // Tell the hub whether a page of Collie is actively in front of you: it holds
  // back notifications while you are looking, and pushes as soon as you switch away.
  let awayTimer = null;
  const seen = () => {
    clearTimeout(awayTimer);
    if (!document.hidden && document.hasFocus()) {
      api("/api/super/seen", { body: { url: location.origin, away: false } }).catch(() => {});
    } else {
      awayTimer = setTimeout(() => {
        if (document.hidden || !document.hasFocus()) {
          api("/api/super/seen", { body: { url: location.origin, away: true } }).catch(() => {});
        }
      }, 1500);
    }
  };
  setInterval(() => { if (!document.hidden && document.hasFocus()) seen(); }, 30e3);
  document.addEventListener("visibilitychange", seen);
  addEventListener("focus", seen);
  addEventListener("blur", seen);

  function normSup(s) {
    s.hasPending = Array.isArray(s.pending);
    s.entries ||= []; s.workers ||= []; s.pending ||= []; s.router ||= { status: "asleep" };
    return s;
  }
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
        let matched = isRootLike ? sp === pp : (sp === pp || sp.startsWith(pp + "/"));
        if (!matched && pp.startsWith("~/")) {
          const rel = pp.slice(1); // "/documents/chatgpt/sfd-net 2"
          const mHome = /^([a-z]:\/users\/[^/]+|\/users\/[^/]+|\/home\/[^/]+|\/root)(\/.*|$)/i.exec(sp);
          if (mHome) {
            const tail = mHome[2] || "";
            matched = tail === rel || tail.startsWith(rel + "/");
          }
        }
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
  const PIN_ICO = `<svg viewBox="0 0 24 24"><path d="M15 4.5l4.5 4.5-3.2 3.2.7 4.3-4.8-4.8-5.2 5.2M12.2 11.7L7.5 7l4.3.7L15 4.5z"/></svg>`;
  const COLLIE_MARK_ICO = `<svg viewBox="6 7 52 51" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 31.5c6.5-1.4 12-3.2 17-6.2 2.6-3 5.2-5 8.4-5.9L38.4 10l6.4 10.4c4.6 3.2 7.2 8.4 7.4 14.6.2 3.6 1.4 6 2.8 8.2-1.6 1.4-2.4 3.4-2.4 5.8 0 2.2-.6 4-1.6 5.6"/><path d="M38.4 10l-3.6 3.2"/><path d="M9.5 31.5c1.2 2.6 4.6 4 10 4 3.4 0 6.4 1 8.8 3"/><path d="M28.3 38.5c-.4 2.8.6 4.6 2.6 5.8-.8 2.2-.2 4.2 1.8 5.6-.2 1.8.4 3.2 1.6 4.4"/><path d="M37 37c2 2.4 2.6 5.2 2 8.4M44 35c2.2 2.6 3 5.6 2.4 9"/></g><circle cx="30.6" cy="26.2" r="2.2" fill="currentColor" stroke="none"/><circle cx="10" cy="31.6" r="2.5" fill="currentColor" stroke="none"/></svg>`;
  const collieMarkHTML = () => `<span class="by-collie" title="Collie 派出" aria-label="Collie 派出">${COLLIE_MARK_ICO}</span>`;
  function pinMarkHTML(smenuKey, pinned) {
    return pinned ? `<span class="pin-mark" data-spin="${esc(smenuKey)}" role="button" tabindex="0" title="已置顶（点击取消置顶）">${PIN_ICO}</span>` : "";
  }
  function itemHTML(v, pinned = false, byCollie = null) {
    const isByC = byCollie !== null ? byCollie : (isCollieOwned(v) && v.name !== ROUTER);
    const where = (state.machines || []).length > 1 ? machineName(v.machine) + " · " : "";
    const named = v.is_agent && v.name !== ROUTER && !isByC && v.name && !autoName(v.name) && v.topic && v.topic !== v.name ? v.name + " · " : "";
    const sub = v.name === ROUTER ? "Collie 停在一个对话框上"
      : v.is_agent ? `${named}${KIND_LABEL[v.kind] || v.kind} · ${where}${base(tilde(v.cwd))}` : where + tilde(v.cwd);
    const smenuKey = "p:" + v.pane_id;
    const more = v.name !== ROUTER ? `<button type="button" class="item-more" data-smenu="${esc(smenuKey)}" title="置顶 / 重命名 / 归属项目 / 归档 / 删除">${MORE_ICO}</button>` : "";
    const quiet = !SHOW_SIDE_DOT.has(v.status);
    const rawTitle = v.is_agent ? title(v) : v.workspace_label || base(tilde(v.cwd));
    const nameInner = isByC && v.name !== ROUTER
      ? `<span class="nm">${esc(title(v))}</span>${collieMarkHTML()}${pinMarkHTML(smenuKey, pinned)}`
      : `${esc(rawTitle)}${pinMarkHTML(smenuKey, pinned)}`;
    return `<li class="s-li${pinned ? " is-pinned" : ""}"><a class="item ${quiet ? "ended" : ""} ${view === "pane" && v.pane_id === current ? "active" : ""}" href="#/p/${encodeURIComponent(v.pane_id)}">
      <span class="glyph">${glyph(v)}</span>
      <span class="body"><div class="name">${nameInner}</div><div class="sub">${esc(sub)}</div></span>
      ${sideDotHTML(v.status)}</a>${more}</li>`;
  }

  const machineName = (id) => (state.machines || []).find((m) => m.id === (id || ""))?.name || id || "本机";
  const isCollieOwned = (v) => v.name === ROUTER || isWorker(v.name);
  let sideMachine = null; // null = 全部; string = filter sidebar sessions to that machine id
  let sideStatus = null;  // null | "running" | "blocked" (mutually exclusive toggle)
  let hideCollie = store.get("hideCollie", false); // persistent toggle to hide Collie-dispatched worker sessions
  const osKey = (os) => /^darwin/i.test(os || "") ? "mac" : /^windows/i.test(os || "") ? "win" : "linux";

  function workerLookup() {
    const names = new Set();
    const sessKeys = new Set();
    const rawSess = new Set();
    const fallbackKeys = new Set();
    for (const w of (sup.workers || [])) {
      if (w.name && w.name !== ROUTER && w.name !== "collie-dream") names.add(w.name);
      if (w.pane_id) fallbackKeys.add("p:" + w.pane_id);
      if (w.session) {
        rawSess.add(w.session);
        const ck = canonSessKey(w.kind, w.machine, w.session);
        if (ck) sessKeys.add(ck);
      }
    }
    for (const e of (sup.entries || [])) {
      if (e.role === "event" && e.tone === "spawn" && e.ref && !e.ref.includes(":") && e.ref !== ROUTER && e.ref !== "collie-dream") {
        names.add(e.ref);
      }
    }
    for (const [k, m] of Object.entries(state.session_meta || {})) {
      if (!m?.collie_worker) continue;
      if (k.startsWith("s:")) {
        sessKeys.add(k);
        const sessId = k.split(":").slice(3).join(":");
        if (sessId) rawSess.add(sessId);
      } else {
        fallbackKeys.add(k);
      }
    }
    for (const h of (hist || [])) {
      if (h.name === ROUTER || h.name === "collie-dream") continue;
      if (h.collie_worker || (h.name && names.has(h.name))) {
        if (h.name) names.add(h.name);
        if (h.id) fallbackKeys.add("h:" + h.id);
        if (h.session) {
          rawSess.add(h.session);
          const ck = canonSessKey(h.kind, h.machine, h.session);
          if (ck) sessKeys.add(ck);
        }
      }
    }
    return { names, sessKeys, rawSess, fallbackKeys };
  }
  function isSessionByCollie(wl, { kind, machine, session, name, fallbackKey, meta, flag }) {
    if (name === ROUTER || name === "collie-dream") return false;
    if (flag || meta?.collie_worker) return true;
    if (fallbackKey && wl.fallbackKeys.has(fallbackKey)) return true;
    if (name && wl.names.has(name)) return true;
    if (session) {
      if (wl.rawSess.has(session)) return true;
      const ck = canonSessKey(kind, machine, session);
      if (ck && wl.sessKeys.has(ck)) return true;
    }
    return false;
  }
  const isInternalRouterCwd = (cwd) => /[\\/]\.collie[\\/](?:router|dream)(?:[\\/]|$)/i.test(cleanPath(cwd || ""));

  $("#side-machine-sel")?.addEventListener("change", (e) => {
    sideMachine = e.target.value === "__all" ? null : e.target.value;
    renderSide();
  });
  $("#session-filter")?.addEventListener("click", (e) => {
    if (e.target.closest("[data-hide-collie]")) {
      hideCollie = !hideCollie;
      store.set("hideCollie", hideCollie);
      renderSide();
      return;
    }
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
        const wl = workerLookup();
        const countFor = (id) => {
          const mm = (x) => id === null || (x || "") === id;
          const seen = new Set();
          let n = 0;
          for (const a of state.agents) {
            if (a.name === ROUTER || !mm(a.machine)) continue;
            const meta = getSessMeta(a.kind, a.machine, a.session, "p:" + a.pane_id);
            if (meta?.deleted || meta?.archived) continue;
            const ck = canonSessKey(a.kind, a.machine, a.session);
            const byC = wl.names.has(a.name) || Boolean(a.session && (wl.rawSess.has(a.session) || (ck && wl.sessKeys.has(ck))));
            if (ck) seen.add(ck);
            if (hideCollie && byC && !meta?.pinned) continue;
            n++;
          }
          for (const e of ext) {
            if (!mm(e.machine) || isInternalRouterCwd(e.cwd)) continue;
            const meta = getSessMeta(e.kind, e.machine, e.session, "x:" + e.id);
            if (meta?.deleted || meta?.archived) continue;
            const ck = canonSessKey(e.kind, e.machine, e.session);
            if (ck && seen.has(ck)) continue;
            if (ck) seen.add(ck);
            const byC = Boolean(e.session && (wl.rawSess.has(e.session) || (ck && wl.sessKeys.has(ck))));
            if (hideCollie && byC && !meta?.pinned) continue;
            n++;
          }
          for (const h of hist) {
            if (h.name === ROUTER || h.name === "collie-dream" || !mm(h.machine)) continue;
            const meta = getSessMeta(h.kind, h.machine, h.session, "h:" + h.id);
            if (meta?.deleted || meta?.archived) continue;
            const ck = canonSessKey(h.kind, h.machine, h.session);
            if (ck && seen.has(ck)) continue;
            if (ck) seen.add(ck);
            const byC = wl.names.has(h.name) || Boolean(h.session && (wl.rawSess.has(h.session) || (ck && wl.sessKeys.has(ck))));
            if (hideCollie && byC && !meta?.pinned) continue;
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
    const pend = activePending();
    const attnTotal = blockedAll.length + pend.length;
    document.title = attnTotal ? `(${attnTotal}) Collie` : "Collie";

    const r = sup.router || {};
    const active = sup.workers.filter((w) => !w.ended);
    const running = active.filter(workerBusy).length;
    const f = sup.follow;
    const stText = r.replied ? "在收尾" : collieStatus(r.status);
    $("#nav-collie-sub").textContent = stText + (running ? ` · ${running} 个任务在跑` : active.length ? ` · 派出 ${active.length} 个` : f?.next ? ` · ${whenShort(f.next)} 跟进` : "");
    $("#nav-collie-sub").title = f?.next ? `Collie 计划下次跟进：${whenShort(f.next)} · ${f.next_text || ""}` : "";
    $("#nav-collie-dot").className = "dot " + collieDot(r.status);
    const np = $("#nav-pending");
    if (np) {
      np.hidden = pend.length === 0;
      np.textContent = pend.length || "";
      np.title = pend.length ? `${pend.length} 条待你确认` : "";
    }
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

  // ───────────────────────────── routing & scroll restoration
  const PANEL_VIEWS = new Set(["trace", "memory", "timers", "hooks", "settings"]);
  let navCur = typeof history.state?.collieIdx === "number" ? history.state.collieIdx : 0;
  let booted = false;
  const scrollByRoute = new Map(); // routeKey -> { top, atBottom }
  let pendingScrollRestore = null;

  function syncHistoryIndex() {
    if (typeof history.state?.collieIdx === "number") {
      navCur = history.state.collieIdx;
    } else {
      navCur = booted ? navCur + 1 : 0;
      try { history.replaceState({ ...(history.state || {}), collieIdx: navCur }, ""); } catch {}
    }
  }
  function replaceHash(hash) {
    try { history.replaceState({ ...(history.state || {}), collieIdx: navCur }, "", hash); }
    catch { location.replace(hash); }
  }
  function fallbackHash() {
    if (!narrow()) return "#/collie";
    if (view === "pane") {
      const v = find(current);
      if (v && (v.name === ROUTER || isWorker(v.name))) return "#/collie";
    } else if (view === "ext" && extCur?.startsWith("h:")) {
      const h = hist.find((x) => x.id === extCur.slice(2));
      if (h && (h.name === ROUTER || sup.workers.some((w) => w.name === h.name))) return "#/collie";
    }
    return "#/";
  }
  function goBack(replaceAtRoot = false) {
    if (navCur > 0) {
      history.back();
      return;
    }
    const dest = fallbackHash();
    if (location.hash === dest || (!location.hash && dest === "#/")) return;
    if (replaceAtRoot) { replaceHash(dest); route(); }
    else location.hash = dest;
  }
  document.addEventListener("click", (e) => {
    if (e.target.closest(".back")) { e.preventDefault(); goBack(); return; }
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest('a[href^="#/"]');
    if (a && a.getAttribute("href") === location.hash) e.preventDefault();
  });

  function routeKeyFor(v, id) {
    if (v === "collie") return "collie";
    if (PANEL_VIEWS.has(v)) return "panel:" + v;
    if (v === "devices") return "devices";
    if (v === "file") return "file:" + (id || "");
    if (v === "ext") return "ext:" + (id || "");
    if (v === "pane") return "pane:" + (id || "");
    return "";
  }
  function viewScroller(v = view) {
    if (v === "collie") return $("#super-thread")?.parentElement || null;
    if (PANEL_VIEWS.has(v)) return $("#panel-body");
    if (v === "devices") return $("#devices-body");
    if (v === "file") return $("#rv-scroller");
    if (v === "ext") return $("#x-thread")?.parentElement || null;
    if (v === "pane") return $("#thread");
    return null;
  }
  function saveCurrentScroll() {
    if (!view) return;
    const key = routeKeyFor(view, view === "ext" ? extCur : current);
    const sc = viewScroller(view);
    if (!key || !sc || sc.clientHeight <= 0) return;
    const atBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 60;
    scrollByRoute.set(key, { top: sc.scrollTop, atBottom });
  }
  function syncJumpBtn(sc, btn) {
    if (!sc || !btn) return;
    const dist = sc.scrollHeight - sc.scrollTop - sc.clientHeight;
    btn.hidden = !(sc.clientHeight > 0 && dist > 160);
  }
  function syncAllJumpBtns() {
    syncJumpBtn($("#super-thread")?.parentElement, $("#super-jump"));
    syncJumpBtn($("#x-thread")?.parentElement, $("#x-jump"));
    syncJumpBtn($("#thread"), $("#d-jump"));
  }

  function route() {
    syncHistoryIndex();
    let h = location.hash;
    if (h === "#/auto") {
      const legacyMap = { inbox: "#/trace", threads: "#/trace", memory: "#/memory", timers: "#/timers", hooks: "#/hooks", settings: "#/settings" };
      replaceHash(legacyMap[store.get("autoTab", "inbox")] || "#/trace");
      h = location.hash;
    }
    if (h === "#/prefs") {
      settingsTab = "local"; store.set("settingsTab", "local");
      replaceHash("#/settings");
      h = location.hash;
    }
    let next = null, id = null, subTab = null;
    const qIdx = h.indexOf("?");
    const hPath = qIdx >= 0 ? h.slice(0, qIdx) : h;
    const hQuery = qIdx >= 0 ? new URLSearchParams(h.slice(qIdx + 1)) : null;
    if (hPath.startsWith("#/p/")) { next = "pane"; id = decodeURIComponent(hPath.slice(4)); }
    else if (hPath.startsWith("#/x/")) { next = "ext"; id = decodeURIComponent(hPath.slice(4)); }
    else if (hPath.startsWith("#/h/")) { next = "ext"; id = "h:" + decodeURIComponent(hPath.slice(4)); }
    else if (hPath === "#/file") { next = "file"; id = (hQuery?.get("path") || "") + "@" + (hQuery?.get("machine") || ""); }
    else if (hPath === "#/collie") next = "collie";
    else if (hPath === "#/trace" || hPath.startsWith("#/trace/")) { next = "trace"; }
    else if (hPath === "#/memory" || hPath.startsWith("#/memory/")) { next = "memory"; subTab = hPath.slice(9); if (["active", "notes", "skills", "archive"].includes(subTab)) { memTab = subTab; store.set("memTab", subTab); } }
    else if (hPath === "#/timers") next = "timers";
    else if (hPath === "#/hooks") next = "hooks";
    else if (hPath === "#/settings" || hPath.startsWith("#/settings/")) { next = "settings"; subTab = hPath.slice(11); if (subTab === "collie" || subTab === "local") { settingsTab = subTab; store.set("settingsTab", subTab); } }
    else if (hPath === "#/devices") next = "devices";
    else if (!narrow()) {
      let dest = "#/collie";
      if (!booted && !h) {
        const last = store.get("last", "#/collie");
        const ok = last.startsWith("#/p/") ? !!find(decodeURIComponent(last.slice(4))) : /^#\/(collie|trace|memory|timers|hooks|settings|devices)(\/[a-z]+)?$/.test(last);
        if (ok) dest = last;
      }
      replaceHash(dest);
      h = dest;
      if (h.startsWith("#/p/")) { next = "pane"; id = decodeURIComponent(h.slice(4)); }
      else next = h.slice(2).split("/")[0];
    }
    if (next && next !== "file") store.set("last", hPath);
    if (hQuery?.get("quotas") === "1") {
      replaceHash(hPath);
      setTimeout(() => { toggleQuotaPop(true); loadQuotas(true); }, 80);
    }
    if (next === view && id === (next === "ext" ? extCur : current)) {
      if (subTab && PANEL_VIEWS.has(next)) openPanel(next);
      return;
    }
    saveCurrentScroll();
    if ($("#app")?.classList.contains("has-file") && (next === "file" || matchMedia("(max-width: 1000px)").matches)) closeFilePane();
    if (view === "ext" && (next !== "ext" || id !== extCur)) { closeExt(); }
    if (view === "pane" && (next !== "pane" || id !== current)) closeStream();
    if (PANEL_VIEWS.has(view) && next !== view) clearInterval(autoTimer);
    if (view === "devices" && next !== "devices") clearInterval(devTimer);
    if (next !== "collie") pendingOpen = false;
    view = next;
    current = next === "ext" ? null : id;
    extCur = next === "ext" ? id : null;
    document.body.classList.toggle("show-main", !!next);
    document.body.classList.toggle("reader-mode", next === "file");
    $("#v-collie").hidden = next !== "collie";
    $("#v-panel").hidden = !PANEL_VIEWS.has(next);
    $("#v-devices").hidden = next !== "devices";
    $("#v-ext").hidden = next !== "ext";
    $("#detail").hidden = next !== "pane";
    if ($("#v-file")) $("#v-file").hidden = next !== "file";
    const activeViewEl = next === "collie" ? $("#v-collie") : PANEL_VIEWS.has(next) ? $("#v-panel") : next === "devices" ? $("#v-devices") : next === "ext" ? $("#v-ext") : next === "pane" ? $("#detail") : next === "file" ? $("#v-file") : null;
    const slot = activeViewEl?.querySelector("[data-head-slot]"), topTools = $("#top-tools");
    if (slot && topTools && topTools.parentNode !== slot) slot.append(topTools);
    renderSide();
    const saved = scrollByRoute.get(routeKeyFor(next, id));
    pendingScrollRestore = saved && !saved.atBottom ? { key: routeKeyFor(next, id), top: saved.top, until: Date.now() + 1200 } : null;
    if (next === "collie") { renderSuper(true); renderTarget(true); if (!narrow()) $("#super-input").focus(); }
    if (PANEL_VIEWS.has(next)) openPanel(next);
    if (next === "devices") openDevices();
    if (next === "ext") openExt(id);
    if (next === "file") openWideFile(hQuery?.get("path") || "", hQuery?.get("machine") || "");
    if (next === "pane") {
      $("#gone").hidden = true;
      resetChat();
      renderHead();
      openStream();
      if (!narrow()) $("#input").focus();
    }
    booted = true;
    requestAnimationFrame(() => {
      if (pendingScrollRestore && pendingScrollRestore.key === routeKeyFor(view, view === "ext" ? extCur : current)) {
        const sc = viewScroller(view);
        if (sc) sc.scrollTop = pendingScrollRestore.top;
      }
      syncAllJumpBtns();
    });
  }
  addEventListener("popstate", route);
  addEventListener("hashchange", route);
  addEventListener("resize", () => { if (booted && !view && !narrow()) route(); });

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
  // Items dismissed locally via × or 已看 before the hub's next stream frame lands.
  const dismissedLocal = new Set();
  const ICON_X = `<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg>`;
  let pendingOpen = false, pendingBarSig = "", pendingListSig = "", flashEntry = { id: "", until: 0 }, jumpSeq = 0;
  let prevCrewSig = "";

  function optimisticallyResolved(id, list = chatEntries()) {
    if (dismissedLocal.has(id)) return true;
    if (!pendingSays.length) return false;
    if (pendingSays.some((m) => m.re?.entry === id)) return true;
    if (!pendingSays.some((m) => !m.re?.entry)) return false;
    const idx = list.findIndex((e) => e.id === id);
    if (idx < 0) return false;
    for (let j = idx + 1; j < list.length; j++) {
      if (list[j].role === "collie") return false;
    }
    return true;
  }
  function activePending() {
    const list = sup.pending || [];
    if (!list.length) return [];
    const entries = pendingSays.length ? chatEntries() : sup.entries;
    return list.filter((p) => p?.id && !optimisticallyResolved(p.id, entries));
  }
  function renderPendingBar() {
    const wrap = $("#pending-wrap"), bar = $("#pending-bar"), listEl = $("#pending-list");
    if (!wrap || !bar || !listEl) return;
    const list = activePending();
    if (list.length < 2) pendingOpen = false;
    if (!list.length) {
      wrap.hidden = true;
      wrap.classList.remove("open");
      listEl.hidden = true;
      pendingBarSig = pendingListSig = "";
      return;
    }
    wrap.hidden = false;
    wrap.classList.toggle("open", pendingOpen);
    const latest = list[list.length - 1];
    const barSig = `${list.length}:${latest.id}:${latest.summary}`;
    if (barSig !== pendingBarSig) {
      pendingBarSig = barSig;
      if (list.length === 1) {
        bar.innerHTML = `<button type="button" class="pending-main" data-goto-pending="${esc(latest.id)}" title="${esc(latest.summary)}">
            <span class="pending-dot"></span><span class="pending-label">待你确认</span><span class="pending-sep">·</span><span class="pending-sum">${esc(latest.summary)}</span>
          </button><button type="button" class="pending-x" data-dismiss="${esc(latest.id)}" title="忽略" aria-label="忽略">${ICON_X}</button>`;
      } else {
        bar.innerHTML = `<button type="button" class="pending-main" data-toggle-pending aria-expanded="${pendingOpen}" title="${esc(latest.summary)}">
            <span class="pending-dot"></span><span class="pending-label">待你确认 (${list.length})</span><span class="pending-sep">·</span><span class="pending-sum">${esc(latest.summary)}</span>
            <svg class="pending-chev" viewBox="0 0 24 24"><path d="M7 14l5-5 5 5"/></svg>
          </button>`;
      }
    } else {
      bar.querySelector("[data-toggle-pending]")?.setAttribute("aria-expanded", String(pendingOpen));
    }
    if (list.length >= 2 && pendingOpen) {
      const listSig = JSON.stringify(list.map((p) => [p.id, p.summary, p.at]));
      if (listSig !== pendingListSig) {
        pendingListSig = listSig;
        const items = [...list].reverse();
        listEl.innerHTML = items.map((p) => `<div class="pending-item">
          <button type="button" class="pending-jump" data-goto-pending="${esc(p.id)}" title="${esc(p.summary)}">
            <span class="pending-dot"></span><span class="pending-sum">${esc(p.summary)}</span><span class="pending-time">${esc(sepTime(p.at))}</span>
          </button><button type="button" class="pending-x" data-dismiss="${esc(p.id)}" title="忽略" aria-label="忽略">${ICON_X}</button>
        </div>`).join("");
      }
      listEl.hidden = false;
    } else {
      listEl.hidden = true;
      pendingListSig = "";
    }
  }
  async function dismissPending(id) {
    if (!id || dismissedLocal.has(id)) return;
    dismissedLocal.add(id);
    if (replyTo?.entry === id) setReply(null);
    renderSide();
    if (view === "collie") renderSuper();
    try {
      await api("/api/super/dismiss", { body: { id } });
    } catch (err) {
      dismissedLocal.delete(id);
      renderSide();
      if (view === "collie") renderSuper();
      toast(err.message, "attn");
    }
  }

  // Older chat, loaded a page at a time when you ask: the hub only sends the
  // latest 200 lines. olderMore: whether there is more before that.
  let older = [], olderMore = null, olderBusy = false, superScrollRAF = 0;
  function chatEntries() {
    const have = new Set(sup.entries.map((e) => e.id));
    for (let i = pendingSays.length - 1; i >= 0; i--) if (pendingSays[i].id && have.has(pendingSays[i].id)) pendingSays.splice(i, 1);
    const old = older.length ? older.filter((e) => !have.has(e.id)) : [];
    return old.length || pendingSays.length ? [...old, ...sup.entries, ...pendingSays] : sup.entries;
  }
  // More before what is shown? Until asked, guess from a full page.
  const canLoadOlder = () => olderMore ?? !!sup.earlier;
  async function loadOlder(keepPos = true) {
    const first = chatEntries().find((e) => e.id);
    if (olderBusy || !first) return false;
    olderBusy = true;
    renderSuper();
    const scroller = $("#super-thread").parentElement, fromBottom = scroller.scrollHeight - scroller.scrollTop;
    let added = false;
    try {
      const r = await api(`/api/super/earlier?before=${encodeURIComponent(first.id)}`);
      const batch = r.entries || [];
      if (batch.length) {
        for (const be of batch) { if (be.id) seenSuperIds.add(be.id); }
        older = [...batch, ...older];
        added = true;
      }
      olderMore = batch.length ? !!r.more : false;
    } catch (e) { olderMore = false; toast(e.message, "attn"); }
    olderBusy = false;
    renderSuper();
    if (keepPos) {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(superScrollRAF);
      scroller.scrollTop = scroller.scrollHeight - fromBottom; // stay where you were reading
    }
    return added;
  }
  async function jumpToEntry(id) {
    if (!id) return;
    const seq = ++jumpSeq;
    pendingOpen = false;
    renderPendingBar();
    const sel = `#v-collie .msg[data-id="${CSS.escape(id)}"]`;
    let m = document.querySelector(sel);
    let guards = 0;
    while (!m && canLoadOlder() && guards++ < 25) {
      while (olderBusy) await new Promise((r) => setTimeout(r, 35));
      if (seq !== jumpSeq) return;
      m = document.querySelector(sel);
      if (m) break;
      const ok = await loadOlder(false);
      if (seq !== jumpSeq) return;
      m = document.querySelector(sel);
      if (!ok) break;
    }
    if (!m) { toast("这条消息太早了，已经不在这里"); return; }
    const foldedProc = m.closest?.("details.collie-proc");
    if (foldedProc && !foldedProc.open) {
      foldedProc.open = true;
      if (foldedProc.dataset?.procId) openSuperProcs.add(foldedProc.dataset.procId);
    }
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(superScrollRAF);
    const sc = $("#super-thread").parentElement;
    const sr = sc.getBoundingClientRect(), mr = m.getBoundingClientRect();
    const want = Math.max(0, Math.min(sc.scrollHeight - sc.clientHeight, sc.scrollTop + (mr.top - sr.top) - Math.max(24, (sc.clientHeight - mr.height) / 2)));
    const dist = want - sc.scrollTop;
    if (Math.abs(dist) > sc.clientHeight * 2.2) {
      sc.scrollTop = want - Math.sign(dist) * sc.clientHeight * 0.9;
    }
    flashEntry = { id, until: Date.now() + 1650 };
    m.classList.remove("flash");
    void m.offsetWidth;
    m.classList.add("flash");
    if (typeof sc.scrollTo === "function") sc.scrollTo({ top: want, behavior: "smooth" });
    else sc.scrollTop = want;
    setTimeout(() => {
      if (flashEntry.id === id && Date.now() >= flashEntry.until) {
        document.querySelector(sel)?.classList.remove("flash");
      }
    }, 1700);
  }
  let superPrimed = false;
  const seenSuperIds = new Set();
  const openSuperProcs = new Set();
  let superStream = null; // { id, full, pos, timer }

  function stepSuperStream() {
    if (!superStream) return;
    const step = Math.max(10, Math.ceil(superStream.full.length / 22));
    let next = Math.min(superStream.full.length, superStream.pos + step);
    // Avoid splitting UTF-16 surrogate pairs
    if (next < superStream.full.length) {
      const code = superStream.full.charCodeAt(next - 1);
      if (code >= 0xD800 && code <= 0xDBFF) next++;
    }
    superStream.pos = next;
    if (superStream.pos >= superStream.full.length) {
      clearInterval(superStream.timer);
      superStream = null;
    }
    if (view === "collie") renderSuper();
  }

  function renderSuper(force) {
    const r = sup.router || {};
    if (!superPrimed && sup.entries.length) {
      for (const e of sup.entries) { if (e.id) seenSuperIds.add(e.id); }
      superPrimed = true;
    } else if (superPrimed && sup.entries.length) {
      let newestCollie = null;
      for (const e of sup.entries) {
        if (e.id && !seenSuperIds.has(e.id)) {
          seenSuperIds.add(e.id);
          if (e.role === "collie") newestCollie = e;
        }
      }
      if (newestCollie && view === "collie" && (newestCollie.text || "").length > 16 && typeof window.requestAnimationFrame === "function") {
        if (superStream?.timer) clearInterval(superStream.timer);
        superStream = {
          id: newestCollie.id,
          full: newestCollie.text,
          pos: Math.min(newestCollie.text.length, 12),
          timer: setInterval(stepSuperStream, 28),
        };
      }
    }
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
    syncComposerBtn($("#super-composer"));
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
    const crewHTML = active.length ? `<span class="crew-label">执行中</span>` + active.map((w) => {
      const pane = paneOf(w.name);
      const wWhere = multiM && w.machine ? `<span class="wm">@${esc(machineName(w.machine))}</span>` : "";
      const tip = [STATUS_LABEL[workerStatus(w)] || workerStatus(w), w.task || ""].filter(Boolean).join(" · ");
      return `<span class="chip-wrap"><a class="chip" ${pane ? `href="#/p/${encodeURIComponent(pane)}"` : ""} title="${esc(tip)}"><span class="dot ${esc(workerStatus(w))}"></span>${esc(w.name)}${wWhere}<span class="k">${esc(KIND_LABEL[w.kind] || w.kind)}</span></a><button type="button" class="chip-stop" data-stop-worker="${esc(w.name)}" title="停止 ${esc(w.name)}">×</button></span>`;
    }).join("") : "";
    const crewChanged = crewHTML !== prevCrewSig;
    prevCrewSig = crewHTML;
    $("#crew").innerHTML = crewHTML;

    const box = $("#super-thread");
    const scroller = box.parentElement;
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    let html = "", prevRole = "";
    if (!sup.entries.length && !pendingSays.length) {
      html = `<div class="hello"><img src="icon.svg" alt="">
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
      const allEntries = chatEntries();
      const pendIds = new Set(activePending().map((p) => p.id));
      const entryPending = (idx, id) => {
        if (!id) return false;
        if (sup.hasPending) return pendIds.has(id);
        if (dismissedLocal.has(id)) return false;
        let otherCollie = false;
        for (let j = idx + 1; j < allEntries.length; j++) {
          const next = allEntries[j];
          if (next.role === "user") {
            const reId = next.re?.entry || "";
            if (reId === id || (!reId && !otherCollie)) return false;
          } else if (next.role === "collie") {
            otherCollie = true;
          }
        }
        return true;
      };
      const replyOpts = (e, idx) => {
        const opts = Array.isArray(e.options) ? e.options.filter((o) => typeof o === "string" && o.trim()) : [];
        if (opts.length) {
          if (!entryPending(idx, e.id)) return "";
          return `<div class="reply-opts" data-entry="${esc(e.id)}">${opts.map((o) =>
            `<button type="button" class="reply-opt" data-opt="${esc(o)}">${esc(o)}</button>`).join("")}</div>`;
        }
        if (e.check && entryPending(idx, e.id)) {
          return `<div class="reply-opts reply-check" data-entry="${esc(e.id)}"><button type="button" class="reply-ack" data-ack="${esc(e.id)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>已看</button></div>`;
        }
        return "";
      };
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
      const routerWorkingNow = !r.replied && (r.status === "working" || r.status === "starting" || r.status === "dreaming" || pendingSays.length > 0);
      // Sync user-expanded collie-proc drawers currently in DOM before rebuilding
      if (box.querySelectorAll) {
        for (const d of box.querySelectorAll("details.collie-proc")) {
          const pid = d.dataset?.procId;
          if (!pid) continue;
          if (d.open) openSuperProcs.add(pid);
          else openSuperProcs.delete(pid);
        }
      }

      // Filter visible entries with their original index in allEntries
      const visible = [];
      for (let ei = 0; ei < allEntries.length; ei++) {
        const e = allEntries[ei];
        if (e.ref === ROUTER && e.tone === "info" && e.role !== "user" && e.role !== "collie") continue;
        if (e.role === "event" && workerChatter(e)) continue;
        visible.push({ e, ei });
      }

      const renderCollieSay = (e, ei, cont, inDrawer = false) => {
        const at = +new Date(e.at) || 0;
        const isStreamingThis = Boolean(superStream && superStream.id === e.id && superStream.pos < superStream.full.length);
        const shownText = isStreamingThis ? superStream.full.slice(0, superStream.pos) : e.text;
        const rendered = md(shownText);
        const tailExtras = isStreamingThis ? "" : `${imagesIn(e.text)}${artifactsIn(e.text, rendered)}${replyOpts(e, ei)}${msgActs(e, at)}`;
        const resHTML = `<div class="say${cont ? " cont" : ""}${inDrawer ? " in-proc" : ""}"><span class="avatar">${cont ? "" : `<img src="icon.svg" alt="">`}</span><div class="msg assistant${isStreamingThis ? " streaming" : ""}" data-id="${esc(e.id)}"${at ? ` title="${esc(fullTime(at))}"` : ""}>${quote(e)}${rendered}${tailExtras}</div></div>`;
        sinceUser++; lastEvent = ""; lastCollie = e.id; sinceCollie = 0;
        return resHTML;
      };

      const renderEventItem = (e) => {
        lastEvent = e.ref || "";
        const hid = e.ref?.startsWith("h:") ? e.ref.slice(2)
          : (!e.ref && (e.text?.includes("换了一个新会话") || (e.text?.includes("睡一会儿") && e.text?.includes("做梦"))) ? routerHist(e.at)?.id : "");
        const xid = !hid && e.ref?.startsWith("x:") ? e.ref.slice(2) : "";
        const pid = !hid && !xid && e.ref?.startsWith("p:") ? e.ref.slice(2) : "";
        const past = !hid && !xid && !pid && e.ref && e.ref !== ROUTER ? workerHist(e.ref, e.at) : null;
        const pane = !hid && !xid && !pid && !past && e.ref ? paneOf(e.ref) : null;
        const href = hid ? `#/h/${encodeURIComponent(hid)}`
          : xid ? `#/x/${encodeURIComponent(xid)}`
          : pid ? `#/p/${encodeURIComponent(pid)}`
          : past ? `#/h/${encodeURIComponent(past.id)}`
          : pane ? `#/p/${encodeURIComponent(pane)}` : "";
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
          return `<div class="event ${toneCls}${isLong ? " expandable" : ""}${isExp ? " expanded" : ""}" ${isLong && e.id ? `data-ev-id="${esc(e.id)}"` : ""}><span class="dot ${tone}"></span><span class="when">${hhmm(e.at)}</span><span class="ev-badge">${badge}</span><span class="ev-text">${esc(e.text)}</span>${tail}</div>`;
        }
        const openLbl = hid ? (e.text?.includes("做梦") ? "做梦前对话 →" : "交接前对话 →") : "查看 →";
        const tail = `<span class="ev-tail">${wState ? `<span>${wState}</span>` : ""}<span class="ev-open">${openLbl}</span></span>`;
        return `<a href="${href}" class="event ${toneCls}"><span class="dot ${tone}"></span><span class="when">${hhmm(e.at)}</span><span class="ev-badge">${badge}</span><span class="ev-text">${esc(e.text)}</span>${tail}</a>`;
      };

      const maybeTimeSep = (e) => {
        const at = +new Date(e.at) || 0;
        const talk = e.role === "user" || e.role === "collie";
        const newDay = at && lastAt && new Date(at).toDateString() !== new Date(lastAt).toDateString();
        let sep = "";
        if (at && (newDay || (talk && (!lastAt || at - lastAt > 10 * 60e3)))) {
          sep = `<div class="time-sep">${esc(sepTime(at))}</div>`;
          prev = "";
          lastQuoted = "";
        }
        if (at) lastAt = at;
        return sep;
      };

      // Fold ONLY explicit `--interim` progress updates and worker/dispatch events above the
      // formal (`!e.interim`) Collie conclusion they led up to. NEVER fold any non-interim
      // Collie message (main answer, supplementary follow-up, or option/check prompt) or
      // session/dream lifecycle milestones!
      const isStuckBlkEvent = (e) => e.role === "event" && e.ref && sup.workers.some((x) => x.name === e.ref && !x.ended && x.status === "blocked");
      const isLifecycleDivider = (e) => e.role === "event" && (
        Boolean(e.ref?.startsWith("h:"))
        || /换了一个新会话|睡一会儿.*做梦|Collie 醒了|整理记忆没/.test(e.text || "")
        || isStuckBlkEvent(e)
      );
      const isFormalCollie = (e) => e.role === "collie" && !e.interim;
      const isCleanupStopEvent = (e) => e.role === "event" && e.tone === "info" && /(?:已停止|已退出)$/.test(String(e.text || "").trim());

      const emitRawItem = ({ e, ei }) => {
        html += maybeTimeSep(e);
        const cont = e.role === "collie" && prev === "collie";
        prev = prevRole = e.role;
        html += e.role === "collie" ? renderCollieSay(e, ei, cont) : renderEventItem(e);
      };

      const emitProcDrawer = (procItems, anchorItem) => {
        if (!procItems.length) return;
        if (!prefs.fold()) {
          for (const it of procItems) emitRawItem(it);
          return;
        }
        if (anchorItem) html += maybeTimeSep(anchorItem.e);
        else html += maybeTimeSep(procItems[0].e);
        const procKey = "sp-" + (procItems[0].e.id || anchorItem?.e?.id || procItems[0].ei);
        const interimN = procItems.filter((x) => x.e.role === "collie").length;
        const evList = procItems.filter((x) => x.e.role === "event").map((x) => x.e);
        const errN = evList.filter((e) => e.tone === "error").length;
        const workerNames = [...new Set(evList.map((e) => {
          const rName = e.ref || "";
          if (!rName || rName === ROUTER || rName.startsWith("h:")) return "";
          if (rName.startsWith("x:") || rName.startsWith("p:")) {
            const tm = (e.text || "").match(/「([^」]{1,28})」/);
            return tm ? tm[1] : "";
          }
          return rName;
        }).filter(Boolean))].slice(0, 3);
        const sumParts = [];
        if (interimN) sumParts.push(`${interimN} 条中间进展`);
        if (evList.length) sumParts.push(`${evList.length} 条调度轨迹${workerNames.length ? "（" + workerNames.join("、") + "）" : ""}`);
        let procInner = "", procPrev = "";
        for (const { e, ei } of procItems) {
          const cont = e.role === "collie" && procPrev === "collie";
          procPrev = e.role;
          procInner += e.role === "collie" ? renderCollieSay(e, ei, cont, true) : renderEventItem(e);
        }
        html += `<details class="turn-proc collie-proc" data-proc-id="${esc(procKey)}" ${openSuperProcs.has(procKey) ? "open" : ""}>`
          + `<summary><svg class="tp-chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg><span class="tp-title">调度与执行过程</span>`
          + `<span class="tp-sub">${esc(sumParts.join(" · "))}${errN ? ` · <b class="errs">${errN} 次异常</b>` : ""}</span>`
          + `</summary><div class="turn-proc-body collie-proc-body">${procInner}</div></details>`;
        prev = "event";
      };

      const flushUnanchoredProc = (procBuf, isLiveTail) => {
        if (!procBuf.length) return;
        if (isLiveTail || !prefs.fold()) {
          for (const it of procBuf) emitRawItem(it);
          procBuf.length = 0;
          return;
        }
        // Historical unanchored span (e.g. context handover warning or interrupted turn before a
        // formal answer arrived): fold pure events, but never hide any Collie text that had no
        // formal conclusion after it!
        const hasCollieText = procBuf.some((x) => x.e.role === "collie");
        if (!hasCollieText) {
          emitProcDrawer(procBuf, null);
        } else {
          let evBuf = [];
          for (const it of procBuf) {
            if (it.e.role === "event") {
              evBuf.push(it);
            } else {
              if (evBuf.length) { emitProcDrawer(evBuf, it); evBuf = []; }
              emitRawItem(it);
            }
          }
          if (evBuf.length) emitProcDrawer(evBuf, null);
        }
        procBuf.length = 0;
      };

      const procBuf = [];
      let vi = 0;
      while (vi < visible.length) {
        const cur = visible[vi];
        const { e } = cur;
        if (e.role === "user") {
          flushUnanchoredProc(procBuf, false);
          html += maybeTimeSep(e);
          const at = +new Date(e.at) || 0;
          prev = prevRole = "user";
          html += `<div class="mine"><div class="msg user" data-id="${esc(e.id)}"${at ? ` title="${esc(fullTime(at))}"` : ""}>${quote(e)}${userText(e.text, "s:" + (e.id || vi))}</div>${mineActs(e, at)}</div>`;
          lastUser = e.id; sinceUser = 0; lastEvent = ""; sinceCollie++; lastQuoted = "";
          vi++;
          continue;
        }
        if (isLifecycleDivider(e)) {
          flushUnanchoredProc(procBuf, false);
          emitRawItem(cur);
          vi++;
          continue;
        }
        if (isFormalCollie(e)) {
          // Collect this formal conclusion plus any consecutive formal supplements (e.g. a postscript
          // sent right after stopping the worker) and absorb immediate worker-stop cleanup events
          // into the process drawer above the conclusion!
          const formalItems = [cur];
          const cleanupEvents = [];
          const baseAt = +new Date(e.at) || 0;
          let look = vi + 1;
          while (look < visible.length) {
            const nxt = visible[look];
            const nxtAt = +new Date(nxt.e.at) || 0;
            const closeInTime = !baseAt || !nxtAt || (nxtAt - baseAt) <= 5 * 60e3;
            if (isFormalCollie(nxt.e) && closeInTime) {
              formalItems.push(nxt);
              look++;
              continue;
            }
            if (isCleanupStopEvent(nxt.e) && closeInTime) {
              cleanupEvents.push(nxt);
              look++;
              continue;
            }
            break;
          }
          const combinedProc = procBuf.concat(cleanupEvents);
          procBuf.length = 0;
          if (combinedProc.length) {
            emitProcDrawer(combinedProc, formalItems[0]);
          }
          for (const fm of formalItems) {
            emitRawItem(fm);
          }
          vi = look;
          continue;
        }
        // Foldable process item (`e.interim` Collie ack or worker/dispatch `event`)
        procBuf.push(cur);
        vi++;
      }
      // Any trailing process items after the last formal conclusion are still in flight: keep visible!
      flushUnanchoredProc(procBuf, true);
      if (routerWorkingNow) {
        const stepTxt = (r.activity || "").trim();
        const liveLabel = r.status === "starting"
          ? "正在唤醒 Collie…"
          : r.status === "dreaming"
            ? "Collie 正在整理记忆，完成后自动醒来…"
            : (stepTxt || "Collie 正在思考与编排…");
        const dotSt = collieDot(r.status === "idle" && pendingSays.length ? "working" : r.status);
        html += `<div class="collie-live"><span class="avatar"><img src="icon.svg" alt=""></span><div class="collie-live-pill"><span class="dot ${esc(dotSt)}"></span><span>${esc(liveLabel)}</span></div></div>`;
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
    renderPendingBar();
    if (olderBusy) html = `<div class="earlier-row">加载中…</div>` + html;
    if (html !== superSig || force) {
      superSig = html;
      box.innerHTML = html;
      if (flashEntry.until > Date.now() && flashEntry.id) {
        box.querySelector(`.msg[data-id="${CSS.escape(flashEntry.id)}"]`)?.classList.add("flash");
      }
    } else if (!crewChanged) {
      return;
    }
    const jumping = flashEntry.until > Date.now();
    const restoring = pendingScrollRestore && pendingScrollRestore.key === "collie" && pendingScrollRestore.until > Date.now();
    if (restoring) {
      scroller.scrollTop = pendingScrollRestore.top;
      pendingScrollRestore = null;
    } else if ((atBottom && !jumping) || force) {
      scroller.scrollTop = scroller.scrollHeight;
      const set = scroller.scrollTop;
      if (typeof requestAnimationFrame === "function") {
        if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(superScrollRAF);
        superScrollRAF = requestAnimationFrame(() => {
          if (scroller.scrollTop === set && scroller.scrollHeight > scroller.clientHeight) {
            scroller.scrollTop = scroller.scrollHeight;
          }
          syncJumpBtn(scroller, $("#super-jump"));
        });
      }
    }
    syncJumpBtn(scroller, $("#super-jump"));
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
    if (idea) { $("#super-input").value = idea; grow($("#super-input")); syncComposerBtn($("#super-composer")); $("#super-input").focus(); return; }
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
      if (c.keys?.length) send("keys", { keys: c.keys }); else if (c.text) send("text", { text: c.text }); else send("keys", { keys: ["enter"] });
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
  // Clear any legacy sticky dispatchTarget from earlier versions: Collie's
  // composer now defaults to automatic routing ("自动派活"), and manual choices
  // apply only to the single outgoing message before resetting back to Auto.
  store.set("dispatchTarget", null);
  let overrideOpen = false, target = null, targetDefault = null;
  let chipSeq = 0;

  function resolveSuperUploadMachine(draftText = "") {
    if (overrideOpen && target?.machine) {
      return target.machine === "local" ? "" : target.machine;
    }
    const low = String(draftText || "").trim().toLowerCase();
    if (low) {
      const hit = (state.projects || []).find((p) => {
        const nm = String(p.name || "").trim();
        if (!nm || nm === "主目录" || nm.length < 2) return false;
        if (!low.includes(nm.toLowerCase())) return false;
        const mObj = (state.machines || []).find((m) => m.id === (p.machine || ""));
        return !p.machine || mObj?.online;
      });
      if (hit) return hit.machine || "";
    }
    return sup.router?.machine || targetDefault?.machine || preferredWorkMachine("") || "";
  }

  async function renderTarget(fresh) {
    if (!targetDefault || fresh) {
      try {
        const s = (await api("/api/super/settings")).settings;
        targetDefault = { machine: s.worker_machine || "", kind: s.worker_kind === "antigravity" ? "agy" : s.worker_kind || "claude", model: s.worker_model || "", effort: s.worker_effort || "" };
      } catch { targetDefault ||= { machine: "", kind: "claude", model: "", effort: "" }; }
    }
    const autoPill = $("#t-auto-pill"), labelEl = $("#cbar-label"), resetBtn = $("#t-reset");
    const mSel = $("#t-machine"), kSel = $("#t-kind"), modSel = $("#t-model"), effSel = $("#t-effort");
    if (!mSel || !kSel || !modSel || !effSel) return;

    if (!overrideOpen) {
      if (autoPill) autoPill.hidden = false;
      if (labelEl) labelEl.hidden = true;
      if (resetBtn) resetBtn.hidden = true;
      for (const s of [mSel, kSel, modSel, effSel]) { s.hidden = true; syncPick(s); }
      return;
    }

    if (autoPill) autoPill.hidden = true;
    if (labelEl) labelEl.hidden = false;
    if (resetBtn) resetBtn.hidden = false;

    const cur = target || { machine: "", kind: "", model: "", effort: "" };
    let ms = runnableMachines(cur.machine === "local" ? "" : cur.machine);
    if (!ms.length) ms = state.machines || [{ id: "", name: "本机", local: true }];

    const fill = (sel, html) => { if (sel._html !== html) { sel._html = html; sel.innerHTML = html; } };
    const mVal = cur.machine || "";
    let mHtml = `<option value="" data-short="自动电脑" data-sub="按涉及的项目或当前在线电脑自动判断" ${mVal === "" ? "selected" : ""}>自动选择电脑</option>`;
    mHtml += ms.map((m) => {
      const val = m.local ? "local" : m.id;
      const sub = [m.local ? "hub" : m.os || "", m.id === targetDefault.machine ? "默认偏好" : ""].filter(Boolean).join(" · ");
      return `<option value="${esc(val)}" data-os="${osKey(m.os)}" data-short="${esc(m.name)}" data-sub="${esc(sub)}" ${val === mVal ? "selected" : ""}>${esc(m.name)}</option>`;
    }).join("");
    fill(mSel, mHtml);
    mSel.value = mVal;
    mSel.hidden = false;
    syncPick(mSel);
    mSel._pick?.classList.toggle("changed", Boolean(mVal));

    const pickedMObj = mVal ? ms.find((m) => (m.local ? "local" : m.id) === mVal) : null;
    const have = pickedMObj?.agents;
    let kVal = cur.kind || "";
    if (kVal && Array.isArray(have) && have.length && !have.includes(kVal)) {
      kVal = "";
      cur.kind = "";
      cur.model = "";
      cur.effort = "";
    }
    let kHtml = `<option value="" data-short="自动 Agent" data-sub="按项目配置或默认偏好自动选择" ${kVal === "" ? "selected" : ""}>自动选择 Agent</option>`;
    kHtml += [["codex", "Codex"], ["claude", "Claude"], ["agy", "Antigravity"], ["gemini", "Gemini"]].map(([k, l]) => {
      const missing = Array.isArray(have) && !have.includes(k);
      const sub = [missing ? "该电脑未安装" : "", k === targetDefault.kind ? "默认偏好" : ""].filter(Boolean).join(" · ");
      return `<option value="${k}" data-glyph="${k}" data-short="${KIND_LABEL[k]}" ${sub ? `data-sub="${esc(sub)}"` : ""} ${missing ? "disabled" : ""} ${k === kVal ? "selected" : ""}>${l}</option>`;
    }).join("");
    fill(kSel, kHtml);
    kSel.value = kVal;
    kSel.hidden = false;
    syncPick(kSel);
    kSel._pick?.classList.toggle("changed", Boolean(kVal));

    renderModelChips(cur);
  }

  async function renderModelChips(resolvedT) {
    const seq = ++chipSeq;
    const modSel = $("#t-model"), effSel = $("#t-effort");
    if (!modSel || !effSel) return;
    const t = resolvedT || target || { machine: "", kind: "", model: "", effort: "" };
    if (!overrideOpen || !t.kind) {
      modSel.hidden = true; effSel.hidden = true;
      syncPick(modSel); syncPick(effSel);
      return;
    }
    const queryM = t.machine === "local" ? "" : (t.machine || targetDefault?.machine || preferredWorkMachine("") || "");
    const info = await modelsFor(t.kind, queryM).catch(() => ({ models: [], efforts: [] }));
    if (seq !== chipSeq || !overrideOpen || !target?.kind) return;
    const list = [...(info.models || [])];
    const model = t.model || "";
    const effort = t.effort || "";
    if (model && !list.some((m) => m.id === model)) list.unshift({ id: model });
    const short = (id) => id.split("/").pop();
    const defShort = info.default ? short(info.default) : "默认模型";
    let html = `<option value="" data-short="${esc(defShort)}" data-sub="${esc(info.default ? "默认（" + info.default + "）" : "使用默认模型")}" ${!model ? "selected" : ""}>默认${info.default ? "（" + esc(short(info.default)) + "）" : ""}</option>`;
    html += list.map((m) => `<option value="${esc(m.id)}" data-short="${esc(m.label && m.label.length <= 24 ? m.label : short(m.id))}" data-sub="${esc(m.label && m.label !== m.id ? m.id : "")}" ${m.id === model ? "selected" : ""}>${esc(m.label || m.id)}</option>`).join("");
    if (modSel._html !== html) { modSel._html = html; modSel.innerHTML = html; }
    modSel.value = model;
    modSel.hidden = false;

    const cur = list.find((m) => m.id === model);
    const effs = cur?.efforts?.length ? cur.efforts : (info.efforts || []);
    const eff = effs.includes(effort) ? effort : "";
    const defE = info.default_effort || "";
    let ehtml = `<option value="" data-short="思考 · ${esc(EFFORT_LABEL[defE] || defE || "默认")}" data-sub="默认思考强度" ${!eff ? "selected" : ""}>默认${defE ? "（" + esc(EFFORT_LABEL[defE] || defE) + "）" : ""}</option>`;
    ehtml += effs.map((e) => `<option value="${esc(e)}" data-short="思考 · ${esc(EFFORT_LABEL[e] || e)}" data-sub="${esc(e)}" ${e === eff ? "selected" : ""}>${esc(EFFORT_LABEL[e] || e)}</option>`).join("");
    if (effSel._html !== ehtml) { effSel._html = ehtml; effSel.innerHTML = ehtml; }
    effSel.value = eff;
    effSel.hidden = effs.length === 0;

    syncPick(modSel); syncPick(effSel);
    modSel._pick?.classList.toggle("changed", Boolean(model));
    effSel._pick?.classList.toggle("changed", Boolean(eff));
  }

  const pick = (o) => { target = { ...(target || { machine: "", kind: "", model: "", effort: "" }), ...o }; };
  $("#t-auto-pill")?.addEventListener("click", (e) => {
    e.preventDefault();
    overrideOpen = true;
    target = { machine: "", kind: "", model: "", effort: "" };
    renderTarget().then(() => {
      const mSel = $("#t-machine");
      if (mSel && !mSel.hidden) openPick(mSel);
    });
  });
  $("#t-machine").addEventListener("change", (e) => {
    pick({ machine: e.target.value });
    renderTarget();
  });
  $("#t-kind").addEventListener("change", (e) => {
    const k = e.target.value;
    const m = (target?.machine === "local" ? "" : target?.machine) || "";
    const mem = k ? getSavedModel(k, m) : null;
    pick({ kind: k, model: mem?.model || "", effort: mem?.effort || "" });
    renderTarget();
  });
  $("#t-model").addEventListener("change", (e) => {
    const m = e.target.value;
    if (target?.kind) {
      const mach = target.machine === "local" ? "" : (target.machine || "");
      saveLastModel(target.kind, mach, m, target.effort || "");
    }
    pick({ model: m });
    renderModelChips(target);
  });
  $("#t-effort").addEventListener("change", (e) => {
    const ef = e.target.value;
    if (target?.kind) {
      const mach = target.machine === "local" ? "" : (target.machine || "");
      saveLastModel(target.kind, mach, target.model || "", ef);
    }
    pick({ effort: ef });
    renderModelChips(target);
  });
  $("#t-reset")?.addEventListener("click", () => {
    overrideOpen = false;
    target = null;
    renderTarget();
  });

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
    const e = chatEntries().find((x) => x.id === b.dataset.re);
    if (e) setReply(e);
  });

  async function sendSuper(text, re, restoreRe) {
    const ov = overrideOpen && target ? { ...target } : null;
    const sendMachine = ov?.machine || "";
    const sendKind = ov?.kind || "";
    const sendModel = sendKind ? (ov?.model || "") : "";
    const sendEffort = sendKind ? (ov?.effort || "") : "";
    const hasOverride = Boolean(sendMachine || sendKind || sendModel || sendEffort);
    // Your message shows at once; the hub's copy takes its place when it arrives.
    const mine = { id: "", role: "user", text, at: new Date().toISOString(), pending: true, re };
    pendingSays.push(mine);
    renderSide();
    renderSuper(true);
    let r;
    try {
      r = await api("/api/super/say", { body: {
        text,
        re: re?.entry || "",
        machine: sendMachine,
        kind: sendKind,
        model: sendModel,
        effort: sendEffort,
        override: hasOverride,
      } });
    } catch (err) {
      const idx = pendingSays.indexOf(mine);
      if (idx >= 0) pendingSays.splice(idx, 1);
      if (restoreRe && re && !replyTo) setReply(chatEntries().find((x) => x.id === re.entry));
      renderSide();
      renderSuper(true);
      throw err;
    }
    // Single-use override: reset back to automatic dispatch right after sending!
    if (overrideOpen) {
      overrideOpen = false;
      target = null;
      renderTarget();
    }
    // The hub's copy may already be here (its push beat the reply): swap now.
    mine.id = r?.entry || "";
    if (!mine.id || sup.entries.some((e) => e.id === mine.id)) {
      const idx = pendingSays.indexOf(mine);
      if (idx >= 0) pendingSays.splice(idx, 1);
      renderSide();
      renderSuper(true);
    }
    if (!sup.router?.alive) toast("正在唤醒 Collie…");
  }

  $("#super-thread").addEventListener("click", async (ev) => {
    const ack = ev.target.closest(".reply-ack[data-ack]");
    if (ack) { ev.preventDefault(); dismissPending(ack.dataset.ack); return; }
    const b = ev.target.closest(".reply-opt[data-opt]");
    if (!b) return;
    const grp = b.closest(".reply-opts[data-entry]");
    if (!grp || grp.dataset.busy) return;
    grp.dataset.busy = "1";
    grp.querySelectorAll("button").forEach((x) => { x.disabled = true; });
    const id = grp.dataset.entry, text = b.dataset.opt;
    if (replyTo?.entry === id) setReply(null);
    const e = chatEntries().find((x) => x.id === id);
    try {
      await sendSuper(text, e ? { entry: e.id, who: "Collie", text: e.text } : { entry: id, who: "Collie", text: "" }, false);
    } catch (err) {
      toast(err.message, "attn");
    }
  });

  $("#pending-wrap")?.addEventListener("click", (ev) => {
    const dis = ev.target.closest("[data-dismiss]");
    if (dis) { ev.preventDefault(); ev.stopPropagation(); dismissPending(dis.dataset.dismiss); return; }
    if (ev.target.closest("[data-toggle-pending]")) { ev.preventDefault(); pendingOpen = !pendingOpen; renderPendingBar(); return; }
    const go = ev.target.closest("[data-goto-pending]");
    if (go) { ev.preventDefault(); jumpToEntry(go.dataset.gotoPending); }
  });
  document.addEventListener("click", (ev) => {
    const pw = $("#pending-wrap");
    if (pendingOpen && pw && !ev.target?.closest?.("#pending-wrap")) { pendingOpen = false; renderPendingBar(); }
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && pendingOpen) { pendingOpen = false; renderPendingBar(); }
  });

  bindComposer($("#super-composer"), $("#super-input"), async (text) => {
    const re = replyTo;
    setReply(null);
    await sendSuper(text, re, true);
  }, (draftText) => resolveSuperUploadMachine(draftText));

  // ───────────────────────────── panel views (执行轨迹 / 长期记忆 / 定时任务 / 外部触发 / 设置)
  let traceFilter = store.get("traceFilter", "all"); // "all" | "running" | "attn" | "done"
  let memTab = store.get("memTab", "active");       // "active" | "notes" | "skills" | "archive"
  if (!["active", "notes", "skills", "archive"].includes(memTab)) memTab = "active";
  let memArchOpen = store.get("memArchOpen", true);
  let memSelNote = "";
  let memSelSkill = "";
  let memCreatingNote = false;
  let memCreatingSkill = false;
  let memArchiveFilter = "";
  let memLastData = null;
  let settingsTab = store.get("settingsTab", "collie"); // "collie" | "local"
  const expandedTraceCards = new Set();
  let autoTimer;

  function memTabBadges(r) {
    if (!r) return {};
    const files = r.files || [];
    const upFront = typeof r.up_front === "number" ? r.up_front : (r.loaded || 0);
    const notesN = files.filter((f) => f.name.startsWith("notes/") && f.name !== "notes/index.md").length;
    const skillsN = (r.skills || []).length;
    const archN = (r.dreams?.length || 0) + files.filter((f) => f.name.startsWith("tasks/done/")).length;
    return {
      active: kb(upFront),
      notes: notesN ? String(notesN) : "",
      skills: skillsN ? String(skillsN) : "",
      archive: archN ? String(archN) : "",
    };
  }

  function renderPanelTabs(which = view, memData = memLastData) {
    const meta = PANEL_META[which];
    const tabsBar = $("#panel-tabs-bar"), tabsEl = $("#panel-tabs");
    if (!tabsBar || !tabsEl) return;
    if (meta?.tabs) {
      const cur = meta.cur();
      const badges = which === "memory" ? memTabBadges(memData) : {};
      tabsBar.hidden = false;
      tabsEl.innerHTML = meta.tabs().map(([k, l]) => {
        const b = badges[k] ? `<span class="tab-cnt">${esc(badges[k])}</span>` : "";
        return `<button type="button" data-tab="${k}" class="${k === cur ? "on" : ""}">${esc(l)}${b}</button>`;
      }).join("");
    } else {
      tabsBar.hidden = true;
      tabsEl.innerHTML = "";
    }
  }

  const PANEL_META = {
    trace: {
      name: "执行轨迹",
      sub: "还原每次派活从下发、跨机执行、回报到结束的完整任务流转链路",
      tabs: null,
    },
    memory: {
      name: "长期记忆",
      sub: "Hub 权威托管 · 跨电脑自动同步的长期指令、按需经验库、自建 Skill 与做梦记录",
      tabs: () => [["active", "核心预载"], ["notes", "经验笔记"], ["skills", "自建技能"], ["archive", "做梦与归档"]],
      cur: () => memTab,
      set: (t) => { memTab = t; store.set("memTab", t); memEditing = false; memCreatingNote = false; memCreatingSkill = false; },
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
    memCreatingNote = false;
    memCreatingSkill = false;
    const panelEl = $("#panel");
    if (panelEl) panelEl.dataset.panelView = which;
    const body = $("#panel-body");
    body._memSig = "";
    body._traceSig = "";
    body._timerSig = "";
    $("#panel-name").textContent = meta.name;
    $("#panel-sub").textContent = meta.sub;
    renderPanelTabs(which);
    clearInterval(autoTimer);
    loadPanel(which);
    if (which === "trace") autoTimer = setInterval(() => loadPanel("trace"), 3500);
    if (which === "memory") autoTimer = setInterval(() => {
      if (!memEditing && !memCreatingNote && !memCreatingSkill && !document.activeElement?.closest?.(".mem-arch-search")) {
        loadPanel("memory");
      }
    }, 5000);
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
        const sig = traceFilter + "|" + [...expandedTraceCards].join(",") + "|"
          + JSON.stringify(sup.workers.map((w) => [w.name, workerStatus(w), w.ended, w.last_report, w.report_at]))
          + "|" + triggers.slice(0, 40).map((t) => t.id + ":" + t.status).join(",");
        if (sig !== body._traceSig) {
          body._traceSig = sig;
          body.innerHTML = traceFlowHTML(triggers, threads);
        }
      } else if (which === "memory") {
        const r = await api("/api/super/memory");
        if (view !== "memory" || memEditing || memCreatingNote || memCreatingSkill) return;
        memLastData = r;
        renderPanelTabs("memory", r);
        const sig = [memTab, memArchOpen, memSelNote, memSelSkill, memArchiveFilter, JSON.stringify(r), sup.workers.map((w) => w.name + ":" + workerStatus(w)).join()].join("|");
        if (sig !== body._memSig) {
          const open = new Set([...body.querySelectorAll("details.mem-fold[open]")].map((d) => d.dataset.path || d.querySelector("summary")?.textContent));
          const first = !body._memSig;
          body._memSig = sig;
          body.innerHTML = memoryHTML(r, memTab);
          if (!first) body.querySelectorAll("details.mem-fold").forEach((d) => d.open = open.has(d.dataset.path || d.querySelector("summary")?.textContent));
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
    const skills = r.skills || [];
    const by = (f) => files.filter(f);
    const upFront = typeof r.up_front === "number" ? r.up_front : (r.loaded || 0);
    const msgSize = typeof r.messages_size === "number" ? r.messages_size : Math.max(0, (r.loaded || 0) - (upFront || 0));
    const budget = Math.max(1, r.budget || 10240);
    const over = upFront > budget;
    const bd = r.breakdown || {};
    const insB = bd.instructions ?? (files.find((f) => f.name === "instructions.md")?.size || 0);
    const idxB = bd.index ?? (files.find((f) => f.name === "notes/index.md")?.size || 0);
    const tskB = bd.tasks ?? files.filter((f) => /^tasks\/[^/]+\.md$/.test(f.name)).reduce((s, f) => s + (f.size || 0), 0);
    const segPct = (b) => Math.min(100, Math.max(b > 0 ? 1.5 : 0, (b / budget) * 100)).toFixed(1);

    const ins = by((f) => f.name === "instructions.md");
    const tasks = by((f) => /^tasks\/[^/]+\.md$/.test(f.name));
    const topicNotes = by((f) => f.name.startsWith("notes/") && f.name !== "notes/index.md").sort((a, b) => a.name.localeCompare(b.name));
    const indexFile = files.find((f) => f.name === "notes/index.md");
    const done = by((f) => f.name.startsWith("tasks/done/")).sort((a, b) => new Date(b.mod) - new Date(a.mod));
    const msgs = by((f) => f.name === "messages.md");
    const legacy = by((f) => f.legacy);
    const sharedSkillsN = skills.filter((s) => s.scope === "shared").length;
    const routerSkillsN = skills.length - sharedSkillsN;

    const dreamClock = r.dream_at && r.dream_at !== "off" ? `每日 ${r.dream_at}` : "自动计划已关闭";
    const dreamSub = r.dreaming
      ? `<b>正在回顾近期对话并整合记忆…</b> 整理完成后自动恢复，期间发来的消息会安全排队。`
      : `上次整理：<b>${r.last_dream ? dayTime(r.last_dream) : "尚未执行"}</b> · 下次计划：<b>${r.next_dream ? dayTime(r.next_dream) : dreamClock}</b>`;
    const firstLine = (t, dflt) => String(t || "").split("\n").filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/^[>*\-\s]+/, "").replace(/`|\*\*/g, "").trim()).find(Boolean) || dflt;
    const titleFromMd = (t, fallback) => {
      const h = String(t || "").split("\n").map((l) => l.trim()).find((l) => /^#+\s+/.test(l));
      return h ? h.replace(/^#+\s+/, "").trim() : fallback;
    };

    // Parse notes/index.md lines (`foo.md — summary` or `- foo.md: summary`) for quick descriptions
    const indexDescMap = new Map();
    if (indexFile?.text) {
      for (const raw of indexFile.text.split("\n")) {
        const m = /^\s*(?:[-*]\s*)?`?([a-zA-Z0-9._/-]+\.md)`?\s*(?:—|–|-|:|：)\s*(.+)$/.exec(raw.trim());
        if (m) {
          const k = m[1].startsWith("notes/") ? m[1] : "notes/" + m[1];
          indexDescMap.set(k, m[2].trim());
        }
      }
    }

    const crew = (f) => {
      const latest = new Map();
      for (const w of sup.workers) if (!latest.has(w.name) || new Date(w.created_at) > new Date(latest.get(w.name).created_at)) latest.set(w.name, w);
      const ws = [...latest.values()].filter((w) => new RegExp(`(^|[^\\w-])${w.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(f.text || ""));
      if (!ws.length) return "";
      return `<span class="mem-crew">${ws.map((w) => {
        const pane = !w.ended && paneOf(w.name), past = !pane && workerHist(w.name, w.created_at);
        const href = pane ? `#/p/${encodeURIComponent(pane)}` : past ? `#/h/${encodeURIComponent(past.id)}` : "";
        const st = workerStatus(w);
        return `<a ${href ? `href="${href}"` : ""} title="${esc((KIND_LABEL[w.kind] || w.kind) + " · " + (STATUS_LABEL[st] || st))}"><span class="dot ${esc(st)}"></span>${esc(w.name)}</a>`;
      }).join("")}</span>`;
    };
    const emptyIcon = '<svg viewBox="0 0 24 24"><path d="M5 4.5A2.5 2.5 0 0 1 7.5 2H19v18H7.5A2.5 2.5 0 0 0 5 22.5z"/><path d="M9 7h6M9 11h6"/></svg>';
    const skillIcon = '<svg viewBox="0 0 24 24"><path d="M12 2l2.4 5.2L20 9.6l-5.6 2.4L12 17.2 9.6 12 4 9.6l5.6-2.4z"/><path d="M19 15l1.1 2.4L22.5 18.5 20.1 19.6 19 22l-1.1-2.4-2.4-1.1 2.4-1.1z"/></svg>';

    const renderInstructionsMD = (fOrTxt) => {
      const txt = typeof fOrTxt === "string" ? fOrTxt : fOrTxt?.text;
      const lines = String(txt || "").split("\n").map((l) => l.trim()).filter((l) => l && !/^#/.test(l));
      if (!lines.length) return "";
      const items = lines.map((l) => {
        const stripped = l.replace(/^[-*]\s+/, "");
        const inferred = /^\(inferred\)\s*/i.test(stripped) || /（inferred）|\(inferred\)\s*$/i.test(stripped);
        const clean = stripped.replace(/^\(inferred\)\s*/i, "").replace(/\s*(?:（inferred）|\(inferred\))\s*$/i, "");
        const tag = inferred ? ` <span class="mem-infer-tag" title="做梦会话从多次对话习惯中自动归纳出的隐性偏好">做梦推断</span>` : "";
        const inlineHtml = md(clean)
          .replace(/^<p>([\s\S]*?)<\/p>\s*$/, "$1")
          .replace(/<code>notes\/([a-zA-Z0-9._-]+\.md)<\/code>/g, (_, fn) =>
            `<button type="button" class="mem-inline-note" data-mem-jump="notes" data-mem-note="notes/${esc(fn)}">notes/${esc(fn)}</button>`)
          .replace(/(^|>|[\s（(，、：:])notes\/([a-zA-Z0-9._-]+\.md)/g, (_, pre, fn) =>
            `${pre}<button type="button" class="mem-inline-note" data-mem-jump="notes" data-mem-note="notes/${esc(fn)}">notes/${esc(fn)}</button>`);
        return `<li>${inlineHtml}${tag}</li>`;
      }).join("");
      return `<ul class="mem-ins-list">${items}</ul>`;
    };

    const card = (f, o = {}) => {
      const edit = !f.legacy && o.edit !== false;
      const seedOnly = isDefaultSeedText(f.name, f.text);
      const summarySub = seedOnly ? (o.seedHint || "尚未写入内容") : (o.sub ?? firstLine(f.text, ""));
      const customBody = !seedOnly && o.customView ? o.customView(f) : "";
      const viewBody = seedOnly
        ? `<div class="mem-seed-empty"><span>${esc(o.seedDesc || "尚未填写内容。点击右侧按钮即可直接编辑保存。")}</span>${edit ? `<button type="button" class="btn small" data-act="mem-edit">立即填写</button>` : ""}</div>`
        : (customBody || md(f.text));
      const delBtn = o.deletable ? `<button type="button" class="btn small danger-ghost" data-act="mem-del" data-del-path="${esc(f.name)}">删除</button>` : "";
      return `<details class="mem-fold" ${o.open ? "open" : ""} data-path="${esc(f.name)}"><summary>
          <span class="mono mem-name">${esc(o.label || f.name)}</span><span class="grow">${esc(summarySub)}</span><span class="muted mono" style="font-size:11.5px">${kb(f.size)}</span></summary>
        <div class="mem-body msg assistant" data-view>${viewBody}</div>
        ${edit || o.deletable ? `<div class="mem-tools">${o.crew ? crew(f) : ""}<span class="muted grow">${esc(dayTime(f.mod))} 更新</span>${delBtn}${edit ? `<button type="button" class="btn small" data-act="mem-edit">编辑</button>` : ""}</div>` : ""}
        ${edit ? `<form class="mem-edit" hidden><textarea name="text" spellcheck="false">${esc(f.text)}</textarea>
          <div class="form-actions"><span class="muted grow">保存至 Hub 主本并自动同步到运行中的 Collie 节点。</span><button type="button" class="btn small" data-act="mem-cancel">取消</button><button class="btn primary small">保存修改</button></div></form>` : ""}
      </details>`;
    };

    // ── Top Overview Bento + Architectural Flowchart (shown ONLY on 核心预载 tab) ──
    const dreamTimeShort = r.dream_at && r.dream_at !== "off" ? r.dream_at : "手动";
    const overviewHTML = `<div class="mem-bento">
      <div class="mem-stat-card">
        <div class="mem-stat-top">
          <span class="mem-stat-label"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M7 15h4M7 10h10"/></svg>新会话启动预载预算</span>
          <span class="badge ${over ? "candidate" : "ok"}">${over ? "超出建议值 · 建议做梦精简" : "精简健康"}</span>
        </div>
        <div class="mem-meter-row">
          <span>${kb(upFront)} <small>/ 建议上限 ${kb(budget)}</small></span>
          <small class="mono" title="所有记忆与自建 Skill 均以 Hub 为权威主本">${esc(tilde(r.dir))}（Hub 主本）</small>
        </div>
        <div class="mem-meter seg ${over ? "warn" : ""}">
          <i class="seg-ins" style="width:${segPct(insB)}%" title="长期指令 ${kb(insB)}"></i>
          <i class="seg-idx" style="width:${segPct(idxB)}%" title="笔记目录索引 ${kb(idxB)}"></i>
          <i class="seg-tsk" style="width:${segPct(tskB)}%" title="在途任务 ${kb(tskB)}"></i>
        </div>
        <div class="mem-legend">
          <span><b class="lg-dot ins"></b>指令 ${kb(insB)}</span>
          <span><b class="lg-dot idx"></b>目录 ${kb(idxB)}</span>
          <span><b class="lg-dot tsk"></b>在途 ${kb(tskB)}</span>
          ${msgSize > 0 ? `<span class="lg-sep">·</span><span title="Hub 自动维护最近 10 条回复，独立于 10 KB 预算">另附最近回复 ${kb(msgSize)}</span>` : ""}
        </div>
      </div>
      <div class="mem-stat-card">
        <div class="mem-stat-top">
          <span class="mem-stat-label"><svg viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>夜间记忆整合（做梦）</span>
          <button type="button" class="btn small" data-act="dream-now" ${r.dreaming ? "disabled" : ""}>${r.dreaming ? "整理中…" : "立即整理记忆"}</button>
        </div>
        <div class="mem-stat-sub">${dreamSub}</div>
        <div class="mem-legend">
          <span>专题笔记 <b>${topicNotes.length}</b> 篇</span>
          <span class="lg-sep">·</span>
          <span>Hub 托管 Skill <b>${skills.length}</b> 个${skills.length ? `（共享 ${sharedSkillsN} / 中枢 ${routerSkillsN}）` : ""}</span>
          <span class="lg-sep">·</span>
          <span>已归档任务 <b>${done.length}</b> 项</span>
        </div>
      </div>
    </div>

    <details class="mem-arch-card" ${memArchOpen ? "open" : ""} data-mem-arch>
      <summary class="mem-arch-head">
        <span class="mem-arch-title">
          <svg viewBox="0 0 24 24"><circle cx="6" cy="6" r="2.2"/><circle cx="18" cy="12" r="2.2"/><circle cx="6" cy="18" r="2.2"/><path d="M8.2 6h4.3a3.5 3.5 0 0 1 3.5 3.5v.3M15.8 13.8v.7a3.5 3.5 0 0 1-3.5 3.5H8.2"/></svg>
          <b>记忆与 Skill 流转机制</b>
          <span class="muted">悬停节点看说明 · 点击中间模块可跳转</span>
        </span>
        <span class="mem-arch-cue">${memArchOpen ? "收起" : "展开"}</span>
      </summary>
      <div class="mem-arch-diagram">
        <svg class="mem-flow-svg" viewBox="0 0 940 228" role="img" aria-label="长期记忆与 Skill 流转图">
          <defs>
            <marker id="mf-arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
              <path class="mf-head" d="M1,1 L7,4 L1,7 z"/>
            </marker>
            <marker id="mf-arr-ok" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
              <path class="mf-head-ok" d="M1,1 L7,4 L1,7 z"/>
            </marker>
            <marker id="mf-arr-sig" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
              <path class="mf-head-sig" d="M1,1 L7,4 L1,7 z"/>
            </marker>
          </defs>

          <!-- Column Eyebrows -->
          <text class="mf-eyebrow" x="104" y="20" text-anchor="middle">写入来源</text>
          <text class="mf-eyebrow" x="472" y="20" text-anchor="middle">HUB 权威分层存储（${esc(tilde(r.dir))}）</text>
          <text class="mf-eyebrow" x="836" y="20" text-anchor="middle">会话加载端</text>

          <!-- Inbound Manifold Curves (3 -> Hub Junction -> 3 Tiers, zero crossings) -->
          <path class="mf-wire" d="M180,58 C206,58 206,120 224,120"/>
          <path class="mf-wire" d="M180,120 H224"/>
          <path class="mf-wire" d="M180,182 C206,182 206,120 224,120"/>
          <path class="mf-wire" d="M224,120 C242,120 244,68 265,68" marker-end="url(#mf-arr)"/>
          <path class="mf-wire" d="M224,120 C242,120 244,126 265,126" marker-end="url(#mf-arr)"/>
          <path class="mf-wire" d="M224,120 C242,120 244,182 265,182" marker-end="url(#mf-arr)"/>
          <circle class="mf-junc" cx="224" cy="120" r="3.5"/>

          <!-- Hub Soft Container -->
          <rect class="mf-hub-wrap" x="252" y="30" width="440" height="184" rx="15"/>

          <!-- Left Column: 3 Minimal Source Pills -->
          <g class="mf-node" data-mf-title="日常对话与派活（盘中实时写入）" data-mf-tip="并非所有记忆都等做梦才写：平时你说的新规矩当场写入 instructions.md；派发跨轮任务建立 tasks/*.md；子任务跑通的仓库路径与排障命令直接记入 notes/*.md 并更新目录。">
            <rect class="mf-card" x="28" y="36" width="152" height="44" rx="11"/>
            <circle class="mf-dot ok" cx="46" cy="58" r="3.5"/>
            <text class="mf-title" x="58" y="62">日常对话</text>
            <text class="mf-cap" x="166" y="62" text-anchor="end">实时</text>
          </g>

          <g class="mf-node" data-mf-title="凌晨做梦整理（collie-dream 离线精炼）" data-mf-tip="每日 ${esc(dreamTimeShort)} 空闲时独立启动 collie-dream 回顾近期对话与命令日志：压缩去重 instructions.md（归纳隐性习惯标为做梦推断）、完结任务归入 tasks/done/、合并笔记，并将重复 ≥3 次的流程提议固化为 Skill。">
            <rect class="mf-card dream" x="28" y="98" width="152" height="44" rx="11"/>
            <circle class="mf-dot dream" cx="46" cy="120" r="3.5"/>
            <text class="mf-title" x="58" y="124">凌晨做梦</text>
            <text class="mf-cap" x="166" y="124" text-anchor="end">${esc(dreamTimeShort)}</text>
          </g>

          <g class="mf-node" data-mf-title="Hub 网关自动快照（零 Token 消耗）" data-mf-tip="每当 Collie 发送正式回复，Hub Go 进程会自动把最近 10 条回复摘录覆写到 messages.md（不调用大模型），避免重启或换新会话后失忆重复汇报。">
            <rect class="mf-card" x="28" y="160" width="152" height="44" rx="11"/>
            <circle class="mf-dot sig" cx="46" cy="182" r="3.5"/>
            <text class="mf-title" x="58" y="186">网关快照</text>
            <text class="mf-cap" x="166" y="186" text-anchor="end">自动</text>
          </g>

          <!-- Center Hub Tiers -->
          <g class="mf-node" data-mf-title="第一层：核心预载（当前 ${kb(upFront)} / 上限 ${kb(budget)}）" data-mf-tip="每次 Collie 开启新会话开场必读的全部文件：长期指令 instructions.md (${kb(insB)}) + 笔记目录 notes/index.md (${kb(idxB)}，只读目录不读正文) + 在途任务 tasks/*.md (${kb(tskB)}) + 最近回复 messages.md (${kb(msgSize)}) + 各 Skill 一句话触发条件。">
            <rect class="mf-card tier1" x="268" y="44" width="408" height="48" rx="11"/>
            <circle class="mf-dot ok" cx="286" cy="68" r="3.8"/>
            <text class="mf-title" x="300" y="72">核心预载</text>
            <text class="mf-cap" x="366" y="72">指令 · 目录 · 在途 · 快照</text>
            <text class="mf-badge-ok" x="660" y="72" text-anchor="end">${kb(upFront)}</text>
          </g>

          <g class="mf-node mf-jump" data-mem-jump="notes" data-mf-title="第二层 A：专题经验笔记（共 ${topicNotes.length} 篇 · 点击查看）" data-mf-tip="存放各项目仓库路径、实验口径与机器差异（如 sfd-net.md）。新会话启动不预载正文；聊到对应项目时才顺着 index.md 目录指针精准 Read 所需的那一篇，平时零开销。">
            <rect class="mf-card tier2" x="268" y="102" width="198" height="48" rx="11"/>
            <circle class="mf-dot sig" cx="286" cy="126" r="3.5"/>
            <text class="mf-title" x="300" y="130">经验笔记</text>
            <text class="mf-cap" x="452" y="130" text-anchor="end">${topicNotes.length} 篇 ↗</text>
          </g>

          <g class="mf-node mf-jump" data-mem-jump="skills" data-mf-title="第二层 B：自建 Skill（共 ${skills.length} 个 · 点击管理）" data-mf-tip="权威主本保存在 Hub，分两档：①「Collie 中枢自用」仅供主脑调度续派；②「全节点共享」自动分发到各台电脑。启动仅读触发条件，命中场景才展开 SKILL.md 全文。">
            <rect class="mf-card tier2" x="478" y="102" width="198" height="48" rx="11"/>
            <circle class="mf-dot sig" cx="496" cy="126" r="3.5"/>
            <text class="mf-title" x="510" y="130">自建 Skill</text>
            <text class="mf-cap" x="662" y="130" text-anchor="end">${skills.length} 个 ↗</text>
          </g>

          <g class="mf-node mf-jump" data-mem-jump="archive" data-mf-title="第三层：做梦日记与历史归档（点击查看）" data-mf-tip="包含历次夜间做梦日记 (dreams/*.md，${r.dreams?.length || 0} 篇) 与已结项历史任务 (tasks/done/*.md，${done.length} 项)。永不注入新会话上下文，不占任何 Token 预算，仅供复盘与做梦对比。">
            <rect class="mf-card tier3" x="268" y="160" width="408" height="42" rx="10"/>
            <circle class="mf-dot muted" cx="286" cy="181" r="3.2"/>
            <text class="mf-title muted" x="300" y="185">做梦与归档</text>
            <text class="mf-cap" x="378" y="185">日记 · 历史结项</text>
            <text class="mf-cap" x="660" y="185" text-anchor="end">不加载 ↗</text>
          </g>

          <!-- Outbound Non-Crossing Curves (Hub -> Consumers) -->
          <path class="mf-wire-ok" d="M676,68 C714,68 718,70 754,70" marker-end="url(#mf-arr-ok)"/>
          <text class="mf-edge ok" x="715" y="61" text-anchor="middle">必读</text>

          <path class="mf-wire-dash" d="M676,118 C714,118 718,86 754,86" marker-end="url(#mf-arr-sig)"/>
          <text class="mf-edge sig" x="715" y="106" text-anchor="middle">按需</text>

          <path class="mf-wire-sig" d="M676,134 C714,134 718,162 754,162" marker-end="url(#mf-arr-sig)"/>
          <text class="mf-edge sig" x="715" y="156" text-anchor="middle">同步</text>

          <!-- Right Column: 2 Runtime Targets -->
          <g class="mf-node" data-mf-title="Collie 主脑新会话（Mac / Hub）" data-mf-tip="每次唤醒或上下文轮转重开时，先一次性注入「核心预载」（${kb(upFront)}）；对话中涉及具体项目或续派侧栏时，再按需 Read 对应经验笔记或展开中枢 Skill。">
            <rect class="mf-card" x="758" y="48" width="154" height="58" rx="12"/>
            <text class="mf-title" x="776" y="73">Collie 主脑</text>
            <text class="mf-cap" x="776" y="92">开场预载 + 按需查</text>
          </g>

          <g class="mf-node" data-mf-title="Mac · Windows 所有会话与 Worker" data-mf-tip="设为「全节点共享」的 Skill 会由 Hub 通过隧道自动同步到所有在线电脑的 ~/.agents/skills、~/.codex/skills 与 ~/.claude/skills（带安全标记，不覆盖本地已有技能），任何会话开箱即用。">
            <rect class="mf-card" x="758" y="132" width="154" height="58" rx="12"/>
            <text class="mf-title" x="776" y="157">Mac · Win 节点</text>
            <text class="mf-cap" x="776" y="176">共享 Skill 下发</text>
          </g>
        </svg>
        <div class="mem-flow-tip" id="mem-flow-tip" hidden></div>
      </div>
    </details>`;

    // ── TAB 1: 核心预载 (active) ──
    if (tab === "active") {
      const indexInteractiveView = (f) => {
        const rows = String(f.text || "").split("\n").map((l) => l.trim()).filter((l) => l && !/^#/.test(l));
        if (!rows.length) return md(f.text);
        return `<div class="mem-idx-list">${rows.map((line) => {
          const m = /^(?:[-*]\s*)?`?([a-zA-Z0-9._/-]+\.md)`?\s*(?:—|–|-|:|：)\s*(.+)$/.exec(line);
          if (!m) return `<div class="mem-idx-row"><span class="mem-idx-desc">${esc(line)}</span></div>`;
          const fn = m[1].replace(/^notes\//, "");
          return `<div class="mem-idx-row">
            <button type="button" class="mono mem-idx-link" data-mem-jump="notes" data-mem-note="notes/${esc(fn)}">${esc(fn)} ↗</button>
            <span class="mem-idx-desc">${esc(m[2])}</span>
          </div>`;
        }).join("")}</div>`;
      };

      return `${overviewHTML}
        ${legacy.length ? `<div class="mem-sec"><div class="mem-sec-hd"><h4>旧版单文件记忆</h4><span class="mem-load-pill must">待下次做梦自动迁移</span></div><div class="card">${legacy.map((f) => card(f, { open: true })).join("")}</div></div>` : ""}

        <div class="mem-sec">
          <div class="mem-sec-hd">
            <h4>长期指令与偏好</h4>
            <span class="mem-load-pill must">每次新会话必读</span>
            <span class="mem-src-pill">你/Collie 实时写入 · 做梦逐条压缩去重</span>
          </div>
          <div class="card">${ins.length
            ? ins.map((f) => card(f, {
                open: true,
                label: "instructions.md",
                sub: "全局行为准则、汇报格式与项目默认路由习惯",
                customView: renderInstructionsMD,
                seedHint: "尚未配置偏好指令",
                seedDesc: "尚未写入长期偏好指令。点击右侧可写下你的常用习惯（如默认语言、代码规范、某类事件的处理原则），Collie 每次开启新会话都会自动遵守。",
              })).join("")
            : `<div class="mem-compact-empty">尚未写入长期偏好指令</div>`}</div>
        </div>

        <div class="mem-sec">
          <div class="mem-sec-hd">
            <h4>进行中的跨轮任务</h4>
            <span class="mem-load-pill must">每次新会话必读</span>
            <span class="mem-src-pill">派活时自动建立 · 完结后归入 tasks/done/</span>
          </div>
          ${tasks.length
            ? `<div class="card">${tasks.map((f) => card(f, { label: f.name.replace(/^tasks\//, ""), open: true, crew: true, deletable: true })).join("")}</div>`
            : `<div class="mem-compact-empty"><span class="dot idle"></span><span>当前没有未完结的跨轮在途任务 · 新会话此项预载开销 <b>0 B</b></span></div>`}
        </div>

        <div class="mem-sec">
          <div class="mem-sec-hd">
            <h4>经验笔记总目录</h4>
            <span class="mem-load-pill must">每次新会话仅读此目录（不预载笔记正文）</span>
            <span class="mem-src-pill">点击文件名可直达专题笔记</span>
          </div>
          <div class="card">${indexFile
            ? card(indexFile, {
                open: true,
                label: "notes/index.md",
                sub: `共索引 ${topicNotes.length} 篇按需读取的专题经验笔记`,
                customView: indexInteractiveView,
                seedHint: "目录索引为空",
                seedDesc: "当前还没有经验笔记条目。Collie 沉淀新笔记后会自动维护此目录索引。",
              })
            : `<div class="mem-compact-empty">暂无目录索引</div>`}</div>
        </div>

        ${msgs.length ? `<div class="mem-sec">
          <div class="mem-sec-hd">
            <h4>最近回复快照</h4>
            <span class="mem-load-pill must">每次新会话必读（独立计费）</span>
            <span class="mem-src-pill">Hub 自动实时覆写最近 10 条正式回复，防止换会话重复汇报</span>
          </div>
          <div class="card">${msgs.map((f) => card(f, { edit: false, open: false, label: "messages.md", sub: "点击展开查看 Hub 最近自动记录的 10 条主对话回复摘录" })).join("")}</div>
        </div>` : ""}`;
    }

    // ── TAB 2: 经验笔记 (notes — 2-column Master-Detail Reader) ──
    if (tab === "notes") {
      const allNotes = [...topicNotes, ...(indexFile ? [indexFile] : [])];
      if (!memSelNote || !allNotes.some((f) => f.name === memSelNote)) {
        memSelNote = (topicNotes[0] || indexFile || {}).name || "";
      }
      const curNote = allNotes.find((f) => f.name === memSelNote) || null;
      const newNoteCard = memCreatingNote ? `<form class="card mem-create-card" id="mem-new-note-form">
        <div class="mem-create-hd"><b>新建专题经验笔记</b><span class="muted">保存至 Hub <code>memory/notes/</code> 并自动登记到 <code>index.md</code></span></div>
        <div class="mem-create-grid">
          <label><span>文件名标识</span><input type="text" name="slug" placeholder="例如：sfd-deploy 或 gpu-cluster" required pattern="[a-zA-Z0-9._-]+" spellcheck="false"></label>
          <label><span>一句话目录摘要（写入 index.md）</span><input type="text" name="summary" placeholder="例如：板端 TensorRT 导出命令与常见报错" required></label>
        </div>
        <label class="mem-create-full"><span>笔记正文（Markdown）</span><textarea name="text" rows="8" spellcheck="false" placeholder="# 标题\n\n记录可复用的仓库路径、验证命令与踩坑经验…"></textarea></label>
        <div class="form-actions"><span class="grow"></span><button type="button" class="btn small" data-act="mem-cancel-new-note">取消</button><button class="btn primary small" type="submit">创建笔记</button></div>
      </form>` : "";

      const splitHTML = allNotes.length ? `<div class="mem-split">
        <aside class="mem-nav">
          ${topicNotes.map((f) => {
            const short = f.name.replace(/^notes\//, "");
            const desc = indexDescMap.get(f.name) || firstLine(f.text, short);
            const on = curNote?.name === f.name;
            return `<button type="button" class="mem-nav-item ${on ? "on" : ""}" data-sel-note="${esc(f.name)}">
              <div class="mni-top"><span class="mni-title">${esc(titleFromMd(f.text, short.replace(/\.md$/, "")))}</span><span class="mni-size mono">${kb(f.size)}</span></div>
              <div class="mni-file mono">${esc(short)}</div>
              <div class="mni-sub">${esc(desc)}</div>
            </button>`;
          }).join("")}
          ${indexFile ? `<button type="button" class="mem-nav-item is-index ${curNote?.name === "notes/index.md" ? "on" : ""}" data-sel-note="notes/index.md">
            <div class="mni-top"><span class="mni-title">目录总索引</span><span class="mem-load-pill must">启动预载</span></div>
            <div class="mni-file mono">index.md · ${kb(indexFile.size)}</div>
          </button>` : ""}
        </aside>
        <div class="card mem-reader" ${curNote ? `data-path="${esc(curNote.name)}"` : ""}>
          ${curNote ? `
            <div class="mem-reader-hd">
              <div class="mrh-main">
                <div class="mrh-title-row">
                  <h3>${esc(titleFromMd(curNote.text, curNote.name.replace(/^notes\//, "")))}</h3>
                  <span class="mono mem-name">${esc(curNote.name)}</span>
                  <span class="mem-load-pill ${curNote.name === "notes/index.md" ? "must" : "lazy"}">${curNote.name === "notes/index.md" ? "每次新会话必读" : "按需读取 · 0 启动开销"}</span>
                </div>
                <div class="mrh-meta muted">${esc(dayTime(curNote.mod))} 更新 · ${kb(curNote.size)}${indexDescMap.get(curNote.name) ? ` · 目录摘要：${esc(indexDescMap.get(curNote.name))}` : ""}</div>
              </div>
              <div class="mrh-acts">
                ${curNote.name !== "notes/index.md" ? `<button type="button" class="btn small danger-ghost" data-act="mem-del" data-del-path="${esc(curNote.name)}">删除</button>` : ""}
                <button type="button" class="btn small" data-act="mem-edit">编辑</button>
              </div>
            </div>
            <div class="mem-body msg assistant" data-view>${isDefaultSeedText(curNote.name, curNote.text) ? `<div class="mem-seed-empty"><span>尚未填写内容。</span><button type="button" class="btn small" data-act="mem-edit">立即填写</button></div>` : md(curNote.text)}</div>
            <div class="mem-tools">${crew(curNote)}<span class="muted grow">存储于 Hub <code>${esc(tilde(r.dir))}/memory/${esc(curNote.name)}</code></span></div>
            <form class="mem-edit" hidden>
              <textarea name="text" spellcheck="false">${esc(curNote.text)}</textarea>
              <div class="form-actions"><span class="muted grow">保存后同步至 Hub 与运行中的 Collie 节点。</span><button type="button" class="btn small" data-act="mem-cancel">取消</button><button class="btn primary small">保存修改</button></div>
            </form>
          ` : ""}
        </div>
      </div>` : `<div class="card"><div class="empty-state"><span class="es-ico">${emptyIcon}</span><b>还没有沉淀的专题经验笔记</b><span>Collie 在跨机排障或执行项目任务后，会自动将值得复用的机器与项目经验归纳到这里。</span></div></div>`;

      return `<div class="mem-sec first">
          <div class="mem-sec-hd">
            <h4>按需检索的专题经验笔记</h4>
            <span class="mem-load-pill lazy">命中话题时才 Read · 不占 10 KB 启动预算</span>
            <span class="grow"></span>
            ${!memCreatingNote ? `<button type="button" class="btn small" data-act="mem-new-note">+ 新建笔记</button>` : ""}
          </div>
          ${newNoteCard}
          ${splitHTML}
        </div>`;
    }

    // ── TAB 3: 自建技能 (skills — Hub-backed & Multi-Node Synced Skill Studio) ──
    if (tab === "skills") {
      if (!memSelSkill || !skills.some((s) => s.slug === memSelSkill)) {
        memSelSkill = skills[0]?.slug || "";
      }
      const curSkill = skills.find((s) => s.slug === memSelSkill) || null;
      const onlineNodeNames = (state.machines || []).filter((m) => m.online && !isAgentlessHub(m)).map((m) => m.name || m.id);
      const syncTargetDesc = onlineNodeNames.length ? onlineNodeNames.join(" · ") : "所有接入的在线电脑";

      const newSkillCard = memCreatingSkill ? `<form class="card mem-create-card" id="mem-new-skill-form">
        <div class="mem-create-hd"><b>在 Hub 上新建 Skill</b><span class="muted">主本保存在 Hub，支持下发至各台电脑或仅供 Collie 中枢自用</span></div>
        <div class="mem-create-grid">
          <label><span>技能目录标识（slug）</span><input type="text" name="slug" placeholder="例如：sfd-router-eval" required pattern="[a-zA-Z0-9][a-zA-Z0-9._-]*" spellcheck="false"></label>
          <label><span>生效与分发范围</span>
            <select name="scope">
              <option value="shared">全节点共享 — 存 Hub 并自动同步至 ${esc(syncTargetDesc)} 所有 Agent</option>
              <option value="router">Collie 中枢自用 — 存 Hub，仅供 Collie 主脑调度与核验使用</option>
            </select>
          </label>
        </div>
        <label class="mem-create-full"><span>当什么场景下触发此 Skill？（description，启动时仅加载这一句）</span><input type="text" name="description" placeholder="例如：当需要在同一测试名单上对照选域准确率与分割 Dice 时使用。" required></label>
        <label class="mem-create-full"><span>技能执行步骤正文（Markdown，命中后按需加载）</span><textarea name="body" rows="9" spellcheck="false" placeholder="# 技能标题\n\n1. 第一步…\n2. 第二步…"></textarea></label>
        <div class="form-actions"><span class="grow"></span><button type="button" class="btn small" data-act="skill-cancel-new">取消</button><button class="btn primary small" type="submit">保存并同步 Skill</button></div>
      </form>` : "";

      const skillsBody = skills.length ? `<div class="mem-split">
        <aside class="mem-nav">
          ${skills.map((sk) => {
            const on = curSkill?.slug === sk.slug;
            const isShared = sk.scope === "shared";
            return `<button type="button" class="mem-nav-item ${on ? "on" : ""}" data-sel-skill="${esc(sk.slug)}">
              <div class="mni-top">
                <span class="mni-title">${esc(sk.name || sk.slug)}</span>
                <span class="mem-scope-pill ${isShared ? "shared" : "router"}">${isShared ? "全节点共享" : "中枢自用"}</span>
              </div>
              <div class="mni-file mono">${esc(sk.slug)} · ${kb(sk.size)}</div>
              <div class="mni-sub">${esc(sk.description || firstLine(sk.body, "暂无触发说明"))}</div>
            </button>`;
          }).join("")}
        </aside>
        <div class="card mem-reader" ${curSkill ? `data-skill-slug="${esc(curSkill.slug)}" data-skill-scope="${esc(curSkill.scope)}"` : ""}>
          ${curSkill ? (() => {
            const isShared = curSkill.scope === "shared";
            const hubRel = isShared ? `skills/${curSkill.slug}/SKILL.md` : `.agents/skills/${curSkill.slug}/SKILL.md`;
            const distText = isShared
              ? `Hub 主本 + 自动分发至 ${syncTargetDesc} 的 ~/.agents/skills · ~/.codex/skills · ~/.claude/skills`
              : `Hub 主本 + 同步至 Collie 主脑目录 (.agents/skills & .claude/skills)，不污染普通项目会话`;
            return `
              <div class="mem-reader-hd">
                <div class="mrh-main">
                  <div class="mrh-title-row">
                    <h3>${esc(curSkill.name || curSkill.slug)}</h3>
                    <span class="mono mem-name">${esc(curSkill.slug)}</span>
                    <span class="mem-scope-pill ${isShared ? "shared" : "router"}">${isShared ? "全节点共享 Skill" : "Collie 中枢自用 Skill"}</span>
                  </div>
                  <div class="mrh-meta muted">${esc(dayTime(curSkill.mod))} 更新 · ${kb(curSkill.size)}${curSkill.extra_files?.length ? ` · 含附属文件 ${curSkill.extra_files.length} 个` : ""}</div>
                </div>
                <div class="mrh-acts">
                  <button type="button" class="btn small" data-act="skill-toggle-scope" data-slug="${esc(curSkill.slug)}" data-cur-scope="${esc(curSkill.scope)}" title="${isShared ? "改为仅供 Collie 主脑自用，并从各电脑全局目录移除" : "改为全节点共享，自动下发到 Mac / Win 各台电脑供所有会话调用"}">${isShared ? "转为中枢自用" : "设为全节点共享"}</button>
                  <button type="button" class="btn small danger-ghost" data-act="skill-del" data-slug="${esc(curSkill.slug)}">删除</button>
                  <button type="button" class="btn small" data-act="skill-edit">编辑 SKILL.md</button>
                </div>
              </div>
              <div data-view>
                <div class="mem-skill-meta-bar">
                  <div class="msmb-row"><span class="msmb-k">启动预载触发条件</span><span class="msmb-v">${esc(curSkill.description || "（未在 YAML frontmatter 中填写 description）")}</span></div>
                  <div class="msmb-row"><span class="msmb-k">Hub 存储与同步</span><span class="msmb-v mono">${esc(tilde(r.dir))}/${esc(hubRel)}</span><span class="msmb-note">${esc(distText)}</span></div>
                  ${curSkill.extra_files?.length ? `<div class="msmb-row"><span class="msmb-k">同目录附属脚本</span><span class="msmb-v mono">${curSkill.extra_files.map((x) => esc(x)).join(" , ")}</span></div>` : ""}
                </div>
                <div class="mem-body msg assistant">${md(curSkill.body || curSkill.text)}</div>
              </div>
              <form class="mem-edit mem-skill-edit" hidden>
                <div class="mem-skill-edit-bar">
                  <label><span>生效范围：</span>
                    <select name="scope">
                      <option value="shared" ${isShared ? "selected" : ""}>全节点共享（自动下发至各台在线电脑）</option>
                      <option value="router" ${!isShared ? "selected" : ""}>Collie 中枢自用（仅 Collie 主脑加载）</option>
                    </select>
                  </label>
                  <span class="muted">保持顶部 <code>---</code> YAML 块中的 <code>name</code> 与 <code>description</code> 简洁明确</span>
                </div>
                <textarea name="text" spellcheck="false">${esc(curSkill.text)}</textarea>
                <div class="form-actions"><span class="muted grow">保存后立即写入 Hub 主本并自动同步对应电脑节点。</span><button type="button" class="btn small" data-act="skill-cancel-edit">取消</button><button class="btn primary small" type="submit">保存并同步</button></div>
              </form>
            `;
          })() : ""}
        </div>
      </div>` : `<div class="card"><div class="empty-state">
        <span class="es-ico">${skillIcon}</span>
        <b>还没有已创建的 Hub 托管 Skill</b>
        <span>当做梦整理发现某套操作在 3 次以上任务中反复固定出现时，Collie 会在主对话里向你提议一键生成 Skill；你也可以点击右上方「+ 新建 Skill」直接创建。</span>
      </div></div>`;

      return `<div class="mem-sec first">
          <div class="mem-sec-hd">
            <h4>Collie 自建与托管的 Skill</h4>
            <span class="mem-load-pill lazy">Hub 权威存储 · 启动仅读触发条件，命中才读正文</span>
            <span class="grow"></span>
            ${!memCreatingSkill ? `<button type="button" class="btn small" data-act="skill-new">+ 新建 Skill</button>` : ""}
          </div>
          ${newSkillCard}
          ${skillsBody}
        </div>`;
    }

    // ── TAB 4: 做梦与归档 (archive) ──
    const q = memArchiveFilter.trim().toLowerCase();
    const filteredDone = q ? done.filter((f) => f.name.toLowerCase().includes(q) || f.text.toLowerCase().includes(q)) : done;

    const renderDreamBody = (txt) => {
      const lines = String(txt || "").split("\n");
      const chips = [];
      const rest = [];
      for (const l of lines) {
        const clean = l.trim().replace(/^[>*\-\s]+/, "");
        if (clean.startsWith("可做成 skill：")) {
          chips.push(`<div class="mem-dream-callout suggest"><b>提议新建 Skill：</b><span>${esc(clean.slice("可做成 skill：".length))}</span></div>`);
        } else if (clean.startsWith("可改进 skill：")) {
          chips.push(`<div class="mem-dream-callout fix"><b>提议优化 Skill：</b><span>${esc(clean.slice("可改进 skill：".length))}</span></div>`);
        } else {
          rest.push(l);
        }
      }
      return chips.join("") + md(rest.join("\n"));
    };

    return `<div class="mem-sec first">
        <div class="mem-sec-hd">
          <h4>夜间做梦整理日记</h4>
          <span class="mem-load-pill cold">冷归档 · 不注入新会话</span>
          <span class="mem-src-pill">${r.last_dream ? `上次整理：${dayTime(r.last_dream)}` : "记录每次做梦精简了哪些规则与发现的模式"}</span>
          <span class="grow"></span>
          <button type="button" class="btn small" data-act="dream-now" ${r.dreaming ? "disabled" : ""}>${r.dreaming ? "整理中…" : "立即整理记忆"}</button>
        </div>
        <div class="card">${r.dreams?.length
          ? r.dreams.map((d, i) => `<details class="mem-fold" ${i === 0 ? "open" : ""} data-path="dreams/${esc(d.name)}"><summary><span class="mono mem-name">${esc(d.name.replace(/\.md$/, ""))}</span><span class="grow">${esc(firstLine(d.text, d.name))}</span><span class="muted mono" style="font-size:11.5px">${kb(d.size || d.text?.length || 0)}</span></summary><div class="mem-body msg assistant">${renderDreamBody(d.text)}</div></details>`).join("")
          : `<div class="empty-state"><span class="es-ico"><svg viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg></span><b>还没有做梦整理记录</b><span>当天有新对话时，Collie 会在凌晨自动回顾对话并精简长期记忆，也可点击上方「立即整理记忆」手动触发。</span></div>`}</div>
      </div>

      <div class="mem-sec">
        <div class="mem-sec-hd">
          <h4>已结项任务归档（${done.length}）</h4>
          <span class="mem-load-pill cold">冷归档 · 不占任何会话预算</span>
          <span class="grow"></span>
          ${done.length > 4 ? `<input type="search" class="mem-arch-search" data-mem-arch-filter placeholder="搜索历史归档任务…" value="${esc(memArchiveFilter)}">` : ""}
        </div>
        <div class="card" id="mem-done-list">${filteredDone.length
          ? filteredDone.map((f) => card(f, { label: f.name.replace(/^tasks\/done\//, ""), crew: true, deletable: true })).join("")
          : `<div class="mem-compact-empty">${q ? "没有匹配该关键词的归档任务" : "暂无已归档的历史任务"}</div>`}</div>
      </div>`;
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
        <div class="card-h"><span class="card-h-main">已配置的定时任务</span><span class="card-h-sub">${ts.length ? `共 ${ts.length} 项（${activeCnt} 项启用中）` : "暂无任务"}</span></div>
        ${(() => {
          if (!ts.length) {
            return `<div class="empty-state"><span class="es-ico">${clockIco}</span><b>还没有配置定时任务</b><span>可在上方直接点击「常用模板」一键填入，或在聊天中直接对 Collie 说「每天早上 9 点帮我检查一次进展」。</span></div>`;
          }
          const activeList = ts.filter((t) => t.enabled);
          const endedList = ts.filter((t) => !t.enabled);
          const endedOpen = !!document.querySelector("details[data-ended-timers]")?.open;
          const rowHTML = (t) => `<li class="row">
            <span class="badge ${t.enabled ? "queued" : "ignored"}">${t.enabled ? "启用中" : "已结束"}</span>
            <div><div class="meta"><b title="${esc(t.spec)}">${esc(describeSpec(t.spec))}</b><span>→ ${esc(t.target || "Collie")}</span>${t.enabled ? `<span>下次触发：${when(t.next_run)}</span>` : t.last_run ? `<span>上次执行：${when(t.last_run)}</span>` : ""}${t.owner ? `<span>${t.owner === "you" ? "手动创建" : esc(t.owner) + " 创建"}</span>` : ""}</div>
            <div class="text">${esc(t.text)}</div></div>
            <button class="btn ghost small" data-del-timer="${esc(t.id)}">删除</button></li>`;
          let out = activeList.length ? `<ul class="rows">${activeList.map(rowHTML).join("")}</ul>` : "";
          if (endedList.length) {
            out += `<details class="tm-ended" data-ended-timers ${endedOpen || !activeList.length ? "open" : ""}><summary>已结束的定时任务（${endedList.length}）</summary><ul class="rows">${endedList.map(rowHTML).join("")}</ul></details>`;
          }
          return out;
        })()}
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
          <div class="set-head-txt"><h4>默认派活偏好（兜底默认）</h4><p>当对话未提及特定电脑上的项目、且输入框处于「自动派活」时优先使用的默认电脑与 Agent；若默认电脑离线会自动切至其他在线电脑。</p></div>
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
          <div class="set-head-txt"><h4>外部消息通知</h4><p>当你离开网页时，自动通过飞书推送 Collie 总控汇报以及各项目独立会话的任务完成、待确认与异常提醒。</p></div>
        </header>
        <div class="set-grid">
          <label class="check span3"><input type="checkbox" name="notify_lark" ${s.notify_lark ? "checked" : ""}> 使用 Hub 上的 lark-cli 发送飞书私聊提醒<small id="lark-who" class="muted">· 正在检测 Hub 上的 lark-cli 状态…</small></label>
          <label>群机器人 Webhook<input name="notify_webhook" value="${esc(s.notify_webhook || "")}" placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…"><small>支持飞书 / Lark 群自定义机器人（发送带直达按钮的交互卡片）或 Slack Webhook</small></label>
          <label>推送触发时机<select name="notify_level" data-title="推送触发时机"><option value="normal" ${(s.notify_level === "normal" || (!s.notify_webhook && !s.notify_lark)) ? "selected" : ""} data-sub="任务跑完、需要确认或报错时均推送飞书卡片">包含任务完成与需介入提醒</option><option value="quiet" ${(s.notify_level === "quiet" && (s.notify_webhook || s.notify_lark)) ? "selected" : ""} data-sub="平时静默，仅在任务阻塞待确认或报错时推送">仅在需要你介入时</option></select><small>当前浏览器前台打开 Collie 页面时自动静音免打扰</small></label>
        </div>
        <div class="notify-test-bar">
          <button type="button" class="btn small" data-act="test-notify">发送测试通知</button>
          <span class="muted" id="notify-test-msg">填好飞书群机器人 Webhook 后可直接点击测试（成功将自动保存通知配置）</span>
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
      } else if (f.id === "mem-new-note-form") {
        let slug = f.slug.value.trim().replace(/\.md$/i, "");
        if (!slug) { toast("请填写文件名标识", "attn"); return; }
        const notePath = "notes/" + slug + ".md";
        const summary = f.summary.value.trim();
        const text = f.text.value.trim() || `# ${slug}\n`;
        await api("/api/super/memory", { body: { path: notePath, text } });
        if (summary && memLastData?.files) {
          const idxFile = memLastData.files.find((x) => x.name === "notes/index.md");
          const existingIdx = String(idxFile?.text || "# Notes\n").trimEnd();
          if (!existingIdx.includes(slug + ".md")) {
            await api("/api/super/memory", { body: { path: "notes/index.md", text: `${existingIdx}\n${slug}.md — ${summary}\n` } });
          }
        }
        memCreatingNote = false;
        memSelNote = notePath;
        $("#panel-body")._memSig = "";
        toast("已创建笔记并同步目录索引");
        loadPanel("memory");
      } else if (f.id === "mem-new-skill-form") {
        const slug = f.slug.value.trim();
        const scope = f.scope.value;
        const desc = f.description.value.trim();
        const mdBody = f.body.value.trim() || `# ${slug}\n`;
        const fullText = `---\nname: ${slug}\ndescription: ${desc}\n---\n\n${mdBody}\n`;
        await api("/api/super/skills", { body: { slug, scope, text: fullText } });
        memCreatingSkill = false;
        memSelSkill = slug;
        $("#panel-body")._memSig = "";
        toast(scope === "shared" ? "已保存到 Hub 并同步至在线电脑" : "已保存到 Hub（Collie 中枢自用）");
        loadPanel("memory");
      } else if (f.classList.contains("mem-skill-edit")) {
        const box = f.closest("[data-skill-slug]");
        const slug = box.dataset.skillSlug;
        const prevScope = box.dataset.skillScope;
        const scope = f.scope.value;
        await api("/api/super/skills", { body: { slug, prev_slug: slug, scope, prev_scope: prevScope, text: f.text.value } });
        memEditing = false;
        $("#panel-body")._memSig = "";
        toast(scope === "shared" ? "已更新 Skill 并同步至各电脑节点" : "已更新 Skill（中枢自用）");
        loadPanel("memory");
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

  $("#panel-body").addEventListener("toggle", (e) => {
    if (e.target?.matches?.("details[data-mem-arch]")) {
      memArchOpen = e.target.open;
      store.set("memArchOpen", memArchOpen);
      const cue = e.target.querySelector(".mem-arch-cue");
      if (cue) cue.textContent = memArchOpen ? "收起" : "展开";
    }
  }, true);

  // Floating hover tooltip for SVG nodes in `#/memory` flowchart
  $("#panel-body").addEventListener("pointermove", (e) => {
    const tipEl = $("#mem-flow-tip");
    if (!tipEl) return;
    const g = e.target?.closest?.("[data-mf-tip]");
    if (!g) {
      if (!tipEl.hidden) tipEl.hidden = true;
      return;
    }
    const title = g.dataset.mfTitle || "";
    const body = g.dataset.mfTip || "";
    const sig = title + "\n" + body;
    if (tipEl._sig !== sig) {
      tipEl._sig = sig;
      tipEl.innerHTML = `${title ? `<div class="mft-t">${esc(title)}</div>` : ""}<div class="mft-b">${esc(body)}</div>`;
    }
    tipEl.hidden = false;
    const wrap = tipEl.parentElement.getBoundingClientRect();
    const tw = tipEl.offsetWidth || 300, th = tipEl.offsetHeight || 90;
    let x = e.clientX - wrap.left + 14;
    let y = e.clientY - wrap.top + 14;
    if (x + tw > wrap.width - 10) x = Math.max(10, e.clientX - wrap.left - tw - 12);
    if (y + th > wrap.height - 8) y = Math.max(8, e.clientY - wrap.top - th - 12);
    tipEl.style.left = `${Math.round(x)}px`;
    tipEl.style.top = `${Math.round(y)}px`;
  });
  $("#panel-body").addEventListener("pointerleave", () => {
    const tipEl = $("#mem-flow-tip");
    if (tipEl) tipEl.hidden = true;
  });

  $("#panel-body").addEventListener("input", (e) => {
    if (e.target?.matches?.("[data-mem-arch-filter]")) {
      memArchiveFilter = e.target.value;
      if (memLastData && view === "memory" && memTab === "archive") {
        const q = memArchiveFilter.trim().toLowerCase();
        const done = (memLastData.files || []).filter((f) => f.name.startsWith("tasks/done/")).sort((a, b) => new Date(b.mod) - new Date(a.mod));
        const filtered = q ? done.filter((f) => f.name.toLowerCase().includes(q) || f.text.toLowerCase().includes(q)) : done;
        const listEl = $("#mem-done-list");
        if (listEl) {
          listEl.innerHTML = filtered.length
            ? filtered.map((f) => `<details class="mem-fold" data-path="${esc(f.name)}"><summary><span class="mono mem-name">${esc(f.name.replace(/^tasks\/done\//, ""))}</span><span class="grow">${esc(String(f.text || "").split("\n").filter((l) => !/^\s*#/.test(l)).map((l) => l.trim()).find(Boolean) || "")}</span><span class="muted mono" style="font-size:11.5px">${kb(f.size)}</span></summary><div class="mem-body msg assistant" data-view>${md(f.text)}</div><div class="mem-tools"><span class="muted grow">${esc(dayTime(f.mod))} 更新</span><button type="button" class="btn small danger-ghost" data-act="mem-del" data-del-path="${esc(f.name)}">删除</button><button type="button" class="btn small" data-act="mem-edit">编辑</button></div><form class="mem-edit" hidden><textarea name="text" spellcheck="false">${esc(f.text)}</textarea><div class="form-actions"><span class="muted grow">保存至 Hub 主本。</span><button type="button" class="btn small" data-act="mem-cancel">取消</button><button class="btn primary small">保存修改</button></div></form></details>`).join("")
            : `<div class="mem-compact-empty">没有匹配该关键词的归档任务</div>`;
        }
      }
    }
  });

  $("#panel-body").addEventListener("click", async (e) => {
    const jumpEl = e.target.closest("[data-mem-jump]");
    if (jumpEl) {
      const targetTab = jumpEl.dataset.memJump;
      if (jumpEl.dataset.memNote) memSelNote = jumpEl.dataset.memNote;
      if (jumpEl.dataset.memSkill) memSelSkill = jumpEl.dataset.memSkill;
      PANEL_META.memory.set(targetTab);
      renderPanelTabs("memory", memLastData);
      $("#panel-body")._memSig = "";
      if (memLastData) {
        $("#panel-body").innerHTML = memoryHTML(memLastData, memTab);
      } else {
        loadPanel("memory");
      }
      return;
    }
    const selNoteEl = e.target.closest("[data-sel-note]");
    if (selNoteEl) {
      memSelNote = selNoteEl.dataset.selNote;
      memEditing = false;
      $("#panel-body")._memSig = "";
      if (memLastData) $("#panel-body").innerHTML = memoryHTML(memLastData, memTab);
      return;
    }
    const selSkillEl = e.target.closest("[data-sel-skill]");
    if (selSkillEl) {
      memSelSkill = selSkillEl.dataset.selSkill;
      memEditing = false;
      $("#panel-body")._memSig = "";
      if (memLastData) $("#panel-body").innerHTML = memoryHTML(memLastData, memTab);
      return;
    }
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
      const formEl = box.querySelector(".mem-edit");
      const viewEl = box.querySelector("[data-view]");
      const toolsEl = box.querySelector(".mem-tools");
      if (formEl) formEl.hidden = !memEditing;
      if (viewEl) viewEl.hidden = memEditing;
      if (toolsEl) toolsEl.hidden = memEditing;
      if (memEditing) formEl?.querySelector("textarea")?.focus();
      else { $("#panel-body")._memSig = ""; loadPanel("memory"); }
      return;
    }
    if (t.dataset.act === "mem-new-note" || t.dataset.act === "mem-cancel-new-note") {
      memCreatingNote = t.dataset.act === "mem-new-note";
      $("#panel-body")._memSig = "";
      if (memLastData) $("#panel-body").innerHTML = memoryHTML(memLastData, memTab);
      if (memCreatingNote) $("#mem-new-note-form input[name=slug]")?.focus();
      return;
    }
    if (t.dataset.act === "mem-del") {
      const p = t.dataset.delPath;
      if (!p || !confirm(`确认删除记忆文件「${p}」？`)) return;
      try {
        await api("/api/super/memory/delete", { body: { path: p } });
        if (p.startsWith("notes/") && memLastData?.files) {
          const short = p.replace(/^notes\//, "");
          const idxFile = memLastData.files.find((x) => x.name === "notes/index.md");
          if (idxFile?.text && idxFile.text.includes(short)) {
            const nextLines = idxFile.text.split("\n").filter((l) => !l.includes(short)).join("\n");
            await api("/api/super/memory", { body: { path: "notes/index.md", text: nextLines } });
          }
        }
        if (memSelNote === p) memSelNote = "";
        $("#panel-body")._memSig = "";
        toast("已删除");
        loadPanel("memory");
      } catch (err) { toast(err.message, "attn"); }
      return;
    }
    if (t.dataset.act === "skill-new" || t.dataset.act === "skill-cancel-new") {
      memCreatingSkill = t.dataset.act === "skill-new";
      $("#panel-body")._memSig = "";
      if (memLastData) $("#panel-body").innerHTML = memoryHTML(memLastData, memTab);
      if (memCreatingSkill) $("#mem-new-skill-form input[name=slug]")?.focus();
      return;
    }
    if (t.dataset.act === "skill-edit" || t.dataset.act === "skill-cancel-edit") {
      const box = t.closest("[data-skill-slug]");
      memEditing = t.dataset.act === "skill-edit";
      const formEl = box?.querySelector(".mem-skill-edit");
      const viewEl = box?.querySelector("[data-view]");
      if (formEl) formEl.hidden = !memEditing;
      if (viewEl) viewEl.hidden = memEditing;
      if (memEditing) formEl?.querySelector("textarea")?.focus();
      else { $("#panel-body")._memSig = ""; loadPanel("memory"); }
      return;
    }
    if (t.dataset.act === "skill-toggle-scope") {
      const slug = t.dataset.slug;
      const curScope = t.dataset.curScope;
      const nextScope = curScope === "shared" ? "router" : "shared";
      const sk = (memLastData?.skills || []).find((x) => x.slug === slug);
      if (!sk) return;
      const tip = nextScope === "shared"
        ? `将「${sk.name || slug}」切换为【全节点共享】？\n切换后，Hub 会自动把它下发同步到所有在线电脑（Mac / Win）供任意会话直接调用。`
        : `将「${sk.name || slug}」切换为【Collie 中枢自用】？\n切换后，仅 Collie 主脑自己加载该技能，并从各电脑全局目录移除托管副本。`;
      if (!confirm(tip)) return;
      try {
        await api("/api/super/skills", { body: { slug, prev_slug: slug, scope: nextScope, prev_scope: curScope, text: sk.text } });
        $("#panel-body")._memSig = "";
        toast(nextScope === "shared" ? "已切换为全节点共享并下发同步" : "已切换为 Collie 中枢自用");
        loadPanel("memory");
      } catch (err) { toast(err.message, "attn"); }
      return;
    }
    if (t.dataset.act === "skill-del") {
      const slug = t.dataset.slug;
      if (!slug || !confirm(`确认从 Hub 删除技能「${slug}」（并清理已同步到各节点的托管副本）？`)) return;
      try {
        await api("/api/super/skills/delete", { body: { slug } });
        if (memSelSkill === slug) memSelSkill = "";
        $("#panel-body")._memSig = "";
        toast("已删除该 Skill");
        loadPanel("memory");
      } catch (err) { toast(err.message, "attn"); }
      return;
    }
    if (t.dataset.act === "test-notify") {
      const f = $("#settings-form");
      const msgEl = $("#notify-test-msg");
      const webhook = f?.notify_webhook?.value.trim() || "";
      const useLark = !!f?.notify_lark?.checked;
      const level = f?.notify_level?.value || "normal";
      const orig = t.textContent;
      t.disabled = true;
      t.textContent = "发送中…";
      if (msgEl) { msgEl.textContent = "正在向飞书发送测试卡片…"; msgEl.className = "muted"; }
      try {
        const res = await api("/api/super/notify/test", {
          body: { notify_webhook: webhook, notify_lark: useLark, notify_level: level, url: location.origin },
        });
        const okMsg = res.warning ? `测试已部分送达（${res.warning}）` : "✓ 测试通知已送达飞书，通知配置已自动保存";
        if (msgEl) { msgEl.textContent = okMsg; msgEl.className = res.warning ? "attn-txt" : "ok-txt"; }
        toast(res.warning ? okMsg : "测试通知已送达飞书");
      } catch (err) {
        if (msgEl) { msgEl.textContent = "发送失败：" + err.message; msgEl.className = "err-txt"; }
        toast(err.message, "attn");
      } finally {
        t.disabled = false;
        t.textContent = orig;
      }
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
  let ext = [], extHash = "", extTimer, extStream = null, extCur = null;
  async function loadExternal(force = false) {
    if (!force && document.hidden && ext.length) return;
    let changed = false;
    try {
      const q = !force && extHash && ext.length ? `?hash=${encodeURIComponent(extHash)}` : "";
      const r = await api("/api/external" + q);
      if (!r.unchanged) {
        extHash = r.hash || r.etag || "";
        ext = r.sessions || [];
        changed = true;
      }
    } catch { return; }
    if (hubs.length) {
      const remoteExt = (await fromHubs("/api/external", "ext")).flat();
      ext = ext.filter((x) => !x.hub).concat(remoteExt);
      changed = true;
    }
    if (changed) {
      renderSide();
      if (view === "ext") renderExtHead();
    }
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
  const routerHist = (at) => {
    const t = +new Date(at);
    if (!t) return null;
    let best = null, bestDiff = 10 * 60e3;
    for (const h of hist) {
      if (h.name !== ROUTER) continue;
      const d = Math.abs(+new Date(h.ended) - t);
      if (d < bestDiff) { best = h; bestDiff = d; }
    }
    return best;
  };
  async function loadHistory() {
    if (document.hidden && hist.length) return;
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
    const byCollie = h ? isSessionByCollie(workerLookup(), { kind: h.kind, machine: h.machine, session: h.session, name: h.name, fallbackKey: "h:" + h.id, meta, flag: h.collie_worker }) : false;
    $("#x-name").textContent = h ? histName(h) : "已结束的会话";
    $("#x-kind").textContent = h ? KIND_LABEL[h.kind] || h.kind : "";
    const xTag = $("#x-tag");
    xTag.className = byCollie && !meta?.archived ? "head-collie-wrap" : "tag";
    xTag.hidden = !byCollie && !meta?.archived;
    xTag.innerHTML = `${byCollie ? collieMarkHTML() : ""}${meta?.archived ? "已归档" : ""}`;
    $("#x-status").className = "status ended";
    $("#x-status").textContent = h ? "上次对话 " + ago(h.ended) : "";
    $("#x-cwd").textContent = h ? (h.machine ? machineName(h.machine) + " · " : "") + tilde(h.cwd) : "";
    const canResume = !!(h && on && h.session && RESUME[h.kind]);
    $("#x-composer").hidden = !h;
    $("#x-input").disabled = !canResume;
    $("#x-input").placeholder = !h ? "会话已不存在" : !on ? `${machineName(h.machine)} 当前离线，上线后可直接发消息继续…` : "输入消息直接继续对话，自动继承上下文…";
    $("#x-hint").textContent = canResume && h.machine ? machineName(h.machine) : "";
    syncComposerBtn($("#x-composer"));
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
    const wl = workerLookup();
    const extRow = (e, inProj = false, pinned = false, byCollie = false) => {
      const open = e.live && e.status === "idle";
      const where = [KIND_LABEL[e.kind] || e.kind, !inProj && many && e.machine ? machineName(e.machine) : "", e.live && !open ? "" : ago(e.updated || e.started)].filter(Boolean).join(" · ");
      const showDot = e.live && SHOW_SIDE_DOT.has(e.status);
      const dot = showDot ? sideDotHTML(e.status, EXT_STATE) : "";
      const attnCls = e.live && e.status === "blocked" ? "attn-row" : "";
      const smenuKey = "x:" + e.id;
      const pMark = !inProj ? pinMarkHTML(smenuKey, pinned) : "";
      const nameHTML = byCollie ? `<span class="nm">${esc(extName(e))}</span>${collieMarkHTML()}${pMark}` : `${esc(extName(e))}${pMark}`;
      return `<li class="s-li ${attnCls}${!inProj && pinned ? " is-pinned" : ""}"><a class="item ${showDot ? "" : "ended"} ${view === "ext" && extCur === e.id ? "active" : ""}" href="#/x/${encodeURIComponent(e.id)}">
        <span class="glyph">${GLYPHS[e.kind] || GLYPHS.agent}</span>
        <span class="body"><div class="name">${nameHTML}</div><div class="sub">${esc(where)}</div></span>${dot}</a>
        <button type="button" class="item-more" data-smenu="${esc(smenuKey)}" title="置顶 / 重命名 / 归属项目 / 归档 / 删除">${MORE_ICO}</button></li>`;
    };
    const histRow = (h, inProj = false, pinned = false, byCollie = false) => {
      const sub = [KIND_LABEL[h.kind] || h.kind, !inProj && many ? machineName(h.machine) : "", ago(h.ended)].filter(Boolean).join(" · ");
      const smenuKey = "h:" + h.id;
      const pMark = !inProj ? pinMarkHTML(smenuKey, pinned) : "";
      return `<li class="s-li${!inProj && pinned ? " is-pinned" : ""}"><a class="item ended ${view === "ext" && extCur === "h:" + h.id ? "active" : ""}" href="#/h/${encodeURIComponent(h.id)}">
        <span class="glyph">${GLYPHS[h.kind] || GLYPHS.agent}</span>
        <span class="body"><div class="name">${byCollie ? `<span class="nm">${esc(histName(h))}</span>${collieMarkHTML()}${pMark}` : `${esc(histName(h))}${pMark}`}</div><div class="sub">${esc(sub)}</div></span></a>
        <button type="button" class="item-more" data-smenu="${esc(smenuKey)}" title="置顶 / 重命名 / 归属项目 / 归档 / 删除">${MORE_ICO}</button></li>`;
    };
    const paneRow = (a, inProj = false, lastT = 0, pinned = false, byCollie = false) => {
      if (!inProj) {
        const html = itemHTML(a, pinned, byCollie);
        return a.status === "blocked" ? html.replace('<li class="s-li', '<li class="s-li attn-row') : html;
      }
      const named = a.is_agent && a.name !== ROUTER && !byCollie && a.name && !autoName(a.name) && a.topic && a.topic !== a.name ? a.name + " · " : "";
      const quiet = !SHOW_SIDE_DOT.has(a.status);
      const whenPart = quiet && lastT ? " · " + ago(new Date(lastT).toISOString()) : "";
      const sub = a.is_agent ? `${named}${KIND_LABEL[a.kind] || a.kind}${whenPart}` : tilde(a.cwd);
      const more = a.name !== ROUTER ? `<button type="button" class="item-more" data-smenu="p:${esc(a.pane_id)}" title="重命名 / 归属项目 / 归档 / 删除">${MORE_ICO}</button>` : "";
      const attnCls = a.status === "blocked" ? "attn-row" : "";
      return `<li class="s-li ${attnCls}"><a class="item ${quiet ? "ended" : ""} ${view === "pane" && a.pane_id === current ? "active" : ""}" href="#/p/${encodeURIComponent(a.pane_id)}">
        <span class="glyph">${glyph(a)}</span>
        <span class="body"><div class="name">${byCollie ? `<span class="nm">${esc(title(a))}</span>${collieMarkHTML()}` : esc(title(a))}</div><div class="sub">${esc(sub)}</div></span>
        ${sideDotHTML(a.status)}</a>${more}</li>`;
    };

    const matchM = (m) => sideMachine === null || (m || "") === sideMachine;
    const isInternalHist = (name) => name === ROUTER || name === "collie-dream";
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
      const wLive = sup.workers.find((w) => w.name === a.name && !w.ended);
      const byCollie = isSessionByCollie(wl, { kind: a.kind, machine: a.machine, session: a.session, name: a.name, fallbackKey: "p:" + a.pane_id, meta });
      const t = (ck && extTimeMap.get(ck)) || +new Date(wLive?.created_at || 0) || +new Date(meta?.updated_at || 0) || 0;
      const proj = projectOfSession(a.kind, a.machine, a.session, a.cwd, "p:" + a.pane_id);
      const pinned = !proj && !!meta?.pinned;
      pool.push({
        key: "p:" + a.pane_id,
        proj,
        pinned,
        pinnedAt: meta?.pinned_at || 0,
        byCollie,
        archived: !!meta?.archived && !isBlocked && !isRunning,
        isRunning, isBlocked, groupRank, t,
        active: view === "pane" && current === a.pane_id,
        html: paneRow(a, !!proj, t, pinned, byCollie),
      });
    }

    const liveWorkerNames = new Set(state.agents.map((a) => a.name).filter(Boolean));
    for (const w of (sup.workers || [])) {
      if (w.ended || w.status !== "starting" || liveWorkerNames.has(w.name)) continue;
      if (!matchM(w.machine)) continue;
      const t = +new Date(w.created_at) || Date.now();
      const proj = projectOfSession(w.kind, w.machine, w.session || "", w.cwd || "", "");
      const where = [!proj && many && w.machine ? machineName(w.machine) : "", KIND_LABEL[w.kind] || w.kind, "启动中…"].filter(Boolean).join(" · ");
      pool.push({
        key: "w:" + w.name,
        proj,
        pinned: false,
        byCollie: true,
        archived: false,
        isRunning: true, isBlocked: false, groupRank: 1, t,
        active: false,
        html: `<li class="s-li"><a class="item" href="#/trace" title="${esc(w.task || "")}">
          <span class="glyph">${GLYPHS[w.kind] || GLYPHS.agent}</span>
          <span class="body"><div class="name"><span class="nm">${esc(w.name)}</span>${collieMarkHTML()}</div><div class="sub">${esc(where)}</div></span>
          ${sideDotHTML("starting")}</a></li>`,
      });
    }

    for (const e of ext) {
      if (!matchM(e.machine) || isInternalRouterCwd(e.cwd)) continue;
      const meta = getSessMeta(e.kind, e.machine, e.session, "x:" + e.id);
      if (meta?.deleted) continue;
      const ck = canonSessKey(e.kind, e.machine, e.session);
      if (ck && seenKeys.has(ck)) continue;
      if (ck) seenKeys.add(ck);
      const isBlocked = !!(e.live && e.status === "blocked");
      const isRunning = !!(e.live && isActivelyRunning(e.status));
      const groupRank = isBlocked ? 0 : isRunning ? 1 : 3;
      const proj = projectOfSession(e.kind, e.machine, e.session, e.cwd, "x:" + e.id);
      const pinned = !proj && !!meta?.pinned;
      const byCollie = isSessionByCollie(wl, { kind: e.kind, machine: e.machine, session: e.session, name: "", fallbackKey: "x:" + e.id, meta });
      pool.push({
        key: e.id,
        proj,
        pinned,
        pinnedAt: meta?.pinned_at || 0,
        byCollie,
        archived: !!meta?.archived && !isBlocked && !isRunning,
        isRunning, isBlocked, groupRank,
        t: +new Date(e.updated || e.started) || 0,
        active: view === "ext" && extCur === e.id,
        html: extRow(e, !!proj, pinned, byCollie),
      });
    }

    for (const h of hist) {
      if (isInternalHist(h.name) || !matchM(h.machine)) continue;
      const meta = getSessMeta(h.kind, h.machine, h.session, "h:" + h.id);
      if (meta?.deleted) continue;
      const ck = canonSessKey(h.kind, h.machine, h.session);
      if (ck && seenKeys.has(ck)) continue;
      if (ck) seenKeys.add(ck);
      const proj = projectOfSession(h.kind, h.machine, h.session, h.cwd, "h:" + h.id);
      const pinned = !proj && !!meta?.pinned;
      const byCollie = isSessionByCollie(wl, { kind: h.kind, machine: h.machine, session: h.session, name: h.name, fallbackKey: "h:" + h.id, meta, flag: h.collie_worker });
      pool.push({
        key: "h:" + h.id,
        proj,
        pinned,
        pinnedAt: meta?.pinned_at || 0,
        byCollie,
        archived: !!meta?.archived,
        isRunning: false, isBlocked: false, groupRank: 3,
        t: +new Date(h.ended) || 0,
        active: view === "ext" && extCur === "h:" + h.id,
        html: histRow(h, !!proj, pinned, byCollie),
      });
    }

    pool.sort((x, y) => (x.groupRank - y.groupRank) || (y.t - x.t));
    const allowCollie = (x) => !hideCollie || !x.byCollie || x.pinned || (sideStatus === "blocked" && x.isBlocked);
    const unarchived = pool.filter((x) => !x.archived && allowCollie(x));
    const archived = pool.filter((x) => x.archived && allowCollie(x));

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
    const hcBtn = $("#sf-hide-collie");
    if (hcBtn) {
      hcBtn.classList.toggle("on", Boolean(hideCollie));
      hcBtn.setAttribute("aria-pressed", String(Boolean(hideCollie)));
    }

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
          const mOn = extOnline({ machine: p.machine });
          const where = many && sideMachine === null ? machineName(p.machine) : "";
          const badgeParts = [where, !mOn ? "离线" : "", items.length ? String(items.length) : ""].filter(Boolean).join(" · ");
          const collapsedDot = !open && (hasBlocked || hasRunning)
            ? `<span class="dot ${hasBlocked ? "blocked" : "working"}"></span>` : "";
          const childHTML = open
            ? `<ul class="list proj-sessions">${items.length
                ? items.map((x) => x.html).join("")
                : !mOn
                  ? `<li class="empty-hint">${esc(machineName(p.machine))} 当前离线，重连后自动同步会话</li>`
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

    // 2. Standalone Sessions Section (Below Projects — Pinned Sessions Fixed at Top)
    const loose = unarchived.filter((x) => !x.proj && matchStatus(x)).sort((x, y) =>
      ((y.pinned ? 1 : 0) - (x.pinned ? 1 : 0))
      || (x.pinned && y.pinned ? ((x.groupRank - y.groupRank) || (y.pinnedAt - x.pinnedAt) || (y.t - x.t)) : ((x.groupRank - y.groupRank) || (y.t - x.t)))
    );
    const sessTitleEl = $("#session-group-title"), sessCntEl = $("#session-count");
    if (sessTitleEl) sessTitleEl.textContent = (state.projects || []).length ? "独立会话" : "会话";
    if (sessCntEl) sessCntEl.textContent = loose.length || "";

    const pinnedLooseN = loose.filter((x) => x.pinned).length;
    const baseCap = pinnedLooseN + RECENT_N;
    let shown = extAll ? loose : loose.slice(0, baseCap);
    const cur = !shown.some((x) => x.active) && loose.find((x) => x.active);
    if (cur) shown = [...shown, cur];

    const moreBtn = loose.length > baseCap
      ? `<li><button type="button" class="more-row ${extAll ? "open" : ""}" data-act="ext-more">
          <svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
          <span>${extAll ? "收起" : `展开其余 ${loose.length - baseCap} 个`}</span>
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
      if ($("#x-chips")) $("#x-chips").hidden = true;
      syncComposerBtn($("#x-composer"));
      if (!gone) extSoon();
      return;
    }
    markExtSeen(e);
    const meta = getSessMeta(e.kind, e.machine, e.session, "x:" + e.id);
    const byCollie = isSessionByCollie(workerLookup(), { kind: e.kind, machine: e.machine, session: e.session, name: "", fallbackKey: "x:" + e.id, meta });
    const on = extOnline(e);
    $("#x-name").textContent = extName(e);
    $("#x-kind").textContent = KIND_LABEL[e.kind] || e.kind;
    const xTag = $("#x-tag");
    xTag.className = byCollie && !meta?.archived ? "head-collie-wrap" : "tag";
    xTag.hidden = !byCollie && !meta?.archived;
    xTag.innerHTML = `${byCollie ? collieMarkHTML() : ""}${meta?.archived ? "已归档" : ""}`;
    $("#x-cwd").textContent = (e.machine ? machineName(e.machine) + " · " : "") + tilde(e.cwd);

    if (e.live && !gone) {
      const stLabel = { working: "工作中", waiting: "在等后台任务", idle: "在线空闲", blocked: "等待确认" }[e.status] || "在线";
      $("#x-status").textContent = stLabel + (e.app ? ` · ${e.app}` : "");
      $("#x-status").className = "status " + (e.status || "unknown");
    } else {
      $("#x-status").textContent = gone ? "已结束" : `上次对话 ${ago(e.updated || e.started)}`;
      $("#x-status").className = "status ended";
    }

    const busyElsewhere = !!(e.live && !e.can_send && (e.status === "working" || e.status === "blocked"));
    const extWorkingNow = !!(on && !gone && e.live && e.status === "working");
    const canChat = !!(on && !busyElsewhere && (e.can_send || e.can_take_over || e.session));
    $("#x-composer").hidden = false;
    $("#x-input").disabled = !canChat;
    $("#x-input").placeholder = !on ? `${machineName(e.machine)} 当前离线，上线后可直接继续对话…`
      : busyElsewhere ? (e.status === "blocked" ? `正在 ${e.app || "原窗口"} 等待确认（当前回合仍由桌面端持有，可在桌面端直接回复，或等当前回合停下后在此回复）…` : `正在 ${e.app || "原窗口"} 中执行，当前步骤完成后即可直接发消息…`)
      : extWorkingNow ? (e.kind === "codex" ? "任务执行中，可直接输入补充指令插话（实时注入当前回合）…" : "任务执行中，可直接输入补充消息（自动排队跟进）…")
      : "输入消息继续对话…";
    $("#x-hint").textContent = canChat && e.machine ? machineName(e.machine) : "";
    syncComposerBtn($("#x-composer"));
    renderExtChips(e.kind, e.machine, e.run, canChat && !e.hub, "x:" + e.id);
    if ($("#x-thread")?._redraw) $("#x-thread")._redraw();
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
      const prevLive = e.live, prevStatus = e.status;
      e.live = true;
      e.status = "working";
      renderExt();
      renderExtHead();
      try {
        const r = await api(`/api/external/${encodeURIComponent(e.id)}/send`, { body: { text, model, effort } });
        if (r.note) toast(r.note, "attn");
        if (model || effort) e.run = [model || "", effort || ""];
        renderExt();
        renderExtHead();
        setTimeout(() => loadExternal().catch(() => {}), 800);
        return;
      } catch (err) {
        e.live = prevLive;
        e.status = prevStatus;
        renderExt();
        renderExtHead();
        if (prevLive || !e.session || /正在桌面端|占用/.test(err.message || "")) {
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
    el._streaming = null;
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
      es.addEventListener("streaming", (ev) => {
        if (!mine()) return;
        const d = JSON.parse(ev.data);
        el._streaming = d && d.text ? { text: d.text, phase: d.phase || "final_answer" } : null;
        if (el._redraw) el._redraw();
      });
      es.addEventListener("status", (ev) => {
        const st = JSON.parse(ev.data);
        if (!st.live || st.status !== "working") el._streaming = null;
        const cur = ext.find((x) => x.id === id);
        if (cur) {
          cur.live = !!st.live;
          cur.status = st.status || "";
          if (typeof st.can_send === "boolean") cur.can_send = st.can_send;
          renderExt();
          if (mine()) {
            renderExtHead();
            if (el._redraw) el._redraw();
          }
        }
      });
      es.addEventListener("messages", (ev) => { el._msgs = null; el._older = null; show(JSON.parse(ev.data)); }); // an older computer
      es.addEventListener("gone", () => { closeExt(); if (mine()) renderExtHead(true); });
      es.onerror = () => {
        if (es.readyState !== EventSource.CLOSED || extStream !== es || !mine()) return;
        const curE = ext.find((x) => x.id === id);
        if (curE && !extOnline(curE)) {
          if (!el.querySelector(".msg")) {
            el.innerHTML = `<div class="thread-empty">${esc(machineName(curE.machine))} 当前离线，电脑重新连接后即可加载对话内容并继续发消息。</div>`;
          }
          setTimeout(() => { if (extStream === es && mine()) connect(); }, 5000);
          return;
        }
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

  // ───────────────────────────── Top-Right Model Quota Popover (delegated to web/quota.js)
  let quotaTimer = null;
  const quotaUI = window.CollieQuota
    ? window.CollieQuota.initQuotaUI({
        $, api, toast, esc, hhmm, osGlyph, GLYPHS, AGENT_LABEL,
        getHubs: () => hubs, tagged,
      })
    : { loadQuotas: async () => {}, toggleQuotaPop: () => {}, renderQuotaBtn: () => {}, renderQuotaPop: () => {} };
  const loadQuotas = (fresh = false) => quotaUI.loadQuotas(fresh);
  const toggleQuotaPop = (open) => quotaUI.toggleQuotaPop(open);

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
  const unixInstallCmd = (base, args) => {
    const b = (base || location.origin).replace(/\/+$/, "");
    return `curl -fsSL ${b}/install.sh | COLLIE_HUB_MIRROR=${b} sh -s -- ${args}`;
  };
  const winCmd = (base, args) => {
    const b = (base || location.origin).replace(/\/+$/, "");
    return `powershell -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; & ([scriptblock]::Create((irm ${b}/install.ps1))) ${args}"`;
  };
  const installCmdFor = (os, args, base) => /^windows\b/i.test(os || "") ? winCmd(base, args) : unixInstallCmd(base, args);
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
    const nodeCmd = pm ? `collie ${nodeArgs} --daemon` : "";
    const installCmd = pm ? unixInstallCmd(devAddr, nodeArgs) : "";
    const installWinCmd = pm ? winCmd(devAddr, nodeArgs) : "";
    const hubCmd = installCmdFor(r.hub.os, "hub", devAddr);
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
          <div class="qr-wrap">${pb ? `<img class="qr" alt="配对二维码" src="demo-qr.png?text=${encodeURIComponent(phoneURL)}">` : ""}</div>
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
        ${machines.map((d) => {
          const dCmd = installCmdFor(d.os, "node", devAddr);
          const reconnectCmd = pm ? installCmdFor(d.os, `node --hub ${devAddr} --code ${pm.code}`, devAddr) : "";
          return `<li class="row dev-row">
          <span class="dev-ico">${osGlyph(d.os)}<span class="dot ${d.online ? "online" : "offline"}"></span></span>
          <div>
            <div class="meta"><b>${esc(d.name)}</b>${brainId === d.id ? `<span class="tag brain">Collie 大脑</span>` : ""}${d.online ? `<span class="tag online-pill">在线</span>` : `<span class="tag">离线 · 上次 ${when(d.last_seen)}</span>`}<span>${esc(d.os || "")}</span>${verTag(d.version, r.latest, dCmd)}</div>
            <div class="dev-sub">${d.home ? `<span class="dev-path">${esc(tilde(d.home))}</span>` : ""}${d.online ? agentsTag(d.agents) : ""}</div>
            ${updateRow(d.version, r.latest, dCmd, "", d.id, d.name)}
            ${!d.online ? (pm ? `<div class="update-cmd"><p class="pair-hint muted">在「${esc(d.name)}」终端执行以下命令即可恢复上线并配置守护进程与开机自启（自动复用原设备，不重复创建）：</p><div class="code"><span>${esc(reconnectCmd)}</span><button class="icon-btn" data-copy="${esc(reconnectCmd)}" title="复制"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></button></div></div>` : `<div class="update-cmd"><p class="pair-hint muted">这台电脑当前离线；若需恢复上线或修复后台守护进程：<button class="btn small" data-reconnect-dev="${esc(d.id)}" data-os-hint="${esc(d.os || "")}">生成重连命令</button></p></div>`) : ""}
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
      else if (b.dataset.reconnectDev) {
        if (/^windows/i.test(b.dataset.osHint || "")) pairOS = "win";
        else if (b.dataset.osHint) pairOS = "unix";
        await newCode("machine");
        loadDevices();
      }
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
        const delId = b.dataset.delDev;
        if (!confirm(`确定移除「${b.dataset.name}」？移除后该电脑关联的项目、会话记录和离线快照都会一并清理，需要重新配对才能再连入。`)) return;
        await api(`/api/devices/${encodeURIComponent(delId)}/delete`, { body: {} });
        if (sideMachine === delId) { sideMachine = "all"; store.set("sideMachine", "all"); }
        try {
          setLocalState(await api("/api/state"));
          await Promise.all([loadExternal(), loadHistory()]);
          renderSide();
          renderTarget(true);
        } catch {}
        loadDevices();
        toast(`已移除「${b.dataset.name}」及其关联数据`);
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
    const dMeta = getSessMeta(v.kind, v.machine, v.session, "p:" + v.pane_id);
    const byCollie = isSessionByCollie(workerLookup(), { kind: v.kind, machine: v.machine, session: v.session, name: v.name, fallbackKey: "p:" + v.pane_id, meta: dMeta });
    const dWorker = $("#d-worker");
    dWorker.className = "head-collie-wrap";
    dWorker.hidden = !byCollie;
    dWorker.innerHTML = byCollie ? collieMarkHTML() : "";
    const st = $("#d-status");
    st.className = "status " + v.status;
    st.innerHTML = `<span class="dot ${esc(v.status)}"></span>${esc(STATUS_LABEL[v.status] || v.status)}`;
    const busy = v.status === "working" || v.status === "starting";
    const ms = state.machines || [];
    const home = ms.find((m) => m.id === (v.machine || ""))?.home;
    const rawCwd = v.cwd || "";
    const cwd = home && rawCwd.length >= home.length && rawCwd.slice(0, home.length).toLowerCase() === home.toLowerCase() && (!rawCwd[home.length] || rawCwd[home.length] === "/" || rawCwd[home.length] === "\\")
      ? "~" + rawCwd.slice(home.length)
      : tilde(rawCwd);
    $("#d-cwd").textContent = (ms.length > 1 ? machineName(v.machine) + " · " : "") + cwd;
    renderWorkerModel(v);
    renderPaneChips(v);
    $("#input").placeholder = busy
      ? (v.kind === "codex" ? `正在执行，可直接输入补充指令向 ${KIND_LABEL[v.kind] || v.kind} 插话…` : `正在执行，可直接输入补充消息给 ${KIND_LABEL[v.kind] || v.kind || "Agent"}…`)
      : `给 ${KIND_LABEL[v.kind] || v.kind || "Agent"} 发消息…`;
    syncComposerBtn($("#composer"));
    if ($("#thread")?._redraw) $("#thread")._redraw();
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
    $("#thread")._sig = ""; $("#thread")._msgs = null; $("#thread")._pending = null; $("#thread")._streaming = null; $("#thread")._blocks = null; $("#thread")._older = null; showRaw = false;
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
    const s = scroller(el);
    const curKey = routeKeyFor(view, view === "ext" ? extCur : current);
    if (pendingScrollRestore && pendingScrollRestore.key === curKey && pendingScrollRestore.until > Date.now()) {
      s.scrollTop = pendingScrollRestore.top;
      pendingScrollRestore = null;
      syncAllJumpBtns();
      return;
    }
    if (!was) { syncAllJumpBtns(); return; }
    s.scrollTop = s.scrollHeight;
    requestAnimationFrame(() => { s.scrollTop = s.scrollHeight; syncAllJumpBtns(); }); // after images and code lay out
  };

  // Scroll-to-bottom buttons & scroll tracking across all conversation scrollers.
  const bindJumpScroller = (sc, btn) => {
    if (!sc || !btn) return;
    sc.addEventListener("scroll", () => {
      syncJumpBtn(sc, btn);
      saveCurrentScroll();
    }, { passive: true });
    btn.addEventListener("click", () => {
      pendingScrollRestore = null;
      sc.scrollTo({ top: sc.scrollHeight, behavior: "smooth" });
      setTimeout(() => syncJumpBtn(sc, btn), 260);
    });
  };
  bindJumpScroller($("#super-thread")?.parentElement, $("#super-jump"));
  bindJumpScroller($("#x-thread")?.parentElement, $("#x-jump"));
  bindJumpScroller($("#thread"), $("#d-jump"));

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
  // A thread's messages: the older ones loaded on request, then the live view, plus optimistic pending sends and live streaming bubble.
  const compactMsgText = (s) => String(s || "")
    .replace(/^```[A-Za-z0-9_+-]*\s*$/gm, "")
    .replace(/\[([^\]\n]+)\]\((?:<[^>\n]+>|[^)\s]+)\)/g, "$1")
    .replace(/[\s…*`|｜━─_\[\]<>]+/g, "");
  const threadMsgs = (el) => {
    reconcilePendingThreadMsgs(el);
    const base = (el._older || []).concat(el._msgs || []).concat(el._pending || []);
    const s = el._streaming;
    if (s && s.text && String(s.text).trim()) {
      const want = compactMsgText(s.text);
      let dup = false;
      for (let k = base.length - 1; k >= 0; k--) {
        if (base[k].kind === "user") break;
        if (base[k].kind === "assistant") {
          const got = compactMsgText(base[k].text);
          if (got && want && (got === want || got.startsWith(want) || got.endsWith(want))) {
            dup = true;
            break;
          }
        }
      }
      if (!dup) {
        return base.concat([{ kind: "assistant", text: s.text, phase: s.phase || "final_answer", streaming: true }]);
      }
    }
    return base;
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
    grow(input);
    syncComposerBtn(form);
    if (form._submit) form._submit(); else form.requestSubmit();
  });
  function isThreadActivelyWorking(el) {
    if (el.id === "thread") {
      const v = find(current);
      if (v && (v.status === "working" || v.status === "starting")) return true;
      return lastLive?.status === "working";
    }
    if (el.id === "x-thread" && extCur && !extCur.startsWith("h:")) {
      const e = ext.find((x) => x.id === extCur);
      return !!(e && e.live && e.status === "working");
    }
    return false;
  }

  function renderToolRunHTML(run, start, open) {
    const row = (t, k) => {
      const cls = t.error ? "err" : (t.output ? "" : "pending");
      return `<details class="tool ${cls}" data-i="${k}" ${open.has(String(k)) ? "open" : ""}>`
        + `<summary><span class="tname">${esc(t.name)}</span><span class="targ">${esc(t.input)}</span></summary>`
        + (t.output ? `<pre>${esc(t.output)}</pre>` : "") + `</details>`;
    };
    if (run.length <= 3 || !prefs.fold()) {
      return `<div class="tools">${run.map((t, k) => row(t, start + k)).join("")}</div>`;
    }
    const key = "run" + start;
    const names = [...new Set(run.map((t) => t.name))].slice(0, 4).join("、");
    const errs = run.filter((t) => t.error).length;
    return `<div class="tools"><details class="toolrun" data-i="${key}" ${open.has(key) ? "open" : ""}>`
      + `<summary><span class="n">${run.length} 个步骤</span><span class="targ">${esc(names)}${errs ? ` · <b class="errs">${errs} 个出错</b>` : ""}</span></summary>`
      + `<div class="toolrun-body">${run.slice(0, -1).map((t, k) => row(t, start + k)).join("")}</div>`
      + `</details>${row(run[run.length - 1], start + run.length - 1)}</div>`;
  }

  function renderProcessItemsHTML(procItems, open) {
    let out = "", p = 0;
    while (p < procItems.length) {
      if (procItems[p].m.kind === "tool") {
        const s = p;
        const run = [];
        while (p < procItems.length && procItems[p].m.kind === "tool") {
          run.push(procItems[p].m);
          p++;
        }
        out += renderToolRunHTML(run, procItems[s].idx, open);
      } else {
        const pm = procItems[p].m;
        const rCls = (pm.phase === "reasoning" ? " reasoning" : "") + (pm.streaming ? " streaming" : "");
        const pmRendered = md(pm.text);
        out += `<div class="msg-note${rCls}">${pmRendered}${imagesIn(pm.text)}${artifactsIn(pm.text, pmRendered)}</div>`;
        p++;
      }
    }
    return out;
  }

  function drawThread(msgs, el = $("#thread"), empty = "还没有对话。发一条消息开始吧。") {
    // Just opened: start at the latest message.
    const was = el._fresh || nearBottom(el) || !el.childElementCount;
    if (msgs.length) el._fresh = false;
    const open = new Set($$("details.tool[open], details.toolrun[open], details.turn-proc[open]", el).map((d) => d.dataset.i));
    if (!msgs.length) { el.innerHTML = `<div class="thread-empty">${empty}</div>`; el._sig = ""; el._blocks = null; return; }
    const threadWorking = isThreadActivelyWorking(el);
    const blocks = [];
    let html = "", i = 0;
    const cut = () => { if (html) { blocks.push(html); html = ""; } };

    const emitAsk = (m, idx) => {
      if (m.name === "recap") {
        html += `<div class="recap-note">${esc(m.input)}</div>`;
        cut();
        return;
      }
      const later = msgs.slice(idx + 1).some((x) => x.kind === "user");
      const replyable = m.name === "wrap_up" || m.name === "request_user_input_async";
      const isOpen = replyable ? !later && !m.output : !m.output && !later;
      const form = el.closest("section.view")?.querySelector("form.composer:not([hidden])");
      const canReplyHere = replyable && !/\n2\.\s/.test(m.text || "") && (!form || !form.querySelector("textarea")?.disabled);
      const opts = (m.options || []).map((o) => canReplyHere && isOpen
        ? `<button type="button" class="btn small" data-act="ask-reply" data-text="${esc(o)}">${esc(o)}</button>`
        : `<span class="opt">${esc(o)}</span>`).join("");
      const whereHint = isOpen && !canReplyHere
        ? (el.id === "x-thread" && /^cd-/.test(extCur || "")
          ? `<div class="where"><button type="button" class="btn small" data-act="ask-reveal">去 Claude 桌面版回答</button><span>这个对话框只能在电脑上答</span></div>`
          : m.name === "request_user_input_async"
            ? `<div class="where">${form && !form.querySelector("textarea")?.disabled ? "在下方输入框直接回复即可继续" : "可在电脑端 Codex 直接回答，或等当前后台步骤停下后在此回复"}</div>`
            : el.id === "thread" ? "" : `<div class="where">在电脑上的会话里回答</div>`)
        : "";
      html += `<div class="ask-card ${isOpen ? "open" : ""}">`
        + (m.input ? `<div class="recap">${esc(m.input)}</div>` : "")
        + `<div class="q"><span class="dot ${isOpen ? "blocked" : "unknown"}"></span>${esc(m.text)}</div>`
        + (opts ? `<div class="opts">${opts}</div>` : "")
        + (m.output ? `<div class="answer">${esc(m.output)}</div>` : whereHint)
        + `</div>`;
      cut();
    };

    const flushProcessGroup = (procItems, startIdx, isLiveGroup) => {
      if (!procItems.length) return;
      if (isLiveGroup || !prefs.fold()) {
        html += `<div class="turn-live-proc">${renderProcessItemsHTML(procItems, open)}</div>`;
        cut();
        return;
      }
      const key = "proc" + startIdx;
      const toolList = procItems.filter((x) => x.m.kind === "tool").map((x) => x.m);
      const noteCount = procItems.length - toolList.length;
      const errs = toolList.filter((t) => t.error).length;
      const toolNames = [...new Set(toolList.map((t) => t.name))].slice(0, 4).join("、");
      const metaParts = [];
      if (noteCount) metaParts.push(`${noteCount} 段思路`);
      if (toolList.length) metaParts.push(`${toolList.length} 个工具调用${toolNames ? "（" + toolNames + "）" : ""}`);
      const subSummary = metaParts.join(" · ");
      html += `<details class="turn-proc" data-i="${key}" ${open.has(key) ? "open" : ""}>`
        + `<summary><svg class="tp-chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg><span class="tp-title">思考与执行过程</span>`
        + (subSummary ? `<span class="tp-sub">${esc(subSummary)}${errs ? ` · <b class="errs">${errs} 个出错</b>` : ""}</span>` : "")
        + `</summary><div class="turn-proc-body">${renderProcessItemsHTML(procItems, open)}</div></details>`;
      cut();
    };

    while (i < msgs.length) {
      if (msgs[i].kind === "user") {
        const m = msgs[i];
        const uKey = `t:${i}:${(m.text || "").length}:${String(m.text || "").slice(0, 20)}`;
        html += `<div class="msg user${m.pending ? " pending" : ""}">${userText(m.text, uKey)}</div>`;
        cut();
        i++;
        continue;
      }
      // One agent turn segment (all consecutive non-user items up to the next user message).
      const segStart = i;
      let segEnd = i;
      while (segEnd < msgs.length && msgs[segEnd].kind !== "user") segEnd++;
      const isLastSeg = segEnd === msgs.length;
      const segHasFinal = msgs.slice(segStart, segEnd).some((x) => x.kind === "assistant" && x.phase === "final_answer" && !x.streaming);
      const segWorking = isLastSeg && threadWorking && !segHasFinal;

      // Determine the final conclusion message of this turn (if any):
      // 1) Explicit Codex `phase === "final_answer"`
      // 2) For Claude/Agy/Gemini (no phase field): once the turn is settled (!segWorking),
      //    the last non-process assistant message is the conclusion, while any earlier
      //    assistant narration before tool calls folds into the reasoning/execution drawer.
      let finalIdx = -1;
      for (let k = segEnd - 1; k >= segStart; k--) {
        if (msgs[k].kind === "assistant" && msgs[k].phase === "final_answer" && !msgs[k].streaming) {
          finalIdx = k;
          break;
        }
      }
      if (finalIdx < 0 && !segWorking) {
        for (let k = segEnd - 1; k >= segStart; k--) {
          const mk = msgs[k];
          if (mk.kind === "assistant" && mk.phase !== "commentary" && mk.phase !== "reasoning") {
            finalIdx = k;
            break;
          }
        }
      }

      let procBuf = [];
      let procStart = segStart;
      for (let k = segStart; k < segEnd; k++) {
        const mk = msgs[k];
        if (mk.kind === "ask") {
          flushProcessGroup(procBuf, procStart, segWorking);
          procBuf = [];
          emitAsk(mk, k);
          continue;
        }
        // Keep any actively streaming non-reasoning bubble AND any non-commentary assistant
        // message that has no subsequent tool/reasoning/commentary step after it in the main thread!
        const hasStepAfter = (idx) => {
          for (let j = idx + 1; j < segEnd; j++) {
            const mj = msgs[j];
            if (mj.kind === "tool" || mj.phase === "commentary" || mj.phase === "reasoning") return true;
          }
          return false;
        };
        const isFinal = k === finalIdx || (mk.kind === "assistant" && (
          (mk.phase === "final_answer" && !mk.streaming)
          || (mk.streaming && mk.phase !== "reasoning")
          || (!segWorking && mk.phase !== "commentary" && mk.phase !== "reasoning" && !hasStepAfter(k))
        ));
        const isProc = !isFinal && (
          mk.kind === "tool"
          || mk.phase === "commentary"
          || mk.phase === "reasoning"
          || (mk.kind === "assistant" && (segWorking || (finalIdx > k && hasStepAfter(k))))
        );
        if (isProc) {
          if (!procBuf.length) procStart = k;
          procBuf.push({ m: mk, idx: k });
          continue;
        }
        flushProcessGroup(procBuf, procStart, segWorking);
        procBuf = [];
        const rendered = md(mk.text);
        const extraImgs = imagesIn(mk.text);
        const extraArts = mk.streaming ? "" : artifactsIn(mk.text, rendered);
        html += `<div class="msg assistant${mk.streaming ? " streaming" : ""}">${rendered}${extraImgs}${extraArts}</div>`;
        cut();
      }
      flushProcessGroup(procBuf, procStart, segWorking);
      i = segEnd;
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
    const prevLiveSt = lastLive?.status;
    const prevStream = (lastLive?.stream_phase || "") + "|" + (lastLive?.streaming || "");
    lastLive = l;
    const th = $("#thread");
    const nextText = l.status === "working" && l.streaming ? l.streaming : "";
    const nextPhase = l.stream_phase || "final_answer";
    const nextStream = nextText ? (nextPhase + "|" + nextText) : "";
    if (th) {
      th._streaming = nextText ? { text: nextText, phase: nextPhase } : null;
    }
    if (prevLiveSt !== l.status || prevStream !== nextStream) {
      if (prevLiveSt !== l.status) syncComposerBtn($("#composer"));
      if (th?._redraw) th._redraw();
    }
    $("#thread").classList.toggle("asking", l.status === "blocked" && !!l.approval);
    const box = $("#live");
    const was = nearBottom(th);
    let html = "";
    if (l.status === "working" && (l.tail || (!nextText && l.meta))) {
      html = `<div class="live-working"><span class="dot working"></span><pre>${esc(l.tail || "正在生成回复…")}</pre>${l.meta ? `<span class="meta">${esc(l.meta)}</span>` : ""}</div>`;
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
  const FILE_RE = /(^|[\s`(（：，、；>;])((?:(?:~|\/)[\w.\-+@%~\/\\]*|[A-Za-z]:[\\/][\w.\-+@%~\/\\]*)[\\/][\w.\-+@%~]+\.[A-Za-z0-9]{1,8})(?![\w\/\\])/g;

  // ───────────────────────────── file viewer & lightbox
  // A file an agent mentions opens here, read-only, from the computer it is on.
  const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;
  const MD_EXT = /\.(md|markdown|mdx)$/i;
  const FILE_DL_MAX = 100 * (1 << 20);
  const IMG_TYPE = { svg: "image/svg+xml", jpg: "image/jpeg", jpeg: "image/jpeg", ico: "image/x-icon" };
  const wideFileHash = (path, machine = "") => {
    const q = new URLSearchParams({ path });
    if (machine) q.set("machine", machine);
    return "#/file?" + q.toString();
  };
  function fileContextMachine() {
    if (view === "file") return wideOpenFile?.machine;
    if (view === "pane") return find(current)?.machine;
    if (view === "ext") {
      const id = extCur || "";
      return (id.startsWith("h:") ? hist.find((h) => h.id === id.slice(2)) : ext.find((x) => x.id === id))?.machine;
    }
  }
  async function fetchFile(path, machine) {
    const clean = String(path || "").split(/[?#]/)[0];
    const asParam = IMG_EXT.test(clean) ? "&as=image" : /\.pdf$/i.test(clean) ? "&as=pdf" : "";
    const q = `/api/file?path=${encodeURIComponent(path)}${machine ? "&machine=" + encodeURIComponent(machine) : ""}${asParam}`;
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
  let fileUrl = "", wideFileUrl = "", fileSeq = 0, wideSeq = 0;
  let lbUrl = "", lbSeq = 0, lbItems = [], lbIdx = 0;

  function collectImageGallery(triggerEl, fallbackPath) {
    const scope = triggerEl?.closest(".rv-md") || triggerEl?.closest(".fv-md") || triggerEl?.closest(".mem-body") || triggerEl?.closest(".thread") || triggerEl?.closest(".msg") || triggerEl?.closest(".thumbs");
    if (!scope) return { items: [fallbackPath], index: 0 };
    const seen = new Set(), items = [];
    const push = (p) => { if (p && !seen.has(p)) { seen.add(p); items.push(p); } };
    for (const el of scope.querySelectorAll(".thumb[data-img], a.fpath[data-path]")) {
      const p = el.dataset.img || el.dataset.path || "";
      if (el.dataset.img || IMG_EXT.test(p.split(/[?#]/)[0])) push(p);
    }
    if (!seen.has(fallbackPath)) push(fallbackPath);
    const idx = Math.max(0, items.indexOf(fallbackPath));
    return { items, index: idx };
  }
  function syncLbZoomUI(zoomed) {
    const btn = $("#ilb-zoom");
    if (btn) btn.textContent = zoomed ? "2x" : "1x";
  }
  function syncLbGalleryUI() {
    const cnt = $("#ilb-count"), prev = $("#ilb-prev"), next = $("#ilb-next");
    const many = lbItems.length > 1;
    if (cnt) {
      cnt.hidden = !many;
      cnt.textContent = many ? `${lbIdx + 1} / ${lbItems.length}` : "";
    }
    if (prev) prev.hidden = !many;
    if (next) next.hidden = !many;
  }
  function closeImageModal() {
    const dlg = $("#img-lightbox");
    if (!dlg) return;
    lbSeq++;
    if (dlg.open) dlg.close();
    const img = $("#ilb-img");
    if (img) { img.removeAttribute("src"); img.hidden = true; img.classList.remove("zoomed"); }
    syncLbZoomUI(false);
    if (lbUrl) { URL.revokeObjectURL(lbUrl); lbUrl = ""; }
  }
  async function showLbAt(index) {
    if (!lbItems.length) return;
    lbIdx = ((index % lbItems.length) + lbItems.length) % lbItems.length;
    const path = lbItems[lbIdx];
    const dlg = $("#img-lightbox"), img = $("#ilb-img"), note = $("#ilb-note"), dl = $("#ilb-dl"), openBtn = $("#ilb-open");
    if (!dlg || !img) return;
    const seq = ++lbSeq;
    const isHttp = /^https?:\/\//i.test(path);
    const fname = (path.split(/[?#]/)[0].split(/[\\/]/).pop() || "image.png");
    $("#ilb-name").textContent = fname;
    $("#ilb-info").textContent = isHttp ? path : tilde(path);
    img.classList.remove("zoomed");
    syncLbZoomUI(false);
    syncLbGalleryUI();
    dl.hidden = true;
    if (openBtn) openBtn.hidden = true;
    if (lbUrl) { URL.revokeObjectURL(lbUrl); lbUrl = ""; }

    const bindReady = (srcUrl) => {
      note.hidden = true;
      img.src = srcUrl;
      img.hidden = false;
      dl.href = srcUrl;
      dl.download = fname;
      dl.hidden = false;
      if (openBtn) { openBtn.href = srcUrl; openBtn.hidden = false; }
    };

    if (isHttp) {
      bindReady(path);
      if (!dlg.open) dlg.showModal();
      return;
    }

    const cached = thumbs.get(path);
    if (cached) {
      bindReady(cached);
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
      bindReady(lbUrl);
    } catch (err) {
      if (seq !== lbSeq || cached) return;
      note.textContent = err.message || "原图读取失败";
      note.hidden = false;
    }
  }
  async function openImageModal(path, triggerEl = null) {
    const g = collectImageGallery(triggerEl, path);
    lbItems = g.items;
    return showLbAt(g.index);
  }
  $("#img-lightbox")?.addEventListener("click", (ev) => {
    if (ev.target.closest("[data-ilb-close]")) { closeImageModal(); return; }
    if (ev.target.closest("#ilb-prev")) { ev.preventDefault(); showLbAt(lbIdx - 1); return; }
    if (ev.target.closest("#ilb-next")) { ev.preventDefault(); showLbAt(lbIdx + 1); return; }
    if (ev.target.closest("#ilb-zoom") || ev.target.id === "ilb-img") {
      const img = $("#ilb-img");
      if (img && !img.hidden) {
        const z = img.classList.toggle("zoomed");
        syncLbZoomUI(z);
      }
      return;
    }
    if (ev.target === $("#img-lightbox") || ev.target.hasAttribute("data-ilb-backdrop")) closeImageModal();
  });
  document.addEventListener("keydown", (ev) => {
    const dlg = $("#img-lightbox");
    if (!dlg?.open) return;
    if (ev.key === "ArrowLeft" && lbItems.length > 1) { ev.preventDefault(); showLbAt(lbIdx - 1); }
    else if (ev.key === "ArrowRight" && lbItems.length > 1) { ev.preventDefault(); showLbAt(lbIdx + 1); }
  });
  $("#img-lightbox")?.addEventListener("close", () => {
    lbSeq++;
    if (lbUrl) { URL.revokeObjectURL(lbUrl); lbUrl = ""; }
  });

  const HL = window.CollieHighlight || { HL_MAX_BYTES: 200 * 1024, HL_MAX_LINES: 5000, detectCodeLang: () => null, highlightCode: (c) => esc(c) };
  const MATH = window.CollieMath || { renderMath: (s) => esc(s), extractMathSegments: (s) => s };
  let fileRawText = "", wideRawText = "";
  let currentOpenFile = null, wideOpenFile = null;
  function setFileHead(langLabel = "", rawText = "", copyable = false) {
    fileRawText = rawText || "";
    const lEl = $("#fv-lang"), cWrap = $("#fv-copy-wrap"), cBtn = $("#fv-copy"), dlBtn = $("#fv-dl"), wideBtn = $("#fv-wide");
    if (lEl) { lEl.hidden = !langLabel; lEl.textContent = langLabel; }
    if (cWrap) cWrap.hidden = !copyable;
    if (dlBtn) dlBtn.hidden = !currentOpenFile;
    if (wideBtn) {
      wideBtn.hidden = !currentOpenFile;
      if (currentOpenFile) wideBtn.href = wideFileHash(currentOpenFile.path, currentOpenFile.machine || "");
    }
    if (cBtn) {
      cBtn.removeAttribute("data-copied");
      cBtn.removeAttribute("data-failed");
      if (cBtn.nextElementSibling) cBtn.nextElementSibling.textContent = "";
    }
  }
  function setWideHead(langLabel = "", rawText = "", copyable = false) {
    wideRawText = rawText || "";
    const lEl = $("#rv-lang"), cWrap = $("#rv-copy-wrap"), cBtn = $("#rv-copy"), dlBtn = $("#rv-dl");
    if (lEl) { lEl.hidden = !langLabel; lEl.textContent = langLabel; }
    if (cWrap) cWrap.hidden = !copyable;
    if (dlBtn) dlBtn.hidden = !wideOpenFile;
    if (cBtn) {
      cBtn.removeAttribute("data-copied");
      cBtn.removeAttribute("data-failed");
      if (cBtn.nextElementSibling) cBtn.nextElementSibling.textContent = "";
    }
  }

  async function renderCodeOrTextInto(body, path, f, headSetter, codeId) {
    const text = await f.blob.text();
    const cut = f.size > f.blob.size ? `<p class="fv-note muted">文件有 ${fmtSize(f.size)}，这里只显示前 1 MB。</p>` : "";
    if (MD_EXT.test(path)) {
      headSetter("Markdown", text, true);
      body.innerHTML = `<div class="msg assistant fv-md" id="${codeId}">${mdRender(text)}</div>${cut}`;
      return;
    }
    const lang = HL.detectCodeLang(path, true);
    headSetter(lang ? lang.label : "", text, true);
    const norm = text.replace(/\r\n/g, "\n").replace(/\n$/, "");
    let lines = 1;
    for (let i = 0; i < norm.length && lines <= HL.HL_MAX_LINES + 1; i++) if (norm.charCodeAt(i) === 10) lines++;
    if (lang && norm.length <= HL.HL_MAX_BYTES && lines <= HL.HL_MAX_LINES) {
      const nums = Array.from({ length: lines }, (_, i) => i + 1).join("\n");
      body.classList.add("is-code");
      body.innerHTML = `<div class="fv-code"><div class="fv-ln" aria-hidden="true">${nums}</div><pre class="fv-pre"><code id="${codeId}">${HL.highlightCode(norm, lang.id)}</code></pre></div>${cut}`;
    } else if (lang) {
      body.classList.add("is-code");
      body.innerHTML = `<pre class="fv-pre fv-large" id="${codeId}">${esc(norm)}</pre>${cut}`;
    } else {
      body.innerHTML = `<pre class="fv-pre" id="${codeId}">${esc(text)}</pre>${cut}`;
    }
  }

  async function openFile(path, triggerEl = null) {
    if (IMG_EXT.test((path || "").split(/[?#]/)[0])) {
      return openImageModal(path, triggerEl);
    }
    const body = $("#fv-body"), seq = ++fileSeq;
    body.classList.remove("is-code", "is-flush");
    currentOpenFile = null;
    setFileHead("", "", false);
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
    currentOpenFile = { path: path, displayPath: f.path || path, machine: f.machine };
    const dlBtn = $("#fv-dl"), wideBtn = $("#fv-wide");
    if (dlBtn) dlBtn.hidden = !(f.size >= 0 && f.size <= FILE_DL_MAX);
    if (wideBtn) { wideBtn.hidden = false; wideBtn.href = wideFileHash(path, f.machine || ""); }
    if (fileUrl) { URL.revokeObjectURL(fileUrl); fileUrl = ""; }
    if (f.kind === "image") {
      const ext = path.split(".").pop().toLowerCase();
      fileUrl = URL.createObjectURL(new Blob([f.blob], { type: IMG_TYPE[ext] || "image/" + ext }));
      const where = (state.machines || []).length > 1 ? machineName(f.machine) + " · " : "";
      $("#fv-path").textContent = where + f.path + " · " + fmtSize(f.size);
      body.innerHTML = `<div class="fv-img"><img src="${fileUrl}" alt=""></div>`;
      return;
    }
    const setObjectURL = (blob) => {
      if (fileUrl) URL.revokeObjectURL(fileUrl);
      fileUrl = URL.createObjectURL(blob);
      return fileUrl;
    };
    if (await artifactUI.renderRichFilePane(path, f, setObjectURL)) {
      body.scrollTop = body.scrollLeft = 0;
      return;
    }
    if (seq !== fileSeq) return;
    const where = (state.machines || []).length > 1 ? machineName(f.machine) + " · " : "";
    $("#fv-path").textContent = where + f.path + " · " + fmtSize(f.size);
    await renderCodeOrTextInto(body, path, f, setFileHead, "fv-code-src");
    body.scrollTop = body.scrollLeft = 0;
  }

  async function openWideFile(path, machineHint = "") {
    const body = $("#rv-body"), sc = $("#rv-scroller"), seq = ++wideSeq;
    if (!body) return;
    body.classList.remove("is-code", "is-flush");
    wideOpenFile = null;
    setWideHead("", "", false);
    if (!path) {
      $("#rv-name").textContent = "未指定文件";
      $("#rv-path").textContent = "";
      body.innerHTML = `<p class="fv-note muted">缺少文件路径参数。</p>`;
      return;
    }
    const fname = path.split(/[\\/]/).pop() || path;
    $("#rv-name").textContent = fname;
    $("#rv-path").textContent = path;
    document.title = `${fname} · Collie`;
    body.innerHTML = `<p class="fv-note muted">读取中…</p>`;
    const tries = machineHint ? [machineHint, ...fileTries().filter((m) => m !== machineHint)] : fileTries();
    let f = null;
    try {
      f = await findFile(path, tries);
    } catch (e) { body.innerHTML = `<p class="fv-note">${esc(e.message)}</p>`; return; }
    if (seq !== wideSeq) return;
    if (!f) { body.innerHTML = `<p class="fv-note">在${tries.length > 1 ? "各台电脑" : "这台电脑"}上都没找到这个文件。</p>`; return; }
    wideOpenFile = { path, machine: f.machine };
    const dlBtn = $("#rv-dl");
    if (dlBtn) dlBtn.hidden = !(f.size >= 0 && f.size <= FILE_DL_MAX);
    if (wideFileUrl) { URL.revokeObjectURL(wideFileUrl); wideFileUrl = ""; }
    if (f.kind === "image") {
      const ext = path.split(".").pop().toLowerCase();
      wideFileUrl = URL.createObjectURL(new Blob([f.blob], { type: IMG_TYPE[ext] || "image/" + ext }));
      const where = (state.machines || []).length > 1 ? machineName(f.machine) + " · " : "";
      $("#rv-path").textContent = where + f.path + " · " + fmtSize(f.size);
      body.innerHTML = `<div class="fv-img rv-img"><img src="${wideFileUrl}" data-wide-img="${esc(path)}" alt="${esc(fname)}"></div>`;
      return;
    }
    const setObjectURL = (blob) => {
      if (wideFileUrl) URL.revokeObjectURL(wideFileUrl);
      wideFileUrl = URL.createObjectURL(blob);
      return wideFileUrl;
    };
    const wideDone = await artifactUI.renderRichFilePane(path, f, setObjectURL, {
      body, pathEl: $("#rv-path"), setHead: setWideHead, codeId: "rv-code-src", wide: true,
    });
    if (seq !== wideSeq) return;
    if (!wideDone) {
      const where = (state.machines || []).length > 1 ? machineName(f.machine) + " · " : "";
      $("#rv-path").textContent = where + f.path + " · " + fmtSize(f.size);
      await renderCodeOrTextInto(body, path, f, setWideHead, "rv-code-src");
    }
    if (sc) sc.scrollTop = sc.scrollLeft = 0;
  }

  const artifactUI = window.CollieArtifacts
    ? window.CollieArtifacts.initArtifacts({
        $, esc, tilde, fmtSize, toast, routeReq, fileTries, findFile,
        machineName, getMachinesCount: () => (state.machines || []).length,
        mdRender: (s) => mdRender(s), showFilePane: () => showFilePane(),
        openFile: (p) => openFile(p), setFileHead, HL,
      })
    : { artifactsIn: () => "", renderRichFilePane: async () => false };
  const artifactsIn = (t, renderedHTML = "") => artifactUI.artifactsIn(t, renderedHTML);
  $("#fv-dl")?.addEventListener("click", (ev) => {
    if (!currentOpenFile || !artifactUI.downloadArtifact) return;
    artifactUI.downloadArtifact(currentOpenFile.path, currentOpenFile.machine, ev.currentTarget);
  });
  $("#rv-dl")?.addEventListener("click", (ev) => {
    if (!wideOpenFile || !artifactUI.downloadArtifact) return;
    artifactUI.downloadArtifact(wideOpenFile.path, wideOpenFile.machine, ev.currentTarget);
  });
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
  const copyTimers = new WeakMap();
  let lastCopyMsg = "";
  function reportCopy(button, ok) {
    const tip = button.nextElementSibling;
    clearTimeout(copyTimers.get(button));
    button.removeAttribute("data-copied");
    button.removeAttribute("data-failed");
    let msg = ok ? "已复制" : "复制失败";
    if (msg === lastCopyMsg) msg += "\u00A0";
    lastCopyMsg = msg;
    if (tip) tip.textContent = "";
    void button.offsetWidth;
    button.setAttribute(ok ? "data-copied" : "data-failed", "");
    if (tip) requestAnimationFrame(() => { tip.textContent = msg; });
    copyTimers.set(button, setTimeout(() => {
      button.removeAttribute("data-copied");
      button.removeAttribute("data-failed");
      if (tip) tip.textContent = "";
    }, 1800));
  }
  $("#fv-copy")?.addEventListener("click", async (ev) => {
    const btn = ev.currentTarget;
    const text = fileRawText || $("#fv-code-src")?.textContent || "";
    if (!text) return;
    reportCopy(btn, await copyText(text));
  });
  $("#rv-copy")?.addEventListener("click", async (ev) => {
    const btn = ev.currentTarget;
    const text = wideRawText || $("#rv-code-src")?.textContent || "";
    if (!text) return;
    reportCopy(btn, await copyText(text));
  });

  document.addEventListener("click", async (ev) => {
    const cm = ev.target.closest("[data-copy-tex]");
    if (cm) {
      const tex = cm.dataset.copyTex || "";
      if (await copyText(tex)) {
        cm.classList.add("copied");
        toast("已复制 LaTeX 公式");
        clearTimeout(cm._t);
        cm._t = setTimeout(() => cm.classList.remove("copied"), 1500);
      }
      return;
    }
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
    const e = chatEntries().find((x) => x.id === b.dataset.copy);
    if (e) toast(await copyText(e.text) ? "已复制" : "复制失败", "");
  });
  // A reply's quote of your message: take you to it.
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a.re[data-goto]");
    if (!a) return;
    e.preventDefault();
    jumpToEntry(a.dataset.goto);
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
    if (t) { e.preventDefault(); openImageModal(t.dataset.img, t); return; }
    const wideImg = e.target.closest(".rv-img img[data-wide-img]");
    if (wideImg) { e.preventDefault(); openImageModal(wideImg.dataset.wideImg, wideImg); return; }
    const a = e.target.closest("a.fpath");
    if (!a) return;
    e.preventDefault();
    const p = a.dataset.path;
    if (view === "file" && !IMG_EXT.test((p || "").split(/[?#]/)[0])) {
      location.hash = wideFileHash(p, wideOpenFile?.machine || "");
      return;
    }
    openFile(p, a);
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
    const inlineMath = [];
    let text = String(src || "").replace(/[\u0000\u0001\u0003\u0004]/g, "").replace(/```([^\n`]*)\n([\s\S]*?)(```|$)/g, (_, lang, code) => {
      const raw = code.replace(/\n$/, "");
      const tag = (lang || "").trim().split(/\s+/)[0];
      const detected = HL.detectCodeLang(lang, false);
      const label = detected ? detected.label : (tag || "code");
      const rendered = detected ? HL.highlightCode(raw, detected.id) : esc(raw);
      blocks.push(`<div class="codeblock"><div class="code-bar"><span class="code-lang">${esc(label)}</span><button type="button" class="code-copy" data-copy-code>${ICON_COPY}<span>复制</span></button></div><pre><code${detected ? ` data-lang="${esc(detected.id)}"` : ""}>${rendered}</code></pre></div>`);
      return `\u0000${blocks.length - 1}\u0000`;
    });
    text = MATH.extractMathSegments(
      text,
      (html) => blocks.push(html) - 1,
      (html) => inlineMath.push(html) - 1,
      ICON_COPY
    );
    text = esc(text);
    const URL_RE = /(?<![="'>\w\/])https?:\/\/[^\s<>"，。；：、！？）」』】（「『【]+/g;
    const trimBalancedURL = (raw) => {
      let u = raw, tail = "";
      while (u.length) {
        const m = u.match(/(?:&quot;|&#39;|[.,;:!?'`]+)$/);
        if (m) { tail = m[0] + tail; u = u.slice(0, -m[0].length); continue; }
        const last = u[u.length - 1];
        if (last === ")" && (u.split("(").length - 1) < (u.split(")").length - 1)) { tail = ")" + tail; u = u.slice(0, -1); continue; }
        if (last === "]" && (u.split("[").length - 1) < (u.split("]").length - 1)) { tail = "]" + tail; u = u.slice(0, -1); continue; }
        break;
      }
      return [u, tail];
    };
    const urlLabel = (u) => {
      const raw = u.replace(/&amp;/g, "&").replace(/^https?:\/\//, "").replace(/\/$/, "");
      return esc(raw.length > 42 ? raw.slice(0, 40) + "…" : raw);
    };
    const parseInlineCodePath = (raw) => {
      if (!raw || raw.includes("://") || raw.startsWith("//") || /[<>"'`*?;$&|()]/.test(raw)) return "";
      const base = raw.replace(/(?:#L\d+(?:-L?\d+)?|:\d+(?:[-:]\d+)?)$/i, "").trim();
      const isUnix = /^(?:~[\\/](?:[^\\/:\r\n]+[\\/])*|\/(?:[\w.\-+@%~\u4e00-\u9fff]+[\\/])+)[\w.\-+@%~\u4e00-\u9fff ]*[A-Za-z0-9_\u4e00-\u9fff]\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(base);
      const isWin = /^[A-Za-z]:[\\/](?:[^<>:"|?*\r\n]+[\\/])*[^<>:"|?*\\/\r\n]+\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(base);
      if (!isUnix && !isWin) return "";
      if (!isWin && /\s/.test(base) && !base.startsWith("~/") && !base.startsWith("/Users/") && !base.startsWith("/home/") && !base.startsWith("/tmp/")) return "";
      const stripped = base.replace(/^(?:~[\\/]|[A-Za-z]:[\\/]|\/)/, "");
      const segs = stripped.split(/[\\/]/);
      if (segs.some((seg) => !seg || seg === "." || /^\.{2,}$/.test(seg))) return "";
      return base;
    };
    const isPureHttpUrl = (raw) => {
      if (!/^https?:\/\/[^\x00-\x20<>"'`]+$/i.test(raw)) return false;
      try {
        const u = new URL(raw);
        if (u.protocol !== "http:" && u.protocol !== "https:") return false;
        const h = u.hostname;
        if (!h || h.startsWith(".") || h.endsWith(".")) return false;
        return h === "localhost" || h.includes(".") || h.startsWith("[") || Boolean(u.port);
      } catch {
        return false;
      }
    };
    const inline = (s) => {
      const spans = [];
      const hold = (h) => `\u0001${spans.push(h) - 1}\u0001`;
      return s
        .replace(/`([^`\n]+)`/g, (_, c) => {
          const raw = unesc(c).trim();
          const cleanP = parseInlineCodePath(raw);
          if (cleanP) {
            const ep = esc(cleanP);
            return hold(`<a class="fpath code-fpath" href="#" data-path="${ep}" title="打开 ${ep}"><code class="code-link">${c}</code></a>`);
          }
          if (isPureHttpUrl(raw)) {
            const eu = esc(raw);
            return hold(`<a class="url code-url" href="${eu}" target="_blank" rel="noopener noreferrer" title="${eu}"><code class="code-link">${c}</code></a>`);
          }
          return hold(`<code>${c}</code>`);
        })
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
        .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
        .replace(/\[image:((?:~[\\/]|\/|[A-Za-z]:[\\/])[^\]\r\n]+\.(?:png|jpe?g|gif|webp|svg|bmp))\]/gi, (_, p) => {
          const raw = p.replace(/&amp;/g, "&");
          return hold(`<span class="thumbs">${thumbBtn(raw)}</span>`);
        })
        .replace(/!\[([^\]\n]*)\]\((https?:\/\/[^)\s"]+)\)/g, (_, alt, u) => hold(`<span class="thumbs"><button type="button" class="thumb" data-img="${u}" aria-label="点击查看原图"><img src="${u}" alt="${alt}"></button></span>`))
        .replace(/!\[([^\]\n]*)\]\(&lt;(?:file:\/\/\/?)?((?:\/|~[\\/]|[A-Za-z]:[\\/])[^&#\r\n]*?(?:&amp;[^&#\r\n]*?)*\.(?:png|jpe?g|gif|webp|svg|bmp))(?:#[^&\r\n]*)?&gt;\)/gi, (_, alt, p) => {
          let raw = p.replace(/&amp;/g, "&");
          try { raw = decodeURI(raw); } catch {}
          return hold(`<span class="thumbs">${thumbBtn(raw)}</span>`);
        })
        .replace(/!\[([^\]\n]*)\]\((?:file:\/\/\/?)?((?:\/|~[\\/]|[A-Za-z]:[\\/])[^)\s"#]+\.(?:png|jpe?g|gif|webp|svg|bmp))(?:#[^)\s"]*)?\)/gi, (_, alt, p) => {
          let raw = p.replace(/&amp;/g, "&");
          try { raw = decodeURI(raw); } catch {}
          return hold(`<span class="thumbs">${thumbBtn(raw)}</span>`);
        })
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s"]+)\)/g, (_, l, u) => hold(`<a href="${u}" target="_blank" rel="noopener noreferrer">${l}</a>`))
        // [MergeStatus.tsx](file:///…/MergeStatus.tsx#L67-L84) or [图](<C:/path with spaces/a.vsdx>):
        .replace(/\[([^\]\n]+)\]\(&lt;(?:file:\/\/\/?)?((?:\/|~[\\/]|[A-Za-z]:[\\/])[^&#\r\n]*?(?:&amp;[^&#\r\n]*?)*)(?:#[^&\r\n]*)?&gt;\)/g, (_, label, p) => {
          p = p.replace(/&amp;/g, "&").replace(/:\d+(?:[-:]\d+)?$/, "");
          try { p = decodeURI(p); } catch {}
          return hold(`<a class="fpath" href="#" data-path="${esc(p)}" title="${esc(p)}">${label}</a>`);
        })
        .replace(/\[([^\]\n]+)\]\((?:file:\/\/\/?)?((?:\/|~[\\/]|[A-Za-z]:[\\/])[^)\s"#]+)(?:#[^)\s"]*)?\)/g, (_, label, p) => {
          p = p.replace(/&amp;/g, "&").replace(/:\d+(?:[-:]\d+)?$/, "");
          try { p = decodeURI(p); } catch {}
          return hold(`<a class="fpath" href="#" data-path="${esc(p)}" title="${esc(p)}">${label}</a>`);
        })
        .replace(FILE_RE, (_, pre, p) => pre + hold(`<a class="fpath" href="#" data-path="${p}" title="打开这个文件">${p}</a>`))
        .replace(URL_RE, (rawU) => {
          const [u, tail] = trimBalancedURL(rawU);
          if (!u) return rawU;
          return `<a class="url" href="${u}" target="_blank" rel="noopener noreferrer" title="${u}">${urlLabel(u)}</a>${tail}`;
        })
        .replace(/\u0001(\d+)\u0001/g, (_, i) => spans[+i]);
    };
    const out = [];
    let list = null, para = [];
    const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; } };
    const flushList = () => { if (list) { out.push(`<${list.tag}${list.start > 1 ? ` start="${list.start}"` : ""}>${list.items.map((x) => `<li>${inline(x)}</li>`).join("")}</${list.tag}>`); list = null; } };
    // A GFM table (with |---| separator) OR a compact pipe-delimited table
    // (ASCII `|` or fullwidth `｜`, >=2 aligned rows with matching column counts).
    const hasPipe = (row) => row.includes("|") || row.includes("｜");
    const normPipes = (row) => row.replace(/｜/g, "|");
    const cells = (row) => normPipes(row).trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
    const isSep = (row) => {
      const nr = normPipes(row);
      return nr.includes("|") && /^\s*\|?\s*:?[-—–]{2,}:?\s*(\|\s*:?[-—–]{2,}:?\s*)*\|?\s*$/.test(nr) && /[-—–]/.test(nr);
    };
    const isCompactTableRun = (startIdx) => {
      const r0 = lines[startIdx];
      if (!hasPipe(r0) || /^\s*(?:[-*•>]|```|\d+[.)]\s)/.test(r0)) return 0;
      const c0 = cells(r0);
      if (c0.length < 2 || c0.some((c) => !c || c.length > 72)) return 0;
      let count = 1;
      for (let k = startIdx + 1; k < lines.length; k++) {
        const rk = lines[k];
        if (!rk.trim() || !hasPipe(rk)) break;
        const ck = cells(rk);
        if (ck.length !== c0.length || ck.some((c) => c.length > 96)) break;
        count++;
      }
      return (c0.length >= 3 && count >= 2) || (c0.length === 2 && count >= 3) ? count : 0;
    };
    const lines = text.split("\n");
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      let m;
      if (hasPipe(line) && li + 1 < lines.length && isSep(lines[li + 1])) {
        flushPara(); flushList();
        const head = cells(line);
        const align = cells(lines[li + 1]).map((c) => c.endsWith(":") ? (c.startsWith(":") ? "center" : "right") : "");
        const td = (tag, c, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ""}>${inline(c)}</${tag}>`;
        let body = "";
        li += 2;
        while (li < lines.length && hasPipe(lines[li]) && lines[li].trim()) {
          const r = cells(lines[li]);
          body += `<tr>${head.map((_, k) => td("td", r[k] || "", k)).join("")}</tr>`;
          li++;
        }
        li--;
        out.push(`<div class="md-table"><table><thead><tr>${head.map((c, k) => td("th", c, k)).join("")}</tr></thead><tbody>${body}</tbody></table></div>`);
        continue;
      }
      const compactRows = isCompactTableRun(li);
      if (compactRows >= 2) {
        flushPara(); flushList();
        const head = cells(line);
        const td = (tag, c) => `<${tag}>${inline(c)}</${tag}>`;
        let body = "";
        for (let k = 1; k < compactRows; k++) {
          const r = cells(lines[li + k]);
          body += `<tr>${head.map((_, colIdx) => td("td", r[colIdx] || "")).join("")}</tr>`;
        }
        li += compactRows - 1;
        out.push(`<div class="md-table"><table><thead><tr>${head.map((c) => td("th", c)).join("")}</tr></thead><tbody>${body}</tbody></table></div>`);
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
    return out.join("")
      .replace(/\u0000(\d+)\u0000/g, (_, n) => blocks[+n])
      .replace(/\u0003(\d+)\u0003/g, (_, n) => inlineMath[+n]);
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
  function uploadFileToMachine(file, name, m) {
    const up = routeReq(`/api/uploads?name=${encodeURIComponent(name)}${m ? "&machine=" + encodeURIComponent(m) : ""}`);
    return fetch(up.url, {
      method: "POST", body: file, credentials: up.hub ? "omit" : "same-origin",
      headers: up.hub ? { Authorization: "Bearer " + up.hub.token } : {},
    }).then(async (res) => {
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || res.statusText);
      return d.path;
    });
  }
  // ───────────────────────────── smart link paste & link cards
  const LINK_ICONS = {
    github: `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2C6.48 2 2 6.58 2 12.26c0 4.54 2.87 8.39 6.84 9.75.5.09.68-.22.68-.49 0-.24-.01-.88-.01-1.72-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.49-1.11-1.49-.91-.64.07-.63.07-.63 1 .07 1.53 1.05 1.53 1.05.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.37-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05A9.38 9.38 0 0 1 12 6.84c.85 0 1.71.12 2.51.35 1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.81-4.57 5.06.36.32.68.94.68 1.9 0 1.37-.01 2.47-.01 2.81 0 .27.18.59.69.49A10.27 10.27 0 0 0 22 12.26C22 6.58 17.52 2 12 2Z"/></svg>`,
    paper: `<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/></svg>`,
    doc: `<svg viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="18" rx="2.5"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>`,
    video: `<svg viewBox="0 0 24 24"><rect x="2.5" y="5" width="19" height="14" rx="3"/><polygon points="10 9 15.5 12 10 15" fill="currentColor" stroke="none"/></svg>`,
    local: `<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7 9l3 3-3 3M12 15h5"/></svg>`,
    web: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3.5 9h17M3.5 15h17M12 3a14.5 14.5 0 0 0 0 18M12 3a14.5 14.5 0 0 1 0 18"/></svg>`,
    ext: `<svg class="lc-ext" viewBox="0 0 24 24"><path d="M7 17L17 7M9 7h8v8"/></svg>`,
  };
  const linkTitleMem = new Map();
  function parseSmartLink(rawUrl, hintTitle = "") {
    let u;
    try { u = new URL(rawUrl); } catch { return null; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const host = u.hostname.replace(/^www\./i, "").toLowerCase();
    const portPart = u.port ? ":" + u.port : "";
    const hostLabel = host + portPart;
    let decPath = "";
    try { decPath = decodeURIComponent(u.pathname || ""); } catch { decPath = u.pathname || ""; }
    const segs = decPath.split("/").filter(Boolean);
    let kind = "web";
    let fallback = hostLabel;
    if (host === "github.com" || host.endsWith(".github.com")) {
      kind = "github";
      if (segs.length >= 2) {
        const repo = `${segs[0]}/${segs[1]}`;
        if (segs[2] === "pull" && segs[3]) fallback = `${repo} · PR #${segs[3]}`;
        else if (segs[2] === "issues" && segs[3]) fallback = `${repo} · Issue #${segs[3]}`;
        else if (segs[2] === "commit" && segs[3]) fallback = `${repo} @ ${segs[3].slice(0, 7)}`;
        else if (segs[2] === "compare" && segs[3]) fallback = `${repo} · ${segs[3]}`;
        else if (segs[2] === "releases" && segs[4]) fallback = `${repo} · ${segs[4]}`;
        else if ((segs[2] === "blob" || segs[2] === "tree") && segs.length >= 4) fallback = `${repo} · ${segs.slice(3).join("/")}`;
        else fallback = segs.length > 2 ? `${repo} · ${segs.slice(2).join("/")}` : repo;
      }
    } else if (host.includes("arxiv.org") || host === "doi.org" || host.includes("openreview.net")) {
      kind = "paper";
      fallback = host.includes("arxiv.org") && segs.length >= 2 ? `arXiv:${segs[segs.length - 1].replace(/\.pdf$/i, "")}` : (segs.join("/") || hostLabel);
    } else if (host.includes("feishu.cn") || host.includes("larksuite.com") || host.includes("larkoffice.com") || host.includes("notion.so") || host.includes("docs.google.com")) {
      kind = "doc";
      fallback = segs.length ? `${host.split(".")[0]} · ${segs.slice(0, 2).join("/")}` : hostLabel;
    } else if (host.includes("youtube.com") || host === "youtu.be" || host.includes("bilibili.com")) {
      kind = "video";
      fallback = segs.length ? `${hostLabel} · ${segs[segs.length - 1]}` : hostLabel;
    } else if (host === "localhost" || /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host)) {
      kind = "local";
      fallback = hostLabel + (decPath && decPath !== "/" ? decPath : "");
    } else if (segs.length) {
      const tail = segs.slice(-2).join("/");
      fallback = tail.length > 44 ? tail.slice(0, 42) + "…" : `${hostLabel}/${tail}`;
    }
    if (fallback.length > 68) fallback = fallback.slice(0, 66) + "…";
    const cached = linkTitleMem.get(u.href);
    const cleanHint = String(hintTitle || "").trim();
    const initialTitle = cached || (cleanHint && cleanHint !== u.href && !/^https?:\/\//i.test(cleanHint) ? cleanHint : "");
    return {
      url: u.href,
      host: hostLabel,
      kind,
      title: initialTitle || fallback,
      isFallback: !initialTitle,
    };
  }
  function unfurlLinkTitle(item, onUpdate) {
    if (!item || !item.isFallback) return;
    if (linkTitleMem.has(item.url)) {
      item.title = linkTitleMem.get(item.url);
      item.isFallback = false;
      onUpdate?.();
      return;
    }
    api(`/api/link-meta?url=${encodeURIComponent(item.url)}`).then((res) => {
      if (res && res.title && String(res.title).trim()) {
        const t = String(res.title).trim();
        linkTitleMem.set(item.url, t);
        item.title = t;
        item.isFallback = false;
        onUpdate?.();
      }
    }).catch(() => {});
  }
  function extractClipboardStandaloneLinks(clipboardData) {
    if (!clipboardData) return null;
    const text = (clipboardData.getData("text/plain") || "").trim();
    const html = (clipboardData.getData("text/html") || "").trim();
    // Single rich HTML anchor copied from browser/docs (`<a href="https://...">Title</a>`)
    if (html && (!text || /^https?:\/\/\S+$/i.test(text))) {
      const m = html.match(/^\s*(?:<meta[^>]*>\s*)*<a\b[^>]*\bhref=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>\s*$/i);
      if (m) {
        const label = m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
        const parsed = parseSmartLink(m[1], label);
        if (parsed) return [parsed];
      }
    }
    if (!text) return null;
    // Check if clipboard text consists solely of 1..8 HTTP(S) URLs separated by whitespace/newlines
    const tokens = text.split(/\s+/).filter(Boolean);
    if (!tokens.length || tokens.length > 8) return null;
    const out = [];
    for (const tok of tokens) {
      if (!/^https?:\/\/[^\s<>"]+$/i.test(tok)) return null;
      const parsed = parseSmartLink(tok);
      if (!parsed) return null;
      out.push(parsed);
    }
    return out;
  }
  function cursorInsideBackticks(ta) {
    if (!ta) return false;
    const before = ta.value.slice(0, ta.selectionStart || 0);
    const fences = (before.match(/```/g) || []).length;
    if (fences % 2 === 1) return true;
    const lineStart = before.lastIndexOf("\n") + 1;
    const ticks = (before.slice(lineStart).match(/`/g) || []).length;
    return ticks % 2 === 1;
  }

  function bindFiles(form, machine) {
    const box = $(".files", form), picker = $('input[type="file"]', form);
    form._files = [];
    form._links = [];
    form._machine = machine;
    const ta = $("textarea", form);
    const origPlaceholder = ta?.placeholder || "";
    const draw = () => {
      const hasAny = (form._links.length + form._files.length) > 0;
      box.hidden = !hasAny || Boolean(form._filesHidden);
      const linksHTML = form._links.map((l, i) => `<span class="file link-chip" title="${esc(l.url)}">`
        + `<a class="lc-open" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">`
        + `<span class="lc-ico">${LINK_ICONS[l.kind] || LINK_ICONS.web}</span>`
        + `<span class="lc-body"><span class="lc-title">${esc(l.title)}</span><span class="lc-host">${esc(l.host)}</span></span>`
        + `${LINK_ICONS.ext}</a>`
        + `<button type="button" class="lc-as-txt" data-link-txt="${i}" title="转为输入框纯文本">T</button>`
        + `<button type="button" data-rm-link="${i}" title="移除链接">×</button></span>`).join("");
      const filesHTML = form._files.map((f, i) => `<span class="file ${f.err ? "err" : f.path ? "" : "busy"}" title="${esc(f.err || f.path || "上传中…")}">
        ${f.thumb ? `<img src="${f.thumb}" alt="">` : `<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>`}
        <span class="fn">${esc(f.name)}</span><span class="fs">${f.err ? "失败" : f.path ? fmtSize(f.size) : "上传中"}</span>
        <button type="button" data-rm="${i}" title="移除">×</button></span>`).join("");
      box.innerHTML = linksHTML + filesHTML;
      if (ta && !ta.disabled && origPlaceholder) {
        if (form._links.length && !ta.value) {
          ta.placeholder = "输入对链接的指令说明，或直接回车发送…";
        } else if (ta.placeholder === "输入对链接的指令说明，或直接回车发送…") {
          ta.placeholder = origPlaceholder;
        }
      }
      syncComposerBtn(form);
    };
    const addLinks = (items) => {
      let added = false;
      for (const item of items) {
        if (form._links.some((x) => x.url === item.url)) continue;
        form._links.push(item);
        added = true;
        unfurlLinkTitle(item, draw);
      }
      if (added) draw();
      return added;
    };
    const add = (list) => {
      const taVal = ta?.value || "";
      for (const file of list) {
        const f = { name: file.name || "粘贴的图片.png", size: file.size, rawFile: file, thumb: file.type.startsWith("image/") ? URL.createObjectURL(file) : "" };
        const m = machine(taVal);
        f.machine = m;
        f.done = uploadFileToMachine(file, f.name, m).then((p) => { f.path = p; })
          .catch((err) => { f.err = err.message; toast(`${f.name}：${err.message}`, "attn"); }).finally(draw);
        form._files.push(f);
      }
      draw();
    };
    $(".attach", form).addEventListener("click", () => picker.click());
    picker.addEventListener("change", () => { add([...picker.files]); picker.value = ""; });
    box.addEventListener("click", (e) => {
      const txtIdx = e.target.closest("[data-link-txt]")?.dataset.linkTxt;
      if (txtIdx != null) {
        const [lnk] = form._links.splice(+txtIdx, 1);
        if (lnk && ta) {
          const s = ta.selectionStart ?? ta.value.length;
          const ePos = ta.selectionEnd ?? ta.value.length;
          const needLead = s > 0 && !/\s$/.test(ta.value.slice(0, s)) ? " " : "";
          const ins = needLead + lnk.url;
          ta.setRangeText(ins, s, ePos, "end");
          grow(ta);
          ta.focus();
        }
        draw();
        return;
      }
      const li = e.target.closest("[data-rm-link]")?.dataset.rmLink;
      if (li != null) {
        form._links.splice(+li, 1);
        draw();
        return;
      }
      const i = e.target.closest("[data-rm]")?.dataset.rm;
      if (i == null) return;
      const [f] = form._files.splice(+i, 1);
      if (f?.thumb) URL.revokeObjectURL(f.thumb);
      draw();
    });
    ta.addEventListener("paste", (e) => {
      const files = [...(e.clipboardData?.files || [])];
      if (files.length) { e.preventDefault(); add(files); return; }
      if (cursorInsideBackticks(ta)) return;
      const links = extractClipboardStandaloneLinks(e.clipboardData);
      if (!links || !links.length) return;
      // Selected text + single URL -> wrap selection into Markdown link `[selected](url)`!
      const selStart = ta.selectionStart ?? 0, selEnd = ta.selectionEnd ?? 0;
      if (selEnd > selStart && links.length === 1) {
        const selected = ta.value.slice(selStart, selEnd).trim();
        if (selected && !/^https?:\/\//i.test(selected)) {
          e.preventDefault();
          ta.setRangeText(`[${selected}](${links[0].url})`, selStart, selEnd, "end");
          grow(ta);
          syncComposerBtn(form);
          return;
        }
      }
      e.preventDefault();
      addLinks(links);
    });
    form.addEventListener("dragover", (e) => {
      if (e.dataTransfer?.types?.includes("Files") || e.dataTransfer?.types?.includes("text/uri-list")) {
        e.preventDefault(); form.classList.add("drop");
      }
    });
    form.addEventListener("dragleave", () => form.classList.remove("drop"));
    form.addEventListener("drop", (e) => {
      form.classList.remove("drop");
      if (e.dataTransfer?.files?.length) {
        e.preventDefault(); add([...e.dataTransfer.files]); return;
      }
      const uriList = (e.dataTransfer?.getData("text/uri-list") || "").split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
      const parsed = uriList.map((u) => parseSmartLink(u)).filter(Boolean);
      if (parsed.length) {
        e.preventDefault();
        addLinks(parsed);
      }
    });
    form._clearFiles = () => {
      form._files.forEach((f) => f.thumb && URL.revokeObjectURL(f.thumb));
      form._files = [];
      form._links = [];
      draw();
    };
  }
  async function withFiles(form, text) {
    const files = form._files || [];
    const links = form._links || [];
    let out = text.trim();
    if (links.length) {
      const linkLines = links.map((l) => (l.title && !l.isFallback) ? `- [${l.title}](${l.url})` : `- ${l.url}`).join("\n");
      out = (out ? out + "\n\n" : "") + "参考链接：\n" + linkLines;
    }
    if (!files.length) return out;
    await Promise.all(files.map((f) => f.done));
    if (files.some((f) => f.err)) throw new Error("有文件没传上去，移除后再发");
    const desiredM = form._machine ? form._machine(out) : undefined;
    if (desiredM !== undefined) {
      await Promise.all(files.map(async (f) => {
        if (f.rawFile && f.machine !== desiredM) {
          f.path = await uploadFileToMachine(f.rawFile, f.name, desiredM);
          f.machine = desiredM;
        }
      }));
    }
    return (out ? out + "\n\n" : "") + "附件：\n" + files.map((f) => f.path).join("\n");
  }
  // Images a Collie or agent message points at (including Markdown file links)
  // show as compact thumbnails under the message, without duplicating inline [image:...].
  const IMG_PATH = /(?:^|[\s(（`"'：:])(?:file:\/\/\/?)?((?:~[\\/]|\/|[A-Za-z]:[\\/])[^\s`"'()（）<>\]]*\.(?:png|jpe?g|gif|webp|svg|bmp))(?=$|[\s)）`"'，。,;；#\]])/gim;
  const IMG_ANGLE = /<(?:file:\/\/\/?)?((?:~[\\/]|\/|[A-Za-z]:[\\/])[^>#\r\n]+\.(?:png|jpe?g|gif|webp|svg|bmp))(?:#[^>\r\n]*)?>/gi;
  function imagesIn(t) {
    const cleaned = String(t || "").replace(IMG_RUN, "")
      .replace(/!\[[^\]\n]*\]\(<[^>\r\n]+>\)/g, "")
      .replace(/!\[[^\]\n]*\]\([^)\n]+\)/g, "");
    const rawList = [
      ...[...cleaned.matchAll(IMG_ANGLE)].map((m) => m[1]),
      ...[...cleaned.matchAll(IMG_PATH)].map((m) => m[1]),
    ];
    const ps = [...new Set(rawList.map((raw) => {
      let p = raw;
      try { p = decodeURI(p); } catch {}
      return p;
    }))].slice(0, 6);
    return ps.length ? `<span class="thumbs">${ps.map((p) => thumbBtn(p)).join("")}</span>` : "";
  }
  // Markdown as one plain line, for quotes: no marks, list dashes or breaks.
  const plainLine = (t) => (t || "").split("\n").map((l) => l.replace(/^\s*(?:[-*+]|\d+\.|#+|>)\s+/, "").trim()).filter(Boolean).join(" ")
    .replace(/\*\*|__|`/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // A user message's attachments & links: links as sleek cards/pills, images as thumbnails, files by name.
  function renderUserLinkCardHTML(lnk) {
    return `<a class="u-link-card" href="${esc(lnk.url)}" target="_blank" rel="noopener noreferrer" title="${esc(lnk.url)}">`
      + `<span class="lc-ico">${LINK_ICONS[lnk.kind] || LINK_ICONS.web}</span>`
      + `<span class="lc-body"><span class="lc-title">${esc(lnk.title)}</span><span class="lc-host">${esc(lnk.host)}</span></span>`
      + `${LINK_ICONS.ext}</a>`;
  }
  function formatUserProseWithLinks(rawBody, cardLinks) {
    if (!rawBody) return "";
    const keptLines = [];
    for (const line of rawBody.split("\n")) {
      const trimmed = line.trim();
      if (/^https?:\/\/[^\s<>"]+$/i.test(trimmed)) {
        const p = parseSmartLink(trimmed);
        if (p) {
          if (!cardLinks.some((x) => x.url === p.url)) cardLinks.push(p);
          continue;
        }
      }
      keptLines.push(line);
    }
    const joined = keptLines.join("\n").trim();
    if (!joined) return "";
    // Linkify `[label](https://...)`, inline `https://...`, and LaTeX math inside escaped user prose
    const tokens = [];
    const hold = (h) => `\u0002${tokens.push(h) - 1}\u0002`;
    let processed = MATH.extractMathSegments(
      joined.replace(/[\u0000\u0002\u0003\u0004]/g, ""),
      (html) => tokens.push(html) - 1,
      (html) => tokens.push(html) - 1,
      ""
    ).replace(/\u0000(\d+)\u0000/g, "\u0002$1\u0002").replace(/\u0003(\d+)\u0003/g, "\u0002$1\u0002");
    processed = processed
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s"]+)\)/g, (_, label, u) => {
        const p = parseSmartLink(u, label);
        const ico = p ? (LINK_ICONS[p.kind] || LINK_ICONS.web) : LINK_ICONS.web;
        return hold(`<a class="u-url-pill" href="${esc(u)}" target="_blank" rel="noopener noreferrer" title="${esc(u)}">${ico}<span>${esc(label)}</span>${LINK_ICONS.ext}</a>`);
      })
      .replace(/https?:\/\/[^\s<>"，。；：、！？）」』】（「『【]+/g, (raw) => {
        const m = raw.match(/^(.*?)([.,;:!?'`)\]]*)$/);
        const cleanU = m ? m[1] : raw;
        const tail = m ? m[2] : "";
        const p = parseSmartLink(cleanU);
        if (!p) return raw;
        return hold(`<a class="u-url-pill" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer" title="${esc(p.url)}">${LINK_ICONS[p.kind] || LINK_ICONS.web}<span>${esc(p.title)}</span>${LINK_ICONS.ext}</a>`) + tail;
      });
    processed = withImages(esc(processed));
    return processed.replace(/\u0002(\d+)\u0002/g, (_, idx) => tokens[+idx] || "");
  }
  const expandedUserMsgs = new Set();
  document.addEventListener("click", (ev) => {
    const fb = ev.target.closest("[data-u-fold]");
    if (!fb) return;
    ev.preventDefault();
    const key = fb.dataset.uFold || "";
    const wrap = fb.closest(".u-fold");
    if (!wrap) return;
    const nextOpen = !wrap.classList.contains("expanded");
    if (key) {
      if (nextOpen) expandedUserMsgs.add(key);
      else expandedUserMsgs.delete(key);
    }
    wrap.classList.toggle("expanded", nextOpen);
    const lines = +fb.dataset.lines || 0;
    const sp = fb.querySelector("span");
    if (sp) sp.textContent = nextOpen ? "收起" : `展开全文${lines > 6 ? `（共 ${lines} 行）` : ""}`;
    if (!nextOpen) {
      const rect = wrap.getBoundingClientRect();
      if (rect.top < 70) wrap.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  });

  function userText(t, foldKey = "") {
    let body = String(t || "");
    let attPaths = [];
    const attIdx = body.lastIndexOf("附件：\n");
    if (attIdx >= 0) {
      attPaths = body.slice(attIdx + 4).split("\n").map((p) => p.trim()).filter(Boolean);
      body = body.slice(0, attIdx).trimEnd();
    }
    const cardLinks = [];
    const refIdx = body.lastIndexOf("参考链接：\n");
    if (refIdx >= 0) {
      const refLines = body.slice(refIdx + 6).split("\n").map((l) => l.trim()).filter(Boolean);
      let allValid = refLines.length > 0;
      const parsedRefs = [];
      for (const rl of refLines) {
        const mMd = rl.match(/^-\s*\[([^\]]+)\]\((https?:\/\/[^)\s"]+)\)\s*$/);
        const mRaw = !mMd && rl.match(/^-\s*(https?:\/\/\S+)\s*$/);
        if (mMd) {
          const p = parseSmartLink(mMd[2], mMd[1]);
          if (p) { parsedRefs.push(p); continue; }
        } else if (mRaw) {
          const p = parseSmartLink(mRaw[1]);
          if (p) { parsedRefs.push(p); continue; }
        }
        allValid = false;
        break;
      }
      if (allValid) {
        cardLinks.push(...parsedRefs);
        body = body.slice(0, refIdx).trimEnd();
      }
    }
    const proseHTML = formatUserProseWithLinks(body, cardLinks);
    const lineCount = body ? body.split("\n").length : 0;
    const isLongUser = Boolean(proseHTML && (body.length > 260 || lineCount > 6));
    const effKey = foldKey || `h:${body.length}:${body.slice(0, 24)}`;
    const isOpen = expandedUserMsgs.has(effKey);
    const proseBlock = !proseHTML ? ""
      : isLongUser
        ? `<div class="u-fold${isOpen ? " expanded" : ""}"><div class="u-fold-body u-prose">${proseHTML}</div><button type="button" class="u-fold-btn" data-u-fold="${esc(effKey)}" data-lines="${lineCount}"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg><span>${isOpen ? "收起" : `展开全文${lineCount > 6 ? `（共 ${lineCount} 行）` : ""}`}</span></button></div>`
        : `<div class="u-prose">${proseHTML}</div>`;
    const imgs = attPaths.filter((p) => IMG_EXT.test(p)), rest = attPaths.filter((p) => !IMG_EXT.test(p));
    const name = (p) => p.split(/[\\/]/).pop().replace(/^[0-9a-f]{6}-/, "");
    return proseBlock
      + (cardLinks.length ? `<div class="user-links${proseHTML ? " has-text" : ""}">${cardLinks.map(renderUserLinkCardHTML).join("")}</div>` : "")
      + (imgs.length ? `<span class="thumbs">${imgs.map((p) => thumbBtn(p)).join("")}</span>` : "")
      + (rest.length ? `<span class="att">${rest.map((p) => `<span>📎 ${esc(name(p))}</span>`).join("")}</span>` : "");
  }

  async function doInterruptForm(form) {
    if (!form) return;
    if (form.id === "super-composer") {
      form._sending = false;
      syncComposerBtn(form);
      await api("/api/super/router/interrupt", { body: {} });
      toast("已中止 Collie 当前处理");
      return;
    }
    if (form.id === "x-composer") {
      if (!extCur || extCur.startsWith("h:")) return;
      form._abortRequested = true;
      form._sending = false;
      const cur = ext.find((x) => x.id === extCur);
      if (cur) { cur.status = "idle"; cur.live = false; renderExt(); renderExtHead(); }
      syncComposerBtn(form);
      await api(`/api/external/${encodeURIComponent(extCur)}/interrupt`, { body: {} });
      toast("已中止当前任务");
      setTimeout(() => loadExternal().catch(() => {}), 800);
      return;
    }
    if (form.id === "composer") {
      if (!current) return;
      form._sending = false;
      syncComposerBtn(form);
      await api(paneURL(current, "interrupt"), { body: {} });
      toast("已中止当前任务");
    }
  }

  // Single bottom-right button state machine (Codex App / ChatGPT style):
  // - Running & input box empty  -> crisp Stop square (■)
  // - Input box has text/files   -> Send arrow (↑) so user can steer/interrupt with a new prompt
  // - Idle & input box empty     -> subdued disabled Send arrow (↑)
  function syncComposerBtn(form) {
    if (!form) return;
    const btn = $(".send", form), input = $("textarea", form);
    if (!btn || !input) return;
    const hasFiles = Boolean(((form._files?.length || 0) + (form._links?.length || 0)) > 0 && !form._filesHidden);
    const hasDraft = Boolean(input.value.trim()) || hasFiles;
    const canInput = !input.disabled;

    let running = Boolean(form._sending);
    let rawShellReady = false;
    if (form.id === "super-composer") {
      if (sup.router?.alive && (sup.router.status === "working" || sup.router.status === "starting")) running = true;
    } else if (form.id === "x-composer") {
      if (!running && extCur && !extCur.startsWith("h:")) {
        const e = ext.find((x) => x.id === extCur);
        if (e && extOnline(e) && e.live && e.status === "working" && (e.can_send || e.pid > 0 || e.kind === "agy")) {
          running = true;
        }
      }
    } else if (form.id === "composer") {
      const v = find(current);
      rawShellReady = Boolean(v && !v.is_agent);
      if ((v && (v.status === "working" || v.status === "starting")) || lastLive?.status === "working") {
        running = true;
      }
    }

    if (running && !hasDraft) {
      btn.classList.add("is-stop");
      btn.type = "button";
      btn.disabled = Boolean(form._interrupting);
      btn.title = "中止当前任务";
    } else {
      btn.classList.remove("is-stop");
      btn.type = "submit";
      btn.disabled = !canInput || Boolean(form._sending) || (!hasDraft && !rawShellReady);
      btn.title = running && hasDraft ? "发送补充指令（插话）" : "发送";
    }
  }

  function bindComposer(form, input, send, machine) {
    if (machine) bindFiles(form, machine);
    const sendBtn = $(".send", form);
    sendBtn?.addEventListener("mousedown", (ev) => {
      if (sendBtn.classList.contains("is-stop")) ev.preventDefault();
    });
    sendBtn?.addEventListener("click", async (ev) => {
      if (!sendBtn.classList.contains("is-stop")) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (form._interrupting) return;
      form._interrupting = true;
      syncComposerBtn(form);
      try { await doInterruptForm(form); }
      catch (err) { toast(err.message, "attn"); }
      finally { form._interrupting = false; syncComposerBtn(form); }
    });

    const submitNow = async () => {
      if (form._sending || input.disabled) return;
      const hasFiles = Boolean(((form._files?.length || 0) + (form._links?.length || 0)) > 0 && !form._filesHidden);
      const rawShell = form.id === "composer" && Boolean(find(current) && !find(current).is_agent);
      const rawDraft = input.value;
      if (!rawDraft.trim() && !hasFiles && !rawShell) return;

      // Clear textarea & file strip synchronously (<1ms) before any async await,
      // and guard against trailing IME compositionend re-committing rawDraft.
      form._sending = true;
      form._abortRequested = false;
      form._filesHidden = true;
      const fileBox = $(".files", form);
      if (fileBox) fileBox.hidden = true;
      input.value = "";
      grow(input);
      requestAnimationFrame(() => {
        if (form._sending && input.value === rawDraft) {
          input.value = "";
          grow(input);
          syncComposerBtn(form);
        }
      });
      syncComposerBtn(form);

      try {
        const text = await withFiles(form, rawDraft);
        await send(text);
        form._filesHidden = false;
        form._clearFiles?.();
        if (form._abortRequested && form.id === "x-composer" && extCur && !extCur.startsWith("h:")) {
          api(`/api/external/${encodeURIComponent(extCur)}/interrupt`, { body: {} }).catch(() => {});
        }
      } catch (err) {
        form._filesHidden = false;
        if (fileBox && ((form._files?.length || 0) + (form._links?.length || 0)) > 0) fileBox.hidden = false;
        if (!input.value) { input.value = rawDraft; grow(input); }
        toast(err.message, "attn");
      } finally {
        form._sending = false;
        syncComposerBtn(form);
      }
    };

    input.addEventListener("input", () => { grow(input); syncComposerBtn(form); });
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.keyCode === 229) return;
      const mod = e.metaKey || e.ctrlKey;
      // "mod": Enter makes a new line and ⌘/Ctrl+Enter sends.
      if (prefs.sendKey() === "mod" ? mod : !mod) {
        e.preventDefault();
        submitNow();
      }
    });
    form._submit = submitNow;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      submitNow();
    });
    syncComposerBtn(form);
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
      const meta = getSessMeta(v.kind, v.machine, v.session, "p:" + v.pane_id);
      return {
        token, type: "pane", pane_id: v.pane_id, workspace_id: v.workspace_id,
        kind: v.kind, machine: v.machine || "", session: v.session || "", cwd: v.cwd || "",
        title: title(v), name: v.name || "", pinned: !!meta?.pinned, archived: false, activeNow: view === "pane" && current === v.pane_id,
      };
    }
    if (token.startsWith("x:")) {
      const eid = token.slice(2), e = ext.find((x) => x.id === eid);
      if (!e) return null;
      const meta = getSessMeta(e.kind, e.machine, e.session, "x:" + e.id);
      return {
        token, type: "ext", ext_id: e.id,
        kind: e.kind, machine: e.machine || "", session: e.session || "", cwd: e.cwd || "",
        title: extName(e), name: "", pinned: !!meta?.pinned, archived: !!meta?.archived, live: !!e.live, activeNow: view === "ext" && extCur === e.id,
      };
    }
    if (token.startsWith("h:")) {
      const hid = token.slice(2), h = hist.find((x) => x.id === hid);
      if (!h) return null;
      const meta = getSessMeta(h.kind, h.machine, h.session, "h:" + h.id);
      return {
        token, type: "hist", hist_id: h.id,
        kind: h.kind, machine: h.machine || "", session: h.session || "", cwd: h.cwd || "",
        title: histName(h), name: h.name || "", pinned: !!meta?.pinned, archived: !!meta?.archived, activeNow: view === "ext" && extCur === "h:" + h.id,
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

  async function togglePinSession(target) {
    if (!target) return;
    const nextPin = !target.pinned;
    await api("/api/sessions/pin", { body: {
      key: target.token || "",
      pane_id: target.pane_id || "", ext_id: target.ext_id || "", hist_id: target.hist_id || "",
      kind: target.kind || "", machine: target.machine || "", session: target.session || "",
      pinned: nextPin,
    } });
    await refreshSessionMeta();
    toast(nextPin ? "已置顶到独立会话顶部" : "已取消置顶");
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
    const spBtn = e.target.closest("[data-spin]");
    if (spBtn) {
      e.preventDefault(); e.stopPropagation();
      const target = resolveSessionTarget(spBtn.dataset.spin);
      if (target) togglePinSession(target).catch((err) => toast(err.message, "attn"));
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
      const curP = projectOfSession(target.kind, target.machine, target.session, target.cwd, target.token);
      const spmPin = $("#spm-pin");
      if (spmPin) {
        spmPin.hidden = Boolean(curP || target.archived);
        spmPin.textContent = target.pinned ? "取消置顶" : "置顶会话";
      }
      const spmProj = $("#spm-project");
      if (spmProj) {
        spmProj.textContent = curP ? "更改 / 移出项目…" : "归属到项目…";
      }
      sessPopMenu.hidden = false;
      const r = mb.getBoundingClientRect();
      const left = Math.min(innerWidth - 176, Math.max(8, r.right - 148));
      const top = r.bottom + 195 > innerHeight ? Math.max(8, r.top - 180) : r.bottom + 4;
      sessPopMenu.style.left = left + "px";
      sessPopMenu.style.top = top + "px";
      return;
    }
    const sact = e.target.closest("#sess-pop-menu [data-sact]")?.dataset.sact;
    if (sact) {
      const target = resolveSessionTarget(sessPopToken);
      closeSessPop();
      if (sact === "pin") togglePinSession(target).catch((err) => toast(err.message, "attn"));
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
      if (act === "interrupt") {
        if (!current) return;
        await api(paneURL(current, "interrupt"), { body: {} });
        toast("已中止当前任务");
      }
      if (act === "interrupt-ext") {
        if (!extCur || extCur.startsWith("h:")) return;
        await api(`/api/external/${encodeURIComponent(extCur)}/interrupt`, { body: {} });
        const cur = ext.find((x) => x.id === extCur);
        if (cur) { cur.status = "idle"; cur.live = false; renderExt(); renderExtHead(); }
        toast("已中止当前任务");
        setTimeout(() => loadExternal().catch(() => {}), 800);
      }
      if (act === "interrupt-router") {
        await api("/api/super/router/interrupt", { body: {} });
        toast("已中止 Collie 当前处理");
      }
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
    clearInterval(quotaTimer);
    loadHistory();
    loadQuotas(false);
    // The hub answers the list from its own copy, so this is cheap.
    let tick = 0;
    extTimer = setInterval(() => { loadExternal(); if (++tick % 3 === 0) loadHistory(); }, 3000);
    quotaTimer = setInterval(() => { if (!document.hidden) loadQuotas(false); }, 90000);
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
  // ───────────────────────────── command palette (⌘K / Ctrl+K) + cross-machine full-text search
  const cmdk = $("#cmdk"), cmdkInput = $("#cmdk-input"), cmdkList = $("#cmdk-list");
  let cmdkItems = [], cmdkIdx = 0;
  let cmdkSearchQ = "", cmdkSearchHits = [], cmdkSearchBusy = false, cmdkSearchTimer = null, cmdkSearchSeq = 0;

  function highlightMatchHTML(str, needle) {
    const raw = String(str || "");
    if (!needle) return esc(raw);
    const low = raw.toLowerCase(), nLow = needle.toLowerCase();
    const idx = low.indexOf(nLow);
    if (idx < 0) return esc(raw);
    return esc(raw.slice(0, idx)) + `<mark class="cmdk-hl">${esc(raw.slice(idx, idx + needle.length))}</mark>` + esc(raw.slice(idx + needle.length));
  }

  async function runCmdkSearch(q) {
    const trimmed = (q || "").trim();
    if ([...trimmed].length < 2) {
      cmdkSearchQ = "";
      cmdkSearchHits = [];
      cmdkSearchBusy = false;
      return;
    }
    const seq = ++cmdkSearchSeq;
    cmdkSearchQ = trimmed;
    cmdkSearchBusy = true;
    renderCmdk();
    try {
      const r = await api(`/api/search?q=${encodeURIComponent(trimmed)}`);
      if (seq !== cmdkSearchSeq) return;
      cmdkSearchHits = r.results || [];
    } catch {
      if (seq !== cmdkSearchSeq) return;
      cmdkSearchHits = [];
    } finally {
      if (seq === cmdkSearchSeq) {
        cmdkSearchBusy = false;
        if (cmdk?.open) renderCmdk();
      }
    }
  }
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
      { ico: '<svg viewBox="0 0 24 24"><circle cx="6" cy="6" r="2.2"/><circle cx="18" cy="12" r="2.2"/><circle cx="6" cy="18" r="2.2"/><path d="M8.2 6h4.3a3.5 3.5 0 0 1 3.5 3.5v.3M15.8 13.8v.7a3.5 3.5 0 0 1-3.5 3.5H8.2"/></svg>', title: "执行轨迹", sub: "查看每次派活从下发、跨机执行到汇报的完整任务流转链路", meta: "导航", run: () => { location.hash = "#/trace"; if (view === "trace") openPanel("trace"); } },
      { ico: '<svg viewBox="0 0 24 24"><path d="M5 4.5A2.5 2.5 0 0 1 7.5 2H19v18H7.5A2.5 2.5 0 0 0 5 22.5z"/><path d="M9 7h6M9 11h6"/></svg>', title: "长期记忆", sub: "按分栏查看或编辑 Collie 的长期指令、经验笔记与归档", meta: "导航", run: () => { location.hash = "#/memory"; } },
      { ico: '<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="8"/><path d="M12 9v4.2l2.8 1.8M9.5 2h5"/></svg>', title: "定时任务", sub: "创建或管理每日巡检与延后提醒", meta: "导航", run: () => { location.hash = "#/timers"; } },
      { ico: '<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.07 0l2.12-2.12a5 5 0 0 0-7.07-7.07L10.7 5.2"/><path d="M14 11a5 5 0 0 0-7.07 0L4.8 13.1a5 5 0 0 0 7.07 7.07l1.41-1.41"/></svg>', title: "外部触发（Webhook 与过滤）", sub: "管理 GitHub / 飞书 Webhook 与免唤醒过滤规则", meta: "导航", run: () => { location.hash = "#/hooks"; } },
      { ico: OS_GLYPHS.relay, title: "设备与节点连接", sub: "管理接入电脑、配对二维码与版本升级", meta: "导航", run: () => { location.hash = "#/devices"; } },
      { ico: '<svg viewBox="0 0 24 24"><path d="M4.4 16.4a8.6 8.6 0 1 1 15.2 0"/><path d="M12 13l3.6-3.8"/><circle cx="12" cy="13" r="1.4"/></svg>', title: "查看各电脑与 Agent 模型剩余用量", sub: "打开右上角配额面板并实时刷新 Codex / Claude / Antigravity / Gemini 额度", meta: "快捷", run: () => { toggleQuotaPop(true); loadQuotas(true); } },
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

    const collieRan = (name) => name === ROUTER || name === "collie-dream";
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
    if ([...needle].length >= 2 && (cmdkSearchHits.length || cmdkSearchBusy)) {
      const ftItems = cmdkSearchHits.map((h) => {
        const where = h.kind === "collie" ? "Collie 主对话" : `${KIND_LABEL[h.kind] || h.kind} · ${machineName(h.machine)}${h.cwd ? " · " + tilde(h.cwd) : ""}`;
        return {
          ico: h.kind === "collie" ? GLYPHS.collie : (GLYPHS[h.kind] || GLYPHS.agent),
          title: h.title || "会话",
          sub: where,
          snippet: h.snippet || "",
          meta: h.updated ? ago(h.updated) : "正文命中",
          run: () => { if (h.hash) location.hash = h.hash; },
        };
      });
      groups.push([cmdkSearchBusy ? "跨机对话正文检索（搜索中…）" : `跨机对话正文检索 (${ftItems.length})`, ftItems]);
    }
    if (navActs.length) groups.push(["导航与快捷操作", navActs]);
    if (recentItems.length) groups.push(["最近会话", recentItems]);
    return groups;
  }
  function renderCmdk() {
    const rawQ = cmdkInput.value;
    const needle = (rawQ || "").trim();
    const groups = buildCmdkItems(rawQ);
    cmdkItems = [];
    let html = "";
    for (const [sec, list] of groups) {
      html += `<div class="cmdk-sec">${esc(sec)}</div>`;
      if (!list.length && cmdkSearchBusy && sec.includes("正文检索")) {
        html += `<div class="cmdk-searching">正在跨电脑检索历史对话正文…</div>`;
        continue;
      }
      for (const it of list) {
        const idx = cmdkItems.length;
        cmdkItems.push(it);
        html += `<button type="button" class="cmdk-item${idx === cmdkIdx ? " on" : ""}" data-ci="${idx}">
          <span class="ci-ico">${it.ico}</span>
          <span class="ci-main">
            <div class="ci-title">${highlightMatchHTML(it.title, needle)}</div>
            <div class="ci-sub">${esc(it.sub)}</div>
            ${it.snippet ? `<div class="ci-snip">${highlightMatchHTML(it.snippet, needle)}</div>` : ""}
          </span>
          <span class="ci-meta">${it.dot ? `<span class="dot ${esc(it.dot)}"></span>` : ""}${esc(it.meta || "")}</span>
        </button>`;
      }
    }
    cmdkList.innerHTML = html || (cmdkSearchBusy ? `<div class="cmdk-empty">正在跨电脑检索历史对话正文…</div>` : `<div class="cmdk-empty">没有找到匹配的会话、操作或对话内容</div>`);
    cmdkList.querySelector(".cmdk-item.on")?.scrollIntoView({ block: "nearest" });
  }
  function openCmdk() {
    if (!cmdk || !$("#app") || $("#app").hidden) return;
    if (cmdk.open) { cmdk.close(); return; }
    closePick();
    clearTimeout(cmdkSearchTimer);
    cmdkSearchSeq++;
    cmdkSearchQ = "";
    cmdkSearchHits = [];
    cmdkSearchBusy = false;
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
  cmdkInput?.addEventListener("input", () => {
    cmdkIdx = 0;
    const q = cmdkInput.value.trim();
    clearTimeout(cmdkSearchTimer);
    if ([...q].length < 2) {
      cmdkSearchSeq++;
      cmdkSearchHits = [];
      cmdkSearchBusy = false;
      renderCmdk();
      return;
    }
    cmdkSearchBusy = true;
    renderCmdk();
    cmdkSearchTimer = setTimeout(() => runCmdkSearch(q), 220);
  });
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
