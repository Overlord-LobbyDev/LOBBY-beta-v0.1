require("dotenv").config();
// ============================================================
//  auth.js  —  HTTP API server
//  Handles: auth, friends, servers, channels, messages, DMs
// ============================================================

const express  = require("express");
const bcrypt   = require("bcrypt");
const jwt      = require("jsonwebtoken");
const cors     = require("cors");
const multer   = require("multer");
const path     = require("path");
const fs       = require("fs");
const { pool, initDb } = require("./db");

const app         = express();
const PORT        = 3001;
const SECRET      = process.env.JWT_SECRET || "change-this-secret-in-production";
const SALT_ROUNDS = 12;
const STEAM_KEY   = process.env.STEAM_API_KEY || "";

const cloudinary = require("cloudinary").v2;
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Helper function to upload files to Cloudinary
async function uploadToCloudinary(buffer, filename, folder) {
  return new Promise((resolve, reject) => {
    const upload_stream = cloudinary.uploader.upload_stream(
      { folder: `lobby/${folder}`, public_id: filename, resource_type: "auto" },
      (error, result) => {
        if (error) reject(error);
        else resolve(result.secure_url);
      }
    );
    upload_stream.end(buffer);
  });
}

// ── Middleware ───────────────────────────────────────────────
app.use(cors({ origin: "*" }));
app.use(express.json());

// Multer with memory storage for Cloudinary
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

app.use("/uploads",      express.static(UPLOAD_DIR));
app.use("/server_icons", express.static(SERVER_ICON_DIR));

// Multer configs
,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /image\//.test(file.mimetype))
});

,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /image\/|video\//.test(file.mimetype))
});

const attachmentUpload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
  }),
  limits: { fileSize: 200 * 1024 * 1024 }
});

// ── Auth middleware ──────────────────────────────────────────
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });
  try {
    const payload = jwt.verify(header.slice(7), SECRET);
    req.userId   = payload.id;
    req.username = payload.username;
    next();
  } catch { res.status(401).json({ error: "Invalid or expired token" }); }
}

async function requireAdmin(req, res, next) {
  const result = await pool.query("SELECT is_admin FROM users WHERE id = $1", [req.userId]);
  if (!result.rows[0]?.is_admin) return res.status(403).json({ error: "Admin access required" });
  next();
}

function isCurrentlyBanned(user) {
  if (!user.is_banned) return false;
  if (!user.banned_until) return true;
  return new Date(user.banned_until) > new Date();
}

// ── Auth routes ──────────────────────────────────────────────

app.post("/register", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Username and password required" });
  if (username.length < 2 || username.length > 32) return res.status(400).json({ error: "Username must be 2-32 characters" });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  try {
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const r = await pool.query(
      "INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id, username, avatar_url, is_admin",
      [username.trim(), hash]
    );
    const user  = r.rows[0];
    const token = jwt.sign({ id: user.id, username: user.username }, SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: user.id, username: user.username, avatarUrl: user.avatar_url, isAdmin: user.is_admin } });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Username already taken" });
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Username and password required" });
  try {
    const r = await pool.query(
      "SELECT id, username, password, avatar_url, is_admin, is_banned, banned_until, ban_reason FROM users WHERE username = $1",
      [username.trim()]
    );
    const user = r.rows[0];
    if (!user) return res.status(401).json({ error: "Invalid username or password" });
    if (!await bcrypt.compare(password, user.password)) return res.status(401).json({ error: "Invalid username or password" });
    if (isCurrentlyBanned(user)) {
      const until  = user.banned_until ? `until ${new Date(user.banned_until).toLocaleString()}` : "permanently";
      const reason = user.ban_reason ? ` Reason: ${user.ban_reason}` : "";
      return res.status(403).json({ error: `Account banned ${until}.${reason}` });
    }
    const token = jwt.sign({ id: user.id, username: user.username }, SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: user.id, username: user.username, avatarUrl: user.avatar_url, isAdmin: user.is_admin } });
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

app.get("/me", requireAuth, async (req, res) => {
  const r = await pool.query("SELECT id, username, avatar_url, is_admin, is_banned, banned_until FROM users WHERE id = $1", [req.userId]);
  const user = r.rows[0];
  if (!user) return res.status(404).json({ error: "User not found" });
  if (isCurrentlyBanned(user)) return res.status(403).json({ error: "Account banned" });
  res.json({ id: user.id, username: user.username, avatarUrl: user.avatar_url, isAdmin: user.is_admin });
});

