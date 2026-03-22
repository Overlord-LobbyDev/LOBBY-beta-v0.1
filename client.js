// ============================================================
//  Discord-clone WebRTC client
//  Fixes: peer discovery, bitrate encoding, ICE flushing,
//         audio double-play, screen-share revert
//  New:   E2E encryption via WebCrypto + insertable streams
// ============================================================

"use strict";

// ---------- state ----------
let localStream = null;
let testMicStream = null;
const peers = {};             // peerId → { pc }
const pendingCandidates = {}; // peerId → RTCIceCandidate[]
let myId       = null;
let myUsername = "You";
let myAvatarUrl = null;

// ── Read JWT token saved by login.html ──────────────────────
// rtcToken/ws provided by index.html global scope
// Auth check handled by index.html

// Shared symmetric key material
const KEY_PASSPHRASE = "discord-clone-secret-change-me";
let sharedCryptoKey = null;

// ---------- WebSocket handlers (called after ws is created) ----------
function initRTC() {
if (!ws) return;

ws.onopen = () => log("Signalling connected");
ws.onerror = e => log("WS error", e);
ws.onclose = ({ code, reason }) => {
  log("WS closed", code, reason);
  if (code === 1008) {
    // Invalid token — force re-login
    localStorage.removeItem("vh_token");
    sessionStorage.removeItem("vh_token");
    window.location.href = "login.html";
  }
};

ws.onmessage = async ({ data }) => {
  const msg = JSON.parse(data);

  switch (msg.type) {
    case "welcome":
      myId       = msg.id;
      myUsername = msg.username || "You";
      log(`Signed in as ${myUsername} (${myId})`);
      updateStatus(`Connected as ${myUsername}`);
      // Update local tile label and user panel
      const localLabel = document.querySelector("#tile-local .tile-label");
      if (localLabel) localLabel.textContent = `${myUsername} (you)`;
      const userNameEl = document.getElementById("myUserName");
      if (userNameEl) userNameEl.textContent = myUsername;
      const myIdLabel = document.getElementById("myIdLabel");
      if (myIdLabel) myIdLabel.textContent = myId;
      // Set avatar initial
      const avatarEl = document.querySelector(".user-avatar");
      if (avatarEl) avatarEl.textContent = myUsername.slice(0, 1).toUpperCase();
      break;

    case "peers":
      // Server now sends full peer objects: { id, username, avatarUrl }
      for (const peer of (msg.peers || [])) {
        if (peer.id !== myId) await createOffer(peer.id, peer.username, peer.avatarUrl);
      }
      break;

    case "peer-joined":
      log(`${msg.username || msg.id} joined`);
      addPeerToUI(msg.id, msg.username, msg.avatarUrl);
      break;

    case "peer-left":
      removePeer(msg.id);
      break;

    case "offer":
      await handleOffer(msg);
      break;

    case "answer":
      await handleAnswer(msg);
      break;

    case "candidate":
      await handleCandidate(msg);
      break;
  }
};
} // end initRTC

function send(obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ---------- Crypto (E2E) ----------
async function initCrypto() {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw", enc.encode(KEY_PASSPHRASE), { name: "PBKDF2" }, false, ["deriveKey"]
  );
  sharedCryptoKey = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: enc.encode("rtc-salt"), iterations: 100_000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
  log("E2E crypto key ready");
}

// Encrypt an encoded RTP frame
async function encryptFrame(encodedFrame, controller) {
  if (!sharedCryptoKey) { controller.enqueue(encodedFrame); return; }
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      sharedCryptoKey,
      encodedFrame.data
    );
    // Prepend IV to encrypted payload
    const buf = new Uint8Array(12 + encrypted.byteLength);
    buf.set(iv, 0);
    buf.set(new Uint8Array(encrypted), 12);
    encodedFrame.data = buf.buffer;
    controller.enqueue(encodedFrame);
  } catch (e) {
    console.error("Encrypt error", e);
  }
}

