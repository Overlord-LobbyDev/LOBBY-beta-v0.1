require("dotenv").config();
// ============================================================
//  server.js  —  Express HTTP + WebSocket signalling server
//  Works on desktop (electron) AND cloud (Render)
// ============================================================

const express = require("express");
const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");
const { randomUUID } = require("crypto");
const jwt = require("jsonwebtoken");
const url = require("url");

const app = express();
const server = http.createServer(app);

// ── Port (Render assigns PORT env var dynamically) ──
const PORT = process.env.PORT || 3000;

// ── Health check endpoint ──────────────────────────────
app.get("/", (req, res) => {
  res.status(200).json({ message: "WebSocket server is running" });
});

// ── WebSocket server ──────────────────────────────────
const wss = new WebSocketServer({ server });

const SECRET = process.env.JWT_SECRET || "change-this-secret-in-production";

// id → { ws, username, avatarUrl, channels: Set, userId, vcChannelId, vcServerId }
const clients = new Map();

function broadcast(senderId, msg) {
  const json = JSON.stringify(msg);
  for (const [id, client] of clients) {
    if (id !== senderId && client.ws.readyState === 1) client.ws.send(json);
  }
}

function broadcastOnlineStatus() {
  const onlineUsers = [...clients.values()]
    .filter(c => c.presenceStatus !== "invisible")
    .map(c => ({
      id: c.peerId, userId: c.userId, username: c.username, avatarUrl: c.avatarUrl,
      presenceStatus: c.presenceStatus || "online"
    }));
  const json = JSON.stringify({ type: "online-users", users: onlineUsers });
  for (const client of clients.values()) {
    if (client.ws.readyState === 1) client.ws.send(json);
  }
}

