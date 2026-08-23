/* === Editor core: state, load, save, wiring === */
(function (global) {
  "use strict";

  const state = {
    fileName: null,
    deckDoc: null,        // parsed Document of the loaded HTML
    slides: [],           // array of slide DOM elements inside deckDoc
    currentIndex: -1,
    dirty: false,
    deckCssVars: {},      // map of :root var name -> value
    clipboardSlide: null, // outerHTML of the most recently copied/cut slide
    editMode: true,       // when true, clicks on blank area won't advance the deck
    revealHidden: false,  // when true, click-to-reveal answer text is forced visible for editing
    dirHandle: null,      // FileSystemDirectoryHandle when user picks a folder
    fileHandle: null,     // FileSystemFileHandle for the currently loaded file
    zoomLevel: 1.0,       // multiplier on top of auto-fit scale; 1.0 = fit, 1.5 = 150%
  };

  // Zoom bounds. Below 0.5 the preview becomes unreadable, above 4 there's
  // little practical use and scrolling around becomes painful.
  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 4.0;
  const ZOOM_STEP = 1.1; // multiplicative — geometric steps feel smoother than fixed +10%

  const ui = {};

  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return Array.from(document.querySelectorAll(sel)); }

  function toast(msg, kind) {
    const el = ui.toast;
    el.className = "toast " + (kind || "");
    el.textContent = msg;
    el.classList.remove("hidden");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add("hidden"), 2800);
  }

  function markDirty() {
    state.dirty = true;
    ui.dirtyFlag.classList.remove("hidden");
  }

  function clearDirty() {
    state.dirty = false;
    ui.dirtyFlag.classList.add("hidden");
  }

  function setButtonsEnabled(enabled) {
    ["btnSave", "btnSaveAs", "btnNewSlide", "btnInsertImg", "btnSaveAsTpl", "btnStyle", "btnPreview",
     "btnRepairDoc",
     "btnZoomIn", "btnZoomOut", "btnZoomReset"].forEach(k => {
      if (ui[k]) ui[k].disabled = !enabled;
    });
  }

  async function refreshLibrary() {
    if (state.dirHandle) {
      await populateDropdownFromHandle(state.dirHandle);
      return;
    }
    // Static build (GitHub Pages): no local server, so there is no folder to
    // auto-list. Decks are opened through the folder / file pickers instead.
    ui.librarySelect.innerHTML = '<option value="">（請先按「選擇資料夾」或「選擇檔案」）</option>';
  }

  async function populateDropdownFromHandle(dirHandle) {
    const names = [];
    for await (const entry of dirHandle.values()) {
      if (entry.kind === "file" && /\.html?$/i.test(entry.name)) {
        names.push(entry.name);
      }
    }
    names.sort((a, b) => a.localeCompare(b, "zh-Hant"));
    ui.librarySelect.innerHTML = '<option value="">（選擇檔案）</option>';
    names.forEach(n => {
      const opt = document.createElement("option");
      opt.value = n;
      opt.textContent = n;
      ui.librarySelect.appendChild(opt);
    });
  }

  async function pickDirectory() {
    if (!window.showDirectoryPicker) {
      toast("此瀏覽器不支援原生資料夾選擇（請使用 Chrome 或 Edge）", "err");
      return;
    }
    if (state.dirty && !confirm("目前有未儲存的變更，確定要切換資料夾嗎？")) return;
    try {
      const handle = await window.showDirectoryPicker({ mode: "readwrite" });
      let perm = await handle.queryPermission({ mode: "readwrite" });
      if (perm !== "granted") perm = await handle.requestPermission({ mode: "readwrite" });
      if (perm !== "granted") {
        toast("未取得此資料夾的寫入權限", "err");
        return;
      }
      state.dirHandle = handle;
      state.fileHandle = null;
      state.fileName = null;
      ui.folderLabel.textContent = handle.name;
      ui.folderLabel.title = handle.name;
      await populateDropdownFromHandle(handle);
      toast("已切換資料夾：" + handle.name, "ok");
    } catch (e) {
      if (e && e.name === "AbortError") return;
      toast("選擇資料夾失敗：" + e.message, "err");
    }
  }

  async function pickFile() {
    if (!window.showOpenFilePicker) {
      toast("此瀏覽器不支援原生檔案選擇（請使用 Chrome 或 Edge）", "err");
      return;
    }
    if (state.dirty && !confirm("目前有未儲存的變更，確定要切換檔案嗎？")) return;
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{
          description: "HTML 檔",
          accept: { "text/html": [".html", ".htm"] },
        }],
        multiple: false,
      });
      let perm = await handle.queryPermission({ mode: "readwrite" });
      if (perm !== "granted") perm = await handle.requestPermission({ mode: "readwrite" });
      if (perm !== "granted") {
        toast("未取得此檔案的寫入權限", "err");
        return;
      }
      state.dirHandle = null;
      state.fileHandle = handle;
      const file = await handle.getFile();
      const name = file.name;
      ui.librarySelect.innerHTML = "";
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      ui.librarySelect.appendChild(opt);
      ui.librarySelect.value = name;
      ui.folderLabel.textContent = "📄 單一檔案";
      ui.folderLabel.title = "單一檔案模式：存檔將直接覆蓋此檔（無 .bak 備份）";
      await loadFromFileHandle(handle, name);
    } catch (e) {
      if (e && e.name === "AbortError") return;
      toast("選擇檔案失敗：" + e.message, "err");
    }
  }

  function autoRepairOnLoad() {
    // Legacy decks (no data-clickdeck-runtime marker) freeze their runtime-built
    // dots / TOC into the saved HTML; on the next open the deck's own script
    // appends another full set and the counts double every save cycle. Normalize
    // the freshly parsed doc on load — strip accumulated runtime-fill children
    // and stamp the marker — so the deck opens at the correct count and every
    // later save stays clean via cleanupRuntimeFillForSerialize. CSS centering is
    // left off (css:false) so opening a file never silently rewrites its
    // stylesheet; that stays a manual action. Silent: no toast / History / dirty,
    // because this is load-time normalization, not a user edit.
    if (!state.deckDoc || !window.Editable || !Editable.repairDocumentStructure) return;
    const slidesCount = state.deckDoc.querySelectorAll(".slide").length;
    if (slidesCount === 0) return;
    Editable.repairDocumentStructure(state.deckDoc, slidesCount, { css: false });
  }

  async function loadFromFileHandle(handle, name) {
    try {
      const file = await handle.getFile();
      const content = await file.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(content, "text/html");
      state.fileName = name;
      state.deckDoc = doc;
      autoRepairOnLoad();
      renderDeckIntoFrame();
      Slides.rebuild();
      StyleEditor.readVarsFromDeck();
      History.clear();
      clearDirty();
      setButtonsEnabled(true);
      ui.stageEmpty.classList.add("hidden");
      toast("已載入：" + name, "ok");
    } catch (e) {
      toast("載入失敗：" + e.message, "err");
    }
  }

  async function loadFile(name) {
    if (!name) return;
    if (state.dirty && !confirm("目前有未儲存的變更，確定要放棄並切換檔案嗎？")) {
      ui.librarySelect.value = state.fileName || "";
      return;
    }
    try {
      let content;
      if (state.dirHandle) {
        const fh = await state.dirHandle.getFileHandle(name);
        const file = await fh.getFile();
        content = await file.text();
        state.fileHandle = fh;
      } else if (state.fileHandle) {
        // Single-file mode: re-read from the already-picked handle.
        content = await (await state.fileHandle.getFile()).text();
      } else {
        toast("請先按「選擇資料夾」或「選擇檔案」載入簡報", "warn");
        return;
      }
      const parser = new DOMParser();
      const doc = parser.parseFromString(content, "text/html");
      state.fileName = name;
      state.deckDoc = doc;
      autoRepairOnLoad();
      renderDeckIntoFrame();
      Slides.rebuild();
      StyleEditor.readVarsFromDeck();
      History.clear();
      clearDirty();
      setButtonsEnabled(true);
      ui.stageEmpty.classList.add("hidden");
      toast("已載入：" + name, "ok");
    } catch (e) {
      toast("載入失敗：" + e.message, "err");
    }
  }

  // Storage polyfill injected at the top of the iframe head. Decks may persist
  // reading position via localStorage / sessionStorage (HoloTeam-style); without
  // this shim the editor's parent origin gets polluted AND opening the editor
  // jumps to whatever slide playback last left off on. The shim is in-memory
  // only, so writes vanish when the iframe reloads — exactly the behavior we
  // want for an editor session.
  const STORAGE_POLYFILL_SRC = "" +
    "(function(){try{" +
    "function makeStore(){" +
    "var mem=Object.create(null);" +
    "var store={" +
    "getItem:function(k){return Object.prototype.hasOwnProperty.call(mem,k)?mem[k]:null;}," +
    "setItem:function(k,v){mem[k]=String(v);}," +
    "removeItem:function(k){delete mem[k];}," +
    "clear:function(){for(var k in mem)delete mem[k];}," +
    "key:function(i){return Object.keys(mem)[i]||null;}" +
    "};" +
    "Object.defineProperty(store,'length',{get:function(){return Object.keys(mem).length;}});" +
    "return store;" +
    "}" +
    "try{Object.defineProperty(window,'localStorage',{value:makeStore(),configurable:true});}catch(_){}" +
    "try{Object.defineProperty(window,'sessionStorage',{value:makeStore(),configurable:true});}catch(_){}" +
    "}catch(_){}})();";

  function buildIframeSrc(doc) {
    // Clone documentElement so polyfill injection never mutates state.deckDoc.
    const clone = doc.documentElement.cloneNode(true);
    const head = clone.querySelector("head");
    if (head) {
      const polyfill = doc.createElement("script");
      polyfill.id = "__editor_storage_polyfill__";
      polyfill.textContent = STORAGE_POLYFILL_SRC;
      head.insertBefore(polyfill, head.firstChild);
    }
    return "<!DOCTYPE html>\n" + clone.outerHTML;
  }

  function stripEditorInjections(clone) {
    // Remove anything the editor injected into the iframe so it never lands
    // in the saved file. Called from both serializeDeck (save) and
    // syncDeckFromIframe (structural ops).
    clone.querySelectorAll("[data-edit-highlight]").forEach(el => el.removeAttribute("data-edit-highlight"));
    clone.querySelectorAll("[contenteditable]").forEach(el => el.removeAttribute("contenteditable"));
    const injected = clone.querySelector("#__editor_style__");
    if (injected) injected.remove();
    const blockStyle = clone.querySelector("#__editor_block_style__");
    if (blockStyle) blockStyle.remove();
    const storagePoly = clone.querySelector("#__editor_storage_polyfill__");
    if (storagePoly) storagePoly.remove();
    clone.querySelectorAll(".__editor_block_overlay__").forEach(el => el.remove());
    // "顯示隱藏內容" marker — clone IS <html>, so the attribute sits on it.
    if (window.Editable && Editable.REVEAL_ATTR) {
      clone.removeAttribute(Editable.REVEAL_ATTR);
    }
  }

  function renderDeckIntoFrame() {
    // Serialize the full doc and load it into the iframe via srcdoc.
    const html = buildIframeSrc(state.deckDoc);
    const iframe = ui.deckFrame;
    iframe.onload = () => {
      Editable.install(iframe.contentDocument);
      Slides.attachClickNav(iframe.contentDocument);
      Slides.attachKeyboard(iframe.contentDocument);
      fitFrameToStage();
      // Slides.rebuild() ran against the still-loading iframe during load, so
      // its activate() couldn't see the live slide to fill the inspector. Now
      // that the deck has rendered, show the active slide's layout options.
      if (window.Editable && Editable.showSlideProps && state.currentIndex >= 0) {
        const live = Slides.detectSlides(iframe.contentDocument)[state.currentIndex];
        if (live) Editable.showSlideProps(live, state.currentIndex);
      }
    };
    iframe.srcdoc = html;
  }

  function syncDeckFromIframe() {
    // Pull the live iframe state (including in-place text/image/link edits)
    // back into state.deckDoc so structural ops don't clobber recent edits.
    const iframe = ui.deckFrame;
    if (!iframe || !iframe.contentDocument || !iframe.contentDocument.documentElement) return;
    const clone = iframe.contentDocument.documentElement.cloneNode(true);
    stripEditorInjections(clone);
    // Restore inline onclick="goTo(N)" we suspended at edit-mode entry so
    // state.deckDoc always mirrors the deck's published shape. The next
    // install() call will re-suspend after the iframe reloads.
    if (window.Editable && Editable.cleanupGotoForSerialize) {
      Editable.cleanupGotoForSerialize(clone);
    }
    // Strip children of containers marked data-clickdeck-runtime="fill" so
    // runtime-built dots / TOC items don't get frozen into the saved file
    // and re-accumulate on next load.
    if (window.Editable && Editable.cleanupRuntimeFillForSerialize) {
      Editable.cleanupRuntimeFillForSerialize(clone);
    }
    const html = "<!DOCTYPE html>\n" + clone.outerHTML;
    const parser = new DOMParser();
    state.deckDoc = parser.parseFromString(html, "text/html");
  }

  function fitFrameToStage() {
    const iframe = ui.deckFrame;
    const stage = iframe.parentElement;
    const rect = stage.getBoundingClientRect();
    const fitScale = Math.min(rect.width / 1920, rect.height / 1080);
    const userZoom = state.zoomLevel || 1.0;
    const scale = fitScale * userZoom;
    // iframe is fixed at 1920x1080 px (see #deck-frame in editor.css) and
    // anchored top/left 50% inside stage-inner. translate(-50%, -50%) pulls
    // the scaled visual back to center; scale then shrinks it to fit.
    iframe.style.transform = `translate(-50%, -50%) scale(${scale})`;
    iframe.style.transformOrigin = "center center";
    const stageOuter = stage.closest(".stage");
    if (stageOuter) stageOuter.classList.toggle("zoomed-in", userZoom > 1.0);
    if (ui.zoomPercent) ui.zoomPercent.textContent = Math.round(userZoom * 100) + "%";
  }

  function setZoom(level) {
    state.zoomLevel = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, level));
    if (state.deckDoc) fitFrameToStage();
  }
  function zoomIn() { setZoom((state.zoomLevel || 1.0) * ZOOM_STEP); }
  function zoomOut() { setZoom((state.zoomLevel || 1.0) / ZOOM_STEP); }
  function zoomReset() { setZoom(1.0); }

  function serializeDeck() {
    // The iframe document holds the live edited state (text, images, bg, links).
    // state.deckDoc is only the initial parse — it does NOT contain user edits.
    // Structural ops (slide add/delete/reorder) mutate state.deckDoc then call
    // reloadFrame, so after those ops the iframe is re-synced. Text edits made
    // between reloadFrame calls live only in the iframe, so we must read from it.
    const iframe = ui.deckFrame;
    const src = (iframe && iframe.contentDocument && iframe.contentDocument.documentElement)
      ? iframe.contentDocument
      : state.deckDoc;
    const clone = src.documentElement.cloneNode(true);
    stripEditorInjections(clone);
    // Put inline onclick="goTo(N)" back so the saved HTML keeps its
    // original click-to-navigate behaviour after the editor is closed.
    if (window.Editable && Editable.cleanupGotoForSerialize) {
      Editable.cleanupGotoForSerialize(clone);
    }
    // Strip children of containers marked data-clickdeck-runtime="fill" so
    // runtime-built dots / TOC items don't get frozen into the saved file
    // and re-accumulate on next load.
    if (window.Editable && Editable.cleanupRuntimeFillForSerialize) {
      Editable.cleanupRuntimeFillForSerialize(clone);
    }
    // Decks that drive navigation with `slides[current].classList.remove('active')`
    // (typical show()/goNext() pattern) only ever clear .active on slides[current].
    // current starts at 0, so any extra .slide.active — whether the user navigated
    // away in the editor, or the source HTML hand-coded .active on a non-first
    // slide — survives forever. Two slides stay layered together and `→` appears
    // to freeze on the orphaned one. Normalize on save so the published file
    // always opens at slide 0 with exactly one .active.
    normalizeActiveSlideForSave(clone);
    // `.reveal.open` is runtime state: the deck's own handler adds it when the
    // audience clicks a card. If it survives into the file the card ships with
    // the answer already showing, which kills the "先猜再點" design.
    normalizeRevealCardsForSave(clone);
    return "<!DOCTYPE html>\n" + clone.outerHTML;
  }

  function normalizeActiveSlideForSave(clone) {
    const actives = clone.querySelectorAll(".slide.active");
    if (actives.length === 0) return;
    actives.forEach(s => s.classList.remove("active"));
    const first = clone.querySelector(".slide");
    if (first) first.classList.add("active");
  }

  function normalizeRevealCardsForSave(clone) {
    clone.querySelectorAll(".reveal.open").forEach(c => c.classList.remove("open"));
  }

  // Manual structural repair: sync iframe edits into deckDoc, run the
  // editable.js heuristic sweep to drop accumulated runtime-fill children
  // (legacy decks without the data-clickdeck-runtime marker), then reload
  // the iframe so the template's own JS rebuilds dots/TOC at the correct
  // count. Marker-aware decks are already cleaned on every save/sync.
  function repairDocStructure() {
    if (!state.deckDoc) {
      toast("尚未載入簡報", "warn");
      return;
    }
    if (!window.Editable || !Editable.repairDocumentStructure) {
      toast("修復模組未載入", "err");
      return;
    }
    History.push();
    syncDeckFromIframe();
    const slidesCount = (state.slides && state.slides.length) ||
      state.deckDoc.querySelectorAll(".slide").length;
    const report = Editable.repairDocumentStructure(state.deckDoc, slidesCount);
    const cssNote = report.cssChanged
      ? `；CSS 修補：${(report.cssActions || []).join("、")}`
      : "";
    if (report.cleared === 0 && !report.cssChanged) {
      if (report.skipped && report.skipped.length) {
        // Surface why each candidate container was passed over, so the user
        // can tell whether the file is already clean or the heuristic just
        // didn't match (e.g. children share no class token).
        const reasons = report.skipped
          .map(s => `${s.name}（${s.count} 個子節點：${s.reason}）`)
          .join("、");
        toast(`未清理，掃描到 ${report.skipped.length} 個候選：${reasons}`, "warn");
      } else {
        toast("結構檢查完成，未發現需要清理的累積節點", "ok");
      }
      return;
    }
    renderDeckIntoFrame();
    markDirty();
    if (report.cleared === 0 && report.cssChanged) {
      toast(`未清理累積節點，但已修補 navbar 置中 CSS${cssNote}`, "ok");
      return;
    }
    const list = report.containers
      .map(c => `${c.name}（移除 ${c.removed}）`)
      .join("、");
    toast(`已清理 ${report.cleared} 個容器、共 ${report.removed} 個多餘節點：${list}${cssNote}`, "ok");
  }

  async function saveDeck(asName) {
    if (!state.deckDoc) return;
    const name = asName || state.fileName;
    try {
      const content = serializeDeck();
      if (state.dirHandle) {
        await saveViaDirHandle(name, content);
      } else if (state.fileHandle) {
        const w = await state.fileHandle.createWritable();
        await w.write(content);
        await w.close();
      } else {
        toast("請先按「選擇資料夾」或「選擇檔案」再儲存", "err");
        return;
      }
      state.fileName = name;
      clearDirty();
      if (state.dirHandle || (!state.fileHandle && !state.dirHandle)) {
        await refreshLibrary();
        ui.librarySelect.value = name;
      }
      toast("已儲存：" + name, "ok");
    } catch (e) {
      toast("儲存失敗：" + e.message, "err");
    }
  }

  async function saveViaDirHandle(name, content) {
    // Backup: copy existing file to <name>.bak before overwriting
    try {
      const existing = await state.dirHandle.getFileHandle(name);
      const prev = await (await existing.getFile()).text();
      const bak = await state.dirHandle.getFileHandle(name + ".bak", { create: true });
      const bw = await bak.createWritable();
      await bw.write(prev);
      await bw.close();
    } catch (_) {
      // File doesn't exist yet — no backup needed.
    }
    const fh = await state.dirHandle.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(content);
    await w.close();
    state.fileHandle = fh;
  }

  async function saveAs() {
    const suggested = state.fileName ? state.fileName.replace(/\.html$/i, "-副本.html") : "新簡報.html";
    if (state.fileHandle && !state.dirHandle && window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: suggested,
          types: [{ description: "HTML 檔", accept: { "text/html": [".html", ".htm"] } }],
        });
        const content = serializeDeck();
        const w = await handle.createWritable();
        await w.write(content);
        await w.close();
        state.fileHandle = handle;
        const f = await handle.getFile();
        state.fileName = f.name;
        ui.librarySelect.innerHTML = "";
        const opt = document.createElement("option");
        opt.value = f.name;
        opt.textContent = f.name;
        ui.librarySelect.appendChild(opt);
        ui.librarySelect.value = f.name;
        clearDirty();
        toast("已另存為：" + f.name, "ok");
      } catch (e) {
        if (e && e.name === "AbortError") return;
        toast("另存新檔失敗：" + e.message, "err");
      }
      return;
    }
    const name = prompt("另存為（.html 結尾）：", suggested);
    if (!name) return;
    const clean = name.trim();
    if (!clean.toLowerCase().endsWith(".html")) {
      toast("檔名必須以 .html 結尾", "err");
      return;
    }
    await saveDeck(clean);
  }

  function openPreview() {
    if (!state.deckDoc) return;
    const html = serializeDeck();
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function init() {
    ui.librarySelect = $("#library-select");
    ui.btnPickDir = $("#btn-pick-dir");
    ui.btnPickFile = $("#btn-pick-file");
    ui.folderLabel = $("#folder-label");
    ui.dirtyFlag = $("#dirty-flag");
    ui.btnSave = $("#btn-save");
    ui.btnSaveAs = $("#btn-save-as");
    ui.btnNewSlide = $("#btn-new-slide");
    ui.btnInsertImg = $("#btn-insert-image");
    ui.btnSaveAsTpl = $("#btn-save-as-template");
    ui.btnStyle = $("#btn-style");
    ui.btnPreview = $("#btn-preview");
    ui.btnRepairDoc = $("#btn-repair-doc");
    ui.btnEditMode = $("#btn-edit-mode");
    ui.btnRevealHidden = $("#btn-reveal-hidden");
    ui.btnZoomIn = $("#btn-zoom-in");
    ui.btnZoomOut = $("#btn-zoom-out");
    ui.btnZoomReset = $("#btn-zoom-reset");
    ui.zoomPercent = $("#btn-zoom-reset");
    ui.deckFrame = $("#deck-frame");
    ui.stageEmpty = $("#stage-empty");
    ui.slideList = $("#slide-list");
    ui.propPanel = $("#prop-panel");
    ui.toast = $("#toast");

    ui.librarySelect.addEventListener("change", e => loadFile(e.target.value));
    ui.btnPickDir.addEventListener("click", pickDirectory);
    if (!window.showDirectoryPicker) {
      ui.btnPickDir.disabled = true;
      ui.btnPickDir.title = "此瀏覽器不支援原生資料夾選擇，請改用 Chrome 或 Edge";
    }
    ui.btnPickFile.addEventListener("click", pickFile);
    if (!window.showOpenFilePicker) {
      ui.btnPickFile.disabled = true;
      ui.btnPickFile.title = "此瀏覽器不支援原生檔案選擇，請改用 Chrome 或 Edge";
    }
    ui.btnSave.addEventListener("click", () => saveDeck());
    ui.btnSaveAs.addEventListener("click", saveAs);
    ui.btnNewSlide.addEventListener("click", () => Templates.openPicker("insert"));
    ui.btnInsertImg.addEventListener("click", () => Editable.insertImageToCurrentSlide());
    ui.btnSaveAsTpl.addEventListener("click", () => Templates.openSaveAsTemplate());
    ui.btnStyle.addEventListener("click", () => StyleEditor.toggle());
    ui.btnPreview.addEventListener("click", openPreview);
    ui.btnRepairDoc.addEventListener("click", repairDocStructure);
    ui.btnEditMode.addEventListener("click", () => {
      state.editMode = !state.editMode;
      ui.btnEditMode.classList.toggle("on", state.editMode);
      ui.btnEditMode.classList.toggle("off", !state.editMode);
      ui.btnEditMode.textContent = state.editMode ? "編輯模式：開" : "編輯模式：關";
      const iframeDoc = ui.deckFrame && ui.deckFrame.contentDocument;
      if (iframeDoc && window.Editable) {
        if (state.editMode) Editable.suspendGoto(iframeDoc);
        else Editable.restoreGoto(iframeDoc);
      }
      toast(state.editMode ? "編輯模式開啟：點空白不換頁" : "編輯模式關閉：恢復原簡報互動", "ok");
    });
    ui.btnRevealHidden.addEventListener("click", () => {
      state.revealHidden = !state.revealHidden;
      ui.btnRevealHidden.classList.toggle("on", state.revealHidden);
      ui.btnRevealHidden.classList.toggle("off", !state.revealHidden);
      ui.btnRevealHidden.setAttribute("aria-pressed", String(state.revealHidden));
      ui.btnRevealHidden.textContent = state.revealHidden ? "顯示隱藏內容：開" : "顯示隱藏內容：關";
      const iframeDoc = ui.deckFrame && ui.deckFrame.contentDocument;
      if (iframeDoc && window.Editable) Editable.applyRevealHidden(iframeDoc);
      toast(state.revealHidden
        ? "隱藏內容已展開，可直接編輯（存檔後仍是點了才開）"
        : "隱藏內容已收合，恢復簡報原本的顯示狀態", "ok");
    });
    ui.btnZoomIn.addEventListener("click", zoomIn);
    ui.btnZoomOut.addEventListener("click", zoomOut);
    ui.btnZoomReset.addEventListener("click", zoomReset);

    // Modal close buttons
    document.querySelectorAll("[data-close]").forEach(b => {
      b.addEventListener("click", () => {
        const m = b.closest(".modal");
        if (m) m.classList.add("hidden");
      });
    });
    document.querySelectorAll(".modal-backdrop").forEach(b => {
      b.addEventListener("click", () => b.closest(".modal").classList.add("hidden"));
    });
    document.querySelectorAll("[data-close-drawer]").forEach(b => {
      b.addEventListener("click", () => b.closest(".drawer").classList.add("hidden"));
    });

    window.addEventListener("resize", () => {
      if (state.deckDoc) fitFrameToStage();
    });
    window.addEventListener("beforeunload", e => {
      if (state.dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    });

    document.addEventListener("keydown", handleGlobalKey);

    refreshLibrary();
    Templates.loadAll();
  }

  function handleGlobalKey(e) {
    const t = e.target;
    const inInput = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    if (inInput) return;
    if (!(e.ctrlKey || e.metaKey)) return;
    const key = e.key.toLowerCase();
    if (key === "z" && !e.shiftKey) {
      e.preventDefault();
      History.undo();
    } else if (key === "y" || (key === "z" && e.shiftKey)) {
      e.preventDefault();
      History.redo();
    } else if (key === "c" && isSlideFocused()) {
      e.preventDefault();
      Slides.copySelected();
    } else if (key === "x" && isSlideFocused()) {
      e.preventDefault();
      Slides.cutSelected();
    } else if (key === "v" && (isSlideFocused() || state.clipboardSlide)) {
      e.preventDefault();
      Slides.pasteAfterSelected();
    }
  }

  function isSlideFocused() {
    const a = document.activeElement;
    if (!a) return false;
    return a === ui.slideList || (a.closest && !!a.closest("#slide-list li"));
  }

  // Expose
  global.Editor = {
    init, state, ui, toast, markDirty, clearDirty,
    serializeDeck, fitFrameToStage, syncDeckFromIframe,
    buildIframeSrc, stripEditorInjections,
  };

})(window);
