// ============================================================
// preload.js — secure bridge between main and renderer
// ============================================================

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  getSources: () => ipcRenderer.invoke("get-desktop-sources"),
  navigate: (page, direction) => ipcRenderer.invoke("navigate", page, direction),
  openCallWindow: () => ipcRenderer.invoke("open-call-window"),
  closeCallWindow: () => ipcRenderer.invoke("close-call-window"),
  openOutgoingCallWindow: () => ipcRenderer.invoke("open-outgoing-call-window"),
  closeOutgoingCallWindow: () => ipcRenderer.invoke("close-outgoing-call-window"),
  openSteamWindow: (url) => ipcRenderer.invoke("open-steam-window", url),
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

  // ── Auto-Updater ─────────────────────────────────────────
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  downloadUpdate: (url, fileName) => ipcRenderer.invoke("download-update", url, fileName),
  onUpdateProgress: (cb) => ipcRenderer.on("update-download-progress", (_e, d) => cb(d)),
});
