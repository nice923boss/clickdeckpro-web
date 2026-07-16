/* === In-place DOM editing: text, images, links, bg images === */
(function (global) {
  "use strict";

  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "META", "LINK", "TITLE", "HEAD"]);

  function install(iframeDoc) {
    injectStyle(iframeDoc);
    // Suspend inline goTo(N) handlers BEFORE scan/installBlockEditor so the
    // editor never accidentally triggers a deck navigation while wiring up.
    if (Editor && Editor.state && Editor.state.editMode) {
      suspendGoto(iframeDoc);
    }
    scan(iframeDoc);
    attachDragDrop(iframeDoc);
    attachSelectionWatcher(iframeDoc);
    installBlockEditor(iframeDoc);
  }

  // === Click-to-goto handling ===========================================
  // Decks built for ClickDeck wire jump-to-slide UI with inline
  // onclick="goTo(N)" (0-based index). In edit mode we want clicks to NOT
  // paginate the deck, but we still need the original handler intact at
  // save time. Solution: move the onclick string into dataset.editGoto and
  // the parsed index into dataset.editGotoIndex, and put the attribute back
  // when the user toggles edit mode off or saves.

  function suspendGoto(doc) {
    if (!doc || !doc.querySelectorAll) return;
    doc.querySelectorAll('[onclick*="goTo"]').forEach(el => {
      if (el.hasAttribute("data-edit-goto-bound")) return;
      const onclick = el.getAttribute("onclick");
      if (!onclick) return;
      const m = onclick.match(/goTo\s*\(\s*(-?\d+)\s*\)/);
      if (!m) return;
      el.dataset.editGoto = onclick;
      el.dataset.editGotoIndex = m[1];
      el.removeAttribute("onclick");
      el.setAttribute("data-edit-goto-bound", "");
    });
  }

  function restoreGoto(doc) {
    if (!doc || !doc.querySelectorAll) return;
    doc.querySelectorAll("[data-edit-goto-bound]").forEach(el => {
      if (el.dataset.editGoto) el.setAttribute("onclick", el.dataset.editGoto);
      delete el.dataset.editGoto;
      delete el.dataset.editGotoIndex;
      el.removeAttribute("data-edit-goto-bound");
    });
  }

  // Called from core.serializeDeck and core.syncDeckFromIframe on the
  // detached clone — we mutate the clone, never the live iframe.
  function cleanupGotoForSerialize(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll("[data-edit-goto-bound]").forEach(el => {
      if (el.dataset.editGoto) el.setAttribute("onclick", el.dataset.editGoto);
      delete el.dataset.editGoto;
      delete el.dataset.editGotoIndex;
      el.removeAttribute("data-edit-goto-bound");
    });
  }

  function findGotoHost(el) {
    if (!el || !el.closest) return null;
    return el.closest("[data-edit-goto-bound]");
  }

  // === Runtime-fill cleanup ============================================
  // Many ClickDeck templates build pagination dots / TOC items at runtime,
  // e.g.  slides.forEach(s => navMini.appendChild(dot)). When we serialize
  // the iframe's full DOM, those runtime-added children get frozen into
  // the saved HTML. Next time the file is opened, the same script runs
  // and appends another full set on top — the saved file grows one set
  // of dots/TOC items per save cycle.
  //
  // Two-pronged fix:
  //   A. Containers explicitly marked data-clickdeck-runtime="fill" get
  //      their children stripped at serialize time. This is the canonical
  //      contract going forward — new templates should carry this attr.
  //   B. repairDocumentStructure() runs a heuristic sweep for legacy decks
  //      without the marker, looking at well-known dots/TOC container
  //      ids/classes and only clearing those whose children share one
  //      tag+className signature (i.e. obviously generator output).

  function cleanupRuntimeFillForSerialize(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('[data-clickdeck-runtime="fill"]').forEach(el => {
      if (el.children.length) el.innerHTML = "";
    });
  }

  const REPAIR_LEGACY_SELECTOR = [
    "#navMini", ".nav-mini",
    "#tocList", ".toc-list",
    '[id*="dots" i]', '[class*="dots" i]',
    '[class*="pagination" i]', '[class*="indicator" i]'
  ].join(",");

  function describeContainer(el) {
    if (el.id) return "#" + el.id;
    if (el.className && typeof el.className === "string") {
      const cls = el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join(".");
      return el.tagName.toLowerCase() + (cls ? "." + cls : "");
    }
    return el.tagName.toLowerCase();
  }

  // Return the set of CSS class tokens that EVERY element in `els` carries.
  // Used to detect "same kind of dot/item" while tolerating per-element state
  // classes (e.g. .nav-dot vs .nav-dot.is-active should still count as the
  // same kind because both share `nav-dot`).
  function sharedClassTokens(els) {
    if (els.length === 0) return [];
    const tokensOf = el =>
      new Set((typeof el.className === "string" ? el.className : "")
        .trim().split(/\s+/).filter(Boolean));
    let shared = tokensOf(els[0]);
    for (let i = 1; i < els.length; i++) {
      const cur = tokensOf(els[i]);
      shared = new Set([...shared].filter(t => cur.has(t)));
      if (shared.size === 0) return [];
    }
    return [...shared];
  }

  // C. CSS layout fix: certain legacy templates put nav-dots inside a flex
  // `.navbar { justify-content: space-between }` row. When dots count is
  // accumulated, the container is wide so dots look centered; once the
  // structural repair (A/B above) restores the correct dot count, the now-short
  // container snaps left along the flex flow and visually misaligns.
  // This sweep injects `position: absolute` + `transform: translate(-50%, -50%)`
  // on `.nav-mini` and `margin-left: auto` on `.nav-counter`, but only when the
  // template actually matches the navbar-flex-space-between pattern AND has not
  // already been patched. Other layouts are left untouched.
  function repairNavMiniCentering(doc) {
    const result = { changed: false, actions: [], styles: 0 };
    if (!doc || !doc.querySelectorAll) return result;
    const styles = doc.querySelectorAll("style");
    if (styles.length === 0) return result;

    // Match a top-level class selector and its body. `sel` is the raw CSS
    // class like ".nav-mini"; the helper escapes regex metacharacters
    // internally. The negative lookahead `(?![\w-])` keeps `.nav-mini\s*\{`
    // from matching `.nav-mini-thumb` (longer class with same prefix). The
    // `:hover`-style modifiers are excluded automatically because they need
    // a `:` between selector and `{`, which fails our `\s*\{` anchor.
    const ruleRe = sel => new RegExp(
      "(" + sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![\\w-])\\s*\\{)([^}]*)(\\})"
    );

    styles.forEach(style => {
      const css = style.textContent || "";
      // Guard 1: only act when `.navbar` exists AND uses space-between.
      const navbarMatch = css.match(ruleRe(".navbar"));
      if (!navbarMatch) return;
      if (!/justify-content\s*:\s*space-between/.test(navbarMatch[2])) return;

      // Guard 2: `.nav-mini` rule must exist and NOT already be absolute.
      const navMiniMatch = css.match(ruleRe(".nav-mini"));
      if (!navMiniMatch) return;
      const navMiniBody = navMiniMatch[2];
      if (/position\s*:\s*absolute/.test(navMiniBody)) return;

      let newCss = css;
      const navMiniInsert =
        "\n    position: absolute;" +
        "\n    left: 50%;" +
        "\n    top: 50%;" +
        "\n    transform: translate(-50%, -50%);" +
        "\n    justify-content: center;";
      newCss = newCss.replace(
        ruleRe(".nav-mini"),
        (m, head, body, tail) => head + body.replace(/\s*$/, "") + navMiniInsert + "\n  " + tail
      );
      result.actions.push(".nav-mini 加入 absolute 置中");

      // Optional: `.nav-counter` gets `margin-left: auto` so the counter+next
      // button cluster moves to the right edge, avoiding overlap with the now
      // absolutely-centered dots.
      const counterMatch = newCss.match(ruleRe(".nav-counter"));
      if (counterMatch && !/margin-left\s*:\s*auto/.test(counterMatch[2])) {
        newCss = newCss.replace(
          ruleRe(".nav-counter"),
          (m, head, body, tail) => head + body.replace(/\s*$/, "") + "\n    margin-left: auto;\n  " + tail
        );
        result.actions.push(".nav-counter 加入 margin-left: auto");
      }

      if (newCss !== css) {
        style.textContent = newCss;
        result.changed = true;
        result.styles++;
      }
    });

    return result;
  }

  function repairDocumentStructure(doc, slidesCount, opts) {
    opts = opts || {};
    const report = {
      scanned: 0, cleared: 0, removed: 0,
      containers: [], skipped: [],
      cssChanged: false, cssActions: [],
      slidesCount,
    };
    if (!doc || !doc.querySelectorAll) return report;

    // A. Marked containers: always clear.
    doc.querySelectorAll('[data-clickdeck-runtime="fill"]').forEach(el => {
      report.scanned++;
      const n = el.children.length;
      if (n === 0) return;
      el.innerHTML = "";
      report.cleared++;
      report.removed += n;
      report.containers.push({ kind: "marked", name: describeContainer(el), removed: n });
    });

    // B. Heuristic sweep for legacy decks (no marker attribute).
    if (slidesCount > 0) {
      doc.querySelectorAll(REPAIR_LEGACY_SELECTOR).forEach(el => {
        if (el.hasAttribute("data-clickdeck-runtime")) return;
        const kids = Array.from(el.children);
        const name = describeContainer(el);
        if (kids.length === 0) return; // 空容器，沒累積
        report.scanned++;
        if (kids.length <= slidesCount) {
          report.skipped.push({ name, count: kids.length, reason: `子節點 ${kids.length} ≤ 投影片數 ${slidesCount}` });
          return;
        }
        const sameTag = kids.every(k => k.tagName === kids[0].tagName);
        if (!sameTag) {
          report.skipped.push({ name, count: kids.length, reason: "子節點 tag 不一致" });
          return;
        }
        // TOC containers interleave .toc-section headers with .toc-item rows,
        // so their children share no single class token and the generic
        // signature test below would skip them — letting accumulated TOC
        // entries survive every save. For a known TOC container whose children
        // are all TOC-family elements, gate on the .toc-item count instead: a
        // clean TOC carries exactly one .toc-item per slide, so more than
        // slidesCount means a frozen set got re-appended on load.
        const isToc = el.id === "tocList" || el.classList.contains("toc-list");
        const allTocFamily = kids.every(k =>
          k.classList.contains("toc-item") || k.classList.contains("toc-section"));
        if (isToc && allTocFamily) {
          const itemCount = kids.filter(k => k.classList.contains("toc-item")).length;
          if (itemCount <= slidesCount) {
            report.skipped.push({ name, count: kids.length, reason: `toc-item ${itemCount} ≤ 投影片數 ${slidesCount}` });
            return;
          }
          el.innerHTML = "";
          el.setAttribute("data-clickdeck-runtime", "fill");
          report.cleared++;
          report.removed += kids.length;
          report.containers.push({ kind: "toc", name, removed: kids.length, items: itemCount });
          return;
        }
        // Tolerate per-element state classes (is-active / is-prev / …) by
        // requiring at least one class token in common across all kids, not
        // exact className equality.
        const shared = sharedClassTokens(kids);
        if (shared.length === 0) {
          report.skipped.push({ name, count: kids.length, reason: "子節點無共同 class" });
          return;
        }
        const n = kids.length;
        el.innerHTML = "";
        // Persist the marker so future serialize calls automatically strip
        // children that the deck's own runtime script will re-append in the
        // iframe. Without this, the saved HTML keeps whatever the iframe held
        // at serialize time (e.g. 20 dots), and the next time a browser opens
        // the file the runtime script doubles it (20 → 40 → 80 …).
        el.setAttribute("data-clickdeck-runtime", "fill");
        report.cleared++;
        report.removed += n;
        report.containers.push({ kind: "heuristic", name, removed: n, shared: shared.join(" ") });
      });
    }

    // C. CSS layout fix for navbar flex-space-between templates whose
    // .nav-mini visually drifts left after structural repair restores the
    // correct (short) dot count. Gated by opts.css so the on-load auto-repair
    // can run the structural sweep without silently rewriting a deck's
    // stylesheet on every open; the manual repair button leaves it enabled.
    if (opts.css !== false) {
      const cssFix = repairNavMiniCentering(doc);
      if (cssFix.changed) {
        report.cssChanged = true;
        report.cssActions = cssFix.actions;
      }
    }

    return report;
  }

  function setGotoIndex(host, idx) {
    host.dataset.editGotoIndex = String(idx);
    const orig = host.dataset.editGoto || "";
    if (/goTo\s*\(\s*-?\d+\s*\)/.test(orig)) {
      host.dataset.editGoto = orig.replace(/goTo\s*\(\s*-?\d+\s*\)/, `goTo(${idx})`);
    } else {
      host.dataset.editGoto = `goTo(${idx})`;
    }
  }

  // Renders an "動畫目標數值" row at the top of the prop panel when the
  // inspected element carries data-target (HoloTeam-style countUp animation).
  // Directly editing textContent would be wiped out by the deck's animation
  // on the next slide activation — the user must update data-target instead,
  // and we mirror the new value into textContent so the editor preview keeps
  // showing the correct number until the deck repaints it.
  function prependAnimationTargetSection(panel, el) {
    if (!el || !el.hasAttribute || !el.hasAttribute("data-target")) return false;
    const raw = el.getAttribute("data-target");
    const initial = Number.isFinite(parseFloat(raw)) ? raw : "0";
    const section = document.createElement("div");
    section.className = "animation-target-section";
    section.innerHTML = `
      <div class="target-tag animation-tag">動畫數字</div>
      <p class="hint">此元素由 JS 動畫覆寫顯示值。請改下方目標值（直接編輯文字會被動畫蓋掉）。</p>
      <label class="field">
        <span>動畫目標數值</span>
        <input type="number" class="prop-anim-target" step="1" value="${escAttr(initial)}" />
      </label>
    `;
    panel.prepend(section);
    const input = section.querySelector(".prop-anim-target");
    input.addEventListener("change", e => {
      const v = e.target.value;
      if (v === "") return;
      History.push();
      el.setAttribute("data-target", v);
      // Mirror into textContent so the editor preview reflects the new
      // target; deck-level countUp animations only sample data-target on
      // slide activation, so without a re-trigger the visible number stays
      // at the previous animation's endpoint.
      el.textContent = v;
      Editor.markDirty();
      // Re-run the deck's own navigation for the current slide to restart
      // the countUp animation with the new target. Best-effort: skip
      // silently if the deck doesn't expose a recognised nav function.
      const iframeWin = Editor.ui.deckFrame.contentWindow;
      const idx = Editor.state.currentIndex;
      if (iframeWin && Number.isInteger(idx)) {
        for (const fnName of ["goTo", "goToSlide", "showSlide", "setSlide", "navigateTo", "show"]) {
          if (typeof iframeWin[fnName] === "function") {
            try { iframeWin[fnName].call(iframeWin, idx); break; }
            catch (_) { /* try next */ }
          }
        }
      }
      if (window.Slides) Slides.rebuildThumbsOnly();
    });
    return true;
  }

  // Renders the "點擊跳轉目標頁碼" row at the top of the prop panel when the
  // inspected element is inside a suspended goTo host. Returns true if a row
  // was added so callers can decide whether to draw additional context.
  function prependGotoSection(panel, el) {
    const host = findGotoHost(el);
    if (!host) return false;
    const total = (Editor.state.slides && Editor.state.slides.length) || 1;
    const rawIdx = parseInt(host.dataset.editGotoIndex, 10);
    const safeIdx = Number.isFinite(rawIdx) ? rawIdx : 0;
    const oneBased = Math.min(Math.max(safeIdx + 1, 1), total);
    const section = document.createElement("div");
    section.className = "goto-section";
    section.innerHTML = `
      <div class="target-tag goto-tag">點擊跳轉</div>
      <label class="field">
        <span>跳轉目標頁碼</span>
        <input type="number" class="prop-goto-page" min="1" max="${total}" step="1" value="${oneBased}" />
      </label>
      <p class="hint">播放模式下點擊此區塊會跳到第 <span class="prop-goto-display">${oneBased}</span> 頁（共 ${total} 頁）。編輯模式下點擊不會跳頁。</p>
    `;
    panel.prepend(section);
    const input = section.querySelector(".prop-goto-page");
    const display = section.querySelector(".prop-goto-display");
    input.addEventListener("change", e => {
      const v = parseInt(e.target.value, 10);
      if (!Number.isFinite(v)) {
        e.target.value = oneBased;
        return;
      }
      const clamped = Math.min(total, Math.max(1, v));
      if (clamped !== v) e.target.value = clamped;
      History.push();
      setGotoIndex(host, clamped - 1);
      display.textContent = clamped;
      Editor.markDirty();
    });
    return true;
  }

  // Standalone inspector shown when the click landed on the goTo host's own
  // frame (i.e. not inside a text/image descendant). Pure jump-target editor.
  function showGotoProps(el) {
    const panel = clearProps();
    panel.innerHTML = `
      <div class="target-tag">點擊跳轉區塊</div>
      <p class="hint">這個區塊在播放模式被點擊時會跳到指定的投影片。修改下方頁碼即可調整目標頁。</p>
    `;
    prependGotoSection(panel, el);
  }

  // Watch iframe selection. When the user drags to highlight text inside a
  // text-marked element (or its descendants), expose the font / size / colour
  // panel for that element and remember the live range so the slider / number
  // / font-family controls apply to the selection rather than the whole element.
  // Without this, users had to click first to enter edit mode before any text
  // controls appeared — selecting alone produced no UI feedback.
  function attachSelectionWatcher(iframeDoc) {
    if (iframeDoc.__editorSelectionBound) return;
    iframeDoc.__editorSelectionBound = true;

    const findTextHost = (node) => {
      let cur = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      while (cur && cur.nodeType === 1) {
        if (cur.matches && cur.matches('[data-edit-highlight="text"]')) return cur;
        cur = cur.parentElement;
      }
      return null;
    };

    iframeDoc.addEventListener("selectionchange", () => {
      const sel = iframeDoc.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
      const range = sel.getRangeAt(0);
      const host = findTextHost(range.startContainer);
      if (!host) return;
      // Selection must stay within the same text host — cross-element drags
      // are ambiguous, leave them alone.
      if (!host.contains(range.endContainer)) return;

      host.__savedRange = range.cloneRange();

      // Avoid re-rendering the panel on every minor selection change once it
      // already targets this host — that would steal focus from input controls
      // the user might be typing in.
      const panel = Editor.ui.propPanel;
      if (panel.__currentTextHost !== host) {
        showTextProps(host);
        panel.__currentTextHost = host;
        // showTextProps wires its own selectionchange handler that mirrors
        // size / family into the controls; calling it here ensures the
        // initial values reflect the selection's resolved styles.
      }
    });
  }

  function attachDragDrop(iframeDoc) {
    if (iframeDoc.__editorDndBound) return;
    iframeDoc.__editorDndBound = true;
    const hasFiles = (dt) => dt && dt.types && Array.from(dt.types).includes("Files");
    iframeDoc.addEventListener("dragover", (e) => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }, true);
    iframeDoc.addEventListener("drop", async (e) => {
      if (!hasFiles(e.dataTransfer)) return;
      const files = Array.from(e.dataTransfer.files || []).filter(f => f.type.startsWith("image/"));
      if (files.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      let slide = e.target && e.target.closest ? e.target.closest(".slide, [data-slide]") : null;
      if (!slide) {
        const slides = Slides.detectSlides(iframeDoc);
        slide = slides[Editor.state.currentIndex] || slides[0] || iframeDoc.querySelector(".slide.active");
      }
      if (!slide) {
        Editor.toast("請先載入簡報", "err");
        return;
      }
      History.push();
      let lastImg = null, lastInfo = null, lastFile = null;
      for (const f of files) {
        try {
          const info = await fileToBase64(f);
          lastImg = appendImageToSlide(iframeDoc, slide, info.dataUrl, f.name);
          lastInfo = info;
          lastFile = f;
        } catch (err) {
          Editor.toast("圖片處理失敗：" + err.message, "err");
        }
      }
      if (lastImg) {
        showImageProps(lastImg);
        Editor.markDirty();
        Slides.rebuildThumbsOnly();
        const verb = files.length > 1 ? `已嵌入 ${files.length} 張圖片` : "已嵌入圖片";
        imageResultToast(lastFile, lastInfo, verb);
      }
    }, true);
  }

  function injectStyle(doc) {
    if (doc.getElementById("__editor_style__")) return;
    const s = doc.createElement("style");
    s.id = "__editor_style__";
    s.textContent = `
      [data-edit-highlight] {
        outline: 1px dashed rgba(212,91,7,.55);
        outline-offset: 2px;
        cursor: pointer;
        transition: outline-color .15s, background .15s;
      }
      [data-edit-highlight]:hover {
        outline: 2px dashed rgba(212,91,7,1);
        background: rgba(212,91,7,.06);
      }
      [data-edit-highlight="text"][contenteditable="true"],
      [data-edit-highlight="text"][contenteditable="true"] * {
        /* Force readable contrast while editing — the saved colour is
           restored when contenteditable is removed on save. Without this,
           white text on a dark slide becomes invisible against the
           white editing background. */
        color: #1f2937 !important;
        -webkit-text-fill-color: #1f2937 !important;
        background-image: none !important;
        text-shadow: none !important;
        opacity: 1 !important;
      }
      [data-edit-highlight="text"][contenteditable="true"] {
        outline: 2px solid rgba(212,91,7,1);
        background: rgba(255,250,220,.97);
        cursor: text;
      }
      [data-edit-highlight="image"]:hover::after {
        content: "點擊更換圖片";
        position: absolute; top: 4px; left: 4px;
        background: rgba(212,91,7,.9); color: #fff;
        font-size: 11px; padding: 2px 6px; border-radius: 3px;
        pointer-events: none; z-index: 9999;
      }
    `;
    doc.head.appendChild(s);
  }

  function scan(doc) {
    // 1) Text: find block-ish elements that contain meaningful text
    const textTargets = doc.querySelectorAll("h1, h2, h3, h4, h5, h6, p, li, td, th, span, strong, em, div");
    textTargets.forEach(el => {
      if (SKIP_TAGS.has(el.tagName)) return;
      // Skip our own overlay UI (injected buttons/containers).
      if (el.closest(".__editor_block_overlay__")) return;
      // Must contain a direct (non-whitespace) text child and no editable parent.
      if (el.closest("[data-edit-highlight=text]")) return;
      const childText = Array.from(el.childNodes).some(n => n.nodeType === Node.TEXT_NODE && n.nodeValue.trim().length > 0);
      if (!childText) return;
      // Skip if it contains other block children; we want leaf-ish text.
      const hasBlockChild = Array.from(el.children).some(c => !["SPAN","STRONG","EM","B","I","U","A","BR","CODE","MARK","SUB","SUP","SMALL"].includes(c.tagName));
      if (hasBlockChild) return;
      el.setAttribute("data-edit-highlight", "text");
      el.addEventListener("click", onTextClick, true);
    });

    // 2) Images
    doc.querySelectorAll("img").forEach(attachImageHandlers);

    // 3) Links (edit href via right-click or when text is selected in link)
    doc.querySelectorAll("a").forEach(attachLinkHandlers);

    // 4) Background images (CSS background-image on common containers)
    doc.querySelectorAll("[style*='background-image']").forEach(el => {
      el.setAttribute("data-edit-highlight", "bgimage");
      el.addEventListener("click", onBgClick, true);
    });
  }

  function onTextClick(e) {
    const el = e.currentTarget;
    // If user is ctrl/cmd clicking a link, allow default behavior by bailing.
    if (el.tagName === "A") return;
    // Already in edit mode: let the browser handle caret placement and
    // mouse-drag selection natively. Otherwise we'd reset the selection
    // on every mouseup.
    if (el.getAttribute("contenteditable") === "true") {
      e.stopPropagation();
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    // Capture a pre-edit snapshot so Ctrl+Z (outside contenteditable) reverts
    // the whole edit session. Intra-field edits use the browser's native undo.
    const preText = el.textContent;
    History.push();
    // Enable editing
    el.setAttribute("contenteditable", "true");
    el.focus();
    // Place cursor at click position
    placeCaretAt(el, e);
    showTextProps(el);

    // Track last non-collapsed selection inside this element, so clicking a
    // parent-window button (which blurs the iframe) doesn't lose the range.
    const iframeDoc = el.ownerDocument;
    const selHandler = () => {
      const s = iframeDoc.getSelection();
      if (s && s.rangeCount > 0 && !s.isCollapsed && el.contains(s.anchorNode) && el.contains(s.focusNode)) {
        el.__savedRange = s.getRangeAt(0).cloneRange();
      }
    };
    iframeDoc.addEventListener("selectionchange", selHandler);

    el.addEventListener("blur", () => {
      iframeDoc.removeEventListener("selectionchange", selHandler);
      finishEdit(el);
    }, { once: true });
    el.addEventListener("input", () => Editor.markDirty(), { once: true });
    el.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        el.blur();
      } else if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        el.blur();
      }
    });
  }

  function placeCaretAt(el, e) {
    const doc = el.ownerDocument;
    let range;
    if (doc.caretPositionFromPoint) {
      const pos = doc.caretPositionFromPoint(e.clientX, e.clientY);
      if (pos) {
        range = doc.createRange();
        range.setStart(pos.offsetNode, pos.offset);
        range.collapse(true);
      }
    } else if (doc.caretRangeFromPoint) {
      range = doc.caretRangeFromPoint(e.clientX, e.clientY);
    }
    if (range) {
      const sel = doc.defaultView.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  function finishEdit(el) {
    el.removeAttribute("contenteditable");
    Editor.markDirty();
    // Rebuild thumb for current slide
    if (global.Slides) Slides.rebuildThumbsOnly();
  }

  function attachImageHandlers(img) {
    if (img.__editorImgBound) return;
    img.__editorImgBound = true;
    img.setAttribute("data-edit-highlight", "image");
    if (!img.style.position) img.style.position = "relative";
    img.addEventListener("click", onImageClick, true);
  }

  function attachLinkHandlers(a) {
    if (a.__editorLinkBound) return;
    a.__editorLinkBound = true;
    a.setAttribute("data-edit-highlight", "link");
    a.addEventListener("contextmenu", onLinkRightClick, true);
    a.addEventListener("click", (e) => { e.preventDefault(); }, true);
  }

  // === Click-hint glow ================================================
  // Links the user flags as "clickable hint" glow when hovered, so a presenter
  // can confirm where the tappable spots are even after the link text was made
  // to look like plain body text (no blue, no underline). Implemented as one
  // persistent <style> block plus a class on the <a>. The style id deliberately
  // avoids the "__editor_" prefix so stripEditorInjections() leaves it in the
  // saved file; the effect is a pure CSS :hover, so it works in the presented
  // deck opened standalone, with no JavaScript.
  const LINK_GLOW_CLASS = "clickdeck-link-glow";
  const LINK_GLOW_STYLE_ID = "clickdeck-link-glow-style";
  // The three glow colours the user can pick. Each maps to a modifier class on
  // the <a>; the matching :hover rule lives in the injected style block below.
  // Gold is the default and also the fallback for the bare `.clickdeck-link-glow`
  // class that older decks saved before the colour choice existed.
  const LINK_GLOW_COLORS = {
    gold:  "clickdeck-glow-gold",
    blue:  "clickdeck-glow-blue",
    white: "clickdeck-glow-white",
  };

  function ensureLinkGlowStyle(doc) {
    if (!doc) return;
    // Upsert rather than create-once: refresh the rules every time so a deck
    // saved with the older single-colour block picks up the blue/white variants.
    let s = doc.getElementById(LINK_GLOW_STYLE_ID);
    if (!s) {
      s = doc.createElement("style");
      s.id = LINK_GLOW_STYLE_ID;
      (doc.head || doc.documentElement).appendChild(s);
    }
    s.textContent = `
      a.${LINK_GLOW_CLASS} { cursor: pointer; transition: text-shadow .18s ease; }
      a.${LINK_GLOW_CLASS}:hover,
      a.${LINK_GLOW_CLASS}.${LINK_GLOW_COLORS.gold}:hover {
        text-shadow: 0 0 5px rgba(255,193,7,.95), 0 0 12px rgba(255,193,7,.7), 0 0 22px rgba(255,193,7,.5);
      }
      a.${LINK_GLOW_CLASS}.${LINK_GLOW_COLORS.blue}:hover {
        text-shadow: 0 0 5px rgba(59,130,246,.95), 0 0 12px rgba(59,130,246,.7), 0 0 22px rgba(59,130,246,.5);
      }
      a.${LINK_GLOW_CLASS}.${LINK_GLOW_COLORS.white}:hover {
        text-shadow: 0 0 6px rgba(255,255,255,.98), 0 0 14px rgba(255,255,255,.8), 0 0 26px rgba(255,255,255,.55);
      }
    `;
  }

  // Read the glow colour applied to a link. Defaults to gold, which also covers
  // legacy links that only carry the bare glow class.
  function getLinkGlowColor(a) {
    if (a.classList.contains(LINK_GLOW_COLORS.blue)) return "blue";
    if (a.classList.contains(LINK_GLOW_COLORS.white)) return "white";
    return "gold";
  }

  // Apply exactly one glow colour modifier class, clearing the others first.
  function setLinkGlowColor(a, color) {
    Object.values(LINK_GLOW_COLORS).forEach(c => a.classList.remove(c));
    a.classList.add(LINK_GLOW_COLORS[color] || LINK_GLOW_COLORS.gold);
  }

  function onImageClick(e) {
    e.stopPropagation();
    e.preventDefault();
    const img = e.currentTarget;
    showImageProps(img);
    const doc = img.ownerDocument;
    if (doc.__editorSelectContainer) doc.__editorSelectContainer(img);
  }

  function onBgClick(e) {
    // Only trigger when clicking the element itself (not a child)
    if (e.target !== e.currentTarget) return;
    e.stopPropagation();
    showBgProps(e.currentTarget);
  }

  function onLinkRightClick(e) {
    e.preventDefault();
    e.stopPropagation();
    showLinkProps(e.currentTarget);
  }

  // === Property panel renderers === //

  function clearProps() {
    const panel = Editor.ui.propPanel;
    panel.innerHTML = "";
    panel.__currentTextHost = null;
    return panel;
  }

  // Font family options shared with the global style drawer so per-element
  // and document-wide pickers stay consistent.
  const FONT_FAMILY_OPTIONS = [
    { label: "（保留原樣）", value: "" },
    { label: "微軟正黑體", value: "'Microsoft JhengHei', '微軟正黑體', sans-serif" },
    { label: "思源黑體", value: "'Noto Sans TC', sans-serif" },
    { label: "蘋方", value: "'PingFang TC', sans-serif" },
    { label: "思源宋體", value: "'Source Han Serif TC', serif" },
    { label: "系統襯線", value: "serif" },
    { label: "系統無襯線", value: "sans-serif" },
    { label: "等寬字體", value: "'JetBrains Mono', 'Consolas', monospace" },
  ];

  // Range slider bounds for the font-size control. 8~120px covers caption-sized
  // body text up to large display headlines without letting the slider hit
  // absurd values via a stray drag.
  const FONT_SIZE_MIN = 8;
  const FONT_SIZE_MAX = 120;

  function fontFamilyOptionsHtml(currentValue) {
    return FONT_FAMILY_OPTIONS.map(opt => {
      const selected = opt.value === currentValue ? " selected" : "";
      return `<option value="${escAttr(opt.value)}"${selected}>${opt.label}</option>`;
    }).join("");
  }

  // Find which preset value (if any) matches the element's current computed
  // font-family. Browsers normalize the string (extra quotes, spacing), so
  // compare normalized tokens rather than raw text.
  function matchFontFamilyPreset(computedFamily) {
    const norm = s => String(s || "")
      .toLowerCase()
      .replace(/["']/g, "")
      .replace(/\s+/g, "")
      .split(",")[0];
    const target = norm(computedFamily);
    if (!target) return "";
    for (const opt of FONT_FAMILY_OPTIONS) {
      if (!opt.value) continue;
      if (norm(opt.value) === target) return opt.value;
    }
    return "";
  }

  function showTextProps(el) {
    const panel = clearProps();
    panel.__currentTextHost = el;
    const tag = el.tagName.toLowerCase();
    panel.innerHTML = `
      <div class="target-tag">文字 · &lt;${tag}&gt;</div>
      <p class="hint">反白選取文字可只套用到選取範圍；直接點擊文字進入編輯模式可改內容。按 Esc 結束編輯。</p>
      <div class="field">
        <span>字級（px）</span>
        <div class="font-size-row">
          <input type="number" id="prop-fontsize" min="${FONT_SIZE_MIN}" max="${FONT_SIZE_MAX}" step="1" placeholder="例：24">
          <input type="range" id="prop-fontsize-range" min="${FONT_SIZE_MIN}" max="${FONT_SIZE_MAX}" step="1" aria-label="字級滑軌">
        </div>
      </div>
      <div class="field">
        <span>字體</span>
        <select id="prop-fontfamily">${fontFamilyOptionsHtml("")}</select>
      </div>
      <div class="field">
        <span>顏色</span>
        <input type="color" id="prop-color">
      </div>
      <div class="field">
        <span>粗體</span>
        <select id="prop-weight">
          <option value="">（不變）</option>
          <option value="400">一般</option>
          <option value="500">中粗</option>
          <option value="700">粗體</option>
          <option value="900">極粗</option>
        </select>
      </div>
      <div class="field">
        <span>超連結</span>
        <p class="hint" style="margin:0 0 6px">先在中間選取文字，再按下方按鈕。</p>
        <button type="button" id="prop-add-link" class="btn">為選取文字加上連結</button>
      </div>
    `;
    prependGotoSection(panel, el);
    // Animation section is prepended AFTER goto so it lands on top — for
    // HoloTeam-style countUp targets this is the dominant hint and should
    // be the first thing the user sees.
    prependAnimationTargetSection(panel, el);
    const fontInput = panel.querySelector("#prop-fontsize");
    const fontRange = panel.querySelector("#prop-fontsize-range");
    const fontFamilySel = panel.querySelector("#prop-fontfamily");
    const iframeDocF = el.ownerDocument;
    const iframeWinF = iframeDocF.defaultView;

    // Find the element that the current selection (or caret) is actually inside,
    // falling back to the edited element. Used to mirror live font-size /
    // font-family into the property panel as the user moves the cursor.
    const resolveSelectionTarget = () => {
      const sel = iframeDocF.getSelection();
      if (sel && sel.rangeCount > 0 && sel.anchorNode && el.contains(sel.anchorNode)) {
        const a = sel.anchorNode;
        const cand = a.nodeType === Node.TEXT_NODE ? a.parentElement : a;
        if (cand && el.contains(cand)) return cand;
      }
      return el;
    };

    const refreshFontInput = () => {
      const focused = document.activeElement;
      const target = resolveSelectionTarget();
      const cs = iframeWinF.getComputedStyle(target);
      const px = parseFloat(cs.fontSize);
      if (!isNaN(px)) {
        const clamped = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(px)));
        if (focused !== fontInput) fontInput.value = Math.round(px);
        if (focused !== fontRange) fontRange.value = clamped;
      }
      if (focused !== fontFamilySel) {
        fontFamilySel.value = matchFontFamilyPreset(cs.fontFamily);
      }
    };
    refreshFontInput();
    const fontSelHandler = () => refreshFontInput();
    iframeDocF.addEventListener("selectionchange", fontSelHandler);
    el.addEventListener("blur", () => {
      iframeDocF.removeEventListener("selectionchange", fontSelHandler);
    }, { once: true });

    // Apply font-size to either:
    //   1) a live drag-wrap span if one was created at drag start (slider drag),
    //   2) the saved selection range (single-shot change from the number input),
    //   3) or the whole edited element (no selection).
    // Re-wrapping the same range on every slider tick would (a) nest spans, and
    // (b) silently clear __savedRange after the first apply, causing subsequent
    // ticks to mutate the whole element instead of the selection.
    const applyFontSize = (size) => {
      if (el.__sizeSpan && el.contains(el.__sizeSpan)) {
        if (size) el.__sizeSpan.style.fontSize = size + "px";
        else el.__sizeSpan.style.removeProperty("font-size");
        Editor.markDirty();
        return;
      }
      const range = el.__savedRange;
      const hasRange = range && !range.collapsed
        && el.contains(range.startContainer) && el.contains(range.endContainer);
      if (hasRange) {
        applyFontSizeToRange(range, size, iframeDocF);
        el.__savedRange = null;
      } else {
        if (size) el.style.fontSize = size + "px";
        else el.style.removeProperty("font-size");
      }
      Editor.markDirty();
    };

    fontInput.addEventListener("change", e => {
      History.push();
      const raw = e.target.value;
      const size = raw === "" ? "" : String(Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, parseInt(raw, 10) || 0)));
      if (raw !== "" && size !== raw) e.target.value = size;
      if (size) fontRange.value = size;
      applyFontSize(size);
    });

    // Slider: live preview while dragging. To avoid the "first tick wraps the
    // selection, subsequent ticks fall back to whole element" bug, we wrap
    // the selection in a span ONCE on pointerdown and keep mutating that span
    // for the rest of the drag. Pointerup clears the cached span so the next
    // operation picks up a fresh selection.
    let rangeDragging = false;
    const startDrag = () => {
      if (rangeDragging) return;
      rangeDragging = true;
      History.push();
      const range = el.__savedRange;
      const hasRange = range && !range.collapsed
        && el.contains(range.startContainer) && el.contains(range.endContainer);
      if (hasRange) {
        const initialSize = parseFloat(fontRange.value) || parseFloat(fontInput.value) || 0;
        el.__sizeSpan = applyFontSizeToRange(range, initialSize ? String(initialSize) : "", iframeDocF);
        el.__savedRange = null;
      }
    };
    const endDrag = () => {
      rangeDragging = false;
      el.__sizeSpan = null;
    };
    fontRange.addEventListener("pointerdown", startDrag);
    fontRange.addEventListener("input", e => {
      const size = e.target.value;
      fontInput.value = size;
      if (!rangeDragging) startDrag();
      applyFontSize(size);
    });
    fontRange.addEventListener("change", endDrag);
    fontRange.addEventListener("pointerup", endDrag);
    fontRange.addEventListener("pointercancel", endDrag);

    fontFamilySel.addEventListener("change", e => {
      History.push();
      const family = e.target.value;
      const range = el.__savedRange;
      const hasRange = range && !range.collapsed
        && el.contains(range.startContainer) && el.contains(range.endContainer);
      if (hasRange) {
        applyFontFamilyToRange(range, family, iframeDocF);
        el.__savedRange = null;
      } else {
        if (family) el.style.fontFamily = family;
        else el.style.removeProperty("font-family");
      }
      Editor.markDirty();
    });

    panel.querySelector("#prop-color").addEventListener("change", e => {
      History.push();
      el.style.color = e.target.value;
      Editor.markDirty();
    });
    panel.querySelector("#prop-weight").addEventListener("change", e => {
      History.push();
      if (e.target.value) el.style.fontWeight = e.target.value;
      else el.style.removeProperty("font-weight");
      Editor.markDirty();
    });
    const linkBtn = panel.querySelector("#prop-add-link");
    // preventDefault on mousedown keeps iframe selection alive when the button is pressed.
    linkBtn.addEventListener("mousedown", e => e.preventDefault());
    linkBtn.addEventListener("click", () => {
      const range = el.__savedRange;
      if (!range || range.collapsed) {
        Editor.toast("請先在文字中反白選取要加連結的部分", "err");
        return;
      }
      const url = prompt("請輸入連結網址（例：https://example.com）：", "https://");
      if (!url || url.trim() === "" || url.trim() === "https://") return;
      History.push();
      addLinkAroundRange(range, url.trim(), el.ownerDocument);
      el.__savedRange = null;
      Editor.markDirty();
      Slides.rebuildThumbsOnly();
      Editor.toast("已加入連結", "ok");
    });
  }

  function showImageProps(img) {
    const panel = clearProps();
    panel.innerHTML = `
      <div class="target-tag">圖片 · &lt;img&gt;</div>
      <div class="field">
        <span>來源 URL</span>
        <input type="text" id="prop-src" value="${escAttr(img.getAttribute("src") || "")}" placeholder="https://... 或相對路徑">
      </div>
      <div class="field">
        <span>或從本機選擇</span>
        <input type="file" id="prop-file" accept="image/*">
      </div>
      <div class="field">
        <span>替代文字（alt）</span>
        <input type="text" id="prop-alt" value="${escAttr(img.getAttribute("alt") || "")}">
      </div>
      <div class="field">
        <span>寬度</span>
        <input type="text" id="prop-width" value="${escAttr(img.getAttribute("width") || img.style.width || "")}">
      </div>
    `;
    prependGotoSection(panel, img);
    panel.querySelector("#prop-src").addEventListener("change", e => {
      History.push();
      img.setAttribute("src", e.target.value);
      Editor.markDirty();
      Slides.rebuildThumbsOnly();
    });
    panel.querySelector("#prop-file").addEventListener("change", async e => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const info = await fileToBase64(f);
        History.push();
        img.setAttribute("src", info.dataUrl);
        panel.querySelector("#prop-src").value = info.dataUrl.slice(0, 80) + "...";
        Editor.markDirty();
        Slides.rebuildThumbsOnly();
        imageResultToast(f, info, "已更換圖片");
      } catch (err) {
        Editor.toast("更換圖片失敗：" + err.message, "err");
      }
    });
    panel.querySelector("#prop-alt").addEventListener("change", e => {
      History.push();
      img.setAttribute("alt", e.target.value);
      Editor.markDirty();
    });
    panel.querySelector("#prop-width").addEventListener("change", e => {
      History.push();
      const v = e.target.value.trim();
      if (v) img.setAttribute("width", v);
      else img.removeAttribute("width");
      Editor.markDirty();
    });
  }

  function showBgProps(el) {
    const panel = clearProps();
    const current = (el.style.backgroundImage || "").match(/url\(["']?(.*?)["']?\)/);
    const currentUrl = current ? current[1] : "";
    panel.innerHTML = `
      <div class="target-tag">背景圖片</div>
      <div class="field">
        <span>圖片 URL</span>
        <input type="text" id="prop-bg" value="${escAttr(currentUrl)}">
      </div>
      <div class="field">
        <span>或從本機選擇</span>
        <input type="file" id="prop-bg-file" accept="image/*">
      </div>
    `;
    prependGotoSection(panel, el);
    panel.querySelector("#prop-bg").addEventListener("change", e => {
      History.push();
      el.style.backgroundImage = `url("${e.target.value}")`;
      Editor.markDirty();
      Slides.rebuildThumbsOnly();
    });
    panel.querySelector("#prop-bg-file").addEventListener("change", async e => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const info = await fileToBase64(f);
        History.push();
        el.style.backgroundImage = `url("${info.dataUrl}")`;
        Editor.markDirty();
        Slides.rebuildThumbsOnly();
        imageResultToast(f, info, "已更換背景");
      } catch (err) {
        Editor.toast("更換背景失敗：" + err.message, "err");
      }
    });
  }

  // === Per-slide vertical alignment =====================================
  // ClickDeck / teaching decks render each .slide as a flex column, so the
  // main axis is vertical and `justify-content` decides top-vs-centred
  // placement. We persist the choice as an inline style on the slide section:
  //   靠上對齊 -> justify-content: flex-start
  //   上下置中 -> justify-content: safe center
  // `safe center` centres the content when it fits the viewport but falls back
  // to top-alignment (using the slide's own overflow scroll) when the content
  // is taller than the screen, so a long slide never has its heading clipped
  // above the scroll region.
  const SLIDE_ALIGN_TOP = "flex-start";
  const SLIDE_ALIGN_CENTER = "safe center";

  function setJustifyContent(el, value) {
    el.style.setProperty("justify-content", value);
    // Older engines reject the `safe`/`unsafe` overflow-alignment keyword via
    // CSSOM; drop it so centring still applies.
    if (!el.style.justifyContent && /^(?:safe|unsafe)\s/.test(value)) {
      el.style.setProperty("justify-content", value.replace(/^(?:safe|unsafe)\s+/, ""));
    }
  }

  function readSlideAlign(slide) {
    // Prefer an explicit inline choice; otherwise read the effective value from
    // computed style so the control mirrors what the audience will see. Anything
    // that isn't centred (flex-start / start / normal / …) reads as "top".
    let val = slide.style.justifyContent;
    if (!val) {
      const win = slide.ownerDocument && slide.ownerDocument.defaultView;
      if (win) val = win.getComputedStyle(slide).justifyContent || "";
    }
    return /center/.test(val) ? "center" : "top";
  }

  function applySlideAlign(index, align) {
    const idoc = Editor.ui.deckFrame && Editor.ui.deckFrame.contentDocument;
    if (!idoc) return;
    const live = Slides.detectSlides(idoc)[index];
    if (!live) return;
    const value = align === "top" ? SLIDE_ALIGN_TOP : SLIDE_ALIGN_CENTER;
    // No-op only when this exact value is already the inline style. We compare
    // the inline value (not the effective/computed one) so a slide centred only
    // by the deck's own stylesheet — i.e. plain `center`, which clips tall
    // content — still gets upgraded to the overflow-safe `safe center`.
    if ((live.style.justifyContent || "").trim() === value) return;
    if (global.History) History.push();
    setJustifyContent(live, value);
    // Mirror onto the parsed deck document so the left-rail thumbnail repaints
    // with the new alignment (thumbnails are cloned from Editor.state.slides).
    const mirror = Editor.state.slides && Editor.state.slides[index];
    if (mirror) setJustifyContent(mirror, value);
    Editor.markDirty();
    if (global.Slides) Slides.rebuildThumbsOnly();
  }

  // === Per-slide full-bleed background image ===========================
  // Stored as inline styles on the slide element itself, so it only ever
  // affects that one slide — never the deck stylesheet or other pages.
  const SLIDE_BG_PROPS = ["background-image", "background-size", "background-position", "background-repeat"];

  function slideHasBgImage(slide) {
    return !!(slide && slide.style && slide.style.backgroundImage);
  }

  // Apply to both the live iframe slide and its deckDoc mirror (like
  // applySlideAlign) so thumbnails and structural reloads keep the change.
  function setSlideBgImage(index, dataUrl) {
    const idoc = Editor.ui.deckFrame && Editor.ui.deckFrame.contentDocument;
    if (!idoc) return false;
    const live = Slides.detectSlides(idoc)[index];
    if (!live) return false;
    if (global.History) History.push();
    const mirror = Editor.state.slides && Editor.state.slides[index];
    [live, mirror].forEach(s => {
      if (!s) return;
      if (dataUrl) {
        s.style.setProperty("background-image", `url("${dataUrl}")`);
        s.style.setProperty("background-size", "cover");
        s.style.setProperty("background-position", "center");
        s.style.setProperty("background-repeat", "no-repeat");
      } else {
        SLIDE_BG_PROPS.forEach(p => s.style.removeProperty(p));
      }
    });
    Editor.markDirty();
    if (global.Slides) Slides.rebuildThumbsOnly();
    return true;
  }

  // Render the per-slide layout controls (currently vertical alignment) into
  // the right-hand inspector. Called from Slides.activate when a slide becomes
  // the active selection, so the inspector reflects the slide, not a block.
  function showSlideProps(slide, index) {
    if (!slide) return;
    const panel = clearProps();
    const current = readSlideAlign(slide);
    // justify-content only moves content vertically when the slide is a flex
    // column (the ClickDeck / teaching-deck convention). Detect this active
    // slide's real rendered layout; if it isn't a vertical flex, the control
    // can't do anything, so disable it and say why rather than latching a
    // "centred" state that produces no visible change.
    const win = slide.ownerDocument && slide.ownerDocument.defaultView;
    const cs = win ? win.getComputedStyle(slide) : null;
    const display = cs ? cs.display : "";
    const dir = cs ? cs.flexDirection : "";
    const isFlexColumn = (display === "flex" || display === "inline-flex") &&
      (dir === "column" || dir === "column-reverse");
    // Only treat it as unsupported when we can positively see a non-vertical
    // layout; a momentarily hidden (display:none) slide is left enabled.
    const unsupported = !!display && display !== "none" && !isFlexColumn;
    const dis = unsupported ? " disabled" : "";
    const hasBg = slideHasBgImage(slide);
    panel.innerHTML = `
      <div class="target-tag">投影片 · 第 ${index + 1} 張</div>
      <div class="field">
        <span>垂直對齊</span>
        <div class="seg" role="group" aria-label="投影片垂直對齊">
          <button type="button" class="seg-btn" data-align="top" aria-pressed="${current === "top"}"${dis}>靠上對齊</button>
          <button type="button" class="seg-btn" data-align="center" aria-pressed="${current === "center"}"${dis}>上下置中</button>
        </div>
        <p class="hint">${unsupported
          ? "此投影片的版面不是直向排列，垂直對齊不會生效，因此暫不開放。"
          : "「上下置中」會在內容放得下時垂直置中，內容過長時自動靠上並可向下捲動，避免標題被裁切。"}</p>
      </div>
      <div class="field">
        <span>滿版底圖</span>
        <input type="file" id="prop-slide-bg-file" accept="image/*" aria-label="上傳滿版底圖">
        <button type="button" id="prop-slide-bg-remove" class="btn"${hasBg ? "" : " disabled"}>移除滿版底圖</button>
        <p class="hint">上傳的圖片會鋪滿這一頁當背景，只影響這一張投影片，其它頁不受影響。</p>
      </div>
      <p class="placeholder">點擊中間簡報裡的文字、圖片或連結，即可編輯內容。</p>
    `;
    if (!unsupported) {
      panel.querySelectorAll(".seg-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          const align = btn.dataset.align;
          applySlideAlign(index, align);
          panel.querySelectorAll(".seg-btn").forEach(b => {
            b.setAttribute("aria-pressed", String(b.dataset.align === align));
          });
        });
      });
    }
    const bgFile = panel.querySelector("#prop-slide-bg-file");
    const bgRemove = panel.querySelector("#prop-slide-bg-remove");
    bgFile.addEventListener("change", async e => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      try {
        const info = await fileToBase64(f);
        if (setSlideBgImage(index, info.dataUrl)) {
          bgRemove.disabled = false;
          imageResultToast(f, info, `已套用第 ${index + 1} 頁滿版底圖`);
        }
      } catch (err) {
        Editor.toast("底圖套用失敗：" + err.message, "err");
      } finally {
        e.target.value = "";
      }
    });
    bgRemove.addEventListener("click", () => {
      if (setSlideBgImage(index, null)) {
        bgRemove.disabled = true;
        Editor.toast(`已移除第 ${index + 1} 頁滿版底圖`, "ok");
      }
    });
  }

  function showLinkProps(a) {
    const panel = clearProps();
    panel.innerHTML = `
      <div class="target-tag">連結 · &lt;a&gt;</div>
      <p class="hint">連結本身被保護，不會觸發跳轉。要編輯內部文字，點擊連結內的文字。</p>
      <div class="field">
        <span>網址（href）</span>
        <input type="url" id="prop-href" value="${escAttr(a.getAttribute("href") || "")}">
      </div>
      <div class="field">
        <span>開啟方式</span>
        <select id="prop-target">
          <option value="">同視窗</option>
          <option value="_blank">新分頁</option>
        </select>
      </div>
      <div class="field">
        <span>顯示文字</span>
        <input type="text" id="prop-link-text" value="${escAttr(a.textContent)}">
      </div>
      <div class="field">
        <span>文字顏色</span>
        <label class="check"><input type="checkbox" id="prop-link-inherit" /><span>跟隨周圍文字顏色（移除藍色與底線）</span></label>
      </div>
      <div class="field">
        <span>點選提示</span>
        <label class="check"><input type="checkbox" id="prop-link-glow" /><span>滑鼠指到時發亮（提示講者這裡可點）</span></label>
        <div class="glow-colors" id="prop-glow-colors" hidden>
          <span class="glow-colors-label">發亮顏色</span>
          <div class="glow-swatches">
            <label class="glow-swatch glow-swatch-gold"><input type="radio" name="glow-color" value="gold"><span class="glow-dot"></span>金黃</label>
            <label class="glow-swatch glow-swatch-blue"><input type="radio" name="glow-color" value="blue"><span class="glow-dot"></span>藍色</label>
            <label class="glow-swatch glow-swatch-white"><input type="radio" name="glow-color" value="white"><span class="glow-dot"></span>白色</label>
          </div>
        </div>
      </div>
      <div class="field">
        <span>移除連結</span>
        <p class="hint" style="margin:0 0 6px">把這段文字變回普通文字，網址連結會被移除（可用復原還原）。</p>
        <button type="button" id="prop-remove-link" class="btn">取消超連結（保留文字）</button>
      </div>
    `;
    prependGotoSection(panel, a);
    panel.querySelector("#prop-target").value = a.getAttribute("target") || "";
    panel.querySelector("#prop-href").addEventListener("change", e => {
      History.push();
      a.setAttribute("href", e.target.value);
      Editor.markDirty();
    });
    panel.querySelector("#prop-target").addEventListener("change", e => {
      History.push();
      if (e.target.value) a.setAttribute("target", e.target.value);
      else a.removeAttribute("target");
      Editor.markDirty();
    });
    panel.querySelector("#prop-link-text").addEventListener("change", e => {
      History.push();
      a.textContent = e.target.value;
      Editor.markDirty();
      Slides.rebuildThumbsOnly();
    });
    const inheritChk = panel.querySelector("#prop-link-inherit");
    inheritChk.checked = a.style.color === "inherit";
    inheritChk.addEventListener("change", e => {
      History.push();
      if (e.target.checked) {
        // Make the link blend into the surrounding text. !important on the inline
        // style beats the browser-default blue and any deck-level `a {}` rule.
        a.style.setProperty("color", "inherit", "important");
        a.style.setProperty("text-decoration", "none", "important");
      } else {
        a.style.removeProperty("color");
        a.style.removeProperty("text-decoration");
      }
      Editor.markDirty();
      Slides.rebuildThumbsOnly();
    });

    const glowChk = panel.querySelector("#prop-link-glow");
    const glowColors = panel.querySelector("#prop-glow-colors");
    const glowRadios = panel.querySelectorAll('input[name="glow-color"]');
    const reflectGlowColor = () => {
      const cur = getLinkGlowColor(a);
      glowRadios.forEach(r => { r.checked = r.value === cur; });
    };
    const glowOn = a.classList.contains(LINK_GLOW_CLASS);
    glowChk.checked = glowOn;
    glowColors.hidden = !glowOn;
    if (glowOn) {
      // Inspecting an existing glow link: upgrade a possibly-legacy style block
      // so blue/white work, then show which colour is currently applied.
      ensureLinkGlowStyle(a.ownerDocument);
      reflectGlowColor();
    }
    glowChk.addEventListener("change", e => {
      History.push();
      if (e.target.checked) {
        ensureLinkGlowStyle(a.ownerDocument);
        a.classList.add(LINK_GLOW_CLASS);
        setLinkGlowColor(a, getLinkGlowColor(a)); // keep prior colour, else gold
        reflectGlowColor();
        glowColors.hidden = false;
      } else {
        a.classList.remove(LINK_GLOW_CLASS);
        Object.values(LINK_GLOW_COLORS).forEach(c => a.classList.remove(c));
        glowColors.hidden = true;
      }
      Editor.markDirty();
    });
    glowRadios.forEach(radio => {
      radio.addEventListener("change", e => {
        if (!e.target.checked) return;
        History.push();
        ensureLinkGlowStyle(a.ownerDocument);
        setLinkGlowColor(a, e.target.value);
        Editor.markDirty();
      });
    });

    const removeBtn = panel.querySelector("#prop-remove-link");
    removeBtn.addEventListener("click", () => {
      const parent = a.parentNode;
      if (!parent) return;
      History.push();
      // Unwrap the <a>: move its children out in place, drop the anchor itself.
      // This strips the href plus any link-only styling (inherit color, glow
      // class) and turns the run back into plain editable text.
      while (a.firstChild) parent.insertBefore(a.firstChild, a);
      parent.removeChild(a);
      parent.normalize(); // merge the now-adjacent text nodes into one run
      clearProps();
      Editor.markDirty();
      Slides.rebuildThumbsOnly();
      Editor.toast("已取消超連結，文字保留", "ok");
    });
  }

  function escAttr(s) {
    return String(s).replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  // Convert an image File to a base64 data URL, auto-compressing large ones.
  // GIF/SVG are passed through untouched (GIF animation would break on canvas,
  // SVG is already tiny and vector). PNG keeps format to preserve transparency.
  const MAX_DIMENSION = 1920;
  const MAX_SIZE_BYTES = 1 * 1024 * 1024;
  const JPEG_QUALITY = 0.85;

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      if (!file || !file.type || !file.type.startsWith("image/")) {
        reject(new Error("不是圖片檔"));
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("讀取檔案失敗"));
      reader.onload = () => {
        const dataUrl = reader.result;
        const isGif = file.type === "image/gif";
        const isSvg = file.type === "image/svg+xml";
        if (isGif || isSvg || file.size <= MAX_SIZE_BYTES) {
          resolve({ dataUrl, compressed: false, origSize: file.size, finalSize: estimateDataUrlBytes(dataUrl) });
          return;
        }
        const img = new Image();
        img.onload = () => {
          const w = img.naturalWidth, h = img.naturalHeight;
          let tw = w, th = h;
          if (Math.max(w, h) > MAX_DIMENSION) {
            const scale = MAX_DIMENSION / Math.max(w, h);
            tw = Math.round(w * scale);
            th = Math.round(h * scale);
          }
          const canvas = document.createElement("canvas");
          canvas.width = tw;
          canvas.height = th;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, tw, th);
          const outType = file.type === "image/png" ? "image/png" : "image/jpeg";
          const outUrl = canvas.toDataURL(outType, JPEG_QUALITY);
          resolve({ dataUrl: outUrl, compressed: true, origSize: file.size, finalSize: estimateDataUrlBytes(outUrl) });
        };
        img.onerror = () => resolve({ dataUrl, compressed: false, origSize: file.size, finalSize: estimateDataUrlBytes(dataUrl) });
        img.src = dataUrl;
      };
      reader.readAsDataURL(file);
    });
  }

  function estimateDataUrlBytes(dataUrl) {
    const i = dataUrl.indexOf(",");
    const b64len = i >= 0 ? dataUrl.length - i - 1 : dataUrl.length;
    return Math.round(b64len * 0.75);
  }

  function fmtSize(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
    return (n / 1024 / 1024).toFixed(2) + " MB";
  }

  function imageResultToast(f, info, verb) {
    if (info.compressed) {
      Editor.toast(`${verb}（已壓縮 ${fmtSize(info.origSize)} → ${fmtSize(info.finalSize)}）`, "ok");
    } else {
      Editor.toast(`${verb}（${fmtSize(info.finalSize)}）`, "ok");
    }
  }

  function insertImageToCurrentSlide() {
    const st = Editor.state;
    const iframeDoc = Editor.ui.deckFrame && Editor.ui.deckFrame.contentDocument;
    if (!iframeDoc || st.currentIndex < 0) {
      Editor.toast("請先選擇投影片", "err");
      return;
    }
    const iframeSlides = Slides.detectSlides(iframeDoc);
    const slide = iframeSlides[st.currentIndex] || iframeDoc.querySelector(".slide.active");
    if (!slide) {
      Editor.toast("找不到當前投影片", "err");
      return;
    }
    // Capture the selected block NOW — while the OS file dialog is open no
    // pointer events reach the iframe, so the selection can't legitimately
    // change; capturing early guards against it being cleared by the dialog's
    // focus churn. Must live inside the current slide (the selection is
    // sticky and may still point at a block on a previously viewed slide).
    let anchor = (typeof window.__editorGetCurrentBlock === "function")
      ? window.__editorGetCurrentBlock() : null;
    if (anchor && (!slide.contains(anchor) || anchor === slide)) anchor = null;
    const picker = document.createElement("input");
    picker.type = "file";
    picker.accept = "image/*";
    picker.style.display = "none";
    picker.addEventListener("change", async () => {
      const f = picker.files && picker.files[0];
      picker.remove();
      if (!f) return;
      try {
        const info = await fileToBase64(f);
        History.push();
        const img = appendImageToSlide(iframeDoc, slide, info.dataUrl, f.name, anchor);
        showImageProps(img);
        Editor.markDirty();
        Slides.rebuildThumbsOnly();
        imageResultToast(f, info, anchor ? "已插入圖片（在選取區塊下方）" : "已插入圖片");
      } catch (err) {
        Editor.toast("插入圖片失敗：" + err.message, "err");
      }
    });
    document.body.appendChild(picker);
    picker.click();
  }

  // Insert an <img>. With an anchor block, the image lands directly after it
  // (visually right below, inside the same column/container); otherwise it is
  // appended at the end of the slide.
  function appendImageToSlide(iframeDoc, slide, dataUrl, fileName, anchor) {
    const img = iframeDoc.createElement("img");
    img.src = dataUrl;
    img.alt = (fileName || "圖片").replace(/\.[^.]+$/, "");
    // min(480px, 100%): cap at 480px but never overflow a narrow column.
    img.style.maxWidth = "min(480px, 100%)";
    img.style.display = "block";
    img.style.margin = "16px";
    if (anchor && anchor.isConnected && slide.contains(anchor) && anchor !== slide && anchor.parentNode) {
      anchor.parentNode.insertBefore(img, anchor.nextSibling);
    } else {
      slide.appendChild(img);
    }
    attachImageHandlers(img);
    return img;
  }

  function addLinkAroundRange(range, url, doc) {
    const a = doc.createElement("a");
    a.setAttribute("href", url);
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener");
    try {
      range.surroundContents(a);
    } catch (err) {
      const frag = range.extractContents();
      a.appendChild(frag);
      range.insertNode(a);
    }
    attachLinkHandlers(a);
    return a;
  }

  function applyFontSizeToRange(range, size, doc) {
    const span = doc.createElement("span");
    if (size) span.style.fontSize = size + "px";
    try {
      range.surroundContents(span);
    } catch (err) {
      const frag = range.extractContents();
      span.appendChild(frag);
      range.insertNode(span);
    }
    return span;
  }

  function applyFontFamilyToRange(range, family, doc) {
    const span = doc.createElement("span");
    if (family) span.style.fontFamily = family;
    try {
      range.surroundContents(span);
    } catch (err) {
      const frag = range.extractContents();
      span.appendChild(frag);
      range.insertNode(span);
    }
    return span;
  }

  // === Block layout editor: hover toolbar, drag-resize, keyboard shortcuts === //
  // Targets elements whose parent is flex or grid (the natural "column" unit
  // for PPT-style editing). Reorder within parent, resize width, duplicate, delete.

  const MIN_BLOCK_WIDTH = 40;
  const MIN_BLOCK_HEIGHT = 24;

  // Apply a user-chosen explicit width to a content block. Clearing max-width is
  // required: deck stylesheets cap text blocks with a ch-based max-width (e.g.
  // `p { max-width: 92ch }`), and per CSS max-width overrides both `width` and a
  // flex `flex-basis`. Without this, a drag/keyboard width past the cap is
  // silently ignored. Once the user resizes, the explicit width is authoritative.
  function applyBlockWidth(block, px, isFlexRow) {
    block.style.maxWidth = "none";
    if (isFlexRow) block.style.flex = `0 0 ${px}px`;
    else block.style.width = `${px}px`;
  }

  function installBlockEditor(iframeDoc) {
    if (iframeDoc.__editorBlockBound) return;
    iframeDoc.__editorBlockBound = true;

    // Strip any stale overlay/style elements left over from a previous mount.
    // These can re-enter the document if a deck snapshot was serialized while
    // the editor was attached and then re-loaded into a fresh iframe.
    iframeDoc.querySelectorAll(".__editor_block_overlay__").forEach(el => el.remove());
    const oldStyle = iframeDoc.getElementById("__editor_block_style__");
    if (oldStyle) oldStyle.remove();

    const win = iframeDoc.defaultView;

    const style = iframeDoc.createElement("style");
    style.id = "__editor_block_style__";
    style.textContent = `
      .__editor_block_overlay__ {
        position: fixed;
        pointer-events: none;
        z-index: 99998;
        display: none;
        box-sizing: border-box;
      }
      .__editor_block_overlay__[data-visible="true"] { display: block; }
      .__editor_block_outline__ {
        position: absolute;
        inset: 0;
        outline: 2px dashed rgba(59,130,246,.75);
        outline-offset: -1px;
        pointer-events: none;
      }
      .__editor_block_toolbar__ {
        position: absolute;
        top: -34px; right: 0;
        display: flex; gap: 2px;
        background: rgba(30,41,59,.96);
        border-radius: 5px;
        padding: 3px;
        pointer-events: auto;
        user-select: none;
        box-shadow: 0 4px 10px rgba(0,0,0,.25);
        font-family: system-ui, -apple-system, "Microsoft JhengHei", sans-serif;
      }
      .__editor_block_toolbar__ button {
        background: transparent;
        border: none;
        color: #fff;
        font-size: 14px;
        line-height: 1;
        width: 26px; height: 26px;
        cursor: pointer;
        border-radius: 3px;
        padding: 0;
      }
      .__editor_block_toolbar__ button:hover { background: rgba(59,130,246,.55); }
      .__editor_block_toolbar__ button[data-op="delete"]:hover { background: rgba(220,38,38,.7); }
      .__editor_block_toolbar__ .__editor_block_sep__ {
        width: 1px; background: rgba(255,255,255,.2); margin: 2px 1px;
      }
      .__editor_block_resize__ {
        position: absolute;
        top: 0; right: -5px;
        width: 10px; height: 100%;
        cursor: ew-resize;
        pointer-events: auto;
        background: transparent;
      }
      .__editor_block_resize__:hover,
      .__editor_block_resize__[data-active="true"] {
        background: rgba(59,130,246,.35);
      }
      .__editor_block_resize_v__ {
        position: absolute;
        bottom: -5px; left: 0;
        width: 100%; height: 10px;
        cursor: ns-resize;
        pointer-events: auto;
        background: transparent;
      }
      .__editor_block_resize_v__:hover,
      .__editor_block_resize_v__[data-active="true"] {
        background: rgba(59,130,246,.35);
      }
    `;
    iframeDoc.head.appendChild(style);

    const overlay = iframeDoc.createElement("div");
    overlay.className = "__editor_block_overlay__";
    overlay.innerHTML = `
      <div class="__editor_block_outline__"></div>
      <div class="__editor_block_resize__" title="拖曳調整寬度"></div>
      <div class="__editor_block_resize_v__" title="拖曳調整高度"></div>
    `;
    iframeDoc.body.appendChild(overlay);

    let currentBlock = null;
    let suppressHover = false;

    function syncTopButtons() {
      const enabled = !!(currentBlock && currentBlock.isConnected);
      document.querySelectorAll('#block-toolbar button[data-op]').forEach(b => {
        b.disabled = !enabled;
      });
    }

    function isFlexOrGrid(el) {
      if (!el) return null;
      const cs = win.getComputedStyle(el);
      if (cs.display === "flex" || cs.display === "inline-flex") return "flex";
      if (cs.display === "grid" || cs.display === "inline-grid") return "grid";
      return null;
    }

    function findMovableBlock(el) {
      let cur = el;
      while (cur && cur !== iframeDoc.body && cur.nodeType === 1) {
        if (cur.closest && cur.closest(".__editor_block_overlay__")) return null;
        if (cur.getAttribute && cur.getAttribute("contenteditable") === "true") return null;
        // Never treat a slide itself as a movable block — slides are managed by
        // the slide list, not the block toolbar. Deleting one here would wipe
        // an entire page.
        if (cur.classList && cur.classList.contains("slide")) return null;
        const parent = cur.parentElement;
        if (parent) {
          // Direct child of a flex/grid container — the original "column unit".
          if (isFlexOrGrid(parent)) return cur;
          // Also: a block-level element whose parent has multiple element
          // children. Lets users target individual rows (icon / title / desc)
          // inside a normal-block container like `.card`, instead of always
          // jumping up to the nearest flex/grid ancestor.
          if (parent !== iframeDoc.body && parent.children.length > 1) {
            const cs = win.getComputedStyle(cur);
            if (cs.display !== "inline" && cs.display !== "contents") return cur;
          }
        }
        cur = parent;
      }
      return null;
    }

    function positionOverlay(block) {
      if (!block || !block.isConnected) { clearBlock(); return; }
      const r = block.getBoundingClientRect();
      overlay.style.left = r.left + "px";
      overlay.style.top = r.top + "px";
      overlay.style.width = r.width + "px";
      overlay.style.height = r.height + "px";
      overlay.setAttribute("data-visible", "true");
    }

    function showOverlay(block) {
      currentBlock = block;
      positionOverlay(block);
      syncTopButtons();
    }

    // Visual-only fade: keeps currentBlock so top-bar buttons remain enabled
    // ("sticky" — user can travel from iframe to top-bar without losing context).
    function fadeOutline() {
      overlay.removeAttribute("data-visible");
    }

    // Full clear: drops currentBlock and disables top-bar buttons. Used after
    // delete and when block is no longer in the DOM.
    function clearBlock() {
      currentBlock = null;
      overlay.removeAttribute("data-visible");
      syncTopButtons();
    }

    // Selection commit is gated by a short dwell timer. Hover positions the
    // overlay immediately for visual feedback, but `currentBlock` (the toolbar's
    // target) only switches after the cursor lingers on a new block for
    // HOVER_DWELL_MS. Brief hovers during transit — e.g. moving the cursor up
    // to the top-bar toolbar — fire pointerover on intermediate elements but
    // never commit, so the toolbar still acts on the user's intended target.
    const HOVER_DWELL_MS = 220;
    let pendingBlock = null;
    let pendingTimer = null;

    function cancelPending() {
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      pendingBlock = null;
    }

    function schedulePending(block) {
      if (pendingBlock === block && pendingTimer) return;
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingBlock = block;
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        if (pendingBlock && pendingBlock.isConnected) {
          currentBlock = pendingBlock;
          positionOverlay(pendingBlock);
          syncTopButtons();
        }
        pendingBlock = null;
      }, HOVER_DWELL_MS);
    }

    iframeDoc.addEventListener("pointerover", (e) => {
      if (suppressHover) return;
      if (e.target && e.target.closest && e.target.closest(".__editor_block_overlay__")) return;
      const block = findMovableBlock(e.target);
      if (!block) {
        cancelPending();
        fadeOutline();
        return;
      }
      if (block === currentBlock) {
        cancelPending();
        return;
      }
      // Don't move the overlay yet — the dwell timer is what makes the
      // selection visible. This deliberately means the overlay stays put on
      // currentBlock during fast cursor traversal, matching what the user
      // sees as "the thing I picked".
      schedulePending(block);
    });

    // Outline fades when cursor leaves the iframe body, but currentBlock stays
    // so the user can move to the top-bar toolbar without losing the selection.
    // Pending commits are cancelled — anything mid-dwell during the exit was
    // a transit hover, not a deliberate selection.
    iframeDoc.addEventListener("pointerleave", () => {
      if (suppressHover) return;
      cancelPending();
      fadeOutline();
    });
    if (iframeDoc.body) {
      iframeDoc.body.addEventListener("pointerleave", () => {
        if (suppressHover) return;
        cancelPending();
        fadeOutline();
      });
    }

    // Click commits immediately — for users who want to skip the dwell wait
    // or are on touch devices that don't fire hover at all.
    iframeDoc.addEventListener("click", (e) => {
      if (suppressHover) return;
      if (e.target && e.target.closest && e.target.closest(".__editor_block_overlay__")) return;
      const block = findMovableBlock(e.target);
      if (block && block !== currentBlock) {
        cancelPending();
        showOverlay(block);
      }
    }, true);

    // Explicit "select container for this element" — used by click handlers so
    // a single click on e.g. an image immediately exposes the adjustment overlay,
    // without requiring a prior hover (which touch devices don't produce anyway).
    iframeDoc.__editorSelectContainer = (el) => {
      const block = findMovableBlock(el);
      if (block && block !== currentBlock) showOverlay(block);
      else if (block) positionOverlay(block);
    };

    win.addEventListener("scroll", () => currentBlock && positionOverlay(currentBlock), true);
    win.addEventListener("resize", () => currentBlock && positionOverlay(currentBlock));

    // Right-edge drag resize
    const handle = overlay.querySelector(".__editor_block_resize__");
    handle.addEventListener("pointerdown", (e) => {
      if (!currentBlock) return;
      e.preventDefault();
      e.stopPropagation();
      handle.setAttribute("data-active", "true");
      suppressHover = true;
      if (global.History) History.push();
      const block = currentBlock;
      const startWidth = block.getBoundingClientRect().width;
      const startX = e.clientX;
      const parent = block.parentElement;
      const parentCS = win.getComputedStyle(parent);
      const isFlexRow =
        (parentCS.display === "flex" || parentCS.display === "inline-flex") &&
        (parentCS.flexDirection === "row" || parentCS.flexDirection === "row-reverse");

      function onMove(ev) {
        const dx = ev.clientX - startX;
        const newWidth = Math.max(MIN_BLOCK_WIDTH, startWidth + dx);
        applyBlockWidth(block, newWidth, isFlexRow);
        positionOverlay(block);
      }
      function onUp() {
        iframeDoc.removeEventListener("pointermove", onMove);
        iframeDoc.removeEventListener("pointerup", onUp);
        handle.removeAttribute("data-active");
        suppressHover = false;
        if (global.Editor) Editor.markDirty();
        if (global.Slides) Slides.rebuildThumbsOnly();
      }
      iframeDoc.addEventListener("pointermove", onMove);
      iframeDoc.addEventListener("pointerup", onUp);
    });

    // Bottom-edge drag resize (height)
    const handleV = overlay.querySelector(".__editor_block_resize_v__");
    handleV.addEventListener("pointerdown", (e) => {
      if (!currentBlock) return;
      e.preventDefault();
      e.stopPropagation();
      handleV.setAttribute("data-active", "true");
      suppressHover = true;
      if (global.History) History.push();
      const block = currentBlock;
      const startHeight = block.getBoundingClientRect().height;
      const startY = e.clientY;
      const parent = block.parentElement;
      const parentCS = win.getComputedStyle(parent);
      const isFlexColumn =
        (parentCS.display === "flex" || parentCS.display === "inline-flex") &&
        (parentCS.flexDirection === "column" || parentCS.flexDirection === "column-reverse");

      function onMoveV(ev) {
        const dy = ev.clientY - startY;
        const newHeight = Math.max(MIN_BLOCK_HEIGHT, startHeight + dy);
        if (isFlexColumn) block.style.flex = `0 0 ${newHeight}px`;
        else block.style.height = `${newHeight}px`;
        positionOverlay(block);
      }
      function onUpV() {
        iframeDoc.removeEventListener("pointermove", onMoveV);
        iframeDoc.removeEventListener("pointerup", onUpV);
        handleV.removeAttribute("data-active");
        suppressHover = false;
        if (global.Editor) Editor.markDirty();
        if (global.Slides) Slides.rebuildThumbsOnly();
      }
      iframeDoc.addEventListener("pointermove", onMoveV);
      iframeDoc.addEventListener("pointerup", onUpV);
    });

    // Keyboard shortcuts — only Alt+key combos, never plain Delete (Delete must
    // remain available for normal text deletion in contenteditable).
    iframeDoc.addEventListener("keydown", (e) => {
      if (!currentBlock) return;
      if (!e.altKey) return;
      const tgt = e.target;
      if (tgt && (tgt.isContentEditable || (tgt.closest && tgt.closest('[contenteditable="true"]')))) return;
      if (e.key === "ArrowUp") { e.preventDefault(); performOp(currentBlock, "up"); }
      else if (e.key === "ArrowDown") { e.preventDefault(); performOp(currentBlock, "down"); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); performOp(currentBlock, e.shiftKey ? "moveleft" : "left"); }
      else if (e.key === "ArrowRight") { e.preventDefault(); performOp(currentBlock, e.shiftKey ? "moveright" : "right"); }
      else if (e.key === "d" || e.key === "D") { e.preventDefault(); performOp(currentBlock, "duplicate"); }
    });

    function performOp(block, op) {
      const parent = block.parentElement;
      if (!parent) return;

      if (op === "delete") {
        if (!win.confirm("確定刪除這個區塊嗎？")) return;
      }

      if (global.History) History.push();

      if (op === "up") {
        const prev = block.previousElementSibling;
        if (prev) parent.insertBefore(block, prev);
      } else if (op === "down") {
        const next = block.nextElementSibling;
        if (next) parent.insertBefore(next, block);
      } else if (op === "moveleft") {
        // Swap with the previous sibling — in a row/grid layout that's the
        // block to the left. Same DOM op as "up", offered separately so users
        // reordering columns aren't forced to reason about "up = left".
        const prev = block.previousElementSibling;
        if (prev) parent.insertBefore(block, prev);
      } else if (op === "moveright") {
        const next = block.nextElementSibling;
        if (next) parent.insertBefore(next, block);
      } else if (op === "left" || op === "right") {
        const parentCS = win.getComputedStyle(parent);
        const isFlexRow =
          (parentCS.display === "flex" || parentCS.display === "inline-flex") &&
          (parentCS.flexDirection === "row" || parentCS.flexDirection === "row-reverse");
        const curWidth = block.getBoundingClientRect().width;
        const step = Math.max(20, Math.round(curWidth * 0.1));
        const newWidth = Math.max(MIN_BLOCK_WIDTH, curWidth + (op === "right" ? step : -step));
        applyBlockWidth(block, newWidth, isFlexRow);
      } else if (op === "duplicate") {
        const clone = block.cloneNode(true);
        // Strip our edit-time attributes so the clone gets re-scanned cleanly.
        clone.querySelectorAll("[contenteditable]").forEach(n => n.removeAttribute("contenteditable"));
        clone.querySelectorAll("[data-edit-highlight]").forEach(n => n.removeAttribute("data-edit-highlight"));
        if (clone.hasAttribute("data-edit-highlight")) clone.removeAttribute("data-edit-highlight");
        parent.insertBefore(clone, block.nextSibling);
        // Re-scan so the new nodes become editable again.
        scan(iframeDoc);
        currentBlock = clone;
        syncTopButtons();
      } else if (op === "delete") {
        block.remove();
        clearBlock();
      }

      if (global.Editor) Editor.markDirty();
      if (global.Slides) Slides.rebuildThumbsOnly();
      if (currentBlock && currentBlock.isConnected) {
        positionOverlay(currentBlock);
        syncTopButtons();
      } else {
        clearBlock();
      }
    }

    // Route for the top-bar block toolbar (header `#block-toolbar`). currentBlock
    // is closure-scoped here, so we expose a thin function instead of leaking it.
    window.__editorPerformBlockOp = (op) => {
      if (!currentBlock || !currentBlock.isConnected) return;
      performOp(currentBlock, op);
    };

    // Read-only accessor for the currently selected block. Used by
    // insertImageToCurrentSlide to place a new image right below the user's
    // selection instead of at the bottom of the slide.
    window.__editorGetCurrentBlock = () => {
      return (currentBlock && currentBlock.isConnected) ? currentBlock : null;
    };

    syncTopButtons();
  }

  // Bind the top-bar block toolbar once. Buttons route to the current iframe's
  // installBlockEditor closure via window.__editorPerformBlockOp.
  function bindTopBlockToolbar() {
    const toolbar = document.getElementById("block-toolbar");
    if (!toolbar || toolbar.__bound) return;
    toolbar.__bound = true;
    toolbar.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-op]");
      if (!btn || btn.disabled) return;
      e.preventDefault();
      if (typeof window.__editorPerformBlockOp === "function") {
        window.__editorPerformBlockOp(btn.dataset.op);
      }
    });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindTopBlockToolbar);
  } else {
    bindTopBlockToolbar();
  }

  global.Editable = {
    install, scan, showTextProps, showImageProps, showLinkProps,
    showGotoProps, showSlideProps,
    suspendGoto, restoreGoto, cleanupGotoForSerialize,
    cleanupRuntimeFillForSerialize, repairDocumentStructure,
    findGotoHost,
    insertImageToCurrentSlide,
    attachImageHandlers, attachLinkHandlers,
    addLinkAroundRange,
    fileToBase64,
  };

})(window);