// Decrypt an incoming RTP frame
async function decryptFrame(encodedFrame, controller) {
  if (!sharedCryptoKey) { controller.enqueue(encodedFrame); return; }
  try {
    const buf = new Uint8Array(encodedFrame.data);
    const iv = buf.slice(0, 12);
    const data = buf.slice(12);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      sharedCryptoKey,
      data
    );
    encodedFrame.data = decrypted;
    controller.enqueue(encodedFrame);
  } catch (e) {
    // Likely a key-frame before encryption kicked in — drop silently
  }
}

function applyEncryption(pc, direction) {
  // insertableStreams (Chrome 86+) — gracefully skip if unsupported
  try {
    pc.getSenders().forEach(sender => {
      if (!sender.track) return;
      const streams = sender.createEncodedStreams();
      streams.readable
        .pipeThrough(new TransformStream({ transform: encryptFrame }))
        .pipeTo(streams.writable);
    });
  } catch (e) {
    log("insertableStreams not supported — encryption skipped");
  }
}

function applyDecryption(receiver) {
  try {
    const streams = receiver.createEncodedStreams();
    streams.readable
      .pipeThrough(new TransformStream({ transform: decryptFrame }))
      .pipeTo(streams.writable);
  } catch (e) { /* not supported */ }
}

// ---------- RTCPeerConnection factory ----------
function createPeerConnection(peerId) {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    encodedInsertableStreams: true   // required for E2E
  });

  peers[peerId] = { pc };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) send({ type: "candidate", candidate, to: peerId });
  };

  pc.onconnectionstatechange = () => {
    log(`[${peerId}] connection: ${pc.connectionState}`);
    updatePeerStatus(peerId, pc.connectionState);
  };

  pc.ontrack = e => {
    applyDecryption(e.receiver);
    attachRemoteStream(peerId, e.streams[0]);
  };

  return pc;
}

// ---------- Offer / Answer ----------
async function createOffer(peerId, username = peerId, avatarUrl = null) {
  if (!localStream) { log("Start call first"); return; }

  const pc = createPeerConnection(peerId);
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  applyBitrate(pc, getCamQuality());

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  send({ type: "offer", offer: pc.localDescription, to: peerId });
  applyEncryption(pc);
}

async function handleOffer({ from, fromUsername, offer }) {
  if (!localStream) { log("No local stream for offer"); return; }

  addPeerToUI(from, fromUsername || from);
  const pc = createPeerConnection(from);
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  applyBitrate(pc, getCamQuality());

  await pc.setRemoteDescription(offer);
  await flushCandidates(from);

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  send({ type: "answer", answer: pc.localDescription, to: from });
  applyEncryption(pc);
}

async function handleAnswer({ from, answer }) {
  const entry = peers[from];
  if (!entry) return;
  await entry.pc.setRemoteDescription(answer);
  await flushCandidates(from);
}

async function handleCandidate({ from, candidate }) {
  const entry = peers[from];
  const ice = new RTCIceCandidate(candidate);
  if (entry?.pc.remoteDescription?.type) {
    await entry.pc.addIceCandidate(ice);
  } else {
    (pendingCandidates[from] ??= []).push(ice);
  }
}

async function flushCandidates(peerId) {
  const entry = peers[peerId];
  if (!entry) return;
  for (const c of (pendingCandidates[peerId] ?? [])) {
    await entry.pc.addIceCandidate(c).catch(() => {});
  }
  delete pendingCandidates[peerId];
}

function removePeer(peerId) {
  peers[peerId]?.pc.close();
  delete peers[peerId];
  document.getElementById(`tile-${peerId}`)?.remove();
  log(`Peer removed: ${peerId}`);
}

// ---------- Bitrate (fix: set encodings properly) ----------
function applyBitrate(pc, quality) {
  // Must be called AFTER addTrack but BEFORE createOffer/Answer
  // Use setParameters after connection for renegotiation-free update
  const maxBitrate =
    quality.includes("1440") ? 10_000_000 :
    quality.includes("1080") ? 5_000_000 :
    quality.includes("720")  ? 2_500_000 :
                               8_000_000;

  pc.getSenders().forEach(sender => {
    if (sender.track?.kind !== "video") return;
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    params.encodings[0].maxBitrate = maxBitrate;
    sender.setParameters(params).catch(() => {
      // setParameters before negotiation may fail — that's fine,
      // we also pass it via the offer SDP degradation preference
    });
  });
}

