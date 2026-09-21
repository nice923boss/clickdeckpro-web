/* === Template host adaptation: read a deck's own slide convention and
   re-shape an inserted template (root element + scoped CSS) to it. ===
   Loaded before templates.js; templates.js consumes it as `TemplateHost`. */
(function (global) {
  "use strict";

  const SCOPE_ATTR = "data-tpl-scope";

  // === Host-convention adaptation ======================================
  // A deck made elsewhere (another machine / another AI) hides and shows
  // its pages by its own rules: `<section class="slide">` toggled through
  // `.active`, or `<div class="page is-current">`, or opacity instead of
  // display… A template's root carries its OWN visibility rule (e.g.
  // `display:flex!important`), so when dropped into such a deck it stays
  // visible on top of every page and navigation appears broken. The fix is
  // to read the host's convention from the live deck and re-shape the
  // template to it: same tag, the host's shared classes / attributes, and
  // the host's active token controlling visibility instead of the
  // template's own rule.

  const STATE_TOKENS = ["active", "is-active", "current", "is-current", "show", "visible", "on"];

  function cssEscape(s) {
    return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^\w-]/g, "\\$&");
  }

  function splitTopLevelCommas(text) {
    const parts = [];
    let depth = 0, cur = "";
    for (const ch of text) {
      if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth--;
      if (ch === "," && depth === 0) { parts.push(cur.trim()); cur = ""; }
      else cur += ch;
    }
    parts.push(cur.trim());
    return parts.filter(Boolean);
  }

  // Reads how the deck's own (non-template) slides are built. Prefers the
  // live iframe document because only there has the deck's script run, so
  // one slide is really shown and the rest really hidden — computed styles
  // tell us which token and which CSS property the host uses.
  function getHostSlideProfile(doc) {
    const liveDoc = Editor.ui && Editor.ui.deckFrame && Editor.ui.deckFrame.contentDocument;
    const liveWin = liveDoc && liveDoc.defaultView;
    const liveUsable = !!(liveDoc && liveDoc.body && Slides.detectSlides(liveDoc).length);
    const src = liveUsable ? liveDoc : doc;
    const all = Slides.detectSlides(src);
    const hostSlides = all.filter(s => !s.hasAttribute(SCOPE_ATTR));
    const sample = hostSlides.length ? hostSlides : all;
    if (!sample.length) return null;

    const tagCount = {};
    sample.forEach(s => { const t = s.tagName.toLowerCase(); tagCount[t] = (tagCount[t] || 0) + 1; });
    const tag = Object.keys(tagCount).sort((a, b) => tagCount[b] - tagCount[a])[0];

    let common = null;
    sample.forEach(s => {
      const set = new Set(s.classList);
      common = common ? common.filter(c => set.has(c)) : [...set];
    });
    const commonClasses = (common || []).filter(c => !STATE_TOKENS.includes(c) && c !== "is-prev");

    let shared = null;
    sample.forEach(s => {
      const m = {};
      for (const a of s.attributes) {
        if (a.name === "class" || a.name === "id" || a.name === "style") continue;
        if (a.name.startsWith("data-edit") || a.name.startsWith("data-clickdeck")) continue;
        m[a.name] = a.value;
      }
      shared = shared
        ? Object.fromEntries(Object.entries(shared).filter(([k, v]) => k in m && m[k] === v))
        : m;
    });

    const profile = {
      tag, commonClasses, sharedAttrs: shared || {},
      activeToken: null, hideProps: [], hidesByDisplay: false,
    };

    if (liveUsable && liveWin && sample.length > 1) {
      const cs = sample.map(s => liveWin.getComputedStyle(s));
      // The hiding property is the first one that splits the host slides
      // into a non-empty shown group and a non-empty hidden group. Checked
      // one property at a time on purpose: an entrance animation paused at
      // its first frame leaves the SHOWN slide at opacity 0, so a combined
      // "display && visibility && opacity" test would see nothing shown.
      const tests = [
        ["display", c => c.display !== "none"],
        ["visibility", c => c.visibility !== "hidden"],
        ["opacity", c => parseFloat(c.opacity) > 0],
      ];
      for (const [prop, isShown] of tests) {
        const shownIdx = [], hiddenIdx = [];
        cs.forEach((c, i) => (isShown(c) ? shownIdx : hiddenIdx).push(i));
        if (!shownIdx.length || !hiddenIdx.length) continue;
        const candidates = [...STATE_TOKENS, ...sample[shownIdx[0]].classList];
        const token = candidates.find(c =>
          shownIdx.every(i => sample[i].classList.contains(c)) &&
          hiddenIdx.every(i => !sample[i].classList.contains(c)));
        if (!token) continue;
        profile.activeToken = token;
        profile.hideProps = [prop];
        profile.hidesByDisplay = prop === "display";
        break;
      }
    } else {
      // Static markup only: we can name the token but not how it hides, so
      // CSS adaptation stays off (root tag / classes are still aligned).
      profile.activeToken = STATE_TOKENS.find(t => sample.some(s => s.classList.contains(t))) || null;
    }
    return profile;
  }

  function adaptRuleList(ruleList, matchesRoot, host, markerSel, out, found, topLevel) {
    const norm = s => s.replace(/\s+/g, "");
    for (const rule of Array.from(ruleList)) {
      if (rule.type === CSSRule.STYLE_RULE) {
        if (norm(rule.selectorText) === norm(markerSel)) {
          // Marker appended by an earlier run: fold it back into `found` and
          // re-emit it at the end, so repeated adaptation is idempotent.
          const d = rule.style.getPropertyValue("display");
          if (d && topLevel) found.display = d;
          continue;
        }
        const parts = splitTopLevelCommas(rule.selectorText);
        const rootParts = parts.filter(matchesRoot);
        if (!rootParts.length) { out.push(rule.cssText); continue; }
        const otherParts = parts.filter(p => !rootParts.includes(p));
        const origDecl = rule.style.cssText;
        const d = rule.style.getPropertyValue("display");
        if (d && d !== "none" && topLevel) found.display = d;
        host.hideProps.forEach(p => rule.style.removeProperty(p));
        const stripped = rule.style.cssText;
        if (otherParts.length) out.push(`${otherParts.join(", ")} { ${origDecl} }`);
        if (stripped.trim()) out.push(`${rootParts.join(", ")} { ${stripped} }`);
      } else if (rule.type === CSSRule.MEDIA_RULE || rule.type === CSSRule.SUPPORTS_RULE) {
        const inner = [];
        adaptRuleList(rule.cssRules, matchesRoot, host, markerSel, inner, found, false);
        if (inner.length) {
          const cond = rule.media ? rule.media.mediaText : rule.conditionText;
          out.push((rule.type === CSSRule.MEDIA_RULE ? "@media " : "@supports ") + cond + " {\n" + inner.join("\n") + "\n}");
        }
      } else {
        out.push(rule.cssText);
      }
    }
  }

  // Takes already-scoped template CSS and (1) strips the host's hiding
  // property from every rule that targets the template ROOT, so the host's
  // own `.slide { display:none }` governs it; (2) re-adds the template's
  // display value under the host's active token, so the page lays out as
  // designed once the host shows it. Rules for descendants are untouched.
  function adaptTemplateCssToHost(cssText, rootEl, tplId, host) {
    if (!cssText || !cssText.trim()) return cssText || "";
    if (!host || !host.activeToken || !host.hideProps.length) return cssText;
    const scopeSel = `[${SCOPE_ATTR}="${tplId}"]`;
    const markerSel = `${scopeSel}.${cssEscape(host.activeToken)}`;

    const probeRoot = document.createElement(rootEl.tagName);
    for (const a of rootEl.attributes) probeRoot.setAttribute(a.name, a.value);
    probeRoot.setAttribute(SCOPE_ATTR, tplId);
    probeRoot.classList.add(host.activeToken);
    const matchesRoot = sel => { try { return probeRoot.matches(sel); } catch (_) { return false; } };

    const probe = document.createElement("style");
    probe.media = "not all";
    probe.textContent = cssText;
    document.head.appendChild(probe);
    try {
      const sheet = probe.sheet;
      if (!sheet || !sheet.cssRules) return cssText;
      const out = [];
      const found = { display: "" };
      adaptRuleList(sheet.cssRules, matchesRoot, host, markerSel, out, found, true);
      if (host.hidesByDisplay && found.display && found.display !== "none") {
        out.push(`${markerSel} { display: ${found.display} !important; }`);
      }
      return out.join("\n");
    } catch (e) {
      return cssText;
    } finally {
      probe.remove();
    }
  }

  // Re-shapes the template root to look like one of the host's own slides:
  // same element tag, the classes / attributes every host slide shares, and
  // no stale active token (the host script decides which page is shown).
  // Returns the root, which is a NEW element when the tag had to change.
  function adaptSlideRootToHost(slide, host, doc) {
    if (!host) return slide;
    let root = slide;
    if (host.tag && root.tagName.toLowerCase() !== host.tag) {
      const repl = doc.createElement(host.tag);
      for (const a of root.attributes) repl.setAttribute(a.name, a.value);
      while (root.firstChild) repl.appendChild(root.firstChild);
      if (root.parentNode) root.parentNode.replaceChild(repl, root);
      root = repl;
    }
    host.commonClasses.forEach(c => root.classList.add(c));
    Object.entries(host.sharedAttrs).forEach(([k, v]) => {
      if (!root.hasAttribute(k)) root.setAttribute(k, v);
    });
    if (host.activeToken) root.classList.remove(host.activeToken);
    return root;
  }

  global.TemplateHost = {
    SCOPE_ATTR,
    getProfile: getHostSlideProfile,
    adaptCss: adaptTemplateCssToHost,
    adaptRoot: adaptSlideRootToHost,
  };
})(window);