// GET /me/invites — fetch all pending server invites for the logged-in user
app.get("/me/invites", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT si.id, si.server_id, si.created_at,
             s.name AS server_name, s.icon_url AS server_icon,
             u.username AS inviter_username, u.id AS inviter_id,
             u.avatar_url AS inviter_avatar
      FROM server_invites si
      JOIN servers s ON s.id = si.server_id
      JOIN users u ON u.id = si.inviter_id
      WHERE si.invitee_id = $1
      ORDER BY si.created_at DESC
    `, [req.userId]);
    res.json(r.rows);
  } catch (e) {
    console.error("[/me/invites]", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/avatar", requireAuth, (req, res) => {
  avatarUpload.single("avatar")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const avatarUrl = await uploadToCloudinary(req.file.buffer, `${req.userId}-avatar`, 'avatars');
    await pool.query("UPDATE users SET avatar_url = $1 WHERE id = $2", [avatarUrl, req.userId]);
    res.json({ avatarUrl });
  });
});

const bannerUpload = multer({
  storage: multer.diskStorage({
    destination: AVATAR_DIR,
    filename: (req, file, cb) => cb(null, `banner_${req.userId}${path.extname(file.originalname).toLowerCase()}`)
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /image\//.test(file.mimetype))
});

app.post("/banner", requireAuth, (req, res) => {
  bannerUpload.single("banner")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const bannerUrl = await uploadToCloudinary(req.file.buffer, `${req.userId}-banner`, 'avatars');
    await pool.query("UPDATE users SET banner_url = $1 WHERE id = $2", [bannerUrl, req.userId]);
    res.json({ bannerUrl });
  });
});

app.patch("/profile", requireAuth, async (req, res) => {
  const { bio, status, bannerColour } = req.body;
  await pool.query(
    `UPDATE users SET
      bio = COALESCE($1, bio),
      status = COALESCE($2, status),
      banner_colour = COALESCE($3, banner_colour)
     WHERE id = $4`,
    [bio ?? null, status ?? null, bannerColour ?? null, req.userId]
  );
  res.json({ success: true });
});

app.patch("/profile/password", requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: "Both passwords required" });
  if (newPassword.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  try {
    const r = await pool.query("SELECT password FROM users WHERE id = $1", [req.userId]);
    const match = await bcrypt.compare(currentPassword, r.rows[0].password);
    if (!match) return res.status(401).json({ error: "Current password is incorrect" });
    const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await pool.query("UPDATE users SET password = $1 WHERE id = $2", [hash, req.userId]);
    res.json({ success: true });
  } catch { res.status(500).json({ error: "Server error" }); }
});

app.get("/profile/:id", requireAuth, async (req, res) => {
  const r = await pool.query(
    `SELECT id, username, avatar_url, bio, status, banner_url, banner_colour,
            display_name, status_emoji, status_text, location, website,
            created_at AS joined_at, steam_id, steam_name, steam_avatar
     FROM users WHERE id = $1`,
    [req.params.id]
  );
  if (!r.rows[0]) return res.status(404).json({ error: "User not found" });
  res.json(r.rows[0]);
});

// ── Friends ──────────────────────────────────────────────────

app.get("/friends", requireAuth, async (req, res) => {
  const r = await pool.query(`
    SELECT f.id, f.status, f.created_at,
      CASE WHEN f.user_id = $1 THEN f.friend_id ELSE f.user_id END AS other_id,
      u.username, u.avatar_url,
      f.user_id = $1 AS is_sender
    FROM friends f
    JOIN users u ON u.id = CASE WHEN f.user_id = $1 THEN f.friend_id ELSE f.user_id END
    WHERE (f.user_id = $1 OR f.friend_id = $1) AND f.status != 'blocked'
    ORDER BY f.created_at DESC
  `, [req.userId]);
  res.json(r.rows);
});

app.get("/users/search", requireAuth, async (req, res) => {
  const q = (req.query.q || "").trim();
  if (q.length < 2) return res.json([]);
  const r = await pool.query(
    "SELECT id, username, avatar_url FROM users WHERE username ILIKE $1 AND id != $2 LIMIT 20",
    [`%${q}%`, req.userId]
  );
  res.json(r.rows);
});

app.post("/friends/request", requireAuth, async (req, res) => {
  const { friendId } = req.body;
  if (!friendId || friendId === req.userId) return res.status(400).json({ error: "Invalid user" });
  try {
    await pool.query(
      "INSERT INTO friends (user_id, friend_id, status) VALUES ($1, $2, 'pending') ON CONFLICT DO NOTHING",
      [req.userId, friendId]
    );
    res.json({ success: true });
  } catch { res.status(500).json({ error: "Server error" }); }
});

app.patch("/friends/:id/accept", requireAuth, async (req, res) => {
  await pool.query(
    "UPDATE friends SET status = 'accepted' WHERE id = $1 AND friend_id = $2",
    [req.params.id, req.userId]
  );
  res.json({ success: true });
});

app.patch("/friends/:id/decline", requireAuth, async (req, res) => {
  await pool.query("DELETE FROM friends WHERE id = $1 AND friend_id = $2", [req.params.id, req.userId]);
  res.json({ success: true });
});

app.delete("/friends/:id", requireAuth, async (req, res) => {
  await pool.query(
    "DELETE FROM friends WHERE id = $1 AND (user_id = $2 OR friend_id = $2)",
    [req.params.id, req.userId]
  );
  res.json({ success: true });
});

app.post("/friends/block", requireAuth, async (req, res) => {
  const { blockId } = req.body;
  try {
    await pool.query(
      `INSERT INTO friends (user_id, friend_id, status) VALUES ($1, $2, 'blocked')
       ON CONFLICT (user_id, friend_id) DO UPDATE SET status = 'blocked'`,
      [req.userId, blockId]
    );
    res.json({ success: true });
  } catch { res.status(500).json({ error: "Server error" }); }
});

// ── Direct Messages ──────────────────────────────────────────

app.get("/dm/:userId", requireAuth, async (req, res) => {
  const other = parseInt(req.params.userId);
  const r = await pool.query(`
    SELECT dm.*, u.username, u.avatar_url,
      COALESCE(
        json_agg(a.*) FILTER (WHERE a.id IS NOT NULL), '[]'
      ) AS attachments
    FROM direct_messages dm
    JOIN users u ON u.id = dm.from_user_id
    LEFT JOIN attachments a ON a.dm_id = dm.id
    WHERE (dm.from_user_id = $1 AND dm.to_user_id = $2)
       OR (dm.from_user_id = $2 AND dm.to_user_id = $1)
    GROUP BY dm.id, u.username, u.avatar_url
    ORDER BY dm.created_at ASC
    LIMIT 100
  `, [req.userId, other]);
  res.json(r.rows);
});

app.post("/dm/:userId", requireAuth, async (req, res) => {
  const { content } = req.body;
  const to = parseInt(req.params.userId);
  const r = await pool.query(
    "INSERT INTO direct_messages (from_user_id, to_user_id, content) VALUES ($1, $2, $3) RETURNING *",
    [req.userId, to, content || ""]
  );
  res.json(r.rows[0]);
});

// ── Servers ──────────────────────────────────────────────────

app.get("/servers", requireAuth, async (req, res) => {
  const r = await pool.query(`
    SELECT s.*, sm.role,
      (SELECT COUNT(*) FROM server_members WHERE server_id = s.id) AS member_count
    FROM servers s
    JOIN server_members sm ON sm.server_id = s.id AND sm.user_id = $1
    ORDER BY s.created_at ASC
  `, [req.userId]);
  const rows = r.rows.map(s => {
    if (s.tags && typeof s.tags === "string") { try { s.tags = JSON.parse(s.tags); } catch { s.tags = []; } }
    else if (!s.tags) s.tags = [];
    return s;
  });
  res.json(rows);
});

// GET /servers/search?q= — search public servers by name, tags, or name#uid
app.get("/servers/search", requireAuth, async (req, res) => {
  const q = (req.query.q || "").trim().toLowerCase();
  if (!q) return res.json([]);
  try {
    // Match by name, unique_id, or tags (stored as JSON array string)
    const r = await pool.query(`
      SELECT s.*, (SELECT COUNT(*) FROM server_members WHERE server_id = s.id) AS member_count
      FROM servers s
      JOIN server_members sm ON sm.server_id = s.id AND sm.user_id = $1
      WHERE LOWER(s.name) LIKE $2
         OR LOWER(s.unique_id) LIKE $2
         OR LOWER(s.tags::text) LIKE $2
      ORDER BY s.name ASC
      LIMIT 20
    `, [req.userId, `%${q}%`]);
    const rows = r.rows.map(s => {
      if (s.tags && typeof s.tags === "string") { try { s.tags = JSON.parse(s.tags); } catch { s.tags = []; } }
      else if (!s.tags) s.tags = [];
      return s;
    });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: "Search failed" }); }
});

app.post("/servers", requireAuth, async (req, res) => {
  const { name, description } = req.body;
  if (!name || name.trim().length < 2) return res.status(400).json({ error: "Server name must be at least 2 characters" });
  try {
    // Generate a unique 6-char alphanumeric ID
    const uniqueId = Math.random().toString(36).slice(2, 8).toUpperCase();
    const r = await pool.query(
      "INSERT INTO servers (name, description, unique_id, owner_id) VALUES ($1, $2, $3, $4) RETURNING *",
      [name.trim(), description?.trim() || "", uniqueId, req.userId]
    );
    const server = r.rows[0];
    await pool.query(
      "INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'owner')",
      [server.id, req.userId]
    );
    await pool.query(
      "INSERT INTO channels (server_id, name, type) VALUES ($1, 'general', 'text'), ($1, 'announcements', 'announcement'), ($1, 'voice', 'voice')",
      [server.id]
    );
    res.json(server);
  } catch { res.status(500).json({ error: "Server error" }); }
});

app.post("/servers/:id/icon", requireAuth, (req, res) => {
  serverIconUpload.single("icon")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const iconUrl = await uploadToCloudinary(req.file.buffer, `${Date.now()}-icon`, 'server_icons');
    await pool.query("UPDATE servers SET icon_url = $1 WHERE id = $2 AND owner_id = $3", [iconUrl, req.params.id, req.userId]);
    res.json({ iconUrl });
  });
});

// PATCH /servers/:id — update name/description/tags/banner/icon (owner or moderator)
const serverPatchUpload = multer({
  storage: multer.diskStorage({
    destination: SERVER_ICON_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.fieldname}${path.extname(file.originalname).toLowerCase()}`)
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /image\//.test(file.mimetype))
});

