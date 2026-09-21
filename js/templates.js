/* === Template library: list, insert, extract (with CSS scoping + JS heuristic) === */
(function (global) {
  "use strict";

  const FRAMEWORK_CLASSES = new Set([
    "slide", "slide-inner", "active", "cover", "section",
    "deck", "app", "hidden",
  ]);

  let cache = [];

  const STORAGE_KEY = "clickdeckpro_templates";

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
    } catch (e) {
      Editor.toast("樣板儲存失敗（瀏覽器空間可能已滿）", "err");
    }
  }

  // Static build: templates live in the browser's localStorage instead of the
  // Python server. On the first visit (no stored key) seed the library with the
  // bundled starter templates; once the key exists we respect it, so deleting
  // every template stays sticky and won't re-seed on the next reload.
  async function loadAll() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === null) {
        cache = (window.STARTER_TEMPLATES || []).slice();
        persist();
      } else {
        cache = JSON.parse(raw) || [];
      }
    } catch (e) {
      cache = [];
    }
    return cache;
  }

  function openPicker(mode) {
    const modal = document.getElementById("template-modal");
    modal.dataset.mode = mode;
    document.getElementById("template-modal-title").textContent =
      mode === "insert" ? "選擇要插入的樣板" : "樣板庫";
    renderGallery();
    modal.classList.remove("hidden");
  }

  function renderGallery() {
    const gallery = document.getElementById("template-gallery");
    gallery.innerHTML = "";
    if (!cache.length) {
      gallery.innerHTML = '<div class="tpl-empty">樣板庫是空的。先開一份簡報，按「存為樣板」把投影片加入樣板庫。</div>';
      return;
    }
    cache.forEach(tpl => {
      const card = document.createElement("div");
      card.className = "tpl-card";
      card.innerHTML = `
        <div class="tpl-thumb"><div class="tpl-thumb-frame"></div></div>
        <button class="tpl-del" title="刪除此樣板">刪除</button>
        <div class="tpl-meta">
          <div class="tpl-name">${escapeHtml(tpl.name || tpl.id)}</div>
          <div class="tpl-cat">${escapeHtml(tpl.category || "")}</div>
        </div>
      `;
      renderTemplatePreview(card.querySelector(".tpl-thumb-frame"), tpl);
      card.addEventListener("click", (e) => {
        if (e.target.classList.contains("tpl-del")) return;
        insertTemplate(tpl);
        document.getElementById("template-modal").classList.add("hidden");
      });
      card.querySelector(".tpl-del").addEventListener("click", (e) => {
        e.stopPropagation();
        if (confirm(`刪除樣板「${tpl.name}」？`)) {
          deleteTemplate(tpl.id);
        }
      });
      gallery.appendChild(card);
    });
  }

  function renderTemplatePreview(frame, tpl) {
    const container = document.createElement("div");
    container.style.cssText = "position:absolute;inset:0;background:#fff;overflow:hidden;";
    const style = document.createElement("style");
    // Scoped like the real insertion — an unscoped `.slide { … }` or
    // `body { … }` rule here would restyle the editor UI itself, because
    // this <style> lives in the editor document, not in an iframe.
    style.textContent = scopeTemplateCss(tpl.css || "", tpl.id);
    container.appendChild(style);
    const wrap = document.createElement("div");
    wrap.innerHTML = tpl.html || "";
    const slide = wrap.firstElementChild;
    if (slide) {
      slide.setAttribute(SCOPE_ATTR, tpl.id);
      slide.style.position = "absolute";
      slide.style.inset = "0";
      slide.style.width = "1920px";
      slide.style.height = "1080px";
      slide.style.display = "flex";
      slide.style.opacity = "1";
      slide.style.transform = "none";
      slide.style.filter = "none";
      slide.classList.add("active");
      container.appendChild(slide);
    }
    frame.appendChild(container);
    requestAnimationFrame(() => {
      const rect = frame.parentElement.getBoundingClientRect();
      const scale = Math.min(rect.width / 1920, rect.height / 1080);
      frame.style.transform = `scale(${scale})`;
    });
  }

  // === Template CSS scoping ============================================
  // Historic bug: template CSS is injected into <head> verbatim. Saved
  // templates keep framework selectors (.slide, .slide.active, .slide h1 …)
  // un-renamed, so inserting one restyled EVERY page of the destination deck.
  // Fix: stamp the inserted slide with data-tpl-scope="<tpl.id>" and rewrite
  // each selector so it only applies inside that slide.
  //
  // Every selector is emitted in two scoped variants joined with a comma:
  //   root form:        .slide.active            -> .slide.active:where([data-tpl-scope="id"])
  //   descendant form:  .slide.active            -> :where([data-tpl-scope="id"]) .slide.active
  // Their union covers "the stamped slide itself + anything inside it" without
  // needing to know which compounds can match the root — a variant that can't
  // match is simply dead. `:where()` carries zero specificity, so every
  // original specificity relationship (template rules vs. the destination
  // deck's own stylesheet) is preserved exactly.
  // html / body / :root selectors are re-rooted onto the slide instead — the
  // slide's ancestors are outside the scope by definition.

  const SCOPE_ATTR = TemplateHost.SCOPE_ATTR;

  function scopeSelectorPart(sel, scopeSel) {
    sel = sel.trim();
    if (!sel) return "";
    // Leading html / body / :root token → the stamped slide takes its place.
    const rootedRe = /^(html|body|:root)(?![\w-])/i;
    if (rootedRe.test(sel)) {
      return sel.replace(rootedRe, scopeSel);
    }
    // First compound = selector up to the first top-level combinator.
    let depth = 0, cut = sel.length;
    for (let i = 0; i < sel.length; i++) {
      const ch = sel[i];
      if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth--;
      else if (depth === 0 && (ch === " " || ch === "\t" || ch === ">" || ch === "+" || ch === "~")) {
        cut = i;
        break;
      }
    }
    const compound = sel.slice(0, cut);
    const rest = sel.slice(cut);
    // Attach :where(scope) to the compound, but before any pseudo-element
    // (`.a::before` must become `.a:where(...)::before`).
    const pe = compound.search(/::|:(?:before|after|first-line|first-letter)(?![\w-])/i);
    const rootForm = pe >= 0
      ? compound.slice(0, pe) + `:where(${scopeSel})` + compound.slice(pe) + rest
      : compound + `:where(${scopeSel})` + rest;
    const descForm = `:where(${scopeSel}) ` + sel;
    return rootForm + ", " + descForm;
  }

  function scopeSelectorText(selectorText, scopeSel) {
    // Split the selector list on top-level commas only (`:is(.a, .b)` stays whole).
    const parts = [];
    let depth = 0, cur = "";
    for (const ch of selectorText) {
      if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth--;
      if (ch === "," && depth === 0) { parts.push(cur); cur = ""; }
      else cur += ch;
    }
    parts.push(cur);
    return parts.map(p => scopeSelectorPart(p, scopeSel)).filter(Boolean).join(", ");
  }

  function scopeRuleList(ruleList, scopeSel, out) {
    for (const rule of Array.from(ruleList)) {
      if (rule.type === CSSRule.STYLE_RULE) {
        const newSel = scopeSelectorText(rule.selectorText, scopeSel);
        out.push(rule.cssText.replace(/^[^{]+/, newSel + " "));
      } else if (rule.type === CSSRule.MEDIA_RULE || rule.type === CSSRule.SUPPORTS_RULE) {
        const inner = [];
        scopeRuleList(rule.cssRules, scopeSel, inner);
        if (inner.length) {
          const cond = rule.media ? rule.media.mediaText : rule.conditionText;
          out.push((rule.type === CSSRule.MEDIA_RULE ? "@media " : "@supports ") + cond + " {\n" + inner.join("\n") + "\n}");
        }
      } else {
        // @keyframes / @font-face / anything else: pass through untouched —
        // keyframes are already renamed per-template at save time.
        out.push(rule.cssText);
      }
    }
  }

  function scopeTemplateCss(cssText, tplId) {
    if (!cssText || !cssText.trim()) return cssText || "";
    const scopeSel = `[${SCOPE_ATTR}="${tplId}"]`;
    // Parse with the browser's own CSS parser via a never-applied probe sheet
    // (media="not all") — regex-only parsing would mangle @keyframes blocks.
    const probe = document.createElement("style");
    probe.media = "not all";
    probe.textContent = cssText;
    document.head.appendChild(probe);
    try {
      const sheet = probe.sheet;
      if (!sheet || !sheet.cssRules) return cssText;
      const out = [];
      scopeRuleList(sheet.cssRules, scopeSel, out);
      return out.join("\n");
    } catch (e) {
      // Parsing failed (shouldn't happen for same-document inline sheets) —
      // fall back to the unscoped CSS rather than dropping styles entirely.
      return cssText;
    } finally {
      probe.remove();
    }
  }

  // Legacy repair: decks that already contain an UNSCOPED __tpl_style_<id>__
  // block (inserted before scoping existed) get it swapped for the scoped
  // version. Existing instances of the template in the deck must then carry
  // the scope attribute or they'd lose their styling — identify them by the
  // template's unique (prefix-renamed) class tokens.
  function stampLegacyTemplateInstances(doc, tpl) {
    const probe = document.createElement("div");
    probe.innerHTML = tpl.html || "";
    const tokens = new Set();
    probe.querySelectorAll("*").forEach(el => {
      if (el.classList) el.classList.forEach(c => { if (!FRAMEWORK_CLASSES.has(c)) tokens.add(c); });
    });
    if (!tokens.size) return 0;
    let stamped = 0;
    Slides.detectSlides(doc).forEach(slide => {
      if (slide.getAttribute(SCOPE_ATTR)) return;
      const hit = [...tokens].some(t =>
        (slide.classList && slide.classList.contains(t)) ||
        slide.querySelector("." + (window.CSS && CSS.escape ? CSS.escape(t) : t)));
      if (hit) {
        slide.setAttribute(SCOPE_ATTR, tpl.id);
        stamped++;
      }
    });
    return stamped;
  }

  function templateStyleId(tplId) {
    return `__tpl_style_${tplId}__`;
  }

  // Manual repair entry: re-run the adaptation over every template page and
  // template style block already in the deck (pages inserted before this
  // adaptation existed). Returns how many of each actually changed.
  function adaptExistingTemplateSlides(doc) {
    const result = { slides: 0, styles: 0 };
    if (!doc || !doc.body) return result;
    const host = TemplateHost.getProfile(doc);
    if (!host) return result;

    const roots = {};
    Slides.detectSlides(doc).forEach(slide => {
      const tplId = slide.getAttribute(SCOPE_ATTR);
      if (!tplId) return;
      const before = slide.outerHTML;
      const root = TemplateHost.adaptRoot(slide, host, doc);
      if (root.outerHTML !== before) result.slides++;
      if (!roots[tplId]) roots[tplId] = root;
    });

    doc.querySelectorAll('style[id^="__tpl_style_"]').forEach(style => {
      const m = /^__tpl_style_(.+)__$/.exec(style.id);
      if (!m || !roots[m[1]]) return;
      const tplId = m[1];
      const tpl = cache.find(t => t.id === tplId);
      let scoped = style.textContent;
      if (scoped.indexOf(`[${SCOPE_ATTR}="${tplId}"]`) < 0) {
        // Legacy unscoped block: scope it first (same path as insertTemplate).
        scoped = scopeTemplateCss(tpl ? tpl.css : scoped, tplId);
      }
      const adapted = TemplateHost.adaptCss(scoped, roots[tplId], tplId, host);
      if (adapted !== style.textContent) {
        style.textContent = adapted;
        result.styles++;
      }
    });
    return result;
  }

  async function deleteTemplate(id) {
    cache = cache.filter(t => t.id !== id);
    persist();
    renderGallery();
    Editor.toast("已刪除樣板", "ok");
  }

  function insertTemplate(tpl) {
    const st = Editor.state;
    if (!st.deckDoc) return;
    // Single History push for the whole template insertion (CSS + JS + HTML).
    // We also sync iframe edits into deckDoc BEFORE touching deckDoc so those
    // edits are preserved after the upcoming reload.
    History.push();
    Editor.syncDeckFromIframe();
    const doc = st.deckDoc;
    const host = TemplateHost.getProfile(doc);

    const wrap = doc.createElement("div");
    wrap.innerHTML = tpl.html;
    let slide = wrap.firstElementChild;
    if (!slide) {
      Editor.toast("樣板 HTML 為空", "err");
      return;
    }
    // The scope stamp: the scoped CSS below only applies inside elements
    // carrying this attribute, so the template can never restyle other pages.
    slide.setAttribute(SCOPE_ATTR, tpl.id);
    slide = TemplateHost.adaptRoot(slide, host, doc);

    if (tpl.css) {
      const styleId = templateStyleId(tpl.id);
      const scopedCss = TemplateHost.adaptCss(scopeTemplateCss(tpl.css, tpl.id), slide, tpl.id, host);
      const existing = doc.getElementById(styleId);
      if (!existing) {
        const style = doc.createElement("style");
        style.id = styleId;
        style.textContent = scopedCss;
        doc.head.appendChild(style);
      } else {
        if (existing.textContent.indexOf(`[${SCOPE_ATTR}="${tpl.id}"]`) < 0) {
          // Same template was inserted before scoping existed: its old style
          // block still leaks into every page. Stamp the already-present
          // instances first so they keep their look before the swap below.
          stampLegacyTemplateInstances(doc, tpl);
        }
        // Always refresh: the block is regenerated from the template source,
        // so an instance inserted before host adaptation existed picks it up.
        existing.textContent = scopedCss;
      }
    }

    if (tpl.js) {
      const scriptId = `__tpl_script_${tpl.id}__`;
      if (!doc.getElementById(scriptId)) {
        const script = doc.createElement("script");
        script.id = scriptId;
        script.textContent = tpl.js;
        doc.body.appendChild(script);
      }
    }

    const slides = Slides.detectSlides(doc);
    const at = st.currentIndex >= 0 ? st.currentIndex : slides.length - 1;
    if (!slides.length) {
      const container = doc.querySelector(".deck, .app, #deck, #app, body");
      container.appendChild(slide);
    } else {
      const anchor = slides[Math.min(at, slides.length - 1)];
      anchor.parentNode.insertBefore(slide, anchor.nextSibling);
    }
    Editor.markDirty();
    Slides.reloadFrame(() => {
      st.currentIndex = at + 1;
      Slides.rebuild();
    });
    Editor.toast("已插入樣板：" + tpl.name, "ok");
  }

  // === Save-as-template flow === //

  function openSaveAsTemplate() {
    const st = Editor.state;
    if (st.currentIndex < 0 || !st.slides[st.currentIndex]) {
      Editor.toast("請先選擇一張投影片", "err");
      return;
    }
    document.getElementById("tpl-name").value = "";
    document.getElementById("tpl-category").value = "content";
    document.getElementById("tpl-extract-css").checked = true;
    document.getElementById("tpl-extract-js").checked = true;

    updateExtractPreview();
    document.getElementById("tpl-extract-css").onchange = updateExtractPreview;
    document.getElementById("tpl-extract-js").onchange = updateExtractPreview;
    document.getElementById("tpl-confirm-save").onclick = confirmSaveTemplate;
    document.getElementById("save-template-modal").classList.remove("hidden");
  }

  function updateExtractPreview() {
    const st = Editor.state;
    const slide = st.slides[st.currentIndex];
    if (!slide) return;
    const extractCss = document.getElementById("tpl-extract-css").checked;
    const extractJs = document.getElementById("tpl-extract-js").checked;

    const analysis = analyzeSlide(slide, st.deckDoc, { extractCss, extractJs });
    const preview = document.getElementById("tpl-extract-preview");
    preview.innerHTML = `
      <div><strong>偵測到的類別：</strong> ${analysis.classNames.length} 個
        （將重新命名 ${analysis.toRename.length} 個，保留框架類 ${analysis.keepFramework.length} 個）</div>
      <div><strong>抽取的 CSS 規則：</strong> ${analysis.cssRuleCount} 條</div>
      <div><strong>抽取的關鍵影格：</strong> ${analysis.keyframes.length} 個</div>
      <div><strong>可能相關的 JS 區塊：</strong> ${analysis.jsBlocks.length} 個
        ${analysis.jsBlocks.length ? '<span style="color:#D45B07">（需確認是否納入）</span>' : ''}
      </div>
    `;
  }

  async function confirmSaveTemplate() {
    const st = Editor.state;
    const slide = st.slides[st.currentIndex];
    const name = document.getElementById("tpl-name").value.trim();
    if (!name) {
      Editor.toast("請輸入樣板名稱", "err");
      return;
    }
    const category = document.getElementById("tpl-category").value;
    const extractCss = document.getElementById("tpl-extract-css").checked;
    const extractJs = document.getElementById("tpl-extract-js").checked;

    const tpl = buildTemplate(slide, st.deckDoc, { name, category, extractCss, extractJs });
    cache = cache.filter(t => t.id !== tpl.id);
    cache.push(tpl);
    persist();
    Editor.toast("已存入樣板庫：" + name, "ok");
    document.getElementById("save-template-modal").classList.add("hidden");
  }

  // === Core extraction logic === //

  function slugify(s) {
    return String(s).toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "tpl";
  }

  function analyzeSlide(slide, doc, opts) {
    const classNames = collectClasses(slide);
    const idNames = collectIds(slide);
    const toRename = classNames.filter(c => !FRAMEWORK_CLASSES.has(c));
    const keepFramework = classNames.filter(c => FRAMEWORK_CLASSES.has(c));

    let cssRuleCount = 0;
    let keyframes = [];
    if (opts.extractCss) {
      const result = collectRelevantCss(doc, new Set([...toRename, ...keepFramework]), new Set(idNames));
      cssRuleCount = result.ruleCount;
      keyframes = result.keyframes;
    }

    let jsBlocks = [];
    if (opts.extractJs) {
      jsBlocks = collectRelevantJs(doc, new Set(toRename), new Set(idNames));
    }

    return { classNames, idNames, toRename, keepFramework, cssRuleCount, keyframes, jsBlocks };
  }

  function collectClasses(root) {
    const set = new Set();
    const walk = (el) => {
      if (el.classList) el.classList.forEach(c => set.add(c));
      Array.from(el.children).forEach(walk);
    };
    walk(root);
    return Array.from(set);
  }

  function collectIds(root) {
    const ids = [];
    if (root.id) ids.push(root.id);
    root.querySelectorAll("[id]").forEach(el => ids.push(el.id));
    return ids;
  }

  function collectRelevantCss(doc, classSet, idSet) {
    const rules = [];
    const keyframes = [];
    let ruleCount = 0;
    const sheets = Array.from(doc.styleSheets);
    for (const sheet of sheets) {
      let cssRules;
      try {
        cssRules = sheet.cssRules;
      } catch (e) { continue; }
      if (!cssRules) continue;
      walkRules(cssRules, classSet, idSet, rules, keyframes);
      ruleCount = rules.length;
    }
    return { rules, keyframes, ruleCount };
  }

  function walkRules(ruleList, classSet, idSet, outRules, outKeyframes) {
    for (const rule of Array.from(ruleList)) {
      if (rule.type === CSSRule.STYLE_RULE) {
        if (selectorMatches(rule.selectorText, classSet, idSet)) {
          outRules.push(rule.cssText);
        }
      } else if (rule.type === CSSRule.MEDIA_RULE || rule.type === CSSRule.SUPPORTS_RULE) {
        const inner = [];
        walkRules(rule.cssRules, classSet, idSet, inner, outKeyframes);
        if (inner.length) {
          const condition = rule.media ? rule.media.mediaText : rule.conditionText;
          const wrapper = rule.type === CSSRule.MEDIA_RULE
            ? `@media ${condition}{${inner.join("")}}`
            : `@supports ${condition}{${inner.join("")}}`;
          outRules.push(wrapper);
        }
      } else if (rule.type === CSSRule.KEYFRAMES_RULE) {
        outKeyframes.push(rule.cssText);
      }
    }
  }

  function selectorMatches(selectorText, classSet, idSet) {
    const classRegex = /\.([a-zA-Z_][\w-]*)/g;
    const idRegex = /#([a-zA-Z_][\w-]*)/g;
    let m;
    while ((m = classRegex.exec(selectorText))) {
      if (classSet.has(m[1])) return true;
    }
    while ((m = idRegex.exec(selectorText))) {
      if (idSet.has(m[1])) return true;
    }
    return false;
  }

  function collectRelevantJs(doc, classSet, idSet) {
    const blocks = [];
    const scripts = doc.querySelectorAll("script");
    scripts.forEach((s, i) => {
      if (s.src) return;
      const text = s.textContent || "";
      if (!text.trim()) return;
      let hit = false;
      for (const c of classSet) {
        if (text.indexOf("'" + c + "'") >= 0 || text.indexOf('"' + c + '"') >= 0 ||
            text.indexOf("." + c) >= 0) { hit = true; break; }
      }
      if (!hit) {
        for (const id of idSet) {
          if (text.indexOf("'" + id + "'") >= 0 || text.indexOf('"' + id + '"') >= 0 ||
              text.indexOf("#" + id) >= 0) { hit = true; break; }
        }
      }
      // Exclude obvious global navigation scripts (heuristic: contain "keydown" + "ArrowRight")
      if (hit && /ArrowRight|ArrowLeft/.test(text) && /keydown/.test(text)) hit = false;
      if (hit) blocks.push(text);
    });
    return blocks;
  }

  function buildTemplate(slide, doc, { name, category, extractCss, extractJs }) {
    const slug = slugify(name) + "-" + Date.now().toString(36);
    const prefix = `tpl_${slug}_`;
    const classNames = collectClasses(slide);
    const idNames = collectIds(slide);
    const renameMap = {};
    const idRenameMap = {};
    classNames.forEach(c => {
      if (!FRAMEWORK_CLASSES.has(c)) renameMap[c] = prefix + c;
    });
    idNames.forEach(id => {
      idRenameMap[id] = prefix + id;
    });

    // Clone slide and rename in HTML
    const slideClone = slide.cloneNode(true);
    rewriteHtml(slideClone, renameMap, idRenameMap);

    // Collect and rewrite CSS
    let cssText = "";
    if (extractCss) {
      const classSet = new Set([...classNames]);
      const idSet = new Set(idNames);
      const { rules, keyframes } = collectRelevantCss(doc, classSet, idSet);
      const allKeyframes = renameKeyframes(keyframes, prefix);
      const kfRenameMap = allKeyframes.renameMap;
      const rewrittenRules = rules.map(r => rewriteCssRule(r, renameMap, idRenameMap, kfRenameMap));
      cssText = [allKeyframes.text, ...rewrittenRules].filter(Boolean).join("\n");
    }

    // Collect and rewrite JS
    let jsText = "";
    if (extractJs) {
      const classSet = new Set(classNames.filter(c => !FRAMEWORK_CLASSES.has(c)));
      const blocks = collectRelevantJs(doc, classSet, new Set(idNames));
      jsText = blocks.map(b => rewriteJsReferences(b, renameMap, idRenameMap)).join("\n\n");
    }

    return {
      id: "tpl-" + slug,
      name,
      category,
      created: new Date().toISOString(),
      html: slideClone.outerHTML,
      css: cssText,
      js: jsText,
    };
  }

  function rewriteHtml(el, classRename, idRename) {
    if (el.classList && el.classList.length) {
      const newClasses = Array.from(el.classList).map(c => classRename[c] || c);
      el.className = newClasses.join(" ");
    }
    if (el.id && idRename[el.id]) {
      el.id = idRename[el.id];
    }
    // Inline style references: background-image url(#id) etc. — leave alone
    Array.from(el.children).forEach(c => rewriteHtml(c, classRename, idRename));
  }

  function rewriteCssRule(cssText, classRename, idRename, kfRename) {
    // Split selector from body; but cssText may include @media wrapper — handle by regex that targets only the selector list portion.
    return cssText.replace(/([^{}]+)\{([^{}]*)\}/g, (match, sel, body) => {
      const newSel = rewriteSelector(sel, classRename, idRename);
      const newBody = rewriteAnimationRefs(body, kfRename);
      return `${newSel}{${newBody}}`;
    });
  }

  function rewriteSelector(sel, classRename, idRename) {
    return sel
      .replace(/\.([a-zA-Z_][\w-]*)/g, (m, name) => classRename[name] ? "." + classRename[name] : m)
      .replace(/#([a-zA-Z_][\w-]*)/g, (m, name) => idRename[name] ? "#" + idRename[name] : m);
  }

  function rewriteAnimationRefs(body, kfRename) {
    if (!Object.keys(kfRename || {}).length) return body;
    return body.replace(/animation(?:-name)?\s*:\s*([^;]+)/g, (m, val) => {
      const replaced = val.replace(/([a-zA-Z_][\w-]*)/g, (t, name) => kfRename[name] || t);
      return m.replace(val, replaced);
    });
  }

  function renameKeyframes(keyframeCssList, prefix) {
    const renameMap = {};
    const rewritten = keyframeCssList.map(css => {
      return css.replace(/@(-[\w]+-)?keyframes\s+([a-zA-Z_][\w-]*)/g, (m, v, name) => {
        const newName = prefix + name;
        renameMap[name] = newName;
        return `@${v || ""}keyframes ${newName}`;
      });
    });
    return { text: rewritten.join("\n"), renameMap };
  }

  function rewriteJsReferences(js, classRename, idRename) {
    let out = js;
    Object.entries(classRename).forEach(([oldName, newName]) => {
      const reQuoted = new RegExp(`(['"\`])${escapeRegex(oldName)}\\1`, "g");
      out = out.replace(reQuoted, (m, q) => `${q}${newName}${q}`);
      const reDot = new RegExp(`\\.${escapeRegex(oldName)}\\b`, "g");
      out = out.replace(reDot, "." + newName);
    });
    Object.entries(idRename).forEach(([oldName, newName]) => {
      const reQuoted = new RegExp(`(['"\`])${escapeRegex(oldName)}\\1`, "g");
      out = out.replace(reQuoted, (m, q) => `${q}${newName}${q}`);
      const reHash = new RegExp(`#${escapeRegex(oldName)}\\b`, "g");
      out = out.replace(reHash, "#" + newName);
    });
    return out;
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  global.Templates = {
    loadAll, openPicker, insertTemplate, adaptExistingTemplateSlides,
    openSaveAsTemplate, analyzeSlide, buildTemplate,
  };

})(window);
