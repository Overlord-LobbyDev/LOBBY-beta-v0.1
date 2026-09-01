// ============================================================
//  screenpicker.js — shared screen/window source picker
//  Injected at runtime into any page that needs it.
//  Used by: index.html (voice channels), chat.html (1-1 & group calls)
//
//  Three things were wrong with the old one and all three were
//  structural rather than cosmetic:
//
//    · it was a bottom sheet, sliding up from the edge of the window
//      like a mobile action sheet in an app that has no other;
//    · it only appeared AFTER every thumbnail had been captured and
//      encoded, so the slower the machine the longer nothing happened;
//    · it looked like a system dialog rather than like Lobby.
//
//  Now it opens instantly with placeholders and fills in, it sits in the
//  middle of the screen, and it speaks the app's own language: mono
//  small-caps labels, thin rules, accent glow, cut corners.
//
//  API is unchanged and additive:
//    openSourcePicker(sources)  -> Promise<id|null>   (as before)
//    openSourcePicker()         -> fetches its own sources, shows at once
// ============================================================

(function () {
  "use strict";

  if (!document.getElementById("sp-styles")) {
    const style = document.createElement("style");
    style.id = "sp-styles";
    style.textContent = `
      #sourcePickerOverlay {
        display:none; position:fixed; inset:0; z-index:99998;
        background:rgba(4,5,9,.72); backdrop-filter:blur(10px);
        align-items:center; justify-content:center;      /* centred, not a sheet */
        padding:32px;
        opacity:0; transition:opacity .18s ease;
      }
      #sourcePickerOverlay.visible { display:flex; }
      #sourcePickerOverlay.open { opacity:1; }

      #sourcePickerModal {
        --sp-accent: var(--hub-accent, var(--accent, #a863ff));
        width:min(1040px, 100%); max-height:min(78vh, 780px);
        display:flex; flex-direction:column; overflow:hidden;
        background:linear-gradient(168deg, #14161e 0%, #0b0d13 100%);
        border-radius:18px;
        box-shadow:0 40px 120px -30px rgba(0,0,0,.95);
        transform:translateY(10px) scale(.985);
        opacity:0;
        transition:transform .22s cubic-bezier(.2,.9,.3,1), opacity .22s;
        position:relative;
      }
      #sourcePickerOverlay.open #sourcePickerModal { transform:none; opacity:1; }
      /* The room's bracket motif, so this belongs to the same app. */
      #sourcePickerModal::before, #sourcePickerModal::after {
        content:""; position:absolute; width:64px; height:64px; pointer-events:none;
        border:2px solid color-mix(in srgb, var(--sp-accent) 50%, transparent);
      }
      #sourcePickerModal::before {
        left:0; top:0; border-right:0; border-bottom:0; border-radius:18px 0 0 0;
      }
      #sourcePickerModal::after {
        right:0; bottom:0; border-left:0; border-top:0; border-radius:0 0 18px 0;
      }

      .sp-head {
        flex:0 0 auto; position:relative;
        display:flex; align-items:center; gap:14px;
        padding:20px 24px 16px;
      }
      .sp-head::after {
        content:""; position:absolute; left:74px; right:74px; bottom:0; height:1px;
        background:linear-gradient(90deg, transparent,
          color-mix(in srgb, var(--sp-accent) 40%, transparent), transparent);
      }
      .sp-eyebrow {
        font-family:'JetBrains Mono', ui-monospace, monospace;
        font-size:9px; font-weight:700; letter-spacing:2px; text-transform:uppercase;
        color:color-mix(in srgb, var(--sp-accent) 85%, white);
      }
      .sp-h1 {
        margin-top:3px;
        font-family:'Archivo', var(--font), system-ui, sans-serif;
        font-size:19px; font-weight:800; color:#fff; letter-spacing:-.2px;
      }
      /* The app's segmented control: one row, the live one filled. */
      .sp-tabs {
        margin-left:auto; display:flex; gap:4px; padding:4px; border-radius:11px;
        background:rgba(0,0,0,.4); box-shadow:inset 0 0 0 1px rgba(255,255,255,.08);
      }
      .sp-tab {
        padding:8px 14px; border-radius:8px; border:0; cursor:pointer;
        background:none; color:#a8b0c2;
        font-family:'JetBrains Mono', ui-monospace, monospace;
        font-size:9px; font-weight:700; letter-spacing:1.3px; text-transform:uppercase;
        transition:background .16s, color .16s;
      }
      .sp-tab:hover { color:#fff; }
      .sp-tab.on {
        color:#0b0510;
        background:linear-gradient(180deg,
          color-mix(in srgb, var(--sp-accent) 94%, white), var(--sp-accent));
      }
      .sp-tab b { opacity:.6; font-weight:700; margin-left:5px; }
      .sp-tab.on b { opacity:.75; }

      .sp-find {
        margin-left:14px; display:flex; align-items:center; gap:8px;
        padding:9px 12px; border-radius:10px; color:#6b7387;
        background:rgba(0,0,0,.42); border:1px solid rgba(255,255,255,.1);
        transition:border-color .16s;
      }
      .sp-find:focus-within { border-color:color-mix(in srgb, var(--sp-accent) 55%, transparent); }
      .sp-find input {
        width:170px; background:none; border:0; outline:none; color:#fff;
        font-family:'Archivo', var(--font), system-ui, sans-serif; font-size:12.5px;
      }
      .sp-x {
        flex:0 0 auto; width:32px; height:32px; border-radius:9px; cursor:pointer;
        background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.1);
        color:#a8b0c2; font-size:15px; line-height:1;
        display:flex; align-items:center; justify-content:center;
        transition:color .16s, border-color .16s, background .16s;
      }
      .sp-x:hover { color:#fff; border-color:rgba(255,120,145,.6); background:rgba(255,60,90,.16); }

      .sp-body { flex:1; min-height:0; overflow-y:auto; padding:18px 24px 8px; }
      .sp-group {
        margin:0 0 10px;
        font-family:'JetBrains Mono', ui-monospace, monospace;
        font-size:9px; font-weight:700; letter-spacing:1.9px; text-transform:uppercase;
        color:#6b7387;
      }
      .sp-group + .sp-grid { margin-bottom:22px; }
      .sp-grid {
        display:grid; gap:14px;
        grid-template-columns:repeat(auto-fill, minmax(248px, 1fr));
      }

      .sp-source {
        position:relative; cursor:pointer; padding:0; overflow:hidden;
        background:linear-gradient(170deg, rgba(255,255,255,.07), rgba(255,255,255,.02));
        box-shadow:inset 0 0 0 1px rgba(255,255,255,.1);
        clip-path:polygon(11px 0, 100% 0, 100% calc(100% - 11px), calc(100% - 11px) 100%, 0 100%, 0 11px);
        transition:transform .16s, box-shadow .16s, background .16s;
      }
      .sp-source:hover {
        transform:translateY(-2px);
        box-shadow:inset 0 0 0 1px color-mix(in srgb, var(--sp-accent) 60%, transparent);
      }
      .sp-source.selected {
        background:linear-gradient(170deg,
          color-mix(in srgb, var(--sp-accent) 22%, transparent), rgba(255,255,255,.03));
        box-shadow:inset 0 0 0 2px var(--sp-accent),
                   0 0 40px -16px color-mix(in srgb, var(--sp-accent) 90%, transparent);
      }
      .sp-thumb {
        width:100%; aspect-ratio:16/9; object-fit:contain; display:block;
        background:#05070d;
      }
      /* Before its picture arrives, a tile is still a tile. */
      .sp-thumb.skel {
        background:linear-gradient(100deg, #0d0f16 30%, #171a23 50%, #0d0f16 70%);
        background-size:200% 100%;
        animation:spSkel 1.1s linear infinite;
      }
      @keyframes spSkel { to { background-position:-200% 0; } }
      .sp-name {
        padding:10px 12px;
        font-family:'Archivo', var(--font), system-ui, sans-serif;
        font-size:12.5px; font-weight:700; color:#e9ecf3;
        overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
      }
      .sp-source.selected .sp-name { color:#fff; }
      .sp-tick {
        position:absolute; top:9px; right:9px;
        width:22px; height:22px; border-radius:50%;
        display:flex; align-items:center; justify-content:center;
        background:var(--sp-accent); color:#0b0510;
        opacity:0; transform:scale(.7); transition:opacity .16s, transform .16s;
      }
      .sp-source.selected .sp-tick { opacity:1; transform:none; }

      .sp-empty {
        padding:40px 10px; text-align:center; color:#6b7387; font-size:13px;
      }

      .sp-foot {
        flex:0 0 auto; position:relative;
        display:flex; align-items:center; gap:10px; padding:16px 24px 20px;
      }
      .sp-foot::before {
        content:""; position:absolute; left:74px; right:74px; top:0; height:1px;
        background:linear-gradient(90deg, transparent,
          color-mix(in srgb, var(--sp-accent) 40%, transparent), transparent);
      }
      .sp-hint {
        flex:1; font-family:'JetBrains Mono', ui-monospace, monospace;
        font-size:9px; font-weight:700; letter-spacing:1.2px; text-transform:uppercase;
        color:#6b7387;
      }
      .sp-btn {
        padding:11px 20px; border-radius:11px; cursor:pointer; border:0;
        font-family:'JetBrains Mono', ui-monospace, monospace;
        font-size:9.5px; font-weight:700; letter-spacing:1.3px; text-transform:uppercase;
        transition:background .16s, color .16s, filter .16s;
      }
      .sp-btn.ghost {
        background:rgba(255,255,255,.05); color:#a8b0c2;
        box-shadow:inset 0 0 0 1px rgba(255,255,255,.1);
      }
      .sp-btn.ghost:hover { color:#fff; background:rgba(255,255,255,.09); }
      .sp-btn.go {
        background:linear-gradient(180deg,
          color-mix(in srgb, var(--sp-accent) 94%, white), var(--sp-accent));
        color:#0b0510;
      }
      .sp-btn.go:hover { filter:brightness(1.08); }
      .sp-btn.go:disabled { opacity:.4; cursor:not-allowed; filter:none; }
    `;
    document.head.appendChild(style);
  }

  if (!document.getElementById("sourcePickerOverlay")) {
    const div = document.createElement("div");
    div.innerHTML = `
      <div id="sourcePickerOverlay">
        <div id="sourcePickerModal">
          <div class="sp-head">
            <div>
              <div class="sp-eyebrow">Share your screen</div>
              <div class="sp-h1">What do you want to show?</div>
            </div>
            <div class="sp-tabs" id="sourcePickerTabs">
              <button class="sp-tab on" data-tab="all">All</button>
              <button class="sp-tab" data-tab="screen">Screens<b id="spNScreens"></b></button>
              <button class="sp-tab" data-tab="window">Windows<b id="spNWindows"></b></button>
            </div>
            <label class="sp-find">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/>
                   <path d="M20 20l-3.6-3.6"/></svg>
              <input id="sourcePickerFind" type="text" placeholder="Search windows" spellcheck="false">
            </label>
            <button class="sp-x" id="sourcePickerClose" title="Cancel">✕</button>
          </div>

          <div class="sp-body" id="sourcePickerBody"></div>

          <div class="sp-foot">
            <span class="sp-hint" id="sourcePickerHint">Double-click to share straight away</span>
            <button class="sp-btn ghost" id="sourcePickerCancel">Cancel</button>
            <button class="sp-btn go" id="sourcePickerConfirm" disabled>Share</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(div.firstElementChild);
  }

  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, c =>
    ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));

  const TICK = `<span class="sp-tick"><svg width="12" height="12" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"
    stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg></span>`;

  window.openSourcePicker = function (sources) {
    return new Promise(resolve => {
      const overlay = document.getElementById("sourcePickerOverlay");
      const body    = document.getElementById("sourcePickerBody");
      const find    = document.getElementById("sourcePickerFind");
      const confirm = document.getElementById("sourcePickerConfirm");
      const cancel  = document.getElementById("sourcePickerCancel");
      const closeBtn= document.getElementById("sourcePickerClose");
      const hint    = document.getElementById("sourcePickerHint");

      const tabs = document.getElementById("sourcePickerTabs");
      let all = Array.isArray(sources) ? sources : null;
      let selectedId = null;
      let query = "";
      let tab = "all";

      /* Screens first and named plainly: they are what most people want,
         and a list that opens on "Chrome window 7" is a list you have to
         read before you can use. */
      function render() {
        if (!all) {
          body.innerHTML =
            `<div class="sp-group">Finding your screens</div>
             <div class="sp-grid">` +
            Array.from({ length: 6 }).map(() =>
              `<div class="sp-source"><div class="sp-thumb skel"></div>
                 <div class="sp-name">&nbsp;</div></div>`).join("") +
            `</div>`;
          return;
        }

        const q = query.trim().toLowerCase();
        const isScreen = s => String(s.id).startsWith("screen");
        const match = s => !q || String(s.name || "").toLowerCase().includes(q);

        document.getElementById("spNScreens").textContent = all.filter(isScreen).length || "";
        document.getElementById("spNWindows").textContent = all.filter(s => !isScreen(s)).length || "";

        /* Screens first even under All: they are what most people came
           for, and a picker that opens on somebody's file manager makes
           you read before you can choose. */
        const list = all
          .filter(match)
          .filter(s => tab === "all" || (tab === "screen") === isScreen(s))
          .sort((a, b) => (isScreen(b) ? 1 : 0) - (isScreen(a) ? 1 : 0));

        const tile = (s) => `
          <div class="sp-source${selectedId === s.id ? " selected" : ""}" data-id="${esc(s.id)}">
            ${s.thumbnail
              ? `<img class="sp-thumb" src="${s.thumbnail}" alt="">`
              : `<div class="sp-thumb skel"></div>`}
            ${TICK}
            <div class="sp-name">${esc(s.name)}</div>
          </div>`;

        body.innerHTML = list.length
          ? `<div class="sp-grid">` + list.map(tile).join("") + `</div>`
          : `<div class="sp-empty">${q
              ? "Nothing matches “" + esc(query) + "”."
              : "Nothing to show here."}</div>`;
      }

      function select(id) {
        selectedId = id;
        body.querySelectorAll(".sp-source").forEach(el =>
          el.classList.toggle("selected", el.dataset.id === id));
        confirm.disabled = !id;
      }

      body.onclick = (e) => {
        const el = e.target.closest(".sp-source");
        if (el && el.dataset.id) select(el.dataset.id);
      };
      /* Double-click is what everyone tries, and it saves a trip to the
         far corner of the dialog. */
      body.ondblclick = (e) => {
        const el = e.target.closest(".sp-source");
        if (el && el.dataset.id) { select(el.dataset.id); close(el.dataset.id); }
      };

      find.oninput = () => { query = find.value; render(); };

      tabs.onclick = (e) => {
        const b = e.target.closest(".sp-tab");
        if (!b) return;
        tab = b.dataset.tab;
        tabs.querySelectorAll(".sp-tab").forEach(x => x.classList.toggle("on", x === b));
        render();
      };

      function onKey(e) {
        if (e.key === "Escape") { e.preventDefault(); close(null); }
        else if (e.key === "Enter" && selectedId) { e.preventDefault(); close(selectedId); }
      }

      function close(val) {
        document.removeEventListener("keydown", onKey, true);
        overlay.classList.remove("open");
        setTimeout(() => overlay.classList.remove("visible"), 200);
        resolve(val || null);
      }

      confirm.disabled = true;
      confirm.onclick = () => close(selectedId);
      cancel.onclick  = () => close(null);
      closeBtn.onclick = () => close(null);
      overlay.onclick = (e) => { if (e.target === overlay) close(null); };
      document.addEventListener("keydown", onKey, true);

      find.value = "";
      tab = "all";
      tabs.querySelectorAll(".sp-tab").forEach(x =>
        x.classList.toggle("on", x.dataset.tab === "all"));
      hint.textContent = "Double-click to share straight away · Esc to cancel";
      render();

      overlay.classList.add("visible");
      requestAnimationFrame(() => overlay.classList.add("open"));
      setTimeout(() => { try { find.focus(); } catch (e) {} }, 60);

      /* Called with nothing: the dialog is already on screen while the
         thumbnails are still being captured, which is the whole reason
         it used to feel slow. */
      if (!all && window.electronAPI && window.electronAPI.getSources) {
        window.electronAPI.getSources().then(list => {
          all = Array.isArray(list) ? list : [];
          render();
        }).catch(() => { all = []; render(); });
      } else if (!all) {
        all = [];
        render();
      }
    });
  };
})();
