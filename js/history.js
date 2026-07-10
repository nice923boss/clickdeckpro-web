/* === Undo / Redo via full-document DOM snapshots === */
(function (global) {
  "use strict";

  const MAX_SIZE = 50;
  const undoStack = [];
  const redoStack = [];

  function captureState() {
    const iframe = Editor.ui.deckFrame;
    if (!iframe || !iframe.contentDocument || !iframe.contentDocument.documentElement) {
      return null;
    }
    // Clone and strip editor-injected artifacts so restored snapshots don't
    // accumulate double-injection styling/attributes/polyfills.
    const clone = iframe.contentDocument.documentElement.cloneNode(true);
    Editor.stripEditorInjections(clone);
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
    const doc = parser.parseFromString("<!DOCTYPE html>\n" + snapshot.html, "text/html");
    Editor.state.deckDoc = doc;
    Editor.state.currentIndex = snapshot.currentIndex;
    const iframe = Editor.ui.deckFrame;
    iframe.onload = () => {
      Editable.install(iframe.contentDocument);
      Slides.attachClickNav(iframe.contentDocument);
      Slides.attachKeyboard(iframe.contentDocument);
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
  }

  function sizes() {
    return { undo: undoStack.length, redo: redoStack.length };
  }

  global.History = { push, undo, redo, clear, sizes, capture: captureState };

})(window);
