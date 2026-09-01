// ============================================================
//  main.js  —  Electron main process
// ============================================================

const { app, BrowserWindow, ipcMain, desktopCapturer, session, shell, screen, Menu, globalShortcut } = require("electron");
const path = require("path");
const fs   = require("fs");   // moved here — was required at line 227 but used at line 79 (crash)

// ── Icon resolution ──────────────────────────────────────────
// macOS wants .icns (Info.plist) or .png (dock.setIcon), Windows wants .ico,
// Linux wants .png. The BrowserWindow `icon` option silently no-ops when the
// format doesn't match the platform — which is why Mac was showing the
// generic Electron icon even though icon.icns exists. Pick the right file
// per platform.
const ICON_PATH = (() => {
  if (process.platform === "darwin") return path.join(__dirname, "icon.icns");
  if (process.platform === "win32")  return path.join(__dirname, "icon.ico");
  return path.join(__dirname, "icon.png");
})();
const ICON_PNG_PATH = path.join(__dirname, "icon.png");

// On macOS, BrowserWindow.icon doesn't control the dock icon — that comes
// from the bundled .app's Info.plist when packaged, and from
// `app.dock.setIcon()` in dev. Set it as early as possible so the dock
// icon is correct when you run `electron .`.
if (process.platform === "darwin" && app.dock && fs.existsSync(ICON_PNG_PATH)) {
  app.whenReady().then(() => {
    try {
      const { nativeImage } = require("electron");
      const img = nativeImage.createFromPath(ICON_PNG_PATH);
      if (img && !img.isEmpty()) app.dock.setIcon(img);
    } catch (e) {
      console.warn("[dock icon]", e.message);
    }
  });
}