app.patch("/servers/:id", requireAuth, (req, res) => {
  serverPatchUpload.fields([{ name: "banner", maxCount: 1 }, { name: "icon", maxCount: 1 }])(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const memberRow = await pool.query("SELECT role FROM server_members WHERE server_id = $1 AND user_id = $2", [req.params.id, req.userId]);
    const isAdmin = (await pool.query("SELECT is_admin FROM users WHERE id = $1", [req.userId])).rows[0]?.is_admin;
    const role = memberRow.rows[0]?.role;
    if (!["owner", "moderator"].includes(role) && !isAdmin) return res.status(403).json({ error: "Not authorised" });
    const updates = [];
    const values  = [];
    let idx = 1;
    if (req.body.name        !== undefined) { updates.push(`name = $${idx++}`);        values.push(req.body.name.trim()); }
    if (req.body.description !== undefined) { updates.push(`description = $${idx++}`); values.push(req.body.description); }
    if (req.body.tags        !== undefined) {
      // Accept JSON string or array
      const tags = typeof req.body.tags === "string" ? req.body.tags : JSON.stringify(req.body.tags);
      updates.push(`tags = $${idx++}`); values.push(tags);
    }
    if (req.files?.banner?.[0]) {
      const url = await uploadToCloudinary(req.files.banner[0].buffer, `${Date.now()}-banner`, 'server_icons');
      updates.push(`banner_url = $${idx++}`); values.push(url);
    }
    if (req.files?.icon?.[0]) {
      const url = await uploadToCloudinary(req.files.icon[0].buffer, `${Date.now()}-icon`, 'server_icons');
      updates.push(`icon_url = $${idx++}`); values.push(url);
    }
    if (!updates.length) return res.json({ success: true });
    values.push(req.params.id);
    await pool.query(`UPDATE servers SET ${updates.join(", ")} WHERE id = $${idx}`, values);
    const updated = await pool.query("SELECT * FROM servers WHERE id = $1", [req.params.id]);
    const row = updated.rows[0];
    if (row?.tags && typeof row.tags === "string") { try { row.tags = JSON.parse(row.tags); } catch {} }
    res.json(row);
  });
});

// POST /servers/:id/banner — upload server banner
app.post("/servers/:id/banner", requireAuth, (req, res) => {
  serverPatchUpload.single("banner")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const bannerUrl = await uploadToCloudinary(req.file.buffer, `${Date.now()}-banner`, 'server_icons');
    await pool.query("UPDATE servers SET banner_url = $1 WHERE id = $2 AND owner_id = $3", [bannerUrl, req.params.id, req.userId]);
    res.json({ bannerUrl });
  });
});

