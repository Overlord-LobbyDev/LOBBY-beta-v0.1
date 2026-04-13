// ============================================================
//  main.js  —  Electron main process
// ============================================================

const { app, BrowserWindow, ipcMain, desktopCapturer, session, shell, screen, Menu, dialog } = require("electron");
const path = require("path");

// Remove the native menu bar entirely
Menu.setApplicationMenu(null);

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    icon: path.join(__dirname, "icon.ico"),
    autoHideMenuBar: true,
    frame: false,
    resizable: true,
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

  // Auto-select seasonal splash (Dec-Feb=winter, Mar-May=spring, Jun-Aug=summer, Sep-Nov=autumn)
  const month = new Date().getMonth(); // 0=Jan
  const splashFile = month <= 1 || month === 11 ? "splash_winter.html"
    : month <= 4 ? "splash_spring.html"
    : month <= 7 ? "splash_summer.html"
    : "splash_autumn.html";
  const fs = require("fs");
  const splashPath = path.join(__dirname, splashFile);
  win.loadFile(fs.existsSync(splashPath) ? splashFile : "splash.html");
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

// ── Auto-Updater IPC ──────────────────────────────────────────
const https = require("https");
const http = require("http");
const fs = require("fs");
const os = require("os");
const { execFile } = require("child_process");

ipcMain.handle("get-app-version", () => {
  return app.getVersion();
});

// ── Check for updates via GitHub Releases API ─────────────────
ipcMain.handle("check-for-updates", async () => {
  const REPO = "Overlord-LobbyDev/LOBBY-beta-v0.1";
  const url  = `https://api.github.com/repos/${REPO}/releases/latest`;

  return new Promise((resolve) => {
    const doFetch = (fetchUrl) => {
      https.get(fetchUrl, {
        headers: {
          "User-Agent": "LOBBY-Updater/" + app.getVersion(),
          "Accept": "application/vnd.github.v3+json",
        }
      }, (res) => {
        // Follow redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          doFetch(res.headers.location);
          return;
        }
        if (res.statusCode === 404) {
          resolve({ error: "Release not found — check repo name or make sure a release exists." });
          return;
        }
        if (res.statusCode !== 200) {
          resolve({ error: `GitHub API error: HTTP ${res.statusCode}` });
          return;
        }
        let body = "";
        res.on("data", chunk => body += chunk);
        res.on("end", () => {
          try {
            const data = JSON.parse(body);
            resolve({
              tag:       data.tag_name,
              name:      data.name || data.tag_name,
              body:      data.body || "",
              url:       data.html_url,
              assets:    (data.assets || []).map(a => ({
                name:                 a.name,
                browser_download_url: a.browser_download_url,
                size:                 a.size,
              })),
              published: data.published_at,
            });
          } catch(e) {
            resolve({ error: "Failed to parse GitHub response: " + e.message });
          }
        });
      }).on("error", (e) => {
        resolve({ error: "Network error: " + e.message });
      });
    };
    doFetch(url);
  });
});



ipcMain.handle("download-update", async (event, downloadUrl, fileName) => {
  const tmpDir = os.tmpdir();
  const filePath = path.join(tmpDir, fileName);
  const sender = event.sender;

  return new Promise((resolve) => {
    const doDownload = (url) => {
      const proto = url.startsWith("https") ? https : http;
      proto.get(url, { headers: { "User-Agent": "LOBBY-Updater" } }, (response) => {
        // Handle redirects (GitHub uses them for asset downloads)
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          doDownload(response.headers.location);
          return;
        }

        if (response.statusCode !== 200) {
          resolve({ success: false, error: `HTTP ${response.statusCode}` });
          return;
        }

        const totalBytes = parseInt(response.headers["content-length"], 10) || 0;
        let downloaded = 0;
        const fileStream = fs.createWriteStream(filePath);

        response.on("data", (chunk) => {
          downloaded += chunk.length;
          if (totalBytes > 0) {
            const percent = (downloaded / totalBytes) * 100;
            try { sender.send("update-download-progress", { percent }); } catch(e) {}
          }
        });

        response.pipe(fileStream);

        fileStream.on("finish", () => {
          fileStream.close(() => {
            try {
              // Get the current install directory so the silent installer
              // reinstalls to the same location without prompting
              const installDir = path.dirname(path.dirname(app.getPath("exe")));

              // /S = silent mode (no UI, auto-uninstalls old version)
              // /D = install directory (must be last arg for NSIS)
              const args = ["/S", `/D=${installDir}`];

              const child = require("child_process").spawn(filePath, args, {
                detached: true,
                stdio: "ignore",
                windowsHide: false,
              });
              child.unref();

              // Give the installer a moment to start, then quit
              setTimeout(() => app.quit(), 2000);
              resolve({ success: true });
            } catch(e) {
              // Fallback: launch installer normally if silent mode fails
              shell.openPath(filePath).then(() => {
                setTimeout(() => app.quit(), 2000);
                resolve({ success: true });
              }).catch(err => {
                resolve({ success: false, error: err.message });
              });
            }
          });
        });

        fileStream.on("error", (err) => {
          resolve({ success: false, error: err.message });
        });
      }).on("error", (err) => {
        resolve({ success: false, error: err.message });
      });
    };

    doDownload(downloadUrl);
  });
});

// ── Custom window controls ────────────────────────────────────
ipcMain.handle("win-minimize", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});
ipcMain.handle("win-maximize", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.handle("win-close", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});
ipcMain.handle("set-titlebar-overlay", (event, { color, symbolColor }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.setTitleBarOverlay({ color, symbolColor, height: 72 });
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