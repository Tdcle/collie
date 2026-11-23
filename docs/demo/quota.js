// Collie Top-Right Model Quota Popover Module (zero-build browser script).
// Manages multi-machine & multi-agent remaining quota collection, alert badge,
// and interactive popover rendering.
(() => {
  "use strict";

  function initQuotaUI(deps) {
    const { $, api, toast, esc, hhmm, osGlyph, GLYPHS, AGENT_LABEL, getHubs, tagged } = deps;
    const quotaBtn = $("#quota-btn"), quotaPill = $("#quota-pill"), quotaDot = $("#quota-dot"), quotaPop = $("#quota-pop");
    let quotaData = { machines: [], updated_at: null };
    let quotaLoading = false, quotaFetchedAt = 0, quotaMachineTab = "all";

    function formatResetEta(iso) {
      if (!iso) return "";
      const d = new Date(iso);
      if (isNaN(d)) return "";
      const diffMs = d - Date.now();
      if (diffMs <= 0) return "即将重置";
      const mins = Math.ceil(diffMs / 60000);
      if (mins < 60) return `${mins} 分钟后重置`;
      const hrs = Math.floor(mins / 60), remM = mins % 60;
      if (hrs < 24) return remM >= 10 && hrs < 6 ? `${hrs} 小时 ${remM} 分后重置` : `${hrs} 小时后重置`;
      const days = Math.floor(hrs / 24);
      if (days < 7) {
        const wk = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
        return `${wk} ${hhmm(d)} 重置`;
      }
      return `${d.getMonth() + 1}/${d.getDate()} ${hhmm(d)} 重置`;
    }

    function pctTone(pct) {
      if (pct <= 12) return "danger";
      if (pct <= 30) return "warn";
      return "";
    }

    function renderQuotaBtn() {
      if (!quotaBtn || !quotaPill) return;
      const ms = quotaData.machines || [];
      let minPct = Infinity, hasIssue = false, issueLabel = "";
      for (const m of ms) {
        if (!m.online) continue;
        for (const a of (m.agents || [])) {
          if (a.status === "exhausted" || a.balance_ok === false) {
            hasIssue = true;
            if (!issueLabel && a.balance) issueLabel = a.balance.replace(/\s+/g, "");
          }
          for (const b of (a.buckets || [])) {
            if (typeof b.remaining_pct === "number" && b.remaining_pct < minPct) {
              minPct = b.remaining_pct;
            }
          }
        }
      }
      if (Number.isFinite(minPct)) {
        const rounded = Math.round(minPct);
        quotaPill.hidden = false;
        quotaPill.textContent = `${rounded}%`;
        const tone = rounded <= 12 ? "danger" : rounded <= 30 ? "warn" : "";
        quotaPill.className = "hq-pill" + (tone ? " " + tone : "");
        if (quotaDot) quotaDot.hidden = !(hasIssue && rounded > 12);
        quotaBtn.title = hasIssue
          ? `模型剩余用量：最低 ${rounded}%（另有账户余额不足或已耗尽，点击查看各电脑详情）`
          : `模型剩余用量：当前最低剩余 ${rounded}%（点击按电脑与 Agent 查看）`;
      } else if (hasIssue) {
        quotaPill.hidden = false;
        quotaPill.textContent = issueLabel || "不足";
        quotaPill.className = "hq-pill danger";
        if (quotaDot) quotaDot.hidden = true;
        quotaBtn.title = "部分模型账户余额不足或配额已用尽（点击查看详情）";
      } else {
        quotaPill.hidden = true;
        if (quotaDot) quotaDot.hidden = true;
      }
    }

    function positionQuotaPop() {
      if (!quotaPop || quotaPop.hidden || !quotaBtn) return;
      const r = quotaBtn.getBoundingClientRect();
      const popW = Math.min(432, innerWidth - 20);
      const left = Math.max(10, Math.min(innerWidth - popW - 10, r.right - popW));
      const top = Math.min(innerHeight - 120, Math.max(8, r.bottom + 8));
      quotaPop.style.left = `${left}px`;
      quotaPop.style.top = `${top}px`;
      quotaPop.style.maxHeight = `${Math.max(220, innerHeight - top - 14)}px`;
    }

    function renderQuotaPop() {
      if (!quotaPop || quotaPop.hidden) return;
      const ms = quotaData.machines || [];
      if (quotaMachineTab !== "all" && !ms.some((m) => (m.id || "hub") === quotaMachineTab)) {
        quotaMachineTab = "all";
      }
      const visible = quotaMachineTab === "all" ? ms : ms.filter((m) => (m.id || "hub") === quotaMachineTab);
      const updTxt = quotaLoading ? "正在刷新…" : quotaData.updated_at ? `${hhmm(quotaData.updated_at)} 更新` : "";

      const tabsHTML = ms.length > 1 ? `<div class="qp-tabs">
        <button type="button" class="qp-tab ${quotaMachineTab === "all" ? "on" : ""}" data-qtab="all">全部 (${ms.length})</button>
        ${ms.map((m) => {
          const mid = m.id || "hub";
          return `<button type="button" class="qp-tab ${quotaMachineTab === mid ? "on" : ""}" data-qtab="${esc(mid)}">${osGlyph(m.os, !!m.relay)}<span>${esc(m.name || mid)}</span></button>`;
        }).join("")}
      </div>` : "";

      const bodyHTML = !ms.length
        ? `<div class="qp-empty">${quotaLoading ? "正在读取各台电脑的模型剩余用量…" : "暂无已连接的电脑或可用 Agent"}</div>`
        : visible.map((m) => {
            const agents = m.agents || [];
            const stTxt = m.online ? "在线" : m.cached ? "离线 · 上次记录" : "离线";
            const agHTML = !agents.length
              ? `<div class="qp-agent is-muted"><div class="qp-a-head"><span class="qp-a-name">未检测到已安装的编码 Agent</span></div></div>`
              : agents.map((a) => {
                  const buckets = a.buckets || [];
                  const hasRich = buckets.length > 0 || !!a.balance || a.status === "exhausted" || a.status === "api_key";
                  const mutedCls = hasRich ? "" : " is-muted";
                  const planBadge = a.provider && a.plan && !["OpenAI", "Anthropic", "Google"].includes(a.provider)
                    ? `${a.provider} · ${a.plan}`
                    : (a.plan || (a.provider && a.status === "api_key" ? a.provider : ""));
                  const balCls = a.balance_ok === false || a.status === "exhausted" ? " bad" : "";
                  return `<div class="qp-agent${mutedCls}">
                    <div class="qp-a-head">
                      <span class="qp-a-ico">${GLYPHS[a.kind] || GLYPHS.agent}</span>
                      <span class="qp-a-name">${esc(AGENT_LABEL[a.kind] || a.kind)}</span>
                      ${planBadge ? `<span class="qp-badge">${esc(planBadge)}</span>` : ""}
                      ${a.reset_credits > 0 ? `<span class="qp-badge credit" title="拥有免费重置配额次数">可重置 ${a.reset_credits} 次</span>` : ""}
                      ${a.balance ? `<span class="qp-bal${balCls}">${esc(a.balance)}</span>` : ""}
                      ${!hasRich && a.note ? `<span class="qp-a-inline-note" title="${esc(a.note)}">${esc(a.note)}</span>` : ""}
                    </div>
                    ${buckets.length ? `<div class="qp-buckets">${buckets.map((b) => {
                      const rem = Math.max(0, Math.min(100, Number(b.remaining_pct) || 0));
                      const tone = pctTone(rem);
                      const eta = formatResetEta(b.resets_at);
                      const pctStr = Number.isInteger(rem) ? `${rem}%` : `${rem.toFixed(1)}%`;
                      return `<div class="qp-bucket">
                        <div class="qp-b-top">
                          <span class="qp-b-label" title="${esc(b.model || b.label)}">${esc(b.label)}</span>
                          <span class="qp-b-meta">
                            ${eta ? `<span class="qp-b-reset">${esc(eta)}</span>` : ""}
                            <span class="qp-b-pct${tone ? " " + tone : ""}">剩余 ${pctStr}</span>
                          </span>
                        </div>
                        <div class="qp-track"><div class="qp-fill${tone ? " " + tone : ""}" style="width:${rem}%"></div></div>
                      </div>`;
                    }).join("")}</div>` : ""}
                    ${hasRich && (a.note || a.model) ? `<div class="qp-note${a.balance_ok === false || a.status === "exhausted" ? " bad" : ""}">
                      <span>${esc(a.note || "")}</span>
                      ${a.model && !(a.note || "").includes(a.model) ? `<span class="mono">${esc(a.model)}</span>` : ""}
                    </div>` : ""}
                  </div>`;
                }).join("");

            return `<section class="qp-machine">
              <header class="qp-m-head">
                <span class="qp-m-ico">${osGlyph(m.os, !!m.relay)}</span>
                <span class="qp-m-name">${esc(m.name || m.id || "本地电脑")}</span>
                <span class="qp-m-state"><span class="conn ${m.online ? "on" : "off"}"></span>${esc(stTxt)}</span>
              </header>
              <div class="qp-agents">${agHTML}</div>
            </section>`;
          }).join("");

      quotaPop.innerHTML = `<header class="qp-head">
        <div class="qp-head-left">
          <b>模型剩余用量</b>
          <span>按接入电脑与 Agent 实时汇总配额与余额（派活自动避开耗尽账户）</span>
        </div>
        <div class="qp-head-right">
          ${updTxt ? `<span class="qp-updated">${esc(updTxt)}</span>` : ""}
          <button type="button" class="qp-refresh${quotaLoading ? " spinning" : ""}" id="qp-refresh-btn" title="立即刷新实时配额">
            <svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 0 1-15.4 6.4L3 16"/><path d="M3 21v-5h5"/><path d="M3 12a9 9 0 0 1 15.4-6.4L21 8"/><path d="M21 3v5h-5"/></svg>
          </button>
        </div>
      </header>
      ${tabsHTML}
      <div class="qp-body">${bodyHTML}</div>`;
      positionQuotaPop();
    }

    async function loadQuotas(fresh = false) {
      if (quotaLoading) return;
      quotaLoading = true;
      renderQuotaPop();
      try {
        const r = await api(`/api/quotas${fresh ? "?fresh=1" : ""}`);
        const list = [...(r.machines || [])];
        for (const h of (getHubs() || [])) {
          try {
            const hr = await api(`/api/quotas${fresh ? "?fresh=1" : ""}`, { hub: h });
            for (const hm of (hr.machines || [])) {
              list.push({ ...hm, id: tagged(hm.id || "hub", h.key), name: `${hm.name || h.name} (${h.name})` });
            }
          } catch {}
        }
        quotaData = { machines: list, updated_at: r.updated_at || new Date().toISOString() };
        quotaFetchedAt = Date.now();
        renderQuotaBtn();
      } catch (e) {
        if (fresh) toast(e.message, "attn");
      } finally {
        quotaLoading = false;
        renderQuotaPop();
      }
    }

    function toggleQuotaPop(open) {
      if (!quotaPop || !quotaBtn) return;
      const want = open ?? quotaPop.hidden;
      quotaPop.hidden = !want;
      quotaBtn.classList.toggle("active", want);
      quotaBtn.setAttribute("aria-expanded", String(want));
      if (want) {
        renderQuotaPop();
        if (!quotaFetchedAt || Date.now() - quotaFetchedAt > 30000) loadQuotas(false);
      }
    }

    quotaBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleQuotaPop();
    });
    quotaPop?.addEventListener("click", (e) => {
      e.stopPropagation();
      const tab = e.target.closest("[data-qtab]")?.dataset.qtab;
      if (tab) {
        quotaMachineTab = tab;
        renderQuotaPop();
        return;
      }
      if (e.target.closest("#qp-refresh-btn")) {
        loadQuotas(true);
      }
    });
    document.addEventListener("click", (e) => {
      if (quotaPop && !quotaPop.hidden && !quotaPop.contains(e.target) && !quotaBtn?.contains(e.target)) {
        toggleQuotaPop(false);
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && quotaPop && !quotaPop.hidden) toggleQuotaPop(false);
    });
    addEventListener("resize", positionQuotaPop);

    return { loadQuotas, toggleQuotaPop, renderQuotaBtn, renderQuotaPop };
  }

  window.CollieQuota = { initQuotaUI };
})();