// POST /servers/:id/join — join a PUBLIC server (discovery/browse only, not invite flow)
app.post("/servers/:id/join", requireAuth, async (req, res) => {
  try {
    // Only allow joining servers that are tagged as public/community
    // Invite-based joining is handled exclusively by /accept-invite
    const serverRow = await pool.query(
      "SELECT tags FROM servers WHERE id = $1",
      [req.params.id]
    );
    if (!serverRow.rows[0]) return res.status(404).json({ error: "Server not found" });

    let tags = [];
    try { tags = JSON.parse(serverRow.rows[0].tags || "[]"); } catch {}
    const isPublic = Array.isArray(tags) && tags.length > 0;

    if (!isPublic) {
      return res.status(403).json({ error: "This server is private. You need an invite to join." });
    }

    await pool.query(
      "INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING",
      [req.params.id, req.userId]
    );
    res.json({ success: true });
  } catch (e) {
    console.error("[/servers/join]", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.delete("/servers/:id", requireAuth, async (req, res) => {
  const r = await pool.query("SELECT owner_id FROM servers WHERE id = $1", [req.params.id]);
  const server = r.rows[0];
  if (!server) return res.status(404).json({ error: "Server not found" });
  const isAdmin = (await pool.query("SELECT is_admin FROM users WHERE id = $1", [req.userId])).rows[0]?.is_admin;
  if (server.owner_id !== req.userId && !isAdmin) return res.status(403).json({ error: "Not authorised" });
  await pool.query("DELETE FROM servers WHERE id = $1", [req.params.id]);
  res.json({ success: true });
});

app.post("/servers/:id/invite", requireAuth, async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });
  try {
    // Inviter must be a member of the server
    const membership = await pool.query(
      "SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2",
      [req.params.id, req.userId]
    );
    if (!membership.rows.length) return res.status(403).json({ error: "You are not in this server" });

    // Don't invite someone already in the server
    const already = await pool.query(
      "SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2",
      [req.params.id, userId]
    );
    if (already.rows.length) return res.status(409).json({ error: "User is already in this server" });

    // Store as a pending invite — recipient must accept
    await pool.query(
      "INSERT INTO server_invites (server_id, inviter_id, invitee_id) VALUES ($1, $2, $3) ON CONFLICT (server_id, invitee_id) DO NOTHING",
      [req.params.id, req.userId, userId]
    );
    res.json({ success: true });
  } catch (e) {
    console.error("[/servers/invite]", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /servers/:id/accept-invite — invitee accepts and joins
app.post("/servers/:id/accept-invite", requireAuth, async (req, res) => {
  try {
    const invite = await pool.query(
      "SELECT id FROM server_invites WHERE server_id = $1 AND invitee_id = $2",
      [req.params.id, req.userId]
    );
    if (!invite.rows.length) return res.status(404).json({ error: "No pending invite found" });

    await pool.query(
      "INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING",
      [req.params.id, req.userId]
    );
    await pool.query(
      "DELETE FROM server_invites WHERE server_id = $1 AND invitee_id = $2",
      [req.params.id, req.userId]
    );
    res.json({ success: true });
  } catch (e) {
    console.error("[/servers/accept-invite]", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /servers/:id/decline-invite — invitee declines, clears pending invite
app.post("/servers/:id/decline-invite", requireAuth, async (req, res) => {
  try {
    await pool.query(
      "DELETE FROM server_invites WHERE server_id = $1 AND invitee_id = $2",
      [req.params.id, req.userId]
    );
    res.json({ success: true });
  } catch (e) {
    console.error("[/servers/decline-invite]", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.patch("/servers/:id/members/:userId/role", requireAuth, async (req, res) => {
  const { role } = req.body;
  if (!["moderator", "member"].includes(role)) return res.status(400).json({ error: "Invalid role" });
  const r = await pool.query("SELECT role FROM server_members WHERE server_id = $1 AND user_id = $2", [req.params.id, req.userId]);
  if (!["owner"].includes(r.rows[0]?.role)) return res.status(403).json({ error: "Only the owner can change roles" });
  await pool.query("UPDATE server_members SET role = $1 WHERE server_id = $2 AND user_id = $3", [role, req.params.id, req.params.userId]);
  res.json({ success: true });
});

app.delete("/servers/:id/leave", requireAuth, async (req, res) => {
  await pool.query("DELETE FROM server_members WHERE server_id = $1 AND user_id = $2", [req.params.id, req.userId]);
  res.json({ success: true });
});

// DELETE /servers/:id/members/:userId — owner/moderator kicks a member
app.delete("/servers/:id/members/:userId", requireAuth, async (req, res) => {
  const serverId = parseInt(req.params.id);
  const targetId = parseInt(req.params.userId);
  try {
    // Check requester's role
    const requesterRow = await pool.query(
      "SELECT role FROM server_members WHERE server_id = $1 AND user_id = $2",
      [serverId, req.userId]
    );
    const requesterRole = requesterRow.rows[0]?.role;
    if (!["owner", "moderator"].includes(requesterRole)) {
      return res.status(403).json({ error: "Only owners and moderators can remove members" });
    }

    // Check target's role — can't kick the owner, and moderators can't kick other moderators
    const targetRow = await pool.query(
      "SELECT role FROM server_members WHERE server_id = $1 AND user_id = $2",
      [serverId, targetId]
    );
    const targetRole = targetRow.rows[0]?.role;
    if (!targetRole) return res.status(404).json({ error: "Member not found" });
    if (targetRole === "owner") return res.status(403).json({ error: "Cannot remove the server owner" });
    if (requesterRole === "moderator" && targetRole === "moderator") {
      return res.status(403).json({ error: "Moderators cannot remove other moderators" });
    }

    await pool.query(
      "DELETE FROM server_members WHERE server_id = $1 AND user_id = $2",
      [serverId, targetId]
    );
    res.json({ success: true });
  } catch (e) {
    console.error("[kick member]", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/servers/:id/members", requireAuth, async (req, res) => {
  const r = await pool.query(`
    SELECT u.id, u.username, u.avatar_url, sm.role
    FROM server_members sm
    JOIN users u ON u.id = sm.user_id
    WHERE sm.server_id = $1
    ORDER BY CASE sm.role WHEN 'owner' THEN 0 WHEN 'moderator' THEN 1 ELSE 2 END, u.username
  `, [req.params.id]);
  res.json(r.rows);
});

// ── Channels ─────────────────────────────────────────────────

app.get("/servers/:id/channels", requireAuth, async (req, res) => {
  const r = await pool.query(
    "SELECT * FROM channels WHERE server_id = $1 ORDER BY type, name",
    [req.params.id]
  );
  res.json(r.rows);
});

app.post("/servers/:id/channels", requireAuth, async (req, res) => {
  const { name, type } = req.body;
  if (!name) return res.status(400).json({ error: "Channel name required" });
  const r = await pool.query("SELECT role FROM server_members WHERE server_id = $1 AND user_id = $2", [req.params.id, req.userId]);
  if (!["owner", "moderator"].includes(r.rows[0]?.role)) return res.status(403).json({ error: "Not authorised" });
  const ch = await pool.query(
    "INSERT INTO channels (server_id, name, type) VALUES ($1, $2, $3) RETURNING *",
    [req.params.id, name.trim().toLowerCase().replace(/\s+/g, "-"), type || "text"]
  );
  res.json(ch.rows[0]);
});

app.delete("/servers/:serverId/channels/:channelId", requireAuth, async (req, res) => {
  const r = await pool.query("SELECT role FROM server_members WHERE server_id = $1 AND user_id = $2", [req.params.serverId, req.userId]);
  if (!["owner", "moderator"].includes(r.rows[0]?.role)) return res.status(403).json({ error: "Not authorised" });
  await pool.query("DELETE FROM channels WHERE id = $1 AND server_id = $2", [req.params.channelId, req.params.serverId]);
  res.json({ success: true });
});

// ── Channel Messages ─────────────────────────────────────────

app.get("/channels/:id/messages", requireAuth, async (req, res) => {
  const r = await pool.query(`
    SELECT m.*, u.username, u.avatar_url,
      COALESCE(json_agg(a.*) FILTER (WHERE a.id IS NOT NULL), '[]') AS attachments
    FROM messages m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN attachments a ON a.message_id = m.id
    WHERE m.channel_id = $1
    GROUP BY m.id, u.username, u.avatar_url
    ORDER BY m.created_at ASC
    LIMIT 100
  `, [req.params.id]);
  res.json(r.rows);
});

app.post("/channels/:id/messages", requireAuth, async (req, res) => {
  const { content } = req.body;
  const r = await pool.query(
    "INSERT INTO messages (channel_id, user_id, content) VALUES ($1, $2, $3) RETURNING *",
    [req.params.id, req.userId, content || ""]
  );
  res.json(r.rows[0]);
});

app.delete("/channels/:channelId/messages/:messageId", requireAuth, async (req, res) => {
  const r = await pool.query("SELECT user_id FROM messages WHERE id = $1", [req.params.messageId]);
  const isAdmin = (await pool.query("SELECT is_admin FROM users WHERE id = $1", [req.userId])).rows[0]?.is_admin;
  if (r.rows[0]?.user_id !== req.userId && !isAdmin) return res.status(403).json({ error: "Not authorised" });
  await pool.query("DELETE FROM messages WHERE id = $1", [req.params.messageId]);
  res.json({ success: true });
});

// ── Attachments ──────────────────────────────────────────────

app.post("/upload", requireAuth, (req, res) => {
  attachmentUpload.single("file")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file" });
    const url = await uploadToCloudinary(req.file.buffer, `${Date.now()}-upload`, 'uploads');
    res.json({
      url,
      filename:  req.file.originalname,
      mimeType:  req.file.mimetype,
      sizeBytes: req.file.size
    });
  });
});

app.post("/attachments", requireAuth, async (req, res) => {
  const { messageId, dmId, url, filename, mimeType, sizeBytes } = req.body;
  const r = await pool.query(
    "INSERT INTO attachments (message_id, dm_id, url, filename, mime_type, size_bytes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
    [messageId || null, dmId || null, url, filename, mimeType, sizeBytes]
  );
  res.json(r.rows[0]);
});

// ── Admin routes ─────────────────────────────────────────────

app.get("/admin/users", requireAuth, requireAdmin, async (req, res) => {
  const r = await pool.query("SELECT id, username, avatar_url, is_admin, is_banned, banned_until, ban_reason, created_at FROM users ORDER BY created_at DESC");
  res.json(r.rows);
});

app.delete("/admin/users/:id", requireAuth, requireAdmin, async (req, res) => {
  if (parseInt(req.params.id) === req.userId) return res.status(400).json({ error: "Cannot delete your own account" });
  await pool.query("DELETE FROM users WHERE id = $1", [parseInt(req.params.id)]);
  res.json({ success: true });
});

app.patch("/admin/users/:id/ban", requireAuth, requireAdmin, async (req, res) => {
  if (parseInt(req.params.id) === req.userId) return res.status(400).json({ error: "Cannot ban yourself" });
  const { durationMinutes, reason } = req.body;
  const bannedUntil = durationMinutes ? new Date(Date.now() + durationMinutes * 60 * 1000) : null;
  await pool.query("UPDATE users SET is_banned=TRUE, banned_until=$1, ban_reason=$2 WHERE id=$3", [bannedUntil, reason || null, parseInt(req.params.id)]);
  res.json({ success: true });
});

app.patch("/admin/users/:id/unban", requireAuth, requireAdmin, async (req, res) => {
  await pool.query("UPDATE users SET is_banned=FALSE, banned_until=NULL, ban_reason=NULL WHERE id=$1", [parseInt(req.params.id)]);
  res.json({ success: true });
});

app.patch("/admin/users/:id/password", requireAuth, requireAdmin, async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: "Password too short" });
  const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await pool.query("UPDATE users SET password=$1 WHERE id=$2", [hash, parseInt(req.params.id)]);
  res.json({ success: true });
});

app.patch("/admin/users/:id/username", requireAuth, requireAdmin, async (req, res) => {
  const { newUsername } = req.body;
  if (!newUsername || newUsername.length < 2 || newUsername.length > 32) return res.status(400).json({ error: "Invalid username" });
  try {
    await pool.query("UPDATE users SET username=$1 WHERE id=$2", [newUsername.trim(), parseInt(req.params.id)]);
    res.json({ success: true });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Username taken" });
    res.status(500).json({ error: "Server error" });
  }
});

app.patch("/admin/users/:id/admin", requireAuth, requireAdmin, async (req, res) => {
  if (parseInt(req.params.id) === req.userId) return res.status(400).json({ error: "Cannot change own admin status" });
  await pool.query("UPDATE users SET is_admin=$1 WHERE id=$2", [!!req.body.isAdmin, parseInt(req.params.id)]);
  res.json({ success: true });
});

// ── Group Chats ──────────────────────────────────────────────

app.get("/groups", requireAuth, async (req, res) => {
  const r = await pool.query(`
    SELECT g.*, gm.joined_at,
      (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) AS member_count
    FROM group_chats g
    JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = $1
    ORDER BY g.created_at DESC
  `, [req.userId]);
  res.json(r.rows);
});

app.post("/groups", requireAuth, async (req, res) => {
  const { name, memberIds } = req.body;
  if (!name) return res.status(400).json({ error: "Group name required" });
  const allIds = [...new Set([req.userId, ...(memberIds || [])])].slice(0, 5);
  try {
    const r = await pool.query(
      "INSERT INTO group_chats (name, owner_id) VALUES ($1, $2) RETURNING *",
      [name.trim(), req.userId]
    );
    const group = r.rows[0];
    for (const uid of allIds) {
      await pool.query(
        "INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [group.id, uid]
      );
    }
    res.json(group);
  } catch { res.status(500).json({ error: "Server error" }); }
});

app.get("/groups/:id/members", requireAuth, async (req, res) => {
  const r = await pool.query(`
    SELECT u.id, u.username, u.avatar_url, gm.joined_at
    FROM group_members gm
    JOIN users u ON u.id = gm.user_id
    WHERE gm.group_id = $1
    ORDER BY gm.joined_at ASC
  `, [req.params.id]);
  res.json(r.rows);
});

app.post("/groups/:id/members", requireAuth, async (req, res) => {
  const { userId } = req.body;
  const countR = await pool.query("SELECT COUNT(*) FROM group_members WHERE group_id = $1", [req.params.id]);
  if (parseInt(countR.rows[0].count) >= 5) return res.status(400).json({ error: "Group is full (max 5)" });
  try {
    await pool.query(
      "INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [req.params.id, userId]
    );
    res.json({ success: true });
  } catch { res.status(500).json({ error: "Server error" }); }
});

app.delete("/groups/:id/members/:userId", requireAuth, async (req, res) => {
  await pool.query(
    "DELETE FROM group_members WHERE group_id = $1 AND user_id = $2",
    [req.params.id, req.params.userId]
  );
  res.json({ success: true });
});

app.delete("/groups/:id", requireAuth, async (req, res) => {
  const r = await pool.query("SELECT owner_id FROM group_chats WHERE id = $1", [req.params.id]);
  if (r.rows[0]?.owner_id !== req.userId) return res.status(403).json({ error: "Not authorised" });
  await pool.query("DELETE FROM group_chats WHERE id = $1", [req.params.id]);
  res.json({ success: true });
});

app.get("/groups/:id/messages", requireAuth, async (req, res) => {
  const r = await pool.query(`
    SELECT gm.*, u.username, u.avatar_url,
      COALESCE(json_agg(a.*) FILTER (WHERE a.id IS NOT NULL), '[]') AS attachments
    FROM group_messages gm
    JOIN users u ON u.id = gm.user_id
    LEFT JOIN attachments a ON a.group_msg_id = gm.id
    WHERE gm.group_id = $1
    GROUP BY gm.id, u.username, u.avatar_url
    ORDER BY gm.created_at ASC
    LIMIT 100
  `, [req.params.id]);
  res.json(r.rows);
});

app.post("/groups/:id/messages", requireAuth, async (req, res) => {
  const { content } = req.body;
  const r = await pool.query(
    "INSERT INTO group_messages (group_id, user_id, content) VALUES ($1, $2, $3) RETURNING *",
    [req.params.id, req.userId, content || ""]
  );
  res.json(r.rows[0]);
});

// ── Social Feed ──────────────────────────────────────────────

const postImageUpload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, `post_${Date.now()}${path.extname(file.originalname).toLowerCase()}`)
  }),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /image\/|video\//.test(file.mimetype))
});

app.get("/feed", requireAuth, async (req, res) => {
  const page  = Math.max(0, parseInt(req.query.page) || 0);
  const limit = Math.min(50, parseInt(req.query.limit) || 10);
  const tab   = req.query.tab || "friends";
  const offset = page * limit;

  let whereClause;
  if (tab === "public") {
    whereClause = `p.visibility = 'public'`;
  } else {
    whereClause = `(
      p.user_id = $1
      OR (p.visibility = 'friends' AND EXISTS(
            SELECT 1 FROM friends f WHERE f.status = 'accepted'
            AND ((f.user_id = $1 AND f.friend_id = p.user_id)
              OR (f.friend_id = $1 AND f.user_id = p.user_id))
          ))
      OR (p.visibility = 'public' AND EXISTS(
            SELECT 1 FROM friends f WHERE f.status = 'accepted'
            AND ((f.user_id = $1 AND f.friend_id = p.user_id)
              OR (f.friend_id = $1 AND f.user_id = p.user_id))
          ))
    )`;
  }

  const r = await pool.query(`
    SELECT p.*, u.username, u.avatar_url,
      (SELECT COUNT(*) FROM post_likes WHERE post_id = p.id) AS like_count,
      (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) AS comment_count,
      EXISTS(SELECT 1 FROM post_likes WHERE post_id = p.id AND user_id = $1) AS liked_by_me
    FROM posts p
    JOIN users u ON u.id = p.user_id
    WHERE ${whereClause}
    ORDER BY p.created_at DESC
    LIMIT $2 OFFSET $3
  `, [req.userId, limit, offset]);
  res.json(r.rows);
});

app.post("/posts", requireAuth, (req, res) => {
  postImageUpload.single("image")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const content    = req.body.content || "";
    const visibility = req.body.visibility || "public";
    const communityTags = req.body.community_tags ? JSON.parse(req.body.community_tags) : [];
    if (!content.trim() && !req.file) return res.status(400).json({ error: "Post needs content or an image" });
    if (content.length > 255) return res.status(400).json({ error: "Post must be 255 characters or less" });
    const imageUrl = req.file ? await uploadToCloudinary(req.file.buffer, `${Date.now()}-image`, 'uploads') : null;
    const r = await pool.query(
      "INSERT INTO posts (user_id, content, image_url, visibility, community_tags) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [req.userId, content, imageUrl, visibility, JSON.stringify(communityTags)]
    );
    res.json(r.rows[0]);
  });
});

app.delete("/posts/:id", requireAuth, async (req, res) => {
  const r = await pool.query("SELECT user_id FROM posts WHERE id = $1", [req.params.id]);
  const isAdmin = (await pool.query("SELECT is_admin FROM users WHERE id = $1", [req.userId])).rows[0]?.is_admin;
  if (r.rows[0]?.user_id !== req.userId && !isAdmin) return res.status(403).json({ error: "Not authorised" });
  await pool.query("DELETE FROM posts WHERE id = $1", [req.params.id]);
  res.json({ success: true });
});

app.post("/posts/:id/like", requireAuth, async (req, res) => {
  const existing = await pool.query("SELECT id FROM post_likes WHERE post_id=$1 AND user_id=$2", [req.params.id, req.userId]);
  if (existing.rows.length) {
    await pool.query("DELETE FROM post_likes WHERE post_id=$1 AND user_id=$2", [req.params.id, req.userId]);
    res.json({ liked: false });
  } else {
    await pool.query("INSERT INTO post_likes (post_id, user_id) VALUES ($1,$2)", [req.params.id, req.userId]);
    res.json({ liked: true });
  }
});

app.get("/posts/:id/comments", requireAuth, async (req, res) => {
  const r = await pool.query(`
    SELECT c.*, u.username, u.avatar_url
    FROM post_comments c JOIN users u ON u.id = c.user_id
    WHERE c.post_id = $1 ORDER BY c.created_at ASC
  `, [req.params.id]);
  res.json(r.rows);
});

app.post("/posts/:id/comments", requireAuth, async (req, res) => {
  const { content, parent_comment_id } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: "Comment cannot be empty" });
  const r = await pool.query(
    "INSERT INTO post_comments (post_id, user_id, content, parent_comment_id) VALUES ($1,$2,$3,$4) RETURNING *",
    [req.params.id, req.userId, content.trim(), parent_comment_id || null]
  );
  // Return with username + avatar for immediate render
  const full = await pool.query(
    "SELECT c.*, u.username, u.avatar_url FROM post_comments c JOIN users u ON u.id = c.user_id WHERE c.id = $1",
    [r.rows[0].id]
  );
  res.json(full.rows[0]);
});

app.delete("/posts/:postId/comments/:commentId", requireAuth, async (req, res) => {
  const r = await pool.query("SELECT user_id FROM post_comments WHERE id = $1", [req.params.commentId]);
  const isAdmin = (await pool.query("SELECT is_admin FROM users WHERE id = $1", [req.userId])).rows[0]?.is_admin;
  if (r.rows[0]?.user_id !== req.userId && !isAdmin) return res.status(403).json({ error: "Not authorised" });
  await pool.query("DELETE FROM post_comments WHERE id = $1", [req.params.commentId]);
  res.json({ success: true });
});

app.get("/follows", requireAuth, async (req, res) => {
  const r = await pool.query(`
    SELECT u.id, u.username, u.avatar_url
    FROM follows f JOIN users u ON u.id = f.following_id
    WHERE f.follower_id = $1
  `, [req.userId]);
  res.json(r.rows);
});

app.post("/follows/:id", requireAuth, async (req, res) => {
  if (parseInt(req.params.id) === req.userId) return res.status(400).json({ error: "Cannot follow yourself" });
  await pool.query(
    "INSERT INTO follows (follower_id, following_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
    [req.userId, req.params.id]
  );
  res.json({ success: true });
});

app.delete("/follows/:id", requireAuth, async (req, res) => {
  await pool.query("DELETE FROM follows WHERE follower_id=$1 AND following_id=$2", [req.userId, req.params.id]);
  res.json({ success: true });
});

app.patch("/profile/visibility", requireAuth, async (req, res) => {
  const { visibility } = req.body;
  if (!["public","friends"].includes(visibility)) return res.status(400).json({ error: "Invalid visibility" });
  await pool.query("UPDATE users SET post_visibility=$1 WHERE id=$2", [visibility, req.userId]);
  res.json({ success: true });
});

// GET /profile/:id/posts — posts by a specific user (respects privacy)
app.get("/profile/:id/posts", requireAuth, async (req, res) => {
  const targetId = parseInt(req.params.id);
  const isSelf = targetId === req.userId;
  const r = await pool.query(`
    SELECT p.*, u.username, u.avatar_url,
      (SELECT COUNT(*) FROM post_likes WHERE post_id = p.id) AS like_count,
      (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) AS comment_count,
      EXISTS(SELECT 1 FROM post_likes WHERE post_id = p.id AND user_id = $2) AS liked_by_me
    FROM posts p
    JOIN users u ON u.id = p.user_id
    WHERE p.user_id = $1
      AND (
        $3 OR
        p.visibility = 'public' OR
        (p.visibility = 'friends' AND EXISTS(
          SELECT 1 FROM friends f WHERE f.status = 'accepted'
          AND ((f.user_id = $2 AND f.friend_id = $1) OR (f.friend_id = $2 AND f.user_id = $1))
        ))
      )
    ORDER BY p.created_at DESC
    LIMIT 50
  `, [targetId, req.userId, isSelf]);
  res.json(r.rows);
});

// GET /profile/:id/friends — public friends list
app.get("/profile/:id/friends", requireAuth, async (req, res) => {
  const r = await pool.query(`
    SELECT
      CASE WHEN f.user_id = $1 THEN f.friend_id ELSE f.user_id END AS other_id,
      u.username, u.avatar_url
    FROM friends f
    JOIN users u ON u.id = CASE WHEN f.user_id = $1 THEN f.friend_id ELSE f.user_id END
    WHERE (f.user_id = $1 OR f.friend_id = $1) AND f.status = 'accepted'
    LIMIT 30
  `, [req.params.id]);
  res.json(r.rows);
});

// PATCH /profile/:id — update own profile fields
app.patch("/profile/:id", requireAuth, async (req, res) => {
  if (parseInt(req.params.id) !== req.userId) return res.status(403).json({ error: "Not authorised" });
  const { display_name, bio, status_emoji, status_text, location, website, banner_colour } = req.body;
  await pool.query(`
    UPDATE users SET
      display_name  = COALESCE($1, display_name),
      bio           = COALESCE($2, bio),
      status_emoji  = COALESCE($3, status_emoji),
      status_text   = COALESCE($4, status_text),
      location      = COALESCE($5, location),
      website       = COALESCE($6, website),
      banner_colour = COALESCE($7, banner_colour)
    WHERE id = $8
  `, [display_name ?? null, bio ?? null, status_emoji ?? null, status_text ?? null,
      location ?? null, website ?? null, banner_colour ?? null, req.userId]);
  res.json({ success: true });
});

// POST /profile/:id/avatar — upload avatar for profile
app.post("/profile/:id/avatar", requireAuth, (req, res) => {
  if (parseInt(req.params.id) !== req.userId) return res.status(403).json({ error: "Not authorised" });
  avatarUpload.single("avatar")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const avatarUrl = await uploadToCloudinary(req.file.buffer, `${req.userId}-avatar`, 'avatars');
    await pool.query("UPDATE users SET avatar_url = $1 WHERE id = $2", [avatarUrl, req.userId]);
    res.json({ avatar_url: avatarUrl });
  });
});

