/* === Script text: edit text that deck scripts draw or generate === */
(function (global) {
  "use strict";

  // generative-workshop-deck decks draw text on p5 canvases ([data-p5]) and
  // build prompt cards / chips ([data-prompt], [data-chips]) from
  // window.PROMPTS. That text lives in string literals of the deck's inline
  // scripts, so it is edited there: locate the literals, show them in the
  // inspector, patch the script source and reload the deck.

  const CJK = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;
  const REGEX_AFTER_WORD = new Set(["return", "typeof", "case", "in", "of", "new", "delete",
    "void", "throw", "instanceof", "yield", "await", "else", "do"]);
  const OPS = [">>>=", "...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=",
    "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=",
    "%=", "&=", "|=", "^=", "**", "<<", ">>"];
  const PROMPT_FIELDS = { title: "標題", tag: "標籤", hint: "提示", text: "提示詞內容" };
  const MOUNTS = "[data-p5], [data-prompt], [data-chips]";

  // Minimal JS tokenizer: just enough to tell string literals apart from
  // comments, regexes and code, so a patch can never land outside a string.
  // str/tpl tokens carry [s, e) offsets of the literal's content (quotes
  // excluded); a template is split into chunks around each ${...}.
  function lex(src) {
    const toks = [];
    const stack = []; // "{" for blocks, "${" for template substitutions
    const n = src.length;
    let i = 0;

    function regexOk() {
      const p = toks[toks.length - 1];
      if (!p) return true;
      if (p.t === "p") return p.v !== ")" && p.v !== "]" && p.v !== "}";
      if (p.t === "w") return REGEX_AFTER_WORD.has(p.v);
      return false;
    }

    function template(head) {
      const s = i;
      while (i < n) {
        const c = src[i];
        if (c === "\\") { i += 2; continue; }
        if (c === "`") { toks.push({ t: "tpl", s, e: i, head, tail: true }); i++; return; }
        if (c === "$" && src[i + 1] === "{") {
          toks.push({ t: "tpl", s, e: i, head, tail: false });
          toks.push({ t: "p", v: "${" });
          stack.push("${");
          i += 2;
          return;
        }
        i++;
      }
      toks.push({ t: "tpl", s, e: n, head, tail: true });
    }

    while (i < n) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === "/" && src[i + 1] === "/") { const j = src.indexOf("\n", i); i = j < 0 ? n : j; continue; }
      if (c === "/" && src[i + 1] === "*") { const j = src.indexOf("*/", i + 2); i = j < 0 ? n : j + 2; continue; }
      if (c === '"' || c === "'") {
        const s = ++i;
        while (i < n && src[i] !== c && src[i] !== "\n") i += src[i] === "\\" ? 2 : 1;
        toks.push({ t: "str", q: c, s, e: Math.min(i, n) });
        i++;
        continue;
      }
      if (c === "`") { i++; template(true); continue; }
      if (c === "/" && regexOk()) {
        let cls = false;
        i++;
        while (i < n && src[i] !== "\n") {
          const d = src[i];
          if (d === "\\") { i += 2; continue; }
          if (d === "[") cls = true;
          else if (d === "]") cls = false;
          else if (d === "/" && !cls) break;
          i++;
        }
        i++;
        while (i < n && /[a-z]/i.test(src[i])) i++;
        toks.push({ t: "re" });
        continue;
      }
      if (/[A-Za-z_$\u0080-\uffff]/.test(c)) {
        const s = i;
        while (i < n && /[\w$\u0080-\uffff]/.test(src[i])) i++;
        toks.push({ t: "w", v: src.slice(s, i) });
        continue;
      }
      if (/[0-9]/.test(c)) {
        while (i < n && /[\w.]/.test(src[i])) i++;
        toks.push({ t: "num" });
        continue;
      }
      if (c === "{") { stack.push("{"); toks.push({ t: "p", v: "{" }); i++; continue; }
      if (c === "}") {
        i++;
        if (stack.pop() === "${") { toks.push({ t: "p", v: "}$" }); template(false); }
        else toks.push({ t: "p", v: "}" });
        continue;
      }
      const op = OPS.find(o => src.startsWith(o, i)) || c;
      toks.push({ t: "p", v: op });
      i += op.length;
    }
    return toks;
  }

  // Map each "{" / "${" token index to its closing token index.
  function matchBraces(toks) {
    const match = new Map();
    const open = [];
    toks.forEach((t, k) => {
      if (t.t !== "p") return;
      if (t.v === "{" || t.v === "${") open.push(k);
      else if ((t.v === "}" || t.v === "}$") && open.length) match.set(open.pop(), k);
    });
    return match;
  }

  const ESCAPES = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0",
    "\n": "", "\r\n": "", "\r": "", "\u2028": "", "\u2029": "" };

  function decodeJs(raw) {
    return raw.replace(/\\(u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|\r\n|[\s\S])/g,
      (m, all, cp, u4, x2) => {
        if (cp) return String.fromCodePoint(parseInt(cp, 16));
        if (u4) return String.fromCharCode(parseInt(u4, 16));
        if (x2) return String.fromCharCode(parseInt(x2, 16));
        return all in ESCAPES ? ESCAPES[all] : all;
      });
  }

  // Inverse of decodeJs for the literal's own quote style. "</script" and
  // "<!--" are broken up so the patched text can't end the <script> element.
  function encodeJs(value, tok) {
    let s = value.replace(/\\/g, "\\\\");
    if (tok.t === "tpl") s = s.replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
    else s = s.replace(/\r/g, "\\r").replace(/\n/g, "\\n").split(tok.q).join("\\" + tok.q);
    return s.replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")
      .replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
  }

  function item(src, tok, label) {
    return { s: tok.s, e: tok.e, t: tok.t, q: tok.q, label,
      partial: tok.t === "tpl" && !(tok.head && tok.tail),
      value: decodeJs(src.slice(tok.s, tok.e)) };
  }

  const isW = (toks, k, v) => !!toks[k] && toks[k].t === "w" && (v === undefined || toks[k].v === v);
  const isP = (toks, k, v) => !!toks[k] && toks[k].t === "p" && toks[k].v === v;

  // Text literals inside the last `SKETCHES.name = ...` (or alias, e.g.
  // `const S = window.SKETCHES; S.name = ...`) in this script, or null.
  function findSketch(src, name) {
    if (!src.includes("SKETCHES") || !src.includes(name)) return null;
    const toks = lex(src);
    const aliases = new Set(["SKETCHES"]);
    toks.forEach((t, k) => {
      if (!["const", "let", "var"].some(d => isW(toks, k, d)) || !isW(toks, k + 1) || !isP(toks, k + 2, "=")) return;
      let j = k + 3;
      if (isW(toks, j, "window") && isP(toks, j + 1, ".")) j += 2;
      if (isW(toks, j, "SKETCHES") && !isP(toks, j + 1, ".") && !isP(toks, j + 1, "[")) aliases.add(toks[k + 1].v);
    });
    let at = -1;
    toks.forEach((t, k) => {
      if (t.t !== "w" || !aliases.has(t.v)) return;
      let j = k + 1;
      if (isP(toks, j, ".") && isW(toks, j + 1, name)) j += 2;
      else if (isP(toks, j, "[") && toks[j + 1] && toks[j + 1].t === "str" &&
        decodeJs(src.slice(toks[j + 1].s, toks[j + 1].e)) === name && isP(toks, j + 2, "]")) j += 3;
      else return;
      if (isP(toks, j, "=")) at = j;
    });
    if (at < 0) return null;
    let open = at + 1;
    while (open < toks.length && !isP(toks, open, "{")) open++;
    const close = matchBraces(toks).get(open);
    if (close === undefined) return null;
    const found = toks.slice(open + 1, close)
      .filter(t => (t.t === "str" || t.t === "tpl") && CJK.test(src.slice(t.s, t.e)));
    return found.map((t, k) => item(src, t, "文字 " + (k + 1)));
  }

  // title / tag / hint / text of the prompt object whose `id` is `id`, or null.
  function findPrompt(src, id) {
    if (!src.includes(id)) return null;
    const toks = lex(src);
    const k = toks.findIndex((t, j) => t.t === "str" && isP(toks, j - 1, ":") && isW(toks, j - 2, "id") &&
      decodeJs(src.slice(t.s, t.e)) === id);
    if (k < 0) return null;
    const match = matchBraces(toks);
    let open = -1;
    for (let j = k - 1; j >= 0; j--) {
      if (isP(toks, j, "{") && match.get(j) > k) { open = j; break; }
    }
    if (open < 0) return null;
    const close = match.get(open);
    const items = [];
    let depth = 0;
    for (let j = open + 1; j < close; j++) {
      const t = toks[j];
      if (t.t === "p" && ["{", "${", "[", "("].includes(t.v)) depth++;
      else if (t.t === "p" && ["}", "}$", "]", ")"].includes(t.v)) depth--;
      else if (depth === 0 && t.t === "w" && PROMPT_FIELDS[t.v] && isP(toks, j + 1, ":")) {
        const v = toks[j + 2];
        const literal = v && (v.t === "str" || (v.t === "tpl" && v.head && v.tail));
        if (literal && (isP(toks, j + 3, ",") || j + 3 === close)) items.push(item(src, v, PROMPT_FIELDS[t.v]));
      }
    }
    return items;
  }

  function scripts() {
    const doc = Editor.state.deckDoc;
    return doc ? Array.from(doc.querySelectorAll("script:not([src])")) : [];
  }

  // Later definitions win at runtime, so the last matching script wins here.
  function locate(kind, key) {
    let hit = null;
    scripts().forEach(script => {
      const src = script.textContent;
      const items = kind === "p5" ? findSketch(src, key) : findPrompt(src, key);
      if (items) hit = { src, items };
    });
    return hit;
  }

  function showFor(el) {
    const mount = el.closest(MOUNTS);
    if (!mount) return;
    const kind = mount.hasAttribute("data-p5") ? "p5" : "prompt";
    const key = kind === "p5" ? mount.dataset.p5 : (mount.dataset.prompt || mount.dataset.chips);
    const hit = locate(kind, key);
    if (!hit) {
      Editor.toast(kind === "p5"
        ? `找不到畫布「${key}」的程式碼（可能在外部 .js 檔），請改原始檔`
        : `找不到提示詞「${key}」的資料（可能在外部 prompts.js），請改原始檔`, "warn");
      return;
    }
    if (!hit.items.length) {
      Editor.toast(`畫布「${key}」的程式裡沒有可編輯的中文文字`, "warn");
      return;
    }
    const attr = kind === "p5" ? "data-p5" : mount.hasAttribute("data-prompt") ? "data-prompt" : "data-chips";
    render(kind, key, hit, `[${attr}="${CSS.escape(key)}"]`, Editor.state.currentIndex);
  }

  function render(kind, key, hit, selector, slideIndex) {
    const panel = Editable.clearProps();
    panel.innerHTML = `
      <div class="target-tag"></div>
      <p class="hint" data-role="intro"></p>
      <div class="row" data-role="fields"></div>
      <button type="button" class="btn primary" data-role="apply">套用</button>
      <p class="hint">套用後簡報會重新載入，修改寫進簡報內的程式，存檔後保留。</p>
    `;
    panel.querySelector(".target-tag").textContent = (kind === "p5" ? "畫布文字 · " : "提示詞卡 · ") + key;

    let intro = kind === "p5"
      ? "這些文字由畫布程式繪製，依程式中的出現順序列出（不含純英文字串）。"
      : "提示詞卡的內容；下方標籤由「提示詞內容」裡的【】自動產生。";
    if (kind === "p5") {
      const pages = Slides.detectSlides(Editor.state.deckDoc)
        .map((s, n) => s.querySelector(selector) ? n + 1 : 0).filter(Boolean);
      if (pages.length > 1) intro += `這個畫布也用在第 ${pages.join("、")} 頁，修改會一起變更。`;
    }
    if (hit.items.some(it => it.partial)) intro += "標示「片段」的欄位夾在程式變數之間，只能改固定文字。";
    panel.querySelector('[data-role="intro"]').textContent = intro;

    const fields = panel.querySelector('[data-role="fields"]');
    const inputs = hit.items.map(it => {
      const field = document.createElement("label");
      field.className = "field";
      const span = document.createElement("span");
      span.textContent = it.label + (it.partial ? "（片段）" : "");
      const long = it.value.length > 40 || it.value.includes("\n");
      const input = document.createElement(long ? "textarea" : "input");
      if (!long) input.type = "text";
      if (long) input.rows = Math.min(14, it.value.split("\n").length + 1);
      input.value = it.value;
      field.append(span, input);
      fields.appendChild(field);
      return input;
    });
    panel.querySelector('[data-role="apply"]').addEventListener("click", () => {
      apply(hit, inputs.map(x => x.value), selector, slideIndex);
    });
  }

  function apply(hit, values, selector, slideIndex) {
    const changed = hit.items.map((it, k) => [it, values[k]]).filter(([it, v]) => v !== it.value);
    if (!changed.length) { Editor.toast("文字沒有變更", "warn"); return; }
    const findScript = () => scripts().find(s => s.textContent === hit.src);
    if (!findScript()) { Editor.toast("簡報程式已變更，請重新點選後再修改", "err"); return; }
    History.push();
    Editor.syncDeckFromIframe();
    const script = findScript();
    if (!script) { Editor.toast("同步後找不到簡報程式，未套用", "err"); return; }
    // Patch from the end so earlier offsets stay valid.
    script.textContent = changed.slice().sort((a, b) => b[0].s - a[0].s)
      .reduce((text, [it, v]) => text.slice(0, it.s) + encodeJs(v, it) + text.slice(it.e), hit.src);
    Editor.markDirty();
    Slides.reloadFrame(() => {
      Slides.rebuild();
      const slide = Slides.detectSlides(Editor.ui.deckFrame.contentDocument)[slideIndex];
      const again = slide && slide.querySelector(selector);
      if (again) showFor(again);
    });
    Editor.toast(`已更新 ${changed.length} 處文字`, "ok");
  }

  global.ScriptText = { showFor, MOUNTS };

})(window);
