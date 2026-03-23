/* settings-panel.js — inject a slide-in settings drawer */
(function () {
  const AUTH_URL = "http://lobby-auth-server.onrender.com";
  const PRESETS  = ["#5865f2","#eb459e","#ed4245","#fee75c","#57f287","#00b0f4","#f47fff","#ff7b7d","#23a55a","#1e1f22"];

  const LOBBY_THEMES = {
    default:  { name:"Default",  emoji:"🌑", bg0:"#1e1f22", bg1:"#2b2d31", bg2:"#313338", bg3:"#383a40", accent:"#5865f2", accentH:"#4752c4", t1:"#f2f3f5", t2:"#b5bac1", t3:"#80848e" },
    midnight: { name:"Midnight", emoji:"🟣", bg0:"#0a0a0f", bg1:"#111118", bg2:"#1a1a24", bg3:"#22222f", accent:"#7c3aed", accentH:"#6d28d9", t1:"#f0f0ff", t2:"#a0a0c0", t3:"#606080" },
    forest:   { name:"Forest",   emoji:"🌲", bg0:"#0d1a0f", bg1:"#142018", bg2:"#1a2d1f", bg3:"#213828", accent:"#16a34a", accentH:"#15803d", t1:"#ecfdf5", t2:"#86efac", t3:"#4ade80" },
    ocean:    { name:"Ocean",    emoji:"🌊", bg0:"#030d1a", bg1:"#071828", bg2:"#0c2236", bg3:"#112c44", accent:"#0ea5e9", accentH:"#0284c7", t1:"#f0f9ff", t2:"#7dd3fc", t3:"#38bdf8" },
    sunset:   { name:"Sunset",   emoji:"🌅", bg0:"#1a0a0a", bg1:"#2a1010", bg2:"#381818", bg3:"#442020", accent:"#f97316", accentH:"#ea580c", t1:"#fff7ed", t2:"#fdba74", t3:"#fb923c" },
    rose:     { name:"Rose",     emoji:"🌹", bg0:"#1a0a10", bg1:"#2a1020", bg2:"#38182c", bg3:"#442038", accent:"#e11d48", accentH:"#be123c", t1:"#fff1f2", t2:"#fda4af", t3:"#fb7185" },
    nord:     { name:"Nord",     emoji:"❄️",  bg0:"#2e3440", bg1:"#3b4252", bg2:"#434c5e", bg3:"#4c566a", accent:"#88c0d0", accentH:"#81a1c1", t1:"#eceff4", t2:"#d8dee9", t3:"#a0a8b8" },
    mocha:    { name:"Mocha",    emoji:"☕", bg0:"#1c1917", bg1:"#292524", bg2:"#2d2b29", bg3:"#3d3935", accent:"#c2966c", accentH:"#a87a50", t1:"#fafaf9", t2:"#d6d3d1", t3:"#a8a29e" },
    light:    { name:"Light",    emoji:"☀️", bg0:"#f2f3f5", bg1:"#ffffff", bg2:"#e9eaec", bg3:"#d9dade", accent:"#5865f2", accentH:"#4752c4", t1:"#060607", t2:"#4e5058",  t3:"#80848e" },
    charizard:{ name:"Shiny Charizard", emoji:"🖤", bg0:"#0d0608", bg1:"#1a0c10", bg2:"#261018", bg3:"#321420", accent:"#8b1a2a", accentH:"#6e1220", t1:"#f5e6e8", t2:"#c9909a", t3:"#8a5560" },
  };

  if (!document.getElementById("sp-css")) {
    const link = document.createElement("link");
    link.id = "sp-css"; link.rel = "stylesheet"; link.href = "settingspanel.css";
    document.head.appendChild(link);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  function init() { injectHTML(); wireToggle(); wireNav(); }

  function injectHTML() {
    const el = document.createElement("div");
    el.innerHTML = `
<button id="settingsToggleBtn" title="Settings">⚙️</button>
<div id="settingsPanelBackdrop"></div>
<div id="settingsDrawer">
  <div class="sp-header">
    <span class="sp-title">⚙️ Settings</span>
    <button class="sp-close" id="spCloseBtn">✕</button>
  </div>
  <div class="sp-body">
    <nav class="sp-nav">
      <div class="sp-nav-label">My Account</div>
      <button class="sp-nav-btn active" data-sp="profile">👤 Profile</button>
      <button class="sp-nav-btn" data-sp="appearance">🎨 Appearance</button>
      <button class="sp-nav-btn" data-sp="themes">🖌 Themes</button>
      <button class="sp-nav-btn" data-sp="security">🔒 Password</button>
      <div class="sp-nav-label" style="margin-top:10px">App Settings</div>
      <button class="sp-nav-btn" data-sp="audiovideo">🎙 Audio & Video</button>
    </nav>

    <div class="sp-content">

      <!-- ── Profile ── -->
      <div class="sp-section active" id="sp-profile">
        <h2>My Profile</h2>
        <div class="sp-preview">
          <div class="sp-preview-banner" id="spPreviewBanner"></div>
          <div class="sp-preview-avatar-wrap">
            <div class="sp-preview-avatar" id="spPreviewAvatar">U</div>
          </div>
          <div class="sp-preview-body">
            <div class="sp-preview-username" id="spPreviewUsername">Loading…</div>
            <div class="sp-preview-status"   id="spPreviewStatus">● Online</div>
            <div class="sp-preview-bio"      id="spPreviewBio"></div>
          </div>
        </div>
        <div class="sp-form-group">
          <label class="sp-label">Avatar</label>
          <label class="sp-upload-btn" for="spAvatarInput">📷 Upload Avatar</label>
          <input type="file" id="spAvatarInput" accept="image/*" style="display:none" />
          <div class="sp-hint">GIF, PNG, JPG, WebP · max 8MB.</div>
        </div>
        <div class="sp-form-group">
          <label class="sp-label">Status Message</label>
          <input class="sp-input" id="spStatus" placeholder="What are you up to?" maxlength="100" />
        </div>
        <div class="sp-form-group">
          <label class="sp-label">Bio</label>
          <textarea class="sp-textarea" id="spBio" placeholder="Tell people about yourself…" maxlength="300"></textarea>
          <div class="sp-hint" id="spBioCounter">0 / 300</div>
        </div>
        <div class="sp-form-group">
          <label class="sp-label">Default Post Visibility</label>
          <select class="sp-select" id="spPostVisibility">
            <option value="public">🌐 Public</option>
            <option value="friends">👥 Friends only</option>
          </select>
        </div>
        <button class="sp-save-btn" id="spSaveProfile">Save Changes</button>
        <div class="sp-msg" id="spProfileMsg"></div>
      </div>

      <!-- ── Appearance ── -->
      <div class="sp-section" id="sp-appearance">
        <h2>Profile Appearance</h2>
        <div class="sp-form-group">
          <label class="sp-label">Banner Image</label>
          <label class="sp-upload-btn" for="spBannerInput" style="justify-content:center">🖼 Upload Banner</label>
          <input type="file" id="spBannerInput" accept="image/*" style="display:none" />
          <div class="sp-hint">Shown at the top of your profile. GIFs supported.</div>
        </div>
        <div class="sp-form-group">
          <label class="sp-label">Banner Colour</label>
          <div class="sp-colour-row">
            <input type="color" class="sp-colour-picker" id="spBannerColour" />
            <div class="sp-colour-presets" id="spColourPresets"></div>
          </div>
        </div>
        <button class="sp-save-btn" id="spSaveAppearance">Save Appearance</button>
        <div class="sp-msg" id="spAppearanceMsg"></div>

        <div style="margin-top:28px;padding-top:20px;border-top:1px solid rgba(255,255,255,.06)">
          <h2>Post Bar Background</h2>
          <div class="sp-form-group">
            <label class="sp-label">Background Image</label>
            <label class="sp-upload-btn" for="spComposeImageInput">🖼 Upload Image</label>
            <input type="file" id="spComposeImageInput" accept="image/*" style="display:none" />
          </div>
          <div class="sp-form-group">
            <label class="sp-label">Background Colour</label>
            <div class="sp-colour-row">
              <input type="color" class="sp-colour-picker" id="spComposeColour" value="#5865f2" />
              <div class="sp-colour-presets" id="spComposePresets"></div>
            </div>
          </div>
          <div class="sp-form-group">
            <label class="sp-label">Opacity <span id="spComposeOpacityLabel" style="color:var(--text-2);font-weight:400;text-transform:none;letter-spacing:0;font-size:12px">15%</span></label>
            <div class="sp-volume-row">
              <span class="sp-volume-icon">○</span>
              <div class="sp-volume-wrap"><input type="range" class="sp-slider" id="spComposeOpacity" min="0" max="40" value="15" /></div>
              <span class="sp-volume-icon">●</span>
            </div>
          </div>
          <button class="sp-save-btn" id="spSaveCompose">Save Post Bar Style</button>
          <button class="sp-save-btn" id="spClearCompose" style="background:var(--bg-3);color:var(--text-2);margin-left:8px">Clear</button>
          <div class="sp-msg" id="spComposeMsg"></div>
        </div>
      </div>

      <!-- ── Themes ── -->
      <div class="sp-section" id="sp-themes">
        <h2>Themes</h2>
        <p style="font-size:13px;color:var(--text-3);margin-top:-12px;margin-bottom:20px">Choose a colour preset crafted for LOBBY. Changes apply instantly.</p>

        <div class="sp-form-group">
          <label class="sp-label">Select Theme</label>
          <select class="sp-select" id="spThemeDropdown" onchange="window._spApplyTheme(this.value)">
            <option value="default">🌑 Default — Classic dark</option>
            <option value="midnight">🟣 Midnight — Deep purple</option>
            <option value="forest">🌲 Forest — Dark green</option>
            <option value="ocean">🌊 Ocean — Deep blue</option>
            <option value="sunset">🌅 Sunset — Warm orange</option>
            <option value="rose">🌹 Rose — Deep rose</option>
            <option value="nord">❄️ Nord — Arctic blue-grey</option>
            <option value="mocha">☕ Mocha — Warm brown</option>
            <option value="light">☀️ Light — Bright mode</option>
            <option value="charizard">🖤 Shiny Charizard — Black &amp; deep crimson</option>
          </select>
        </div>

        <div class="sp-form-group">
          <label class="sp-label">Colour Preview</label>
          <div id="spThemePreviewBar" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px"></div>
        </div>

        <div class="sp-theme-grid" id="spThemeGrid"></div>
      </div>

      <!-- ── Password ── -->
      <div class="sp-section" id="sp-security">
        <h2>Change Password</h2>
        <div class="sp-form-group">
          <label class="sp-label">Current Password</label>
          <input class="sp-input" type="password" id="spCurrentPw" placeholder="Enter current password" />
        </div>
        <div class="sp-form-group">
          <label class="sp-label">New Password</label>
          <input class="sp-input" type="password" id="spNewPw" placeholder="At least 6 characters" />
        </div>
        <div class="sp-form-group">
          <label class="sp-label">Confirm New Password</label>
          <input class="sp-input" type="password" id="spConfirmPw" placeholder="Repeat new password" />
        </div>
        <button class="sp-save-btn" id="spSavePassword">Change Password</button>
        <div class="sp-msg" id="spPasswordMsg"></div>
      </div>

      <!-- ── Audio & Video ── -->
      <div class="sp-section" id="sp-audiovideo">
        <h2>Audio & Video</h2>
        <div class="sp-form-group">
          <label class="sp-label">Microphone</label>
          <select class="sp-select" id="spMicSelect"></select>
        </div>
        <div class="sp-form-group">
          <label class="sp-label">Input Volume <span id="spInputVolLabel" style="color:var(--text-2);font-weight:400;text-transform:none;letter-spacing:0;font-size:12px">100%</span></label>
          <div class="sp-volume-row">
            <span class="sp-volume-icon">🔇</span>
            <div class="sp-volume-wrap"><input type="range" class="sp-slider" id="spInputVol" min="0" max="100" value="100" /></div>
            <span class="sp-volume-icon">🎙</span>
          </div>
        </div>
        <div class="sp-form-group">
          <label class="sp-label">Webcam</label>
          <select class="sp-select" id="spCamSelect"></select>
        </div>
        <div class="sp-form-group">
          <label class="sp-label">Speaker / Output Device</label>
          <select class="sp-select" id="spSpeakerSelect"></select>
        </div>
        <div class="sp-form-group">
          <label class="sp-label">Output Volume <span id="spOutputVolLabel" style="color:var(--text-2);font-weight:400;text-transform:none;letter-spacing:0;font-size:12px">100%</span></label>
          <div class="sp-volume-row">
            <span class="sp-volume-icon">🔇</span>
            <div class="sp-volume-wrap"><input type="range" class="sp-slider" id="spOutputVol" min="0" max="100" value="100" /></div>
            <span class="sp-volume-icon">🔊</span>
          </div>
        </div>
        <div class="sp-form-group">
          <label class="sp-label">Webcam Quality</label>
          <select class="sp-select" id="spCamQuality">
            <option value="720p30">720p 30fps</option>
            <option value="720p60">720p 60fps</option>
            <option value="1080p30" selected>1080p 30fps</option>
            <option value="1080p60">1080p 60fps</option>
            <option value="1440p30">1440p 30fps</option>
            <option value="1440p60">1440p 60fps</option>
            <option value="source">Source (max)</option>
          </select>
        </div>
        <div class="sp-form-group">
          <label class="sp-label">Screen Share Quality</label>
          <select class="sp-select" id="spScreenQuality">
            <option value="720p30">720p 30fps</option>
            <option value="720p60">720p 60fps</option>
            <option value="1080p30" selected>1080p 30fps</option>
            <option value="1080p60">1080p 60fps</option>
            <option value="1440p30">1440p 30fps</option>
            <option value="1440p60">1440p 60fps</option>
            <option value="source">Source (max)</option>
          </select>
        </div>
        <div class="sp-form-group">
          <label class="sp-label">Test Microphone</label>
          <div style="display:flex;gap:10px;align-items:center">
            <button class="sp-save-btn" id="spTestMicBtn" style="padding:8px 16px;font-size:13px;margin-top:0">🎤 Test Mic</button>
            <span id="spTestMicStatus" style="font-size:12px;color:var(--text-3)">Click to test</span>
          </div>
          <canvas class="sp-mic-meter" id="spMicMeter" width="400" height="22"></canvas>
        </div>
        <button class="sp-save-btn" id="spSaveAV">Save Audio & Video</button>
        <div class="sp-msg" id="spAVMsg"></div>
      </div>

    </div><!-- sp-content -->
  </div><!-- sp-body -->
</div><!-- settingsDrawer -->`;
    document.body.appendChild(el);
  }

  function wireToggle() {
    document.getElementById("settingsPanelBackdrop").addEventListener("click", closePanel);
    document.getElementById("spCloseBtn").addEventListener("click", closePanel);
    document.addEventListener("keydown", e => { if (e.key === "Escape") closePanel(); });
    // Wire trigger button — retry until found
    function wireTrigger(attempts) {
      const trigger = document.getElementById("spTriggerBtn");
      if (trigger) {
        trigger.addEventListener("click", togglePanel);
      } else if (attempts > 0) {
        setTimeout(() => wireTrigger(attempts - 1), 100);
      }
    }
    wireTrigger(20);
  }

  function togglePanel() {
    const isOpen = document.getElementById("settingsDrawer").classList.contains("open");
    isOpen ? closePanel() : openPanel();
  }

  function openPanel() {
    document.getElementById("settingsDrawer").classList.add("open");
    document.getElementById("settingsPanelBackdrop").classList.add("open");
    const t = document.getElementById("spTriggerBtn");
    if (t) { t.style.color = "var(--accent)"; t.style.background = "var(--bg-3)"; }
    loadProfile();
  }

  function closePanel() {
    document.getElementById("settingsDrawer").classList.remove("open");
    document.getElementById("settingsPanelBackdrop").classList.remove("open");
    const t = document.getElementById("spTriggerBtn");
    if (t) { t.style.color = ""; t.style.background = ""; }
  }

  function wireNav() {
    document.querySelectorAll(".sp-nav-btn[data-sp]").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".sp-nav-btn").forEach(b => b.classList.remove("active"));
        document.querySelectorAll(".sp-section").forEach(s => s.classList.remove("active"));
        btn.classList.add("active");
        document.getElementById(`sp-${btn.dataset.sp}`).classList.add("active");
        if (btn.dataset.sp === "audiovideo") loadAVDevices();
        if (btn.dataset.sp === "themes") loadThemeSection();
      });
    });

    document.getElementById("spSaveProfile").addEventListener("click", saveProfile);
    document.getElementById("spSaveAppearance").addEventListener("click", saveAppearance);
    document.getElementById("spSavePassword").addEventListener("click", savePassword);
    document.getElementById("spSaveAV").addEventListener("click", saveAV);
    document.getElementById("spTestMicBtn").addEventListener("click", toggleMicTest);
    document.getElementById("spAvatarInput").addEventListener("change", uploadAvatar);
    document.getElementById("spBannerInput").addEventListener("change", uploadBanner);
    document.getElementById("spComposeImageInput").addEventListener("change", uploadComposeImage);
    document.getElementById("spSaveCompose").addEventListener("click", saveComposeStyle);
    document.getElementById("spClearCompose").addEventListener("click", clearComposeStyle);

    const composeOpacitySlider = document.getElementById("spComposeOpacity");
    composeOpacitySlider.addEventListener("input", () => {
      document.getElementById("spComposeOpacityLabel").textContent = `${composeOpacitySlider.value}%`;
      updateSliderFill(composeOpacitySlider);
      applyComposePreview();
    });
    document.getElementById("spComposeColour").addEventListener("input", () => {
      buildComposePresets(document.getElementById("spComposeColour").value);
      applyComposePreview();
    });
    loadComposeStyle();

    document.getElementById("spBannerColour").addEventListener("input", e => {
      spPendingColour = e.target.value;
      document.querySelectorAll(".sp-colour-preset").forEach(el => el.classList.remove("selected"));
      updateBannerPreview(null, e.target.value);
    });
    document.getElementById("spBio").addEventListener("input", function () {
      document.getElementById("spBioCounter").textContent = `${this.value.length} / 300`;
      document.getElementById("spPreviewBio").textContent = this.value;
    });
    document.getElementById("spStatus").addEventListener("input", function () {
      document.getElementById("spPreviewStatus").textContent = this.value ? `● ${this.value}` : "● Online";
    });
  }

  /* ── Theme section ─────────────────────────────────────────── */
  function loadThemeSection() {
    const current = localStorage.getItem("lobby_theme") || "default";
    const dd = document.getElementById("spThemeDropdown");
    if (dd) dd.value = current;
    buildThemeGrid(current);
    buildThemePreviewBar(current);
  }

  window._spApplyTheme = function(id) {
    const t = LOBBY_THEMES[id];
    if (!t) return;
    const r = document.documentElement;
    r.style.setProperty("--bg-0", t.bg0);   r.style.setProperty("--bg-1", t.bg1);
    r.style.setProperty("--bg-2", t.bg2);   r.style.setProperty("--bg-3", t.bg3);
    r.style.setProperty("--accent", t.accent); r.style.setProperty("--accent-h", t.accentH);
    r.style.setProperty("--text-1", t.t1);  r.style.setProperty("--text-2", t.t2);
    r.style.setProperty("--text-3", t.t3);
    localStorage.setItem("lobby_theme", id);
    buildThemeGrid(id);
    buildThemePreviewBar(id);
    // sync index.html setTheme if available
    if (typeof window.setTheme === "function") window.setTheme(id);
  };

  function buildThemeGrid(active) {
    const grid = document.getElementById("spThemeGrid");
    if (!grid) return;
    grid.innerHTML = Object.entries(LOBBY_THEMES).map(([id, t]) => `
      <div class="sp-theme-card ${id === active ? "active" : ""}" onclick="window._spApplyTheme('${id}');document.getElementById('spThemeDropdown').value='${id}'">
        <div class="sp-theme-preview" style="background:${t.bg1}">
          <div class="sp-theme-dot" style="background:${t.bg0}"></div>
          <div class="sp-theme-dot" style="background:${t.accent}"></div>
          <div class="sp-theme-dot" style="background:${t.t1}"></div>
        </div>
        <div class="sp-theme-label" style="background:${t.bg2};color:${t.t1}">
          ${t.emoji} ${t.name}
        </div>
      </div>`).join("");
  }

  function buildThemePreviewBar(id) {
    const t = LOBBY_THEMES[id] || LOBBY_THEMES.default;
    const bar = document.getElementById("spThemePreviewBar");
    if (!bar) return;
    const swatches = [
      { label:"Background", color:t.bg0 }, { label:"Surface", color:t.bg1 },
      { label:"Card",       color:t.bg2 }, { label:"Elevated", color:t.bg3 },
      { label:"Accent",     color:t.accent }, { label:"Text", color:t.t1 },
    ];
    bar.innerHTML = swatches.map(s => `
      <div style="display:flex;flex-direction:column;align-items:center;gap:4px">
        <div style="width:40px;height:40px;border-radius:10px;background:${s.color};border:1px solid rgba(255,255,255,.12)"></div>
        <div style="font-size:9px;color:var(--text-3);text-align:center">${s.label}</div>
      </div>`).join("");
  }

  /* ── API helpers ───────────────────────────────────────────── */
  function token() { return localStorage.getItem("vh_token") || sessionStorage.getItem("vh_token"); }
  function authH() { return { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" }; }
  async function api(path, opts = {}) {
    return fetch(`${AUTH_URL}${path}`, { ...opts, headers: { ...authH(), ...(opts.headers || {}) } }).then(r => r.json());
  }

  let spMe = null, spPendingColour = "#5865f2", spTestMicStream = null, spMicMeterAnim = null;

  async function loadProfile() {
    if (!token()) return;
    spMe = await api("/me");
    if (spMe.error) return;
    const profile = await api(`/profile/${spMe.id}`);
    document.getElementById("spPreviewUsername").textContent = spMe.username;
    document.getElementById("spStatus").value = profile.status || "";
    document.getElementById("spBio").value    = profile.bio    || "";
    document.getElementById("spBioCounter").textContent = `${(profile.bio||"").length} / 300`;
    document.getElementById("spPreviewBio").textContent  = profile.bio || "";
    document.getElementById("spPreviewStatus").textContent = profile.status ? `● ${profile.status}` : "● Online";
    document.getElementById("spPostVisibility").value = profile.post_visibility || "public";
    const av = document.getElementById("spPreviewAvatar");
    if (profile.avatar_url) av.innerHTML = `<img src="${profile.avatar_url}" />`;
    else av.textContent = spMe.username.slice(0,1).toUpperCase();
    av.onclick = () => document.getElementById("spAvatarInput").click();
    updateBannerPreview(profile.banner_url, profile.banner_colour || "#5865f2");
    spPendingColour = profile.banner_colour || "#5865f2";
    document.getElementById("spBannerColour").value = spPendingColour;
    buildColourPresets(spPendingColour);
    document.getElementById("spPreviewBanner").onclick = () => document.getElementById("spBannerInput").click();
  }

  function updateBannerPreview(imageUrl, colour) {
    const el = document.getElementById("spPreviewBanner");
    if (imageUrl) {
      el.style.backgroundImage = `url(${imageUrl})`; el.style.backgroundSize = "cover";
      el.style.backgroundPosition = "center"; el.style.backgroundColor = "transparent";
    } else {
      el.style.backgroundImage = "none"; el.style.backgroundColor = colour || "#5865f2";
    }
  }

  function buildColourPresets(selected) {
    const container = document.getElementById("spColourPresets");
    container.innerHTML = PRESETS.map(c => `
      <div class="sp-colour-preset ${c === selected ? "selected" : ""}" style="background:${c}" title="${c}"
        onclick="(function(){ window._spSelectColour('${c}'); })()"></div>`).join("");
  }

  window._spSelectColour = function(colour) {
    spPendingColour = colour;
    document.getElementById("spBannerColour").value = colour;
    document.querySelectorAll(".sp-colour-preset").forEach(el => el.classList.toggle("selected", el.title === colour));
    updateBannerPreview(null, colour);
  };

  async function uploadAvatar(e) {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const src = ev.target.result;
      document.getElementById("spPreviewAvatar").innerHTML = `<img src="${src}" />`;
      ["myAvatar","myPanelAvatar","composeAvatar"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = `<img src="${src}" style="width:100%;height:100%;object-fit:cover" />`;
      });
    };
    reader.readAsDataURL(file);
    const form = new FormData(); form.append("avatar", file);
    const r = await fetch(`${AUTH_URL}/avatar`, { method:"POST", headers:{ Authorization:`Bearer ${token()}` }, body:form }).then(r=>r.json());
    spShowMsg("spProfileMsg", r.error ? r.error : "Avatar updated!", r.error ? "error" : "success");
    e.target.value = "";
  }

  async function uploadBanner(e) {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => updateBannerPreview(ev.target.result, null);
    reader.readAsDataURL(file);
    const form = new FormData(); form.append("banner", file);
    const r = await fetch(`${AUTH_URL}/banner`, { method:"POST", headers:{ Authorization:`Bearer ${token()}` }, body:form }).then(r=>r.json());
    if (r.error) spShowMsg("spAppearanceMsg", r.error, "error");
    else { spShowMsg("spAppearanceMsg", "Banner updated!", "success"); refreshAllPanelBanners(r.bannerUrl, null); }
    e.target.value = "";
  }

  function refreshAllPanelBanners(imageUrl, colour) {
    ["userPanelBanner","chatPanelBanner"].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      if (imageUrl) {
        el.style.backgroundImage = `url(${imageUrl})`; el.style.backgroundSize = "cover";
        el.style.backgroundPosition = "center"; el.style.backgroundColor = "transparent"; el.style.opacity = "0.18";
      } else if (colour) {
        el.style.backgroundImage = "none"; el.style.backgroundColor = colour; el.style.opacity = "0.3";
      }
    });
  }

  async function saveProfile() {
    const r = await api("/profile", { method:"PATCH", body:JSON.stringify({ bio:document.getElementById("spBio").value.trim(), status:document.getElementById("spStatus").value.trim() })});
    await api("/profile/visibility", { method:"PATCH", body:JSON.stringify({ visibility:document.getElementById("spPostVisibility").value })});
    spShowMsg("spProfileMsg", r.success ? "Saved!" : r.error||"Failed", r.success ? "success" : "error");
  }

  async function saveAppearance() {
    const r = await api("/profile", { method:"PATCH", body:JSON.stringify({ bannerColour:spPendingColour })});
    spShowMsg("spAppearanceMsg", r.success ? "Saved!" : r.error||"Failed", r.success ? "success" : "error");
    buildColourPresets(spPendingColour);
    if (r.success) refreshAllPanelBanners(null, spPendingColour);
  }

  async function savePassword() {
    const current = document.getElementById("spCurrentPw").value;
    const newPw   = document.getElementById("spNewPw").value;
    const confirm = document.getElementById("spConfirmPw").value;
    if (!current || !newPw) { spShowMsg("spPasswordMsg", "Fill in all fields", "error"); return; }
    if (newPw !== confirm)  { spShowMsg("spPasswordMsg", "Passwords do not match", "error"); return; }
    if (newPw.length < 6)   { spShowMsg("spPasswordMsg", "Min 6 characters", "error"); return; }
    const r = await api("/profile/password", { method:"PATCH", body:JSON.stringify({ currentPassword:current, newPassword:newPw })});
    spShowMsg("spPasswordMsg", r.success ? "Password changed!" : r.error||"Failed", r.success ? "success" : "error");
    if (r.success) { document.getElementById("spCurrentPw").value = ""; document.getElementById("spNewPw").value = ""; document.getElementById("spConfirmPw").value = ""; }
  }

  async function loadAVDevices() {
    try { await navigator.mediaDevices.getUserMedia({ audio:true, video:true }); } catch {}
    const devices  = await navigator.mediaDevices.enumerateDevices();
    populateSel("spMicSelect",     devices.filter(d=>d.kind==="audioinput"),  localStorage.getItem("vh_mic")||"");
    populateSel("spCamSelect",     devices.filter(d=>d.kind==="videoinput"),  localStorage.getItem("vh_cam")||"");
    populateSel("spSpeakerSelect", devices.filter(d=>d.kind==="audiooutput"), localStorage.getItem("vh_speaker")||"");
    document.getElementById("spCamQuality").value    = localStorage.getItem("vh_camQuality")||"1080p30";
    document.getElementById("spScreenQuality").value = localStorage.getItem("vh_screenQuality")||"1080p30";
    const inVol = localStorage.getItem("vh_inputVolume")||"100";
    const outVol = localStorage.getItem("vh_outputVolume")||"100";
    const inSlider = document.getElementById("spInputVol");
    const outSlider = document.getElementById("spOutputVol");
    inSlider.value = inVol; outSlider.value = outVol;
    document.getElementById("spInputVolLabel").textContent  = `${inVol}%`;
    document.getElementById("spOutputVolLabel").textContent = `${outVol}%`;
    updateSliderFill(inSlider); updateSliderFill(outSlider);
    inSlider.oninput  = () => { document.getElementById("spInputVolLabel").textContent  = `${inSlider.value}%`;  updateSliderFill(inSlider); };
    outSlider.oninput = () => { document.getElementById("spOutputVolLabel").textContent = `${outSlider.value}%`; updateSliderFill(outSlider); };
  }

  function populateSel(id, devices, saved) {
    const sel = document.getElementById(id);
    sel.innerHTML = devices.length ? "" : `<option value="">No devices found</option>`;
    devices.forEach((d, i) => {
      const opt = document.createElement("option");
      opt.value = d.deviceId; opt.text = d.label || `Device ${i+1}`;
      if (d.deviceId === saved) opt.selected = true;
      sel.appendChild(opt);
    });
  }

  function updateSliderFill(slider) {
    const pct = ((slider.value - slider.min) / (slider.max - slider.min)) * 100;
    slider.style.background = `linear-gradient(to right, var(--accent) ${pct}%, var(--bg-3) ${pct}%)`;
  }

  function saveAV() {
    localStorage.setItem("vh_mic",           document.getElementById("spMicSelect").value);
    localStorage.setItem("vh_cam",           document.getElementById("spCamSelect").value);
    localStorage.setItem("vh_speaker",       document.getElementById("spSpeakerSelect").value);
    localStorage.setItem("vh_camQuality",    document.getElementById("spCamQuality").value);
    localStorage.setItem("vh_screenQuality", document.getElementById("spScreenQuality").value);
    localStorage.setItem("vh_inputVolume",   document.getElementById("spInputVol").value);
    localStorage.setItem("vh_outputVolume",  document.getElementById("spOutputVol").value);
    spShowMsg("spAVMsg", "Audio & Video settings saved!", "success");
  }

  async function toggleMicTest() {
    const btn = document.getElementById("spTestMicBtn");
    const status = document.getElementById("spTestMicStatus");
    if (spTestMicStream) {
      spTestMicStream.getTracks().forEach(t => t.stop());
      spTestMicStream = null; cancelAnimationFrame(spMicMeterAnim);
      btn.textContent = "🎤 Test Mic"; status.textContent = "Click to test";
      const ctx = document.getElementById("spMicMeter").getContext("2d");
      ctx.clearRect(0, 0, 400, 22); return;
    }
    try {
      const deviceId = document.getElementById("spMicSelect").value;
      spTestMicStream = await navigator.mediaDevices.getUserMedia({ audio:{ deviceId: deviceId ? { exact:deviceId } : undefined }, video:false });
      btn.textContent = "⏹ Stop"; status.textContent = "Speak into your mic…";
      const audioCtx = new AudioContext(); const analyser = audioCtx.createAnalyser();
      audioCtx.createMediaStreamSource(spTestMicStream).connect(analyser);
      analyser.fftSize = 256;
      const data = new Uint8Array(analyser.frequencyBinCount);
      const canvas = document.getElementById("spMicMeter"); const ctx = canvas.getContext("2d");
      function draw() {
        spMicMeterAnim = requestAnimationFrame(draw); analyser.getByteFrequencyData(data);
        const avg = data.reduce((a,b) => a+b, 0) / data.length;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const grad = ctx.createLinearGradient(0, 0, canvas.width, 0);
        grad.addColorStop(0, "#23a55a"); grad.addColorStop(0.6, "#fee75c"); grad.addColorStop(1, "#ed4245");
        ctx.fillStyle = grad; ctx.fillRect(0, 0, (avg/128)*canvas.width, canvas.height);
      }
      draw();
    } catch(e) { status.textContent = "Error: " + e.message; }
  }

  let spComposeImageUrl = null;

  function buildComposePresets(selected) {
    const container = document.getElementById("spComposePresets"); if (!container) return;
    container.innerHTML = PRESETS.map(c => `
      <div class="sp-colour-preset ${c===selected?"selected":""}" style="background:${c}" title="${c}"
        onclick="(function(){ window._spSelectComposeColour('${c}'); })()"></div>`).join("");
  }

  window._spSelectComposeColour = function(colour) {
    document.getElementById("spComposeColour").value = colour;
    buildComposePresets(colour); applyComposePreview();
  };

  function loadComposeStyle() {
    const saved = JSON.parse(localStorage.getItem("vh_compose_bg") || "{}");
    spComposeImageUrl = (saved.imageUrl && saved.imageUrl.startsWith("data:")) ? saved.imageUrl : null;
    const colour = saved.colour || "#5865f2";
    const opacity = saved.opacity !== undefined ? saved.opacity : 15;
    document.getElementById("spComposeColour").value = colour;
    document.getElementById("spComposeOpacity").value = opacity;
    document.getElementById("spComposeOpacityLabel").textContent = `${opacity}%`;
    updateSliderFill(document.getElementById("spComposeOpacity"));
    buildComposePresets(colour); applyComposeBanner();
  }

  function applyComposePreview() { applyComposeBanner(); }

  function applyComposeBanner() {
    const el = document.getElementById("composeBanner"); if (!el) return;
    const saved = JSON.parse(localStorage.getItem("vh_compose_bg") || "{}");
    const imageUrl = spComposeImageUrl || saved.imageUrl || null;
    const colour = document.getElementById("spComposeColour")?.value || saved.colour || "#5865f2";
    const opacity = (parseInt(document.getElementById("spComposeOpacity")?.value ?? saved.opacity ?? 15)) / 100;
    if (imageUrl) {
      el.style.backgroundImage = `url(${imageUrl})`; el.style.backgroundSize = "cover";
      el.style.backgroundPosition = "center"; el.style.backgroundColor = "transparent";
    } else { el.style.backgroundImage = "none"; el.style.backgroundColor = colour; }
    el.style.opacity = opacity;
  }

  async function uploadComposeImage(e) {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => { spComposeImageUrl = ev.target.result; applyComposePreview(); };
    reader.readAsDataURL(file); e.target.value = "";
  }

  function saveComposeStyle() {
    const colour = document.getElementById("spComposeColour").value;
    const opacity = document.getElementById("spComposeOpacity").value;
    const imageUrl = (spComposeImageUrl && spComposeImageUrl.startsWith("data:")) ? spComposeImageUrl : null;
    localStorage.setItem("vh_compose_bg", JSON.stringify({ imageUrl, colour, opacity:parseInt(opacity) }));
    applyComposeBanner(); spShowMsg("spComposeMsg", "Post bar style saved!", "success");
  }

  function clearComposeStyle() {
    spComposeImageUrl = null; localStorage.removeItem("vh_compose_bg");
    const el = document.getElementById("composeBanner");
    if (el) { el.style.backgroundImage = "none"; el.style.backgroundColor = "transparent"; el.style.opacity = "0"; }
    spShowMsg("spComposeMsg", "Cleared!", "success");
  }

  const spMsgTimers = {};
  function spShowMsg(id, text, type) {
    const el = document.getElementById(id); if (!el) return;
    el.textContent = text; el.className = `sp-msg ${type}`;
    clearTimeout(spMsgTimers[id]);
    spMsgTimers[id] = setTimeout(() => el.className = "sp-msg", 4000);
  }

  // Expose functions globally for onclick handlers
  window._spApplyTheme = (themeId) => {
    const btn = document.querySelector(`[data-theme-btn="${themeId}"]`);
    if (btn) btn.click();
  };
  window._spSwitchCat = (catId) => {
    const btn = document.querySelector(`[data-sp="${catId}"]`);
    if (btn) btn.click();
  };
  window.spSelect = (id) => {
    const el = document.getElementById(id);
    if (el && el.click) el.click();
  };

})();