// POST /profile/:id/banner — upload banner for profile
app.post("/profile/:id/banner", requireAuth, (req, res) => {
  if (parseInt(req.params.id) !== req.userId) return res.status(403).json({ error: "Not authorised" });
  bannerUpload.single("banner")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const bannerUrl = await uploadToCloudinary(req.file.buffer, `${req.userId}-banner`, 'avatars');
    await pool.query("UPDATE users SET banner_url = $1 WHERE id = $2", [bannerUrl, req.userId]);
    res.json({ banner_url: bannerUrl });
  });
});

// ── Steam Integration ────────────────────────────────────────

// GET /steam/auth — redirect user to Steam OpenID login page
app.get("/steam/auth", async (req, res) => {
  // Token can come from query param (popup flow) or Authorization header
  let userId = null;
  const queryToken = req.query.token;
  if (queryToken) {
    try {
      const payload = jwt.verify(queryToken, SECRET);
      userId = payload.id;
    } catch { return res.status(401).send("Invalid token"); }
  } else {
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) {
      try {
        const payload = jwt.verify(header.slice(7), SECRET);
        userId = payload.id;
      } catch { return res.status(401).send("Invalid token"); }
    }
  }
  if (!userId) return res.status(401).send("Unauthorized");

  const returnUrl = `https://lobby-auth-server.onrender.com/steam/callback?userId=${userId}`;
  const steamOpenIdUrl =
    `https://steamcommunity.com/openid/login` +
    `?openid.ns=http://specs.openid.net/auth/2.0` +
    `&openid.mode=checkid_setup` +
    `&openid.return_to=${encodeURIComponent(returnUrl)}` +
    `&openid.realm=${encodeURIComponent(`https://lobby-auth-server.onrender.com`)}` +
    `&openid.identity=http://specs.openid.net/auth/2.0/identifier_select` +
    `&openid.claimed_id=http://specs.openid.net/auth/2.0/identifier_select`;
  res.redirect(steamOpenIdUrl);
});

