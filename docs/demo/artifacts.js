// Collie Cross-Machine Artifact Cards & Rich File Viewer Module (zero-build).
// Detects non-image deliverables (.pdf, .docx, .xlsx, .pptx, .csv, .tsv, .tex,
// .zip, .html, .ipynb, .md, etc.) mentioned in messages, renders compact
// preview/download cards, and renders inline PDF / CSV-table / Office previews.
(() => {
  "use strict";

  // Only surface standalone binary/table deliverables as cards when they are NOT
  // already linked inline via Markdown `[label](path)` or `<a class="fpath">`!
  const ARTIFACT_EXTS = new Set([
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv", "tsv",
    "zip", "tar", "gz", "tgz", "7z", "rar"
  ]);

  const BADGE_META = {
    pdf: { badge: "PDF", tone: "is-pdf", canPreview: true },
    csv: { badge: "CSV", tone: "is-table", canPreview: true },
    tsv: { badge: "TSV", tone: "is-table", canPreview: true },
    xls: { badge: "XLS", tone: "is-table", canPreview: false },
    xlsx: { badge: "XLSX", tone: "is-table", canPreview: false },
    doc: { badge: "DOC", tone: "is-doc", canPreview: false },
    docx: { badge: "DOCX", tone: "is-doc", canPreview: false },
    ppt: { badge: "PPT", tone: "is-slide", canPreview: false },
    pptx: { badge: "PPTX", tone: "is-slide", canPreview: false },
    zip: { badge: "ZIP", tone: "is-zip", canPreview: false },
    tar: { badge: "TAR", tone: "is-zip", canPreview: false },
    gz: { badge: "GZ", tone: "is-zip", canPreview: false },
    tgz: { badge: "TGZ", tone: "is-zip", canPreview: false },
    "7z": { badge: "7Z", tone: "is-zip", canPreview: false },
    rar: { badge: "RAR", tone: "is-zip", canPreview: false },
    tex: { badge: "TeX", tone: "is-code", canPreview: true },
    bib: { badge: "BIB", tone: "is-code", canPreview: true },
    ipynb: { badge: "IPYNB", tone: "is-code", canPreview: true },
    html: { badge: "HTML", tone: "is-code", canPreview: true },
    json: { badge: "JSON", tone: "is-code", canPreview: true },
    md: { badge: "MD", tone: "is-doc", canPreview: true },
    markdown: { badge: "MD", tone: "is-doc", canPreview: true },
  };

  // Matches unlinked spaced paths (`C:\Users\26422\Documents\SFD-Net 2\summary.csv` or `<C:/path with spaces/report.pdf>`)
  // while skipping files already wrapped in clickable Markdown `[label](path)` links!
  const ANGLE_FILE_RE = /(?<!\]\()<(?:file:\/\/\/?)?((?:~[\\/]|\/|[A-Za-z]:[\\/])[^>#\r\n]+\.([A-Za-z0-9]{1,8}))(?:#[^>\r\n]*)?>/gi;
  const SPACED_WIN_UNIX_RE = /(?:^|[\s(（"':：])((?:~[\\/]|\/(?:Users|home|root|tmp|var|opt|private)[\\/]|[A-Za-z]:[\\/])[^\r\n`"'<>|*?]+\.(?:pdf|docx?|xlsx?|pptx?|csv|tsv|zip|tar|tgz|gz|7z|rar))(?=$|[\s)）"'，。,;；])/gim;

  function extOf(p) {
    const clean = String(p || "").split(/[?#]/)[0];
    const dot = clean.lastIndexOf(".");
    return dot >= 0 ? clean.slice(dot + 1).toLowerCase() : "";
  }

  function extractArtifacts(text, renderedHTML = "") {
    if (!text) return [];
    // Strip fenced code blocks and all Markdown `[label](path)` links (which already render as Codex-style inline links!).
    const stripped = String(text)
      .replace(/```[\s\S]*?(```|$)/g, " ")
      .replace(/!?\[[^\]\n]*\]\(<[^>\r\n]+>\)/g, " ")
      .replace(/!?\[[^\]\n]*\]\([^)\n]+\)/g, " ");
    const linkedPaths = new Set();
    if (renderedHTML) {
      for (const m of String(renderedHTML).matchAll(/data-path="([^"]+)"/g)) {
        const p = m[1].replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
        if (p) linkedPaths.add(p);
      }
    }
    const rawHits = [];
    for (const m of stripped.matchAll(ANGLE_FILE_RE)) rawHits.push(m[1]);
    for (const m of stripped.matchAll(SPACED_WIN_UNIX_RE)) rawHits.push(m[1]);

    const seen = new Set();
    const out = [];
    for (let raw of rawHits) {
      try { raw = decodeURI(raw); } catch {}
      raw = raw.replace(/:\d+(?:[-:]\d+)?$/, "").trim();
      if (linkedPaths.has(raw)) continue;
      const ext = extOf(raw);
      if (!ARTIFACT_EXTS.has(ext)) continue;
      if (/[\\\/]\.(?:claude|codex|collie|gemini)[\\\/]/i.test(raw)) continue;
      if (seen.has(raw)) continue;
      seen.add(raw);
      out.push({ path: raw, ext, meta: BADGE_META[ext] || { badge: ext.toUpperCase(), tone: "is-doc", canPreview: false } });
      if (out.length >= 6) break;
    }
    return out;
  }

  function parseDelimitedTable(text, sep = ",", maxRows = 150) {
    const clean = String(text || "").replace(/^\uFEFF/, "");
    const rows = [];
    let cur = [], field = "", inQuotes = false;
    const n = clean.length;
    for (let i = 0; i < n; i++) {
      const ch = clean[i];
      if (inQuotes) {
        if (ch === '"') {
          if (clean[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else {
          field += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === sep) {
        cur.push(field); field = "";
      } else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && clean[i + 1] === "\n") i++;
        cur.push(field); field = "";
        if (cur.length > 1 || (cur[0] || "").trim() !== "") rows.push(cur);
        cur = [];
        if (rows.length >= maxRows + 1) break;
      } else {
        field += ch;
      }
    }
    if (field || cur.length) {
      cur.push(field);
      if (cur.length > 1 || (cur[0] || "").trim() !== "") rows.push(cur);
    }
    return rows;
  }

  const NUM_CELL_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?%?$/;

  function initArtifacts(deps) {
    const { $, esc, tilde, fmtSize, toast, routeReq, fileTries, machineName, getMachinesCount, mdRender, setFileHead } = deps;

    function artifactsIn(text, renderedHTML = "") {
      const list = extractArtifacts(text, renderedHTML);
      if (!list.length) return "";
      const dlIco = `<svg viewBox="0 0 24 24"><path d="M12 3v12m0 0l-4-4m4 4l4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>`;
      const eyeIco = `<svg viewBox="0 0 24 24"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/></svg>`;
      return `<div class="artifact-cards">${list.map((it) => {
        const fname = it.path.split(/[\\/]/).pop() || it.path;
        const shortDir = tilde(it.path);
        return `<div class="art-card" data-art-open="${esc(it.path)}" title="${esc(shortDir)}">
          <span class="art-badge ${esc(it.meta.tone)}">${esc(it.meta.badge)}</span>
          <span class="art-main">
            <span class="art-name">${esc(fname)}</span>
            <span class="art-sub mono">${esc(shortDir)}</span>
          </span>
          <span class="art-acts">
            ${it.meta.canPreview ? `<button type="button" class="art-btn" data-art-preview="${esc(it.path)}" title="在线预览">${eyeIco}</button>` : ""}
            <button type="button" class="art-btn" data-art-dl="${esc(it.path)}" title="跨机下载到本地">${dlIco}</button>
          </span>
        </div>`;
      }).join("")}</div>`;
    }

    async function downloadArtifact(path, knownMachine, triggerBtn) {
      if (triggerBtn) { triggerBtn.disabled = true; triggerBtn.classList.add("busy"); }
      try {
        const tries = knownMachine !== undefined ? [knownMachine] : fileTries();
        let blob = null, finalName = path.split(/[\\/]/).pop() || "download";
        for (const m of tries) {
          const q = `/api/file?path=${encodeURIComponent(path)}${m ? "&machine=" + encodeURIComponent(m) : ""}&download=1`;
          const r = routeReq(q);
          const res = await fetch(r.url, { headers: r.hub ? { Authorization: "Bearer " + r.hub.token } : {}, credentials: r.hub ? "omit" : "same-origin" });
          if (res.status === 404) continue;
          if (!res.ok) {
            let e = {}; try { e = await res.json(); } catch {}
            throw new Error(e.error || "下载失败");
          }
          if (res.headers.get("X-File-Kind") === "binary" && (+res.headers.get("X-File-Size") || 0) > (50 << 20)) {
            throw new Error("文件超过 50 MB 在线传输上限");
          }
          blob = await res.blob();
          break;
        }
        if (!blob) throw new Error("在连接的电脑上未找到该文件");
        const u = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = u;
        a.download = finalName;
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(u), 8000);
        toast(`已下载 ${finalName}`);
      } catch (err) {
        toast(err.message || "下载失败", "attn");
      } finally {
        if (triggerBtn) { triggerBtn.disabled = false; triggerBtn.classList.remove("busy"); }
      }
    }

    async function renderRichFilePane(path, f, setObjectURL) {
      const body = $("#fv-body");
      const ext = extOf(path);
      const where = getMachinesCount() > 1 ? machineName(f.machine) + " · " : "";
      $("#fv-path").textContent = where + f.path + (f.size ? " · " + fmtSize(f.size) : "");

      const makeToolbar = (extra = "") => `<div class="fv-toolbar">
        <span class="fv-kind-pill">${esc((BADGE_META[ext]?.badge) || ext.toUpperCase() || f.kind.toUpperCase())}</span>
        ${extra ? `<span class="fv-dim-meta">${extra}</span>` : `<span class="muted">${fmtSize(f.size)}</span>`}
      </div>`;
      const bindDl = () => {
        $("#fv-dl-btn")?.addEventListener("click", (ev) => downloadArtifact(path, f.machine, ev.currentTarget));
      };

      if (f.kind === "pdf") {
        let pdfBlob = f.blob;
        if (!pdfBlob || pdfBlob.size === 0) {
          const q = `/api/file?path=${encodeURIComponent(path)}${f.machine ? "&machine=" + encodeURIComponent(f.machine) : ""}&as=pdf`;
          const r = routeReq(q);
          const res = await fetch(r.url, { headers: r.hub ? { Authorization: "Bearer " + r.hub.token } : {}, credentials: r.hub ? "omit" : "same-origin" });
          if (res.ok) pdfBlob = await res.blob();
        }
        if (pdfBlob && pdfBlob.size > 0) {
          if (setFileHead) setFileHead("PDF", "", false);
          body.classList.add("is-flush");
          const url = setObjectURL(new Blob([pdfBlob], { type: "application/pdf" }));
          body.innerHTML = `${makeToolbar()}<iframe class="fv-pdf" src="${url}#toolbar=1&navpanes=0" title="${esc(path)}"></iframe>`;
          bindDl();
          return true;
        }
      }

      if (f.kind === "csv" || ext === "csv" || ext === "tsv") {
        const text = await f.blob.text();
        const rows = parseDelimitedTable(text, ext === "tsv" ? "\t" : ",", 150);
        if (rows.length >= 1) {
          if (setFileHead) setFileHead(ext === "tsv" ? "TSV" : "CSV", text, true);
          body.classList.add("is-flush");
          const colCount = rows.reduce((m, r) => Math.max(m, r.length), rows[0].length);
          const head = Array.from({ length: colCount }, (_, i) => (rows[0][i] ?? "").trim() || `Col ${i + 1}`);
          const dataRows = rows.slice(1, 121);
          const isNumCol = head.map((_, ci) => {
            let nums = 0, nonEmpty = 0;
            for (const r of dataRows) {
              const v = (r[ci] ?? "").trim();
              if (!v) continue;
              nonEmpty++;
              if (NUM_CELL_RE.test(v)) nums++;
            }
            return nonEmpty > 0 && nums / nonEmpty >= 0.8;
          });
          const dimInfo = `${dataRows.length}${rows.length > 121 ? "+" : ""} 行 × ${colCount} 列 · ${fmtSize(f.size)}`;
          const moreNote = rows.length > 121 ? `<p class="fv-note muted" style="padding:0 14px 16px">表格较大，在线展示前 120 行；完整数据可点击右上角「下载到本地」。</p>` : "";
          body.innerHTML = `${makeToolbar(esc(dimInfo))}<div class="fv-csv-wrap"><table class="fv-csv" id="fv-code-src">
            <thead><tr><th class="idx">#</th>${head.map((c, ci) => `<th class="${isNumCol[ci] ? "num" : ""}" title="${esc(c)}">${esc(c)}</th>`).join("")}</tr></thead>
            <tbody>${dataRows.map((r, ri) => `<tr><td class="idx">${ri + 1}</td>${head.map((_, ci) => {
              const v = (r[ci] ?? "").trim();
              return `<td class="${isNumCol[ci] ? "num" : ""}" title="${esc(v)}">${esc(v)}</td>`;
            }).join("")}</tr>`).join("")}</tbody>
          </table></div>${moreNote}`;
          bindDl();
          return true;
        }
      }

      if (f.kind === "office" || f.kind === "archive" || f.kind === "binary") {
        if (setFileHead) setFileHead((BADGE_META[ext]?.badge) || "", "", false);
        const typeDesc = f.kind === "office" ? "Office 文档（Word / Excel / PPT）" : f.kind === "archive" ? "压缩归档包" : "二进制文件";
        const canDl = f.size > 0 && f.size <= (50 << 20);
        body.innerHTML = `<div class="fv-binary-card">
          <div class="fv-bin-badge">${esc((BADGE_META[ext]?.badge) || ext.toUpperCase() || "FILE")}</div>
          <h4>${esc(path.split(/[\\/]/).pop() || path)}</h4>
          <p class="muted">${typeDesc} · ${fmtSize(f.size)}${where ? " · 位于 " + esc(machineName(f.machine)) : ""}</p>
          ${canDl ? `<button type="button" class="btn primary" id="fv-dl-btn">一键下载到本机打开</button>` : `<p class="muted">文件体积超过 50 MB 在线下载限制</p>`}
        </div>`;
        bindDl();
        return true;
      }

      if (f.kind === "markdown" || /\.(md|markdown|mdx)$/i.test(path)) {
        const text = await f.blob.text();
        if (setFileHead) setFileHead("Markdown", text, true);
        body.classList.add("is-flush");
        const cut = f.size > f.blob.size ? `<p class="fv-note muted" style="padding:0 20px 16px">文件共 ${fmtSize(f.size)}，当前预览前 1 MB。</p>` : "";
        body.innerHTML = `${makeToolbar()}<div class="msg assistant fv-md" id="fv-code-src" style="padding:14px 20px 24px">${mdRender(text)}</div>${cut}`;
        bindDl();
        return true;
      }

      // Let openFile render source code / plain text with sticky line numbers + offline syntax highlighting!
      return false;
    }

    document.addEventListener("click", (e) => {
      const dlBtn = e.target.closest("[data-art-dl]");
      if (dlBtn) {
        e.preventDefault();
        e.stopPropagation();
        downloadArtifact(dlBtn.dataset.artDl, undefined, dlBtn);
        return;
      }
      const prevBtn = e.target.closest("[data-art-preview]");
      if (prevBtn) {
        e.preventDefault();
        e.stopPropagation();
        deps.openFile(prevBtn.dataset.artPreview);
        return;
      }
      const card = e.target.closest("[data-art-open]");
      if (card) {
        e.preventDefault();
        const p = card.dataset.artOpen;
        const ext = extOf(p);
        const meta = BADGE_META[ext];
        if (meta && !meta.canPreview) {
          downloadArtifact(p, undefined, card.querySelector("[data-art-dl]"));
        } else {
          deps.openFile(p);
        }
      }
    });

    return { artifactsIn, downloadArtifact, renderRichFilePane, extOf };
  }

  window.CollieArtifacts = { initArtifacts };
})();
