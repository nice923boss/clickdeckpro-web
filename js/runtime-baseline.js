/* === Runtime baseline: keep deck-script DOM changes out of saves and snapshots === */
(function (global) {
  "use strict";

  // Deck scripts rewrite parts of their own DOM on load: rendered prompt
  // cards, backdrop layers, base64 image src, canvas sizes, progress width.
  // Cloning the live iframe freezes all of that into the saved file and into
  // undo snapshots (where it then renders a second time). Right after load we
  // diff the live DOM against the parsed source and remember what the
  // runtime changed, so serialization can put the source version back.
  // Outside slides the deck owns those nodes outright and they are always
  // reverted; inside slides a node is only reverted while it still holds its
  // load-time value, so anything the user edited afterwards is kept.
  function capture(iframeDoc) {
    const state = Editor.state;
    state.runtimeBaseline = null;
    if (!state.deckDoc || !iframeDoc || !iframeDoc.documentElement) return;
    const liveSlides = new Set(Slides.detectSlides(iframeDoc));
    const srcSlides = new Set(Slides.detectSlides(state.deckDoc));
    const hostsOf = (set) => {
      const hosts = new Set();
      set.forEach(s => { for (let p = s.parentElement; p; p = p.parentElement) hosts.add(p); });
      return hosts;
    };
    const liveHosts = hostsOf(liveSlides);
    const srcHosts = hostsOf(srcSlides);
    const role = (el, slides, hosts) => slides.has(el) ? "slide" : hosts.has(el) ? "host" : "";
    const same = (s, l) => s.tagName === l.tagName && s.id === l.id &&
      role(s, srcSlides, srcHosts) === role(l, liveSlides, liveHosts);
    const directText = el => Array.from(el.childNodes)
      .filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.nodeValue).join("");
    const records = [];

    function walk(src, live, inSlide) {
      const isSlide = liveSlides.has(live);
      const guarded = inSlide || isSlide;
      const attrs = [];
      new Set([...src.getAttributeNames(), ...live.getAttributeNames()]).forEach(n => {
        // Slide navigation classes are handled by normalizeActiveSlideForSave.
        if (isSlide && n === "class") return;
        const a = src.getAttribute(n);
        const b = live.getAttribute(n);
        if (a !== b) attrs.push([n, a, b]);
      });
      if (attrs.length) records.push({ el: live, guarded, attrs });

      const s = Array.from(src.children);
      const l = Array.from(live.children).filter(c => c.id !== "__editor_storage_polyfill__");
      const container = !guarded && (!live.parentElement || liveHosts.has(live) ||
        live.tagName === "HEAD" || live.tagName === "BODY");
      if (container) {
        // Align children so nodes the runtime appended (toasts, library
        // <style> tags, canvases) can be dropped without disturbing the
        // siblings that hold the slides. Slides and their ancestors are
        // never treated as appended.
        const markAdded = (el) => {
          if (!role(el, liveSlides, liveHosts)) records.push({ el, added: true });
        };
        let j = 0;
        for (let i = 0; i < s.length && j < l.length; i++) {
          let k = j;
          while (k < l.length && !same(s[i], l[k])) k++;
          if (k === l.length) continue;
          for (; j < k; j++) markAdded(l[j]);
          walk(s[i], l[j], false);
          j++;
        }
        for (; j < l.length; j++) markAdded(l[j]);
        return;
      }
      const reshaped = s.length !== l.length || s.some((c, i) => !same(c, l[i])) ||
        directText(src) !== directText(live);
      if (reshaped) {
        records.push({ el: live, guarded, html: [src.innerHTML, live.innerHTML] });
        return;
      }
      s.forEach((c, i) => walk(c, l[i], guarded));
    }

    walk(state.deckDoc.documentElement, iframeDoc.documentElement, false);
    state.runtimeBaseline = { doc: iframeDoc, records };
  }

  // Map each baseline record onto the matching node of a fresh clone of the
  // live document. Must run right after cloneNode, before anything is removed
  // from the clone, so child indexes still line up.
  function pair(liveRoot, clone) {
    const base = Editor.state.runtimeBaseline;
    if (!base || base.doc !== liveRoot.ownerDocument) return [];
    const pairs = [];
    base.records.forEach(rec => {
      if (!liveRoot.contains(rec.el)) return;
      const path = [];
      for (let n = rec.el; n !== liveRoot; n = n.parentElement) {
        path.push(Array.prototype.indexOf.call(n.parentElement.children, n));
      }
      let target = clone;
      for (let i = path.length - 1; i >= 0 && target; i--) target = target.children[path[i]];
      if (target) pairs.push([rec, target]);
    });
    return pairs;
  }

  function restore(pairs) {
    pairs.forEach(([rec, el]) => {
      if (rec.added) {
        el.remove();
      } else if (rec.html) {
        if (!rec.guarded || el.innerHTML === rec.html[1]) el.innerHTML = rec.html[0];
      } else {
        rec.attrs.forEach(([name, srcVal, rtVal]) => {
          if (rec.guarded && el.getAttribute(name) !== rtVal) return;
          if (srcVal === null) el.removeAttribute(name);
          else el.setAttribute(name, srcVal);
        });
      }
    });
  }

  global.RuntimeBaseline = { capture, pair, restore };

})(window);