// GET /steam/callback — Steam redirects here after user logs in
app.get("/steam/callback", async (req, res) => {
  const claimed = req.query["openid.claimed_id"] || "";
  const identity = req.query["openid.identity"] || "";
  const userId  = req.query.userId;

  console.log("[steam/callback] claimed_id:", claimed);
  console.log("[steam/callback] identity:", identity);
  console.log("[steam/callback] userId:", userId);
  console.log("[steam/callback] all params:", JSON.stringify(req.query));

  // Steam returns steamid in claimed_id like: https://steamcommunity.com/openid/id/76561198...
  const matchClaimed  = claimed.match(/\/openid\/id\/(\d+)/);
  const matchIdentity = identity.match(/\/openid\/id\/(\d+)/);
  const match = matchClaimed || matchIdentity;

  if (!match || !userId) {
    console.error("[steam/callback] Failed — no match or no userId");
    return res.send(`<html><body style="background:#1e1f22;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
      <div style="text-align:center">
        <div style="font-size:48px">❌</div>
        <div style="font-size:16px;margin-top:12px">Steam login failed — could not extract Steam ID</div>
        <div style="font-size:12px;color:#80848e;margin-top:8px">claimed: ${claimed}</div>
      </div>
      <script>setTimeout(() => window.close(), 4000);</script>
    </body></html>`);
  }

  const steamId = match[1];
  console.log("[steam/callback] Steam ID:", steamId);

  if (!STEAM_KEY) {
    return res.send(`<html><body style="background:#1e1f22;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh">
      <div style="text-align:center"><div style="font-size:48px">❌</div><div>Steam API key not configured</div></div>
      <script>setTimeout(() => window.close(), 3000);</script>
    </body></html>`);
  }

  try {
    const r = await fetch(
      `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_KEY}&steamids=${steamId}`
    );
    const data   = await r.json();
    const player = data?.response?.players?.[0];

    console.log("[steam/callback] player:", player?.personaname);

    if (!player) {
      return res.send(`<html><body style="background:#1e1f22;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh">
        <div style="text-align:center"><div style="font-size:48px">❌</div><div>Could not fetch Steam profile — is your profile public?</div></div>
        <script>setTimeout(() => window.close(), 4000);</script>
      </body></html>`);
    }

    await pool.query(
      "UPDATE users SET steam_id = $1, steam_name = $2, steam_avatar = $3 WHERE id = $4",
      [steamId, player.personaname, player.avatarfull, userId]
    );

    console.log("[steam/callback] ✅ Linked", player.personaname, "to userId", userId);

    res.send(`
      <html><body style="background:#1e1f22;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
        <div style="text-align:center">
          <div style="font-size:48px;margin-bottom:16px">✅</div>
          <div style="font-size:18px;font-weight:700">Linked as ${player.personaname}</div>
          <div style="font-size:13px;color:#80848e;margin-top:8px">You can close this window and return to LOBBY</div>
        </div>
        <script>
          try { window.opener?.postMessage({type:'steam-linked',steamName:${JSON.stringify(player.personaname)},steamId:'${steamId}',steamAvatar:${JSON.stringify(player.avatarfull)}},'*'); } catch(e){}
          setTimeout(() => { try { window.close(); } catch(e){} }, 2000);
        </script>
      </body></html>`
    );
  } catch (err) {
    console.error("[steam/callback]", err);
    res.send(`<html><body style="background:#1e1f22;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh">
      <div style="text-align:center"><div style="font-size:48px">❌</div><div>Server error: ${err.message}</div></div>
      <script>setTimeout(() => window.close(), 4000);</script>
    </body></html>`);
  }
});