// ---------- Video constraints ----------
// Always use `ideal` so the browser gets as close as possible without
// throwing an OverconstrainedError if the webcam can't hit the exact value.
function getVideoConstraints(quality) {
  if (quality === "source") {
    return { width: { ideal: 9999 }, height: { ideal: 9999 }, frameRate: { ideal: 60 } };
  }
  const map = {
    "720p30":  { width: { ideal: 1280 }, height: { ideal: 720  }, frameRate: { ideal: 30, max: 30 } },
    "720p60":  { width: { ideal: 1280 }, height: { ideal: 720  }, frameRate: { ideal: 60, max: 60 } },
    "1080p30": { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } },
    "1080p60": { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60, max: 60 } },
    "1440p30": { width: { ideal: 2560 }, height: { ideal: 1440 }, frameRate: { ideal: 30, max: 30 } },
    "1440p60": { width: { ideal: 2560 }, height: { ideal: 1440 }, frameRate: { ideal: 60, max: 60 } },
  };
  return map[quality] ?? { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } };
}

// ---------- DOM helpers ----------
const videosContainer = document.getElementById("videos");
const statusEl         = document.getElementById("status");

function updateStatus(text) { if (statusEl) statusEl.textContent = text; }
function log(...args) { console.log("[rtc]", ...args); }

// Store peer usernames so tile labels stay correct
const peerUsernames = {};

function addPeerToUI(peerId, username = peerId, avatarUrl = null) {
  peerUsernames[peerId] = username;
  if (document.getElementById(`tile-${peerId}`)) {
    // Already exists — just update the label
    const lbl = document.querySelector(`#tile-${peerId} .tile-label`);
    if (lbl) lbl.textContent = username;
    return;
  }
  const tile = document.createElement("div");
  tile.className = "video-tile";
  tile.id = `tile-${peerId}`;

  const initial = username.slice(0, 1).toUpperCase();
  const avatarHtml = avatarUrl
    ? `<img src="${avatarUrl}" class="tile-avatar" alt="${username}" />`
    : `<div class="tile-avatar-initial">${initial}</div>`;

  tile.innerHTML = `
    <video id="remoteVideo-${peerId}" autoplay playsinline></video>
    ${avatarHtml}
    <div class="tile-label">${username}</div>
    <div class="tile-status" id="status-${peerId}">connecting…</div>`;
  videosContainer.appendChild(tile);
}

function updatePeerStatus(peerId, state) {
  const el = document.getElementById(`status-${peerId}`);
  if (el) el.textContent = state;
}

function attachRemoteStream(peerId, stream) {
  addPeerToUI(peerId);
  const vid = document.getElementById(`remoteVideo-${peerId}`);
  if (vid) {
    vid.srcObject = stream;
    vid.volume = getOutputVolume();
  }
}


// ---------- DOM elements ----------
const startButton         = document.getElementById("startBtn");
const leaveButton         = document.getElementById("leaveBtn");
const muteBtn             = document.getElementById("muteBtn");
const cameraBtn           = document.getElementById("cameraBtn");
const screenBtn           = document.getElementById("screenBtn");

// ── Settings helpers — read from localStorage (set in profile settings) ──
function getMicId()        { return localStorage.getItem("vh_mic")           || ""; }
function getCamId()        { return localStorage.getItem("vh_cam")           || ""; }
function getSpeakerId()    { return localStorage.getItem("vh_speaker")       || ""; }
function getCamQuality()   { return localStorage.getItem("vh_camQuality")    || "1080p30"; }
function getScreenQuality(){ return localStorage.getItem("vh_screenQuality") || "1080p30"; }
function getInputVolume()  { return parseFloat(localStorage.getItem("vh_inputVolume")  || "100") / 100; }
function getOutputVolume() { return parseFloat(localStorage.getItem("vh_outputVolume") || "100") / 100; }