wss.on("connection", (ws, req) => {
  const { query } = url.parse(req.url, true);
  let user = { peerId: randomUUID().slice(0, 8), userId: null, username: "Anonymous", avatarUrl: null };

  if (query.token) {
    try {
      const payload = jwt.verify(query.token, SECRET);
      user.peerId = `u${payload.id}`;
      user.userId = payload.id;
      user.username = payload.username;
    } catch {
      ws.close(1008, "Invalid token");
      return;
    }
  }

  if (clients.has(user.peerId)) {
    clients.get(user.peerId).ws.close(1000, "Replaced");
  }

  clients.set(user.peerId, {
    ws,
    ...user,
    subscribedChannels: new Set(),
    vcChannelId: null,   // voice channel this client is currently in
    vcServerId: null,    // server the voice channel belongs to
    groupCallId: null,   // group call this client is currently in
    presenceStatus: "online"
  });
  console.log(`[+] ${user.username} connected — total: ${clients.size}`);

  // Welcome + peer list
  ws.send(JSON.stringify({ type: "welcome", id: user.peerId, username: user.username }));
  const peerList = [...clients.entries()]
    .filter(([id]) => id !== user.peerId)
    .map(([id, c]) => ({ id, username: c.username, avatarUrl: c.avatarUrl }));
  ws.send(JSON.stringify({ type: "peers", peers: peerList }));

  broadcast(user.peerId, { type: "peer-joined", id: user.peerId, username: user.username, avatarUrl: user.avatarUrl });
  broadcastOnlineStatus();

  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── WebRTC signalling (1-1, group, and voice channel) ─
    // vc-offer / vc-answer / vc-candidate all have a `to` field —
    // they're handled here automatically, same as 1-1 call signalling.
    if (msg.to) {
      const target = clients.get(msg.to);
      if (target?.ws.readyState === 1) {
        target.ws.send(JSON.stringify({ ...msg, from: user.peerId, fromUsername: user.username }));
      }
      return;
    }

    // ── Chat: subscribe to channel ───────────────────────
    if (msg.type === "subscribe-channel") {
      clients.get(user.peerId).subscribedChannels.add(msg.channelId);
      return;
    }

    if (msg.type === "unsubscribe-channel") {
      clients.get(user.peerId).subscribedChannels.delete(msg.channelId);
      return;
    }

    // ── Chat: new channel message ────────────────────────
    if (msg.type === "channel-message") {
      for (const [id, client] of clients) {
        if (client.subscribedChannels.has(msg.channelId) && client.ws.readyState === 1) {
          client.ws.send(JSON.stringify({
            type: "channel-message",
            channelId: msg.channelId,
            message: msg.message
          }));
        }
      }
      return;
    }

    // ── Chat: direct message ─────────────────────────────
    if (msg.type === "direct-message") {
      const targetPeerId = `u${msg.toUserId}`;
      const target = clients.get(targetPeerId);
      const enrichedMessage = {
        ...msg.message,
        from_user_id: user.userId,
        username: user.username
      };
      if (target?.ws.readyState === 1) {
        target.ws.send(JSON.stringify({
          type: "direct-message",
          message: enrichedMessage,
          from: user.peerId,
          fromUsername: user.username
        }));
      }
      return;
    }

    // ── Friend request notification ──────────────────────
    if (msg.type === "friend-request") {
      const target = clients.get(`u${msg.toUserId}`);
      if (target?.ws.readyState === 1) {
        target.ws.send(JSON.stringify({
          type: "friend-request",
          fromUsername: user.username,
          fromAvatarUrl: user.avatarUrl || null,
          fromId: user.userId,
          friendId: msg.friendId || null
        }));
      }
      return;
    }

    // ── Friend request accepted notification ─────────────
    if (msg.type === "friend-accepted") {
      const target = clients.get(`u${msg.toUserId}`);
      if (target?.ws.readyState === 1) {
        target.ws.send(JSON.stringify({
          type: "friend-accepted",
          fromUsername: user.username,
          fromAvatarUrl: user.avatarUrl || null
        }));
      }
      return;
    }

    // ── Group invite notification ─────────────────────────
    if (msg.type === "group-invite") {
      const target = clients.get(`u${msg.toUserId}`);
      if (target?.ws.readyState === 1) {
        target.ws.send(JSON.stringify({
          type: "group-invite",
          fromUsername: user.username,
          groupName: msg.groupName,
          groupId: msg.groupId
        }));
      }
      return;
    }

    // ── Server invite notification ────────────────────────
    if (msg.type === "server-invite") {
      const target = clients.get(`u${msg.toUserId}`);
      if (target?.ws.readyState === 1) {
        target.ws.send(JSON.stringify({
          type: "server-invite",
          fromUsername: user.username,
          fromAvatarUrl: user.avatarUrl || msg.fromAvatarUrl || null,
          serverName: msg.serverName,
          serverId: msg.serverId
        }));
      }
      return;
    }

    // ── Mention notification ──────────────────────────────
    if (msg.type === "mention") {
      const target = clients.get(`u${msg.toUserId}`);
      if (target?.ws.readyState === 1) {
        target.ws.send(JSON.stringify({
          type: "mention",
          fromUsername: user.username,
          fromAvatarUrl: user.avatarUrl || null,
          context: msg.context,
          postId: msg.postId
        }));
      }
      return;
    }

    // ── New post broadcast ───────────────────────────────
    if (msg.type === "new-post") {
      broadcast(user.peerId, { type: "new-post", post: msg.post });
      return;
    }

    // ── 1-1 call signalling ──────────────────────────────
    if (["call-invite","call-accept","call-decline","call-offer","call-answer","call-candidate","call-end"].includes(msg.type)) {
      const target = clients.get(msg.to);
      if (target?.ws.readyState === 1) {
        target.ws.send(JSON.stringify({ ...msg, from: user.peerId, fromUsername: user.username }));
      }
      return;
    }

    // ── Leave call ───────────────────────────────────────
    if (msg.type === "leave") {
      broadcast(user.peerId, { type: "peer-left", id: user.peerId });
      return;
    }

    // ── Group call: join/leave ────────────────────────────
    if (msg.type === "group-call-join") {
      const groupChannelId = `group-${msg.groupId}`;
      const client = clients.get(user.peerId);
      if (client) client.groupCallId = msg.groupId;

      // Send the joiner the list of peers already in the call
      const existingPeers = [...clients.values()]
        .filter(c => c.groupCallId === msg.groupId && c.peerId !== user.peerId)
        .map(c => ({ peerId: c.peerId, userId: c.userId, username: c.username, avatarUrl: c.avatarUrl || null }));
      ws.send(JSON.stringify({ type: "group-call-peers", groupId: msg.groupId, peers: existingPeers }));

      // Notify only group members (subscribed to this group channel)
      for (const [id, c] of clients) {
        if (id !== user.peerId && c.subscribedChannels.has(groupChannelId) && c.ws.readyState === 1) {
          c.ws.send(JSON.stringify({
            type: "group-call-join",
            groupId: msg.groupId,
            peerId: user.peerId,
            userId: user.userId,
            username: user.username,
            avatarUrl: user.avatarUrl || null
          }));
        }
      }
      return;
    }

    if (msg.type === "group-call-leave") {
      const client = clients.get(user.peerId);
      if (client) client.groupCallId = null;

      const groupChannelId = `group-${msg.groupId}`;
      for (const [id, c] of clients) {
        if (id !== user.peerId && c.subscribedChannels.has(groupChannelId) && c.ws.readyState === 1) {
          c.ws.send(JSON.stringify({
            type: "group-call-leave",
            groupId: msg.groupId,
            peerId: user.peerId,
            userId: user.userId
          }));
        }
      }
      return;
    }

    // ── Group call: WebRTC signalling ──────────────────────
    if (["group-offer","group-answer","group-candidate"].includes(msg.type)) {
      const target = clients.get(msg.to);
      if (target?.ws.readyState === 1) {
        target.ws.send(JSON.stringify({ ...msg, from: user.peerId }));
      }
      return;
    }

    // ── Group chat message ───────────────────────────────
    if (msg.type === "group-message") {
      for (const [id, client] of clients) {
        if (client.subscribedChannels.has(`group-${msg.groupId}`) && client.ws.readyState === 1) {
          client.ws.send(JSON.stringify({
            type: "group-message",
            groupId: msg.groupId,
            message: msg.message
          }));
        }
      }
      return;
    }

    // ── Presence status update ───────────────────────────
    if (msg.type === "presence-update") {
      const client = clients.get(user.peerId);
      if (client) client.presenceStatus = msg.status || "online";
      broadcastOnlineStatus();
      return;
    }

    // ── Typing indicator ─────────────────────────────────
    if (msg.type === "typing") {
      if (msg.channelId) {
        for (const [id, client] of clients) {
          if (id !== user.peerId && client.subscribedChannels.has(msg.channelId) && client.ws.readyState === 1) {
            client.ws.send(JSON.stringify({ type: "typing", channelId: msg.channelId, username: user.username }));
          }
        }
      } else if (msg.toUserId) {
        const target = clients.get(`u${msg.toUserId}`);
        if (target?.ws.readyState === 1) {
          target.ws.send(JSON.stringify({ type: "typing", fromUsername: user.username, isDm: true }));
        }
      }
      return;
    }

    // ── Voice channel: join ───────────────────────────────
    if (msg.type === "vc-join") {
      const client = clients.get(user.peerId);
      if (client) {
        client.vcChannelId = msg.channelId;
        client.vcServerId = msg.serverId;
        client.vcUsername = msg.username || user.username;
        client.vcAvatarUrl = msg.avatarUrl || null;
      }

      // Send the joiner the current member list for this channel
      const currentMembers = [...clients.values()]
        .filter(c => c.vcChannelId === msg.channelId && c.peerId !== user.peerId)
        .map(c => ({ userId: c.userId, username: c.vcUsername || c.username, avatarUrl: c.vcAvatarUrl || null, muted: false }));
      ws.send(JSON.stringify({ type: "vc-members", channelId: msg.channelId, members: currentMembers }));

      // Notify everyone else in the same channel that we joined
      for (const [id, c] of clients) {
        if (id !== user.peerId && c.vcChannelId === msg.channelId && c.ws.readyState === 1) {
          c.ws.send(JSON.stringify({
            type: "vc-joined",
            channelId: msg.channelId,
            userId: user.userId,
            username: msg.username || user.username,
            avatarUrl: msg.avatarUrl || null
          }));
        }
      }
      return;
    }

    // ── Voice channel: mute state broadcast ──────────────
    if (msg.type === "vc-mute") {
      for (const [id, c] of clients) {
        if (id !== user.peerId && c.vcChannelId === msg.channelId && c.ws.readyState === 1) {
          c.ws.send(JSON.stringify({
            type: "vc-mute",
            channelId: msg.channelId,
            userId: user.userId,
            muted: msg.muted
          }));
        }
      }
      return;
    }

    // ── Voice channel: leave ──────────────────────────────
    if (msg.type === "vc-leave") {
      const client = clients.get(user.peerId);
      const channelId = msg.channelId || client?.vcChannelId;
      if (client) { client.vcChannelId = null; client.vcServerId = null; }

      for (const [id, c] of clients) {
        if (id !== user.peerId && c.ws.readyState === 1) {
          c.ws.send(JSON.stringify({
            type: "vc-left",
            channelId: channelId,
            userId: user.userId
          }));
        }
      }
      return;
    }
  });

  ws.on("close", () => {
    const client = clients.get(user.peerId);

    // If the user was in a voice channel, notify others before removing
    if (client?.vcChannelId) {
      const channelId = client.vcChannelId;
      for (const [id, c] of clients) {
        if (id !== user.peerId && c.ws.readyState === 1) {
          c.ws.send(JSON.stringify({
            type: "vc-left",
            channelId: channelId,
            userId: user.userId
          }));
        }
      }
    }

    // If the user was in a group call, notify group members
    if (client?.groupCallId) {
      const groupId = client.groupCallId;
      const groupChannelId = `group-${groupId}`;
      for (const [id, c] of clients) {
        if (id !== user.peerId && c.subscribedChannels.has(groupChannelId) && c.ws.readyState === 1) {
          c.ws.send(JSON.stringify({
            type: "group-call-leave",
            groupId,
            peerId: user.peerId,
            userId: user.userId
          }));
        }
      }
    }

    clients.delete(user.peerId);
    broadcast(user.peerId, { type: "peer-left", id: user.peerId });
    broadcastOnlineStatus();
    console.log(`[-] ${user.username} disconnected — total: ${clients.size}`);
  });

  ws.on("error", err => console.error(`[!] ${user.username}:`, err.message));
});

// ── Start server ──────────────────────────────────────
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[✓] Server running on port ${PORT}`);
  console.log(`[✓] HTTP: http://localhost:${PORT}`);
  console.log(`[✓] WebSocket: ws://localhost:${PORT}`);
});