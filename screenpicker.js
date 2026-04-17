// ============================================================
//  screenpicker.js — shared screen/window source picker
//  Injected at runtime into any page that needs it.
//  Used by: index.html (voice channels), chat.html (1-1 & group calls)
// ============================================================

(function () {
  "use strict";

  // Inject CSS once
  if (!document.getElementById("sp-styles")) {
    const style = document.createElement("style");
    style.id = "sp-styles";
    style.textContent = `
      #sourcePickerOverlay {
        display:none; position:fixed; inset:0; z-index:99998;
        background:rgba(0,0,0,.7); backdrop-filter:blur(8px);
        align-items:flex-end; justify-content:center;
        padding-bottom:0;
      }
      #sourcePickerOverlay.visible { display:flex; }
      #sourcePickerOverlay.open { display:flex; }
      #sourcePickerModal {
        background:var(--bg-1); border-radius:16px 16px 0 0;
        width:min(720px, 100vw); max-height:75vh;
        display:flex; flex-direction:column;
        box-shadow:0 -12px 48px rgba(0,0,0,.6);
        border:1px solid rgba(255,255,255,.08); border-bottom:none;
        transform:translateY(100%);
        transition:transform .35s cubic-bezier(0.16,1,0.3,1);
      }
      #sourcePickerOverlay.open #sourcePickerModal { transform:translateY(0); }
      .sp-header {
        display:flex; align-items:center; justify-content:space-between;
        padding:20px 24px 0;
      }
      .sp-title {
        display:flex; align-items:center; gap:10px;
        font-size:17px; font-weight:700; color:var(--text-1);
      }
      .sp-title svg { color:var(--accent); }
      .sp-close {
        background:var(--bg-3); border:none; border-radius:50%;
        width:28px; height:28px; display:flex; align-items:center; justify-content:center;
        color:var(--text-3); cursor:pointer; transition:background .15s, color .15s;
      }
      .sp-close:hover { background:var(--bg-0); color:var(--text-1); }
      .sp-subtitle { padding:6px 24px 0; font-size:13px; color:var(--text-3); }
      .sp-grid {
        display:grid; grid-template-columns:repeat(auto-fill, minmax(180px, 1fr));
        gap:10px; padding:16px 24px; overflow-y:auto; flex:1;
      }
      .sp-source {
        background:var(--bg-2); border-radius:10px; cursor:pointer;
        border:2px solid transparent; transition:border-color .15s, background .15s;
        overflow:hidden; display:flex; flex-direction:column;
      }
      .sp-source:hover { background:var(--bg-3); }
      .sp-source.selected { border-color:var(--accent); background:rgba(88,101,242,.08); }
      .sp-source-thumb {
        width:100%; aspect-ratio:16/9; object-fit:cover;
        background:var(--bg-0); display:block;
      }
      .sp-source-thumb-placeholder {
        width:100%; aspect-ratio:16/9; background:var(--bg-0);
        display:flex; align-items:center; justify-content:center;
        color:var(--text-3); font-size:28px;
      }
      .sp-source-name {
        padding:8px 10px; font-size:12px; font-weight:600;
        color:var(--text-2); white-space:nowrap;
        overflow:hidden; text-overflow:ellipsis;
      }
      .sp-footer {
        display:flex; justify-content:flex-end; gap:10px;
        padding:14px 24px; border-top:1px solid rgba(255,255,255,.06);
        flex-shrink:0;
      }
      .sp-btn-cancel {
        background:var(--bg-3); border:none; border-radius:8px;
        color:var(--text-2); font-size:13px; font-weight:600; font-family:var(--font);
        padding:8px 18px; cursor:pointer; transition:background .15s, color .15s;
      }
      .sp-btn-cancel:hover { background:var(--bg-0); color:var(--text-1); }
      .sp-btn-share {
        background:var(--accent); border:none; border-radius:8px;
        color:#fff; font-size:13px; font-weight:700; font-family:var(--font);
        padding:8px 20px; cursor:pointer; transition:background .15s, opacity .15s;
      }
      .sp-btn-share:hover:not(:disabled) { background:var(--accent-h,#4752c4); }
      .sp-btn-share:disabled { opacity:.4; cursor:not-allowed; }
    `;
    document.head.appendChild(style);
  }

  // Inject HTML once
  if (!document.getElementById("sourcePickerOverlay")) {
    const div = document.createElement("div");
    div.innerHTML = `
      <div id="sourcePickerOverlay">
        <div id="sourcePickerModal">
          <div class="sp-header">
            <div class="sp-title">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="2" y="3" width="20" height="14" rx="2"/>
                <line x1="8" y1="21" x2="16" y2="21"/>
                <line x1="12" y1="17" x2="12" y2="21"/>
              </svg>
              Share Your Screen
            </div>
            <button class="sp-close" id="sourcePickerClose">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
          <p class="sp-subtitle">Choose a window or screen to share</p>
          <div class="sp-grid" id="sourcePickerGrid"></div>
          <div class="sp-footer">
            <button class="sp-btn-cancel" id="sourcePickerCancel">Cancel</button>
            <button class="sp-btn-share" id="sourcePickerConfirm" disabled>Share</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(div.firstElementChild);
  }

  // Expose globally — safe to call from any page
  window.openSourcePicker = function (sources) {
    return new Promise(resolve => {
      const overlay  = document.getElementById("sourcePickerOverlay");
      const grid     = document.getElementById("sourcePickerGrid");
      const confirm  = document.getElementById("sourcePickerConfirm");
      const cancel   = document.getElementById("sourcePickerCancel");
      const closeBtn = document.getElementById("sourcePickerClose");
      let selectedId = null;

      grid.innerHTML = sources.map(s => {
        const thumb = typeof s.thumbnail === "string"
          ? `<img class="sp-source-thumb" src="${s.thumbnail}" />`
          : `<div class="sp-source-thumb-placeholder">🖥</div>`;
        return `<div class="sp-source" data-id="${s.id}" onclick="spSelect(this,'${s.id}')">
          ${thumb}
          <div class="sp-source-name">${s.name}</div>
        </div>`;
      }).join("");

      window.spSelect = (el, id) => {
        document.querySelectorAll(".sp-source").forEach(e => e.classList.remove("selected"));
        el.classList.add("selected");
        selectedId = id;
        confirm.disabled = false;
      };

      const close = (val) => {
        overlay.classList.remove("open");
        setTimeout(() => overlay.classList.remove("visible"), 350);
        resolve(val || null);
      };

      confirm.disabled = true;
      confirm.onclick  = () => close(selectedId);
      cancel.onclick   = () => close(null);
      closeBtn.onclick = () => close(null);
      overlay.onclick  = (e) => { if (e.target === overlay) close(null); };

      overlay.classList.add("visible");
      requestAnimationFrame(() => overlay.classList.add("open"));
    });
  };
})();