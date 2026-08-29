// ============================================================
// preload.js — secure bridge between main and renderer
// ============================================================

const { contextBridge, ipcRenderer, webFrame } = require("electron");

// ── Zoom API ──────────────────────────────────────────────────────
// Native Electron zoom is preferred over CSS `zoom` because it scales
// fonts crisply, doesn't break layout calculations, and is what the
// rest of Chromium uses for Ctrl+/Ctrl-. Exposed to the renderer so
// the in-app Ctrl+Scroll HUD can drive it.
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;
const ZOOM_STEP = 0.1;
function _clampZoom(z) { return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(z * 100) / 100)); }

contextBridge.exposeInMainWorld("electronAPI", {
  getSources: () => ipcRenderer.invoke("get-desktop-sources"),
  // ── Zoom controls (renderer-side via webFrame, no IPC needed) ───
  getZoomFactor: () => { try { return webFrame.getZoomFactor(); } catch { return 1.0; } },
  setZoomFactor: (factor) => { try { webFrame.setZoomFactor(_clampZoom(factor)); return webFrame.getZoomFactor(); } catch { return 1.0; } },
  zoomBy: (delta) => {
    try {
      const cur = webFrame.getZoomFactor();
      const next = _clampZoom(cur + delta);
      webFrame.setZoomFactor(next);
      return next;
    } catch { return 1.0; }
  },
  resetZoom: () => { try { webFrame.setZoomFactor(1.0); return 1.0; } catch { return 1.0; } },
  navigate: (page, direction) => ipcRenderer.invoke("navigate", page, direction),
  openCallWindow: () => ipcRenderer.invoke("open-call-window"),
  closeCallWindow: () => ipcRenderer.invoke("close-call-window"),
  openOutgoingCallWindow: () => ipcRenderer.invoke("open-outgoing-call-window"),
  closeOutgoingCallWindow: () => ipcRenderer.invoke("close-outgoing-call-window"),
  openSteamWindow: (url) => ipcRenderer.invoke("open-steam-window", url),
  // Hand Steam an app id and ask it to start the game. Validated and
  // turned into a steam:// URL in the main process, never here.
  launchSteamGame: (appid) => ipcRenderer.invoke("launch-steam-game", appid),
  setAppIcon: (buffer) => ipcRenderer.invoke("set-app-icon", buffer),

  // ── Voice Channel native PiP window ──────────────────────
  openVcPip: (opts) => ipcRenderer.invoke("vc-pip-open", opts),
  closeVcPip: () => ipcRenderer.invoke("vc-pip-close"),
  updateVcPip: (data) => ipcRenderer.invoke("vc-pip-update", data),
  vcPipAction: (action) => ipcRenderer.invoke("vc-pip-action", action),

  // Listeners for vcpip.html (the pip window itself)
  onVcPipData: (cb) => ipcRenderer.on("vc-pip-data", (_e, d) => cb(d)),
  onVcPipResized: (cb) => ipcRenderer.on("vc-pip-resized", (_e, d) => cb(d)),

  // Listeners for index.html (receive actions/events from pip window)
  onVcPipAction: (cb) => ipcRenderer.on("vc-pip-action", (_e, a) => cb(a)),
  onVcPipClosed: (cb) => ipcRenderer.on("vc-pip-closed", () => cb()),

  // ── Window controls (frameless) ───────────────────────────
  minimizeWindow: () => ipcRenderer.invoke("win-minimize"),
  maximizeWindow: () => ipcRenderer.invoke("win-maximize"),
  closeWindow:    () => ipcRenderer.invoke("win-close"),
  setTitlebarOverlay: (opts) => ipcRenderer.invoke("set-titlebar-overlay", opts),

  // ── Auto-Updater ─────────────────────────────────────────
  getAppVersion:   () => ipcRenderer.invoke("get-app-version"),
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  downloadUpdate:  (url, fileName) => ipcRenderer.invoke("download-update", url, fileName),
  onUpdateProgress: (cb) => ipcRenderer.on("update-download-progress", (_e, d) => cb(d)),
});