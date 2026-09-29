/* === Undo / Redo via full-document DOM snapshots === */
(function (global) {
  "use strict";

  const MAX_SIZE = 50;
  const undoStack = [];
  const redoStack = [];

  // Large inline scripts (engines, base64 image tables) are identical in every
  // snapshot, so each one is stored once here and snapshots keep a token.
  const SCRIPT_POOL_MIN = 10000;
  const scriptPool = [];
  const scriptPoolIndex = new Map();
  const SCRIPT_TOKEN_RE = /\/\*__clickdeck_history_script_(\d+)__\*\//g;

  function poolScripts(clone) {
    clone.querySelectorAll("script").forEach(s => {
      const text = s.textContent;
      if (text.length < SCRIPT_POOL_MIN) return;
      let n = scriptPoolIndex.get(text);
      if (n === undefined) {
        n = scriptPool.push(text) - 1;
        scriptPoolIndex.set(text, n);
      }
      s.textContent = `/*__clickdeck_history_script_${n}__*/`;
    });
  }

  function captureState() {
    const iframe = Editor.ui.deckFrame;
    if (!iframe || !iframe.contentDocument || !iframe.contentDocument.documentElement) {
      return null;
    }
    // Clone and strip editor-injected artifacts so restored snapshots don't
    // accumulate double-injection styling/attributes/polyfills. Runtime DOM
    // (backdrop layers, rendered cards) goes back to its source shape too,
    // otherwise the deck renders it a second time after undo.
    const live = iframe.contentDocument.documentElement;
    const clone = live.cloneNode(true);
    const runtimePairs = RuntimeBaseline.pair(live, clone);
    Editor.stripEditorInjections(clone);
    RuntimeBaseline.restore(runtimePairs);
    poolScripts(clone);
    return {
      html: clone.outerHTML,
      currentIndex: Editor.state.currentIndex,
    };
  }

  function push() {
    const s = captureState();
    if (!s) return;
    const top = undoStack[undoStack.length - 1];
    if (top && top.html === s.html) return;
    undoStack.push(s);
    if (undoStack.length > MAX_SIZE) undoStack.shift();
    redoStack.length = 0;
  }

  function restore(snapshot) {
    if (!snapshot) return;
    const parser = new DOMParser();
    const html = snapshot.html.replace(SCRIPT_TOKEN_RE, (_, n) => scriptPool[n]);
    const doc = parser.parseFromString("<!DOCTYPE html>\n" + html, "text/html");
    Editor.state.deckDoc = doc;
    Editor.state.currentIndex = snapshot.currentIndex;
    const iframe = Editor.ui.deckFrame;
    iframe.onload = () => {
      Editable.install(iframe.contentDocument);
      Slides.attachClickNav(iframe.contentDocument);
      Slides.attachKeyboard(iframe.contentDocument);
      Slides.watchActiveSlide(iframe.contentDocument);
      Editor.fitFrameToStage();
      Slides.rebuild();
    };
    // Route through buildIframeSrc so the storage polyfill is re-injected on
    // every restore (the captured snapshot itself has it stripped).
    iframe.srcdoc = Editor.buildIframeSrc(doc);
    Editor.markDirty();
  }

  function undo() {
    if (!undoStack.length) {
      Editor.toast("沒有可復原的操作", "err");
      return;
    }
    const current = captureState();
    if (current) redoStack.push(current);
    const prev = undoStack.pop();
    restore(prev);
    Editor.toast("已復原", "ok");
  }

  function redo() {
    if (!redoStack.length) {
      Editor.toast("沒有可重做的操作", "err");
      return;
    }
    const current = captureState();
    if (current) undoStack.push(current);
    const next = redoStack.pop();
    restore(next);
    Editor.toast("已重做", "ok");
  }

  function clear() {
    undoStack.length = 0;
    redoStack.length = 0;
    scriptPool.length = 0;
    scriptPoolIndex.clear();
  }

  function sizes() {
    return { undo: undoStack.length, redo: redoStack.length };
  }

  global.History = { push, undo, redo, clear, sizes, capture: captureState };

})(window);
