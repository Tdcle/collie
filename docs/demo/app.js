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
  const AGENT_LABEL = { claude: "Claude Code", codex: "Codex", agy: "Antigravity" };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const tilde = (p) => (p || "").replace(/^\/Users\/[^/]+|^\/home\/[^/]+|^[A-Za-z]:[\\/]Users[\\/][^\\/]+/, "~");
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

  // ───────────────────────────── icons & labels
  const GLYPHS = {
    claude: '<svg viewBox="0 0 32 32"><path d="M16 5v22M5 16h22M8.2 8.2l15.6 15.6M23.8 8.2L8.2 23.8"/></svg>',
    codex: '<svg viewBox="0 0 32 32"><path d="M16 4l10.4 6v12L16 28 5.6 22V10z"/><path d="M13 13l-3 3 3 3M19 13l3 3-3 3"/></svg>',
    agy: '<svg viewBox="0 0 32 32"><ellipse cx="16" cy="16" rx="11" ry="5" transform="rotate(-30 16 16)"/><path d="M16 21V9M12 13l4-4 4 4"/></svg>',
    agent: '<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="10"/><path d="M12 15h.01M20 15h.01M12 20c2.4 1.8 5.6 1.8 8 0"/></svg>',
    shell: '<svg viewBox="0 0 32 32"><rect x="4" y="6" width="24" height="20" rx="3"/><path d="M9 13l4 3-4 3M15 20h7"/></svg>',
    collie: '<img src="icon.svg" alt="" style="width:20px;height:20px">',
  };
  const KIND_LABEL = { claude: "claude", codex: "codex", agy: "antigravity", antigravity: "antigravity" };
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
    : o.dataset.dot ? `<span class="pi"><span class="dot ${esc(o.dataset.dot)}"></span></span>` : "";
  function syncPick(sel) {
    const b = sel._pick;
    if (!b) return;
    const o = sel.selectedOptions[0];
    b.querySelector(".pv").innerHTML = o ? optIcon(o) + `<span class="pt">${esc(o.dataset.short || o.textContent)}</span>` : "";
    b.disabled = sel.disabled;
    b.hidden = sel.hidden;
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
  $("#logout").addEventListener("click", async () => { await fetch("/api/logout", { method: "POST" }); location.reload(); });

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
    return {
      agents: (s.agents || []).map(fix), shells: (s.shells || []).map(fix),
      machines: ms.map((m) => ({ ...m, hub: k, id: tagged(m.id, k), local: false,
        name: m.local ? h.name : h.name + " · " + m.name,
        online: online && (m.local ? s.ok !== false : m.online) })),
    };
  }
  function mergedState() {
    const parts = [...remote.values()].map((r) => r.state).filter(Boolean);
    if (!parts.length) return localState;
    return { ...localState,
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
  const autoName = (n) => /^(claude|codex|agy|antigravity)-\d+$/.test(n || "");
  const base = (p) => (p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "~";
  function title(v) {
    if (!v) return "";
    if (v.name === ROUTER) return "Collie";
    if (isWorker(v.name)) return v.name; // Collie talks about its agents by name
    return v.topic || (v.name && !autoName(v.name) ? v.name : base(tilde(v.cwd))) || v.pane_id;
  }

  // ───────────────────────────── sidebar
  function itemHTML(v) {
    const where = (state.machines || []).length > 1 ? machineName(v.machine) + " · " : "";
    const named = v.is_agent && v.name !== ROUTER && !isWorker(v.name) && v.name && !autoName(v.name) && v.topic && v.topic !== v.name ? v.name + " · " : "";
    const sub = v.name === ROUTER ? "Collie 停在一个对话框上"
      : v.is_agent ? `${named}${KIND_LABEL[v.kind] || v.kind} · ${where}${base(tilde(v.cwd))}` : where + tilde(v.cwd);
    return `<li><a class="item ${view === "pane" && v.pane_id === current ? "active" : ""}" href="#/p/${encodeURIComponent(v.pane_id)}">
      <span class="glyph">${glyph(v)}</span>
      <span class="body"><div class="name">${isCollieOwned(v) && v.name !== ROUTER ? `<span class="nm">${esc(title(v))}</span><span class="by-collie">Collie 派出</span>` : esc(v.is_agent ? title(v) : v.workspace_label || base(tilde(v.cwd)))}</div><div class="sub">${esc(sub)}</div></span>
      <span class="dot ${esc(v.status)}" title="${esc(STATUS_LABEL[v.status] || v.status)}"></span></a></li>`;
  }

  const machineName = (id) => (state.machines || []).find((m) => m.id === (id || ""))?.name || id || "本机";
  const isCollieOwned = (v) => v.name === ROUTER || isWorker(v.name);

  function renderSide() {
    const blocked = state.agents.filter((a) => a.status === "blocked");
    $("#attention-group").hidden = blocked.length === 0;
    $("#attention").innerHTML = blocked.map(itemHTML).join("");

    const machines = (state.machines || [{ id: "", name: "本机", local: true, online: state.ok }]);
    const multi = machines.length > 1;

    renderSessions();
    $("#shells").innerHTML = state.shells.map(itemHTML).join("");
    $("#shell-count").textContent = state.shells.length || "";
    $("#shell-group").hidden = state.shells.length === 0;

    const online = machines.filter((m) => m.local ? state.ok : m.online).length;
    $("#conn").className = "conn " + (online ? "on" : "off");
    $("#herdr-status").textContent = !online ? "herdr 不可用" : multi ? `${online}/${machines.length} 台电脑在线` : `${state.agents.length} 个 agent`;
    if (!state.ok && state.error) $("#herdr-status").title = state.error;
    document.title = blocked.length ? `(${blocked.length}) Collie` : "Collie";

    const r = sup.router || {};
    const active = sup.workers.filter((w) => !w.ended);
    const running = active.filter(workerBusy).length;
    $("#nav-collie-sub").textContent = collieStatus(r.status) + (running ? ` · ${running} 个任务在跑` : active.length ? ` · 派出 ${active.length} 个` : "");
    $("#nav-collie-dot").className = "dot " + collieDot(r.status);
    $("#nav-queue").hidden = !sup.queued;
    $("#nav-queue").textContent = sup.queued;
    $("#nav-collie").classList.toggle("active", view === "collie");
    $("#nav-auto").classList.toggle("active", view === "auto");
    $("#nav-devices").classList.toggle("active", view === "devices");
    $("#nav-prefs").classList.toggle("active", view === "prefs");
  }

  // ───────────────────────────── routing
  function route() {
    const h = location.hash;
    let next = null, id = null;
    if (h.startsWith("#/p/")) { next = "pane"; id = decodeURIComponent(h.slice(4)); }
    else if (h.startsWith("#/x/")) { next = "ext"; id = decodeURIComponent(h.slice(4)); }
    else if (h.startsWith("#/h/")) { next = "ext"; id = "h:" + decodeURIComponent(h.slice(4)); }
    else if (h === "#/collie") next = "collie";
    else if (h === "#/auto") next = "auto";
    else if (h === "#/devices") next = "devices";
    else if (h === "#/prefs") next = "prefs";
    else if (!narrow()) {
      // Desktop has no empty home: reopen where you were, else Collie.
      const last = store.get("last", "#/collie");
      const ok = last.startsWith("#/p/") ? !!find(decodeURIComponent(last.slice(4))) : /^#\/(collie|auto|devices|prefs)$/.test(last);
      location.replace(ok ? last : "#/collie");
      return;
    }
    if (next) store.set("last", h);
    if (next === view && id === (next === "ext" ? extCur : current)) return;
    if (view === "ext" && (next !== "ext" || id !== extCur)) { closeExt(); extCur = null; }
    if (view === "pane" && (next !== "pane" || id !== current)) closeStream();
    if (view === "auto" && next !== "auto") clearInterval(autoTimer);
    if (view === "devices" && next !== "devices") clearInterval(devTimer);
    view = next; current = next === "ext" ? null : id;
    document.body.classList.toggle("show-main", !!next);
    $("#v-collie").hidden = next !== "collie";
    $("#v-auto").hidden = next !== "auto";
    $("#v-devices").hidden = next !== "devices";
    $("#v-prefs").hidden = next !== "prefs";
    $("#v-ext").hidden = next !== "ext";
    $("#detail").hidden = next !== "pane";
    renderSide();
    if (next === "collie") { renderSuper(true); renderTarget(true); if (!narrow()) $("#super-input").focus(); }
    if (next === "auto") openAuto();
    if (next === "devices") openDevices();
    if (next === "prefs") renderPrefs();
    if (next === "ext") openExt(id);
    if (next === "pane") {
      $("#gone").hidden = true;
      $("#log").textContent = "";
      resetChat();
      term?.reset();
      renderHead();
      openStream();
      if (!narrow()) $("#input").focus();
    }
  }
  addEventListener("hashchange", route);

  // ───────────────────────────── Collie (super-agent) view
  let superSig = "";
  // Which model Collie itself runs with, next to its status.
  async function renderRouterModel(r) {
    const el = $("#router-model");
    const key = [r.kind, r.model, r.effort, r.pending].join("|");
    if (el._key === key) return;
    el._key = key;
    let model = r.model;
    if (!model && r.kind) model = (await modelsFor(r.kind === "antigravity" ? "agy" : r.kind, "")).default || "";
    if (el._key !== key) return;
    const parts = [];
    if (model) parts.push(esc(model.split("/").pop()) + (r.model ? "" : "（默认）"));
    if (r.effort) parts.push("思考 " + esc(EFFORT_LABEL[r.effort] || r.effort));
    el.innerHTML = parts.join(" · ") + (r.pending ? ` <button type="button" class="pending" data-act="router-restart" title="Collie 的模型设置改过了，点这里重启 Collie">重启后生效</button>` : "");
    el.title = `Collie 自己用的模型${model ? "：" + model : ""}${r.effort ? "，思考强度 " + r.effort : ""}（自动化 → 设置 → Collie 自己）`;
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
    $("#router-kind").textContent = KIND_LABEL[r.kind] || r.kind || "";
    const st = $("#router-status");
    st.className = "status " + collieDot(r.status);
    st.innerHTML = `<span class="dot ${esc(collieDot(r.status))}"></span>${esc(collieStatus(r.status))}`;
    $("#router-queue").textContent = sup.paused ? "已暂停投递" : routerQueued() ? `${routerQueued()} 条事件排队中` : "";
    const cx = $("#router-ctx");
    cx.textContent = r.handover ? "正在交接记忆…" : r.alive && r.context ? `上下文 ${r.context}%` : "";
    cx.classList.toggle("warn", !!r.handover || (r.rotate_at > 0 && r.context >= r.rotate_at - 10));
    cx.title = r.rotate_at > 0 ? `用到 ${r.rotate_at}% 时，Collie 会把要记住的事写进 memory/，然后换一个新会话` : "自动换会话已关闭（自动化 → 设置）";
    renderRouterModel(r);
    $$('[data-act="pause"]').forEach((b) => b.textContent = sup.paused ? "恢复投递" : "暂停投递");

    const active = sup.workers.filter((w) => !w.ended);
    if (view === "collie") renderTarget();
    $("#crew").innerHTML = active.map((w) => {
      const pane = paneOf(w.name);
      return `<a class="chip" ${pane ? `href="#/p/${encodeURIComponent(pane)}"` : ""}><span class="dot ${esc(workerStatus(w))}" title="${esc(STATUS_LABEL[workerStatus(w)] || "")}"></span>${esc(w.name)}<span class="k">${esc(KIND_LABEL[w.kind] || w.kind)}</span></a>`;
    }).join("");

    const box = $("#super-thread");
    const scroller = box.parentElement;
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    let html = "", prevRole = "";
    if (!sup.entries.length && !pendingSays.length) {
      html = `<div class="hello"><img src="icon.svg" alt="">
        <h3>一个入口，管一群 agent</h3>
        <p>把事情告诉 Collie。它会理解上下文、拆好活，交给 Claude、Codex 或 Antigravity 在你的机器上并行去做，只在需要你决定或验收时出声。</p>
        <div class="ideas">
          <button data-idea="看一下 ~/agent-workspace 里最近改动最多的三个项目，各派一个 agent 检查有没有失败的测试，最后给我一句话总结。">并行检查三个项目的测试</button>
          <button data-idea="每天早上 9 点帮我看一下各个任务的进展，有卡住的就告诉我。">每天 9 点汇报进展</button>
          <button data-idea="以后 GitHub 上有人评论 @collie 的 issue，就派一个 agent 去复现，确认后再告诉我。">把 GitHub 评论变成任务</button>
        </div></div>`;
    } else {
      let prev = "", lastAt = 0;
      // What a reply is about shows as a quoted line, unless it is plain
      // from what is right above: the first answer to your last message, or
      // a word on the worker whose line it follows.
      let lastUser = "", sinceUser = 0, lastEvent = "", lastCollie = "", sinceCollie = 0;
      const quote = (e) => {
        const q = e.re;
        if (!q) return "";
        if (q.entry && q.entry === lastUser && !sinceUser) return "";
        if (q.entry && q.entry === lastCollie && !sinceCollie) return "";
        if (q.worker && q.worker === lastEvent) return "";
        const pane = q.worker && paneOf(q.worker), past = q.worker && !pane ? workerHist(q.worker, e.at) : null;
        const attr = q.entry ? `href="#" data-goto="${esc(q.entry)}"` : pane ? `href="#/p/${encodeURIComponent(pane)}"` : past ? `href="#/h/${encodeURIComponent(past.id)}"` : "";
        return `<a class="re" ${attr} title="${esc(q.text)}"><span class="re-who">${esc(q.who)}</span>${esc(plainLine(q.text))}</a>`;
      };
      for (const e of chatEntries()) {
        if (e.ref === ROUTER && e.tone === "info" && e.role !== "user" && e.role !== "collie") continue;
        if (e.role === "event" && workerChatter(e)) continue;
        // A quiet line with the time when the talk picks up again after a
        // while (or on a new day); hovering a message shows its exact time.
        const at = +new Date(e.at) || 0;
        // A new day always gets its line, even before an event (whose own
        // time has no date); talk after a pause gets one too.
        const talk = e.role === "user" || e.role === "collie";
        const newDay = at && lastAt && new Date(at).toDateString() !== new Date(lastAt).toDateString();
        if (at && (newDay || (talk && (!lastAt || at - lastAt > 10 * 60e3)))) {
          html += `<div class="time-sep">${esc(sepTime(at))}</div>`;
          prev = "";
        }
        if (at) lastAt = at;
        const cont = e.role === "collie" && prev === "collie";
        prev = prevRole = e.role;
        const tip = at ? ` title="${esc(fullTime(at))}" data-time="${esc(sepTime(at))}"` : "";
        if (e.role === "user") {
          html += `<div class="mine"><div class="msg user" data-id="${esc(e.id)}"${at ? ` title="${esc(fullTime(at))}"` : ""}>${quote(e)}${userText(e.text)}</div>${mineActs(e, at)}</div>`;
          lastUser = e.id; sinceUser = 0; lastEvent = ""; sinceCollie++;
        } else if (e.role === "collie") {
          html += `<div class="say${cont ? " cont" : ""}"><span class="avatar">${cont ? "" : `<img src="icon.svg" alt="">`}</span><div class="msg assistant" data-id="${esc(e.id)}"${at ? ` title="${esc(fullTime(at))}"` : ""}>${quote(e)}${md(e.text)}${imagesIn(e.text)}${msgActs(e, at)}</div></div>`;
          sinceUser++; lastEvent = ""; lastCollie = e.id; sinceCollie = 0;
        } else {
          lastEvent = e.ref || "";
          // A worker's line opens the session it was about: its record once
          // that session ended (a name is reused after), else its pane.
          const past = e.ref && e.ref !== ROUTER ? workerHist(e.ref, e.at) : null;
          const pane = !past && e.ref ? paneOf(e.ref) : null;
          const tag = past ? `a href="#/h/${encodeURIComponent(past.id)}" title="看它的完整记录"` : pane ? `a href="#/p/${encodeURIComponent(pane)}"` : "div";
          // A spawn line spins only while that worker is still at it; history stays still.
          const w = e.tone === "spawn" ? sup.workers.find((x) => x.name === e.ref) : null;
          const busy = w && workerBusy(w);
          const stuck = w && !w.ended && w.status === "blocked";
          const tone = e.tone === "blocked" ? "blocked" : e.tone === "done" ? "done" : e.tone === "spawn" ? (busy ? "working" : stuck ? "blocked" : "unknown") : e.tone === "error" ? "failed" : "unknown";
          // A spawn line carries its worker's state, in place of a line per change.
          const state = w ? (w.ended ? "已结束" : busy ? "还在跑" : stuck ? "等你确认" : "") : "";
          html += `<${tag} class="event ${e.tone === "error" ? "error" : ""}"><span class="dot ${tone}"></span><span class="when">${hhmm(e.at)}</span><span>${esc(e.text)}</span>${state ? `<span class="wstate">${state}</span>` : ""}</${tag.split(" ")[0]}>`;
        }
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

  $("#super-thread").addEventListener("click", (e) => {
    const idea = e.target.closest("[data-idea]")?.dataset.idea;
    if (idea) { $("#super-input").value = idea; grow($("#super-input")); $("#super-input").focus(); }
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
  // "派到": where this message's work runs. Shows the defaults from
  // 自动化 → 设置 (read again whenever this view opens); target holds only
  // what was picked here, so a message never carries a stale default.
  let target = null, targetDefault = null;
  async function renderTarget(fresh) {
    if (!targetDefault || fresh) {
      try {
        const s = (await api("/api/super/settings")).settings;
        targetDefault = { machine: s.worker_machine || "", kind: s.worker_kind === "antigravity" ? "agy" : s.worker_kind || "claude", model: s.worker_model || "", effort: s.worker_effort || "" };
      } catch { targetDefault ||= { machine: "", kind: "claude", model: "", effort: "" }; }
    }
    // What was picked here over the defaults: picking only an agent leaves the
    // computer at its default, not unset.
    const t = targetNow();
    const ms = (state.machines || [{ id: "", name: "本机", local: true }]).filter((m) => !m.hub && (m.local ? state.ok !== false : m.online || m.id === t.machine));
    const fill = (sel, html) => { if (sel._html !== html) { sel._html = html; sel.innerHTML = html; } };
    const mSel = $("#t-machine"), kSel = $("#t-kind");
    fill(mSel, ms.map((m) => `<option value="${esc(m.id)}" data-dot="${m.local || m.online ? "online" : "offline"}"
      data-sub="${m.local ? "hub" : m.os || ""}${m.id === targetDefault.machine ? " · 默认" : ""}" ${m.id === t.machine ? "selected" : ""}>${esc(m.name)}</option>`).join(""));
    const have = ms.find((m) => m.id === t.machine)?.agents;
    fill(kSel, [["claude", "Claude"], ["codex", "Codex"], ["agy", "Antigravity"]].map(([k, l]) => {
      const missing = Array.isArray(have) && !have.includes(k);
      const sub = [missing ? "这台电脑没装" : "", k === targetDefault.kind ? "默认" : ""].filter(Boolean).join(" · ");
      return `<option value="${k}" data-glyph="${k}" data-short="${KIND_LABEL[k]}" ${sub ? `data-sub="${sub}"` : ""} ${missing && k !== t.kind ? "disabled" : ""} ${k === t.kind ? "selected" : ""}>${l}</option>`;
    }).join(""));
    mSel.value = t.machine; kSel.value = t.kind;
    mSel.hidden = ms.length < 2;
    syncPick(mSel); syncPick(kSel);
    mSel._pick?.classList.toggle("changed", t.machine !== targetDefault.machine);
    kSel._pick?.classList.toggle("changed", t.kind !== targetDefault.kind);
    renderModelChips();
  }
  // The default model and effort belong to the default kind of agent; any
  // other kind starts from that agent's own settings.
  const modelDefaults = (t) => t.kind === targetDefault.kind ? { model: targetDefault.model, effort: targetDefault.effort } : { model: "", effort: "" };
  const modelNow = (t) => { const d = modelDefaults(t); return { model: t.model ?? d.model, effort: t.effort ?? d.effort, d }; };
  let chipSeq = 0;
  async function renderModelChips() {
    const seq = ++chipSeq, t = targetNow(), { model, effort, d } = modelNow(t);
    const mSel = $("#t-model"), eSel = $("#t-effort");
    const info = await modelsFor(t.kind, t.machine);
    if (seq !== chipSeq) return;
    const list = [...(info.models || [])];
    if (model && !list.some((m) => m.id === model)) list.unshift({ id: model });
    const short = (id) => id.split("/").pop();
    const mark = (v, dv) => (v === dv ? " · 默认" : "");
    let html = d.model ? "" : `<option value="" data-short="默认模型" data-sub="${esc(info.default ? "现在是 " + info.default + " · 默认" : "agent 自己的设置 · 默认")}">默认</option>`;
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
    mSel._pick?.classList.toggle("changed", model !== d.model);
    eSel._pick?.classList.toggle("changed", eff !== d.effort && eff !== "");
  }
  const pick = (o) => { target = { ...(target || {}), ...o }; };
  $("#t-machine").addEventListener("change", (e) => { pick({ machine: e.target.value }); renderTarget(); });
  $("#t-kind").addEventListener("change", (e) => { pick({ kind: e.target.value, model: undefined, effort: undefined }); renderTarget(); });
  $("#t-model").addEventListener("change", (e) => { pick({ model: e.target.value }); renderModelChips(); });
  $("#t-effort").addEventListener("change", (e) => { pick({ effort: e.target.value || modelDefaults(targetNow()).effort }); renderModelChips(); });
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
    // Only what was picked here goes along; the hub fills in its current defaults.
    const t = targetNow(), p = target || {};
    const { model, effort } = modelNow(t);
    const re = replyTo;
    setReply(null);
    // Your message shows at once; the hub's copy takes its place when it arrives.
    const mine = { id: "", role: "user", text, at: new Date().toISOString(), pending: true, re };
    pendingSays.push(mine);
    renderSuper(true);
    let r;
    try {
      r = await api("/api/super/say", { body: { text, re: re?.entry || "",
      machine: "machine" in p ? (t.machine || "local") : "",
      kind: "kind" in p ? t.kind : "",
      model: "model" in p || "kind" in p ? model : "",
      effort: "effort" in p || "kind" in p ? effort : "" } });
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

  // ───────────────────────────── automation view
  let autoTab = store.get("autoTab", "inbox");
  let autoTimer;
  $("#auto-tabs").addEventListener("click", (e) => {
    const t = e.target.closest("button")?.dataset.tab;
    if (!t) return;
    autoTab = t; store.set("autoTab", t);
    openAuto();
  });

  function openAuto() {
    memEditing = false;
    $("#auto-body")._memSig = "";
    $$("#auto-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === autoTab));
    clearInterval(autoTimer);
    loadAuto();
    if (autoTab === "inbox" || autoTab === "threads") autoTimer = setInterval(loadAuto, 4000);
    if (autoTab === "memory") autoTimer = setInterval(() => { if (!memEditing) loadAuto(); }, 5000);
  }

  async function loadAuto() {
    const body = $("#auto-body");
    try {
      if (autoTab === "inbox" || autoTab === "threads") {
        const r = await api("/api/super/triggers");
        if (view !== "auto") return;
        body.innerHTML = autoTab === "inbox" ? inboxHTML(r.triggers || []) : threadsHTML(r.threads || []);
      } else if (autoTab === "memory") {
        const r = await api("/api/super/memory");
        if (view !== "auto" || autoTab !== "memory" || memEditing) return;
        // Workers' states count too: the task cards show them.
        const sig = JSON.stringify(r) + sup.workers.map((w) => w.name + ":" + workerStatus(w)).join();
        if (sig !== body._memSig) {
          const open = new Set([...body.querySelectorAll("details[open]")].map((d) => d.dataset.path || d.querySelector("summary")?.textContent));
          const first = !body._memSig;
          body._memSig = sig; body.innerHTML = memoryHTML(r);
          if (!first) body.querySelectorAll("details").forEach((d) => d.open = open.has(d.dataset.path || d.querySelector("summary")?.textContent));
        }
        return;
      } else if (autoTab === "timers") {
        const r = await api("/api/super/timers");
        body.innerHTML = timersHTML(r.timers || []);
      } else {
        const r = await api("/api/super/settings");
        body.innerHTML = autoTab === "hooks" ? hooksHTML(r) : settingsHTML(r);
        if (autoTab !== "hooks") api("/api/super/lark?fresh").then((l) => {
          const el = $("#lark-who");
          if (el) el.textContent = l.ready ? `发给 ${l.who || "lark-cli 登录的人"}（以机器人身份）` : `${l.problem}，所以不会发`;
        }).catch(() => {});
      }
    } catch (err) { body.innerHTML = `<p class="panel-intro">${esc(err.message)}</p>`; }
  }

  // ───────────────────────────── memory: what Collie keeps between sessions
  let memEditing = false;
  const kb = (n) => (n / 1024).toFixed(1) + " KB";
  const dayTime = (t) => {
    const d = new Date(t), today = new Date().toDateString(), tmr = new Date(Date.now() + 864e5).toDateString();
    const hm = d.toTimeString().slice(0, 5);
    return d.toDateString() === today ? "今天 " + hm : d.toDateString() === tmr ? "明天 " + hm : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  };
  function memoryHTML(r) {
    const files = r.files || [];
    const by = (f) => files.filter(f);
    const over = r.loaded > r.budget;
    const dream = r.dreaming ? `<b>Collie 正在做梦</b>：回顾最近的对话，整理记忆。整理完会自己醒来，期间的消息会先攒着。`
      : `上次做梦：${r.last_dream ? dayTime(r.last_dream) : "还没有"}　·　下次：${r.next_dream ? dayTime(r.next_dream) + "（当天有新对话才会做）" : "已关闭"}`;
    const firstLine = (t, dflt) => t.split("\n").filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/^[>*\-\s]+/, "").replace(/`|\*\*/g, "").trim()).find(Boolean) || dflt;
    // A task names the workers on it: show them live, and open their session.
    const crew = (f) => {
      const latest = new Map(); // a name can be reused: the newest one
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
    const card = (f, o = {}) => {
      const edit = !f.legacy && o.edit !== false;
      return `<details class="mem-fold" ${o.open ? "open" : ""} data-path="${esc(f.name)}"><summary>
          <span class="mono mem-name">${esc(o.label || f.name)}</span><span class="grow">${esc(o.sub ?? firstLine(f.text, ""))}</span><span class="muted">${kb(f.size)}</span></summary>
        <div class="mem-body msg assistant" data-view>${md(f.text)}</div>
        ${edit ? `<div class="mem-tools">${o.crew ? crew(f) : ""}<span class="muted grow">${esc(dayTime(f.mod))} 更新</span><button class="btn small" data-act="mem-edit">编辑</button></div>
        <form class="mem-edit" hidden><textarea name="text" spellcheck="false">${esc(f.text)}</textarea>
          <div class="form-actions"><span class="muted grow">Collie 下次读这个文件时生效。</span><button type="button" class="btn small" data-act="mem-cancel">取消</button><button class="btn primary small">保存</button></div></form>` : ""}
      </details>`;
    };
    const group = (title, note, list, o = {}) => list.length || o.always ? `<h4 class="mem-h">${title}<span class="muted">${note}</span></h4>
      <div class="card">${list.length ? list.map((f, i) => card(f, typeof o.card === "function" ? o.card(f, i) : o.card || {})).join("") : `<div class="empty-row">${o.empty || "空"}</div>`}</div>` : "";
    const ins = by((f) => f.name === "instructions.md");
    const tasks = by((f) => /^tasks\/[^/]+\.md$/.test(f.name));
    const notes = by((f) => f.name.startsWith("notes/")).sort((a, b) => (a.name === "notes/index.md" ? -1 : b.name === "notes/index.md" ? 1 : a.name.localeCompare(b.name)));
    const done = by((f) => f.name.startsWith("tasks/done/")).sort((a, b) => new Date(b.mod) - new Date(a.mod));
    const msgs = by((f) => f.name === "messages.md");
    const legacy = by((f) => f.legacy);
    return `<p class="panel-intro">Collie 的长期记忆在 <code>${esc(r.dir)}/memory</code>，按用途分开：每次新会话只先读<b>指令、笔记索引、进行中的任务和最近说过的话</b>，其余需要时再看。
      「做梦」时，Collie 回顾最近的会话来整理记忆：替换过时的条目，发现只有跨多次对话才看得出的习惯（标记为 inferred）。</p>
      <div class="card"><div class="mem-dream"><span class="dot ${r.dreaming ? "starting" : "asleep"}"></span><span class="grow">${dream}</span>
        <button class="btn small" data-act="dream-now" ${r.dreaming ? "disabled" : ""}>${r.dreaming ? "做梦中…" : "现在整理"}</button></div>
        <div class="mem-dream mem-load"><span class="grow">每次新会话先读：<b class="${over ? "warn" : ""}">${kb(r.loaded)}</b> / 建议 ${kb(r.budget)} 以内${over ? "（偏大，做梦时会精简）" : ""}</span></div></div>
      ${legacy.length ? group("旧版记忆", "等下次做梦或换会话时拆进 memory/", legacy, { card: { open: true } }) : ""}
      ${group("指令", "你的长期要求和偏好，每次都读", ins, { card: { open: true, label: "instructions.md", sub: "" }, always: true, empty: "还没有" })}
      ${group("进行中的任务", "一件事一个文件，每次都读", tasks, { card: { label: undefined, crew: true }, always: true, empty: "没有进行中的任务" })}
      ${group("笔记", "只先读索引，其余需要时读", notes, { card: (f) => ({ open: f.name === "notes/index.md", label: f.name.replace(/^notes\//, "") }) })}
      ${group("最近说过的话", "hub 自动记录，避免重复", msgs, { card: { edit: false, label: "messages.md" } })}
      ${r.dreams.length ? `<h4 class="mem-h">做梦日记</h4><div class="card">${r.dreams.map((d, i) => `<details class="mem-fold" ${i === 0 ? "open" : ""}><summary><span class="muted mono mem-name">${esc(d.name.replace(/\.md$/, ""))}</span><span class="grow">${esc(firstLine(d.text, d.name))}</span></summary><div class="mem-body msg assistant">${md(d.text)}</div></details>`).join("")}</div>` : ""}
      ${group("已完成", "做完或放弃的任务", done, { card: (f) => ({ label: f.name.replace(/^tasks\/done\//, ""), crew: true }) })}`;
  }

  function inboxHTML(ts) {
    return `<p class="panel-intro">你的消息、外部事件、定时器，以及派出的 agent 完成或卡住，都会进这里。先按来源策略过滤；订阅了线程的 agent 直接收到，其余交给 Collie 判断。对方正忙时事件会先攒着，空闲后一次送过去。</p>
      <div class="card"><ul class="rows">${ts.length ? ts.map((t) => `<li class="row">
        <span class="badge ${esc(t.status === "queued" ? "queued" : t.status === "ignored" ? "ignored" : t.action === "candidate" ? "candidate" : "")}">${esc({ queued: "排队", delivered: "已投递", ignored: "已忽略" }[t.status] || t.status)}</span>
        <div><div class="meta"><b>#${esc(t.id)}</b><span>${esc(SOURCE_LABEL[t.source] || t.source)}</span><span>${esc(t.thread)}</span>${t.from ? `<span>from ${esc(t.from === ROUTER ? "Collie" : t.from)}</span>` : ""}${t.targets?.length ? `<span>→ ${esc(t.targets.map((x) => x === ROUTER ? "Collie" : x).join(", "))}</span>` : ""}${t.action === "candidate" ? "<span>candidate</span>" : ""}</div>
        <div class="text">${esc(t.text)}</div></div>
        <span class="right">${when(t.at)}</span></li>`).join("") : `<li class="empty-row">收件箱是空的</li>`}</ul></div>`;
  }

  function threadsHTML(ths) {
    return `<p class="panel-intro">同一个对话、Issue/PR 或群聊话题里的连续事件构成一条线程。Collie 派出的 agent 订阅线程后，后续事件直达它，不再经过 Collie。chat:main 始终由 Collie 自己处理。</p>
      <div class="card"><ul class="rows">${ths.length ? ths.map((th) => `<li class="row">
        <span class="badge">${th.triggers?.length || 0}</span>
        <div><div class="meta"><b>${esc(th.id)}</b>${th.subscribers?.length ? `<span>订阅：${esc(th.subscribers.join(", "))}</span>` : "<span>→ Collie</span>"}</div></div>
        <span class="right">${when(th.last_at)}</span></li>`).join("") : `<li class="empty-row">还没有线程</li>`}</ul></div>`;
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
    return `<p class="panel-intro">到点会给 Collie（或某个 agent）发一条消息：每天的例行检查、过一会儿的跟进提醒。Collie 自己也会设定时来跟进。</p>
      <div class="card"><div class="card-h">新建定时</div>
        <form class="form tm-form" id="timer-form" data-mode="weekdays">
          <div class="tm-row"><span class="tm-lab">什么时候</span>
            <div class="seg tm-mode">${[["daily", "每天"], ["weekdays", "工作日"], ["weekly", "每周"], ["every", "每隔"], ["once", "一次"]].map(([m, l]) => `<button type="button" data-mode="${m}">${l}</button>`).join("")}</div>
          </div>
          <div class="tm-row tm-when">
            <span class="tm-lab"></span>
            <div class="tm-days" data-show="weekly">${WEEK.map(([d, l], i) => `<button type="button" data-day="${d}" class="${i === 0 ? "on" : ""}">${l}</button>`).join("")}</div>
            <input type="time" name="clock" value="09:00" data-show="daily weekdays weekly">
            <span class="tm-every" data-show="every"><input type="number" name="every_n" min="1" value="2"><select name="every_u" data-title="单位"><option value="m">分钟</option><option value="h" selected>小时</option><option value="d">天</option></select></span>
            <span class="tm-once" data-show="once"><input type="datetime-local" name="at" value="${localStamp(soon)}">
              ${[["30 分钟后", 30], ["1 小时后", 60], ["明早 9 点", "am"]].map(([l, v]) => `<button type="button" class="chip-btn" data-at="${v}">${l}</button>`).join("")}</span>
          </div>
          <label class="tm-text"><span class="tm-lab">说什么</span><textarea name="text" rows="2" placeholder="例如：检查各个任务的进展，有卡住的告诉我" required></textarea></label>
          <div class="tm-foot">
            <label class="tm-target"><span class="tm-lab">交给</span><select name="target" data-title="到点交给谁"><option value="" data-sub="由它决定怎么处理">Collie</option>${sup.workers.filter((w) => !w.ended).map((w) => `<option value="${esc(w.name)}" data-sub="${esc(KIND_LABEL[w.kind] || w.kind)}">${esc(w.name)}</option>`).join("")}</select></label>
            <span class="tm-sum muted"></span>
            <button class="btn primary small">添加</button>
          </div>
        </form></div>
      <div class="card"><ul class="rows">${ts.length ? ts.map((t) => `<li class="row">
        <span class="badge ${t.enabled ? "queued" : "ignored"}">${t.enabled ? "启用" : "已结束"}</span>
        <div><div class="meta"><b title="${esc(t.spec)}">${esc(describeSpec(t.spec))}</b><span>→ ${esc(t.target || "Collie")}</span>${t.enabled ? `<span>下次 ${when(t.next_run)}</span>` : ""}${t.owner ? `<span>${t.owner === "you" ? "你设的" : esc(t.owner) + " 设的"}</span>` : ""}</div>
        <div class="text">${esc(t.text)}</div></div>
        <button class="btn ghost small" data-del-timer="${esc(t.id)}">删除</button></li>`).join("") : `<li class="empty-row">还没有定时</li>`}</ul></div>`;
  }
  // Timer form: mode, days and quick times are buttons; everything re-describes the spec.
  $("#auto-body").addEventListener("click", (e) => {
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
  $("#auto-body").addEventListener("input", (e) => { const f = e.target.closest("#timer-form"); if (f) syncTimerForm(f); });
  $("#auto-body").addEventListener("change", (e) => { const f = e.target.closest("#timer-form"); if (f) syncTimerForm(f); });

  function hooksHTML(r) {
    const base = location.origin + "/hooks/";
    const url = (src) => `${base}${src}?key=${r.hook_key}`;
    return `<p class="panel-intro">把外部事件接进来。Webhook 立即返回 202，过滤和路由在收件箱里异步完成。未经请求的事件默认是 <b>candidate</b>：只有 Collie 的记忆或你的规则覆盖到时才会行动，否则保持安静。</p>
      <div class="card"><div class="card-h">Webhook 地址</div><div class="form">
        <label>GitHub <small>Settings → Webhooks，Content type 选 application/json</small><div class="code"><span>${esc(url("github"))}</span><button class="icon-btn" data-copy="${esc(url("github"))}" title="复制"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></button></div></label>
        <label>飞书 / Lark <small>事件订阅的请求地址，已支持 url_verification</small><div class="code"><span>${esc(url("feishu"))}</span><button class="icon-btn" data-copy="${esc(url("feishu"))}" title="复制"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></button></div></label>
        <label>通用 <small>POST JSON：{"text","thread","from","id"}，source 名可自取</small><div class="code"><span>curl -X POST '${esc(url("ci"))}' -H 'Content-Type: application/json' -d '{"thread":"build-42","text":"nightly build failed"}'</span></div></label>
      </div></div>
      <div class="card"><div class="card-h">来源策略（快路径）<button class="btn small" id="add-policy">添加</button></div>
        <div id="policies">${(r.policies || []).map(policyRow).join("")}</div>
        <div class="form"><div class="form-actions"><button class="btn primary small" id="save-policies">保存策略</button></div></div></div>`;
  }

  function policyRow(p = { source: "webhook:", action: "candidate", allow: [] }) {
    return `<div class="policy">
      <input data-f="source" value="${esc(p.source)}" placeholder="webhook:github">
      <select data-f="action">${["respond", "candidate", "ignore"].map((a) => `<option value="${a}" ${p.action === a ? "selected" : ""}>${{ respond: "直接响应", candidate: "候选（Collie 判断）", ignore: "忽略" }[a]}</option>`).join("")}</select>
      <input data-f="allow" value="${esc((p.allow || []).join(", "))}" placeholder="白名单（可选，逗号分隔）">
      <button class="icon-btn" data-del-policy title="删除"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>`;
  }

  // ───────────────────────────── settings: grouped by what they are about
  // Fills a model picker and its effort picker from what that agent offers.
  async function fillModels(form, who) {
    const kindSel = form[who + "_kind"], modelSel = form[who + "_model"], effSel = form[who + "_effort"];
    const machine = who === "worker" && form.worker_machine ? form.worker_machine.value : "";
    const want = modelSel.dataset.value ?? modelSel.value, wantEff = effSel.dataset.value ?? effSel.value;
    modelSel.innerHTML = `<option value="">读取中…</option>`;
    const info = await modelsFor(kindSel.value, machine);
    const list = [...(info.models || [])];
    if (want && !list.some((m) => m.id === want)) list.unshift({ id: want });
    const sub = (m) => [m.label && m.label !== m.id ? m.id : "", m.note && m.note !== m.id && !(m.label && m.note.startsWith(m.label)) ? m.note : ""].filter(Boolean).join(" · ");
    modelSel.innerHTML = `<option value="" data-sub="${esc(info.default ? "现在是 " + info.default : "用 agent 自己的设置")}">默认</option>`
      + list.map((m) => `<option value="${esc(m.id)}" data-sub="${esc(sub(m))}" ${m.id === want ? "selected" : ""}>${esc(m.label || m.id)}</option>`).join("")
      + `<option value="__custom" data-sub="输入列表里没有的模型名">其他…</option>`;
    delete modelSel.dataset.value;
    const fillEffort = () => {
      const m = list.find((x) => x.id === modelSel.value);
      const effs = m?.efforts?.length ? m.efforts : (info.efforts || []);
      const cur = effSel.dataset.value ?? effSel.value;
      effSel.innerHTML = `<option value="" data-sub="${esc(info.default_effort ? "现在是 " + (EFFORT_LABEL[info.default_effort] || info.default_effort) : "用 agent 自己的设置")}">默认</option>`
        + effs.map((e) => `<option value="${esc(e)}" data-sub="${esc(e)}" ${e === cur ? "selected" : ""}>${esc(EFFORT_LABEL[e] || e)}</option>`).join("");
      delete effSel.dataset.value;
      effSel.disabled = effs.length === 0;
    };
    fillEffort();
    modelSel.onchange = () => {
      if (modelSel.value === "__custom") {
        const v = (prompt("模型名（照 agent 的 --model 参数写）") || "").trim();
        if (v) modelSel.add(new Option(v, v, true, true), 1);
        else modelSel.value = "";
      }
      fillEffort();
    };
  }
  function bindSettings(form) {
    if (!form || form._bound) return;
    form._bound = true;
    for (const who of ["router", "worker"]) {
      fillModels(form, who);
      form[who + "_kind"].addEventListener("change", () => { form[who + "_model"].value = ""; form[who + "_effort"].value = ""; fillModels(form, who); });
    }
    form.worker_machine?.addEventListener("change", () => fillModels(form, "worker"));
  }

  function settingsHTML(r) {
    const s = r.settings;
    const kindOpts = (v) => [["claude", "Claude", "claude"], ["codex", "Codex", "codex"], ["antigravity", "Antigravity", "agy"]].map(([k, l, g]) => `<option value="${k}" data-glyph="${g}" ${v === k ? "selected" : ""}>${l}</option>`).join("");
    const modelPick = (who, model, effort) => `
          <label>模型<select name="${who}_model" data-title="模型" data-value="${esc(model || "")}"><option value="${esc(model || "")}" selected>${esc(model || "默认")}</option></select></label>
          <label>思考强度<select name="${who}_effort" data-title="思考强度" data-value="${esc(effort || "")}"><option value="${esc(effort || "")}" selected>${esc(EFFORT_LABEL[effort] || effort || "默认")}</option></select></label>`;
    const many = (state.machines || []).length > 1;
    setTimeout(() => bindSettings($("#settings-form")));
    return `<form class="settings" id="settings-form">
      <section class="card set-sec">
        <header><h4>Collie 自己</h4><p>只负责理解、分派和回复，轻量快速的模型就够。它在 <code>${esc(tilde(r.router_dir))}</code> 里工作：ROUTER.md 是操作手册，memory/ 是长期记忆。</p></header>
        <div class="set-grid three">
          <label>Agent<select name="router_kind" data-title="Collie 自己用的 agent">${kindOpts(s.router_kind)}</select></label>
          ${modelPick("router", s.router_model, s.router_effort)}
        </div>
        <details class="set-adv" ${(s.router_args || []).length ? "open" : ""}><summary>更多启动参数</summary>
          <label><input name="router_args" class="mono" value="${esc((s.router_args || []).join(" "))}" placeholder="例如 --permission-mode plan"><small>原样加在启动命令后面，一般不用填</small></label>
        </details>
      </section>

      <section class="card set-sec">
        <header><h4>派活默认</h4><p>Collie 派 agent 干活时默认这样启动；你说「用 Codex…」「在 Mac 上…」时它会自己换。</p></header>
        <div class="set-grid three">
          <label>Agent<select name="worker_kind" data-title="派活默认用">${kindOpts(s.worker_kind)}</select></label>
          ${modelPick("worker", s.worker_model, s.worker_effort)}
        </div>
        <div class="set-grid three">
          ${many ? `<label>电脑<select name="worker_machine" data-title="派活默认在哪台电脑">${state.machines.map((m) => `<option value="${esc(m.id)}" data-dot="${m.local || m.online ? "online" : "offline"}" ${m.id === (s.worker_machine || "") ? "selected" : ""}>${esc(m.name)}${m.local ? "（hub）" : m.online ? "" : "（离线）"}</option>`).join("")}</select></label>` : ""}
          <label class="${many ? "span2" : "span3"}">目录<input name="worker_cwd" class="mono" value="${esc(tilde(s.worker_cwd))}"></label>
        </div>
      </section>

      <section class="card set-sec">
        <header><h4>记忆与会话</h4><p>Collie 的对话变长后会换新会话，要记住的事通过 memory/ 交接；每晚回顾当天的对话，整理记忆。</p></header>
        <div class="set-grid">
          <label>上下文用到多少时换新会话<select name="rotate_pct" data-title="上下文用到多少时换新会话">${[50, 60, 70, 80, -1].map((p) => `<option value="${p}" ${(s.rotate_pct || 60) === p ? "selected" : ""}>${p < 0 ? "从不" : p + "%"}</option>`).join("")}</select><small>窗口大小按 agent 自己的设置算</small></label>
          <label>每晚做梦<select name="dream_at" data-title="每晚做梦">${["02:00", "04:00", "06:00", "off"].map((t) => `<option value="${t}" ${(s.dream_at || "04:00") === t ? "selected" : ""}>${t === "off" ? "不做" : t}</option>`).join("")}</select><small>当天没有新对话就跳过</small></label>
        </div>
      </section>

      <section class="card set-sec">
        <header><h4>通知</h4></header>
        <div class="set-grid">
          <label class="check span3"><input type="checkbox" name="notify_lark" ${s.notify_lark ? "checked" : ""}> 用 hub 上的 lark-cli 发飞书消息给你<small id="lark-who" class="muted">· 正在看 hub 上的 lark-cli…</small></label>
          <label>Webhook<input name="notify_webhook" value="${esc(s.notify_webhook || "")}" placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…"><small>飞书 / Lark 机器人或 Slack</small></label>
          <label>什么时候推送<select name="notify_level" data-title="什么时候推送"><option value="quiet" ${s.notify_level === "quiet" ? "selected" : ""} data-sub="卡住、要你确认、出错">只在需要你时</option><option value="normal" ${s.notify_level === "normal" ? "selected" : ""} data-sub="外加 Collie 的回复，比如做完事的汇报">也推送 Collie 的回复</option></select><small>你正开着 Collie 的网页时不推</small></label>
        </div>
      </section>

      <section class="card set-sec">
        <header><h4>其他</h4></header>
        <div class="set-grid">
          <label>聊天回复长度<input name="reply_chars" type="number" min="40" step="20" value="${s.reply_chars || 200}"><small>Collie 平时每条回复大约多少字（英文按词算）；你要详细时它会写长</small></label>
          <label>多久没进展算卡住<input name="stall_minutes" type="number" min="0" value="${s.stall_minutes}"><small>分钟；0 表示不检查</small></label>
        </div>
        <label class="check"><input type="checkbox" name="bypass" ${s.ask_permissions ? "" : "checked"}> 跳过权限确认：Collie 和它派出的 agent 直接跑命令、改文件，不停下来问你（重启 Collie、新派的 agent 生效）</label>
        <label class="check"><input type="checkbox" name="paused" ${s.paused ? "checked" : ""}> 暂停投递：事件照收，先不交给 agent</label>
      </section>

      <div class="set-actions"><button type="button" class="btn small" data-act="router-restart">重启 Collie</button><span class="grow"></span><button class="btn primary small">保存</button></div>
    </form>`;
  }

  $("#auto-body").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      if (f.id === "timer-form") {
        const r = timerSpec(f);
        if (r.err) { toast(r.err, "attn"); return; }
        await api("/api/super/timers", { body: { spec: r.spec, text: f.text.value, target: f.target.value, owner: "you" } });
        toast(`已添加：${describeSpec(r.spec)}`);
        loadAuto();
      } else if (f.classList.contains("mem-edit")) {
        await api("/api/super/memory", { body: { path: f.closest("[data-path]").dataset.path, text: f.text.value } });
        memEditing = false;
        toast("已保存");
        loadAuto();
      } else if (f.id === "settings-form") {
        const cur = (await api("/api/super/settings")).settings;
        const s = {
          ...cur,
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
        await api("/api/super/settings", { body: { settings: s } });
        renderTarget(true);
        const relaunch = s.router_kind !== cur.router_kind || s.router_model !== (cur.router_model || "") || s.router_effort !== (cur.router_effort || "") || s.router_args.join(" ") !== (cur.router_args || []).join(" ") || s.ask_permissions !== !!cur.ask_permissions;
        toast(relaunch ? "已保存。Collie 自己的启动设置在重启 Collie 后生效" : "已保存");
      }
    } catch (err) { toast(err.message, "attn"); }
  });

  $("#auto-body").addEventListener("click", async (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.act === "mem-edit" || t.dataset.act === "mem-cancel") {
      const box = t.closest("[data-path]");
      memEditing = t.dataset.act === "mem-edit";
      box.querySelector(".mem-edit").hidden = !memEditing;
      box.querySelector("[data-view]").hidden = memEditing;
      box.querySelector(".mem-tools").hidden = memEditing;
      if (memEditing) box.querySelector("textarea").focus();
      else { $("#auto-body")._memSig = ""; loadAuto(); }
      return;
    }
    if (t.dataset.act === "dream-now") {
      t.disabled = true; t.textContent = "开始中…";
      try { await api("/api/super/dream", { body: {} }); toast("Collie 去做梦了"); }
      catch (err) { toast(err.message, "attn"); }
      loadAuto();
      return;
    }
    if (t.dataset.delTimer) {
      await api(`/api/super/timers/${t.dataset.delTimer}/delete`, { method: "POST", body: {} }).catch((err) => toast(err.message));
      loadAuto();
    } else if (t.dataset.copy) {
      await copy(t.dataset.copy); toast("已复制");
    } else if (t.id === "add-policy") {
      $("#policies").insertAdjacentHTML("beforeend", policyRow());
    } else if (t.hasAttribute("data-del-policy")) {
      t.closest(".policy").remove();
    } else if (t.id === "save-policies") {
      const policies = $$(".policy").map((row) => ({
        source: $("[data-f=source]", row).value.trim(), action: $("[data-f=action]", row).value,
        allow: $("[data-f=allow]", row).value.split(",").map((x) => x.trim()).filter(Boolean),
      })).filter((p) => p.source);
      try { await api("/api/super/settings", { body: { policies } }); toast("策略已保存"); } catch (err) { toast(err.message, "attn"); }
    }
  });

  // ───────────────────────────── agents in other terminals (outside herdr)
  let ext = [], extTimer, extStream = null, extCur = null;
  async function loadExternal() {
    if (document.hidden && ext.length) return;
    try { ext = (await api("/api/external")).sessions || []; } catch { return; }
    ext = ext.concat(...await fromHubs("/api/external", "ext"));
    renderExt();
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
    renderHist();
    if (view === "collie") renderSuper();
    if (view === "ext" && extCur?.startsWith("h:")) renderHistHead(extCur.slice(2));
  }
  const ago = (t) => {
    const s = (Date.now() - new Date(t)) / 1000;
    return s < 90 ? "刚刚" : s < 3600 ? Math.round(s / 60) + " 分钟前" : s < 86400 ? Math.round(s / 3600) + " 小时前" : Math.round(s / 86400) + " 天前";
  };
  const histName = (h) => h.title || (h.name && !autoName(h.name) ? h.name : base(tilde(h.cwd)));
  const histOnline = (h) => !h.machine || (state.machines || []).some((m) => m.id === h.machine && m.online);
  const renderHist = () => renderSessions();
  function renderHistHead(hid) {
    const h = hist.find((x) => x.id === hid);
    const on = h && histOnline(h);
    $("#x-name").textContent = h ? histName(h) : "已结束的会话";
    $("#x-kind").textContent = h ? KIND_LABEL[h.kind] || h.kind : "";
    $("#x-tag").textContent = "已结束";
    $("#x-status").className = "status ended";
    $("#x-status").textContent = h ? "结束于 " + ago(h.ended) : "";
    $("#x-cwd").textContent = h ? (h.machine ? machineName(h.machine) + " · " : "") + tilde(h.cwd) : "";
    $("#x-note").textContent = !h ? "这条记录已经不在了。"
      : on ? `继续会${h.machine ? "在 " + machineName(h.machine) + " 上" : ""}用同一个会话重新打开 ${KIND_LABEL[h.kind] || h.kind}，之前的上下文都还在。`
      : `${machineName(h.machine)} 现在不在线，连上后才能继续。`;
    const b = $("#x-takeover");
    b.textContent = "继续这个会话";
    b.hidden = false;
    b.disabled = !on;
    $("#x-forget").hidden = !h;
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
  const RESUME = { claude: (s) => ["--resume", s], codex: (s) => ["resume", s], agy: (s) => ["--conversation", s] };
  async function continueHist(hid) {
    const h = hist.find((x) => x.id === hid);
    if (!h || !RESUME[h.kind]) return;
    const b = $("#x-takeover");
    b.disabled = true; b.textContent = "正在打开…";
    try {
      const r = await api("/api/agents", { body: {
        kind: h.kind, cwd: h.cwd, machine: h.machine || "", name: "", label: histName(h).slice(0, 40), args: RESUME[h.kind](h.session),
      } });
      if (r.warning) toast(r.warning);
      await api(`/api/history/${encodeURIComponent(h.id)}/delete`, { body: {} }).catch(() => {});
      hist = hist.filter((x) => x.id !== h.id);
      renderHist();
      location.hash = "#/p/" + encodeURIComponent(r.pane_id);
    } catch (err) {
      toast(err.message, "attn");
      renderHistHead(hid);
    }
  }
  $("#x-forget").addEventListener("click", async () => {
    const hid = extCur?.startsWith("h:") && extCur.slice(2);
    if (!hid) return;
    try { await api(`/api/history/${encodeURIComponent(hid)}/delete`, { body: {} }); } catch (err) { toast(err.message, "attn"); return; }
    hist = hist.filter((x) => x.id !== hid);
    renderHist();
    location.hash = "#/";
  });
  const extName = (e) => e.title || (e.cwd ? e.cwd.split(/[\\/]/).filter(Boolean).pop() : "") || KIND_LABEL[e.kind] || e.kind;
  // The sidebar, by what you need: what is going on now (herdr agents, yours
  // and Collie's, and other apps' running sessions), then what you did lately
  // (other apps' resting conversations and ended herdr sessions, merged).
  // Which computer something is on is a detail on its row.
  const RECENT_N = 8;
  let extAll = store.get("extAll", false);
  const EXT_STATE = { working: "在干活", waiting: "在等后台任务", idle: "开着，在等你", blocked: "等电脑那边确认" };
  const RANK = { working: 0, waiting: 0.5, starting: 1, blocked: 2, done: 3, unknown: 4, idle: 4 };
  function renderExt() { renderSessions(); }
  $("#live-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-fold]");
    if (!b) return;
    store.set("idleOpen", !store.get("idleOpen", false));
    renderSessions();
  });
  function renderSessions() {
    const many = (state.machines || []).length > 1;
    const extRow = (e) => {
      const open = e.live && e.status === "idle";
      const where = [e.app || KIND_LABEL[e.kind] || e.kind, many && e.machine ? machineName(e.machine) : "", e.live && !open ? "" : ago(e.updated || e.started)].filter(Boolean).join(" · ");
      const dot = e.live ? `<span class="dot ${esc(e.status || "unknown")}" title="${esc(EXT_STATE[e.status] || "正在运行")}"></span>` : "";
      return `<li><a class="item ${e.live ? "" : "ended"} ${view === "ext" && extCur === e.id ? "active" : ""}" href="#/x/${encodeURIComponent(e.id)}">
        <span class="glyph">${GLYPHS[e.kind] || GLYPHS.agent}</span>
        <span class="body"><div class="name">${esc(extName(e))}</div><div class="sub">${esc(where)}</div></span>${dot}</a></li>`;
    };
    const histRow = (h) => {
      const sub = [KIND_LABEL[h.kind] || h.kind, many ? machineName(h.machine) : "", ago(h.ended)].filter(Boolean).join(" · ");
      return `<li><a class="item ended ${view === "ext" && extCur === "h:" + h.id ? "active" : ""}" href="#/h/${encodeURIComponent(h.id)}">
        <span class="glyph">${GLYPHS[h.kind] || GLYPHS.agent}</span>
        <span class="body"><div class="name">${esc(histName(h))}</div><div class="sub">${esc(sub)}</div></span></a></li>`;
    };

    // 进行中: needs-you rows are already above. Another app's session that is
    // only open (kept alive in the background, nothing running) stays here,
    // marked, below the busy ones.
    const going = (e) => e.live;
    const panes = state.agents.filter((a) => a.name !== ROUTER && a.status !== "blocked")
      .map((a) => ({ rank: RANK[a.status] ?? 3, done: a.status === "done", html: itemHTML(a), on: view === "pane" && a.pane_id === current }));
    const liveExt = ext.filter(going).map((e) => ({ rank: RANK[e.status] ?? 3, done: e.status === "done", html: extRow(e), on: view === "ext" && extCur === e.id }));
    const live = [...panes, ...liveExt].sort((x, y) => x.rank - y.rank);
    const busy = live.filter((x) => x.rank <= 1).length;
    $("#live-count").textContent = busy ? `${busy} 个在跑` : live.length || "";
    // Sessions that are only open (idle, a plain terminal) fold into one row
    // once there are more than a few, so 最近 stays within reach. One that just
    // finished has a result to look at, so it stays listed, as does the one on
    // screen.
    const folds = (x) => x.rank >= 3 && !x.done;
    const idle = live.filter(folds);
    let rows = live;
    if (idle.length > 3) {
      const open = store.get("idleOpen", false);
      const shown = live.filter((x) => !folds(x) || open || x.on);
      const hid = idle.length - (open ? 0 : idle.filter((x) => x.on).length);
      rows = [...shown, { html: `<li><button type="button" class="fold-row ${open ? "open" : ""}" data-fold="idle" aria-expanded="${open}">
        <svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>${open ? "收起空闲的" : `${hid} 个空闲`}</button></li>` }];
    }
    $("#live-list").innerHTML = rows.map((x) => x.html).join("")
      || `<li class="empty-hint">没有在跑的会话。点右上角 + 新建，或让 Collie 派一个。</li>`;

    // 最近: newest first; Collie's own sessions are reached from its conversation.
    const collieRan = (name) => name === ROUTER || sup.workers.some((w) => w.name === name);
    const recent = [
      ...ext.filter((e) => !going(e)).map((e) => ({ id: e.id, t: new Date(e.updated || e.started), html: extRow(e) })),
      ...hist.filter((h) => !collieRan(h.name)).map((h) => ({ id: "h:" + h.id, t: new Date(h.ended), html: histRow(h) })),
    ].sort((x, y) => y.t - x.t);
    let shown = extAll ? recent : recent.slice(0, RECENT_N);
    const cur = view === "ext" && extCur && !shown.some((x) => x.id === extCur) && recent.find((x) => x.id === extCur);
    if (cur) shown = [...shown, cur];
    $("#recent-group").hidden = !recent.length;
    $("#recent-list").innerHTML = shown.map((x) => x.html).join("")
      + (recent.length > RECENT_N ? `<li><button type="button" class="more-row" data-act="ext-more">${extAll ? "收起" : `还有 ${recent.length - RECENT_N} 个`}</button></li>` : "");
  }
  // Look up the open session again in a moment (a few times at most).
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
    const text = { working: `${e && e.app || "那边"}里还在跑…`, blocked: "在等你在电脑上确认" }[st];
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
    $("#x-tag").textContent = "只读";
    $("#x-forget").hidden = true;
    $("#x-takeover").textContent = "在 herdr 里接管";
    $("#x-takeover").className = "btn primary small";
    $("#x-composer").hidden = true;
    const e = ext.find((x) => x.id === extCur);
    if (!e) {
      $("#x-status").textContent = gone ? "已退出" : "正在连接那台电脑…";
      $("#x-status").className = "status " + (gone ? "ended" : "unknown");
      $("#x-takeover").disabled = true;
      if (!gone) extSoon();
      return;
    }
    $("#x-name").textContent = extName(e);
    $("#x-kind").textContent = KIND_LABEL[e.kind] || e.kind;
    $("#x-status").textContent = gone ? "已退出" : `正在运行 · ${e.app || "另一个终端"}`;
    $("#x-status").className = "status " + (gone ? "ended" : "unknown");
    $("#x-cwd").textContent = (e.machine ? machineName(e.machine) + " · " : "") + tilde(e.cwd);
    const app = e.app || "另一个终端";
    if (!e.live && !gone) {
      // A desktop app's conversation that is not running right now.
      $("#x-tag").textContent = e.can_send ? "可对话" : "只读";
      $("#x-status").textContent = `上次活动 ${ago(e.updated || e.started)} · ${app}`;
      $("#x-status").className = "status ended";
      $("#x-takeover").hidden = !e.can_take_over;
      $("#x-takeover").disabled = false;
      $("#x-takeover").textContent = "在 herdr 里继续";
      $("#x-takeover").className = "btn small";
      $("#x-composer").hidden = !e.can_send;
      if (e.can_send) $("#x-hint").textContent = e.kind === "agy" ? "经 Antigravity 送达" : "经 Codex App 送达";
      $("#x-note").textContent = e.can_send ? ""
        : (e.read_only || "") + (e.can_take_over ? "。也可以在 herdr 里用同一个会话继续，之后就能在这里对话。" : "");
      return;
    }
    $("#x-takeover").hidden = !e.can_take_over;
    $("#x-note").textContent = gone ? "这个进程已经退出了。"
      : !e.session ? `它跑在 ${app} 里，还没有会话记录，所以没法接管。`
      : `它跑在 ${app} 里，Collie 只能看，不能往里面打字。接管会先结束那边的进程（相当于按 Ctrl-C），再在 herdr 里接着同一个会话继续，之后就能在这里和它对话。`;
    $("#x-takeover").disabled = !!gone || !e.session;
    if (e.status && !gone) {
      $("#x-status").textContent = `${{ working: "正在跑", waiting: "在等后台任务", idle: "空闲，等你发话", blocked: "等电脑那边确认" }[e.status] || "正在运行"} · ${app}`;
      $("#x-status").className = "status " + e.status;
    }
    if (e.can_send && !gone) {
      // It takes messages where it runs: no need to take it over.
      $("#x-tag").textContent = "可对话";
      $("#x-composer").hidden = false;
      $("#x-takeover").className = "btn small";
      $("#x-hint").textContent = e.kind === "agy" ? "经 Antigravity 送达" : e.app === "Codex 桌面版" ? "经 Codex App 送达" : e.kind === "codex" ? "经 Codex 后台送达" : "经会话收件箱送达";
      $("#x-note").textContent = "";
    } else if (!gone && e.read_only && e.session) {
      $("#x-note").textContent = e.read_only + "。接管会先结束那边的进程（相当于按 Ctrl-C），再在 herdr 里接着同一个会话继续。";
    }
  }
  bindComposer($("#x-composer"), $("#x-input"), async (text) => {
    const e = ext.find((x) => x.id === extCur);
    if (!e) throw new Error("这个会话已经结束了");
    const r = await api(`/api/external/${encodeURIComponent(e.id)}/send`, { body: { text } });
    if (r.note) toast(r.note, "attn");
  });
  function closeExt() { extStream?.close(); extStream = null; }
  $("#recent-list").addEventListener("click", (ev) => {
    if (!ev.target.closest("[data-act=ext-more]")) return;
    ev.preventDefault();
    extAll = !extAll; store.set("extAll", extAll);
    renderExt();
  });
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
  $("#x-takeover").addEventListener("click", async () => {
    if (extCur?.startsWith("h:")) return continueHist(extCur.slice(2));
    const e = ext.find((x) => x.id === extCur);
    if (!e) return;
    const app = e.app || "另一个终端";
    if (e.live && !confirm(`接管「${extName(e)}」？\n\n会先结束 ${app} 里的这个 ${KIND_LABEL[e.kind] || e.kind} 进程（相当于按 Ctrl-C），然后在 herdr 里用同一个会话继续。${app} 那边会回到命令行。`)) return;
    const b = $("#x-takeover");
    b.disabled = true; b.textContent = "接管中…";
    try {
      const r = await api(`/api/external/${encodeURIComponent(e.id)}/takeover`, { body: {} });
      toast("已在 herdr 里接管");
      ext = ext.filter((x) => x.id !== e.id);
      renderExt();
      location.hash = "#/p/" + encodeURIComponent(r.pane_id);
    } catch (err) {
      toast(err.message, "attn");
      b.disabled = false;
    } finally { b.textContent = "在 herdr 里接管"; }
  });

  // ───────────────────────────── preferences (per device, in localStorage)
  const prefs = {
    theme: () => store.get("theme", "system"),
    text: () => store.get("text", "normal"),
    sendKey: () => store.get("sendKey", "enter"),
    notify: () => store.get("notify", true),
    fold: () => store.get("fold", true),
  };
  const darkMQ = matchMedia("(prefers-color-scheme: dark)");
  function applyLook() {
    const root = document.documentElement;
    const t = prefs.theme(), x = prefs.text();
    if (t === "system") delete root.dataset.theme; else root.dataset.theme = t;
    if (x === "normal") delete root.dataset.text; else root.dataset.text = x;
    const dark = t === "dark" || (t === "system" && darkMQ.matches);
    $$('meta[name="theme-color"]').forEach((m) => { m.removeAttribute("media"); m.content = dark ? "#0b0b0c" : "#ffffff"; });
    dispatchEvent(new Event("collie:theme"));
  }
  darkMQ.addEventListener("change", applyLook);
  applyLook();

  function renderPrefs() {
    const seg = (key, cur, opts) => `<div class="seg" data-pref="${key}">${opts.map(([v, label]) =>
      `<button type="button" data-v="${v}" class="${v === cur ? "on" : ""}">${label}</button>`).join("")}</div>`;
    const sw = (key, on) => `<button type="button" class="switch" role="switch" aria-checked="${on}" data-pref="${key}"></button>`;
    const row = (title, sub, ctl) => `<div class="pref"><div class="pl"><b>${title}</b>${sub ? `<small>${sub}</small>` : ""}</div>${ctl}</div>`;
    const perm = !("Notification" in window) ? "这个浏览器不支持通知（手机上通常要先添加到主屏幕）"
      : Notification.permission === "denied" ? "浏览器已拒绝通知，需要在浏览器的网站设置里打开"
      : "页面在后台时，agent 需要你确认或完成任务会弹通知";
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    $("#prefs-body").innerHTML = `<div class="prefs">
      <div class="card"><div class="card-h">外观</div>
        ${row("主题", "跟随系统时，设备切到深色模式这里也跟着变", seg("theme", prefs.theme(), [["system", '<span class="theme-swatch system"></span>跟随系统'], ["light", '<span class="theme-swatch light"></span>浅色'], ["dark", '<span class="theme-swatch dark"></span>深色']]))}
        ${row("对话文字", "", seg("text", prefs.text(), [["small", "小"], ["normal", "标准"], ["large", "大"]]))}
      </div>
      <div class="card"><div class="card-h">对话</div>
        ${row("打开 agent 时显示", "对话：从会话记录整理的消息；屏幕：终端原样；日志：自动换行的滚动输出", seg("mode2", mode, [["chat", "对话"], ["screen", "屏幕"], ["log", "日志"]]))}
        ${row("发送消息", "另一种按法用来换行；Shift+Enter 总是换行", seg("sendKey", prefs.sendKey(), [["enter", "Enter"], ["mod", mac ? "⌘ Enter" : "Ctrl Enter"]]))}
        ${row("折叠连续的工具步骤", "超过 3 步时收成一行，只露出最后一步", sw("fold", prefs.fold()))}
      </div>
      <div class="card"><div class="card-h">通知</div>
        ${row("浏览器通知", esc(perm), sw("notify", prefs.notify() && (!("Notification" in window) || Notification.permission !== "denied")))}
      </div>
      <p class="panel-intro">Collie 本身的设置（它自己用哪个 agent、派活默认在哪台电脑、通知机器人）在 <a href="#/auto" data-auto-tab="settings">自动化 → 设置</a>；电脑和手机的连接在 <a href="#/devices">设备</a>。</p>
    </div>`;
  }
  $("#prefs-body").addEventListener("click", async (e) => {
    const link = e.target.closest("a[data-auto-tab]");
    if (link) autoTab = link.dataset.autoTab;
    const b = e.target.closest(".seg[data-pref] button, button.switch[data-pref]");
    if (!b) return;
    if (b.classList.contains("switch")) {
      const key = b.dataset.pref, on = b.getAttribute("aria-checked") !== "true";
      if (key === "notify" && on && "Notification" in window && Notification.permission !== "granted") {
        const p = await Notification.requestPermission();
        if (p !== "granted") { toast("浏览器没有允许通知", "attn"); renderPrefs(); return; }
      }
      store.set(key, on);
    } else {
      const key = b.closest("[data-pref]").dataset.pref, v = b.dataset.v;
      if (key === "mode2") setMode(v); else store.set(key, v);
      if (key === "theme" || key === "text") applyLook();
    }
    renderPrefs();
  });

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
  // Which agents a computer has: nothing when not known (an older node).
  const agentsTag = (list) => !Array.isArray(list) ? ""
    : list.length ? `<span title="这台电脑上装了的 agent">${list.map((k) => esc(AGENT_LABEL[k] || k)).join(" · ")}</span>`
    : `<span class="tag attn" title="找不到 claude、codex、agy 命令：装一个，再重连这台电脑">没装 agent</span>`;
  const verTag = (have, latest, cmd) => !have ? "" : isOld(have, latest)
    ? `<span class="tag attn" title="${esc("更新：" + cmd)}">${esc(have)} → ${esc(latest)}</span>` : `<span>${esc(have)}</span>`;
  const updateRow = (have, latest, cmd, note, id, name) => isOld(have, latest)
    ? `<div class="update-cmd"><p class="pair-hint">有新版本 ${esc(latest)}。<button class="btn small primary" data-update="${esc(id)}" data-name="${esc(name)}">更新到 ${esc(latest)}</button></p><p class="pair-hint muted">点了没反应的话，在这台电脑上运行${note ? "（" + esc(note) + "）" : ""}：</p><div class="code"><span>${esc(cmd)}</span><button class="icon-btn" data-copy="${esc(cmd)}" title="复制"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></button></div></div>` : "";

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
    const browsers = r.devices.filter((d) => d.kind !== "machine");
    const addrSel = addrs.length > 1 ? `<label class="addr-pick">用这个地址<select id="dev-addr">${addrs.map((a) => `<option ${a === devAddr ? "selected" : ""}>${esc(a)}</option>`).join("")}</select></label>` : "";
    const keepOpen = document.activeElement?.id === "dev-addr" || document.activeElement?.closest?.("#add-hub");
    if (keepOpen) return; // don't redraw under an open select or a half-typed form
    const typed = [...document.querySelectorAll("#add-hub input")].map((i) => i.value);

    $("#devices-body").innerHTML = `
      <p class="panel-intro">Collie 适合放在一台常开的开发机上当 hub：手机、平板和浏览器只连 hub；你的 Mac、Linux 或 Windows 电脑运行 <code>collie node</code> 主动连上来，hub 就能在上面开 agent、看对话、处理确认。不用开端口，也不需要 SSH。</p>

      <div class="pair-grid">
        <div class="card pair-card">
          <div class="card-h">连接手机或平板</div>
          <div class="qr-wrap">${pb ? `<img class="qr" alt="配对二维码" src="demo-qr.png?text=${encodeURIComponent(phoneURL)}">` : ""}</div>
          <p class="pair-hint">用相机扫一下，在浏览器里打开即可，之后可「添加到主屏幕」。<b>${pb ? left(pb) : ""}</b> 内有效，只能用一次。</p>
          <div class="code"><span>${esc(phoneURL)}</span><button class="icon-btn" data-copy="${esc(phoneURL)}" title="复制"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></button></div>
          ${addrSel}
        </div>

        <div class="card pair-card">
          <div class="card-h">连接一台电脑</div>
          <p class="pair-hint">在那台电脑上装好 herdr（编译安装还需 git 和 Go 1.25+），然后运行以作为后台服务常驻：</p>
          ${pm ? `<p class="pair-hint"><b>macOS / Linux</b>：</p>
               <div class="code big"><span>${esc(installCmd)}</span><button class="icon-btn" data-copy="${esc(installCmd)}" title="复制"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></button></div>
               <p class="pair-hint"><b>Windows（PowerShell）</b>：</p>
               <div class="code big"><span>${esc(installWinCmd)}</span><button class="icon-btn" data-copy="${esc(installWinCmd)}" title="复制"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></button></div>
               <p class="pair-hint">已经装了 collie 的话：</p>
               <div class="code"><span>${esc(nodeCmd)}</span><button class="icon-btn" data-copy="${esc(nodeCmd)}" title="复制"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></button></div>
               <p class="pair-hint"><b>${left(pm)}</b> 内有效，只能用一次。之后它会自动重连。</p>`
             : `<button class="btn primary" id="new-node-code">生成连接命令</button>`}
          <p class="pair-hint muted">需要这台电脑能访问上面的地址（同一内网或 VPN）。</p>
        </div>
      </div>

      <div class="card"><div class="card-h">电脑</div><ul class="rows">
        <li class="row dev-row">
          <span class="dot ${r.hub.herdr ? "online" : "offline"}"></span>
          <div><div class="meta"><b>${esc(r.hub.name)}</b><span class="tag">hub</span>${r.hub.os ? `<span>${esc(r.hub.os)}</span>` : ""}${verTag(r.hub.version, r.latest, hubCmd)}${agentsTag(r.hub.agents)}${r.hub.herdr ? "" : "<span>没检测到 herdr，这台只当 hub 用</span>"}</div><div class="text mono">${esc(tilde(r.hub.home))}</div>${updateRow(r.hub.version, r.latest, hubCmd, "装 hub 时加过 --url 等参数的话照样带上", "", r.hub.name)}</div>
          <span class="right">${r.hub.herdr ? "在线" : ""}</span></li>
        ${machines.map((d) => { const dCmd = installCmdFor(d.os, "node"); return `<li class="row dev-row">
          <span class="dot ${d.online ? "online" : "offline"}"></span>
          <div><div class="meta"><b>${esc(d.name)}</b><span>${esc(d.os || "")}</span>${verTag(d.version, r.latest, dCmd)}${d.online ? agentsTag(d.agents) : ""}<span>${d.online ? "在线" : "离线 · 上次 " + when(d.last_seen)}</span></div><div class="text mono">${esc(d.home ? tilde(d.home) : "")}</div>${updateRow(d.version, r.latest, dCmd, "", d.id, d.name)}</div>
          <button class="btn ghost small" data-del-dev="${esc(d.id)}" data-name="${esc(d.name)}">移除</button></li>`; }).join("")}
      </ul></div>

      <div class="card"><div class="card-h">其他 hub</div>
        <p class="pair-hint">别的网络里的 Collie hub（云电脑、家里的电脑）。和这台 hub 不通也没关系：只要这个浏览器能打开它，它的会话就会出现在侧栏里。</p>
        <ul class="rows">${hubs.map((h) => { const on = remote.get(h.key)?.online; return `<li class="row dev-row">
          <span class="dot ${on ? "online" : "offline"}"></span>
          <div><div class="meta"><b>${esc(h.name)}</b><span>${on ? "在线" : "连不上"}</span></div><div class="text mono">${esc(h.url)}</div></div>
          <button class="btn ghost small" data-del-hub="${esc(h.key)}" data-name="${esc(h.name)}">移除</button></li>`; }).join("")}
        </ul>
        <form id="add-hub" class="hub-add">
          <input name="link" required autocomplete="off" placeholder="粘贴那个 hub「设备 → 连接手机或平板」里的链接">
          <input name="name" autocomplete="off" placeholder="叫它什么（可选）">
          <button class="btn primary">添加</button>
        </form>
        <p class="pair-hint muted">那个 hub 也要是 v0.2.4 以后的版本。</p>
      </div>

      <div class="card"><div class="card-h">手机和浏览器</div><ul class="rows">
        ${browsers.length ? browsers.map((d) => `<li class="row dev-row">
          <span class="dot unknown"></span>
          <div><div class="meta"><b>${esc(d.name)}</b>${d.current ? '<span class="tag">当前</span>' : ""}<span>最近 ${when(d.last_seen)}</span></div></div>
          <button class="btn ghost small" data-del-dev="${esc(d.id)}" data-name="${esc(d.name)}">移除</button></li>`).join("")
        : `<li class="empty-row">还没有配对过的手机。用访问令牌登录的浏览器不在这里列出。</li>`}
      </ul></div>`;
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
      if (b.dataset.copy) { await copy(b.dataset.copy); toast("已复制"); }
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
    $("#d-name").textContent = v.name === ROUTER ? "Collie 的终端" : v.is_agent ? title(v) : v.workspace_label || base(tilde(v.cwd));
    $("#d-name").title = v.is_agent && v.name && v.name !== ROUTER ? `名字：${v.name}` : "";
    $("#d-kind").textContent = v.is_agent ? (KIND_LABEL[v.kind] || v.kind) : "";
    const role = isWorker(v.name) ? "Collie 派出" : "";
    $("#d-worker").hidden = !role;
    $("#d-worker").textContent = role;
    const st = $("#d-status");
    st.className = "status " + v.status;
    st.innerHTML = `<span class="dot ${esc(v.status)}"></span>${esc(STATUS_LABEL[v.status] || v.status)}`;
    // With more than one computer, say which one it runs on; its own home
    // folder shortens to ~ (big Linux boxes keep homes outside /home).
    const ms = state.machines || [];
    const home = ms.find((m) => m.id === (v.machine || ""))?.home;
    const rawCwd = v.cwd || "";
    const cwd = home && rawCwd.length >= home.length && rawCwd.slice(0, home.length).toLowerCase() === home.toLowerCase() && (!rawCwd[home.length] || rawCwd[home.length] === "/" || rawCwd[home.length] === "\\")
      ? "~" + rawCwd.slice(home.length)
      : tilde(rawCwd);
    $("#d-cwd").textContent = (ms.length > 1 ? machineName(v.machine) + " · " : "") + cwd;
    renderWorkerModel(v);
    // The pane may have shown up before the page knew what it is (a fresh
    // terminal): once it does, switch to the view that fits.
    if (view === "pane" && $("#viewer").dataset.mode && $("#viewer").dataset.mode !== curMode()) { closeStream(); resetChat(); openStream(); }
    $("#input").placeholder = v.name === ROUTER ? "直接在 Collie 的终端里输入…" : v.is_agent ? `给 ${KIND_LABEL[v.kind] || v.kind} 发消息…` : "输入命令…";
  }

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

  // ───────────────────────────── one agent: streams
  let mode = store.get("mode2", "chat");
  let stream = null;
  let term = null;
  let size = { cols: 0, rows: 0 };

  // A plain shell has no conversation to show, so it opens on the screen.
  const isShell = () => { const v = find(current); return !!v && !v.is_agent; };
  let shellMode = null; // a shell's own pick; never overwrites the agent default
  const curMode = () => isShell() ? (shellMode || (mode === "chat" ? "screen" : mode)) : mode;
  function applyMode() {
    const m = curMode();
    $("#viewer").dataset.mode = m;
    $("#detail").classList.toggle("chat-mode", m === "chat");
    $("#detail").classList.toggle("shell", isShell());
    $$("#mode-seg button").forEach((b) => {
      b.classList.toggle("on", b.dataset.mode === m);
      if (b.dataset.mode === "chat") b.hidden = isShell();
    });
  }
  function setMode(m) {
    if (view === "pane" && isShell()) shellMode = m; else { mode = m; store.set("mode2", m); }
    applyMode();
    if (view === "pane" && current) { closeStream(); resetChat(); openStream(); }
  }
  $$("#mode-seg button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));

  function ensureTerm() {
    if (term || !window.Terminal) return;
    const css = getComputedStyle(document.documentElement);
    term = new Terminal({
      cols: 120, rows: 40, fontFamily: css.getPropertyValue("--mono"), fontSize: 13, lineHeight: 1.15,
      cursorBlink: false, scrollback: 0, allowTransparency: true, theme: termTheme(),
    });
    term.open($("#screen"));
    term.onData(typeIntoPane);
    // The terminal is the input: tap or click it and type. (A drag that
    // selected text, or scrolled the screen sideways, isn't a tap.)
    $("#screen").addEventListener("click", () => { if (!term.hasSelection()) term.focus(); });
    term.textarea?.setAttribute("enterkeyhint", "enter");
    term.textarea?.addEventListener("focus", () => $("#viewer").classList.add("typing"));
    term.textarea?.addEventListener("blur", () => $("#viewer").classList.remove("typing"));
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { term.options.theme = termTheme(); });
    addEventListener("collie:theme", () => { term.options.theme = termTheme(); });
  }
  function termTheme() {
    const fg = getComputedStyle(document.documentElement).getPropertyValue("--term-fg").trim();
    return { background: "rgba(0,0,0,0)", foreground: fg, cursor: fg, selectionBackground: "rgba(127,127,127,.3)" };
  }
  // The pane keeps its own width (herdr can't resize it for us), so a phone
  // can't fit 120 columns legibly: there it shows the screen at a readable
  // size and scrolls sideways, or, with 全览, the whole width at once.
  const narrowScreen = matchMedia("(max-width: 760px)");
  function fitTerm() {
    if (!term || !size.cols) return;
    const el = $("#screen"), pad = parseFloat(getComputedStyle(el).paddingLeft) * 2;
    const fitW = Math.floor(((el.clientWidth - pad) / size.cols / 0.602) * 2) / 2;
    const overview = store.get("term-overview", false);
    const fs = narrowScreen.matches && !overview ? Math.min(14, Math.max(fitW, 11)) : Math.max(4.5, Math.min(14, fitW));
    if (term.options.fontSize !== fs) term.options.fontSize = fs;
    $("#term-fit").textContent = overview ? "放大" : "全览";
    $("#term-fit").hidden = !narrowScreen.matches || fitW >= 11;
  }
  addEventListener("resize", () => fitTerm());
  $("#term-fit").addEventListener("click", () => { store.set("term-overview", !store.get("term-overview", false)); fitTerm(); });
  $("#term-kbd").addEventListener("click", () => term?.focus());

  function openStream() {
    const id = current;
    applyMode();
    const m = curMode();
    if (m === "chat") return openChat(id);
    if (m === "screen") ensureTerm();
    stream = openES(paneURL(id, "stream") + "?mode=" + m);
    stream.addEventListener("frame", (e) => {
      if (id !== current) return;
      const f = JSON.parse(e.data);
      if (m === "screen") drawScreen(f); else drawLog(f.text);
    });
    stream.addEventListener("gone", () => { $("#gone").hidden = false; closeStream(); });
  }
  function closeStream() { stream?.close(); stream = null; }

  function drawScreen(f) {
    if (!term) return;
    if (f.cols && f.rows && (f.cols !== size.cols || f.rows !== size.rows)) {
      size = { cols: f.cols, rows: f.rows };
      term.resize(f.cols, f.rows);
      fitTerm();
    }
    term.write("\x1b[?25l\x1b[H\x1b[2J" + f.text.replace(/\r?\n/g, "\r\n"));
  }
  function cleanLog(text) {
    return text.split("\n").map((l) => l.replace(/\s+$/, ""))
      .map((l) => (/^\s*[─━═\-]{16,}\s*$/.test(l) ? "────────────────" : l))
      .join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  }
  function drawLog(text) {
    const el = $("#log");
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    el.textContent = cleanLog(text);
    if (atBottom) el.scrollTop = el.scrollHeight;
    $("#jump").hidden = atBottom;
  }
  $("#log").addEventListener("scroll", () => { const el = $("#log"); $("#jump").hidden = el.scrollHeight - el.scrollTop - el.clientHeight < 40; });
  $("#jump").addEventListener("click", () => { const el = $("#log"); el.scrollTop = el.scrollHeight; });

  // ───────────────────────────── one agent: conversation
  let showRaw = false;
  function resetChat() {
    $("#thread").innerHTML = "";
    $("#thread").classList.remove("asking");
    $("#live").hidden = true;
    $("#live").innerHTML = "";
    $("#thread")._sig = ""; $("#thread")._msgs = null; $("#thread")._blocks = null; $("#thread")._older = null; showRaw = false;
  }
  function openChat(id) {
    stream = openES(paneURL(id, "chat"));
    const alive = () => id === current && curMode() === "chat";
    stream.addEventListener("reset", () => alive() && resetChat());
    const th = $("#thread");
    resetEarlier(th, (c) => paneURL(id, "earlier") + "?before=" + c);
    th._redraw = () => alive() && drawThread(threadMsgs(th));
    if (!th._msgs) primeThread(th, "p:" + id);
    const showPane = (msgs) => { keepThread("p:" + id, msgs); drawThread(msgs); };
    stream.addEventListener("patch", (e) => alive() && showPane(applyPatch(th, JSON.parse(e.data))));
    stream.addEventListener("messages", (e) => alive() && drawThread(JSON.parse(e.data))); // an older computer
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
    return threadMsgs(el);
  }
  // A thread's messages: the older ones loaded on request, then the live view.
  const threadMsgs = (el) => (el._older || []).concat(el._msgs || []);
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
      html += m.kind === "user" ? `<div class="msg user">${userText(m.text)}</div>` : `<div class="msg assistant">${md(m.text)}</div>`;
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

  function drawFallback(text) {
    const el = $("#thread");
    const was = nearBottom(el) || !el.childElementCount;
    const v = find(current);
    const note = v && v.is_agent ? `${esc(KIND_LABEL[v.kind] || v.kind)} 还没有可读取的会话记录，先显示终端输出` : "普通终端，这里显示终端输出";
    el.innerHTML = `<div class="fallback-note">${note}</div><pre class="termcard">${esc(cleanLog(text))}</pre>`;
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

  $("#kbd-toggle").addEventListener("click", () => {
    const on = $("#keys").classList.toggle("open");
    $("#kbd-toggle").classList.toggle("on", on);
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
  async function openFile(path) {
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
  // Images a message carries ("[image:~/.collie/images/….png]", saved from the
  // agent's transcript on its computer) show as thumbnails; tap for the panel.
  const IMG_TOKEN = /\[image:(~\/\.collie\/images\/[0-9a-f]+\.(?:png|jpg|gif|webp))\]\n?/g;
  const thumbs = new Map(); // path -> object URL, kept so redraws don't refetch
  const IMG_RUN = /(?:\[image:~\/\.collie\/images\/[0-9a-f]+\.(?:png|jpg|gif|webp)\]\n?)+/g;
  const thumbBtn = (p) => `<button type="button" class="thumb" data-img="${esc(p)}" aria-label="图片"><img alt=""${thumbs.get(p) ? ` src="${thumbs.get(p)}"` : ""}></button>`;
  const withImages = (html) => html.includes("[image:") ? html.replace(IMG_RUN, (run) => `<span class="thumbs">${run.replace(IMG_TOKEN, (_, p) => thumbBtn(p))}</span>`) : html;
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
    if (t) { e.preventDefault(); openFile(t.dataset.img); return; }
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
    let text = String(src || "").replace(/```[^\n]*\n([\s\S]*?)(```|$)/g, (_, code) => {
      blocks.push(`<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre>`);
      return `\u0000${blocks.length - 1}\u0000`;
    });
    text = esc(text);
    const inline = (s) => s
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s"]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      // [MergeStatus.tsx](file:///…/MergeStatus.tsx#L67-L84): the name, opening the file.
      .replace(/\[([^\]\n]+)\]\((?:file:\/\/\/?)?((?:\/|~[\\/]|[A-Za-z]:[\\/])[^)\s"#]+)(?:#[^)\s"]*)?\)/g, (_, label, p) => {
        p = p.replace(/:\d+(?:[-:]\d+)?$/, "");
        try { p = decodeURI(p); } catch {}
        return `<a class="fpath" href="#" data-path="${p}" title="${p}">${label}</a>`;
      })
      .replace(FILE_RE, '$1<a class="fpath" href="#" data-path="$2" title="打开这个文件">$2</a>');
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

  $("#keys").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || !current) return;
    if (b.dataset.k) sendKeys([b.dataset.k]); else if (b.dataset.t) sendText(b.dataset.t);
  });
  $("#keys").addEventListener("mousedown", (e) => e.preventDefault());

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
  // Images a Collie message points at (a screenshot a worker took) show
  // under it, so you need not open each one.
  const IMG_PATH = /(?:^|[\s(（`"'：:])((?:~|\/)[^\s`"'()（）<>]*\.(?:png|jpe?g|gif|webp))(?=$|[\s)）`"'，。,;；])/gim;
  function imagesIn(t) {
    const ps = [...new Set([...(t || "").matchAll(IMG_PATH)].map((m) => m[1]))].slice(0, 6);
    return ps.length ? `<span class="thumbs">${ps.map(thumbBtn).join("")}</span>` : "";
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
      + (imgs.length ? `<span class="thumbs">${imgs.map(thumbBtn).join("")}</span>` : "")
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
      try {
        const text = await withFiles(form, input.value);
        await send(text);
        input.value = ""; grow(input); form._clearFiles?.();
      }
      catch (err) { toast(err.message, "attn"); }
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
    try {
      if (v.is_agent) await api(`/api/agents/${encodeURIComponent(current)}/prompt`, { body: { text } });
      else await api(paneURL(current, "text"), { body: { text, enter: true } });
    } catch (err) {
      throw new Error(err.message.includes("blocked") ? "agent 正在等你确认，先处理上面的确认卡片" : err.message);
    }
  }, () => (current || "").includes("@") ? current.slice(current.lastIndexOf("@") + 1) : "");

  // ───────────────────────────── menus
  document.addEventListener("click", (e) => {
    const opener = e.target.closest("[data-menu]");
    $$(".menu").forEach((m) => { if (!opener || m.id !== opener.dataset.menu) m.hidden = true; });
    if (opener) { const m = $("#" + opener.dataset.menu); m.hidden = !m.hidden; }
  });

  document.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    const v = find(current);
    try {
      if (act === "interrupt") sendKeys(["ctrl+c"]);
      if (act === "copy" && v) { await copy(v.pane_id); toast("已复制 " + v.pane_id); }
      if (act === "shell-here" && v) {
        const r = await api("/api/agents", { body: { kind: "shell", cwd: v.cwd, machine: v.machine || "" } });
        location.hash = "#/p/" + encodeURIComponent(r.pane_id);
      }
      if (act === "close" && v) {
        if (!confirm(`关闭工作区「${v.workspace_label || v.workspace_id}」？里面的进程会被结束。`)) return;
        await api(`/api/workspaces/${encodeURIComponent(v.workspace_id)}/close`, { method: "POST", body: {} });
        location.hash = "#/";
      }
      if (act === "router-open") {
        const p = paneOf(ROUTER);
        if (p) location.hash = "#/p/" + encodeURIComponent(p); else toast("Collie 还在休眠；发一条消息就会唤醒它");
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
      if (act === "auto") location.hash = "#/auto";
    } catch (err) { toast(err.message, "attn"); }
  });

  // ───────────────────────────── launcher
  const sheet = $("#launch");
  const cwdInput = $("#l-cwd");
  const nameInput = $("#l-name");
  let nameTouched = false;

  function suggestName() {
    if (!nameTouched) nameInput.value = "";
    // A terminal needs only a computer and a folder.
    const shell = $("input[name=kind]:checked")?.value === "shell";
    $$("#launch .agent-only").forEach((f) => f.hidden = shell);
    $("#launch-go").textContent = shell ? "打开" : "启动";
    if (!shell) fillLaunchModels();
  }
  // Model and effort for a new agent: "" leaves it to the agent's own settings
  // on that computer (what it would run if started by hand).
  let launchSeq = 0;
  async function fillLaunchModels() {
    const seq = ++launchSeq, kind = $("input[name=kind]:checked")?.value;
    const mSel = $("#l-model");
    const keep = { model: mSel.value, effort: $("#l-effort").value, key: mSel._key };
    const info = await modelsFor(kind, pickMachine);
    if (seq !== launchSeq) return;
    const same = keep.key === kind + "@" + pickMachine;
    mSel._key = kind + "@" + pickMachine;
    const list = info.models || [];
    const def = info.default ? info.default.split("/").pop() : "";
    mSel.innerHTML = `<option value="" data-short="默认模型" data-sub="${esc(info.default ? "现在是 " + info.default : "agent 自己的设置")}">默认${def ? "（" + esc(def) + "）" : ""}</option>` +
      list.map((m) => `<option value="${esc(m.id)}" data-sub="${esc(m.label && m.label !== m.id ? m.id : "")}">${esc(m.label || m.id)}</option>`).join("");
    mSel.value = same && list.some((m) => m.id === keep.model) ? keep.model : "";
    fillLaunchEfforts(info, same ? keep.effort : "");
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
    fillLaunchEfforts(await modelsFor($("input[name=kind]:checked").value, pickMachine), $("#l-effort").value);
  });
  let pickMachine = "";
  const recentKey = () => "recentDirs" + (pickMachine ? ":" + pickMachine : "");
  function renderMachinePick() {
    const ms = (state.machines || []).filter((m) => m.local ? state.ok : m.online);
    $("#l-machine-field").hidden = ms.length < 2;
    if (!ms.some((m) => m.id === pickMachine)) pickMachine = ms[0]?.id || "";
    $("#l-machines").innerHTML = ms.map((m) => `<button type="button" class="${m.id === pickMachine ? "on" : ""}" data-m="${esc(m.id)}">
      <span class="dot online"></span>${esc(m.name)}${m.local ? "<small>hub</small>" : ""}</button>`).join("");
    markKinds();
  }
  // Agents the chosen computer doesn't have can't be picked.
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
      small.textContent = missing ? "没装" : small.dataset.cmd;
    }
    if ($("input[name=kind]:checked")?.disabled) {
      const first = $$("input[name=kind]").find((r) => !r.disabled);
      if (first) { first.checked = true; first.dispatchEvent(new Event("change")); }
    }
  }
  function resetDir() {
    const recent = store.get(recentKey(), []);
    cwdInput.value = recent[0] || "~";
    $("#recent").innerHTML = recent.slice(0, 6).map((d) => `<button type="button" data-d="${esc(d)}">${esc(d)}</button>`).join("");
    browse(cwdInput.value);
  }
  $("#l-machines").addEventListener("click", (e) => {
    const b = e.target.closest("[data-m]");
    if (!b) return;
    pickMachine = b.dataset.m;
    store.set("machine", pickMachine);
    renderMachinePick();
    resetDir();
    suggestName();
  });
  function openLauncher() {
    nameTouched = false;
    $("#launch-error").textContent = "";
    $("#l-prompt").value = "";
    pickMachine = store.get("machine", "");
    renderMachinePick();
    const recent = store.get(recentKey(), []);
    cwdInput.value = recent[0] || "~";
    $("#recent").innerHTML = recent.slice(0, 6).map((d) => `<button type="button" data-d="${esc(d)}">${esc(d)}</button>`).join("");
    const radio = $(`input[name=kind][value="${store.get("kind", "claude")}"]`);
    if (radio && !radio.disabled) radio.checked = true;
    markKinds();
    suggestName();
    browse(cwdInput.value);
    sheet.showModal();
    if (prefs.notify() && "Notification" in window && Notification.permission === "default") Notification.requestPermission();
  }
  $("#new-btn").addEventListener("click", openLauncher);
  $$("input[name=kind]").forEach((r) => r.addEventListener("change", suggestName));
  nameInput.addEventListener("input", () => { nameTouched = true; });
  $("#recent").addEventListener("click", (e) => { const d = e.target.closest("button")?.dataset.d; if (d) { cwdInput.value = d; browse(d); } });

  let browseTimer, dirParent = "";
  async function browse(p) {
    try {
      const r = await api("/api/dirs?path=" + encodeURIComponent(p) + (pickMachine ? "&machine=" + encodeURIComponent(pickMachine) : ""));
      dirParent = r.parent || "";
      $("#dirs").innerHTML = r.dirs.map((d) => `<li data-d="${esc(d)}">${esc(d)}</li>`).join("");
    } catch { dirParent = ""; $("#dirs").innerHTML = ""; }
  }
  cwdInput.addEventListener("input", () => { clearTimeout(browseTimer); browseTimer = setTimeout(() => browse(cwdInput.value), 250); });
  $("#dirs").addEventListener("click", (e) => {
    const d = e.target.closest("li")?.dataset.d;
    if (!d) return;
    if (/^[A-Za-z]:[\\/]?$/.test(d)) {
      cwdInput.value = d;
    } else {
      const cur = cwdInput.value.replace(/[\\/]+$/, "") || "~";
      const sep = cur.includes("\\") || /^[A-Za-z]:/.test(cur) ? "\\" : "/";
      cwdInput.value = (cur === "/" ? "" : cur) + sep + d;
    }
    browse(cwdInput.value);
  });
  $("#dir-up").addEventListener("click", () => {
    let up = dirParent;
    if (!up) {
      const v = cwdInput.value.replace(/[\\/]+$/, "");
      if (/^[A-Za-z]:$/.test(v)) up = "/";
      else {
        const i = Math.max(v.lastIndexOf("/"), v.lastIndexOf("\\"));
        up = i > 0 ? v.slice(0, i) : i === 0 ? "/" : "~";
        if (/^[A-Za-z]:$/.test(up)) up += "\\";
      }
    }
    cwdInput.value = up;
    browse(up);
  });
  $("#launch-form").addEventListener("submit", async (e) => {
    if (e.submitter?.value !== "go") return;
    e.preventDefault();
    const kind = $("input[name=kind]:checked").value;
    const shell = kind === "shell";
    const body = shell ? { kind, cwd: cwdInput.value.trim(), machine: pickMachine }
      : { kind, name: nameInput.value.trim(), cwd: cwdInput.value.trim(), prompt: $("#l-prompt").value, machine: pickMachine,
          model: $("#l-model").value, effort: $("#l-effort").value };
    const go = $("#launch-go");
    go.disabled = true; go.textContent = shell ? "打开中…" : "启动中…";
    $("#launch-error").textContent = "";
    try {
      const r = await api("/api/agents", { body });
      store.set("kind", body.kind);
      store.set(recentKey(), [body.cwd, ...store.get(recentKey(), []).filter((d) => d !== body.cwd)].slice(0, 8));
      sheet.close();
      if (r.warning) toast(r.warning, "attn");
      location.hash = "#/p/" + encodeURIComponent(r.pane_id);
    } catch (err) { $("#launch-error").textContent = err.message; }
    finally { go.disabled = false; go.textContent = shell ? "打开" : "启动"; }
  });

  // ───────────────────────────── viewport (mobile keyboard)
  // The app fills the visible area: its height shrinks above the keyboard, and
  // it follows the visible area when the browser scrolls the page for it.
  function setVH() {
    const v = window.visualViewport;
    const root = document.documentElement.style;
    // Chats that were showing their latest lines keep showing them as the keyboard takes space.
    const pinned = [...document.querySelectorAll(".viewer, #log")].filter((el) => el.offsetParent && el.scrollHeight - el.scrollTop - el.clientHeight < 80);
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
    setMode(mode);
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
  boot();
})();