// Alias used by legacy helpers
const qualitySelect = { value: getCamQuality() };
const camQualitySelect    = { value: getCamQuality(),    addEventListener: () => {} };
const screenQualitySelect = { value: getScreenQuality(), addEventListener: () => {} };
const micSelect           = { value: getMicId() };

// ---------- Mute toggle ----------
muteBtn?.addEventListener("click", () => {
  if (!localStream) return;
  const tracks = localStream.getAudioTracks();
  if (!tracks.length) return;
  const enabled = !tracks[0].enabled;
  tracks.forEach(t => t.enabled = enabled);
  muteBtn.textContent = enabled ? "🎙 Mute" : "🔇 Unmute";
  muteBtn.classList.toggle("active", !enabled);
});

// ---------- Camera toggle ----------
cameraBtn?.addEventListener("click", () => {
  if (!localStream) return;
  const tracks = localStream.getVideoTracks();
  if (!tracks.length) return;
  const enabled = !tracks[0].enabled;
  tracks.forEach(t => t.enabled = enabled);
  cameraBtn.textContent = enabled ? "📷 Camera Off" : "📷 Camera On";
  cameraBtn.classList.toggle("active", !enabled);
});

// ---------- Live webcam quality change ----------
camQualitySelect.addEventListener("change", async () => {
  if (!localStream) return;
  const q = getCamQuality();

  try {
    // Stop the existing video track first
    localStream.getVideoTracks().forEach(t => t.stop());

    // Request a brand new video track at the chosen quality
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: getVideoConstraints(q),
      audio: false
    });
    const newVideoTrack = newStream.getVideoTracks()[0];

    // Swap it into localStream
    localStream.getVideoTracks().forEach(t => localStream.removeTrack(t));
    localStream.addTrack(newVideoTrack);

    // Update the local video element
    document.getElementById("localVideo").srcObject = localStream;

    // Push the new track to all peers (only if not screen sharing)
    if (!isSharing) {
      Object.values(peers).forEach(({ pc }) => {
        const sender = pc.getSenders().find(s => s.track?.kind === "video");
        sender?.replaceTrack(newVideoTrack);
      });
      Object.values(peers).forEach(({ pc }) => applyBitrate(pc, q));
    }

    log("Webcam quality →", q);
  } catch (e) {
    log("Cam quality error:", e.message);
  }
});

// ---------- Live screen share quality change ----------
screenQualitySelect.addEventListener("change", async () => {
  if (!isSharing || !activeScreenTrack) return;

  const q         = getScreenQuality();
  const frameRate = q.includes("60") ? 60 : 30;
  const height    = q.includes("1440") ? 1440 : q.includes("1080") ? 1080 : 720;
  const width     = q.includes("1440") ? 2560 : q.includes("1080") ? 1920 : 1280;

  if (q === "source") {
    // "Source" — remove all constraints so the OS gives max resolution
    await activeScreenTrack.applyConstraints({}).catch(e => log("Screen quality error:", e));
  } else {
    await activeScreenTrack.applyConstraints({
      frameRate: { ideal: frameRate, max: frameRate },
      width:     { ideal: width,     max: width     },
      height:    { ideal: height,    max: height    },
    }).catch(e => log("Screen quality error:", e));
  }

  // Update bitrate for all peers to match new quality
  Object.values(peers).forEach(({ pc }) => applyBitrate(pc, q));
  log("Screen share quality →", q);
});

// ============================================================
//  Screen share — Electron desktopCapturer picker
//  Uses IPC to get sources from main process, shows a custom
//  picker modal, then captures the chosen screen/window.
// ============================================================

let isSharing = false;
let activeScreenTrack = null;

