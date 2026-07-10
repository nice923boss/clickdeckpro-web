/* === Slide detection, thumbnails, reorder, delete === */
(function (global) {
  "use strict";

  const SLIDE_SELECTORS = [".slide", "[data-slide]", "section.slide", "[data-title]"];

  function detectSlides(doc) {
    for (const sel of SLIDE_SELECTORS) {
      const found = Array.from(doc.querySelectorAll(sel));
      if (found.length >= 2) return found;
    }
    // Fallback: direct children of a deck container
    const deck = doc.querySelector(".deck, .app, #deck, #app");
    if (deck) {
      const kids = Array.from(deck.children).filter(el => el.tagName === "DIV");
      if (kids.length >= 2) return kids;
    }
    return [];
  }

  function slideLabel(slide, i) {
    // data-title (ClickDeck) or data-label (HoloTeam-style) take precedence over heading text.
    const title = slide.getAttribute("data-title") || slide.getAttribute("data-label");
    if (title) return title;
    const h = slide.querySelector("h1, h2, h3");
    if (h && h.textContent.trim()) return h.textContent.trim().slice(0, 24);
    return "投影片 " + (i + 1);
  }

  function buildThumb(liEl, slide, doc) {
    const thumb = liEl.querySelector(".thumb");
    thumb.innerHTML = "";
    const host = document.createElement("div");
    host.className = "thumb-frame";
    // Shadow DOM isolates the slide's CSS so it cannot leak into the editor
    // chrome (.stage / .slide / etc.). Without this, every loaded deck adds
    // a `<style>` whose `.stage { width: 100vw }` rule overrides the editor's
    // own `.stage` and pushes the preview off-center.
    const root = host.attachShadow({ mode: "open" });
    const container = document.createElement("div");
    container.style.cssText = "position:absolute;inset:0;background:#fff;overflow:hidden;width:1920px;height:1080px;";
    const head = doc.querySelector("head");
    if (head) {
      head.querySelectorAll("style, link[rel=stylesheet]").forEach(s => {
        root.appendChild(s.cloneNode(true));
      });
    }
    const slideClone = slide.cloneNode(true);
    slideClone.style.position = "absolute";
    slideClone.style.inset = "0";
    slideClone.style.width = "1920px";
    slideClone.style.height = "1080px";
    slideClone.style.display = "flex";
    slideClone.style.opacity = "1";
    slideClone.style.transform = "none";
    slideClone.style.filter = "none";
    slideClone.style.pointerEvents = "none";
    slideClone.classList.add("active");
    container.appendChild(slideClone);
    root.appendChild(container);
    thumb.appendChild(host);

    // Scale the container after layout so the 1920x1080 stage fits the thumb.
    requestAnimationFrame(() => {
      const rect = thumb.getBoundingClientRect();
      const scale = Math.min(rect.width / 1920, rect.height / 1080);
      container.style.transformOrigin = "top left";
      container.style.transform = `scale(${scale})`;
    });
  }

  function activate(i) {
    const st = Editor.state;
    const doc = st.deckDoc;
    if (!doc || !st.slides[i]) return;
    st.currentIndex = i;

    // Toggle slide classes on the live iframe document. Decks use different
    // conventions: legacy ones rely on `.active`; many recent templates use
    // `.is-active` (BEM) and also distinguish a `.is-prev` for outgoing
    // animations. We mirror both to maximise compatibility, then delegate to
    // the deck's own navigation function if it exposes one so its internal
    // state (progress bar, nav dots, TOC highlight) updates too.
    const iframeDoc = Editor.ui.deckFrame.contentDocument;
    const iframeWin = Editor.ui.deckFrame.contentWindow;
    if (iframeDoc) {
      const iframeSlides = detectSlides(iframeDoc);

      let deckHandled = false;
      if (iframeWin) {
        // "show" sits at the tail because it's the most ambiguous name — a
        // deck that defines its own goTo/goToSlide etc. takes precedence,
        // and only HoloTeam-style decks that expose a single `show(idx)`
        // fall through to it.
        for (const fnName of ["goTo", "goToSlide", "showSlide", "setSlide", "navigateTo", "show"]) {
          const fn = iframeWin[fnName];
          if (typeof fn === "function") {
            try { fn.call(iframeWin, i); deckHandled = true; break; }
            catch (_) { /* ignore and fall back to manual class toggle */ }
          }
        }
      }

      if (!deckHandled) {
        iframeSlides.forEach((s, idx) => {
          s.classList.remove("active", "is-active", "is-prev");
          if (idx === i) s.classList.add("active", "is-active");
          else if (idx < i) s.classList.add("is-prev");
        });
      }

      // Day series counter / progress bar mirroring (only if deck didn't
      // already update them via its own goTo).
      if (!deckHandled) {
        // Support both "cur" (ClickDeck convention) and "curr" (HoloTeam-style).
        // Preserve leading-zero padding ("01" → "05") if the original used it.
        const counters = ["cur", "curr"]
          .map(id => iframeDoc.getElementById(id))
          .filter(Boolean);
        counters.forEach(node => {
          const orig = (node.textContent || "").trim();
          const padded = /^0\d/.test(orig);
          node.textContent = padded ? String(i + 1).padStart(orig.length, "0") : String(i + 1);
        });
        const prog = iframeDoc.getElementById("progress");
        const total = iframeDoc.getElementById("total");
        if (prog && total) {
          const t = parseInt(total.textContent, 10) || iframeSlides.length;
          prog.style.width = ((i + 1) / t * 100) + "%";
        }
      }
    }

    // Update list highlight and focus so keyboard shortcuts (Ctrl+C/X/V) target this slide.
    Editor.ui.slideList.querySelectorAll("li").forEach((li, idx) => {
      li.classList.toggle("active", idx === i);
    });
    const activeLi = Editor.ui.slideList.querySelector(`li[data-index="${i}"]`);
    if (activeLi && document.activeElement !== activeLi) {
      // Don't steal focus if the user is currently typing somewhere else.
      const ae = document.activeElement;
      const inInput = ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable);
      if (!inInput) activeLi.focus({ preventScroll: true });
    }

    // Reflect the active slide's layout options (e.g. vertical alignment) in the
    // right inspector. Skipped when the iframe still holds a *different* deck —
    // during a file switch contentDocument briefly points at the previous (or
    // blank) deck, whose slide count won't match the freshly rebuilt state.slides;
    // core.renderDeckIntoFrame's onload re-runs this once the new deck is live.
    if (window.Editable && Editable.showSlideProps && iframeDoc) {
      const liveSlides = detectSlides(iframeDoc);
      if (liveSlides.length === Editor.state.slides.length && liveSlides[i]) {
        Editable.showSlideProps(liveSlides[i], i);
      }
    }
  }

  function rebuild() {
    const st = Editor.state;
    const doc = st.deckDoc;
    const list = Editor.ui.slideList;
    list.innerHTML = "";
    st.slides = detectSlides(doc);
    st.slides.forEach((slide, i) => {
      const li = document.createElement("li");
      li.dataset.index = i;
      li.draggable = true;
      li.tabIndex = 0;
      li.innerHTML = `
        <div class="thumb"></div>
        <div class="label"><span>${i + 1}. ${escapeHtml(slideLabel(slide, i))}</span>
          <button class="del" title="刪除此投影片">✕</button></div>
      `;
      li.addEventListener("click", (e) => {
        if (e.target.classList.contains("del")) return;
        activate(i);
      });
      li.querySelector(".del").addEventListener("click", (e) => {
        e.stopPropagation();
        deleteSlide(i);
      });
      // Drag and drop reorder
      li.addEventListener("dragstart", (e) => {
        li.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(i));
      });
      li.addEventListener("dragend", () => {
        li.classList.remove("dragging");
        list.querySelectorAll("li").forEach(x => x.classList.remove("drag-over"));
      });
      li.addEventListener("dragover", (e) => {
        e.preventDefault();
        li.classList.add("drag-over");
      });
      li.addEventListener("dragleave", () => {
        li.classList.remove("drag-over");
      });
      li.addEventListener("drop", (e) => {
        e.preventDefault();
        const from = parseInt(e.dataTransfer.getData("text/plain"), 10);
        const to = i;
        if (Number.isInteger(from) && from !== to) moveSlide(from, to);
      });
      list.appendChild(li);
      buildThumb(li, slide, doc);
    });
    if (st.slides.length && st.currentIndex < 0) activate(0);
    else if (st.currentIndex >= st.slides.length) activate(st.slides.length - 1);
    else if (st.currentIndex >= 0) activate(st.currentIndex);
  }

  function rebuildThumbsOnly() {
    const st = Editor.state;
    const list = Editor.ui.slideList;
    Array.from(list.children).forEach((li, i) => {
      if (st.slides[i]) buildThumb(li, st.slides[i], st.deckDoc);
    });
  }

  function deleteSlide(i) {
    const st = Editor.state;
    if (!st.slides[i]) return;
    if (st.slides.length <= 1) {
      Editor.toast("至少保留一張投影片", "err");
      return;
    }
    if (!confirm(`確定刪除第 ${i + 1} 張投影片？`)) return;
    History.push();
    Editor.syncDeckFromIframe();
    const fresh = detectSlides(st.deckDoc);
    if (!fresh[i]) return;
    fresh[i].remove();
    Editor.markDirty();
    reloadFrame(() => {
      if (st.currentIndex >= fresh.length - 1) st.currentIndex = 0;
      rebuild();
    });
  }

  function moveSlide(from, to) {
    const st = Editor.state;
    History.push();
    Editor.syncDeckFromIframe();
    const fresh = detectSlides(st.deckDoc);
    if (!fresh[from] || !fresh[to]) return;
    const fromEl = fresh[from];
    const toEl = fresh[to];
    if (from < to) {
      toEl.parentNode.insertBefore(fromEl, toEl.nextSibling);
    } else {
      toEl.parentNode.insertBefore(fromEl, toEl);
    }
    Editor.markDirty();
    reloadFrame(() => {
      st.currentIndex = to;
      rebuild();
    });
  }

  function insertSlide(slideElement, afterIndex) {
    const st = Editor.state;
    History.push();
    Editor.syncDeckFromIframe();
    const fresh = detectSlides(st.deckDoc);
    // Ensure the slide element belongs to state.deckDoc.
    const node = (slideElement.ownerDocument === st.deckDoc)
      ? slideElement
      : st.deckDoc.importNode(slideElement, true);
    if (!fresh.length) {
      const container = st.deckDoc.querySelector(".deck, .app, #deck, #app, body");
      container.appendChild(node);
    } else {
      const anchor = fresh[Math.min(afterIndex, fresh.length - 1)];
      anchor.parentNode.insertBefore(node, anchor.nextSibling);
    }
    Editor.markDirty();
    reloadFrame(() => {
      st.currentIndex = afterIndex + 1;
      rebuild();
    });
  }

  function copySelected() {
    const st = Editor.state;
    const idoc = Editor.ui.deckFrame.contentDocument;
    if (!idoc || st.currentIndex < 0) {
      Editor.toast("請先選取投影片", "err");
      return;
    }
    const iframeSlides = detectSlides(idoc);
    const slide = iframeSlides[st.currentIndex];
    if (!slide) return;
    // Clone and strip editor-injected attrs before storing
    const clone = slide.cloneNode(true);
    clone.querySelectorAll("[data-edit-highlight]").forEach(el => el.removeAttribute("data-edit-highlight"));
    clone.querySelectorAll("[contenteditable]").forEach(el => el.removeAttribute("contenteditable"));
    st.clipboardSlide = clone.outerHTML;
    Editor.toast(`已複製第 ${st.currentIndex + 1} 張投影片`, "ok");
  }

  function cutSelected() {
    const st = Editor.state;
    if (st.currentIndex < 0) {
      Editor.toast("請先選取投影片", "err");
      return;
    }
    if (st.slides.length <= 1) {
      Editor.toast("至少保留一張投影片", "err");
      return;
    }
    copySelected();
    History.push();
    Editor.syncDeckFromIframe();
    const fresh = detectSlides(st.deckDoc);
    const i = st.currentIndex;
    if (!fresh[i]) return;
    fresh[i].remove();
    Editor.markDirty();
    reloadFrame(() => {
      if (st.currentIndex >= fresh.length - 1) st.currentIndex = 0;
      rebuild();
    });
  }

  function pasteAfterSelected() {
    const st = Editor.state;
    if (!st.clipboardSlide) {
      Editor.toast("剪貼簿沒有投影片", "err");
      return;
    }
    const parser = new DOMParser();
    const tmp = parser.parseFromString(st.clipboardSlide, "text/html");
    const el = tmp.body.firstElementChild;
    if (!el) {
      Editor.toast("剪貼簿內容無法解析", "err");
      return;
    }
    const at = Math.max(st.currentIndex, 0);
    insertSlide(el, at);
    Editor.toast("已貼上投影片", "ok");
  }

  function reloadFrame(after) {
    const st = Editor.state;
    const iframe = Editor.ui.deckFrame;
    // Route through Editor.buildIframeSrc so the in-memory storage polyfill
    // is injected on structural reloads too — otherwise reordering / deleting
    // a slide would briefly let the deck's native localStorage write through.
    const html = Editor.buildIframeSrc(st.deckDoc);
    iframe.onload = () => {
      Editable.install(iframe.contentDocument);
      attachClickNav(iframe.contentDocument);
      attachKeyboard(iframe.contentDocument);
      Editor.fitFrameToStage();
      if (after) after();
    };
    iframe.srcdoc = html;
  }

  function attachKeyboard(doc) {
    const NAV_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " ", "Spacebar", "PageUp", "PageDown", "Home", "End"]);
    const handler = (e) => {
      const t = e.target;
      const inEditable = t && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");

      // Edit mode + inside an editable: swallow ALL key events at capture
      // phase so the deck's own keydown handlers (which often hijack
      // Backspace/Enter/F/? for slide navigation) can't fire. Crucially we do
      // NOT preventDefault — the browser's native contenteditable behavior
      // (typing, Backspace/Delete, Ctrl+Z) still needs to run.
      if (Editor.state.editMode && inEditable) {
        e.stopPropagation();
        e.stopImmediatePropagation();
        return;
      }

      // Edit mode + outside editable: stop nav keys so stray arrow/space
      // presses don't accidentally paginate the deck.
      if (Editor.state.editMode && NAV_KEYS.has(e.key)) {
        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();
        return;
      }

      if (inEditable) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) { e.preventDefault(); window.parent.History.undo(); }
      else if (key === "y" || (key === "z" && e.shiftKey)) { e.preventDefault(); window.parent.History.redo(); }
    };
    // Capture phase so we run before the deck's own bubble-phase listeners.
    doc.addEventListener("keydown", handler, true);
    if (doc.defaultView) doc.defaultView.addEventListener("keydown", handler, true);
  }

  function attachClickNav(doc) {
    // When editMode is on, swallow clicks on blank deck area so the deck's
    // click-to-advance handler (usually a bubble-phase listener on document)
    // never fires. Interactive targets — buttons, links, form controls,
    // inline onclick, editable text — are allowed through unchanged.
    doc.addEventListener("click", (e) => {
      if (!Editor.state.editMode) return;
      const t = e.target;
      if (!t || !t.closest) return;

      // Clicks on (or inside) a suspended goTo host. Editable.suspendGoto
      // already stripped the inline onclick at edit-mode entry, so the deck
      // won't paginate either way. We still swallow the event so deck-level
      // listeners (progress bars, dots) don't react, then route to the goto
      // inspector when the click hit the host frame itself.
      const gotoHost = t.closest("[data-edit-goto-bound]");
      if (gotoHost) {
        const editableTarget = t.closest("[data-edit-highlight]");
        // If the click landed inside an editable text/image descendant we
        // let editable.js own the click — its showXxxProps already prepends
        // the goto field at the top of the panel.
        if (editableTarget && gotoHost.contains(editableTarget)) return;
        e.stopPropagation();
        if (window.Editable && Editable.showGotoProps) {
          Editable.showGotoProps(gotoHost);
        }
        return;
      }

      if (t.closest("button, a, input, textarea, select, [onclick], [data-edit-highlight], [contenteditable='true']")) return;
      e.stopPropagation();
    }, true);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  global.Slides = {
    detectSlides, rebuild, rebuildThumbsOnly, activate,
    deleteSlide, moveSlide, insertSlide,
    copySelected, cutSelected, pasteAfterSelected,
    attachClickNav, attachKeyboard, reloadFrame,
  };

})(window);
