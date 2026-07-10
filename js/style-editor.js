/* === Style editor drawer: CSS custom properties + font === */
(function (global) {
  "use strict";

  function toggle() {
    const drawer = document.getElementById("style-drawer");
    drawer.classList.toggle("hidden");
    if (!drawer.classList.contains("hidden")) render();
  }

  function readVarsFromDeck() {
    const st = Editor.state;
    st.deckCssVars = {};
    if (!st.deckDoc) return;
    const sheets = Array.from(st.deckDoc.styleSheets);
    for (const sheet of sheets) {
      let rules;
      try { rules = sheet.cssRules; } catch (e) { continue; }
      if (!rules) continue;
      for (const rule of Array.from(rules)) {
        if (rule.type === CSSRule.STYLE_RULE && /:root\b/.test(rule.selectorText)) {
          for (let i = 0; i < rule.style.length; i++) {
            const prop = rule.style[i];
            if (prop.startsWith("--")) {
              st.deckCssVars[prop] = rule.style.getPropertyValue(prop).trim();
            }
          }
        }
      }
    }
  }

  function render() {
    const st = Editor.state;
    const container = document.getElementById("style-colors");
    const hint = document.getElementById("style-colors-hint");
    container.innerHTML = "";

    const vars = Object.entries(st.deckCssVars || {});
    if (vars.length) {
      hint.classList.add("hidden");
      vars.forEach(([name, value]) => {
        const isColor = isColorValue(value);
        const row = document.createElement("div");
        row.className = "color-row";
        row.innerHTML = `
          <span class="var-name">${name}</span>
          ${isColor ? `<input type="color" value="${toHexColor(value)}" data-name="${name}">` : ""}
          <input type="text" value="${value.replace(/"/g, "&quot;")}" data-name="${name}" data-text="1">
        `;
        container.appendChild(row);
      });
      container.querySelectorAll("input[type=color]").forEach(inp => {
        // Snapshot once per open picker interaction, not per 'input' event (which
        // fires on every slider tick). Use 'change' to commit one undo step.
        inp.addEventListener("change", e => {
          History.push();
        });
        inp.addEventListener("input", e => {
          const name = e.target.dataset.name;
          updateVar(name, e.target.value);
          const txt = container.querySelector(`input[data-text="1"][data-name="${name}"]`);
          if (txt) txt.value = e.target.value;
        });
      });
      container.querySelectorAll("input[data-text='1']").forEach(inp => {
        inp.addEventListener("change", e => {
          History.push();
          updateVar(e.target.dataset.name, e.target.value);
          const color = container.querySelector(`input[type=color][data-name="${e.target.dataset.name}"]`);
          if (color && isColorValue(e.target.value)) color.value = toHexColor(e.target.value);
        });
      });
    } else {
      hint.classList.remove("hidden");
      hint.textContent = "此簡報沒有使用 CSS 變數（:root 底下的 --xxx）。可以在「存為樣板」時順便把配色抽出為變數。";
    }

    const fontSel = document.getElementById("style-font");
    fontSel.onchange = (e) => {
      History.push();
      applyFont(e.target.value);
    };
  }

  function isColorValue(v) {
    if (!v) return false;
    v = v.trim().toLowerCase();
    if (/^#[0-9a-f]{3,8}$/.test(v)) return true;
    if (/^rgba?\(/.test(v)) return true;
    if (/^hsla?\(/.test(v)) return true;
    // Modern CSS color spaces (Chrome 111+, all current browsers): let the
    // probe in toHexColor() resolve them. HoloTeam-style decks declare their
    // palette entirely in oklch(), so this is the difference between the
    // colour picker working at all and showing #000000.
    if (/^(oklch|oklab|lab|lch|hwb|color)\(/.test(v)) return true;
    const namedColors = ["red","green","blue","white","black","orange","purple","yellow","pink","gray","grey"];
    return namedColors.includes(v);
  }

  function toHexColor(v) {
    if (!v) return "#000000";
    v = v.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(v)) return v;
    if (/^#[0-9a-fA-F]{3}$/.test(v)) {
      return "#" + v.slice(1).split("").map(c => c + c).join("");
    }
    // rgb()
    const m = v.match(/rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/);
    if (m) {
      return "#" + [m[1], m[2], m[3]].map(n => Number(n).toString(16).padStart(2, "0")).join("");
    }
    // Fallback: use a 1px canvas to let the browser resolve the value to an
    // actual RGB pixel. Modern browsers (Chrome 146 verified) preserve
    // oklch / oklab / lab / lch / hwb / color() as the computed value of
    // `style.color`, so a `getComputedStyle(span).color` probe yields the
    // original string back instead of "rgb(...)". Canvas rasterisation is
    // the reliable way to coerce these spaces to sRGB integers.
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 1; canvas.height = 1;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#000000";
      ctx.fillStyle = v;
      // If the browser rejected the value, fillStyle silently stays at the
      // previous setting ("#000000") and the pixel will be black — same
      // behaviour as the final return below, which is acceptable.
      ctx.fillRect(0, 0, 1, 1);
      const data = ctx.getImageData(0, 0, 1, 1).data;
      return "#" + [data[0], data[1], data[2]]
        .map(n => n.toString(16).padStart(2, "0")).join("");
    } catch (_) { /* fall through to default */ }
    return "#000000";
  }

  function updateVar(name, value) {
    const st = Editor.state;
    st.deckCssVars[name] = value;
    // Re-apply by injecting/updating a :root override style tag
    let overrideStyle = st.deckDoc.getElementById("__editor_vars__");
    if (!overrideStyle) {
      overrideStyle = st.deckDoc.createElement("style");
      overrideStyle.id = "__editor_vars__";
      st.deckDoc.head.appendChild(overrideStyle);
    }
    const body = Object.entries(st.deckCssVars)
      .map(([k, v]) => `${k}: ${v};`).join(" ");
    overrideStyle.textContent = `:root{${body}}`;

    // Mirror into iframe
    const iframeDoc = Editor.ui.deckFrame.contentDocument;
    if (iframeDoc) {
      let mirror = iframeDoc.getElementById("__editor_vars__");
      if (!mirror) {
        mirror = iframeDoc.createElement("style");
        mirror.id = "__editor_vars__";
        iframeDoc.head.appendChild(mirror);
      }
      mirror.textContent = overrideStyle.textContent;
    }
    Editor.markDirty();
    Slides.rebuildThumbsOnly();
  }

  function applyFont(fontStack) {
    const st = Editor.state;
    let style = st.deckDoc.getElementById("__editor_font__");
    if (!fontStack) {
      if (style) style.remove();
      const iframeDoc = Editor.ui.deckFrame.contentDocument;
      const mirror = iframeDoc && iframeDoc.getElementById("__editor_font__");
      if (mirror) mirror.remove();
      Editor.markDirty();
      return;
    }
    if (!style) {
      style = st.deckDoc.createElement("style");
      style.id = "__editor_font__";
      st.deckDoc.head.appendChild(style);
    }
    style.textContent = `html, body { font-family: ${fontStack} !important; }`;

    const iframeDoc = Editor.ui.deckFrame.contentDocument;
    if (iframeDoc) {
      let mirror = iframeDoc.getElementById("__editor_font__");
      if (!mirror) {
        mirror = iframeDoc.createElement("style");
        mirror.id = "__editor_font__";
        iframeDoc.head.appendChild(mirror);
      }
      mirror.textContent = style.textContent;
    }
    Editor.markDirty();
    Slides.rebuildThumbsOnly();
  }

  global.StyleEditor = { toggle, render, readVarsFromDeck };

})(window);
