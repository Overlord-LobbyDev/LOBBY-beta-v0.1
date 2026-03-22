// ============================================================
//  main.js  —  Electron main process
// ============================================================

const { app, BrowserWindow, ipcMain, desktopCapturer, session, shell, screen } = require("electron");
const path = require("path");

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    icon: path.join(__dirname, "icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ["media", "audioCapture", "videoCapture"];
    callback(allowed.includes(permission));
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (
      url.startsWith("https://steamcommunity.com") ||
      url.startsWith("https://lobby-auth-server.onrender.com/steam")
    ) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 850, height: 650, autoHideMenuBar: true, title: "Sign in through Steam",
          webPreferences: { contextIsolation: true, nodeIntegration: false }
        }
      };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });

  ipcMain.handle("open-steam-window", (event, url) => {
    const steamWin = new BrowserWindow({
      width: 850, height: 650, autoHideMenuBar: true, title: "Sign in through Steam",
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    });
    steamWin.loadURL(url);
    steamWin.webContents.on("did-navigate", (e, navUrl) => {
      if (navUrl.startsWith("https://lobby-auth-server.onrender.com/steam/callback")) {
        setTimeout(() => { try { if (steamWin && !steamWin.isDestroyed()) steamWin.close(); } catch(e) {} }, 2500);
      }
    });
    steamWin.on("closed", () => {});
  });

  win.loadFile("login.html");
}

ipcMain.handle("navigate", (event, page, direction = "fade") => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.loadFile(page, { query: { transition: direction } });
});

let callWindow = null;
let outgoingCallWindow = null;

ipcMain.handle("open-call-window", (event) => {
  if (callWindow && !callWindow.isDestroyed()) { callWindow.focus(); return; }
  callWindow = new BrowserWindow({
    width: 320, height: 380, resizable: false, minimizable: false, maximizable: false,
    alwaysOnTop: true, frame: true, title: "Incoming Call",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false }
  });
  callWindow.loadFile("incomingcall.html");
  callWindow.on("closed", () => { callWindow = null; });
});

ipcMain.handle("close-call-window", () => {
  if (callWindow && !callWindow.isDestroyed()) callWindow.close();
});

ipcMain.handle("open-outgoing-call-window", (event) => {
  if (outgoingCallWindow && !outgoingCallWindow.isDestroyed()) { outgoingCallWindow.focus(); return; }
  outgoingCallWindow = new BrowserWindow({
    width: 320, height: 380, resizable: false, minimizable: false, maximizable: false,
    alwaysOnTop: true, frame: true, title: "Calling…",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false }
  });
  outgoingCallWindow.loadFile("outgoingcall.html");
  outgoingCallWindow.on("closed", () => { outgoingCallWindow = null; });
});

ipcMain.handle("close-outgoing-call-window", () => {
  if (outgoingCallWindow && !outgoingCallWindow.isDestroyed()) outgoingCallWindow.close();
});

ipcMain.handle("get-desktop-sources", async () => {
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true,
  });
  return sources.map(s => ({
    id: s.id, name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
    appIcon: s.appIcon ? s.appIcon.toDataURL() : null,
  }));
});

ipcMain.handle("set-app-icon", async (event, pngBuffer) => {
  try {
    const { nativeImage } = require("electron");
    const img = nativeImage.createFromBuffer(Buffer.from(pngBuffer));
    BrowserWindow.getAllWindows().forEach(w => { if (!w.isDestroyed()) w.setIcon(img); });
    return { success: true };
  } catch(e) {
    console.error("[set-app-icon]", e.message);
    return { error: e.message };
  }
});

// ── Voice Channel PiP native window ─────────────────────────
let vcPipWindow = null;

ipcMain.handle("vc-pip-open", (event, { channelName, width, height }) => {
  if (vcPipWindow && !vcPipWindow.isDestroyed()) {
    vcPipWindow.show();
    vcPipWindow.focus();
    return;
  }

  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const w = width  || 300;
  const h = height || 220;

  vcPipWindow = new BrowserWindow({
    width: w, height: h,
    x: sw - w - 24, y: sh - h - 24,
    minWidth: 220, minHeight: 160,
    maxWidth: 800, maxHeight: 700,
    frame: false, transparent: true, hasShadow: true,
    alwaysOnTop: true, resizable: true, movable: true,
    skipTaskbar: true,
    title: `🔊 ${channelName || "Voice"}`,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, nodeIntegration: false,
    }
  });

  vcPipWindow.loadFile("vcpip.html");

  // "screen-saver" level keeps the PiP above ALL windows including fullscreen apps
  vcPipWindow.setAlwaysOnTop(true, "screen-saver");
  vcPipWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Re-assert level every time any other window gains focus so it never goes behind
  const reassertOnTop = () => {
    if (vcPipWindow && !vcPipWindow.isDestroyed()) {
      vcPipWindow.setAlwaysOnTop(true, "screen-saver");
    }
  };
  app.on("browser-window-focus", reassertOnTop);

  vcPipWindow.on("closed", () => {
    // Clean up listener to prevent memory leak
    app.removeListener("browser-window-focus", reassertOnTop);
    vcPipWindow = null;
    const mainWin = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
    mainWin?.webContents.send("vc-pip-closed");
  });

  vcPipWindow.on("resize", () => {
    if (!vcPipWindow || vcPipWindow.isDestroyed()) return;
    const [w, h] = vcPipWindow.getSize();
    vcPipWindow.webContents.send("vc-pip-resized", { width: w, height: h });
  });
});

ipcMain.handle("vc-pip-close", () => {
  if (vcPipWindow && !vcPipWindow.isDestroyed()) vcPipWindow.close();
});

ipcMain.handle("vc-pip-update", (event, data) => {
  if (vcPipWindow && !vcPipWindow.isDestroyed()) {
    vcPipWindow.webContents.send("vc-pip-data", data);
  }
});

ipcMain.handle("vc-pip-start-drag", (event) => {
  if (vcPipWindow && !vcPipWindow.isDestroyed()) {
    vcPipWindow.webContents.startDrag({ file: "" });
  }
});

ipcMain.handle("vc-pip-action", (event, action) => {
  const mainWin = BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.webContents !== event.sender);
  if (mainWin) mainWin.webContents.send("vc-pip-action", action);
});

app.whenReady().then(() => {
  if (process.platform === "win32") app.setAppUserModelId("com.lobby.app");
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

console.log("Electron main process started");