// On macOS, keep a minimal menu so that system-level keyboard shortcuts
// (Cmd+C, Cmd+V, Cmd+X, Cmd+A, Cmd+Z, Cmd+Shift+Z) continue to work.
// On Windows/Linux we remove the menu bar entirely (it's frameless).
if (process.platform === "darwin") {
  const macMenu = Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { role: "front" },
      ],
    },
  ]);
  Menu.setApplicationMenu(macMenu);
} else {
  Menu.setApplicationMenu(null);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    icon: ICON_PATH,
    autoHideMenuBar: true,
    frame: false,
    resizable: true,
    // The window's native background. Electron defaults this to WHITE, which
    // is what caused the random white flashes: this app is entirely dark, so
    // any frame where the compositor hasn't finished painting (a layer being
    // rebuilt, a raster stall, a loadFile navigation between pages) let the
    // white ground show through for a frame or two. Painting it --bg-0 means
    // there is no white anywhere in the stack to flash.
    backgroundColor: "#141820",
    // Don't show the window until it has something painted — kills the white
    // rectangle on launch before the first frame lands.
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  win.once("ready-to-show", () => win.show());

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ["media", "audioCapture", "videoCapture"];
    callback(allowed.includes(permission));
  });

  // ── YouTube embeds need a Referer ──────────────────────────────
  // The renderer is loaded with loadFile, so its origin is file:// and it
  // sends no Referer. YouTube's player refuses with "Error 153" when it
  // cannot tell who is embedding it. Referer is a forbidden header, so no
  // amount of renderer code can set it — only the main process can.
  //
  // Scoped to YouTube's own hosts so nothing else in the app is touched,
  // and it names the domain this app genuinely belongs to rather than
  // impersonating another site.
  const YT_HOSTS = /^https:\/\/([\w-]+\.)*(youtube\.com|youtube-nocookie\.com|ytimg\.com|googlevideo\.com)\//i;
  const APP_ORIGIN = "https://lobby-auth-server.onrender.com";
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ["https://*.youtube.com/*", "https://youtube.com/*",
             "https://*.youtube-nocookie.com/*",
             "https://*.ytimg.com/*", "https://*.googlevideo.com/*"] },
    (details, callback) => {
      if (YT_HOSTS.test(details.url)) {
        details.requestHeaders["Referer"] = APP_ORIGIN + "/";
        details.requestHeaders["Origin"]  = APP_ORIGIN;
      }
      callback({ requestHeaders: details.requestHeaders });
    }
  );

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (
      url.startsWith("https://steamcommunity.com") ||
      url.startsWith("https://lobby-auth-server.onrender.com/steam") ||
      url.startsWith("https://lobby-auth-server.onrender.com/chess") ||
      url.startsWith("https://lichess.org/oauth") ||
      url.startsWith("https://lichess.org/login")
    ) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 850, height: 650, autoHideMenuBar: true, title: "Link Account",
          webPreferences: { contextIsolation: true, nodeIntegration: false }
        }
      };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });

  ipcMain.handle("open-steam-window", (event, url) => {
    const isChess = url.includes("/chess/auth");
    const steamWin = new BrowserWindow({
      width: isChess ? 600 : 850, height: isChess ? 500 : 650,
      autoHideMenuBar: true,
      title: isChess ? "Link Chess Account" : "Sign in through Steam",
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    });
    steamWin.loadURL(url);
    steamWin.webContents.on("did-navigate", (e, navUrl) => {
      if (navUrl.startsWith("https://lobby-auth-server.onrender.com/steam/callback") ||
          navUrl.startsWith("https://lobby-auth-server.onrender.com/chess/callback/lichess") ||
          navUrl.includes("chess-linked")) {
        setTimeout(() => { try { if (steamWin && !steamWin.isDestroyed()) steamWin.close(); } catch(e) {} }, 3000);
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
  const splashPath = path.join(__dirname, splashFile);
  win.loadFile(fs.existsSync(splashPath) ? splashFile : "splash.html");
}

// Launch a Steam title on the user's own machine.
//
// Steam registers the steam:// protocol at install time, so handing
// the OS steam://rungameid/<id> starts the game -- or, if it is not
// installed, opens Steam on its install prompt. Either is the right
// answer to "play this"; neither can be distinguished from here, and
// the renderer is told as much rather than being given a fake
// success signal to display.
//
// THE RENDERER NEVER NAMES THE URL. It passes an app id, this checks
// it is a plain positive integer, and the steam:// string is built
// here. shell.openExternal will open file:// and every other
// registered protocol on the machine, so forwarding a
// renderer-supplied string would be an arbitrary-launch hole -- and
// this renderer displays other people's lobby names and post bodies.
ipcMain.handle("launch-steam-game", (event, appid) => {
  const id = String(appid == null ? "" : appid).trim();
  if (!/^[0-9]{1,10}$/.test(id)) return { ok: false, error: "bad appid" };
  try {
    shell.openExternal("steam://rungameid/" + id);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

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
    backgroundColor: "#141820",
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
    backgroundColor: "#141820",
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
    // 256x144 is more than the picker draws a tile at, and the capture
    // cost scales with this for every window that is open.
    thumbnailSize: { width: 512, height: 288 },
    // The icons were fetched and PNG-encoded for every window and then
    // never used by anything. That was pure cost.
    fetchWindowIcons: false,
  });
  return sources.map(s => {
    let thumbnail = null;
    try {
      // JPEG rather than PNG: a screenshot is a photograph, and PNG
      // encoding of a few dozen of them is what made this slow.
      thumbnail = s.thumbnail.isEmpty()
        ? null
        : "data:image/jpeg;base64," + s.thumbnail.toJPEG(82).toString("base64");
    } catch (e) { thumbnail = null; }
    return { id: s.id, name: s.name, thumbnail, appIcon: null };
  });
});

ipcMain.handle("set-app-icon", async (event, pngBuffer) => {
  try {
    const { nativeImage } = require("electron");
    const img = nativeImage.createFromBuffer(Buffer.from(pngBuffer));
    // BrowserWindow.setIcon controls the taskbar icon on Windows/Linux.
    // On macOS it's a no-op — the dock icon is controlled by app.dock.setIcon.
    if (process.platform === "darwin") {
      if (app.dock) app.dock.setIcon(img);
    } else {
      BrowserWindow.getAllWindows().forEach(w => { if (!w.isDestroyed()) w.setIcon(img); });
    }
    return { success: true };
  } catch(e) {
    console.error("[set-app-icon]", e.message);
    return { error: e.message };
  }
});

// ── Voice Channel PiP native window ─────────────────────────
let vcPipWindow = null;

// Where the picture-in-picture window was last left. Kept beside the
// app's own data rather than in the renderer, because the window
// outlives any one page.
const VC_PIP_STATE = path.join(app.getPath("userData"), "vcpip-bounds.json");

function readPipBounds() {
  try {
    const raw = JSON.parse(fs.readFileSync(VC_PIP_STATE, "utf8"));
    if (!raw || typeof raw.x !== "number") return null;
    // A monitor that has since been unplugged would put the window
    // somewhere nobody can see. Only restore onto a display that is
    // actually there, and only if a good part of it lands on screen.
    const fits = screen.getAllDisplays().some(d => {
      const b = d.workArea;
      return raw.x + raw.width  > b.x + 40 && raw.x < b.x + b.width  - 40 &&
             raw.y + raw.height > b.y + 40 && raw.y < b.y + b.height - 40;
    });
    return fits ? raw : null;
  } catch (e) { return null; }
}

let _pipSaveT = null;
function savePipBounds() {
  if (!vcPipWindow || vcPipWindow.isDestroyed()) return;
  // Debounced: a drag fires this many times a second.
  clearTimeout(_pipSaveT);
  _pipSaveT = setTimeout(() => {
    try {
      if (!vcPipWindow || vcPipWindow.isDestroyed()) return;
      fs.writeFileSync(VC_PIP_STATE, JSON.stringify(vcPipWindow.getBounds()));
    } catch (e) {}
  }, 400);
}

ipcMain.handle("vc-pip-open", (event, { channelName, width, height, from }) => {
  try {
  if (vcPipWindow && !vcPipWindow.isDestroyed()) {
    vcPipWindow.show();
    vcPipWindow.focus();
    return;
  }

  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const saved = readPipBounds();
  const w = (saved && saved.width)  || width  || 420;
  const h = (saved && saved.height) || height || 300;

  vcPipWindow = new BrowserWindow({
    width: w, height: h,
    x: saved ? saved.x : sw - w - 24,   // overridden below when flying
    y: saved ? saved.y : sh - h - 24,
    minWidth: 260, minHeight: 180,
    // Big enough to actually watch someone's screen on a second
    // monitor. The old 800x700 cap made that impossible.
    maxWidth: 3840, maxHeight: 2160,
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

  const relaySize = () => {
    if (!vcPipWindow || vcPipWindow.isDestroyed()) return;
    const [w, h] = vcPipWindow.getSize();
    vcPipWindow.webContents.send("vc-pip-resized", { width: w, height: h });
    // The main window needs this too: it is the one capturing frames,
    // and a 400px capture stretched across a 1400px window is the
    // blur. It can only send the right size if it knows the size.
    try {
      // Resolved here: mainWin is a local in other handlers, not a
      // module-level binding, so it does not exist in this scope.
      const target = BrowserWindow.getAllWindows()
        .find(x => !x.isDestroyed() && x !== vcPipWindow);
      target?.webContents.send("vc-pip-resized", { width: w, height: h });
    } catch (e) {}
    savePipBounds();
  };
  vcPipWindow.on("resize", relaySize);
  vcPipWindow.on("move", savePipBounds);
  vcPipWindow.once("ready-to-show", relaySize);

  // The flight out. Held at zero opacity until the first frame is
  // painted, or it flies as an empty box and lands as a picture.
  if (from && from.width > 40) {
    const rest = pipRestingBounds(w, h);
    try {
      vcPipWindow.setOpacity(0);
      vcPipWindow.setBounds(from);
    } catch (e) {}
    vcPipWindow.once("ready-to-show", () => {
      animatePip(from, rest, 280, 0, 1);
    });
  }
  } catch (err) {
    // A failure here used to be silent in both processes.
    console.error("[vc-pip-open]", err);
    vcPipWindow = null;
    return { error: String(err && err.message || err) };
  }
});

// The floating window is dragged by its own contents rather than by a
// drag region, so that hovering it still works. send/on rather than
// invoke/handle: this fires many times a second and none of them
// needs an answer.
ipcMain.on("vc-pip-move-by", (event, d) => {
  // A hand on the window wins over an animation.
  if (_pipAnim) { clearInterval(_pipAnim); _pipAnim = null; }
  if (!vcPipWindow || vcPipWindow.isDestroyed() || !d) return;
  const dx = Math.round(Number(d.dx) || 0);
  const dy = Math.round(Number(d.dy) || 0);
  if (!dx && !dy) return;
  const b = vcPipWindow.getBounds();
  vcPipWindow.setBounds({ x: b.x + dx, y: b.y + dy, width: b.width, height: b.height });
  savePipBounds();
});

// Ground truth, and the reason the renderer could not tell whether
// its request had worked: openVcPip answers nothing either way.
// Bounds and opacity, eased, on a frame timer. Electron has no
// animation of its own for either, and both have to move together
// or the window looks like it is fading rather than travelling.
let _pipAnim = null;
function animatePip(from, to, ms, opacityFrom, opacityTo, done) {
  if (!vcPipWindow || vcPipWindow.isDestroyed()) return;
  clearInterval(_pipAnim);
  const t0 = Date.now();
  const lerp = (a, b, k) => Math.round(a + (b - a) * k);
  _pipAnim = setInterval(() => {
    if (!vcPipWindow || vcPipWindow.isDestroyed()) { clearInterval(_pipAnim); return; }
    const raw = Math.min(1, (Date.now() - t0) / ms);
    // Out-cubic: quick off the mark, unhurried into place.
    const k = 1 - Math.pow(1 - raw, 3);
    try {
      vcPipWindow.setBounds({
        x: lerp(from.x, to.x, k), y: lerp(from.y, to.y, k),
        width: lerp(from.width, to.width, k),
        height: lerp(from.height, to.height, k),
      });
      vcPipWindow.setOpacity(opacityFrom + (opacityTo - opacityFrom) * k);
    } catch (e) {}
    if (raw >= 1) { clearInterval(_pipAnim); _pipAnim = null; if (done) done(); }
  }, 16);
}

// Where the window lives when it is not travelling: the last place it
// was left, or the bottom-right of the primary display.
function pipRestingBounds(w, h) {
  const saved = readPipBounds();
  if (saved) return { x: saved.x, y: saved.y, width: saved.width, height: saved.height };
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  return { x: sw - w - 24, y: sh - h - 24, width: w, height: h };
}

// Fly it back to where it came from, then close. The renderer sends
// the rectangle because only it knows where the share is on screen.
ipcMain.handle("vc-pip-close-to", (event, rect) => {
  if (!vcPipWindow || vcPipWindow.isDestroyed()) return;
  const win = vcPipWindow;
  const from = win.getBounds();
  if (!rect || !rect.width) { win.close(); return; }
  // Saved first: the flight home would otherwise overwrite the
  // position the user actually chose.
  try { fs.writeFileSync(VC_PIP_STATE, JSON.stringify(from)); } catch (e) {}
  animatePip(from, rect, 220, 1, 0, () => {
    if (win && !win.isDestroyed()) win.close();
  });
});

ipcMain.handle("vc-pip-exists", () => {
  const live = !!(vcPipWindow && !vcPipWindow.isDestroyed());
  return {
    exists: live,
    visible: live ? vcPipWindow.isVisible() : false,
    bounds: live ? vcPipWindow.getBounds() : null,
  };
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

  // F12 or Ctrl+Shift+I opens DevTools on the focused window
  globalShortcut.register("F12", () => {
    const win = BrowserWindow.getFocusedWindow();
    if (win) win.webContents.toggleDevTools();
  });
  globalShortcut.register("CommandOrControl+Shift+I", () => {
    const win = BrowserWindow.getFocusedWindow();
    if (win) win.webContents.toggleDevTools();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

console.log("Electron main process started");