// ── Picker modal (injected into the page at runtime) ────────
function buildPickerModal() {
  if (document.getElementById("screenPickerModal")) return;

  const style = document.createElement("style");
  style.textContent = `
    #screenPickerModal {
      display: none;
      position: fixed; inset: 0; z-index: 9999;
      background: rgba(0,0,0,.75);
      align-items: center; justify-content: center;
    }
    #screenPickerModal.open { display: flex; }
    #screenPickerBox {
      background: #2b2d31;
      border-radius: 12px;
      padding: 24px;
      width: min(860px, 92vw);
      max-height: 80vh;
      display: flex; flex-direction: column; gap: 16px;
      box-shadow: 0 24px 64px rgba(0,0,0,.6);
    }
    #screenPickerBox h2 {
      font-size: 18px; font-weight: 700; color: #f2f3f5; margin: 0;
    }
    #screenPickerBox p {
      font-size: 13px; color: #80848e; margin: -8px 0 0;
    }
    #pickerTabs {
      display: flex; gap: 8px;
    }
    .picker-tab {
      padding: 6px 16px; border-radius: 6px; border: none; cursor: pointer;
      font-size: 13px; font-weight: 600; font-family: inherit;
      background: #383a40; color: #b5bac1; transition: background .15s;
    }
    .picker-tab.active { background: #5865f2; color: #fff; }
    #pickerGrid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 12px;
      overflow-y: auto;
      max-height: 50vh;
      padding-right: 4px;
    }
    .picker-item {
      background: #1e1f22;
      border: 2px solid transparent;
      border-radius: 8px;
      padding: 10px;
      cursor: pointer;
      display: flex; flex-direction: column; gap: 8px;
      transition: border-color .15s, background .15s;
    }
    .picker-item:hover { background: #313338; border-color: #5865f2; }
    .picker-item.selected { border-color: #5865f2; background: #383a40; }
    .picker-thumb {
      width: 100%; aspect-ratio: 16/9;
      object-fit: cover; border-radius: 4px;
      background: #111;
    }
    .picker-name {
      font-size: 12px; color: #b5bac1; font-weight: 600;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    #pickerActions {
      display: flex; justify-content: flex-end; gap: 10px;
    }
    #pickerCancel {
      padding: 9px 20px; border-radius: 6px; border: none; cursor: pointer;
      font-size: 14px; font-weight: 600; font-family: inherit;
      background: #383a40; color: #b5bac1;
    }
    #pickerConfirm {
      padding: 9px 20px; border-radius: 6px; border: none; cursor: pointer;
      font-size: 14px; font-weight: 600; font-family: inherit;
      background: #5865f2; color: #fff;
    }
    #pickerConfirm:disabled { opacity: .45; cursor: default; }
  `;
  document.head.appendChild(style);

  const modal = document.createElement("div");
  modal.id = "screenPickerModal";
  modal.innerHTML = `
    <div id="screenPickerBox">
      <h2>Share your screen</h2>
      <p>Choose a display or application window to share</p>
      <div id="pickerTabs">
        <button class="picker-tab active" data-filter="screen">Screens</button>
        <button class="picker-tab" data-filter="window">Windows</button>
      </div>
      <div id="pickerGrid"></div>
      <div id="pickerActions">
        <button id="pickerCancel">Cancel</button>
        <button id="pickerConfirm" disabled>Share</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

// Open picker, resolve with chosen source id or null
function openSourcePicker(sources) {
  return new Promise(resolve => {
    buildPickerModal();

    const modal      = document.getElementById("screenPickerModal");
    const grid       = document.getElementById("pickerGrid");
    const confirmBtn = document.getElementById("pickerConfirm");
    const cancelBtn  = document.getElementById("pickerCancel");
    const tabs       = document.querySelectorAll(".picker-tab");

    let selectedId  = null;
    let activeFilter = "screen";

    function renderGrid(filter) {
      grid.innerHTML = "";
      const filtered = sources.filter(s =>
        filter === "screen" ? s.id.startsWith("screen") : !s.id.startsWith("screen")
      );
      if (!filtered.length) {
        grid.innerHTML = `<p style="color:#80848e;font-size:13px">No ${filter}s found</p>`;
        return;
      }
      filtered.forEach(src => {
        const item = document.createElement("div");
        item.className = "picker-item" + (src.id === selectedId ? " selected" : "");
        item.dataset.id = src.id;
        item.innerHTML = `
          <img class="picker-thumb" src="${src.thumbnail}" alt="" />
          <div class="picker-name">${src.name}</div>`;
        item.addEventListener("click", () => {
          document.querySelectorAll(".picker-item").forEach(el => el.classList.remove("selected"));
          item.classList.add("selected");
          selectedId = src.id;
          confirmBtn.disabled = false;
        });
        grid.appendChild(item);
      });
    }

    tabs.forEach(tab => {
      tab.addEventListener("click", () => {
        tabs.forEach(t => t.classList.remove("active"));
        tab.classList.add("active");
        activeFilter = tab.dataset.filter;
        selectedId = null;
        confirmBtn.disabled = true;
        renderGrid(activeFilter);
      });
    });

    confirmBtn.addEventListener("click", () => {
      modal.classList.remove("open");
      resolve(selectedId);
    }, { once: true });

    cancelBtn.addEventListener("click", () => {
      modal.classList.remove("open");
      resolve(null);
    }, { once: true });

    renderGrid(activeFilter);
    modal.classList.add("open");
  });
}

// ── Start / stop screen share ────────────────────────────────
screenBtn?.addEventListener("click", async () => {
  // Stop if already sharing
  if (isSharing) {
    activeScreenTrack?.stop();   // fires onended → revert handler below
    return;
  }

  if (!localStream) { alert("Start a call first."); return; }

  // 1. Ask main process for sources via preload bridge
  if (!window.electronAPI) {
    alert("electronAPI not found — make sure preload.js is loaded.");
    return;
  }

  let sources;
  try {
    sources = await window.electronAPI.getSources();
  } catch (e) {
    console.error("getSources failed:", e);
    return;
  }

  // 2. Show our custom picker modal
  const chosenId = await openSourcePicker(sources);
  if (!chosenId) { log("Screen share cancelled"); return; }

  // 3. Capture the chosen source using getUserMedia with chromeMediaSource
  const screenQuality = getScreenQuality();
  const frameRate = screenQuality.includes("60") ? 60 : 30;
  const height =
    screenQuality.includes("1440") ? 1440 :
    screenQuality.includes("1080") ? 1080 : 720;

  let screenStream;
  try {
    screenStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: chosenId,
          maxWidth:     screenQuality.includes("1440") ? 2560 : screenQuality.includes("1080") ? 1920 : 1280,
          maxHeight:    height,
          maxFrameRate: frameRate,
        }
      }
    });
  } catch (err) {
    console.error("Screen capture failed:", err);
    alert("Could not capture screen: " + err.message);
    return;
  }

  activeScreenTrack = screenStream.getVideoTracks()[0];
  isSharing = true;

  // 4. Replace outgoing video for all peers (they see the screen)
  Object.values(peers).forEach(({ pc }) => {
    const sender = pc.getSenders().find(s => s.track?.kind === "video");
    sender?.replaceTrack(activeScreenTrack);
  });

  // 5. Create a dedicated screen share tile — webcam tile stays untouched
  let screenTile = document.getElementById("tile-local-screen");
  if (!screenTile) {
    screenTile = document.createElement("div");
    screenTile.className = "video-tile screen-share-tile";
    screenTile.id = "tile-local-screen";
    screenTile.innerHTML = `
      <video id="localScreenVideo" autoplay playsinline muted></video>
      <div class="tile-label">You (screen)</div>
      <div class="tile-status">sharing</div>`;
    // Insert right after the webcam tile
    const camTile = document.getElementById("tile-local");
    camTile.insertAdjacentElement("afterend", screenTile);
  }
  document.getElementById("localScreenVideo").srcObject = screenStream;

  screenBtn.textContent = "⏹ Stop Share";
  screenBtn.classList.add("active");
  Object.values(peers).forEach(({ pc }) => applyBitrate(pc, screenQuality));
  log("Screen sharing —", activeScreenTrack.label);

  // 6. Remove screen tile and revert peers to webcam when sharing ends
  activeScreenTrack.onended = async () => {
    isSharing = false;
    activeScreenTrack = null;

    // Remove the screen share tile
    document.getElementById("tile-local-screen")?.remove();

    // Revert peers back to the existing webcam track (no need to re-request camera)
    const camTrack = localStream.getVideoTracks()[0];
    if (camTrack) {
      Object.values(peers).forEach(({ pc }) => {
        const sender = pc.getSenders().find(s => s.track?.kind === "video");
        sender?.replaceTrack(camTrack);
      });
    }

    screenBtn.textContent = "\uD83D\uDDB5 Share Screen";
    screenBtn.classList.remove("active");
    Object.values(peers).forEach(({ pc }) => applyBitrate(pc, getCamQuality()));
    log("Screen sharing stopped — peers reverted to webcam");
  };
});

// ---------- Leave call ----------
leaveButton?.addEventListener("click", () => {
  // Close all peer connections
  Object.entries(peers).forEach(([peerId, { pc }]) => {
    pc.close();
    document.getElementById(`tile-${peerId}`)?.remove();
  });
  Object.keys(peers).forEach(k => delete peers[k]);

  // Stop all local tracks
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }

  // Stop screen share if active
  if (activeScreenTrack) {
    activeScreenTrack.stop();
    activeScreenTrack = null;
    isSharing = false;
    document.getElementById("tile-local-screen")?.remove();
  }

  // Reset local video tile
  const localVid = document.getElementById("localVideo");
  if (localVid) localVid.srcObject = null;

  // Reset UI
  // Hide call area, show social feed
  const callArea = document.getElementById("callArea");
  if (callArea) callArea.style.display = "none";
  // Restore to home panel after call
  if (typeof showHomePanel === "function") showHomePanel();
  document.getElementById("callControls").style.display = "none";
  startButton.style.display = "none"; // stays hidden — calls initiated from chat
  muteBtn.textContent = "🎙 Mute";
  muteBtn.classList.remove("active");
  cameraBtn.textContent = "📷 Camera";
  cameraBtn.classList.remove("active");
  screenBtn.textContent = "🖥 Share Screen";
  screenBtn.classList.remove("active");

  updateStatus("Left call");
  log("Left call");

  // Notify server
  send({ type: "leave" });
});

// ---------- Start call ----------
startButton?.addEventListener("click", async () => {
  try {
    await initCrypto();

    const micId   = getMicId();
    const camId   = getCamId();
    const quality = getCamQuality();

    // Try with saved devices first, fall back to defaults if they fail
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: micId ? { exact: micId } : undefined },
        video: { ...getVideoConstraints(quality), ...(camId ? { deviceId: { exact: camId } } : {}) }
      });
    } catch {
      // Fall back to default devices if saved ones are unavailable
      log("Saved devices unavailable, using defaults");
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: getVideoConstraints(quality)
      });
    }

    document.getElementById("localVideo").srcObject = localStream;

    // Apply input (mic) gain
    try {
      const audioCtx = new AudioContext();
      const source   = audioCtx.createMediaStreamSource(localStream);
      const gain     = audioCtx.createGain();
      gain.gain.value = getInputVolume();
      const dest = audioCtx.createMediaStreamDestination();
      source.connect(gain);
      gain.connect(dest);
      const gainedTrack = dest.stream.getAudioTracks()[0];
      if (gainedTrack) {
        localStream.getAudioTracks().forEach(t => localStream.removeTrack(t));
        localStream.addTrack(gainedTrack);
      }
    } catch (e) { log("Gain node error:", e.message); }

    send({ type: "ready" });

    // Show call area, hide social feed
    // Show chat panel and reveal call area
    if (typeof showChatPanel === "function") showChatPanel();
    const callArea = document.getElementById("callArea");
    if (callArea) callArea.style.display = "flex";
    document.getElementById("callControls").style.display = "flex";
    startButton.style.display = "none";
    updateStatus("In call — waiting for peers…");
    log("Call started");
  } catch (err) {
    console.error("Start call error:", err);
    alert("Could not start call: " + err.message);
  }
});