// DELETE /steam/unlink — remove Steam account from profile
app.delete("/steam/unlink", requireAuth, async (req, res) => {
  await pool.query(
    "UPDATE users SET steam_id = NULL, steam_name = NULL, steam_avatar = NULL WHERE id = $1",
    [req.userId]
  );
  res.json({ success: true });
});

// GET /steam/recent — get recently played games + achievements for the logged-in user
app.get("/steam/recent", requireAuth, async (req, res) => {
  const userRow = await pool.query("SELECT steam_id FROM users WHERE id = $1", [req.userId]);
  const steam_id = userRow.rows[0]?.steam_id;
  if (!steam_id) return res.json([]);
  if (!STEAM_KEY) return res.status(503).json({ error: "Steam API key not configured" });
  try {
    // Fetch recently played games
    const gamesRes = await fetch(
      `https://api.steampowered.com/IPlayerService/GetRecentlyPlayedGames/v1/?key=${STEAM_KEY}&steamid=${steam_id}&count=10`
    );
    const gamesData = await gamesRes.json();
    const games = gamesData?.response?.games || [];

    // Fetch achievements for all games in parallel
    const enriched = await Promise.all(games.map(async (g) => {
      let achievements = [];
      try {
          const [schemaRes, playerRes] = await Promise.all([
            fetch(`https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?key=${STEAM_KEY}&appid=${g.appid}`),
            fetch(`https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/?key=${STEAM_KEY}&steamid=${steam_id}&appid=${g.appid}`)
          ]);
          const schema = await schemaRes.json();
          const player = await playerRes.json();
          const schemaAchs = schema?.game?.availableGameStats?.achievements || [];
          const playerAchs = (player?.playerstats?.achievements || [])
            .filter(a => a.achieved === 1)
            .sort((a, b) => b.unlocktime - a.unlocktime)
            .slice(0, 5);
          achievements = playerAchs.map(pa => {
            const meta = schemaAchs.find(s => s.name === pa.apiname) || {};
            return {
              apiname:     pa.apiname,
              name:        meta.displayName || pa.apiname,
              description: meta.description || "",
              icon:        meta.icon || "",
              unlocktime:  pa.unlocktime,
            };
          });
        } catch(e) {}

      const hoursRecent = g.playtime_2weeks  ? (g.playtime_2weeks  / 60).toFixed(1) : null;
      const hoursTotal  = g.playtime_forever ? (g.playtime_forever / 60).toFixed(1) : "0";

      return {
        appid:       g.appid,
        name:        g.name,
        header_img:  `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.appid}/header.jpg`,
        capsule_img: `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.appid}/library_600x900.jpg`,
        hours_recent: hoursRecent,
        hours_total:  hoursTotal,
        achievements,
      };
    }));

    res.json(enriched);
  } catch (err) {
    console.error("[steam/recent]", err);
    res.status(500).json({ error: "Could not reach Steam API" });
  }
});

// ── Start ────────────────────────────────────────────────────
initDb().then(() => {
  app.listen(PORT, () => console.log(`[auth] HTTP server on Render (https://lobby-auth-server.onrender.com)`));
});