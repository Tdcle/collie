// Collie Offline Syntax Highlighter Module (zero-build, zero external deps).
// Single-pass O(N) lexical scanner across 22 language grammars; every emitted
// slice passes through esc() so output is XSS-safe and preserves exact
// textContent when copying selected lines.
(() => {
  "use strict";

  const HL_MAX_BYTES = 200 * 1024;
  const HL_MAX_LINES = 5000;

  const esc = (s) => String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  const LANG_LABELS = {
    go: "Go", py: "Python", js: "JavaScript", ts: "TypeScript", jsx: "JSX", tsx: "TSX",
    sql: "SQL", json: "JSON", yaml: "YAML", sh: "Shell", html: "HTML", xml: "XML",
    css: "CSS", md: "Markdown", diff: "Diff", rust: "Rust", java: "Java",
    c: "C", cpp: "C++", toml: "TOML", dockerfile: "Dockerfile", makefile: "Makefile",
    tex: "LaTeX",
  };
  const EXT_LANG = {
    go: "go", py: "py", pyi: "py", pyw: "py",
    js: "js", mjs: "js", cjs: "js", ts: "ts", mts: "ts", cts: "ts", jsx: "jsx", tsx: "tsx",
    sql: "sql", json: "json", jsonl: "json", jsonc: "json", ipynb: "json", webmanifest: "json",
    yaml: "yaml", yml: "yaml", sh: "sh", bash: "sh", zsh: "sh", ps1: "sh",
    html: "html", htm: "html", vue: "html", svelte: "html",
    xml: "xml", svg: "xml", plist: "xml", xhtml: "xml",
    css: "css", scss: "css", less: "css", md: "md", markdown: "md", mdx: "md",
    diff: "diff", patch: "diff", rs: "rust", java: "java", kt: "java", kts: "java",
    c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", proto: "cpp",
    toml: "toml", ini: "toml", cfg: "toml", conf: "toml",
    dockerfile: "dockerfile", mk: "makefile", tex: "tex", bib: "tex", sty: "tex", cls: "tex",
  };
  const FENCE_LANG = {
    ...EXT_LANG,
    golang: "go", gomod: "go", python: "py", python3: "py",
    javascript: "js", node: "js", typescript: "ts",
    mysql: "sql", postgres: "sql", postgresql: "sql", sqlite: "sql", hive: "sql", sparksql: "sql", plsql: "sql",
    json5: "json", shell: "sh", console: "sh", env: "sh", powershell: "sh", pwsh: "sh",
    rust: "rust", kotlin: "java", "c++": "cpp", protobuf: "cpp",
    docker: "dockerfile", makefile: "makefile", make: "makefile", latex: "tex", bibtex: "tex",
  };

  function detectCodeLang(raw, byPath = false) {
    if (!raw) return null;
    let id = "";
    if (byPath) {
      const name = String(raw).split(/[\\/]/).pop() || "";
      const low = name.toLowerCase();
      if (low === "dockerfile" || low.startsWith("dockerfile.") || low === "containerfile") id = "dockerfile";
      else if (low === "makefile" || low === "gnumakefile" || low === "justfile") id = "makefile";
      else if (low === "go.mod" || low === "go.sum") id = "go";
      else if (/^\.(?:bashrc|bash_profile|zshrc|profile|env)(?:\..+)?$/.test(low) || low === ".gitignore" || low === ".dockerignore") id = "sh";
      else if (low.includes(".")) id = EXT_LANG[low.split(".").pop()] || "";
    } else {
      const tag = String(raw).trim().split(/[\s{:]/)[0].toLowerCase().replace(/^language-/, "");
      id = FENCE_LANG[tag] || "";
    }
    return id && LANG_LABELS[id] ? { id, label: LANG_LABELS[id] } : null;
  }

  const wset = (s) => new Set(s.trim().split(/\s+/));
  function wordCls(kw, ty, cn, { ci = false, pascal = true, calls = true } = {}) {
    const kS = wset(kw), tS = ty ? wset(ty) : null, cS = cn ? wset(cn) : null;
    return (tok, src, idx) => {
      const w = ci ? tok.toLowerCase() : tok;
      if (kS.has(w)) return "k";
      if (cS?.has(w)) return "n";
      if (tS?.has(w)) return "ty";
      if (calls) {
        let j = idx + tok.length;
        while (j < src.length && (src[j] === " " || src[j] === "\t")) j++;
        if (src[j] === "(") return "fn";
      }
      if (pascal && /^[A-Z][A-Za-z0-9_]*$/.test(tok)) return "ty";
      return "";
    };
  }

  function compileRules(rules, flags = "gm") {
    return { re: new RegExp(rules.map((r) => "(" + r.pat + ")").join("|"), flags), rules };
  }

  function scanCompiled(src, { re, rules }) {
    let out = "", pos = 0;
    for (const m of src.matchAll(re)) {
      if (m.index > pos) out += esc(src.slice(pos, m.index));
      const tok = m[0];
      if (!tok) continue;
      let g = 0;
      while (g < rules.length && m[g + 1] === undefined) g++;
      const r = rules[g];
      if (r?.html) {
        out += r.html(tok, src, m.index);
      } else {
        const cls = typeof r?.cls === "function" ? r.cls(tok, src, m.index) : r?.cls;
        out += cls ? `<span class="hl-${cls}">${esc(tok)}</span>` : esc(tok);
      }
      pos = m.index + tok.length;
    }
    if (pos < src.length) out += esc(src.slice(pos));
    return out;
  }

  const P_CL = "//[^\\n]*", P_CB = "\\/\\*[\\s\\S]*?(?:\\*\\/|$)", P_HASH = "#[^\\n]*";
  const P_DQ = '"(?:\\\\[\\s\\S]|[^"\\\\\\n])*"?', P_SQ = "'(?:\\\\[\\s\\S]|[^'\\\\\\n])*'?", P_TPL = "`(?:\\\\[\\s\\S]|[^`\\\\])*`?";
  const P_NUM = "-?\\b(?:0[xX][0-9a-fA-F_]+|0[bBoO][0-9_]+|\\d[\\d_]*(?:\\.[\\d_]+)?(?:[eE][+-]?\\d+)?i?)\\b";
  const P_ID = "[A-Za-z_$][\\w$]*";
  const leadHash = (t) => (t[0] === "#" ? `<span class="hl-c">${esc(t)}</span>` : esc(t[0]) + `<span class="hl-c">${esc(t.slice(1))}</span>`);
  const TAG_SUB = compileRules([
    { pat: "^<\\/?[A-Za-z][\\w:-]*", cls: "ty" },
    { pat: "\\/?>|<\\?[\\w:-]*|\\?>", cls: "ty" },
    { pat: '"[^"]*"|\'[^\']*\'', cls: "s" },
    { pat: "[\\w:-]+(?=\\s*=)", cls: "pr" },
    { pat: "[\\w:-]+", cls: "pr" },
  ]);
  const hlTag = (t) => scanCompiled(t, TAG_SUB);
  const GRAMMARS = {};

  function getGrammar(id) {
    if (GRAMMARS[id]) return GRAMMARS[id];
    let rules = null, flags = "gm";
    const jsWords = wordCls(
      "as async await break case catch class const continue debugger default delete do else enum export extends finally for from function get if implements import in instanceof interface keyof let namespace new of private protected public readonly return satisfies set static super switch throw try type typeof var void while yield",
      "any bigint boolean never number object string symbol unknown Promise Map Set Array Record Partial Omit Pick Readonly",
      "true false null undefined NaN Infinity this"
    );
    switch (id) {
      case "go":
        rules = [
          { pat: P_CL, cls: "c" }, { pat: P_CB, cls: "c" },
          { pat: "`[^`]*`?", cls: "s" }, { pat: P_DQ, cls: "s" }, { pat: P_SQ, cls: "s" },
          { pat: P_NUM, cls: "n" },
          { pat: P_ID, cls: wordCls(
            "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var module require replace exclude",
            "any bool byte comparable complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr",
            "true false nil iota"
          ) },
        ];
        break;
      case "py":
        rules = [
          { pat: P_HASH, cls: "c" },
          { pat: '(?:[fFrRbBuU]{1,2})?(?:"""[\\s\\S]*?(?:"""|$)|\'\'\'[\\s\\S]*?(?:\'\'\'|$))', cls: "s" },
          { pat: "(?:[fFrRbBuU]{1,2})?(?:" + P_DQ + "|" + P_SQ + ")", cls: "s" },
          { pat: "@[A-Za-z_][\\w.]*", cls: "m" },
          { pat: P_NUM, cls: "n" },
          { pat: "[A-Za-z_][\\w]*", cls: wordCls(
            "and as assert async await break case class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return try while with yield",
            "bool bytes callable dict float frozenset int list object set slice str tuple type Exception ValueError TypeError KeyError RuntimeError OSError",
            "True False None self cls"
          ) },
        ];
        break;
      case "js": case "ts": case "jsx": case "tsx":
        rules = [
          { pat: P_CL, cls: "c" }, { pat: P_CB, cls: "c" },
          { pat: P_TPL, cls: "s" }, { pat: P_DQ, cls: "s" }, { pat: P_SQ, cls: "s" },
          ...(id === "jsx" || id === "tsx" ? [{ pat: "<\\/?[A-Za-z][\\w.]*(?=\\s|\\/|\\>)", cls: "ty" }] : []),
          { pat: "@[A-Za-z_$][\\w$.]*", cls: "m" },
          { pat: P_NUM, cls: "n" },
          { pat: P_ID, cls: jsWords },
        ];
        break;
      case "sql":
        rules = [
          { pat: "--[^\\n]*", cls: "c" }, { pat: P_CB, cls: "c" },
          { pat: "'(?:''|\\\\[\\s\\S]|[^'])*'?", cls: "s" }, { pat: P_DQ, cls: "pr" }, { pat: "`[^`]*`?", cls: "pr" },
          { pat: "\\$\\d+|:[A-Za-z_]\\w*", cls: "m" },
          { pat: P_NUM, cls: "n" },
          { pat: "[A-Za-z_]\\w*", cls: wordCls(
            "select from where and or not in exists is as join left right inner outer full cross lateral on using group by order asc desc nulls first last having limit offset union all except intersect insert into values update set delete create alter drop replace truncate table view index database schema temp temporary if case when then else end with recursive distinct over partition rows range between preceding following unbounded current row primary key foreign references default unique check constraint begin commit rollback pragma explain analyze unnest",
            "int integer bigint smallint tinyint text varchar char nvarchar boolean bool date time timestamp timestamptz datetime float double real decimal numeric json jsonb blob bytea uuid serial array map struct string",
            "null true false",
            { ci: true, pascal: false, calls: true }
          ) },
        ];
        break;
      case "json":
        rules = [
          { pat: P_CL, cls: "c" }, { pat: P_CB, cls: "c" },
          { pat: P_DQ, cls: (tok, src, idx) => {
            let j = idx + tok.length;
            while (j < src.length && (src[j] === " " || src[j] === "\t" || src[j] === "\n" || src[j] === "\r")) j++;
            return src[j] === ":" ? "pr" : "s";
          } },
          { pat: "\\b(?:true|false|null)\\b", cls: "n" },
          { pat: "-?\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b", cls: "n" },
        ];
        break;
      case "yaml":
        rules = [
          { pat: "(?:^|[ \\t])#[^\\n]*", html: leadHash },
          { pat: "^[ \\t]*(?:-[ \\t]+)?[A-Za-z0-9_.\\-]+(?=\\s*:(?:\\s|$))", html: (t) => {
            const m = /^([ \t]*(?:-[ \t]+)?)(.*)$/.exec(t);
            return esc(m[1]) + `<span class="hl-pr">${esc(m[2])}</span>`;
          } },
          { pat: P_DQ, cls: "s" }, { pat: "'(?:''|[^'\\n])*'?", cls: "s" },
          { pat: "[&*][\\w-]+|![\\w/-]+", cls: "m" },
          { pat: "\\b(?:true|false|null|yes|no|on|off)\\b", cls: "n" },
          { pat: "-?\\b\\d+(?:\\.\\d+)?\\b", cls: "n" },
        ];
        break;
      case "sh":
        rules = [
          { pat: "^#![^\\n]*", cls: "m" },
          { pat: "(?:^|[ \\t;&|()])#[^\\n]*", html: leadHash },
          { pat: '"(?:\\\\[\\s\\S]|[^"\\\\])*"?', cls: "s" }, { pat: "'[^']*'", cls: "s" },
          { pat: "\\$(?:\\{[^}\\n]+\\}|\\([^)\\n]*\\)|[A-Za-z_]\\w*|[0-9?!@#$*_-])", cls: "m" },
          { pat: "(?:^|[ \\t])--?[A-Za-z0-9][\\w-]*", html: (t) => (t[0] === "-" ? `<span class="hl-pr">${esc(t)}</span>` : esc(t[0]) + `<span class="hl-pr">${esc(t.slice(1))}</span>`) },
          { pat: "\\b(?:if|then|else|elif|fi|for|in|do|done|while|until|case|esac|function|select|return|exit|break|continue|export|local|readonly|declare|typeset|set|unset|shift|source|trap|exec|eval)\\b", cls: "k" },
          { pat: "\\b(?:echo|printf|cd|pwd|test|read|kill|wait|true|false)\\b", cls: "fn" },
          { pat: "-?\\b\\d+\\b", cls: "n" },
        ];
        break;
      case "html": case "xml":
        rules = [
          { pat: "<!--[\\s\\S]*?(?:-->|$)", cls: "c" },
          { pat: "<![^>]*>", cls: "m" },
          ...(id === "html" ? [
            { pat: "<script\\b[^>]*>[\\s\\S]*?<\\/script>", html: (t) => {
              const m = /^(<script\b[^>]*>)([\s\S]*)(<\/script>)$/i.exec(t);
              return m ? hlTag(m[1]) + highlightCode(m[2], "js") + hlTag(m[3]) : esc(t);
            } },
            { pat: "<style\\b[^>]*>[\\s\\S]*?<\\/style>", html: (t) => {
              const m = /^(<style\b[^>]*>)([\s\S]*)(<\/style>)$/i.exec(t);
              return m ? hlTag(m[1]) + highlightCode(m[2], "css") + hlTag(m[3]) : esc(t);
            } },
          ] : []),
          { pat: "<\\/?[A-Za-z?][\\w:-]*(?:\\s+(?:\"[^\"]*\"|'[^']*'|[^\"'<>])*)?\\s*[\\/?]?>", html: hlTag },
          { pat: "&[A-Za-z0-9#]+;", cls: "n" },
        ];
        break;
      case "css":
        rules = [
          { pat: P_CB, cls: "c" }, { pat: P_CL, cls: "c" },
          { pat: P_DQ, cls: "s" }, { pat: P_SQ, cls: "s" },
          { pat: "@[\\w-]+", cls: "k" },
          { pat: "--[\\w-]+", cls: "m" },
          { pat: "#[0-9a-fA-F]{3,8}\\b", cls: "n" },
          { pat: "[a-zA-Z-]+(?=\\s*:)", cls: "pr" },
          { pat: "-?\\b\\d+(?:\\.\\d+)?(?:px|em|rem|dvh|svh|vh|vw|%|s|ms|deg|fr|ch)?\\b", cls: "n" },
          { pat: "\\b(?:var|calc|min|max|clamp|color-mix|light-dark|linear-gradient|radial-gradient|url|rgb|rgba|hsl|hsla)(?=\\()", cls: "fn" },
        ];
        break;
      case "diff":
        rules = [
          { pat: "^(?:diff |index |--- |\\+\\+\\+ )[^\\n]*", cls: "m" },
          { pat: "^@@[^\\n]*", cls: "fn" },
          { pat: "^\\+[^\\n]*", cls: "add" },
          { pat: "^-[^\\n]*", cls: "del" },
        ];
        break;
      case "md":
        rules = [
          { pat: "^#{1,6}\\s[^\\n]*", cls: "fn" },
          { pat: "```[\\s\\S]*?(?:```|$)", cls: "s" },
          { pat: "`[^`\\n]+`", cls: "s" },
          { pat: "\\*\\*[^*\\n]+\\*\\*", cls: "k" },
          { pat: "\\[[^\\]\\n]+\\]\\([^)\\n]+\\)", cls: "ty" },
          { pat: "^>\\s[^\\n]*", cls: "c" },
        ];
        break;
      case "rust":
        rules = [
          { pat: P_CL, cls: "c" }, { pat: P_CB, cls: "c" },
          { pat: "#!?\\[[^\\]\\n]*\\]", cls: "m" },
          { pat: 'r#*"[\\s\\S]*?"#*', cls: "s" }, { pat: P_DQ, cls: "s" },
          { pat: "'(?:\\\\.|[^'\\\\\\n])'", cls: "s" },
          { pat: "'[a-zA-Z_]\\w*\\b", cls: "m" },
          { pat: "\\b[a-z_]\\w*!", cls: "m" },
          { pat: P_NUM, cls: "n" },
          { pat: "[A-Za-z_]\\w*", cls: wordCls(
            "as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while",
            "bool char f32 f64 i8 i16 i32 i64 i128 isize str u8 u16 u32 u64 u128 usize String Vec Option Result Box Rc Arc Cow",
            "true false None Some Ok Err"
          ) },
        ];
        break;
      case "java":
        rules = [
          { pat: P_CL, cls: "c" }, { pat: P_CB, cls: "c" },
          { pat: P_DQ, cls: "s" }, { pat: P_SQ, cls: "s" },
          { pat: "@[A-Za-z_][\\w.]*", cls: "m" },
          { pat: P_NUM, cls: "n" },
          { pat: P_ID, cls: wordCls(
            "abstract assert break case catch class const continue default do else enum extends final finally for fun goto if implements import in instanceof interface internal native new object open override package private protected public record return sealed static strictfp super suspend switch synchronized throw throws transient try val var volatile when while yield",
            "boolean byte char double float int long short void String List Map Set Optional Object Integer Long Double Boolean",
            "true false null this"
          ) },
        ];
        break;
      case "c": case "cpp":
        rules = [
          { pat: P_CL, cls: "c" }, { pat: P_CB, cls: "c" },
          { pat: "^[ \\t]*#[ \\t]*[a-zA-Z_]\\w*[^\\n]*", cls: "m" },
          { pat: P_DQ, cls: "s" }, { pat: P_SQ, cls: "s" },
          { pat: P_NUM, cls: "n" },
          { pat: "[A-Za-z_]\\w*", cls: wordCls(
            "alignas alignof auto break case catch class co_await co_return co_yield constexpr consteval constinit const const_cast continue decltype default delete do dynamic_cast else enum explicit export extern final for friend goto if inline mutable namespace new noexcept operator override private protected public register reinterpret_cast requires return sizeof static static_assert static_cast struct switch template thread_local throw try typedef typeid typename union using virtual volatile while message service rpc repeated optional required",
            "bool char char8_t char16_t char32_t double float int long short signed size_t ssize_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t uintptr_t ptrdiff_t void wchar_t string vector map unordered_map set unique_ptr shared_ptr bytes",
            "true false nullptr NULL this"
          ) },
        ];
        break;
      case "toml":
        rules = [
          { pat: P_HASH, cls: "c" },
          { pat: "^[ \\t]*\\[\\[?[^\\]\\n]+\\]\\]?", cls: "ty" },
          { pat: '"""[\\s\\S]*?(?:"""|$)|\'\'\'[\\s\\S]*?(?:\'\'\'|$)', cls: "s" },
          { pat: P_DQ, cls: "s" }, { pat: "'[^'\\n]*'?", cls: "s" },
          { pat: "^[ \\t]*[A-Za-z0-9_.-]+(?=\\s*=)", cls: "pr" },
          { pat: "\\b(?:true|false)\\b|\\b\\d{4}-\\d{2}-\\d{2}(?:[T ]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})?)?\\b", cls: "n" },
          { pat: P_NUM, cls: "n" },
        ];
        break;
      case "dockerfile":
        rules = [
          { pat: P_HASH, cls: "c" },
          { pat: "^[ \\t]*(?:FROM|RUN|CMD|LABEL|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL|AS)\\b", cls: "k" },
          { pat: P_DQ, cls: "s" }, { pat: P_SQ, cls: "s" },
          { pat: "\\$(?:\\{[^}\\n]+\\}|[A-Za-z_]\\w*)", cls: "m" },
          { pat: "(?:^|[ \\t])--[A-Za-z0-9][\\w=-]*", html: (t) => (t[0] === "-" ? `<span class="hl-pr">${esc(t)}</span>` : esc(t[0]) + `<span class="hl-pr">${esc(t.slice(1))}</span>`) },
          { pat: P_NUM, cls: "n" },
        ];
        flags = "gim";
        break;
      case "makefile":
        rules = [
          { pat: P_HASH, cls: "c" },
          { pat: "^[A-Za-z0-9_.\\-/]+(?=\\s*:[^=])", cls: "fn" },
          { pat: "^[ \\t]*(?:include|-include|ifeq|ifneq|ifdef|ifndef|else|endif|export|unexport|override|define|endef|\\.PHONY|\\.DEFAULT_GOAL)\\b", cls: "k" },
          { pat: "^[ \\t]*[A-Za-z_]\\w*(?=\\s*[:+?]?=)", cls: "pr" },
          { pat: "\\$(?:\\([^)\\n]+\\)|\\{[^}\\n]+\\}|[@<^?*+%|])", cls: "m" },
          { pat: P_DQ, cls: "s" }, { pat: P_SQ, cls: "s" },
        ];
        break;
      case "tex":
        rules = [
          { pat: "(?<!\\\\)%[^\\n]*", cls: "c" },
          { pat: "\\\\(?:begin|end|section|subsection|subsubsection|documentclass|usepackage|cite|ref|label|caption|textbf|textit|emph|includegraphics)\\b", cls: "k" },
          { pat: "\\\\[A-Za-z@]+", cls: "fn" },
          { pat: "\\$\\$[\\s\\S]*?\\$\\$|\\$[^$\\n]+\\$", cls: "s" },
          { pat: "[{}]", cls: "ty" },
          { pat: P_NUM, cls: "n" },
        ];
        break;
    }
    return rules ? (GRAMMARS[id] = compileRules(rules, flags)) : null;
  }

  function highlightCode(code, langId) {
    if (!langId || code.length > HL_MAX_BYTES) return esc(code);
    const g = getGrammar(langId);
    return g ? scanCompiled(code, g) : esc(code);
  }

  window.CollieHighlight = {
    HL_MAX_BYTES,
    HL_MAX_LINES,
    detectCodeLang,
    highlightCode,
  };
})();
