/* CollieMath — Zero-dependency offline LaTeX-to-MathML Core renderer for Collie. */
(() => {
  "use strict";

  const escXML = (s) => String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  const GREEK = {
    alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ϵ", varepsilon: "ε",
    zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ", varkappa: "ϰ",
    lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", varpi: "ϖ", rho: "ρ", varrho: "ϱ",
    sigma: "σ", varsigma: "ς", tau: "τ", upsilon: "υ", phi: "ϕ", varphi: "φ",
    chi: "χ", psi: "ψ", omega: "ω",
    Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π",
    Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
    ell: "ℓ", hbar: "ℏ", imath: "ı", jmath: "ȷ", wp: "℘", Re: "ℜ", Im: "ℑ", aleph: "ℵ",
    infty: "∞", partial: "∂", nabla: "∇", emptyset: "∅", varnothing: "∅",
    forall: "∀", exists: "∃", nexists: "∄", neg: "¬", lnot: "¬",
    top: "⊤", bot: "⊥", angle: "∠", triangle: "△",
    checkmark: "✓", dagger: "†", ddagger: "‡", star: "⋆",
  };

  const OPS = {
    times: "×", cdot: "·", cdots: "⋯", ldots: "…", dots: "…", vdots: "⋮", ddots: "⋱",
    div: "÷", pm: "±", mp: "∓", circ: "∘", bullet: "•", ast: "∗",
    oplus: "⊕", ominus: "⊖", otimes: "⊗", oslash: "⊘", odot: "⊙",
    cap: "∩", cup: "∪", sqcap: "⊓", sqcup: "⊔", uplus: "⊎", setminus: "∖", smallsetminus: "∖",
    vee: "∨", lor: "∨", wedge: "∧", land: "∧",
    le: "≤", leq: "≤", leqslant: "⩽", ge: "≥", geq: "≥", geqslant: "⩾",
    neq: "≠", ne: "≠", approx: "≈", sim: "∼", simeq: "≃", cong: "≅", equiv: "≡",
    propto: "∝", asymp: "≍", doteq: "≐", prec: "≺", succ: "≻", preceq: "⪯", succeq: "⪰",
    ll: "≪", gg: "≫",
    in: "∈", notin: "∉", ni: "∋", owns: "∋",
    subset: "⊂", supset: "⊃", subseteq: "⊆", supseteq: "⊇", subsetneq: "⊊", supsetneq: "⊋",
    sqsubseteq: "⊑", sqsupseteq: "⊒",
    vdash: "⊢", dashv: "⊣", models: "⊨", perp: "⊥", parallel: "∥", mid: "∣", nmid: "∤",
    to: "→", rightarrow: "→", leftarrow: "←", gets: "←", leftrightarrow: "↔",
    Rightarrow: "⇒", Leftarrow: "⇐", Leftrightarrow: "⇔", iff: "⟺", implies: "⟹", impliedby: "⟸",
    mapsto: "↦", longmapsto: "⟼", longrightarrow: "⟶", longleftarrow: "⟵",
    uparrow: "↑", downarrow: "↓", updownarrow: "↕", Uparrow: "⇑", Downarrow: "⇓",
    nearrow: "↗", searrow: "↘", swarrow: "↙", nwarrow: "↖", hookrightarrow: "↪",
    colon: ":", because: "∵", therefore: "∴",
  };

  const BIG_OPS = {
    sum: { ch: "∑", movable: true },
    prod: { ch: "∏", movable: true },
    coprod: { ch: "∐", movable: true },
    bigcap: { ch: "⋂", movable: true },
    bigcup: { ch: "⋃", movable: true },
    bigsqcup: { ch: "⨆", movable: true },
    bigoplus: { ch: "⨁", movable: true },
    bigotimes: { ch: "⨂", movable: true },
    bigodot: { ch: "⨀", movable: true },
    bigvee: { ch: "⋁", movable: true },
    bigwedge: { ch: "⋀", movable: true },
    int: { ch: "∫", movable: false },
    iint: { ch: "∬", movable: false },
    iiint: { ch: "∭", movable: false },
    oint: { ch: "∮", movable: false },
  };

  const FUNC_NAMES = new Set([
    "arg", "max", "min", "sup", "inf", "lim", "limsup", "liminf",
    "sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan",
    "sinh", "cosh", "tanh", "coth",
    "exp", "log", "ln", "lg", "det", "dim", "ker", "hom", "deg", "gcd", "Pr", "bmod", "mod",
    "tr", "rank", "diag", "sgn", "sign", " clip", "softmax", "Softmax", "MSE", "BCE", "IoU", "Dice",
  ]);

  const MOVABLE_FUNCS = new Set(["max", "min", "sup", "inf", "lim", "limsup", "liminf", "det", "Pr", "gcd"]);

  const DELIMS = {
    "(": "(", ")": ")", "[": "[", "]": "]",
    "\\{": "{", "\\}": "}", "{": "{", "}": "}",
    "|": "|", "\\|": "‖", "\\vert": "|", "\\Vert": "‖",
    "\\langle": "⟨", "\\rangle": "⟩",
    "\\lfloor": "⌊", "\\rfloor": "⌋",
    "\\lceil": "⌈", "\\rceil": "⌉",
    "/": "/", "\\backslash": "\\", ".": "",
  };

  const SPACES = {
    ",": "0.167em", ":": "0.222em", ";": "0.278em", ">": "0.222em",
    "!": "-0.167em", " ": "0.333em",
    quad: "1em", qquad: "2em", thinspace: "0.167em", medspace: "0.222em", thickspace: "0.278em",
    enspace: "0.5em",
  };

  const ACCENTS = {
    hat: { ch: "^", over: true, stretchy: false },
    widehat: { ch: "^", over: true, stretchy: true },
    check: { ch: "ˇ", over: true, stretchy: false },
    tilde: { ch: "~", over: true, stretchy: false },
    widetilde: { ch: "~", over: true, stretchy: true },
    acute: { ch: "´", over: true, stretchy: false },
    grave: { ch: "`", over: true, stretchy: false },
    dot: { ch: "˙", over: true, stretchy: false },
    ddot: { ch: "¨", over: true, stretchy: false },
    breve: { ch: "˘", over: true, stretchy: false },
    bar: { ch: "¯", over: true, stretchy: false },
    overline: { ch: "¯", over: true, stretchy: true },
    underline: { ch: "_", over: false, stretchy: true },
    vec: { ch: "→", over: true, stretchy: false },
    overrightarrow: { ch: "→", over: true, stretchy: true },
    overleftarrow: { ch: "←", over: true, stretchy: true },
    overbrace: { ch: "⏞", over: true, stretchy: true, movable: true },
    underbrace: { ch: "⏟", over: false, stretchy: true, movable: true },
  };

  const BB_MAP = {
    A: "𝔸", B: "𝔹", C: "ℂ", D: "𝔻", E: "𝔼", F: "𝔽", G: "𝔾", H: "ℍ", I: "𝕀", J: "𝕁", K: "𝕂", L: "𝕃", M: "𝕄",
    N: "ℕ", O: "𝕆", P: "ℙ", Q: "ℚ", R: "ℝ", S: "𝕊", T: "𝕋", U: "𝕌", V: "𝕍", W: "𝕎", X: "𝕏", Y: "𝕐", Z: "ℤ",
    "1": "𝟙", "0": "𝟘",
  };

  const CAL_MAP = {
    A: "𝒜", B: "ℬ", C: "𝒞", D: "𝒟", E: "ℰ", F: "ℱ", G: "𝒢", H: "ℋ", I: "ℐ", J: "𝒥", K: "𝒦", L: "ℒ", M: "ℳ",
    N: "𝒩", O: "𝒪", P: "𝒫", Q: "𝒬", R: "ℛ", S: "𝒮", T: "𝒯", U: "𝒰", V: "𝒱", W: "𝒲", X: "𝒳", Y: "𝒴", Z: "𝒵",
  };

  function mapAlphabet(str, table) {
    return [...str].map((ch) => table[ch] || ch).join("");
  }

  class Parser {
    constructor(src, display) {
      this.s = src;
      this.i = 0;
      this.n = src.length;
      this.display = display;
    }

    skipWS() {
      while (this.i < this.n) {
        const c = this.s[this.i];
        if (c === " " || c === "\t" || c === "\r" || c === "\n") {
          this.i++;
        } else if (c === "%") {
          while (this.i < this.n && this.s[this.i] !== "\n") this.i++;
        } else {
          break;
        }
      }
    }

    peek() {
      this.skipWS();
      return this.i < this.n ? this.s[this.i] : "";
    }

    readCmd() {
      // Assumes this.s[this.i] === '\\'
      this.i++;
      if (this.i >= this.n) return "";
      const c = this.s[this.i];
      if (/[A-Za-z]/.test(c)) {
        let start = this.i;
        while (this.i < this.n && /[A-Za-z]/.test(this.s[this.i])) this.i++;
        if (this.s[this.i] === "*" && (this.s.slice(start, this.i) === "operatorname")) {
          this.i++;
          return "operatorname*";
        }
        return this.s.slice(start, this.i);
      }
      this.i++;
      return c;
    }

    readRawBrace() {
      this.skipWS();
      if (this.s[this.i] !== "{") {
        if (this.i >= this.n) return "";
        if (this.s[this.i] === "\\") return "\\" + this.readCmd();
        return this.s[this.i++];
      }
      this.i++;
      let depth = 1, start = this.i;
      while (this.i < this.n && depth > 0) {
        if (this.s[this.i] === "\\") {
          this.i += 2;
          continue;
        }
        if (this.s[this.i] === "{") depth++;
        else if (this.s[this.i] === "}") depth--;
        if (depth > 0) this.i++;
      }
      const out = this.s.slice(start, this.i);
      if (this.s[this.i] === "}") this.i++;
      return out;
    }

    readBracketOpt() {
      this.skipWS();
      if (this.s[this.i] !== "[") return null;
      this.i++;
      let depth = 1, start = this.i;
      while (this.i < this.n && depth > 0) {
        if (this.s[this.i] === "{") depth++;
        else if (this.s[this.i] === "}" && depth > 1) depth--;
        else if (this.s[this.i] === "[") depth++;
        else if (this.s[this.i] === "]") depth--;
        if (depth > 0) this.i++;
      }
      const raw = this.s.slice(start, this.i);
      if (this.s[this.i] === "]") this.i++;
      return raw;
    }

    readDelimToken() {
      this.skipWS();
      if (this.i >= this.n) return "";
      if (this.s[this.i] === "\\") {
        const cmd = "\\" + this.readCmd();
        return DELIMS[cmd] !== undefined ? DELIMS[cmd] : cmd.slice(1);
      }
      const ch = this.s[this.i++];
      return DELIMS[ch] !== undefined ? DELIMS[ch] : ch;
    }

    parseGroup(subDisplay = this.display) {
      this.skipWS();
      if (this.i >= this.n) return "<mrow></mrow>";
      if (this.s[this.i] === "{") {
        this.i++;
        const prev = this.display;
        this.display = subDisplay;
        const inner = this.parseRow("}");
        this.display = prev;
        if (this.s[this.i] === "}") this.i++;
        return inner;
      }
      const prev = this.display;
      this.display = subDisplay;
      const atom = this.parseBaseAtom();
      this.display = prev;
      return atom ? atom.xml : "<mrow></mrow>";
    }

    parseRow(stopOn = "") {
      const items = [];
      while (this.i < this.n) {
        this.skipWS();
        if (this.i >= this.n) break;
        const c = this.s[this.i];
        if (stopOn && c === stopOn) break;
        if (c === "}") break;
        if (stopOn === "\\right" && this.s.startsWith("\\right", this.i) && !/[A-Za-z]/.test(this.s[this.i + 6] || "")) {
          break;
        }
        // Handle infix `\over` / `\choose`
        if (this.s.startsWith("\\over", this.i) && !/[A-Za-z]/.test(this.s[this.i + 5] || "")) {
          this.i += 5;
          const num = wrapMrow(items);
          const den = this.parseRow(stopOn);
          return `<mfrac>${num}${den}</mfrac>`;
        }
        const node = this.parseScriptedAtom();
        if (!node) break;
        items.push(node);
      }
      return wrapMrow(items);
    }

    parseScriptedAtom() {
      let base = this.parseBaseAtom();
      if (!base) return "";
      let sub = null, sup = null;
      let forceLimits = null; // true = \limits, false = \nolimits

      while (this.i < this.n) {
        this.skipWS();
        if (this.s.startsWith("\\limits", this.i) && !/[A-Za-z]/.test(this.s[this.i + 7] || "")) {
          this.i += 7;
          forceLimits = true;
          continue;
        }
        if (this.s.startsWith("\\nolimits", this.i) && !/[A-Za-z]/.test(this.s[this.i + 9] || "")) {
          this.i += 9;
          forceLimits = false;
          continue;
        }
        const ch = this.s[this.i];
        if (ch === "_" && sub === null) {
          this.i++;
          sub = this.parseGroup(false);
          continue;
        }
        if (ch === "^" && sup === null) {
          this.i++;
          sup = this.parseGroup(false);
          continue;
        }
        if (ch === "'") {
          let primes = "";
          while (this.s[this.i] === "'") { primes += "′"; this.i++; }
          const primeNode = `<mo>${primes}</mo>`;
          sup = sup ? `<mrow>${sup}${primeNode}</mrow>` : primeNode;
          continue;
        }
        break;
      }

      const useUnderOver = forceLimits !== null ? forceLimits : (Boolean(base.movable) && this.display);
      if (sub !== null && sup !== null) {
        return useUnderOver
          ? `<munderover>${base.xml}${sub}${sup}</munderover>`
          : `<msubsup>${base.xml}${sub}${sup}</msubsup>`;
      }
      if (sub !== null) {
        return useUnderOver
          ? `<munder>${base.xml}${sub}</munder>`
          : `<msub>${base.xml}${sub}</msub>`;
      }
      if (sup !== null) {
        return useUnderOver
          ? `<mover>${base.xml}${sup}</mover>`
          : `<msup>${base.xml}${sup}</msup>`;
      }
      return base.xml;
    }

    parseBaseAtom() {
      this.skipWS();
      if (this.i >= this.n) return null;
      const c = this.s[this.i];

      if (c === "{") {
        this.i++;
        const xml = this.parseRow("}");
        if (this.s[this.i] === "}") this.i++;
        return { xml };
      }

      if (c === "\\") {
        return this.parseCommand();
      }

      // Multi-digit number (e.g. `10` in `10^{-6}` or `0.05`)
      if (/\d/.test(c)) {
        let start = this.i;
        while (this.i < this.n && /\d/.test(this.s[this.i])) this.i++;
        if (this.s[this.i] === "." && /\d/.test(this.s[this.i + 1] || "")) {
          this.i++;
          while (this.i < this.n && /\d/.test(this.s[this.i])) this.i++;
        }
        return { xml: `<mn>${this.s.slice(start, this.i)}</mn>` };
      }

      if (/[A-Za-z]/.test(c)) {
        this.i++;
        return { xml: `<mi>${c}</mi>` };
      }

      this.i++;
      if (c === "-") return { xml: `<mo>−</mo>` };
      if (c === "+" || c === "=" || c === "<" || c === ">" || c === "," || c === ";" || c === ":" || c === "!" || c === "/" || c === "*" || c === "|" || c === "(" || c === ")" || c === "[" || c === "]") {
        const stretch = (c === "(" || c === ")" || c === "[" || c === "]" || c === "|") ? ` stretchy="false"` : "";
        return { xml: `<mo${stretch}>${escXML(c)}</mo>` };
      }
      if (c === "~") return { xml: `<mspace width="0.333em"/>` };
      if (c === "&") return { xml: `<mspace width="0.5em"/>` };
      return { xml: `<mtext>${escXML(c)}</mtext>` };
    }

    parseCommand() {
      const cmd = this.readCmd();
      if (!cmd) return { xml: "" };

      if (cmd === "\\") {
        return { xml: `<mspace linebreak="newline"/>` };
      }
      if (SPACES[cmd] !== undefined) {
        return { xml: `<mspace width="${SPACES[cmd]}"/>` };
      }
      if (cmd === "hspace" || cmd === "kern" || cmd === "mkern") {
        const w = this.readRawBrace().trim() || "0.5em";
        return { xml: `<mspace width="${escXML(w)}"/>` };
      }
      if (cmd === "displaystyle") { this.display = true; return this.parseBaseAtom() || { xml: "" }; }
      if (cmd === "textstyle" || cmd === "scriptstyle" || cmd === "scriptscriptstyle") {
        this.display = false;
        return this.parseBaseAtom() || { xml: "" };
      }

      if (cmd === "frac" || cmd === "dfrac" || cmd === "tfrac" || cmd === "cfrac") {
        const subDisp = cmd === "dfrac" || cmd === "cfrac";
        const num = this.parseGroup(subDisp);
        const den = this.parseGroup(subDisp);
        const xml = `<mfrac>${num}${den}</mfrac>`;
        return { xml: cmd === "dfrac" ? `<mstyle displaystyle="true">${xml}</mstyle>` : xml };
      }

      if (cmd === "binom" || cmd === "dbinom" || cmd === "tbinom") {
        const top = this.parseGroup(false);
        const bot = this.parseGroup(false);
        return { xml: `<mrow><mo stretchy="true">(</mo><mfrac linethickness="0">${top}${bot}</mfrac><mo stretchy="true">)</mo></mrow>` };
      }

      if (cmd === "sqrt") {
        const root = this.readBracketOpt();
        const body = this.parseGroup(false);
        if (root !== null && root.trim()) {
          const rXml = new Parser(root, false).parseRow();
          return { xml: `<mroot>${body}${rXml}</mroot>` };
        }
        return { xml: `<msqrt>${body}</msqrt>` };
      }

      if (ACCENTS[cmd]) {
        const acc = ACCENTS[cmd];
        const target = this.parseGroup(false);
        const mo = `<mo stretchy="${acc.stretchy ? "true" : "false"}">${escXML(acc.ch)}</mo>`;
        const xml = acc.over
          ? `<mover accent="true">${target}${mo}</mover>`
          : `<munder>${target}${mo}</munder>`;
        return { xml, movable: Boolean(acc.movable) };
      }

      if (cmd === "overset" || cmd === "stackrel") {
        const top = this.parseGroup(false);
        const base = this.parseGroup(this.display);
        return { xml: `<mover>${base}${top}</mover>` };
      }
      if (cmd === "underset") {
        const bot = this.parseGroup(false);
        const base = this.parseGroup(this.display);
        return { xml: `<munder>${base}${bot}</munder>` };
      }
      if (cmd === "mathop") {
        const body = this.parseGroup(this.display);
        return { xml: body, movable: true };
      }
      if (cmd === "boxed") {
        const body = this.parseGroup(this.display);
        return { xml: `<menclose notation="box"><mpadded width="+0.4em" height="+0.2em" depth="+0.2em" lspace="0.2em">${body}</mpadded></menclose>` };
      }
      if (cmd === "color" || cmd === "textcolor") {
        const col = this.readRawBrace().trim();
        const body = this.parseGroup(this.display);
        return { xml: `<mstyle mathcolor="${escXML(col)}">${body}</mstyle>` };
      }
      if (cmd === "phantom" || cmd === "hphantom" || cmd === "vphantom") {
        const body = this.parseGroup(false);
        return { xml: `<mphantom>${body}</mphantom>` };
      }
      if (cmd === "tag" || cmd === "tag*") {
        const tagTxt = this.readRawBrace().trim();
        return { xml: `<mspace width="1.2em"/><mtext>(${escXML(tagTxt)})</mtext>` };
      }

      if (cmd === "left") {
        const leftD = this.readDelimToken();
        const inner = this.parseRow("\\right");
        let rightD = "";
        if (this.s.startsWith("\\right", this.i)) {
          this.i += 6;
          rightD = this.readDelimToken();
        }
        const lMo = leftD ? `<mo stretchy="true">${escXML(leftD)}</mo>` : "";
        const rMo = rightD ? `<mo stretchy="true">${escXML(rightD)}</mo>` : "";
        return { xml: `<mrow>${lMo}${inner}${rMo}</mrow>` };
      }

      if (/^[Bb]igg?[lr]?$/.test(cmd)) {
        const d = this.readDelimToken();
        const sz = cmd.toLowerCase().startsWith("bigg") ? "2.1em" : "1.45em";
        return { xml: d ? `<mo minsize="${sz}" maxsize="${sz}" stretchy="true">${escXML(d)}</mo>` : `<mrow></mrow>` };
      }

      if (cmd === "begin") {
        const env = this.readRawBrace().trim();
        return { xml: this.parseEnvironment(env) };
      }

      if (cmd === "text" || cmd === "textrm" || cmd === "textbf" || cmd === "textit" || cmd === "textsf" || cmd === "texttt" || cmd === "mbox") {
        const raw = this.readRawBrace();
        const st = cmd === "textbf" ? ` style="font-weight:650"` : cmd === "textit" ? ` style="font-style:italic"` : "";
        return { xml: `<mtext${st}>${escXML(raw)}</mtext>` };
      }

      if (cmd === "operatorname" || cmd === "operatorname*") {
        const raw = this.readRawBrace().trim();
        return { xml: `<mi mathvariant="normal">${escXML(raw)}</mi>`, movable: cmd === "operatorname*" };
      }

      if (cmd === "mathbb") {
        const raw = this.readRawBrace().trim();
        return { xml: `<mi>${escXML(mapAlphabet(raw, BB_MAP))}</mi>` };
      }
      if (cmd === "mathcal" || cmd === "mathscr") {
        const raw = this.readRawBrace().trim();
        return { xml: `<mi>${escXML(mapAlphabet(raw, CAL_MAP))}</mi>` };
      }
      if (cmd === "mathrm" || cmd === "rm") {
        const raw = this.readRawBrace().trim();
        return { xml: `<mi mathvariant="normal">${escXML(raw)}</mi>` };
      }
      if (cmd === "mathbf" || cmd === "bf" || cmd === "bm" || cmd === "boldsymbol") {
        const raw = this.readRawBrace().trim();
        const inner = raw.startsWith("\\") ? GREEK[raw.slice(1)] || raw : raw;
        return { xml: `<mi mathvariant="bold">${escXML(inner)}</mi>` };
      }
      if (cmd === "mathsf") {
        const raw = this.readRawBrace().trim();
        return { xml: `<mi mathvariant="sans-serif">${escXML(raw)}</mi>` };
      }
      if (cmd === "mathtt") {
        const raw = this.readRawBrace().trim();
        return { xml: `<mi mathvariant="monospace">${escXML(raw)}</mi>` };
      }
      if (cmd === "mathit") {
        const raw = this.readRawBrace().trim();
        return { xml: `<mi mathvariant="italic">${escXML(raw)}</mi>` };
      }

      if (cmd === "not") {
        this.skipWS();
        if (this.s[this.i] === "=") { this.i++; return { xml: `<mo>≠</mo>` }; }
        if (this.s.startsWith("\\in", this.i)) { this.i += 3; return { xml: `<mo>∉</mo>` }; }
        if (this.s.startsWith("\\equiv", this.i)) { this.i += 6; return { xml: `<mo>≢</mo>` }; }
        const next = this.parseBaseAtom();
        return { xml: next ? `<mover>${next.xml}<mo>/</mo></mover>` : `<mo>¬</mo>` };
      }

      if (BIG_OPS[cmd]) {
        const op = BIG_OPS[cmd];
        return { xml: `<mo largeop="true" movablelimits="${op.movable ? "true" : "false"}">${op.ch}</mo>`, movable: op.movable };
      }

      if (FUNC_NAMES.has(cmd)) {
        // Check if followed by an identifier/operator so `\arg\max_d` gets proper thin operator spacing!
        const save = this.i;
        this.skipWS();
        const nextCh = this.s[this.i] || "";
        const followedByWord = /[A-Za-z0-9\\]/.test(nextCh) && nextCh !== "_" && nextCh !== "^";
        this.i = save;
        const mi = `<mi mathvariant="normal">${escXML(cmd)}</mi>`;
        const movable = MOVABLE_FUNCS.has(cmd);
        if (followedByWord && !movable) {
          return { xml: `<mrow>${mi}<mspace width="0.167em"/></mrow>`, movable: false };
        }
        return { xml: mi, movable };
      }

      if (GREEK[cmd]) {
        const isUpper = /^[A-Z]/.test(cmd);
        return { xml: `<mi${isUpper ? ` mathvariant="normal"` : ""}>${GREEK[cmd]}</mi>` };
      }

      if (OPS[cmd]) {
        return { xml: `<mo>${OPS[cmd]}</mo>` };
      }

      if (DELIMS["\\" + cmd] !== undefined) {
        const d = DELIMS["\\" + cmd];
        return { xml: d ? `<mo stretchy="false">${escXML(d)}</mo>` : `<mrow></mrow>` };
      }

      if (cmd === "%" || cmd === "#" || cmd === "&" || cmd === "_" || cmd === "$") {
        return { xml: `<mtext>${escXML(cmd)}</mtext>` };
      }

      return { xml: `<mi mathvariant="normal">${escXML(cmd)}</mi>` };
    }

    parseEnvironment(env) {
      const endTag = `\\end{${env}}`;
      let depth = 1, pos = this.i;
      const beginTag = `\\begin{${env}}`;
      while (pos < this.n && depth > 0) {
        if (this.s.startsWith(beginTag, pos)) {
          depth++;
          pos += beginTag.length;
        } else if (this.s.startsWith(endTag, pos)) {
          depth--;
          if (depth === 0) break;
          pos += endTag.length;
        } else {
          pos++;
        }
      }
      let body = this.s.slice(this.i, pos);
      if (this.s.startsWith(endTag, pos)) {
        this.i = pos + endTag.length;
      } else {
        this.i = this.n;
      }

      // Optional column spec for `array`: `{ccc}`
      if (env === "array") {
        const trimmed = body.trimStart();
        if (trimmed.startsWith("{")) {
          const p = new Parser(trimmed, false);
          p.readRawBrace();
          body = trimmed.slice(p.i);
        }
      }

      const rawRows = splitLaTeXRows(body);
      const isAlign = /^(?:align\*?|aligned|split)$/.test(env);
      const mtr = rawRows
        .filter((r, idx) => r.trim() !== "" || idx < rawRows.length - 1)
        .map((rowStr) => {
          const cols = splitLaTeXCols(rowStr);
          const mtds = cols.map((colStr, cIdx) => {
            const cellXml = new Parser(colStr.trim(), env === "cases" || isAlign ? this.display : false).parseRow();
            let alignStyle = "";
            if (env === "cases" || env === "rcases") alignStyle = ` style="text-align:left"`;
            else if (isAlign) alignStyle = cIdx % 2 === 0 ? ` style="text-align:right"` : ` style="text-align:left;padding-left:0.2em"`;
            return `<mtd${alignStyle}>${cellXml}</mtd>`;
          }).join("");
          return `<mtr>${mtds}</mtr>`;
        }).join("");

      const table = `<mtable rowspacing="0.45ex" columnspacing="0.8em">${mtr}</mtable>`;
      if (env === "pmatrix") return `<mrow><mo stretchy="true">(</mo>${table}<mo stretchy="true">)</mo></mrow>`;
      if (env === "bmatrix") return `<mrow><mo stretchy="true">[</mo>${table}<mo stretchy="true">]</mo></mrow>`;
      if (env === "Bmatrix") return `<mrow><mo stretchy="true">{</mo>${table}<mo stretchy="true">}</mo></mrow>`;
      if (env === "vmatrix") return `<mrow><mo stretchy="true">|</mo>${table}<mo stretchy="true">|</mo></mrow>`;
      if (env === "Vmatrix") return `<mrow><mo stretchy="true">‖</mo>${table}<mo stretchy="true">‖</mo></mrow>`;
      if (env === "cases") return `<mrow><mo stretchy="true">{</mo>${table}</mrow>`;
      if (env === "rcases") return `<mrow>${table}<mo stretchy="true">}</mo></mrow>`;
      return table;
    }
  }

  function wrapMrow(items) {
    if (items.length === 0) return "<mrow></mrow>";
    if (items.length === 1) return items[0];
    return `<mrow>${items.join("")}</mrow>`;
  }

  function splitLaTeXRows(s) {
    const rows = [];
    let cur = "", depth = 0, i = 0;
    while (i < s.length) {
      if (s.startsWith("\\begin{", i)) { depth++; cur += "\\begin{"; i += 7; continue; }
      if (s.startsWith("\\end{", i)) { if (depth > 0) depth--; cur += "\\end{"; i += 5; continue; }
      if (s[i] === "{") { depth++; cur += "{"; i++; continue; }
      if (s[i] === "}") { if (depth > 0) depth--; cur += "}"; i++; continue; }
      if (depth === 0 && s[i] === "\\" && s[i + 1] === "\\") {
        i += 2;
        if (s[i] === "*") i++;
        if (s[i] === "[") {
          while (i < s.length && s[i] !== "]") i++;
          if (s[i] === "]") i++;
        }
        rows.push(cur);
        cur = "";
        continue;
      }
      cur += s[i++];
    }
    rows.push(cur);
    return rows;
  }

  function splitLaTeXCols(s) {
    const cols = [];
    let cur = "", depth = 0, i = 0;
    while (i < s.length) {
      if (s[i] === "\\" && i + 1 < s.length) {
        cur += s[i] + s[i + 1];
        i += 2;
        continue;
      }
      if (s[i] === "{") depth++;
      else if (s[i] === "}" && depth > 0) depth--;
      else if (s[i] === "&" && depth === 0) {
        cols.push(cur);
        cur = "";
        i++;
        continue;
      }
      cur += s[i++];
    }
    cols.push(cur);
    return cols;
  }

  function renderMath(tex, display = false) {
    const clean = String(tex || "").trim();
    if (!clean) return "";
    try {
      const p = new Parser(clean, display);
      const body = p.parseRow();
      const dispAttr = display ? ` display="block"` : "";
      return `<math xmlns="http://www.w3.org/1998/Math/MathML"${dispAttr}>${body}</math>`;
    } catch {
      return `<code>${escXML(clean)}</code>`;
    }
  }

  // Extract display & inline math from raw Markdown text (after fenced codeblocks
  // have already been replaced by \u0000N\u0000, and BEFORE HTML-escaping).
  // - Display math (`\[...\]`, `$$...$$`, standalone `\begin{align|equation|gather}...`)
  //   is pushed into `blocks[]` (`\u0000N\u0000`).
  // - Inline code spans (`` `...` ``) are temporarily shielded so `$` / `\(` inside
  //   backticks are untouched.
  // - Inline math (`\(...\)` and `$...$`) is pushed into `inlines[]` (`\u0003N\u0003`).
  function extractMathSegments(rawText, pushBlock, pushInline, copyIcon = "") {
    if (!rawText || (!rawText.includes("\\") && !rawText.includes("$"))) return rawText;

    // 1. Temporarily shield inline code spans `` `...` `` so math delimiters inside code never trigger.
    const codeShield = [];
    let s = rawText.replace(/`[^`\n]+`/g, (m) => `\u0004${codeShield.push(m) - 1}\u0004`);

    const makeDisplayBlock = (tex) => {
      const raw = String(tex || "").trim();
      if (!raw) return "";
      const mathHTML = renderMath(raw, true);
      const copyBtn = copyIcon
        ? `<button type="button" class="math-copy" data-copy-tex="${escXML(raw)}" title="复制 LaTeX 公式">${copyIcon}</button>`
        : "";
      const idx = pushBlock(`<div class="math-block">${mathHTML}${copyBtn}</div>`);
      return `\n\u0000${idx}\u0000\n`;
    };

    const makeInlineSpan = (tex) => {
      const raw = String(tex || "").trim();
      if (!raw) return "";
      const mathHTML = renderMath(raw, false);
      const idx = pushInline(`<span class="math-inline" title="${escXML(raw)}">${mathHTML}</span>`);
      return `\u0003${idx}\u0003`;
    };

    // 2. Display math: `\[ ... \]` and `$$ ... $$` and standalone `\begin{equation|align|gather}...`
    s = s.replace(/\\\[([\s\S]*?)\\\]/g, (_, body) => makeDisplayBlock(body));
    s = s.replace(/\$\$([\s\S]*?)\$\$/g, (_, body) => makeDisplayBlock(body));
    s = s.replace(/\\begin\{(equation\*?|align\*?|gather\*?)\}([\s\S]*?)\\end\{\1\}/g, (full, env, body) => {
      return makeDisplayBlock(env.startsWith("align") ? `\\begin{aligned}${body}\\end{aligned}` : body);
    });

    // 3. Inline math: `\( ... \)`
    s = s.replace(/\\\(([^\n]+?)\\\)/g, (_, body) => makeInlineSpan(body));

    // 4. Inline math: `$ ... $` (strictly single-line, non-currency: no space after opening `$`
    //    or before closing `$`, not preceded/followed by ASCII word/digit/$)
    s = s.replace(/(?<![\\A-Za-z0-9$])\$(?!\s)([^\n$]*?(?<![\\\s]))\$(?![A-Za-z0-9$])/g, (full, body) => {
      // Skip pure plain multi-digit numbers with commas like `$1,000` (if paired accidentally)
      if (/^\d[\d,.]*$/.test(body) && body.length > 2) return full;
      return makeInlineSpan(body);
    });

    // 5. Restore inline code spans for normal Markdown inline processing.
    return s.replace(/\u0004(\d+)\u0004/g, (_, i) => codeShield[+i]);
  }

  window.CollieMath = { renderMath, extractMathSegments };
})();
