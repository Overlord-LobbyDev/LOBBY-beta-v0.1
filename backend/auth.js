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
const cloudinary = require("cloudinary").v2;
const nodemailer = require("nodemailer");

const app         = express();
const PORT        = process.env.PORT || 3001;
const SECRET      = process.env.JWT_SECRET || "change-this-secret-in-production";
const SALT_ROUNDS = 12;
const STEAM_KEY   = process.env.STEAM_API_KEY || "";

// ── Cloudinary config ───────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

async function uploadToCloudinary(fileBuffer, folder, publicId, resourceType = "image") {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: `lobby/${folder}`, public_id: publicId, resource_type: resourceType, overwrite: true },
      (err, result) => err ? reject(err) : resolve(result.secure_url)
    );
    stream.end(fileBuffer);
  });
}

// ── Email Configuration ────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: process.env.EMAIL_SERVICE || "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  }
});

// Generate 6-digit verification code
function generateVerificationCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Send verification email
async function sendVerificationEmail(email, platform, code) {
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: `LOBBY: Link your ${platform} account`,
      html: `
        <h2>Verify Your ${platform} Account</h2>
        <p>You requested to link your ${platform} account to LOBBY.</p>
        <p>Enter this code to complete verification:</p>
        <h3 style="font-family: monospace; font-size: 24px; letter-spacing: 4px;">
          ${code}
        </h3>
        <p>This code expires in 10 minutes.</p>
        <p><strong>If you didn't request this, ignore this email.</strong></p>
      `
    });
    return true;
  } catch (err) {
    console.error("Email send error:", err);
    return false;
  }
}

// ── Middleware ───────────────────────────────────────────────
app.use(cors({ origin: "*" }));
app.use(express.json());

// Static file serving
const AVATAR_DIR     = path.join(__dirname, "avatars");
const UPLOAD_DIR     = path.join(__dirname, "uploads");
const SERVER_ICON_DIR = path.join(__dirname, "server_icons");
[AVATAR_DIR, UPLOAD_DIR, SERVER_ICON_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d); });
app.use("/avatars",      express.static(AVATAR_DIR));
app.use("/uploads",      express.static(UPLOAD_DIR));
app.use("/server_icons", express.static(SERVER_ICON_DIR));

// Multer configs
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /image\//.test(file.mimetype))
});

const serverIconUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /image\/|video\//.test(file.mimetype))
});

const attachmentUpload = multer({
  storage: multer.memoryStorage(),
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

// ── Per-process user-flags cache (is_admin / is_overlord) ────
// Avoids a SELECT on every request that needs to check admin status.
// TTL is 60 s — short enough that promotions take effect quickly.
const _userFlagsCache = new Map();
const USER_FLAGS_TTL  = 60_000;

async function getUserFlags(userId) {
  const cached = _userFlagsCache.get(userId);
  if (cached && Date.now() - cached.ts < USER_FLAGS_TTL) return cached;
  const r = await pool.query(
    "SELECT is_admin, is_overlord FROM users WHERE id = $1", [userId]
  );
  const flags = {
    isAdmin:    r.rows[0]?.is_admin    || false,
    isOverlord: r.rows[0]?.is_overlord || false,
    ts: Date.now(),
  };
  _userFlagsCache.set(userId, flags);
  return flags;
}

// Call this whenever admin/overlord status changes so the cache is fresh
function invalidateUserFlags(userId) { _userFlagsCache.delete(userId); }

async function requireAdmin(req, res, next) {
  const { isAdmin } = await getUserFlags(req.userId);
  if (!isAdmin) return res.status(403).json({ error: "Admin access required" });
  next();
}

async function requireOverlord(req, res, next) {
  const { isOverlord } = await getUserFlags(req.userId);
  if (!isOverlord) return res.status(403).json({ error: "Overlord access required" });
  next();
}

function isCurrentlyBanned(user) {
  if (!user.is_banned) return false;
  if (!user.banned_until) return true;
  return new Date(user.banned_until) > new Date();
}

// ── Auth routes ──────────────────────────────────────────────

app.post("/register", async (req, res) => {
  const { username, password, email } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Username and password required" });
  if (username.length < 2 || username.length > 32) return res.status(400).json({ error: "Username must be 2-32 characters" });
  // Hard-blocked words for usernames (severe terms never allowed)
  const HARD_BLOCKED = ['nigger','nigga','fuck','shit','cunt','faggot','retard','chink','spic','kike'];
  const lowerUsername = username.trim().toLowerCase();
  if (HARD_BLOCKED.some(w => lowerUsername.includes(w))) {
    return res.status(400).json({ error: "Username contains prohibited words" });
  }
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Invalid email address" });
  try {
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const r = await pool.query(
      "INSERT INTO users (username, password_hash, email) VALUES ($1, $2, $3) RETURNING id, username, avatar_url, is_admin, email",
      [username.trim(), hash, email ? email.toLowerCase().trim() : null]
    );
    const user  = r.rows[0];
    const token = jwt.sign({ id: user.id, username: user.username }, SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: user.id, username: user.username, avatarUrl: user.avatar_url, isAdmin: user.is_admin }, needs_email: !user.email });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Username already taken" });
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Username and password required" });
  try {
    let user = null;
    const input   = username.trim();
    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input);
    const isTag   = !isEmail && input.includes('#');

    if (isEmail) {
      const r = await pool.query(
        "SELECT id, username, password_hash, avatar_url, is_admin, is_overlord, is_banned, banned_until, ban_reason, email FROM users WHERE LOWER(email) = $1",
        [input.toLowerCase()]
      );
      user = r.rows[0] || null;
      if (!user) return res.status(401).json({ error: "No account found with that email address" });
    } else if (isTag) {
      const hashIdx   = input.lastIndexOf('#');
      const unamePart = input.slice(0, hashIdx).trim();
      const tagPart   = input.slice(hashIdx);
      if (!unamePart) return res.status(400).json({ error: "Invalid format — use Username#Tag or your email" });
      const r = await pool.query(
        "SELECT id, username, password_hash, avatar_url, is_admin, is_overlord, is_banned, banned_until, ban_reason, email FROM users WHERE username = $1",
        [unamePart]
      );
      const candidate = r.rows[0];
      // Compute tag server-side using same formula as frontend
      const computedTag = candidate ? (() => { const n = (Math.abs(candidate.id * 2654435761) >>> 0) % 9000 + 1000; return `#${n}`; })() : null;
      if (!candidate || computedTag !== tagPart) return res.status(401).json({ error: "Invalid username or tag" });
      user = candidate;
    } else {
      // Plain username — backwards compat
      const r = await pool.query(
        "SELECT id, username, password_hash, avatar_url, is_admin, is_overlord, is_banned, banned_until, ban_reason, email FROM users WHERE username = $1",
        [input]
      );
      user = r.rows[0] || null;
      if (!user) return res.status(401).json({ error: "Invalid username or password" });
    }

    if (!await bcrypt.compare(password, user.password_hash)) return res.status(401).json({ error: "Incorrect password" });

    if (isCurrentlyBanned(user)) {
      const until  = user.banned_until ? `until ${new Date(user.banned_until).toLocaleString()}` : "permanently";
      const reason = user.ban_reason ? ` Reason: ${user.ban_reason}` : "";
      return res.status(403).json({ error: `Account banned ${until}.${reason}` });
    }
    const token = jwt.sign({ id: user.id, username: user.username }, SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: user.id, username: user.username, avatarUrl: user.avatar_url, isAdmin: user.is_admin, isOverlord: user.is_overlord }, needs_email: !user.email });
  } catch (err) { console.error("[login error]", err); res.status(500).json({ error: "Server error" }); }
});

app.get("/me", requireAuth, async (req, res) => {
  const r = await pool.query(
    `SELECT id, username, avatar_url, is_admin, is_overlord, is_banned, banned_until,
            tournament_card_image_url, tournament_card_bg_colour,
            tournament_card_border_colour, tournament_card_name_colour, tournament_card_bg_pos,
            riot_puuid, riot_gamename, riot_tagline,
            chess_username, lichess_username
     FROM users WHERE id = $1`,
    [req.userId]
  );
  const user = r.rows[0];
  if (!user) return res.status(404).json({ error: "User not found" });
  if (isCurrentlyBanned(user)) return res.status(403).json({ error: "Account banned" });

  // Email fetched separately — safe if column not yet migrated
  let email = null;
  try {
    const er = await pool.query("SELECT email FROM users WHERE id = $1", [req.userId]);
    email = er.rows[0]?.email || null;
  } catch(e) { /* column not yet migrated — safe to ignore */ }

  res.json({
    id: user.id,
    username: user.username,
    avatarUrl: user.avatar_url,
    isAdmin: user.is_admin,
    is_admin: user.is_admin,
    isOverlord: user.is_overlord,
    needs_email: !email,
    tournamentCard: {
      imageUrl:      user.tournament_card_image_url     || null,
      bgColour:      user.tournament_card_bg_colour     || '#2c3440',
      borderColour:  user.tournament_card_border_colour || '#f9a8d4',
      nameColour:    user.tournament_card_name_colour   || '#fdf2f8',
      bgPos:         user.tournament_card_bg_pos        || '50% 50%',
    },
    riot_puuid:       user.riot_puuid       || null,
    riot_gamename:    user.riot_gamename    || null,
    riot_tagline:     user.riot_tagline     || null,
    chess_username:   user.chess_username   || null,
    lichess_username: user.lichess_username || null,
  });
});

// ── Send email verification code ──────────────────────────────
app.post("/email-verify/send", requireAuth, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Invalid email address" });
  const normalised = email.toLowerCase().trim();
  try {
    const taken = await pool.query(
      "SELECT id FROM users WHERE LOWER(email) = $1 AND id != $2", [normalised, req.userId]
    );
    if (taken.rows.length) return res.status(409).json({ error: "Email already linked to another account" });

    const code      = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 mins

    // UPSERT — replaces old code atomically without a separate DELETE round-trip
    await pool.query(
      `INSERT INTO email_verifications (user_id, email, verification_code, code_expires_at, attempts)
       VALUES ($1,$2,$3,$4,0)
       ON CONFLICT (user_id) DO UPDATE SET
         email = EXCLUDED.email,
         verification_code = EXCLUDED.verification_code,
         code_expires_at = EXCLUDED.code_expires_at,
         attempts = 0,
         created_at = NOW()`,
      [req.userId, normalised, code, expiresAt]
    );

    const sent = await sendVerificationEmail(normalised, "LOBBY", code);
    if (!sent) return res.status(500).json({ error: "Failed to send email — check EMAIL_USER and EMAIL_PASSWORD in your .env" });

    res.json({ success: true });
  } catch(err) {
    console.error("[email-verify/send]", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ── Confirm email verification code ──────────────────────────
app.post("/email-verify/confirm", requireAuth, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "Code required" });
  try {
    const r = await pool.query(
      "SELECT * FROM email_verifications WHERE user_id = $1 AND verification_code = $2",
      [req.userId, code.trim()]
    );

    if (!r.rows.length) {
      // Increment attempts on any matching pending row
      await pool.query("UPDATE email_verifications SET attempts = attempts + 1 WHERE user_id = $1", [req.userId]).catch(() => {});
      return res.status(400).json({ error: "Invalid verification code" });
    }

    const verif = r.rows[0];
    if (new Date() > new Date(verif.code_expires_at)) {
      await pool.query("DELETE FROM email_verifications WHERE id = $1", [verif.id]);
      return res.status(400).json({ error: "Code expired — request a new one" });
    }
    if (verif.attempts >= 5) {
      return res.status(429).json({ error: "Too many attempts — request a new code" });
    }

    await pool.query("UPDATE users SET email = $1 WHERE id = $2", [verif.email, req.userId]);
    await pool.query("DELETE FROM email_verifications WHERE id = $1", [verif.id]);

    res.json({ success: true, email: verif.email });
  } catch(err) {
    console.error("[email-verify/confirm]", err);
    res.status(500).json({ error: "Verification failed" });
  }
});

// ── Link Riot account ────────────────────────────────────────
app.post("/link-riot", requireAuth, async (req, res) => {
  const { gameName, tagLine } = req.body;
  if (!gameName || !tagLine) return res.status(400).json({ error: "gameName and tagLine required" });
  const RIOT_API_KEY = process.env.RIOT_API_KEY;
  if (!RIOT_API_KEY) return res.status(503).json({ error: "Riot API not configured on server" });
  try {
    const axios = require("axios");
    const resp = await axios.get(
      `https://europe.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
      { headers: { "X-Riot-Token": RIOT_API_KEY } }
    );
    const { puuid, gameName: gn, tagLine: tl } = resp.data;
    await pool.query(
      "UPDATE users SET riot_puuid = $1, riot_gamename = $2, riot_tagline = $3 WHERE id = $4",
      [puuid, gn, tl, req.userId]
    );
    res.json({ success: true, gameName: gn, tagLine: tl });
  } catch (err) {
    const is404 = err.response?.status === 404;
    res.status(is404 ? 404 : 500).json({
      error: is404 ? "Riot account not found — check your Game Name and Tagline" : "Failed to link Riot account"
    });
  }
});

// ── Unlink Riot account ───────────────────────────────────────
app.delete("/link-riot", requireAuth, async (req, res) => {
  await pool.query("UPDATE users SET riot_puuid = NULL, riot_gamename = NULL, riot_tagline = NULL WHERE id = $1", [req.userId]);
  res.json({ success: true });
});

// ── POST /link-chess — Frontend initiates chess account linking ──────────
app.post("/link-chess", requireAuth, async (req, res) => {
  const { platform, username } = req.body;
  const userId = req.userId;

  if (!platform || !username) {
    return res.status(400).json({ error: "Missing platform or username" });
  }

  if (!["chess.com", "lichess"].includes(platform)) {
    return res.status(400).json({ error: "Invalid platform" });
  }

  try {
    // For Lichess: use OAuth popup
    if (platform === "lichess") {
      const popupToken = jwt.sign({ id: userId }, SECRET, { expiresIn: "15m" });
      const popupUrl = `${process.env.AUTH_SERVER_URL || "https://lobby-auth-server.onrender.com"}/chess/auth?platform=${encodeURIComponent(platform)}&username=${encodeURIComponent(username)}&token=${popupToken}`;
      return res.json({
        success: true,
        popupUrl,
        message: "Opening Lichess OAuth window…"
      });
    }

    // For Chess.com: use email verification via LOBBY account
    // Get user's LOBBY email (they already verified this when signing up)
    const userRow = await pool.query("SELECT email FROM users WHERE id = $1", [userId]);
    if (!userRow.rows.length || !userRow.rows[0].email) {
      return res.status(400).json({ error: "No email found on your LOBBY account" });
    }
    const userEmail = userRow.rows[0].email;

    // Verify Chess.com username exists (public API check)
    const axios = require("axios");
    let chessProfile;
    try {
      const check = await axios.get(
        `https://api.chess.com/pub/player/${encodeURIComponent(username.toLowerCase())}`,
        { headers: { "User-Agent": "LOBBY-App/1.0" } }
      );
      if (check.status !== 200) throw new Error("not found");
      chessProfile = check.data;
    } catch (err) {
      const is404 = err.response?.status === 404 || err.message?.includes("not found");
      return res.status(is404 ? 404 : 500).json({
        error: is404 ? `Chess.com account "${username}" not found` : "Could not reach Chess.com"
      });
    }

    // Generate verification code
    const crypto = require("crypto");
    const verifyCode = crypto.randomBytes(24).toString("hex").toUpperCase();

    // Store verification record
    await pool.query(
      "DELETE FROM chess_verifications WHERE user_id = $1 AND platform = 'chess.com'",
      [userId]
    );
    await pool.query(
      `INSERT INTO chess_verifications (user_id, platform, username, verification_code, code_expires_at, attempts)
       VALUES ($1, 'chess.com', $2, $3, $4, 0)`,
      [userId, username, verifyCode, new Date(Date.now() + 15 * 60 * 1000)]
    );

    // Send verification email to their LOBBY email
    const verifyLink = `https://lobby-auth-server.onrender.com/chess/verify-email?code=${verifyCode}&userId=${userId}`;
    const emailHtml = `
      <html>
      <body style="font-family:Arial,sans-serif;background:#1e1f22;color:#f2f3f5;padding:20px">
        <div style="max-width:500px;margin:0 auto;background:#2b2d31;border-radius:12px;padding:30px">
          <div style="text-align:center;margin-bottom:20px">
            <div style="font-size:48px">♟️</div>
            <h1 style="margin:10px 0 5px;font-size:22px">Verify Chess.com Account</h1>
            <p style="color:#80848e;margin:0">Link your Chess.com account to LOBBY</p>
          </div>
          
          <p style="color:#b5bac1;line-height:1.6">
            You requested to link the Chess.com account <strong style="color:#f2f3f5">${username}</strong> to your LOBBY profile.
          </p>
          
          <div style="background:#313338;border-radius:8px;padding:20px;margin:20px 0;text-align:center">
            <a href="${verifyLink}" style="display:inline-block;padding:12px 24px;background:#5865f2;color:#fff;text-decoration:none;border-radius:8px;font-weight:700">Verify & Link Account</a>
          </div>
          
          <p style="color:#80848e;font-size:13px;margin:20px 0 0">
            Or copy this link: <br>
            <code style="background:#313338;padding:8px 12px;border-radius:4px;display:block;word-break:break-all;margin-top:8px">${verifyLink}</code>
          </p>
          
          <p style="color:#80848e;font-size:12px;margin:20px 0 0;border-top:1px solid rgba(255,255,255,.1);padding-top:15px">
            This link expires in 15 minutes. If you didn't request this, you can safely ignore this email.
          </p>
        </div>
      </body>
      </html>
    `;

    // Send email using nodemailer
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
      console.error("[/link-chess] Email config missing: EMAIL_USER or EMAIL_PASSWORD not set");
      return res.status(500).json({ 
        error: "Email service not configured on server. Contact support." 
      });
    }

    const transporter = require("nodemailer").createTransport({
      service: process.env.EMAIL_SERVICE || "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
      }
    });

    try {
      await transporter.sendMail({
        from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
        to: userEmail,
        subject: `Verify your Chess.com account for LOBBY`,
        html: emailHtml
      });

      console.log(`[/link-chess] ✅ Sent verification email to ${userEmail} for Chess.com account "${username}"`);

      res.json({
        success: true,
        message: `Verification email sent to ${userEmail}. Check your email to confirm linking your Chess.com account.`
      });
    } catch (emailErr) {
      console.error("[/link-chess] Email send error:", emailErr.message);
      res.status(500).json({ 
        error: `Failed to send email: ${emailErr.message}` 
      });
    }

  } catch (err) {
    console.error("[/link-chess] Error:", err.message);
    res.status(500).json({ error: err.message || "Failed to process request" });
  }
});

// ── GET /chess/verify-email — User clicks verification link from email ────
app.get("/chess/verify-email", async (req, res) => {
  const { code, userId } = req.query;

  if (!code || !userId) {
    return res.send(`
      <html><body style="background:#1e1f22;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
        <div style="text-align:center"><div style="font-size:48px">❌</div><div style="margin-top:12px">Missing verification code or user ID</div></div>
      </body></html>
    `);
  }

  try {
    // Get the verification record
    const verRow = await pool.query(
      "SELECT * FROM chess_verifications WHERE user_id = $1 AND platform = 'chess.com'",
      [userId]
    );

    if (!verRow.rows.length) {
      return res.send(`
        <html><body style="background:#1e1f22;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
          <div style="text-align:center"><div style="font-size:48px">❌</div><div style="margin-top:12px">No pending verification found</div></div>
        </body></html>
      `);
    }

    const verification = verRow.rows[0];
    const chessUsername = verification.username;

    // Check if expired
    if (new Date() > new Date(verification.code_expires_at)) {
      await pool.query("DELETE FROM chess_verifications WHERE id = $1", [verification.id]);
      return res.send(`
        <html><body style="background:#1e1f22;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
          <div style="text-align:center"><div style="font-size:48px">⏰</div><div style="margin-top:12px">Verification link expired — please try linking again</div></div>
        </body></html>
      `);
    }

    // Verify the code matches
    if (code !== verification.verification_code) {
      return res.send(`
        <html><body style="background:#1e1f22;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
          <div style="text-align:center"><div style="font-size:48px">❌</div><div style="margin-top:12px">Invalid verification code</div></div>
        </body></html>
      `);
    }

    // Verify Chess.com account still exists and get canonical username
    const axios = require("axios");
    let verifiedUsername = chessUsername;
    try {
      const profileRes = await axios.get(
        `https://api.chess.com/pub/player/${encodeURIComponent(chessUsername.toLowerCase())}`,
        { headers: { "User-Agent": "LOBBY-App/1.0" } }
      );
      if (profileRes.data?.username) {
        verifiedUsername = profileRes.data.username;
      }
    } catch (err) {
      return res.send(`
        <html><body style="background:#1e1f22;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
          <div style="text-align:center"><div style="font-size:48px">❌</div><div style="margin-top:12px">Chess.com account not found — may have been deleted</div></div>
        </body></html>
      `);
    }

    // All verified! Link the account
    await pool.query(
      "UPDATE users SET chess_username = $1 WHERE id = $2",
      [verifiedUsername, userId]
    );

    // Clean up verification record
    await pool.query("DELETE FROM chess_verifications WHERE id = $1", [verification.id]);

    console.log(`[chess/verify-email] ✅ Email-verified and linked "${verifiedUsername}" to userId ${userId}`);

    res.send(`
      <html>
      <body style="background:#1e1f22;color:#f2f3f5;font-family:'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
        <div style="background:#2b2d31;border-radius:16px;padding:40px;max-width:420px;width:90%;text-align:center;box-shadow:0 24px 64px rgba(0,0,0,.5)">
          <div style="font-size:48px;margin-bottom:16px">✅</div>
          <div style="font-size:20px;font-weight:800;margin-bottom:8px">Account Linked!</div>
          <div style="font-size:13px;color:#b5bac1;margin-bottom:16px">
            Your Chess.com account <strong style="color:#f2f3f5">${verifiedUsername}</strong> is now linked to LOBBY.
          </div>
          <div style="font-size:12px;color:#80848e;margin-bottom:20px">
            You can close this window or return to the app.
          </div>
          <button onclick="window.close()" style="padding:10px 20px;background:#5865f2;color:#fff;border:none;border-radius:8px;font-size:13px;cursor:pointer;font-family:inherit;font-weight:700">
            Close
          </button>
        </div>
      </body>
      </html>
    `);

  } catch (err) {
    console.error("[chess/verify-email]", err);
    res.send(`
      <html><body style="background:#1e1f22;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
        <div style="text-align:center"><div style="font-size:48px">❌</div><div style="margin-top:12px">Verification failed: ${err.message}</div></div>
      </body></html>
    `);
  }
});

// ── Step 1: Start Chess Account Verification ──────────────────
// ── Chess Integration (with ownership verification) ─────────

// ── Lichess: OAuth2 PKCE flow (user logs into Lichess to prove ownership) ──

// GET /chess/auth — entry point for the popup window
app.get("/chess/auth", async (req, res) => {
  try {
    const { platform, username, token: queryToken } = req.query;

    // Authenticate from query token (same as Steam)
    let userId = null;
    if (queryToken) {
      try {
        const payload = jwt.verify(queryToken, SECRET);
        userId = payload.id;
      } catch { return res.status(401).send("Invalid token"); }
    }
    if (!userId) return res.status(401).send("Unauthorized");
    if (!platform || !["chess.com", "lichess"].includes(platform)) {
      return res.send(`<html><body style="background:#1e1f22;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
        <div style="text-align:center"><div style="font-size:48px">❌</div><div style="margin-top:12px">Invalid platform</div></div>
        <script>setTimeout(() => window.close(), 3000);</script>
      </body></html>`);
    }

    if (platform === "lichess") {
      // ── Lichess: redirect to Lichess OAuth login ──
      // Generate PKCE code_verifier + code_challenge
      const crypto = require("crypto");
      const codeVerifier = crypto.randomBytes(32).toString("hex");
      const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
      const state = crypto.randomBytes(16).toString("hex");

      // Store verifier + state in DB so the callback can retrieve them
      // Delete any existing record first to avoid conflicts
      await pool.query(
        "DELETE FROM chess_verifications WHERE user_id = $1 AND platform = 'lichess'",
        [userId]
      );
      await pool.query(
        `INSERT INTO chess_verifications (user_id, platform, username, verification_code, code_expires_at, attempts)
         VALUES ($1, 'lichess', $2, $3, $4, 0)`,
        [userId, username || "pending", JSON.stringify({ codeVerifier, state }), new Date(Date.now() + 10 * 60 * 1000)]
      );

      const redirectUri = `https://lobby-auth-server.onrender.com/chess/callback/lichess?userId=${userId}`;
      const lichessAuthUrl = `https://lichess.org/oauth`
        + `?response_type=code`
        + `&client_id=lobby-app`
        + `&redirect_uri=${encodeURIComponent(redirectUri)}`
        + `&code_challenge_method=S256`
        + `&code_challenge=${codeChallenge}`
        + `&state=${state}`;

      return res.redirect(lichessAuthUrl);
    }

    // ── Chess.com: Personal access token verification flow ──
    if (!username) {
      return res.send(`<html><body style="background:#1e1f22;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
        <div style="text-align:center"><div style="font-size:48px">❌</div><div style="margin-top:12px">Username required</div></div>
        <script>setTimeout(() => window.close(), 3000);</script>
      </body></html>`);
    }

    // Store pending verification session
    await pool.query(
      "DELETE FROM chess_verifications WHERE user_id = $1 AND platform = 'chess.com'",
      [userId]
    );
    await pool.query(
      `INSERT INTO chess_verifications (user_id, platform, username, verification_code, code_expires_at, attempts)
       VALUES ($1, 'chess.com', $2, $3, $4, 0)`,
      [userId, username, '', new Date(Date.now() + 10 * 60 * 1000)]
    );

    // Set content-type explicitly
    res.setHeader("Content-Type", "text/html; charset=utf-8");

    // Show the token verification page
    const escapedUsername = username.replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
    const html = `<!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"><title>Link Chess.com — LOBBY</title></head>
    <body style="background:#1e1f22;color:#f2f3f5;font-family:'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;box-sizing:border-box">
      <div id="card" style="background:#2b2d31;border-radius:16px;padding:36px;max-width:480px;width:100%;box-shadow:0 24px 64px rgba(0,0,0,.5)">
        <div style="text-align:center;margin-bottom:24px">
          <div style="font-size:42px;margin-bottom:12px">♟️</div>
          <div style="font-size:20px;font-weight:800">Verify Chess.com Account</div>
          <div style="font-size:13px;color:#80848e;margin-top:6px">Securely prove you own <strong style="color:#f2f3f5">${escapedUsername}</strong></div>
        </div>

        <div style="background:#1e1f22;border-radius:10px;padding:16px;margin-bottom:20px">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#80848e;margin-bottom:10px">Step 1 — Create a personal access token</div>
          <div style="font-size:13px;color:#b5bac1;line-height:1.6">
            1. Go to <a href="https://www.chess.com/settings/security" target="_blank" style="color:#5865f2;text-decoration:none;font-weight:600">chess.com/settings/security ↗</a><br>
            2. Scroll to <strong style="color:#f2f3f5">"Personal Access Tokens"</strong><br>
            3. Click <strong style="color:#f2f3f5">"Generate Token"</strong><br>
            4. Give it any name (e.g., "LOBBY Verification")<br>
            5. Select only <strong style="color:#f2f3f5">"Read-only"</strong> scope<br>
            6. Copy the token (you'll only see it once)
          </div>
        </div>

        <div style="background:#1e1f22;border-radius:10px;padding:16px;margin-bottom:20px">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#80848e;margin-bottom:10px">Step 2 — Paste your token here</div>
          <input id="tokenInput" type="password" placeholder="Paste your Chess.com personal access token here" 
            style="width:100%;padding:12px 14px;background:#313338;color:#f2f3f5;border:1px solid rgba(255,255,255,.1);border-radius:8px;font-size:13px;font-family:monospace;box-sizing:border-box;margin-bottom:8px"
          />
          <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#b5bac1;cursor:pointer">
            <input id="showTokenCheckbox" type="checkbox" onchange="document.getElementById('tokenInput').type = this.checked ? 'text' : 'password'" style="cursor:pointer">
            Show token
          </label>
        </div>

        <div id="status" style="font-size:13px;min-height:20px;margin-bottom:14px;text-align:center"></div>

        <button id="verifyBtn" onclick="verify()"
          style="width:100%;padding:13px;background:#5865f2;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit;transition:background .15s"
          onmouseover="this.style.background='#4752c4'" onmouseout="this.style.background='#5865f2'">
          Verify & Link
        </button>
        <button onclick="window.close()"
          style="width:100%;padding:10px;background:transparent;color:#80848e;border:1px solid rgba(255,255,255,.1);border-radius:8px;font-size:13px;cursor:pointer;font-family:inherit;margin-top:8px">
          Cancel
        </button>
        <div style="font-size:11px;color:#80848e;text-align:center;margin-top:12px">⚠️ <strong>Don't worry:</strong> We only use the token to verify you own the account, then you can delete it from your Chess.com settings immediately.</div>
      </div>

      <script>
        async function verify() {
          const btn = document.getElementById('verifyBtn');
          const status = document.getElementById('status');
          const token = document.getElementById('tokenInput').value?.trim();

          if (!token) {
            status.style.color = '#ed4245';
            status.textContent = 'Please paste your token first.';
            return;
          }

          btn.disabled = true;
          btn.textContent = 'Verifying token…';
          btn.style.opacity = '0.6';
          status.textContent = '';

          try {
            const res = await fetch(window.location.origin + '/chess/callback/chesscom', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ userId: ${userId}, token: token })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Verification failed');

            document.getElementById('card').innerHTML = \`
              <div style="text-align:center">
                <div style="font-size:48px;margin-bottom:16px">✅</div>
                <div style="font-size:18px;font-weight:700">Linked as \${data.username}</div>
                <div style="font-size:13px;color:#80848e;margin-top:8px">You can now delete the token from your Chess.com settings.</div>
                <div style="font-size:12px;color:#80848e;margin-top:4px">This window will close automatically.</div>
              </div>
            \`;
            try { window.opener?.postMessage({ type:'chess-linked', platform:'chess.com', username:data.username }, '*'); } catch(e) {}
            setTimeout(() => { try { window.close(); } catch(e) {} }, 2500);
          } catch(e) {
            status.style.color = '#ed4245';
            status.textContent = e.message;
            btn.disabled = false;
            btn.textContent = 'Retry';
            btn.style.opacity = '1';
          }
        }
      </script>
    </body></html>`;

    res.send(html);

  } catch (err) {
    console.error("[/chess/auth error]", err);
    res.status(500).send(`<html><body style="background:#1e1f22;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
      <div style="text-align:center">
        <div style="font-size:48px">❌</div>
        <div style="margin-top:12px">Server error: ${err.message}</div>
        <div style="font-size:12px;color:#80848e;margin-top:8px">Close this window and try again</div>
      </div>
      <script>setTimeout(() => window.close(), 5000);</script>
    </body></html>`);
  }
});

// ── Lichess OAuth callback — Lichess redirects here after user logs in ──
app.get("/chess/callback/lichess", async (req, res) => {
  const { code, state, userId } = req.query;

  if (!code || !userId) {
    return res.send(`<html><body style="background:#1e1f22;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
      <div style="text-align:center"><div style="font-size:48px">❌</div><div style="margin-top:12px">Missing authorization code</div></div>
      <script>setTimeout(() => window.close(), 3000);</script>
    </body></html>`);
  }

  try {
    // Retrieve stored PKCE verifier
    const verRow = await pool.query(
      "SELECT * FROM chess_verifications WHERE user_id = $1 AND platform = 'lichess'",
      [userId]
    );
    if (!verRow.rows.length) throw new Error("No pending verification found");

    const stored = JSON.parse(verRow.rows[0].verification_code);
    if (stored.state !== state) throw new Error("State mismatch — possible CSRF");

    // Exchange authorization code for access token
    const axios = require("axios");
    const redirectUri = `https://lobby-auth-server.onrender.com/chess/callback/lichess?userId=${userId}`;

    const tokenRes = await axios.post("https://lichess.org/api/token", new URLSearchParams({
      grant_type: "authorization_code",
      code: code,
      redirect_uri: redirectUri,
      client_id: "lobby-app",
      code_verifier: stored.codeVerifier,
    }).toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    });

    const accessToken = tokenRes.data?.access_token;
    if (!accessToken) throw new Error("No access token received from Lichess");

    // Fetch the authenticated user's profile — this gives us their VERIFIED username
    const profileRes = await axios.get("https://lichess.org/api/account", {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    const lichessUsername = profileRes.data?.username;
    if (!lichessUsername) throw new Error("Could not read Lichess username");

    // Revoke the token immediately — we only needed it to confirm identity
    await axios.delete("https://lichess.org/api/token", {
      headers: { Authorization: `Bearer ${accessToken}` }
    }).catch(() => {}); // Non-critical if revocation fails

    // Save verified username to database
    await pool.query(
      "UPDATE users SET lichess_username = $1 WHERE id = $2",
      [lichessUsername, userId]
    );

    // Clean up verification record
    await pool.query("DELETE FROM chess_verifications WHERE user_id = $1 AND platform = 'lichess'", [userId]);

    console.log(`[chess/lichess] ✅ OAuth-verified and linked "${lichessUsername}" to userId ${userId}`);

    res.send(`
      <html><body style="background:#1e1f22;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
        <div style="text-align:center">
          <div style="font-size:48px;margin-bottom:16px">✅</div>
          <div style="font-size:18px;font-weight:700">Linked as ${lichessUsername}</div>
          <div style="font-size:13px;color:#80848e;margin-top:8px">You can close this window and return to LOBBY</div>
        </div>
        <script>
          try { window.opener?.postMessage({type:'chess-linked',platform:'lichess',username:${JSON.stringify(lichessUsername)}},'*'); } catch(e){}
          setTimeout(() => { try { window.close(); } catch(e){} }, 2500);
        </script>
      </body></html>
    `);
  } catch (err) {
    console.error("[chess/lichess callback]", err.message);
    res.send(`<html><body style="background:#1e1f22;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
      <div style="text-align:center">
        <div style="font-size:48px">❌</div>
        <div style="font-size:16px;margin-top:12px">${err.message || "Lichess verification failed"}</div>
        <div style="font-size:12px;color:#80848e;margin-top:8px">Close this window and try again</div>
      </div>
      <script>setTimeout(() => window.close(), 5000);</script>
    </body></html>`);
  }
});

// ── Chess.com personal access token verification callback ──
app.post("/chess/callback/chesscom", async (req, res) => {
  const { userId, token } = req.body;
  if (!userId || !token) return res.status(400).json({ error: "Missing userId or token" });

  try {
    // Get pending verification
    const verRow = await pool.query(
      "SELECT * FROM chess_verifications WHERE user_id = $1 AND platform = 'chess.com'",
      [userId]
    );
    if (!verRow.rows.length) return res.status(400).json({ error: "No pending verification — start again" });

    const verification = verRow.rows[0];
    const chessUsername = verification.username;

    // Check expiry
    if (new Date() > new Date(verification.code_expires_at)) {
      await pool.query("DELETE FROM chess_verifications WHERE id = $1", [verification.id]);
      return res.status(400).json({ error: "Verification expired — close this window and try again" });
    }

    // Check brute force
    if (verification.attempts >= 5) {
      return res.status(429).json({ error: "Too many attempts — close this window and try again" });
    }

    // Increment attempts
    await pool.query("UPDATE chess_verifications SET attempts = attempts + 1 WHERE id = $1", [verification.id]);

    // Verify the token by making an authenticated request to Chess.com API
    const axios = require("axios");
    try {
      // Use the token as a Bearer token to access protected endpoints
      const meRes = await axios.get("https://api.chess.com/pub/user", {
        headers: {
          "Authorization": `Bearer ${token}`,
          "User-Agent": "LOBBY-App/1.0"
        }
      });

      const authenticatedUsername = meRes.data?.username;
      if (!authenticatedUsername) {
        return res.status(401).json({ error: "Token verification failed — invalid token or no user data" });
      }

      // Verify the token is for the correct account (case-insensitive)
      if (authenticatedUsername.toLowerCase() !== chessUsername.toLowerCase()) {
        return res.status(403).json({
          error: `Token is for account "${authenticatedUsername}", but you're trying to link "${chessUsername}". Use the correct account's token.`
        });
      }

      // Token verified! Save to database
      await pool.query(
        "UPDATE users SET chess_username = $1 WHERE id = $2",
        [authenticatedUsername, userId]
      );

      // Clean up verification record
      await pool.query("DELETE FROM chess_verifications WHERE id = $1", [verification.id]);

      console.log(`[chess/chesscom] ✅ Token-verified and linked "${authenticatedUsername}" to userId ${userId}`);

      res.json({
        success: true,
        platform: "chess.com",
        username: authenticatedUsername,
        message: "Chess.com account verified and linked"
      });

    } catch (tokenErr) {
      // Token is invalid or expired
      const isUnauth = tokenErr.response?.status === 401 || tokenErr.response?.status === 403;
      return res.status(isUnauth ? 401 : 500).json({
        error: isUnauth
          ? "Invalid or expired token — generate a new one from chess.com/settings/security"
          : "Could not verify token — try again"
      });
    }

  } catch (err) {
    console.error("[chess/chesscom callback]", err.message);
    res.status(500).json({ error: "Verification failed — try again" });
  }
});

// DELETE /chess/unlink — remove chess account from profile
app.delete("/chess/unlink", requireAuth, async (req, res) => {
  const { platform } = req.body;

  if (!platform) {
    return res.status(400).json({ error: "platform required" });
  }

  try {
    if (platform === "lichess") {
      await pool.query("UPDATE users SET lichess_username = NULL WHERE id = $1", [req.userId]);
    } else {
      await pool.query("UPDATE users SET chess_username = NULL WHERE id = $1", [req.userId]);
    }

    // Clean up any leftover verification records
    await pool.query(
      "DELETE FROM chess_verifications WHERE user_id = $1 AND platform = $2",
      [req.userId, platform]
    ).catch(() => {});

    console.log(`[chess/unlink] Unlinked ${platform} from userId ${req.userId}`);
    res.json({ success: true, message: `${platform} account unlinked` });
  } catch (err) {
    console.error("[chess/unlink]", err);
    res.status(500).json({ error: "Failed to unlink account" });
  }
});

// ── Keep old DELETE route as alias for backwards compatibility ──
app.delete("/link-chess", requireAuth, async (req, res) => {
  const { platform } = req.body;
  if (!platform) return res.status(400).json({ error: "platform required" });
  try {
    if (platform === "lichess") {
      await pool.query("UPDATE users SET lichess_username = NULL WHERE id = $1", [req.userId]);
    } else {
      await pool.query("UPDATE users SET chess_username = NULL WHERE id = $1", [req.userId]);
    }
    await pool.query("DELETE FROM chess_verifications WHERE user_id = $1 AND platform = $2", [req.userId, platform]).catch(() => {});
    res.json({ success: true, message: `${platform} account unlinked` });
  } catch (err) {
    res.status(500).json({ error: "Failed to unlink account" });
  }
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
    const avatarUrl = await uploadToCloudinary(req.file.buffer, "avatars", `user_${req.userId}`);
    await pool.query("UPDATE users SET avatar_url = $1 WHERE id = $2", [avatarUrl, req.userId]);
    res.json({ avatarUrl });
  });
});

const bannerUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /image\//.test(file.mimetype))
});

app.post("/banner", requireAuth, (req, res) => {
  bannerUpload.single("banner")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const bannerUrl = await uploadToCloudinary(req.file.buffer, "banners", `banner_${req.userId}`);
    await pool.query("UPDATE users SET banner_url = $1 WHERE id = $2", [bannerUrl, req.userId]);
    res.json({ bannerUrl });
  });
});

// ── App wallpaper upload ─────────────────────────────────────────
const wallpaperUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /image\//.test(file.mimetype))
});

app.post("/wallpaper", requireAuth, (req, res) => {
  wallpaperUpload.single("wallpaper")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    try {
      const wallpaperUrl = await uploadToCloudinary(req.file.buffer, "wallpapers", `wp_${req.userId}`);
      // Uploading a new custom image implicitly clears preset/use_cover
      await pool.query(
        `UPDATE users SET wallpaper_url = $1, wallpaper_preset = NULL, wallpaper_use_cover = FALSE WHERE id = $2`,
        [wallpaperUrl, req.userId]
      );
      res.json({ wallpaperUrl });
    } catch (e) {
      console.error("[POST /wallpaper]", e.message);
      res.status(500).json({ error: "Wallpaper upload failed: " + e.message });
    }
  });
});

// Update wallpaper settings (preset, toggles, sliders, or clear)
app.patch("/wallpaper", requireAuth, async (req, res) => {
  try {
    const {
      wallpaperUrl,
      wallpaperPreset,
      wallpaperUseCover,
      wallpaperBlur,
      wallpaperDim,
      wallpaperSolidSidebars
    } = req.body || {};

    // Clamp slider values
    const blur = Number.isFinite(+wallpaperBlur) ? Math.max(0, Math.min(80, +wallpaperBlur)) : null;
    const dim  = Number.isFinite(+wallpaperDim)  ? Math.max(0, Math.min(100, +wallpaperDim)) : null;

    // We use COALESCE-style behaviour: pass explicit `null` to clear a field,
    // pass `undefined` / missing to leave it alone. Because the frontend
    // always sends all six, this simplifies to an unconditional write.
    await pool.query(
      `UPDATE users SET
         wallpaper_url            = $1,
         wallpaper_preset         = $2,
         wallpaper_use_cover      = $3,
         wallpaper_blur           = COALESCE($4, wallpaper_blur),
         wallpaper_dim            = COALESCE($5, wallpaper_dim),
         wallpaper_solid_sidebars = $6
       WHERE id = $7`,
      [
        wallpaperUrl ?? null,
        wallpaperPreset ?? null,
        !!wallpaperUseCover,
        blur,
        dim,
        !!wallpaperSolidSidebars,
        req.userId
      ]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("[PATCH /wallpaper]", err.message);
    res.status(500).json({ error: "Wallpaper save failed: " + err.message });
  }
});

// ── Tournament card image upload ─────────────────────────────
const tournamentCardUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /image\//.test(file.mimetype))
});

app.post("/tournament-card-image", requireAuth, (req, res) => {
  tournamentCardUpload.single("image")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    try {
      const imageUrl = await uploadToCloudinary(req.file.buffer, "tournament_cards", `tcard_${req.userId}`);
      await pool.query("UPDATE users SET tournament_card_image_url = $1 WHERE id = $2", [imageUrl, req.userId]);
      res.json({ imageUrl });
    } catch(err) { res.status(500).json({ error: err.message }); }
  });
});

// ── Tournament card settings (colours, position) ─────────────
app.patch("/tournament-card", requireAuth, async (req, res) => {
  try {
    const { bgColour, borderColour, nameColour, bgPos, clearImage } = req.body;
    if (clearImage) {
      await pool.query("UPDATE users SET tournament_card_image_url = NULL WHERE id = $1", [req.userId]);
    }
    await pool.query(
      `UPDATE users SET
        tournament_card_bg_colour      = COALESCE($1, tournament_card_bg_colour),
        tournament_card_border_colour  = COALESCE($2, tournament_card_border_colour),
        tournament_card_name_colour    = COALESCE($3, tournament_card_name_colour),
        tournament_card_bg_pos         = COALESCE($4, tournament_card_bg_pos)
       WHERE id = $5`,
      [bgColour || null, borderColour || null, nameColour || null, bgPos || null, req.userId]
    );
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.patch("/profile", requireAuth, async (req, res) => {
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
  } catch(err) { console.error("API error at line " + 211 + ":", err.message || err); res.status(500).json({ error: "Server error: " + (err.message || "unknown") }); }
});

app.get("/profile/:id", requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: "Invalid user ID" });
    const r = await pool.query(
      `SELECT u.id, u.username, u.avatar_url, u.bio, u.status, u.banner_url, u.banner_colour,
              u.display_name, u.status_emoji, u.status_text, u.location, u.website,
              u.created_at AS joined_at, u.steam_id, u.steam_name, u.steam_avatar,
              u.wallpaper_url, u.wallpaper_preset, u.wallpaper_use_cover,
              u.wallpaper_blur, u.wallpaper_dim, u.wallpaper_solid_sidebars,
              u.twitch_url, u.youtube_url, u.twitter_url, u.pinned_post_id,
              (SELECT COUNT(*) FROM follows WHERE following_id = u.id)::int          AS followers_count,
              (SELECT COUNT(*) FROM tournament_players WHERE user_id = u.id)::int    AS tournaments_played
       FROM users u WHERE u.id = $1`,
      [id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: "User not found" });
    res.json(r.rows[0]);
  } catch(err) { console.error("[GET /profile/:id]", err.message); res.status(500).json({ error: "Profile error: " + err.message }); }
});

// PUT /presence — set user's presence status (online, away, dnd, invisible)
app.put("/presence", requireAuth, async (req, res) => {
  try {
    const { status } = req.body;
    if (!["online", "away", "dnd", "invisible"].includes(status)) {
      return res.status(400).json({ error: "Invalid status. Must be: online, away, dnd, invisible" });
    }
    await pool.query("UPDATE users SET presence_status = $1 WHERE id = $2", [status, req.userId]);
    res.json({ ok: true, status });
  } catch(err) {
    console.error("[PUT /presence]", err.message);
    res.status(500).json({ error: "Failed to set presence" });
  }
});

// GET /users/:id/mutual-servers — lobbies both you and another user share
app.get("/users/:id/mutual-servers", requireAuth, async (req, res) => {
  try {
    const otherId = parseInt(req.params.id);
    if (!otherId || isNaN(otherId)) return res.status(400).json({ error: "Invalid user ID" });
    const r = await pool.query(
      `SELECT s.id, s.name, s.icon_url
       FROM servers s
       JOIN server_members sm1 ON sm1.server_id = s.id AND sm1.user_id = $1
       JOIN server_members sm2 ON sm2.server_id = s.id AND sm2.user_id = $2
       ORDER BY s.name`,
      [req.userId, otherId]
    );
    res.json(r.rows);
  } catch(err) {
    console.error("[GET /users/:id/mutual-servers]", err.message);
    res.status(500).json({ error: "Failed to fetch mutual servers" });
  }
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

// GET /users/discover — people to find on the Discover page.
//
// /users/search deliberately returns nothing for an empty query, so it
// cannot back a browse surface. This is the browse case.
//
// Nothing new is exposed: profiles are already public and already
// searchable by name. Banned accounts are excluded, and so are accounts
// with nothing on them -- no avatar, no bio, no display name -- because
// a wall of empty profiles is not discovery, it is a user dump.
//
// NOTE: there is no per-user "hide me from discovery" flag in the
// schema. post_visibility governs posts, not the profile. If people
// should be able to opt out of being browsed, that column does not
// exist yet and this endpoint cannot honour it.
app.get("/users/discover", requireAuth, async (req, res) => {
  try {
    const { limit, offset } = _page(req);
    const r = await pool.query(`
      SELECT id, username, display_name, avatar_url, bio, created_at
      FROM users
      WHERE COALESCE(is_banned, FALSE) = FALSE
        AND id <> $1
        AND (avatar_url IS NOT NULL OR bio IS NOT NULL OR display_name IS NOT NULL)
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `, [req.userId, limit, offset]);
    res.json(r.rows.map(u => ({
      id: u.id,
      username: u.username,
      display_name: u.display_name,
      avatar_url: u.avatar_url,
      bio: u.bio,
    })));
  } catch (e) {
    console.error("[users/discover]", e.message);
    res.json([]);
  }
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
  } catch(err) { console.error("API error at line " + 261 + ":", err.message || err); res.status(500).json({ error: "Server error: " + (err.message || "unknown") }); }
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
  } catch(err) { console.error("API error at line " + 294 + ":", err.message || err); res.status(500).json({ error: "Server error: " + (err.message || "unknown") }); }
});

// ── Direct Messages ──────────────────────────────────────────

// DM conversations list (for unread badges) — MUST be before /dm/:userId
app.get("/dm/conversations", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        sub.other_id,
        sub.from_user_id,
        sub.content,
        sub.created_at,
        u.username,
        u.avatar_url
      FROM (
        SELECT DISTINCT ON (other_id)
          CASE WHEN from_user_id = $1 THEN to_user_id ELSE from_user_id END AS other_id,
          from_user_id,
          content,
          created_at
        FROM direct_messages
        WHERE from_user_id = $1 OR to_user_id = $1
        ORDER BY
          CASE WHEN from_user_id = $1 THEN to_user_id ELSE from_user_id END,
          created_at DESC
      ) sub
      JOIN users u ON u.id = sub.other_id
      ORDER BY sub.created_at DESC
    `, [req.userId]);
    res.json(r.rows);
  } catch (err) {
    console.error("DM conversations error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

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

// Delete a DM. Either participant (sender or recipient) can delete.
// Frontend expects this route to exist — previously it 404'd silently and
// the message stayed in the DB even though the UI looked like it worked.
app.delete("/dm/:userId/messages/:msgId", requireAuth, async (req, res) => {
  try {
    const msgId = parseInt(req.params.msgId);
    const otherUserId = parseInt(req.params.userId);
    const msg = await pool.query(
      "SELECT from_user_id, to_user_id FROM direct_messages WHERE id = $1",
      [msgId]
    );
    if (!msg.rows[0]) return res.status(404).json({ error: "Message not found" });
    const isAdmin = (await getUserFlags(req.userId)).isAdmin;
    const row = msg.rows[0];
    const isParticipant = row.from_user_id === req.userId || row.to_user_id === req.userId;
    if (!isParticipant && !isAdmin) return res.status(403).json({ error: "Not authorised" });
    await pool.query("DELETE FROM attachments WHERE dm_id = $1", [msgId]);
    await pool.query("DELETE FROM direct_messages WHERE id = $1", [msgId]);
    res.json({ success: true, otherUserId });
  } catch (err) {
    console.error("[DELETE dm msg]", err.message);
    res.status(500).json({ error: "Server error" });
  }
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

// GET /servers/search?q= — search servers by name, tags, or name#uid
// Returns the user's own servers AND any public/discoverable servers (those with tags).
// Each result includes is_member boolean so the frontend can show Join vs Open.
app.get("/servers/search", requireAuth, async (req, res) => {
  const q = (req.query.q || "").trim().toLowerCase();
  try {
    let r;
    if (!q) {
      // No query — return all public/discoverable servers (those with tags)
      r = await pool.query(`
        SELECT s.*,
          (SELECT COUNT(*) FROM server_members WHERE server_id = s.id) AS member_count,
          EXISTS(SELECT 1 FROM server_members WHERE server_id = s.id AND user_id = $1) AS is_member
        FROM servers s
        WHERE s.tags IS NOT NULL AND s.tags::text != '[]' AND s.tags::text != '' AND s.tags::text != 'null'
        ORDER BY s.name ASC
        LIMIT 50
      `, [req.userId]);
    } else {
      // Search: return servers the user is a member of OR public servers matching the query
      // Search by name, unique_id, OR individual tag values (case-insensitive)
      r = await pool.query(`
        SELECT s.*,
          (SELECT COUNT(*) FROM server_members WHERE server_id = s.id) AS member_count,
          EXISTS(SELECT 1 FROM server_members WHERE server_id = s.id AND user_id = $1) AS is_member
        FROM servers s
        WHERE (
            LOWER(s.name) LIKE $2
            OR LOWER(s.unique_id) LIKE $2
            OR (
              s.tags IS NOT NULL AND s.tags::text != '' AND s.tags::text != 'null' AND s.tags::text != '[]'
              AND EXISTS (
                SELECT 1 FROM json_array_elements_text(s.tags::json) AS t
                WHERE LOWER(t) LIKE $2
              )
            )
          )
          AND (
            EXISTS(SELECT 1 FROM server_members WHERE server_id = s.id AND user_id = $1)
            OR (s.tags IS NOT NULL AND s.tags::text != '[]' AND s.tags::text != '' AND s.tags::text != 'null')
          )
        ORDER BY s.name ASC
        LIMIT 30
      `, [req.userId, `%${q}%`]);
    }
    const rows = r.rows.map(s => {
      if (s.tags && typeof s.tags === "string") { try { s.tags = JSON.parse(s.tags); } catch { s.tags = []; } }
      else if (!s.tags) s.tags = [];
      return s;
    });
    res.json(rows);
  } catch(e) { console.error("[/servers/search]", e); res.status(500).json({ error: "Search failed" }); }
});

app.post("/servers", requireAuth, async (req, res) => {
  const { name, description } = req.body;
  if (!name || name.trim().length < 2) return res.status(400).json({ error: "Lobby name must be at least 2 characters" });
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
  } catch(err) { console.error("API error at line " + 391 + ":", err.message || err); res.status(500).json({ error: "Server error: " + (err.message || "unknown") }); }
});

app.post("/servers/:id/icon", requireAuth, (req, res) => {
  serverIconUpload.single("icon")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const iconUrl = await uploadToCloudinary(req.file.buffer, "server_icons", `server_icon_${req.params.id}`);
    await pool.query("UPDATE servers SET icon_url = $1 WHERE id = $2 AND owner_id = $3", [iconUrl, req.params.id, req.userId]);
    res.json({ iconUrl });
  });
});

// PATCH /servers/:id — update name/description/tags/banner/icon (owner or moderator)
const serverPatchUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /image\//.test(file.mimetype))
});

app.patch("/servers/:id", requireAuth, (req, res) => {
  serverPatchUpload.fields([{ name: "banner", maxCount: 1 }, { name: "icon", maxCount: 1 }])(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const memberRow = await pool.query("SELECT role FROM server_members WHERE server_id = $1 AND user_id = $2", [req.params.id, req.userId]);
    const isAdmin = (await getUserFlags(req.userId)).isAdmin;
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
      const url = await uploadToCloudinary(req.files.banner[0].buffer, "server_banners", `server_banner_${req.params.id}`);
      updates.push(`banner_url = $${idx++}`); values.push(url);
    }
    if (req.files?.icon?.[0]) {
      const url = await uploadToCloudinary(req.files.icon[0].buffer, "server_icons", `server_icon_${req.params.id}`);
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
    const bannerUrl = await uploadToCloudinary(req.file.buffer, "server_banners", `server_banner_${req.params.id}`);
    await pool.query("UPDATE servers SET banner_url = $1 WHERE id = $2 AND owner_id = $3", [bannerUrl, req.params.id, req.userId]);
    res.json({ bannerUrl });
  });
});

// PUT /servers/:id/sidebar-order — save sidebar section order (owner/moderator only)
app.put("/servers/:id/sidebar-order", requireAuth, async (req, res) => {
  try {
    const serverId = parseInt(req.params.id);
    const { order } = req.body;

    const VALID_KEYS = ['announcements', 'text', 'voice', 'tournaments', 'events'];
    if (!Array.isArray(order) || !order.every(k => VALID_KEYS.includes(k))) {
      return res.status(400).json({ error: "Invalid section order" });
    }

    // Verify caller is owner or moderator
    const memberResult = await pool.query(
      "SELECT role FROM server_members WHERE server_id = $1 AND user_id = $2",
      [serverId, req.userId]
    );
    const role = memberResult.rows[0]?.role;
    if (role !== 'owner' && role !== 'moderator') {
      return res.status(403).json({ error: "Only owners and moderators can reorder sections" });
    }

    await pool.query(
      "UPDATE servers SET sidebar_section_order = $1 WHERE id = $2",
      [JSON.stringify(order), serverId]
    );

    res.json({ success: true, order });
  } catch (error) {
    console.error("[servers/sidebar-order error]", error);
    res.status(500).json({ error: "Failed to save section order" });
  }
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
    if (!serverRow.rows[0]) return res.status(404).json({ error: "Lobby not found" });

    let tags = [];
    try { tags = JSON.parse(serverRow.rows[0].tags || "[]"); } catch {}
    const isPublic = Array.isArray(tags) && tags.length > 0;

    if (!isPublic) {
      return res.status(403).json({ error: "This lobby is private. You need an invite to join." });
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
  if (!server) return res.status(404).json({ error: "Lobby not found" });
  const isAdmin = (await getUserFlags(req.userId)).isAdmin;
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
    if (!membership.rows.length) return res.status(403).json({ error: "You are not in this lobby" });

    // Don't invite someone already in the server
    const already = await pool.query(
      "SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2",
      [req.params.id, userId]
    );
    if (already.rows.length) return res.status(409).json({ error: "User is already in this lobby" });

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
    if (targetRole === "owner") return res.status(403).json({ error: "Cannot remove the lobby owner" });
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
  // Includes each member's personalised tournament ("match") card so the
  // lobby member list can render it. Same shape and defaults as the
  // tournamentCard object built in backend/tournaments.js.
  const r = await pool.query(`
    SELECT u.id, u.username, u.avatar_url, sm.role,
           u.tournament_card_image_url, u.tournament_card_bg_colour,
           u.tournament_card_border_colour, u.tournament_card_name_colour,
           u.tournament_card_bg_pos
    FROM server_members sm
    JOIN users u ON u.id = sm.user_id
    WHERE sm.server_id = $1
    ORDER BY CASE sm.role WHEN 'owner' THEN 0 WHEN 'moderator' THEN 1 ELSE 2 END, u.username
  `, [req.params.id]);
  res.json(r.rows.map(u => ({
    id: u.id,
    username: u.username,
    avatar_url: u.avatar_url,
    role: u.role,
    tournamentCard: {
      imageUrl:     u.tournament_card_image_url     || null,
      bgColour:     u.tournament_card_bg_colour     || '#2c3440',
      borderColour: u.tournament_card_border_colour || '#f9a8d4',
      nameColour:   u.tournament_card_name_colour   || '#fdf2f8',
      bgPos:        u.tournament_card_bg_pos        || '50% 50%'
    }
  })));
});

// ══════════════════════════════════════════════════════════════════
// GET /servers/:id/activity — what everyone in this lobby is doing NOW.
//
// Provider registry: each entry takes the lobby's members and returns
// activity rows. Adding a source later (Discord, Spotify, SoundCloud,
// Xbox) means appending one function here — nothing else changes, and
// the client renders whatever comes back.
//
// Every provider must:
//   * be BULK where the upstream allows it (one request per lobby, not
//     one per member) — this is polled, so per-member fans out badly
//   * never throw; a provider that fails returns [] and the rest survive
//
// Row shape (stable contract with the client):
//   { userId, username, avatar_url, provider, kind, title, detail, artUrl }
//   kind: 'playing' | 'listening' | 'watching'
// ══════════════════════════════════════════════════════════════════

const _activityCache = new Map();      // serverId -> { ts, data }
const ACTIVITY_TTL = 45000;

// ── Steam ── live only: gameextrainfo is present ONLY while in a game.
// (GetRecentlyPlayedGames is a two-week history and cannot answer this.)
async function _actSteam(members) {
  if (!STEAM_KEY) return [];
  const withSteam = members.filter(m => m.steam_id).slice(0, 100);
  if (!withSteam.length) return [];
  const ids = withSteam.map(m => m.steam_id).join(",");
  const r = await fetch(
    `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_KEY}&steamids=${ids}`
  );
  const d = await r.json();
  const by = {};
  (d?.response?.players || []).forEach(p => { by[p.steamid] = p; });
  return withSteam.map(m => {
    const p = by[m.steam_id];
    if (!p || !p.gameextrainfo) return null;
    return {
      userId: m.id, username: m.username, avatar_url: m.avatar_url,
      provider: "steam", kind: "playing",
      title: p.gameextrainfo,
      detail: null,
      artUrl: p.gameid
        ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${p.gameid}/capsule_sm_120.jpg`
        : null
    };
  }).filter(Boolean);
}

// ── Lichess ── /api/users/status is bulk (100 ids) and needs no key.
// `playing: true` means they are in a game right now.
async function _actLichess(members) {
  const withL = members.filter(m => m.lichess_username).slice(0, 100);
  if (!withL.length) return [];
  const ids = withL.map(m => m.lichess_username).join(",");
  const r = await fetch(`https://lichess.org/api/users/status?ids=${encodeURIComponent(ids)}`);
  const rows = await r.json();
  const by = {};
  (Array.isArray(rows) ? rows : []).forEach(u => {
    if (u && u.id) by[String(u.id).toLowerCase()] = u;
  });
  return withL.map(m => {
    const u = by[String(m.lichess_username).toLowerCase()];
    if (!u || !u.playing) return null;
    return {
      userId: m.id, username: m.username, avatar_url: m.avatar_url,
      provider: "lichess", kind: "playing",
      title: "Lichess", detail: "In a game", artUrl: null
    };
  }).filter(Boolean);
}

// ── Chess.com ── deliberately inert. Chess.com's public API exposes
// `last_online` but no "in a game right now" endpoint, so reporting
// activity from it would be a guess. Left wired so it starts working the
// moment a real source exists.
async function _actChessCom(/* members */) { return []; }

const ACTIVITY_PROVIDERS = [_actSteam, _actLichess, _actChessCom];

app.get("/servers/:id/activity", requireAuth, async (req, res) => {
  const serverId = String(req.params.id);
  const hit = _activityCache.get(serverId);
  if (hit && (Date.now() - hit.ts) < ACTIVITY_TTL) return res.json(hit.data);

  try {
    const r = await pool.query(
      `SELECT u.id, u.username, u.avatar_url,
              u.steam_id, u.lichess_username, u.chess_username
         FROM server_members sm
         JOIN users u ON u.id = sm.user_id
        WHERE sm.server_id = $1`,
      [serverId]
    );
    const members = r.rows;
    if (!members.length) {
      _activityCache.set(serverId, { ts: Date.now(), data: [] });
      return res.json([]);
    }

    // One failing provider must not take the others down with it.
    const settled = await Promise.all(
      ACTIVITY_PROVIDERS.map(fn =>
        fn(members).catch(e => {
          console.warn("[activity] provider failed:", e.message);
          return [];
        })
      )
    );
    const data = settled.flat();
    _activityCache.set(serverId, { ts: Date.now(), data });
    res.json(data);
  } catch (err) {
    console.error("[GET /servers/:id/activity]", err.message);
    res.json([]);              // never break the header over an API hiccup
  }
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
  try {
    const r = await pool.query(`
      SELECT m.id, m.channel_id, m.content, m.created_at, m.user_id,
        u.username, u.avatar_url,
        COALESCE(json_agg(a.*) FILTER (WHERE a.id IS NOT NULL), '[]') AS attachments
      FROM messages m
      JOIN users u ON u.id = m.user_id
      LEFT JOIN attachments a ON a.message_id = m.id
      WHERE m.channel_id = $1
      GROUP BY m.id, m.channel_id, m.content, m.created_at, m.user_id, u.username, u.avatar_url
      ORDER BY m.created_at ASC
      LIMIT 100
    `, [req.params.id]);
    res.json(r.rows);
  } catch (err) {
    console.error("[channel messages error]", err.message);
    res.status(500).json({ error: "Failed to load messages" });
  }
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
  const isAdmin = (await getUserFlags(req.userId)).isAdmin;
  if (r.rows[0]?.user_id !== req.userId && !isAdmin) return res.status(403).json({ error: "Not authorised" });
  await pool.query("DELETE FROM attachments WHERE message_id = $1", [req.params.messageId]);
  await pool.query("DELETE FROM messages WHERE id = $1", [req.params.messageId]);
  res.json({ success: true });
});

// ── Attachments ──────────────────────────────────────────────

app.post("/upload", requireAuth, (req, res) => {
  attachmentUpload.single("file")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file" });
    const resType = /^video\//.test(req.file.mimetype) ? "video" : (/^audio\//.test(req.file.mimetype) ? "video" : "auto");
    const url = await uploadToCloudinary(req.file.buffer, "uploads", `msg_${Date.now()}`, resType);
    res.json({
      url,
      filename:  req.file.originalname,
      mimeType:  req.file.mimetype,
      sizeBytes: req.file.size
    });
  });
});

app.post("/attachments", requireAuth, async (req, res) => {
  try {
    const { messageId, dmId, groupMsgId, url, filename, mimeType, sizeBytes } = req.body;
    if (!url) return res.status(400).json({ error: "Missing url" });
    // Write to both `url` and legacy `file_url` so the INSERT works on both
    // the current schema and on older databases that still have a NOT NULL
    // file_url column. The DB migration in db.js drops that NOT NULL, but
    // populating both keeps us safe during rollout.
    const r = await pool.query(
      "INSERT INTO attachments (message_id, dm_id, group_msg_id, url, file_url, filename, mime_type, size_bytes) VALUES ($1,$2,$3,$4,$4,$5,$6,$7) RETURNING *",
      [messageId || null, dmId || null, groupMsgId || null, url, filename || null, mimeType || null, sizeBytes || null]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error("[attachments insert] failed:", err.message, err.code);
    res.status(500).json({ error: err.message || "attachments insert failed" });
  }
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
  invalidateUserFlags(parseInt(req.params.id));
  res.json({ success: true });
});

// GET /admin/profanity-words — list all words
app.get("/admin/profanity-words", requireAuth, requireOverlord, async (req, res) => {
  try {
    const r = await pool.query("SELECT id, word, created_at FROM profanity_words ORDER BY word ASC");
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: "Server error" }); }
});

// POST /admin/profanity-words — add a word
app.post("/admin/profanity-words", requireAuth, requireOverlord, async (req, res) => {
  const { word } = req.body;
  if (!word || !word.trim()) return res.status(400).json({ error: "Word required" });
  try {
    const r = await pool.query(
      "INSERT INTO profanity_words (word, added_by) VALUES ($1, $2) ON CONFLICT (word) DO NOTHING RETURNING *",
      [word.trim().toLowerCase(), req.userId]
    );
    res.json(r.rows[0] || { message: "Word already exists" });
  } catch(e) { res.status(500).json({ error: "Server error" }); }
});

// DELETE /admin/profanity-words/:word — remove a word
app.delete("/admin/profanity-words/:word", requireAuth, requireOverlord, async (req, res) => {
  try {
    await pool.query("DELETE FROM profanity_words WHERE word = $1", [req.params.word.toLowerCase()]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: "Server error" }); }
});

// GET /admin/servers?page=1 — list all servers (25 per page)
app.get("/admin/servers", requireAuth, requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 25;
    const offset = (page - 1) * limit;
    const r = await pool.query(
      `SELECT s.id, s.name, s.icon_url, s.created_at, u.username as owner_name,
              (SELECT COUNT(*) FROM server_members sm WHERE sm.server_id = s.id) as member_count
       FROM servers s LEFT JOIN users u ON s.owner_id = u.id
       ORDER BY s.created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    const total = await pool.query("SELECT COUNT(*) FROM servers");
    res.json({ servers: r.rows, total: parseInt(total.rows[0].count), page, limit });
  } catch(e) { res.status(500).json({ error: "Server error" }); }
});

// POST /admin/announcements — create announcement (broadcasts to users via WS is handled client-side)
app.post("/admin/announcements", requireAuth, requireAdmin, async (req, res) => {
  const { title, body, link, serverId } = req.body;
  if (!title?.trim() || !body?.trim()) return res.status(400).json({ error: "Title and body required" });
  try {
    const r = await pool.query(
      "INSERT INTO announcements (title, body, link, server_id, sent_by) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [title.trim(), body.trim(), link?.trim() || null, serverId || null, req.userId]
    );
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: "Server error" }); }
});

// GET /admin/announcements — get history (most recent 50)
app.get("/admin/announcements", requireAuth, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT a.*, u.username as sent_by_name, s.name as server_name
       FROM announcements a
       LEFT JOIN users u ON a.sent_by = u.id
       LEFT JOIN servers s ON a.server_id = s.id
       ORDER BY a.created_at DESC LIMIT 50`
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: "Server error" }); }
});

// GET /announcements/recent — get recent announcements for notification panel (all users)
app.get("/announcements/recent", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT a.id, a.title, a.body, a.link, a.created_at, u.username as sent_by_name, s.name as server_name
       FROM announcements a
       LEFT JOIN users u ON a.sent_by = u.id
       LEFT JOIN servers s ON a.server_id = s.id
       WHERE a.server_id IS NULL OR a.server_id IN (
         SELECT server_id FROM server_members WHERE user_id = $1
       )
       ORDER BY a.created_at DESC LIMIT 10`,
      [req.userId]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: "Server error" }); }
});

// PATCH /admin/users/:id/overlord — grant/revoke overlord (overlord only)
app.patch("/admin/users/:id/overlord", requireAuth, requireOverlord, async (req, res) => {
  const { grant } = req.body; // true or false
  try {
    await pool.query("UPDATE users SET is_overlord = $1 WHERE id = $2", [!!grant, req.params.id]);
    invalidateUserFlags(parseInt(req.params.id));
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: "Server error" }); }
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
    // Batch insert all members in a single query instead of N sequential inserts
    const memberValues = allIds.map((uid, i) => `($1, $${i + 2})`).join(", ");
    await pool.query(
      `INSERT INTO group_members (group_id, user_id) VALUES ${memberValues} ON CONFLICT DO NOTHING`,
      [group.id, ...allIds]
    );
    res.json(group);
  } catch(err) { console.error("API error at line " + 801 + ":", err.message || err); res.status(500).json({ error: "Server error: " + (err.message || "unknown") }); }
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
  } catch(err) { console.error("API error at line " + 825 + ":", err.message || err); res.status(500).json({ error: "Server error: " + (err.message || "unknown") }); }
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

app.delete("/groups/:id/messages/:msgId", requireAuth, async (req, res) => {
  try {
    // Allow message author or group owner to delete
    const msg = await pool.query("SELECT user_id FROM group_messages WHERE id = $1 AND group_id = $2", [req.params.msgId, req.params.id]);
    if (!msg.rows[0]) return res.status(404).json({ error: "Message not found" });
    const group = await pool.query("SELECT owner_id FROM group_chats WHERE id = $1", [req.params.id]);
    if (msg.rows[0].user_id !== req.userId && group.rows[0]?.owner_id !== req.userId) {
      return res.status(403).json({ error: "Not authorized" });
    }
    await pool.query("DELETE FROM attachments WHERE group_msg_id = $1", [req.params.msgId]);
    await pool.query("DELETE FROM group_messages WHERE id = $1", [req.params.msgId]);
    res.json({ success: true });
  } catch(err) { console.error("[DELETE group msg]", err.message); res.status(500).json({ error: "Server error" }); }
});

// ── Social Feed ──────────────────────────────────────────────

const postImageUpload = multer({
  storage: multer.memoryStorage(),
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
      (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) AS comment_count,
      (SELECT COALESCE(json_agg(json_build_object('emoji', sub.emoji, 'count', sub.cnt)), '[]'::json) FROM (SELECT emoji, COUNT(*)::int AS cnt FROM post_reactions WHERE post_id = p.id GROUP BY emoji ORDER BY cnt DESC) sub) AS reactions,
      (SELECT emoji FROM post_reactions WHERE post_id = p.id AND user_id = $1) AS my_reaction,
      (SELECT COUNT(*) FROM post_reactions WHERE post_id = p.id) AS reaction_count
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
    const imageUrl = req.file ? await uploadToCloudinary(req.file.buffer, "posts", `post_${Date.now()}`) : null;
    const r = await pool.query(
      "INSERT INTO posts (user_id, content, image_url, visibility, community_tags) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [req.userId, content, imageUrl, visibility, JSON.stringify(communityTags)]
    );
    res.json(r.rows[0]);
  });
});

// GET /posts/:id — fetch a single post by ID (for pinned post display)
app.get("/posts/:id", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT p.*, u.username, u.display_name, u.avatar_url
       FROM posts p JOIN users u ON u.id = p.user_id
       WHERE p.id = $1`,
      [req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: "Post not found" });
    res.json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete("/posts/:id", requireAuth, async (req, res) => {
  const r = await pool.query("SELECT user_id FROM posts WHERE id = $1", [req.params.id]);
  const isAdmin = (await getUserFlags(req.userId)).isAdmin;
  if (r.rows[0]?.user_id !== req.userId && !isAdmin) return res.status(403).json({ error: "Not authorised" });
  await pool.query("DELETE FROM posts WHERE id = $1", [req.params.id]);
  res.json({ success: true });
});

// Toggle a reaction on a post (send same emoji again to remove it)
app.post("/posts/:id/react", requireAuth, async (req, res) => {
  const { emoji } = req.body;
  if (!emoji) return res.status(400).json({ error: "emoji is required" });
  const postId = req.params.id;

  const existing = await pool.query(
    "SELECT id, emoji FROM post_reactions WHERE post_id=$1 AND user_id=$2",
    [postId, req.userId]
  );

  if (existing.rows.length) {
    if (existing.rows[0].emoji === emoji) {
      // Same emoji → remove reaction
      await pool.query("DELETE FROM post_reactions WHERE post_id=$1 AND user_id=$2", [postId, req.userId]);
      return res.json({ reacted: false, emoji: null });
    } else {
      // Different emoji → update reaction
      await pool.query("UPDATE post_reactions SET emoji=$1 WHERE post_id=$2 AND user_id=$3", [emoji, postId, req.userId]);
      return res.json({ reacted: true, emoji });
    }
  } else {
    // No existing reaction → insert
    await pool.query("INSERT INTO post_reactions (post_id, user_id, emoji) VALUES ($1,$2,$3)", [postId, req.userId, emoji]);

    // Auto-capture viral post into lobby timeline when it hits the threshold
    try {
      const VIRAL_THRESHOLD = 5;
      const countRow = await pool.query(
        "SELECT COUNT(*)::int AS cnt FROM post_reactions WHERE post_id=$1", [postId]
      );
      const totalReactions = countRow.rows[0]?.cnt || 0;
      if (totalReactions === VIRAL_THRESHOLD) {
        // Find which server this post belongs to (posts linked to a server via channel)
        const postRow = await pool.query(
          `SELECT p.id, p.content, p.channel_id, c.server_id
           FROM posts p
           LEFT JOIN channels c ON c.id = p.channel_id
           WHERE p.id = $1;`,
          [postId]
        );
        const post = postRow.rows[0];
        if (post?.server_id) {
          const existsRow = await pool.query(
            "SELECT 1 FROM lobby_timeline_events WHERE ref_id=$1 AND ref_type='post';", [postId]
          );
          if (!existsRow.rows.length) {
            const excerpt = (post.content || "").replace(/<[^>]+>/g, "").slice(0, 80);
            await pool.query(
              `INSERT INTO lobby_timeline_events (server_id, type, title, description, ref_id, ref_type)
               VALUES ($1, 'viral_post', $2, $3, $4, 'post');`,
              [post.server_id, `🔥 Viral Post`, excerpt || "A post blew up!", parseInt(postId)]
            );
          }
        }
      }
    } catch (captureErr) {
      console.warn("[viral capture]", captureErr.message);
    }

    return res.json({ reacted: true, emoji });
  }
});

// Toggle a reaction on a comment. Same contract as /posts/:id/react:
// the same emoji again removes it, a different emoji replaces it, and
// none yet adds it. One row per user per comment, enforced by the
// UNIQUE on the table.
app.post("/comments/:id/react", requireAuth, async (req, res) => {
  const { emoji } = req.body;
  if (!emoji) return res.status(400).json({ error: "emoji is required" });
  const commentId = req.params.id;

  try {
    const existing = await pool.query(
      "SELECT id, emoji FROM comment_reactions WHERE comment_id=$1 AND user_id=$2",
      [commentId, req.userId]
    );

    let reacted, mine;
    if (existing.rows.length) {
      if (existing.rows[0].emoji === emoji) {
        await pool.query("DELETE FROM comment_reactions WHERE comment_id=$1 AND user_id=$2", [commentId, req.userId]);
        reacted = false; mine = null;
      } else {
        await pool.query("UPDATE comment_reactions SET emoji=$1 WHERE comment_id=$2 AND user_id=$3", [emoji, commentId, req.userId]);
        reacted = true; mine = emoji;
      }
    } else {
      await pool.query("INSERT INTO comment_reactions (comment_id, user_id, emoji) VALUES ($1,$2,$3)", [commentId, req.userId, emoji]);
      reacted = true; mine = emoji;
    }

    // Hand back the fresh totals so a caller never has to re-fetch the
    // whole thread just to update the one row it changed.
    const counts = await pool.query(
      "SELECT emoji, COUNT(*)::int AS count FROM comment_reactions WHERE comment_id=$1 GROUP BY emoji ORDER BY count DESC",
      [commentId]
    );
    const total = counts.rows.reduce((a, row) => a + row.count, 0);
    res.json({ reacted, emoji: mine, reactions: counts.rows, reaction_count: total });
  } catch (e) {
    console.error("[comment-react]", e.message);
    res.status(500).json({ error: "Could not react to comment" });
  }
});

// Get reactions summary for a post
app.get("/posts/:id/reactions", requireAuth, async (req, res) => {
  const postId = req.params.id;
  const counts = await pool.query(
    "SELECT emoji, COUNT(*)::int AS count FROM post_reactions WHERE post_id=$1 GROUP BY emoji ORDER BY count DESC",
    [postId]
  );
  const mine = await pool.query(
    "SELECT emoji FROM post_reactions WHERE post_id=$1 AND user_id=$2",
    [postId, req.userId]
  );
  res.json({
    reactions: counts.rows,
    my_reaction: mine.rows[0]?.emoji || null
  });
});

app.get("/posts/:id/comments", requireAuth, async (req, res) => {
  // Reaction data per comment, the same three fields the feed already
  // returns for a post: the emoji breakdown, this viewer's own reaction,
  // and the total. The total is what "top comment" is ranked on.
  try {
    const r = await pool.query(`
      SELECT c.*, u.username, u.avatar_url,
        (SELECT COALESCE(json_agg(json_build_object('emoji', sub.emoji, 'count', sub.cnt)), '[]'::json)
           FROM (SELECT emoji, COUNT(*)::int AS cnt FROM comment_reactions
                  WHERE comment_id = c.id GROUP BY emoji ORDER BY cnt DESC) sub) AS reactions,
        (SELECT emoji FROM comment_reactions WHERE comment_id = c.id AND user_id = $2) AS my_reaction,
        (SELECT COUNT(*)::int FROM comment_reactions WHERE comment_id = c.id) AS reaction_count
      FROM post_comments c JOIN users u ON u.id = c.user_id
      WHERE c.post_id = $1 ORDER BY c.created_at ASC
    `, [req.params.id, req.userId]);
    res.json(r.rows);
  } catch (e) {
    // comment_reactions is created by initDb on boot. If a request lands
    // before that has run, serve the thread without reaction data rather
    // than failing the whole list -- comments matter more than counts.
    console.error("[comments] reaction aggregate failed, serving plain:", e.message);
    const r = await pool.query(`
      SELECT c.*, u.username, u.avatar_url
      FROM post_comments c JOIN users u ON u.id = c.user_id
      WHERE c.post_id = $1 ORDER BY c.created_at ASC
    `, [req.params.id]);
    res.json(r.rows.map(row => ({ ...row, reactions: [], my_reaction: null, reaction_count: 0 })));
  }
});

app.post("/posts/:id/comments", requireAuth, async (req, res) => {
  try {
    const { content, parent_comment_id } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: "Comment cannot be empty" });
    console.log(`[comments] POST /posts/${req.params.id}/comments by user ${req.userId}: "${content.trim().slice(0,50)}"`);
    const r = await pool.query(
      "INSERT INTO post_comments (post_id, user_id, content, parent_comment_id) VALUES ($1,$2,$3,$4) RETURNING *",
      [req.params.id, req.userId, content.trim(), parent_comment_id || null]
    );
    // Return with username + avatar for immediate render
    const full = await pool.query(
      "SELECT c.*, u.username, u.avatar_url FROM post_comments c JOIN users u ON u.id = c.user_id WHERE c.id = $1",
      [r.rows[0].id]
    );
    console.log(`[comments] Comment ${full.rows[0].id} created successfully`);
    res.json(full.rows[0]);
  } catch (err) {
    console.error(`[comments] POST error:`, err.message || err);
    res.status(500).json({ error: "Failed to create comment", detail: err.message });
  }
});

app.delete("/posts/:postId/comments/:commentId", requireAuth, async (req, res) => {
  const r = await pool.query("SELECT user_id FROM post_comments WHERE id = $1", [req.params.commentId]);
  const isAdmin = (await getUserFlags(req.userId)).isAdmin;
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
  if (isNaN(targetId)) return res.status(400).json({ error: "Invalid user ID" });
  const isSelf = targetId === req.userId;
  try {
  const r = await pool.query(`
    SELECT p.*, u.username, u.avatar_url,
      (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) AS comment_count,
      (SELECT COALESCE(json_agg(json_build_object('emoji', sub.emoji, 'count', sub.cnt)), '[]'::json) FROM (SELECT emoji, COUNT(*)::int AS cnt FROM post_reactions WHERE post_id = p.id GROUP BY emoji ORDER BY cnt DESC) sub) AS reactions,
      (SELECT emoji FROM post_reactions WHERE post_id = p.id AND user_id = $2) AS my_reaction,
      (SELECT COUNT(*) FROM post_reactions WHERE post_id = p.id) AS reaction_count
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
  } catch (err) {
    console.error("[profile posts error]", err.message);
    res.status(500).json({ error: "Failed to load posts" });
  }
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
  const { display_name, bio, status_emoji, status_text, location, website, banner_colour, twitch_url, youtube_url, twitter_url } = req.body;
  await pool.query(`
    UPDATE users SET
      display_name  = COALESCE($1, display_name),
      bio           = COALESCE($2, bio),
      status_emoji  = COALESCE($3, status_emoji),
      status_text   = COALESCE($4, status_text),
      location      = COALESCE($5, location),
      website       = COALESCE($6, website),
      banner_colour = COALESCE($7, banner_colour),
      twitch_url    = $8,
      youtube_url   = $9,
      twitter_url   = $10
    WHERE id = $11
  `, [display_name ?? null, bio ?? null, status_emoji ?? null, status_text ?? null,
      location ?? null, website ?? null, banner_colour ?? null,
      twitch_url || null, youtube_url || null, twitter_url || null, req.userId]);
  res.json({ success: true });
});

// PATCH /profile/:id/pin — pin or unpin a post
app.patch("/profile/:id/pin", requireAuth, async (req, res) => {
  if (parseInt(req.params.id) !== req.userId) return res.status(403).json({ error: "Not authorised" });
  const { post_id } = req.body;
  await pool.query("UPDATE users SET pinned_post_id = $1 WHERE id = $2", [post_id || null, req.userId]);
  res.json({ success: true });
});

// POST /profile/:id/avatar — upload avatar for profile
app.post("/profile/:id/avatar", requireAuth, (req, res) => {
  if (parseInt(req.params.id) !== req.userId) return res.status(403).json({ error: "Not authorised" });
  avatarUpload.single("avatar")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const avatarUrl = await uploadToCloudinary(req.file.buffer, "avatars", `user_${req.userId}`);
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
    const bannerUrl = await uploadToCloudinary(req.file.buffer, "banners", `banner_${req.userId}`);
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

// ── Store art ──────────────────────────────────────────────────────
// Steam moved store art to content-hashed paths:
//
//   .../store_item_assets/steam/apps/<appid>/<hash>/library_capsule.jpg
//
// The hash is a content digest, so nothing can be built from an appid,
// and every asset carries a DIFFERENT hash -- the header hash does not
// resolve the poster. Older apps still answer on the legacy unhashed
// path, which is why most of the library worked and anything published
// recently 404d on every guess.
//
// IStoreBrowseService/GetItems is the source that solves it. Unlike
// appdetails, which exposes only header_image and a 231x87 capsule, it
// returns the hash of EVERY asset including library_capsule -- the 2:3
// poster this UI is built around -- and it does so for old and new apps
// alike. Verified against a 2026 beta, a re-release, and two catalogue
// titles: all four resolve, and library_capsule_2x is a true 600x900.
//
// Cached for six hours. The call runs once per game per request and
// store art changes about never.
const STEAM_ASSET_HOST = "https://shared.akamai.steamstatic.com/store_item_assets/";
// How many recently played titles to ask Steam for.
//
// This was 10, and Steam sorts the list by playtime in the last two
// weeks. A player with eleven recent titles therefore lost the
// eleventh -- and because the tail of that list is everything with 0h
// this fortnight, what fell off was the back catalogue: exactly where
// a 100%-completed game with 2800 hours on it lives. The card simply
// stopped appearing, with nothing to indicate it had been cut.
//
// 24 because the list is inherently bounded -- it is two weeks of
// activity, not a library -- so this is a ceiling almost nobody
// reaches rather than a page size. Each title costs two more Steam
// calls for its achievement schema and progress, which is what the
// cache below is for.
const RECENT_COUNT = 24;

// Recently-played responses, briefly. Raising the count above doubled
// the fan-out per request -- 24 titles is up to 48 achievement calls --
// and the front page asks for this on every open. Two-week playtime
// does not move minute to minute, so a short TTL costs the reader
// nothing and takes the repeat loads off Steam entirely.
const _steamRecentCache = new Map();
const RECENT_TTL_MS = 3 * 60 * 1000;
function _recentCached(key) {
  const hit = _steamRecentCache.get(key);
  if (hit && Date.now() - hit.at < RECENT_TTL_MS) return hit.data;
  if (hit) _steamRecentCache.delete(key);
  return null;
}
function _recentStore(key, data) {
  _steamRecentCache.set(key, { data, at: Date.now() });
  // Bounded so a long-lived process cannot accumulate one entry per
  // account that has ever loaded the page.
  if (_steamRecentCache.size > 500) {
    const oldest = _steamRecentCache.keys().next().value;
    _steamRecentCache.delete(oldest);
  }
}

const _steamArtCache = new Map();
const STEAM_ART_TTL = 6 * 60 * 60 * 1000;

async function steamArt(appid) {
  const hit = _steamArtCache.get(appid);
  if (hit && Date.now() - hit.at < STEAM_ART_TTL) return hit.art;

  // Legacy paths. Still correct for most of the back catalogue, and the
  // floor to fall back to if Steam cannot be reached at all.
  const legacy = {
    header_img:  `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`,
    capsule_img: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/library_600x900.jpg`,
  };
  let art = null;

  try {
    const input = JSON.stringify({
      ids: [{ appid: Number(appid) }],
      context: { language: "english", country_code: "US", steam_realm: 1 },
      data_request: { include_assets: true },
    });
    const r = await fetch(
      "https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=" +
      encodeURIComponent(input)
    );
    if (r.ok) {
      const j = await r.json();
      const items = j && j.response && j.response.store_items;
      const a = items && items[0] && items[0].assets;
      if (a && a.asset_url_format) {
        // asset_url_format is "steam/apps/<id>/${FILENAME}?t=...", and each
        // filename already carries its own hash directory.
        // asset_url_format is DOCUMENTED as relative, and usually is —
        // but Steam returns it absolute for some titles, and prefixing
        // the host onto an absolute URL builds
        //   https://shared.akamai…/store_item_assets/https://cdn…
        // which resolves to nothing. Every card built from one of those
        // fires a request that fails, which is where several hundred
        // ERR_NAME_NOT_RESOLVED entries came from.
        const mk = (f) => {
          if (!f) return null;
          const path = a.asset_url_format.replace("${FILENAME}", f);
          const abs = /^https?:/i.test(path) && path.indexOf("//") === path.indexOf(":") + 1;
          return abs ? path : STEAM_ASSET_HOST + path;
        };
        // 2x first: a true 600x900 rather than the 300x450, which the
        // poster card would otherwise have to scale up.
        const poster = mk(a.library_capsule_2x || a.library_capsule || a.main_capsule);
        const header = mk(a.header_2x || a.header);
        if (poster || header) {
          art = {
            header_img:  header || legacy.header_img,
            capsule_img: poster || legacy.capsule_img,
          };
        }
      }
    }
  } catch (e) {
    console.error("[steam-art] GetItems", appid, e.message);
  }

  // appdetails knows the header hash but no library art, so it is a
  // second choice rather than the first.
  if (!art) {
    try {
      const r = await fetch(
        `https://store.steampowered.com/api/appdetails?appids=${appid}&filters=basic`
      );
      if (r.ok) {
        const j = await r.json();
        const d = j && j[appid] && j[appid].data;
        if (d && d.header_image) {
          art = { header_img: d.header_image, capsule_img: legacy.capsule_img };
        }
      }
    } catch (e) {
      console.error("[steam-art] appdetails", appid, e.message);
    }
  }

  if (!art) art = legacy;
  _steamArtCache.set(appid, { art, at: Date.now() });
  return art;
}

// GET /steam/art?appids=1,2,3 — batch art resolution for any page.
//
// The home page was not the only place building Steam URLs from an
// appid: the shared game catalogue behind Discover, Tournaments, Queue
// and Speedrun does the same, so every one of those pages has the same
// holes for recent titles. This exposes the resolver they all need.
//
// No auth: these are public store assets, and the panels that need them
// render before a token is necessarily to hand. Capped at 50 ids per
// call so one request cannot fan out into hundreds of upstream ones,
// and steamArt() is cached, so a repeated id costs nothing.
app.get("/steam/art", async (req, res) => {
  const raw = String(req.query.appids || "");
  const ids = raw.split(",")
    .map(x => x.trim())
    .filter(x => /^\d+$/.test(x))
    .slice(0, 50);
  if (!ids.length) return res.json({});

  try {
    const pairs = await Promise.all(ids.map(async (id) => {
      try { return [id, await steamArt(id)]; }
      catch (e) { return [id, null]; }
    }));
    const out = {};
    for (const [id, art] of pairs) if (art) out[id] = art;
    // Cached hard at the edge too: store art is effectively immutable.
    res.set("Cache-Control", "public, max-age=21600");
    res.json(out);
  } catch (err) {
    console.error("[steam/art]", err.message);
    res.status(500).json({ error: "Could not resolve art" });
  }
});

const _steamModesCache = new Map();
const STEAM_MODES_TTL = 24 * 60 * 60 * 1000;   // categories change ~never

// Steam publishes CATEGORIES, not a capacity. There is no player-count
// field anywhere in appdetails, so maxPlayers is parsed out of the
// description prose where a game happens to state it ("A 1-4 player
// physics based fishing simulator") and left null otherwise rather than
// guessed — most titles, CS2 included, never say.
//
// l=english matters: without it the categories come back in the store's
// own language for that title and Tekken 8 answers in Japanese, which
// no downstream string match would survive.
const PLAYER_COUNT_RE = [
  /\b(?:up to|supports?)\s+(\d{1,2})\s+players?\b/i,
  /\b\d{1,2}\s*[-–]\s*(\d{1,2})\s+player/i,
  /\b(\d{1,2})\s*[-–]?\s*player\s+(?:co-?op|multiplayer|online)/i,
];

function parseMaxPlayers(text) {
  if (!text) return null;
  const clean = String(text).replace(/<[^>]*>/g, " ");
  for (const re of PLAYER_COUNT_RE) {
    const m = clean.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n >= 2 && n <= 128) return n;
    }
  }
  return null;
}

async function steamModes(appid) {
  const hit = _steamModesCache.get(appid);
  if (hit && Date.now() - hit.at < STEAM_MODES_TTL) return hit.modes;

  let out = { modes: [], maxPlayers: null };
  try {
    const r = await fetch(
      `https://store.steampowered.com/api/appdetails?appids=${appid}&l=english`
    );
    if (r.ok) {
      const j = await r.json();
      const d = j && j[appid] && j[appid].success && j[appid].data;
      if (d) {
        const cats = Array.isArray(d.categories) ? d.categories : [];
        out.modes = cats
          .map(c => c && c.description)
          .filter(Boolean);
        out.maxPlayers =
          parseMaxPlayers(d.short_description) ||
          parseMaxPlayers(d.about_the_game) ||
          null;
      }
    }
  } catch (e) {
    console.error("[steam-modes]", appid, e.message);
  }

  _steamModesCache.set(appid, { modes: out, at: Date.now() });
  return out;
}

// GET /steam/modes?appids=1,2,3 — what a game actually supports.
//
// Sibling of /steam/art and shaped the same way: public, batched, capped
// at 50 so one call cannot fan out into hundreds of upstream lookups.
// The client uses it for the queue's PvP/PvE signifier and for filtering
// a library by how a game is actually played.
//
// It exists because neither appdetails nor SteamSpy sends an
// Access-Control-Allow-Origin header, so the browser cannot ask either
// of them directly — this is the only way the page can have this data.
app.get("/steam/modes", async (req, res) => {
  const raw = String(req.query.appids || "");
  const ids = raw.split(",")
    .map(x => x.trim())
    .filter(x => /^\d+$/.test(x))
    .slice(0, 50);
  if (!ids.length) return res.json({});

  try {
    const pairs = await Promise.all(ids.map(async (id) => {
      try { return [id, await steamModes(id)]; }
      catch (e) { return [id, null]; }
    }));
    const out = {};
    for (const [id, m] of pairs) if (m && m.modes.length) out[id] = m;
    res.set("Cache-Control", "public, max-age=86400");
    res.json(out);
  } catch (err) {
    console.error("[steam/modes]", err.message);
    res.status(500).json({ error: "Could not resolve modes" });
  }
});

const _ownedCache = new Map();
const OWNED_TTL = 30 * 60 * 1000;

// GET /steam/owned — the player's whole Steam library.
//
// /steam/recent is GetRecentlyPlayedGames: a fortnight's worth, a dozen
// titles at most. Queueing for something you own but have not touched
// lately is a different question and needs a different endpoint.
//
// Sorted by playtime and capped at 200: a library runs to hundreds of
// rows, and the ones worth queueing for are the ones with hours on them.
app.get("/steam/owned", requireAuth, async (req, res) => {
  const userRow = await pool.query("SELECT steam_id FROM users WHERE id = $1", [req.userId]);
  const steam_id = userRow.rows[0]?.steam_id;
  /* No account linked is not an empty library: the caller has to be
     able to say so instead of claiming the account owns nothing. */
  if (!steam_id) return res.json({ linked: false, games: [] });
  if (!STEAM_KEY) return res.status(503).json({ error: "Steam API key not configured" });

  const hit = _ownedCache.get(steam_id);
  if (hit && Date.now() - hit.at < OWNED_TTL) return res.json(hit.games);

  try {
    const r = await fetch(
      `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${STEAM_KEY}` +
      `&steamid=${steam_id}&include_appinfo=1&include_played_free_games=1`
    );
    const j = await r.json();
    /* A private profile answers with no games key at all; a public
       one with an empty library answers with an empty array. */
    if (!Array.isArray(j?.response?.games)){
      return res.json({ linked: true, private: true, games: [] });
    }
    const games = (j.response.games || [])
      .sort((a, b) => (b.playtime_forever || 0) - (a.playtime_forever || 0))
      .slice(0, 200)
      .map(g => ({
        appid: g.appid,
        name: g.name,
        hours_total:  Math.round((g.playtime_forever || 0) / 60),
        hours_recent: +(((g.playtime_2weeks || 0) / 60).toFixed(1)),
      }));
    _ownedCache.set(steam_id, { games, at: Date.now() });
    res.json(games);
  } catch (err) {
    console.error("[steam/owned]", err.message);
    res.status(500).json({ error: "Could not load library" });
  }
});

// GET /steam/search?q=… — find ANY game on Steam.
//
// Not the catalogue and not the player's library: the store's own index,
// so a game nobody here owns yet is still reachable. Public, like
// /steam/art — the picker renders before a token is necessarily to hand.
app.get("/steam/search", async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 80);
  if (q.length < 2) return res.json([]);
  try {
    const r = await fetch(
      `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(q)}&cc=us&l=english`
    );
    if (!r.ok) return res.json([]);
    const j = await r.json();
    const out = (j.items || [])
      .filter(it => it && it.type === "app" && it.id)
      .slice(0, 24)
      .map(it => ({ appid: it.id, name: it.name }));
    res.set("Cache-Control", "public, max-age=600");
    res.json(out);
  } catch (err) {
    console.error("[steam/search]", err.message);
    res.json([]);
  }
});

// GET /steam/recent — get recently played games + achievements for the logged-in user
app.get("/steam/recent", requireAuth, async (req, res) => {
  const userRow = await pool.query("SELECT steam_id FROM users WHERE id = $1", [req.userId]);
  const steam_id = userRow.rows[0]?.steam_id;
  if (!steam_id) return res.json([]);
  if (!STEAM_KEY) return res.status(503).json({ error: "Steam API key not configured" });

  // Keyed by steam_id, not by our user id: two accounts linked to the
  // same Steam profile have the same answer, and the profile view asks
  // this about other people.
  const cached = _recentCached(steam_id);
  if (cached) return res.json(cached);

  try {
    // Fetch recently played games
    const gamesRes = await fetch(
      `https://api.steampowered.com/IPlayerService/GetRecentlyPlayedGames/v1/?key=${STEAM_KEY}&steamid=${steam_id}&count=${RECENT_COUNT}`
    );
    const gamesData = await gamesRes.json();
    const games = gamesData?.response?.games || [];

    // Fetch achievements for all games in parallel
    const enriched = await Promise.all(games.map(async (g) => {
      let achievements = [];
      let achUnlocked = 0;   // how many this player has
      let achTotal = 0;      // how many the game has at all
      try {
          const [schemaRes, playerRes] = await Promise.all([
            fetch(`https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?key=${STEAM_KEY}&appid=${g.appid}`),
            fetch(`https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/?key=${STEAM_KEY}&steamid=${steam_id}&appid=${g.appid}`)
          ]);
          const schema = await schemaRes.json();
          const player = await playerRes.json();
          const schemaAchs = schema?.game?.availableGameStats?.achievements || [];

          // Count BEFORE slicing. The list is trimmed to five for display,
          // and the old code sliced first, so the number it reported could
          // never exceed five however many the player actually had.
          const unlockedAll = (player?.playerstats?.achievements || [])
            .filter(a => a.achieved === 1)
            .sort((a, b) => b.unlocktime - a.unlocktime);

          achUnlocked = unlockedAll.length;
          // How many the game HAS, from its schema. Needed to know when
          // someone has the full set -- a completion cannot be inferred
          // from the unlocked count alone.
          achTotal = schemaAchs.length;

          const playerAchs = unlockedAll.slice(0, 5);
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

      const art = await steamArt(g.appid);

      return {
        appid:       g.appid,
        name:        g.name,
        header_img:  art.header_img,
        capsule_img: art.capsule_img,
        hours_recent: hoursRecent,
        hours_total:  hoursTotal,
        achievements,
        achievementsUnlocked: achUnlocked,
        achievementsTotal: achTotal,
        // Only claimed when the schema actually told us the size of the
        // set. A game with no achievements must not read as 100%.
        achievementsComplete: achTotal > 0 && achUnlocked >= achTotal,
      };
    }));

    _recentStore(steam_id, enriched);
    res.json(enriched);
  } catch (err) {
    console.error("[steam/recent]", err);
    res.status(500).json({ error: "Could not reach Steam API" });
  }
});

// GET /steam/recent/:userId — get recently played games + achievements for any user
app.get("/steam/recent/:userId", requireAuth, async (req, res) => {
  const { userId } = req.params;
  const userRow = await pool.query("SELECT steam_id FROM users WHERE id = $1", [userId]);
  const steam_id = userRow.rows[0]?.steam_id;
  if (!steam_id) return res.json([]);
  if (!STEAM_KEY) return res.status(503).json({ error: "Steam API key not configured" });

  // Keyed by steam_id, not by our user id: two accounts linked to the
  // same Steam profile have the same answer, and the profile view asks
  // this about other people.
  const cached = _recentCached(steam_id);
  if (cached) return res.json(cached);

  try {
    // Fetch recently played games
    const gamesRes = await fetch(
      `https://api.steampowered.com/IPlayerService/GetRecentlyPlayedGames/v1/?key=${STEAM_KEY}&steamid=${steam_id}&count=${RECENT_COUNT}`
    );
    const gamesData = await gamesRes.json();
    const games = gamesData?.response?.games || [];

    // Fetch achievements for all games in parallel
    const enriched = await Promise.all(games.map(async (g) => {
      let achievements = [];
      let achUnlocked = 0;   // how many this player has
      let achTotal = 0;      // how many the game has at all
      try {
          const [schemaRes, playerRes] = await Promise.all([
            fetch(`https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?key=${STEAM_KEY}&appid=${g.appid}`),
            fetch(`https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/?key=${STEAM_KEY}&steamid=${steam_id}&appid=${g.appid}`)
          ]);
          const schema = await schemaRes.json();
          const player = await playerRes.json();
          const schemaAchs = schema?.game?.availableGameStats?.achievements || [];

          // Count BEFORE slicing. The list is trimmed to five for display,
          // and the old code sliced first, so the number it reported could
          // never exceed five however many the player actually had.
          const unlockedAll = (player?.playerstats?.achievements || [])
            .filter(a => a.achieved === 1)
            .sort((a, b) => b.unlocktime - a.unlocktime);

          achUnlocked = unlockedAll.length;
          // How many the game HAS, from its schema. Needed to know when
          // someone has the full set -- a completion cannot be inferred
          // from the unlocked count alone.
          achTotal = schemaAchs.length;

          const playerAchs = unlockedAll.slice(0, 5);
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

      const art = await steamArt(g.appid);

      return {
        appid:       g.appid,
        name:        g.name,
        header_img:  art.header_img,
        capsule_img: art.capsule_img,
        hours_recent: hoursRecent,
        hours_total:  hoursTotal,
        achievements,
        achievementsUnlocked: achUnlocked,
        achievementsTotal: achTotal,
        // Only claimed when the schema actually told us the size of the
        // set. A game with no achievements must not read as 100%.
        achievementsComplete: achTotal > 0 && achUnlocked >= achTotal,
      };
    }));

    _recentStore(steam_id, enriched);
    res.json(enriched);
  } catch (err) {
    console.error("[steam/recent/:userId]", err);
    res.status(500).json({ error: "Could not reach Steam API" });
  }
});
// ==================== TOURNAMENT ROUTES ====================
// Add these routes to your auth.js file (before the global error handlers section)

// Create a new tournament
app.post("/tournaments/create", requireAuth, async (req, res) => {
  const { lobbyId, name, description, format, playerCount, rules, prize, startTime, joinType } = req.body;

  /* A hub tournament belongs to the Tournaments page, not to a Lobby,
     so it has no lobbyId and must not be given one. A lobby tournament
     is unchanged and still requires it. Anything the client does not
     say is a lobby tournament, which is what every existing caller
     sends. */
  const scope = req.body.scope === "global" ? "global" : "lobby";
  const visibility = (scope === "global" && req.body.visibility === "code")
    ? "code" : "public";

  // Validate input
  if (!name || !format || !playerCount) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  if (scope === "lobby" && !lobbyId) {
    return res.status(400).json({ error: "A Lobby tournament needs a Lobby" });
  }

  const validFormats = ['single', 'double', 'round-robin'];
  const validPlayerCounts = [4, 8, 16, 32, 64, 128];
  const validJoinTypes = ['open', 'invite_only'];

  if (!validFormats.includes(format)) {
    return res.status(400).json({ error: "Invalid tournament format" });
  }

  if (!validPlayerCounts.includes(playerCount)) {
    return res.status(400).json({ error: "Invalid player count" });
  }

  const resolvedJoinType = validJoinTypes.includes(joinType) ? joinType : 'open';

  try {
    /* The cap is enforced HERE, not only in the page that opens the form.
       It had lived entirely in openCreateTournament, so posting to this
       route directly ignored it — which is how an account ends up with
       eleven active tournaments against a free tier of three. */
    const allow = await tournamentAllowance(req.userId);
    if (!allow.mayCreate) {
      return res.status(403).json({
        error: "You are hosting " + allow.active + " of " + allow.cap +
               " tournaments. Finish or cancel one, or unlock unlimited.",
        cap: allow.cap, active: allow.active,
      });
    }

    /* Minted before the insert so the unique index is the thing that
       decides, and a collision fails the request rather than silently
       handing two tournaments the same code. */
    const joinCode = visibility === "code" ? await mintTourneyCode() : null;

    const result = await pool.query(
      `INSERT INTO tournaments
        (lobby_id, host_id, name, description, format, player_count, max_players, status, rules, prize, start_time, join_type, scope, visibility, join_code)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'setup', $8, $9, $10, $11, $12, $13, $14)
      RETURNING *;`,
      [
        scope === "global" ? null : lobbyId,
        req.userId,
        name,
        description || null,
        format,
        playerCount,
        playerCount,
        rules || null,
        prize || null,
        startTime ? new Date(startTime) : null,
        resolvedJoinType,
        scope,
        visibility,
        joinCode
      ]
    );

    /* The one place the code is handed out unprompted: to the person who
       just created the tournament. After this it comes back only through
       /me/tournaments, and only to the host or someone already in. */
    res.status(201).json({
      success: true,
      joinCode: joinCode || null,
      tournament: result.rows[0]
    });
  } catch (error) {
    console.error("[tournament/create error]", error);
    res.status(500).json({ error: "Failed to create tournament" });
  }
});

// Get tournament details
// ══════════════════════════════════════════════════════════════════
// SPEEDRUNNING
//
// Reference data -- games, categories, world records -- is fetched from
// speedrun.com directly by the client, which is CORS-open, so none of
// that is proxied here. What lives here is the part speedrun.com has no
// equivalent for: Lobby submissions, scheduled attempts with RSVPs, and
// races.
//
// The hub is already honest about the gap. When /speedrun/live returns
// nothing it falls back to recently-verified runs from speedrun.com AND
// labels them as a proxy, and its counters show 0 rather than a made-up
// number. These endpoints fill the gap without touching that behaviour.
// ══════════════════════════════════════════════════════════════════

// "1:23:45.678" / "23:45" / "45.6" -> milliseconds. Returns null on
// anything unparseable rather than guessing a number, because a wrong
// time silently ranks a run in the wrong place.
function _srParseTime(txt) {
  const t = String(txt || "").trim();
  if (!t) return null;
  const m = t.match(/^(?:(\d+):)?(?:(\d+):)?(\d+)(?:[.,](\d{1,3}))?$/);
  if (!m) return null;
  const a = m[1] ? parseInt(m[1], 10) : null;
  const b = m[2] ? parseInt(m[2], 10) : null;
  const c = parseInt(m[3], 10);
  const frac = m[4] ? parseInt(m[4].padEnd(3, "0"), 10) : 0;
  let h = 0, min = 0, sec = 0;
  if (a !== null && b !== null) { h = a; min = b; sec = c; }
  else if (a !== null)          { min = a; sec = c; }
  else                          { sec = c; }
  if (min > 59 || sec > 59) return null;
  return ((h * 3600) + (min * 60) + sec) * 1000 + frac;
}

function _srFmt(ms) {
  if (ms == null) return null;
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s2 = total % 60;
  const frac = ms % 1000;
  const base = (h ? h + ":" + String(m).padStart(2, "0") : String(m)) +
               ":" + String(s2).padStart(2, "0");
  return frac ? base + "." + String(frac).padStart(3, "0") : base;
}

// GET /speedrun/server-counters — the hub stat strip.
app.get("/speedrun/server-counters", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM speedrun_attempts WHERE state = 'live') AS live,
        (SELECT COUNT(*)::int FROM speedrun_races
          WHERE created_at > NOW() - INTERVAL '1 day') AS races_today
    `);
    const row = r.rows[0] || {};
    res.json({ live: row.live || 0, racesToday: row.races_today || 0 });
  } catch (e) {
    console.error("[speedrun/server-counters]", e.message);
    res.json({ live: 0, racesToday: 0 });
  }
});

// GET /speedrun/live — attempts running right now.
app.get("/speedrun/live", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT a.*, u.username, u.avatar_url,
        (SELECT COUNT(*)::int FROM speedrun_attempt_rsvps v WHERE v.attempt_id = a.id) AS viewers
      FROM speedrun_attempts a JOIN users u ON u.id = a.user_id
      WHERE a.state = 'live'
      ORDER BY a.started_at DESC NULLS LAST LIMIT 20
    `);
    res.json(r.rows.map(x => ({
      id: x.id,
      runner: x.username,
      runnerAvatar: x.avatar_url,
      game: x.game,
      category: x.category,
      startedAt: x.started_at,
      videoUrl: x.video_url,
      viewerCount: x.viewers || 0,
      // isRecent marks the speedrun.com proxy path. These are genuinely
      // live, so it is false -- which is what removes the "showing latest
      // verified runs" banner the client puts above proxied rows.
      isRecent: false,
    })));
  } catch (e) {
    console.error("[speedrun/live]", e.message);
    res.json([]);
  }
});

// GET /speedrun/scheduled — upcoming attempts you can RSVP to.
app.get("/speedrun/scheduled", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT a.*, u.username, u.avatar_url,
        (SELECT COUNT(*)::int FROM speedrun_attempt_rsvps v WHERE v.attempt_id = a.id) AS rsvps
      FROM speedrun_attempts a JOIN users u ON u.id = a.user_id
      WHERE a.state = 'scheduled' AND (a.scheduled_for IS NULL OR a.scheduled_for > NOW())
      ORDER BY a.scheduled_for ASC NULLS LAST LIMIT 20
    `);
    res.json(r.rows.map(x => ({
      id: x.id,
      runner: x.username,
      runnerAvatar: x.avatar_url,
      game: x.game,
      category: x.category,
      scheduledFor: x.scheduled_for,
      rsvps: x.rsvps || 0,
    })));
  } catch (e) {
    console.error("[speedrun/scheduled]", e.message);
    res.json([]);
  }
});

// POST /speedrun/scheduled/:id/rsvp — toggle, so the button can undo.
app.post("/speedrun/scheduled/:id/rsvp", requireAuth, async (req, res) => {
  try {
    const had = await pool.query(
      "SELECT 1 FROM speedrun_attempt_rsvps WHERE attempt_id = $1 AND user_id = $2",
      [req.params.id, req.userId]
    );
    if (had.rows.length) {
      await pool.query(
        "DELETE FROM speedrun_attempt_rsvps WHERE attempt_id = $1 AND user_id = $2",
        [req.params.id, req.userId]
      );
    } else {
      await pool.query(`
        INSERT INTO speedrun_attempt_rsvps (attempt_id, user_id) VALUES ($1,$2)
        ON CONFLICT (attempt_id, user_id) DO NOTHING
      `, [req.params.id, req.userId]);
    }
    const c = await pool.query(
      "SELECT COUNT(*)::int AS n FROM speedrun_attempt_rsvps WHERE attempt_id = $1",
      [req.params.id]
    );
    res.json({ ok: true, going: !had.rows.length, rsvps: (c.rows[0] || {}).n || 0 });
  } catch (e) {
    console.error("[speedrun/rsvp]", e.message);
    res.status(500).json({ error: "Could not RSVP" });
  }
});

// POST /speedrun/attempts — announce a run, now or later.
app.post("/speedrun/attempts", requireAuth, async (req, res) => {
  const { game, category, scheduledFor, videoUrl, live } = req.body || {};
  if (!game) return res.status(400).json({ error: "game is required" });
  try {
    const r = await pool.query(`
      INSERT INTO speedrun_attempts (user_id, game, category, state, scheduled_for, started_at, video_url)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
    `, [
      req.userId, game, category || null,
      live ? "live" : "scheduled",
      scheduledFor || null,
      live ? new Date() : null,
      videoUrl || null,
    ]);
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) {
    console.error("[speedrun/attempts]", e.message);
    res.status(500).json({ error: "Could not create the attempt" });
  }
});

// GET /speedrun/races — { active, upcoming }, the shape the hub reads.
app.get("/speedrun/races", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT r.*, u.username AS host_name,
        (SELECT COUNT(*)::int FROM speedrun_race_entrants e WHERE e.race_id = r.id) AS runners
      FROM speedrun_races r LEFT JOIN users u ON u.id = r.host_id
      WHERE r.status IN ('live','upcoming')
      ORDER BY r.scheduled_for ASC NULLS LAST, r.created_at DESC
      LIMIT 40
    `);
    const card = x => ({
      id: x.id,
      title: x.title,
      game: x.game,
      category: x.category,
      prize: x.prize,
      status: x.status,
      runners: x.runners || 0,
      host: x.host_name || null,
      scheduledFor: x.scheduled_for,
    });
    res.json({
      active:   r.rows.filter(x => x.status === "live").map(card),
      upcoming: r.rows.filter(x => x.status === "upcoming").map(card),
    });
  } catch (e) {
    console.error("[speedrun/races]", e.message);
    res.json({ active: [], upcoming: [] });
  }
});

// POST /speedrun/races — host one. The host is entered automatically:
// a race with a host who is not running it is a scheduling mistake.
app.post("/speedrun/races", requireAuth, async (req, res) => {
  const { title, game, category, prize, scheduledFor } = req.body || {};
  if (!game)  return res.status(400).json({ error: "game is required" });
  try {
    const r = await pool.query(`
      INSERT INTO speedrun_races (host_id, title, game, category, prize, scheduled_for, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
    `, [
      req.userId,
      title || (game + " race"),
      game, category || null, prize || null,
      scheduledFor || null,
      scheduledFor ? "upcoming" : "live",
    ]);
    const race = r.rows[0];
    await pool.query(
      "INSERT INTO speedrun_race_entrants (race_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [race.id, req.userId]
    ).catch(() => {});
    res.json({ ok: true, id: race.id });
  } catch (e) {
    console.error("[speedrun/races create]", e.message);
    res.status(500).json({ error: "Could not create the race" });
  }
});

// POST /speedrun/races/:id/join
app.post("/speedrun/races/:id/join", requireAuth, async (req, res) => {
  try {
    const race = await pool.query("SELECT * FROM speedrun_races WHERE id = $1", [req.params.id]);
    if (!race.rows.length) return res.status(404).json({ error: "No such race" });
    if (["done", "cancelled"].includes(race.rows[0].status)) {
      return res.status(400).json({ error: "That race has finished" });
    }
    await pool.query(`
      INSERT INTO speedrun_race_entrants (race_id, user_id) VALUES ($1,$2)
      ON CONFLICT (race_id, user_id) DO NOTHING
    `, [req.params.id, req.userId]);
    const c = await pool.query(
      "SELECT COUNT(*)::int AS n FROM speedrun_race_entrants WHERE race_id = $1",
      [req.params.id]
    );
    res.json({ ok: true, runners: (c.rows[0] || {}).n || 0 });
  } catch (e) {
    console.error("[speedrun/races join]", e.message);
    res.status(500).json({ error: "Could not join the race" });
  }
});

// POST /speedrun/submit — a run, for review.
//
// Everything lands as pending. The client already tells the user their
// run is queued for moderation, so auto-verifying would make that copy a
// lie and would put unreviewed times on a leaderboard.
app.post("/speedrun/submit", requireAuth, async (req, res) => {
  const { game, category, time, videoUrl, notes } = req.body || {};
  if (!game || !String(game).trim()) return res.status(400).json({ error: "game is required" });
  if (!time || !String(time).trim()) return res.status(400).json({ error: "time is required" });
  const ms = _srParseTime(time);
  try {
    const r = await pool.query(`
      INSERT INTO speedrun_runs (user_id, game, category, time_text, time_ms, video_url, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
    `, [
      req.userId, String(game).trim(),
      (category && String(category).trim()) || "Any%",
      String(time).trim(), ms,
      (videoUrl && String(videoUrl).trim()) || null,
      (notes && String(notes).trim()) || null,
    ]);
    const q = await pool.query(`
      SELECT COUNT(*)::int AS n FROM speedrun_runs
      WHERE status = 'pending' AND submitted_at <= $1
    `, [r.rows[0].submitted_at]);
    res.json({
      ok: true,
      id: r.rows[0].id,
      queuePosition: (q.rows[0] || {}).n || 1,
      // Said plainly so the client never has to infer it.
      parsedTimeMs: ms,
      status: "pending",
    });
  } catch (e) {
    console.error("[speedrun/submit]", e.message);
    res.status(500).json({ error: "Could not submit the run" });
  }
});

// GET /me/speedrun/pb — your best VERIFIED run, and where it ranks.
//
// Verified only: the card says "verified <date>" beside the time, and a
// pending run shown there would be claiming a standing it has not been
// given. A run with an unparseable time is excluded from ranking rather
// than sorted arbitrarily.
app.get("/me/speedrun/pb", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT * FROM speedrun_runs
      WHERE user_id = $1 AND status = 'verified' AND time_ms IS NOT NULL
      ORDER BY time_ms ASC LIMIT 1
    `, [req.userId]);
    if (!r.rows.length) return res.json(null);
    const pb = r.rows[0];
    const rank = await pool.query(`
      SELECT COUNT(*)::int + 1 AS rank FROM speedrun_runs
      WHERE game = $1 AND category = $2 AND status = 'verified'
        AND time_ms IS NOT NULL AND time_ms < $3
    `, [pb.game, pb.category, pb.time_ms]);
    res.json({
      id: pb.id,
      game: pb.game,
      category: pb.category,
      time: pb.time_text,
      timeMs: pb.time_ms,
      videoUrl: pb.video_url,
      rank: (rank.rows[0] || {}).rank || null,
      verifiedAt: pb.verified_at,
    });
  } catch (e) {
    console.error("[me/speedrun/pb]", e.message);
    res.json(null);
  }
});

// ══════════════════════════════════════════════════════════════════
// MATCHMAKING QUEUE
//
// The client had a written contract for this and no implementation, so
// every call 404d and the search screen span forever. Built to that
// contract.
//
// WHY POLLING. The contract documents websocket pushes (queue-matched,
// queue-member-joined, ...), and the client already handles those
// messages. It cannot be done from here: the websocket lives in a
// separate process (server.js) and this service has no handle on it --
// there is not even a broadcast helper in this file. Rather than couple
// two services together for it, /queue/:id/status is authoritative and
// the client polls it, then hands the payload to the same _qOnMatched
// the socket path would have called. If the two services are ever
// merged, the push can be added without changing any of this.
//
// A SESSION IS A PARTY. People join an existing searching session
// rather than being paired off separately, so "a match" and "a group"
// are one row -- there is no window where a match exists but the group
// does not, and no reconciliation between the two.
// ══════════════════════════════════════════════════════════════════

// The tiers the client offers, in order. Distance between them is what
// "skill window" means.
// ── Playlists ────────────────────────────────────────────────────
//
// Matching was on exact game AND exact party size. With 87 games in the
// picker and sizes 2-10 that is 783 buckets two strangers have to land
// in simultaneously, which at this scale means never. The tier window
// widens with age; game and size never did, so the widening could not
// save it.
//
// A playlist is a bucket people share on purpose: a pool of games and
// one party size. Six of them instead of 783. Everyone queueing for
// fighters is in ONE pool, so two people arriving five minutes apart
// can still meet.
//
// Stored in queue_sessions.game as "pl:<id>", which needs no schema
// change -- that column is text and already holds an arbitrary game id.
// Exact-game queueing still works exactly as before for anyone who
// wants one specific title and will wait for it.
const Q_PLAYLISTS = [
  { id: "fighters", name: "Fighters", sub: "One on one, any rank", players: 2,
    games: ["tekken8","sf6","mk1","gg-strive","kof15","dbfz","naruto-storm","smash","melee"] },
  { id: "duos", name: "Shooters · Duos", sub: "Two up, any rank", players: 2,
    games: ["cs2","valorant","apex","cod-mw3","cod-bo6","fortnite","finals","r6siege","pubg"] },
  { id: "squad", name: "Shooters · Squad", sub: "Four stack", players: 4,
    games: ["apex","cod-mw3","cod-bo6","fortnite","finals","r6siege","pubg","battlefield2042","overwatch2","marvel-rivals"] },
  { id: "arena", name: "MOBA & Arena", sub: "Lanes and drafts", players: 2,
    games: ["lol","dota2","smite2","predecessor","tft","wildrift"] },
  { id: "coop", name: "Co-op & Chill", sub: "No rank, no pressure", players: 3,
    games: ["minecraft","palworld","lethal-company","deeprock","phasmophobia","valheim","enshrouded","terraria"] },
  // Deliberately last and deliberately unfiltered. It is the pool that
  // can always match, which is what makes an empty night survivable.
  { id: "any", name: "Anything goes", sub: "Any game, any rank", players: 2, games: null },
];
function _qPlaylist(id) {
  return Q_PLAYLISTS.find(p => p.id === String(id || "").toLowerCase()) || null;
}
function _qPlaylistIdOf(game) {
  const g = String(game || "");
  return g.startsWith("pl:") ? g.slice(3) : null;
}

const Q_TIERS = ["bronze","silver","gold","plat","diamond","master","pro"];
const Q_SESSION_MAX_MS = 3 * 60 * 60 * 1000;   // the UI promises 3 hours

// A short-handed table with nothing happening in it is not waiting for
// anyone -- it is abandoned. Reclaiming it at twenty minutes rather
// than three hours keeps the pool honest: every table listed is one
// somebody is actually sitting at.
//
// Only ever applied to a table that is still SHORT. A full group can
// sit in silence for an hour and still be a real group; the three-hour
// cap is the only rule that touches them.
const Q_SEARCH_IDLE_MS = 20 * 60 * 1000;

// A table code is read off a screen and typed, or said out loud and
// typed. So the alphabet drops every character that survives neither:
// no O or 0, no I, 1 or L, no S or 5.
const Q_CODE_ALPHABET = "ABCDEFGHJKMNPQRTUVWXYZ2346789";
function _qMakeCode(){
  let out = "";
  for (let i = 0; i < 6; i++){
    out += Q_CODE_ALPHABET[Math.floor(Math.random() * Q_CODE_ALPHABET.length)];
  }
  return out.slice(0, 3) + "-" + out.slice(3);
}

// Collisions are possible, so the unique index is the arbiter and the
// loop is what makes it a non-event.
async function _qAssignCode(sessionId){
  for (let i = 0; i < 6; i++){
    const code = _qMakeCode();
    try {
      const r = await pool.query(
        "UPDATE queue_sessions SET join_code = $2 WHERE id = $1 AND join_code IS NULL RETURNING join_code",
        [sessionId, code]);
      if (r.rowCount) return r.rows[0].join_code;
      // Already had one.
      const cur = await pool.query("SELECT join_code FROM queue_sessions WHERE id = $1", [sessionId]);
      return (cur.rows[0] || {}).join_code || null;
    } catch (e) { /* unique violation: try another */ }
  }
  return null;
}

function _qTierIdx(t) {
  const i = Q_TIERS.indexOf(String(t || "").toLowerCase());
  return i === -1 ? 3 : i;   // unknown sits mid-ladder rather than at an end
}

// The window widens as a session waits. This is why the elapsed timer on
// the search screen means something: a strict match is tried first, and
// standards drop the longer nobody suitable appears. Without it, a
// narrow tier would simply never match on a small player base.
function _qWindowFor(ageMs) {
  if (ageMs < 30000) return 0;
  if (ageMs < 90000) return 1;
  if (ageMs < 180000) return 2;
  return Q_TIERS.length;   // past three minutes, take anyone
}

// The tier window a side is willing to accept, given how long it has
// waited and what it asked for.
//
//   strict  never widens -- exact tier or nothing
//   ±1      floors at one tier and still widens with age
//   any     everyone, immediately
//   (unset) the original age-only curve
function _qWindowWith(ageMs, width) {
  if (width === "strict") return 0;
  if (width === "any")    return Q_TIERS.length;
  if (width === "one")    return Math.max(_qWindowFor(ageMs), 1);
  return _qWindowFor(ageMs);
}

// Every user this one cannot be matched with, in either direction. One
// query rather than a check per candidate, because the matcher runs
// this against every open session.
async function _qBlockedIds(userId) {
  const r = await pool.query(
    `SELECT blocked_id AS id FROM user_blocks WHERE user_id = $1
     UNION
     SELECT user_id   AS id FROM user_blocks WHERE blocked_id = $1`,
    [userId]
  );
  return new Set(r.rows.map(x => x.id));
}

// What the ladder already knows about this player for this game.
//
// The queue asks people to declare their own tier and then asks for
// proof, which is a workaround for not having a number. There IS a
// number: rating-engine keeps per-game Elo and RP with seasons and
// smurf penalties applied. Where it has one, it wins — a declared tier
// is a claim and this is a record.
async function _qLadderTier(userId, game) {
  try {
    const eng = require("./rating-engine.js");
    if (!eng || !eng.getUserTier || !eng.normalizeGameTag) return null;
    const tag = eng.normalizeGameTag(String(game || "").replace(/^pl:/, ""));
    if (!tag) return null;
    const t = await eng.getUserTier(userId, tag);
    const name = t && (t.tier || t.name || t.rank);
    if (!name) return null;
    const id = String(name).toLowerCase().split(/[\s_-]/)[0];
    return Q_TIERS.includes(id) ? id : null;
  } catch (e) {
    return null;                 // the ladder is an enhancement, never a gate
  }
}

// Hours in this game, from Steam, for the account that owns them.
//
// The proof field asks people to paste a link nobody checks. The server
// can already see their playtime, which is the thing the link was
// standing in for — so it fills it in rather than asking.
async function _qSteamProof(userId, game) {
  try {
    const appid = String(game || "").match(/^steam:(\d+)$/)?.[1]
               || (/^\d+$/.test(String(game)) ? String(game) : null);
    if (!appid || !STEAM_KEY) return null;
    const u = await pool.query("SELECT steam_id FROM users WHERE id = $1", [userId]);
    const sid = u.rows[0]?.steam_id;
    if (!sid) return null;
    const r = await fetch(
      `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${STEAM_KEY}` +
      `&steamid=${sid}&include_appinfo=0&appids_filter[0]=${appid}&input_json=` +
      encodeURIComponent(JSON.stringify({ steamid: sid, appids_filter: [Number(appid)] }))
    );
    const j = await r.json();
    const row = (j?.response?.games || []).find(g => String(g.appid) === appid);
    if (!row) return null;
    const hrs = Math.round((row.playtime_forever || 0) / 60);
    return hrs > 0 ? `steam:${hrs}h` : null;
  } catch (e) {
    return null;
  }
}

// The tiers that must show proof. Read from the end of the ladder so
// adding a tier above Pro does not silently exempt it.
const Q_PROOF_FROM = 5;                    // Master upward
function _qNeedsProof(tier) {
  return _qTierIdx(tier) >= Q_PROOF_FROM;
}

// Two sides agree on a preference when either does not have one. NULL is
// "no preference", so it matches anything -- which is what keeps a
// filter from quietly excluding every player who left it alone.
function _qPrefOk(a, b) {
  if (a === null || a === undefined || a === "") return true;
  if (b === null || b === undefined || b === "") return true;
  return String(a) === String(b);
}

async function _qRoster(sessionId) {
  const r = await pool.query(`
    SELECT m.user_id, m.skill, m.proof, m.joined_at, m.role, m.ping_ms, m.region,
           m.hours,
           u.username, u.avatar_url,
           -- What they have done in the app, not just in this table.
           (SELECT COUNT(*)::int FROM tournament_players tp
             WHERE tp.user_id = m.user_id) AS tourneys,
           (SELECT COUNT(*)::int FROM tournament_players tp
             WHERE tp.user_id = m.user_id AND tp.status = 'winner') AS tourney_wins,
           (s.owner_id = m.user_id) AS is_owner
    FROM queue_members m
    JOIN users u ON u.id = m.user_id
    JOIN queue_sessions s ON s.id = m.session_id
    WHERE m.session_id = $1 AND m.left_at IS NULL
    ORDER BY m.joined_at ASC
  `, [sessionId]);
  return r.rows.map(x => ({
    userId: x.user_id,
    id: x.user_id,
    username: x.username,
    avatar_url: x.avatar_url,
    skill: x.skill,
    proof: x.proof,
    isOwner: !!x.is_owner,
    role: x.role || null,
    pingMs: x.ping_ms == null ? null : Number(x.ping_ms),
    region: x.region || null,
    hours: x.hours == null ? null : Number(x.hours),
    tourneys: x.tourneys || 0,
    tourneyWins: x.tourney_wins || 0,
  }));
}

async function _qSession(id) {
  const r = await pool.query("SELECT * FROM queue_sessions WHERE id = $1", [id]);
  return r.rows[0] || null;
}

// A session that has run past its cap is closed on read rather than by a
// sweeper: there is no scheduler in this service, and a session nobody
// looks at does no harm.
async function _qExpire(sess) {
  await pool.query(
    "UPDATE queue_sessions SET state = 'expired', ended_at = NOW() WHERE id = $1",
    [sess.id]
  );
  return Object.assign({}, sess, { state: "expired" });
}

async function _qExpireIfStale(sess) {
  if (!sess || sess.ended_at) return sess;
  const started = new Date(sess.matched_at || sess.created_at).getTime();
  if (Date.now() - started >= Q_SESSION_MAX_MS) return _qExpire(sess);

  // The idle rule. Activity is anything a person did: arriving, saying
  // something, or putting a question to the table. Polling for updates
  // is not activity -- a client left open on a dead table would
  // otherwise keep it alive forever, which is the exact failure this
  // exists to stop.
  if (sess.state === "searching") {
    try {
      const r = await pool.query(`
        SELECT (SELECT COUNT(*)::int FROM queue_members m
                 WHERE m.session_id = $1 AND m.left_at IS NULL) AS filled,
               GREATEST(
                 $2::timestamptz,
                 COALESCE((SELECT kept_at FROM queue_sessions WHERE id = $1), $2::timestamptz),
                 COALESCE((SELECT MAX(joined_at) FROM queue_members
                            WHERE session_id = $1), $2::timestamptz),
                 COALESCE((SELECT MAX(created_at) FROM queue_messages
                            WHERE session_id = $1), $2::timestamptz),
                 COALESCE((SELECT MAX(created_at) FROM queue_polls
                            WHERE session_id = $1), $2::timestamptz)
               ) AS last_at
      `, [sess.id, sess.created_at]);

      const row = r.rows[0] || {};
      const filled = row.filled || 0;
      const idle = Date.now() - new Date(row.last_at || sess.created_at).getTime();
      // Playing counts as being there. Reclaiming a table because
      // nobody typed for twenty minutes, while all of them are inside
      // the match it exists for, is the worst possible time to do it.
      if (!sess.started_at &&
          filled < (sess.players || 2) && idle >= Q_SEARCH_IDLE_MS) {
        return _qExpire(sess);
      }
    } catch (e) {
      // queue_messages / queue_polls arrived later than this table did.
      // A database without them is not a reason to refuse to answer --
      // the three-hour cap above still applies.
      console.warn("[queue/idle]", e.message);
    }
  }
  return sess;
}

function _qPayload(sess, members) {
  const plId = _qPlaylistIdOf(sess.game);
  const pl = plId ? _qPlaylist(plId) : null;
  return {
    queueId: sess.id,
    state: sess.state,
    game: sess.game,
    // Null for an exact-game session. The client needs to know which
    // it is: a playlist match agrees its title afterwards, an exact
    // one already has it.
    playlist: pl ? { id: pl.id, name: pl.name, sub: pl.sub, games: pl.games } : null,
    players: sess.players,
    skill: sess.skill,
    members,
    filled: members.length,
    ownerId: sess.owner_id,
    startedAt: sess.matched_at || sess.created_at,
    expiresAt: new Date(
      new Date(sess.matched_at || sess.created_at).getTime() + Q_SESSION_MAX_MS
    ).toISOString(),
    serverId: sess.server_id || null,
    // The room half of the table. A client polling status should not
    // need three more round trips to know what is being voted on and
    // whether the game code has been posted yet.
    lobbyCode: sess.lobby_code || null,
    lobbyNote: sess.lobby_note || null,
    locked: !!sess.locked,
    startedAt2: sess.started_at || null,
    inPlay: !!sess.started_at,
    voiceRoom: "qt:" + sess.id,
    joinCode: sess.join_code || null,
  };
}

// Everything the table is currently deciding. Open polls with their
// tallies, plus the standing kick votes -- which already existed but
// were invisible, so a vote against you was cast in the dark.
async function _qRoom(sessionId, viewerId) {
  const polls = await pool.query(`
    SELECT p.*, u.username AS author_name, t.username AS target_name
      FROM queue_polls p
      LEFT JOIN users u ON u.id = p.author_id
      LEFT JOIN users t ON t.id = p.target_id
     WHERE p.session_id = $1 AND p.created_at > NOW() - INTERVAL '20 minutes'
     ORDER BY p.created_at DESC LIMIT 8
  `, [sessionId]);

  const ids = polls.rows.map(x => x.id);
  let votes = { rows: [] };
  if (ids.length) {
    votes = await pool.query(
      "SELECT poll_id, voter_id, choice FROM queue_poll_votes WHERE poll_id = ANY($1::int[])",
      [ids]);
  }

  const kick = await pool.query(`
    SELECT target_id, COUNT(*)::int AS votes,
           BOOL_OR(voter_id = $2) AS mine
      FROM queue_votes WHERE session_id = $1 GROUP BY target_id
  `, [sessionId, viewerId]);

  const seated = await pool.query(
    "SELECT COUNT(*)::int AS n FROM queue_members WHERE session_id = $1 AND left_at IS NULL",
    [sessionId]);
  const n = (seated.rows[0] || {}).n || 1;

  const wait = await pool.query(`
    SELECT w.user_id, w.created_at, u.username, u.avatar_url, w.skill
      FROM queue_waitlist w JOIN users u ON u.id = w.user_id
     WHERE w.session_id = $1 ORDER BY w.created_at ASC
  `, [sessionId]);

  const rated = await pool.query(
    "SELECT target_id, score FROM queue_ratings WHERE session_id = $1 AND rater_id = $2",
    [sessionId, viewerId]);

  // When this table would be reclaimed if nothing else happens.
  // Null while it is full, in play, or locked -- none of those are
  // reclaimed at all, and a countdown that never runs out is just
  // an alarming number on the screen.
  const idle = await pool.query(`
    SELECT s.players, s.started_at, s.locked,
           (SELECT COUNT(*)::int FROM queue_members m
             WHERE m.session_id = s.id AND m.left_at IS NULL) AS filled,
           GREATEST(
             s.created_at,
             COALESCE(s.kept_at, s.created_at),
             COALESCE((SELECT MAX(joined_at) FROM queue_members j
                        WHERE j.session_id = s.id), s.created_at),
             COALESCE((SELECT MAX(created_at) FROM queue_messages c2
                        WHERE c2.session_id = s.id), s.created_at),
             COALESCE((SELECT MAX(created_at) FROM queue_polls p2
                        WHERE p2.session_id = s.id), s.created_at)
           ) AS last_at
      FROM queue_sessions s WHERE s.id = $1
  `, [sessionId]).catch(() => ({ rows: [] }));

  const iw = idle.rows[0] || {};
  const idleAt = (!iw.started_at && !iw.locked && (iw.filled || 0) < (iw.players || 2) && iw.last_at)
    ? new Date(new Date(iw.last_at).getTime() + Q_SEARCH_IDLE_MS).toISOString()
    : null;

  const chat = await pool.query(`
    SELECT c.id, c.body, c.created_at, c.user_id, u.username, u.avatar_url
      FROM queue_messages c LEFT JOIN users u ON u.id = c.user_id
     WHERE c.session_id = $1
     ORDER BY c.created_at DESC LIMIT 60
  `, [sessionId]);

  return {
    polls: polls.rows.map(x => {
      const mine = votes.rows.filter(v => v.poll_id === x.id);
      const opts = Array.isArray(x.options) ? x.options : [];
      const tally = opts.map((_, i) => mine.filter(v => v.choice === i).length);
      const own = mine.find(v => v.voter_id === viewerId);
      return {
        id: x.id, kind: x.kind, question: x.question, options: opts,
        targetId: x.target_id || null, targetName: x.target_name || null,
        author: x.author_name || null, authorId: x.author_id,
        closesAt: x.closes_at, closed: !!x.closed, result: x.result || null,
        tally, votes: mine.length,
        myChoice: own ? own.choice : null,
        // A majority of everyone seated, so an abstention is not a yes.
        needed: Math.floor(n / 2) + 1,
      };
    }),
    waitlist: wait.rows.map(x => ({
      userId: x.user_id, username: x.username, avatar: x.avatar_url,
      skill: x.skill, since: x.created_at,
    })),
    myRatings: rated.rows.reduce((a, x) => (a[x.target_id] = x.score, a), {}),
    idleAt: idleAt,
    // Oldest first: a transcript is read downwards.
    chat: chat.rows.reverse().map(x => ({
      id: x.id, userId: x.user_id, username: x.username,
      avatar: x.avatar_url, body: x.body, at: x.created_at,
    })),
    // Same denominator the kick endpoint enforces: everyone but the
    // person on the end of it.
    kicks: kick.rows.map(x => ({
      targetId: x.target_id, votes: x.votes, mine: !!x.mine,
      needed: Math.floor(Math.max(1, n - 1) / 2) + 1,
    })),
  };
}

// POST /queue/intent — join a compatible session, or open one.
app.post("/queue/intent", requireAuth, async (req, res) => {
  const { playlist, game: rawGame, players, skill, proof,
          mic, playstyle, mode, width, host } = req.body || {};

  // Normalised here so a junk value can never reach the filter and
  // quietly match nothing. Anything unrecognised becomes "no preference".
  const wMic   = (mic === true || mic === false) ? mic : null;
  const wPlay  = ["casual", "comp"].includes(playstyle) ? playstyle : null;
  const wMode  = ["pvp", "pve"].includes(mode) ? mode : null;
  const wWidth = ["strict", "one", "any"].includes(width) ? width : null;
  // Door policy for a table you are opening. Clamped, because a host
  // asking for a two-year-old account is asking for an empty table.
  const wSteamOnly = (req.body || {}).steamOnly === true;
  const wMinAge = Math.max(0, Math.min(90, parseInt((req.body || {}).minAgeDays, 10) || 0));

  // A playlist fixes both halves of the bucket, which is the whole
  // point of it: its id becomes the game, its size becomes the size,
  // and everyone who picked it is therefore matchable with everyone
  // else who picked it.
  const pl = playlist ? _qPlaylist(playlist) : null;
  if (playlist && !pl) return res.status(400).json({ error: "No such playlist" });

  const game = pl ? ("pl:" + pl.id) : rawGame;
  if (!game) return res.status(400).json({ error: "game or playlist is required" });
  const size = pl ? pl.players : Math.max(2, Math.min(10, parseInt(players, 10) || 2));
  const tier = String(skill || "plat").toLowerCase();

  // What the ladder says, if it says anything. A rating outranks a
  // self-declared tier: it is a record rather than a claim, and it
  // already has the smurf penalties applied.
  const ladderTier = await _qLadderTier(req.userId, game);
  const effTier = ladderTier || tier;
  const verified = !!ladderTier;

  // Master and Pro have to show their working. The top of a ladder is
  // where claiming a rank you do not hold costs other people the most.
  //
  // A verified tier is exempt: it was never a claim, so there is nothing
  // to substantiate. Where it is a claim, Steam playtime stands in for
  // the pasted link if the account has any — the server can see the
  // hours, so asking the player to type them was always theatre.
  let effProof = String(proof || "").trim();
  if (_qNeedsProof(effTier) && !verified && !effProof) {
    effProof = (await _qSteamProof(req.userId, game)) || "";
  }
  if (_qNeedsProof(effTier) && !verified && !effProof) {
    return res.status(400).json({
      error: "Master and Pro need skill proof — add a tracker link or a recent result.",
      code: "proof_required",
    });
  }

  try {
    // Already queueing? Return that session rather than opening a second
    // one -- otherwise a double-click leaves an orphan searching forever.
    const existing = await pool.query(`
      SELECT s.* FROM queue_sessions s
      JOIN queue_members m ON m.session_id = s.id AND m.user_id = $1 AND m.left_at IS NULL
      WHERE s.state IN ('searching','matched')
      ORDER BY s.created_at DESC LIMIT 1
    `, [req.userId]);
    if (existing.rows.length) {
      const sess = await _qExpireIfStale(existing.rows[0]);
      if (sess.state !== "expired") {
        return res.json(_qPayload(sess, await _qRoster(sess.id)));
      }
    }

    // Candidates: same game, same target size, still filling, not mine.
    const open = await pool.query(`
      SELECT s.*,
        (SELECT COUNT(*)::int FROM queue_members qm
          WHERE qm.session_id = s.id AND qm.left_at IS NULL) AS filled,
        EXTRACT(EPOCH FROM (NOW() - s.created_at)) * 1000 AS age_ms
      FROM queue_sessions s
      WHERE s.state = 'searching' AND s.game = $1 AND s.players = $2
        AND NOT EXISTS (SELECT 1 FROM queue_members k
                         WHERE k.session_id = s.id AND k.user_id = $3 AND k.kicked)
      ORDER BY s.created_at ASC
    `, [game, size, req.userId]);


    const mine = _qTierIdx(effTier);

    // Everyone this player must never be matched with, and everything
    // known about the player that a host might be gating on.
    const blocked = await _qBlockedIds(req.userId);
    const meRow = await pool.query(
      "SELECT steam_id, created_at FROM users WHERE id = $1", [req.userId]);
    const meSteam = !!meRow.rows[0]?.steam_id;
    const meAgeDays = meRow.rows[0]?.created_at
      ? (Date.now() - new Date(meRow.rows[0].created_at).getTime()) / 86400000
      : 0;

    // Which open sessions hold somebody in the block set. Done as one
    // query rather than per candidate.
    const blockedSess = new Set();
    if (blocked.size && open.rows.length) {
      const bs = await pool.query(
        `SELECT DISTINCT session_id FROM queue_members
          WHERE left_at IS NULL AND session_id = ANY($1) AND user_id = ANY($2)`,
        [open.rows.map(r => r.id), Array.from(blocked)]
      );
      bs.rows.forEach(r => blockedSess.add(r.session_id));
    }

    // Hosting means "open my own table and wait", so no candidate is
    // considered at all -- the point is that people come to you.
    const fit = host ? null : open.rows.find(row => {
      if ((row.filled || 0) >= row.players) return false;
      // A block is absolute and is checked before anything else: no
      // preference should be able to talk you into a table with someone
      // you have blocked, or them into yours.
      if (blockedSess.has(row.id)) return false;
      // The table's own door policy.
      if (row.steam_only && !meSteam) return false;
      if ((row.min_age_days || 0) > 0 && meAgeDays < row.min_age_days) return false;
      // Both sides must accept: the waiting session has widened by age,
      // and the arriving player has not waited at all. Using the widest
      // of the two is what lets a long-waiting group take anyone.
      const win = Math.max(
        _qWindowWith(Number(row.age_ms) || 0, row.width),
        _qWindowWith(0, wWidth)
      );
      if (Math.abs(_qTierIdx(row.skill) - mine) > win) return false;
      return _qPrefOk(wMic,  row.mic)
          && _qPrefOk(wPlay, row.playstyle)
          && _qPrefOk(wMode, row.mode);
    });

    let sessionId;
    if (fit) {
      sessionId = fit.id;
      await pool.query(`
        INSERT INTO queue_members (session_id, user_id, skill, proof)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (session_id, user_id)
        DO UPDATE SET left_at = NULL, skill = EXCLUDED.skill, proof = EXCLUDED.proof
      `, [sessionId, req.userId, effTier, effProof || null]);
    } else {
      const created = await pool.query(`
        INSERT INTO queue_sessions (game, players, skill, owner_id, mic, playstyle, mode, width,
                                    steam_only, min_age_days, verified_tier)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *
      `, [game, size, effTier, req.userId, wMic, wPlay, wMode, wWidth,
          wSteamOnly, wMinAge, verified]);
      sessionId = created.rows[0].id;
      await _qAssignCode(sessionId);
      await pool.query(
        "INSERT INTO queue_members (session_id, user_id, skill, proof) VALUES ($1,$2,$3,$4)",
        [sessionId, req.userId, effTier, effProof || null]
      );
    }

    // Full? Then it is a match. Done in one statement so two people
    // arriving at once cannot both believe they completed it.
    await pool.query(`
      UPDATE queue_sessions s SET state = 'matched', matched_at = NOW()
      WHERE s.id = $1 AND s.state = 'searching'
        AND (SELECT COUNT(*) FROM queue_members m
              WHERE m.session_id = s.id AND m.left_at IS NULL) >= s.players
    `, [sessionId]);

    const sess = await _qSession(sessionId);
    res.json(_qPayload(sess, await _qRoster(sessionId)));
  } catch (e) {
    console.error("[queue/intent]", e.message);
    res.status(500).json({ error: "Could not join the queue" });
  }
});

// GET /queue/tier?game=… -- what the ladder knows about you here.
//
// So the page can show a rank as verified BEFORE you search, rather than
// the server quietly overriding a tier you picked and never saying so.
app.get("/queue/tier", requireAuth, async (req, res) => {
  const game = String(req.query.game || "");
  if (!game) return res.json({ tier: null, verified: false });
  try {
    const tier = await _qLadderTier(req.userId, game);
    const proof = tier ? null : await _qSteamProof(req.userId, game);
    res.json({ tier, verified: !!tier, proof });
  } catch (e) {
    res.json({ tier: null, verified: false, proof: null });
  }
});

// ── Blocking ─────────────────────────────────────────────────────────
//
// The queue's whole job is putting you in a call with strangers, and
// until now the only recourse was a vote-kick that lasted one session.
// A block is personal, permanent and silent: the other party is never
// told, they simply stop being matchable with you.

app.get("/blocks", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT b.blocked_id AS id, u.username, u.avatar_url, b.created_at
         FROM user_blocks b JOIN users u ON u.id = b.blocked_id
        WHERE b.user_id = $1 ORDER BY b.created_at DESC`, [req.userId]);
    res.json(r.rows);
  } catch (e) {
    console.error("[blocks]", e.message);
    res.status(500).json({ error: "Could not load your block list" });
  }
});

app.post("/blocks/:id", requireAuth, async (req, res) => {
  const target = parseInt(req.params.id, 10);
  if (!target) return res.status(400).json({ error: "Bad user id" });
  if (target === req.userId) return res.status(400).json({ error: "You cannot block yourself" });
  try {
    await pool.query(
      `INSERT INTO user_blocks (user_id, blocked_id, reason) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, blocked_id) DO NOTHING`,
      [req.userId, target, (req.body || {}).reason || null]);
    res.json({ ok: true });
  } catch (e) {
    console.error("[blocks/add]", e.message);
    res.status(500).json({ error: "Could not block that player" });
  }
});

app.delete("/blocks/:id", requireAuth, async (req, res) => {
  const target = parseInt(req.params.id, 10);
  if (!target) return res.status(400).json({ error: "Bad user id" });
  try {
    await pool.query("DELETE FROM user_blocks WHERE user_id=$1 AND blocked_id=$2",
      [req.userId, target]);
    res.json({ ok: true });
  } catch (e) {
    console.error("[blocks/remove]", e.message);
    res.status(500).json({ error: "Could not unblock that player" });
  }
});

// POST /queue/:id/report -- raise something for a human to look at.
//
// Separate from blocking on purpose: blocking is a private preference
// that takes effect immediately, reporting is a request for review. Most
// people want the first and are offered only the second.
app.post("/queue/:id/report", requireAuth, async (req, res) => {
  const sid = parseInt(req.params.id, 10) || null;
  const { targetId, reason, detail, alsoBlock } = req.body || {};
  const target = parseInt(targetId, 10);
  if (!target || !reason) return res.status(400).json({ error: "targetId and reason are required" });
  try {
    await pool.query(
      `INSERT INTO queue_reports (session_id, reporter_id, target_id, reason, detail)
       VALUES ($1,$2,$3,$4,$5)`,
      [sid, req.userId, target, String(reason).slice(0, 40), (detail || "").slice(0, 500)]);
    if (alsoBlock) {
      await pool.query(
        `INSERT INTO user_blocks (user_id, blocked_id, reason) VALUES ($1,$2,$3)
         ON CONFLICT (user_id, blocked_id) DO NOTHING`,
        [req.userId, target, "reported: " + String(reason).slice(0, 40)]);
    }
    res.json({ ok: true, blocked: !!alsoBlock });
  } catch (e) {
    console.error("[queue/report]", e.message);
    res.status(500).json({ error: "Could not file that report" });
  }
});

// GET /queue/open -- the tables you could walk up to.
//
// /queue/intent picks one FOR you. This is the other half: the same
// searching sessions, but listed, so you can see who is already in one
// and how long they have been waiting before committing. Rank is
// reported rather than enforced -- the list shows you what is there and
// the join is what checks whether you fit.
app.get("/queue/open", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT s.id, s.game, s.players, s.skill, s.mic, s.playstyle, s.mode, s.width,
             s.steam_only, s.min_age_days, s.verified_tier,
             s.created_at, s.started_at,
             EXTRACT(EPOCH FROM (NOW() - s.created_at)) * 1000 AS age_ms,
             (SELECT COUNT(*)::int FROM queue_members m
               WHERE m.session_id = s.id AND m.left_at IS NULL) AS filled,
             u.username AS owner_name, u.avatar_url AS owner_avatar,
             -- Who is already sitting there. A seat count tells you the
             -- table is half full; the names tell you who you would be
             -- sitting with, which is the part worth deciding on.
             (SELECT COALESCE(json_agg(json_build_object(
                       'name', mu.username, 'avatar', mu.avatar_url)
                     ORDER BY m2.joined_at), '[]'::json)
                FROM queue_members m2
                JOIN users mu ON mu.id = m2.user_id
               WHERE m2.session_id = s.id AND m2.left_at IS NULL) AS members
      FROM queue_sessions s
      LEFT JOIN users u ON u.id = s.owner_id
      WHERE s.state = 'searching'
        -- Not shown once it has gone quiet: it is minutes from being
        -- reclaimed, and walking up to one is a wasted press.
        AND (s.created_at > NOW() - INTERVAL '20 minutes'
             OR (SELECT COUNT(*) FROM queue_members f
                  WHERE f.session_id = s.id AND f.left_at IS NULL) >= s.players
             OR (SELECT MAX(joined_at) FROM queue_members g
                  WHERE g.session_id = s.id) > NOW() - INTERVAL '20 minutes')
        AND NOT EXISTS (SELECT 1 FROM queue_members k
                         WHERE k.session_id = s.id AND k.user_id = $1 AND k.kicked)
        AND NOT EXISTS (SELECT 1 FROM queue_members me
                         WHERE me.session_id = s.id AND me.user_id = $1 AND me.left_at IS NULL)
        -- A blocked player's table is not shown at all. Listing one you
        -- can never join would be worse than not listing it.
        AND NOT EXISTS (
          SELECT 1 FROM queue_members bm
           WHERE bm.session_id = s.id AND bm.left_at IS NULL
             AND bm.user_id IN (
               SELECT blocked_id FROM user_blocks WHERE user_id = $1
               UNION
               SELECT user_id    FROM user_blocks WHERE blocked_id = $1))
      ORDER BY s.created_at ASC
      LIMIT 60
    `, [req.userId]);

    // Full tables are listed too, marked as full. They were filtered
    // out entirely, which meant a popular table was invisible and the
    // waiting line behind it was unreachable -- you cannot queue for a
    // table you are never shown.
    res.json(r.rows
      .map(x => ({
        full: (x.filled || 0) >= x.players,
        inPlay: !!x.started_at,
        id: x.id, game: x.game, players: x.players, filled: x.filled || 0,
        skill: x.skill, mic: x.mic, playstyle: x.playstyle, mode: x.mode,
        width: x.width, ageMs: Math.round(Number(x.age_ms) || 0),
        steamOnly: !!x.steam_only, minAgeDays: x.min_age_days || 0,
        verifiedTier: !!x.verified_tier,
        owner: x.owner_name || null, ownerAvatar: x.owner_avatar || null,
        members: Array.isArray(x.members) ? x.members : [],
      })));
  } catch (e) {
    console.error("[queue/open]", e.message);
    res.status(500).json({ error: "Could not list tables" });
  }
});

// POST /queue/:id/join -- take a seat at one specific table.
//
// The rank window still applies: choosing a table from a list does not
// let you sit at one that would not have matched you, or the list would
// be a way around the thing it is showing you.
app.post("/queue/:id/join", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "Bad table id" });
  const tier = String((req.body || {}).skill || "plat").toLowerCase();
  const proof = (req.body || {}).proof || null;

  try {
    const r = await pool.query(`
      SELECT s.*,
        (SELECT COUNT(*)::int FROM queue_members m
          WHERE m.session_id = s.id AND m.left_at IS NULL) AS filled,
        EXTRACT(EPOCH FROM (NOW() - s.created_at)) * 1000 AS age_ms
      FROM queue_sessions s WHERE s.id = $1
    `, [id]);
    const sess = r.rows[0];
    if (!sess) return res.status(404).json({ error: "No such table" });
    if (sess.state !== "searching") return res.status(409).json({ error: "That table has already filled" });
    if ((sess.filled || 0) >= sess.players) return res.status(409).json({ error: "That table is full" });

    const kicked = await pool.query(
      "SELECT 1 FROM queue_members WHERE session_id=$1 AND user_id=$2 AND kicked", [id, req.userId]);
    if (kicked.rows.length) return res.status(403).json({ error: "You cannot rejoin that table" });

    /* The list already hides these, but the endpoint cannot rely on that
       -- a table can fill with a blocked player between the fetch and
       the click, and this is the door rather than the window. */
    const blk = await _qBlockedIds(req.userId);
    if (blk.size) {
      const hit = await pool.query(
        `SELECT 1 FROM queue_members WHERE session_id=$1 AND left_at IS NULL
           AND user_id = ANY($2) LIMIT 1`, [id, Array.from(blk)]);
      if (hit.rows.length) return res.status(403).json({ error: "That table is not available to you" });
    }

    /* The table's door policy applies to a chosen seat exactly as it
       does to a matched one, or the list would be a way around it. */
    const meRow = await pool.query(
      "SELECT steam_id, created_at FROM users WHERE id = $1", [req.userId]);
    if (sess.steam_only && !meRow.rows[0]?.steam_id) {
      return res.status(403).json({ error: "That table is for Steam-linked players" });
    }
    if ((sess.min_age_days || 0) > 0) {
      const days = meRow.rows[0]?.created_at
        ? (Date.now() - new Date(meRow.rows[0].created_at).getTime()) / 86400000 : 0;
      if (days < sess.min_age_days) {
        return res.status(403).json({ error: "That table is not open to new accounts yet" });
      }
    }

    const win = _qWindowWith(Number(sess.age_ms) || 0, sess.width);
    if (Math.abs(_qTierIdx(sess.skill) - _qTierIdx(tier)) > win) {
      return res.status(409).json({ error: "That table is outside your rank range for now" });
    }

    await pool.query(`
      INSERT INTO queue_members (session_id, user_id, skill, proof)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (session_id, user_id)
      DO UPDATE SET left_at = NULL, skill = EXCLUDED.skill, proof = EXCLUDED.proof
    `, [id, req.userId, tier, proof]);

    await pool.query(`
      UPDATE queue_sessions s SET state = 'matched', matched_at = NOW()
      WHERE s.id = $1 AND s.state = 'searching'
        AND (SELECT COUNT(*) FROM queue_members m
              WHERE m.session_id = s.id AND m.left_at IS NULL) >= s.players
    `, [id]);

    const out = await _qSession(id);
    res.json(_qPayload(out, await _qRoster(id)));
  } catch (e) {
    console.error("[queue/join]", e.message);
    res.status(500).json({ error: "Could not join that table" });
  }
});

// GET /queue/pulse -- who is waiting, right now.
//
// The old page could not answer the first question anyone has about
// matchmaking: is anyone here? Nothing rendered a population and no
// endpoint could have supplied one. This is that number.
//
// Honest about zero. An empty pool returns 0 and the page says so and
// offers something else, rather than showing a spinner that implies
// a search is closing in on something.
//
// Unauthenticated on purpose: it is an aggregate count with no names in
// it, and the queue button wants to show a badge before anyone signs in.
app.get("/queue/pulse", async (req, res) => {
  try {
    // The sweep. Expiry on read only reaches tables somebody is still
    // asking about, and an abandoned one is by definition the one nobody
    // asks about -- so it sat in the pool forever. The pulse is polled by
    // every client on the queue page, which makes it the cheapest place
    // to reclaim them: one statement, no extra timer, and it self-heals
    // as soon as a single person opens the page.
    await pool.query(`
      UPDATE queue_sessions s
         SET state = 'expired', ended_at = NOW()
       WHERE s.state = 'searching' AND s.ended_at IS NULL
         AND (
           s.created_at < NOW() - ($1 || ' milliseconds')::interval
           OR (
             (SELECT COUNT(*) FROM queue_members m
               WHERE m.session_id = s.id AND m.left_at IS NULL) < s.players
             AND s.started_at IS NULL
             AND GREATEST(
                   COALESCE(s.kept_at, s.created_at),
                   COALESCE((SELECT MAX(joined_at) FROM queue_members j
                              WHERE j.session_id = s.id), s.created_at))
                 < NOW() - ($2 || ' milliseconds')::interval
           )
         )
    `, [String(Q_SESSION_MAX_MS), String(Q_SEARCH_IDLE_MS)]).catch(() => {});

    const r = await pool.query(`
      SELECT s.game, s.players,
             COUNT(m.user_id)::int      AS waiting,
             COUNT(DISTINCT s.id)::int  AS sessions
      FROM queue_sessions s
      JOIN queue_members m
        ON m.session_id = s.id AND m.left_at IS NULL
      WHERE s.state = 'searching'
        -- Sessions expire on read rather than by a sweeper, so a stale
        -- one can still be marked searching. Excluded by age here, or
        -- the pulse would count people who left hours ago.
        AND s.created_at > NOW() - INTERVAL '3 hours'
      GROUP BY s.game, s.players
    `);

    const playlists = {};
    const games = {};
    let total = 0;
    for (const row of r.rows) {
      const plId = _qPlaylistIdOf(row.game);
      total += row.waiting;
      if (plId) {
        const cur = playlists[plId] || { waiting: 0, sessions: 0 };
        cur.waiting += row.waiting; cur.sessions += row.sessions;
        playlists[plId] = cur;
      } else {
        const cur = games[row.game] || { waiting: 0, sessions: 0 };
        cur.waiting += row.waiting; cur.sessions += row.sessions;
        games[row.game] = cur;
      }
    }

    res.json({
      total,
      playlists,
      games,
      // Sent with the counts so the client never has to keep its own copy
      // of the pool definitions in sync with this file.
      definitions: Q_PLAYLISTS.map(p => ({
        id: p.id, name: p.name, sub: p.sub, players: p.players,
        games: p.games, gameCount: p.games ? p.games.length : null,
      })),
    });
  } catch (e) {
    console.error("[queue/pulse]", e.message);
    res.json({ total: 0, playlists: {}, games: {}, definitions: [] });
  }
});

// GET /queue/:id/status — what the client polls while searching.
app.get("/queue/:id/status", requireAuth, async (req, res) => {
  try {
    let sess = await _qSession(req.params.id);
    if (!sess) return res.status(404).json({ error: "No such queue" });
    sess = await _qExpireIfStale(sess);

    // Late arrivals can complete a session between polls, so the same
    // fill check runs here. Without it a group could sit full and still
    // read as searching until somebody else posted an intent.
    if (sess.state === "searching") {
      await pool.query(`
        UPDATE queue_sessions s SET state = 'matched', matched_at = NOW()
        WHERE s.id = $1 AND s.state = 'searching'
          AND (SELECT COUNT(*) FROM queue_members m
                WHERE m.session_id = s.id AND m.left_at IS NULL) >= s.players
      `, [sess.id]);
      sess = await _qSession(sess.id);
    }
    res.json(_qPayload(sess, await _qRoster(sess.id)));
  } catch (e) {
    console.error("[queue/status]", e.message);
    res.status(500).json({ error: "Could not read the queue" });
  }
});

// POST /queue/:id/cancel — leave. The session closes when the last
// member goes, so an abandoned row cannot keep matching people into it.
app.post("/queue/:id/cancel", requireAuth, async (req, res) => {
  try {
    await pool.query(
      "UPDATE queue_members SET left_at = NOW() WHERE session_id = $1 AND user_id = $2",
      [req.params.id, req.userId]
    );
    const left = await pool.query(
      "SELECT COUNT(*)::int AS n FROM queue_members WHERE session_id = $1 AND left_at IS NULL",
      [req.params.id]
    );
    if ((left.rows[0] || {}).n === 0) {
      await pool.query(
        "UPDATE queue_sessions SET state = 'cancelled', ended_at = NOW() WHERE id = $1",
        [req.params.id]
      );
    } else {
      // Someone leaving a full group puts it back in the pool.
      await pool.query(`
        UPDATE queue_sessions s SET state = 'searching', matched_at = NULL
        WHERE s.id = $1 AND s.state = 'matched'
          AND (SELECT COUNT(*) FROM queue_members m
                WHERE m.session_id = s.id AND m.left_at IS NULL) < s.players
      `, [req.params.id]);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("[queue/cancel]", e.message);
    res.status(500).json({ error: "Could not leave the queue" });
  }
});

// POST /queue/:id/vote-kick — majority of everyone else.
app.post("/queue/:id/vote-kick", requireAuth, async (req, res) => {
  const target = parseInt((req.body || {}).targetUserId, 10);
  if (!target) return res.status(400).json({ error: "targetUserId is required" });
  if (target === req.userId) return res.status(400).json({ error: "Cannot vote for yourself" });
  try {
    const inSession = await pool.query(`
      SELECT COUNT(*)::int AS n FROM queue_members
      WHERE session_id = $1 AND user_id IN ($2, $3) AND left_at IS NULL
    `, [req.params.id, req.userId, target]);
    if ((inSession.rows[0] || {}).n < 2) {
      return res.status(400).json({ error: "Both must be in this queue" });
    }

    // UNIQUE(session, voter, target) makes a repeat vote a no-op rather
    // than a second tally.
    await pool.query(`
      INSERT INTO queue_votes (session_id, voter_id, target_id) VALUES ($1,$2,$3)
      ON CONFLICT (session_id, voter_id, target_id) DO NOTHING
    `, [req.params.id, req.userId, target]);

    const tally = await pool.query(
      "SELECT COUNT(*)::int AS votes FROM queue_votes WHERE session_id = $1 AND target_id = $2",
      [req.params.id, target]
    );
    const roster = await pool.query(
      "SELECT COUNT(*)::int AS n FROM queue_members WHERE session_id = $1 AND left_at IS NULL",
      [req.params.id]
    );
    const votes = (tally.rows[0] || {}).votes || 0;
    const others = Math.max(1, ((roster.rows[0] || {}).n || 1) - 1);
    const needed = Math.floor(others / 2) + 1;

    let passed = false;
    if (votes >= needed) {
      passed = true;
      // kicked, not just gone: the flag is what stops the matcher
      // putting them straight back into the same session.
      await pool.query(
        "UPDATE queue_members SET left_at = NOW(), kicked = TRUE WHERE session_id = $1 AND user_id = $2",
        [req.params.id, target]
      );
      await pool.query(
        "DELETE FROM queue_votes WHERE session_id = $1 AND target_id = $2",
        [req.params.id, target]
      );
      await pool.query(`
        UPDATE queue_sessions s SET state = 'searching', matched_at = NULL
        WHERE s.id = $1 AND s.state = 'matched'
          AND (SELECT COUNT(*) FROM queue_members m
                WHERE m.session_id = s.id AND m.left_at IS NULL) < s.players
      `, [req.params.id]);
    }
    res.json({ ok: true, userId: target, votes, needed, passed });
  } catch (e) {
    console.error("[queue/vote-kick]", e.message);
    res.status(500).json({ error: "Could not register the vote" });
  }
});

// GET /queue/:id/room -- the table as a room: who is seated, what is
// being voted on, and whether the game code has been posted.
app.get("/queue/:id/room", requireAuth, async (req, res) => {
  try {
    const sess0 = await _qSession(req.params.id);
    if (!sess0) return res.status(404).json({ error: "No such table" });
    // A seat that came free while nobody was looking is filled here,
    // before the room is described, so the answer is never one poll
    // out of date.
    await _qPromoteWaiting(sess0.id);
    if (!sess0.join_code) await _qAssignCode(sess0.id);
    // The same staleness check /status runs. Without it a table could be
    // reported as live here and expired there, and the client believed
    // whichever it asked last.
    let sess = await _qSession(req.params.id);
    sess = await _qExpireIfStale(sess);
    const roster = await _qRoster(sess.id);
    const room = await _qRoom(sess.id, req.userId);
    res.json(Object.assign(_qPayload(sess, roster), room));
  } catch (e) {
    console.error("[queue/room]", e.message);
    res.status(500).json({ error: "Could not read the table" });
  }
});

// POST /queue/:id/poll -- ask the table something.
//
// Anyone seated can ask. A table where only the leader may put a
// question is not a table, it is an audience -- and the one power that
// does need a majority (a kick) is already majority-gated below.
app.post("/queue/:id/poll", requireAuth, async (req, res) => {
  const b = req.body || {};
  const question = String(b.question || "").trim().slice(0, 120);
  const kind = ["poll", "ready", "kick"].includes(b.kind) ? b.kind : "poll";
  let options = Array.isArray(b.options)
    ? b.options.map(x => String(x || "").trim().slice(0, 48)).filter(Boolean).slice(0, 6)
    : [];
  if (!options.length) options = ["Yes", "No"];
  if (!question) return res.status(400).json({ error: "Ask something" });

  try {
    const seat = await pool.query(
      "SELECT 1 FROM queue_members WHERE session_id = $1 AND user_id = $2 AND left_at IS NULL",
      [req.params.id, req.userId]);
    if (!seat.rowCount) return res.status(403).json({ error: "You are not at this table" });

    // One open question at a time. Two live polls means neither gets a
    // majority, and the table stalls arguing about which to answer.
    const live = await pool.query(`
      SELECT COUNT(*)::int AS n FROM queue_polls
       WHERE session_id = $1 AND closed = FALSE AND closes_at > NOW()
    `, [req.params.id]);
    if ((live.rows[0] || {}).n > 0) {
      return res.status(409).json({ error: "A vote is already running" });
    }

    const secs = Math.max(15, Math.min(180, parseInt(b.seconds, 10) || 60));
    const r = await pool.query(`
      INSERT INTO queue_polls (session_id, author_id, kind, question, options, target_id, closes_at)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6, NOW() + ($7 || ' seconds')::interval)
      RETURNING id
    `, [req.params.id, req.userId, kind, question, JSON.stringify(options),
        parseInt(b.targetUserId, 10) || null, String(secs)]);

    res.json({ ok: true, pollId: r.rows[0].id });
  } catch (e) {
    console.error("[queue/poll]", e.message);
    res.status(500).json({ error: "Could not open the vote" });
  }
});

// POST /queue/:id/poll/:pollId/vote -- one voice each.
app.post("/queue/:id/poll/:pollId/vote", requireAuth, async (req, res) => {
  const choice = parseInt((req.body || {}).choice, 10);
  if (!(choice >= 0)) return res.status(400).json({ error: "choice is required" });
  try {
    const seat = await pool.query(
      "SELECT 1 FROM queue_members WHERE session_id = $1 AND user_id = $2 AND left_at IS NULL",
      [req.params.id, req.userId]);
    if (!seat.rowCount) return res.status(403).json({ error: "You are not at this table" });

    const pr = await pool.query(
      "SELECT * FROM queue_polls WHERE id = $1 AND session_id = $2",
      [req.params.pollId, req.params.id]);
    const poll = pr.rows[0];
    if (!poll) return res.status(404).json({ error: "No such vote" });
    if (poll.closed || new Date(poll.closes_at) < new Date()) {
      return res.status(409).json({ error: "That vote has closed" });
    }

    // Changing your mind is allowed while the vote is open; voting
    // twice is not. The UNIQUE plus an UPDATE on conflict is the
    // difference between the two.
    await pool.query(`
      INSERT INTO queue_poll_votes (poll_id, voter_id, choice) VALUES ($1,$2,$3)
      ON CONFLICT (poll_id, voter_id) DO UPDATE SET choice = EXCLUDED.choice
    `, [poll.id, req.userId, choice]);

    const seated = await pool.query(
      "SELECT COUNT(*)::int AS n FROM queue_members WHERE session_id = $1 AND left_at IS NULL",
      [req.params.id]);
    const n = (seated.rows[0] || {}).n || 1;
    const needed = Math.floor(n / 2) + 1;

    const vr = await pool.query(
      "SELECT choice, COUNT(*)::int AS c FROM queue_poll_votes WHERE poll_id = $1 GROUP BY choice",
      [poll.id]);
    const top = vr.rows.sort((a, b2) => b2.c - a.c)[0];

    // Closed the moment it is decided rather than when the clock runs
    // out: a question everyone has answered should not sit there
    // pretending it is still open.
    let result = null;
    let acted = null;
    if (top && top.c >= needed) {
      const opts = Array.isArray(poll.options) ? poll.options : [];
      result = opts[top.choice] != null ? String(opts[top.choice]) : String(top.choice);
      await pool.query("UPDATE queue_polls SET closed = TRUE, result = $2 WHERE id = $1",
                       [poll.id, result]);

      // A ready check that passes closes the door behind it. Reporting
      // "everyone is ready" and then waiting for the leader to press
      // something else is half a decision, and the half it leaves out
      // is the one that stops a stranger landing mid-countdown.
      if (poll.kind === "ready" && top.choice === 0) {
        await pool.query(`
          UPDATE queue_sessions SET locked = TRUE, state = 'matched',
                 matched_at = COALESCE(matched_at, NOW())
           WHERE id = $1
        `, [req.params.id]).catch(() => {});
        acted = "locked";
      }
    }
    res.json({ ok: true, needed, result, closed: !!result, acted });
  } catch (e) {
    console.error("[queue/poll/vote]", e.message);
    res.status(500).json({ error: "Could not register the vote" });
  }
});

// POST /queue/:id/code -- post the game's own invite code to the table.
//
// Owner-only, and deliberately so: this is the one thing that cannot be
// undone by a vote, because everyone will have copied it by the time a
// vote finished. It is also the least harmful power in the room -- a
// wrong code wastes a minute, it does not remove anybody.
app.post("/queue/:id/code", requireAuth, async (req, res) => {
  const b = req.body || {};
  const code = String(b.code == null ? "" : b.code).trim().slice(0, 64);
  const note = String(b.note == null ? "" : b.note).trim().slice(0, 120);
  try {
    const sess = await _qSession(req.params.id);
    if (!sess) return res.status(404).json({ error: "No such table" });
    if (sess.owner_id !== req.userId) {
      return res.status(403).json({ error: "Only the table leader can post the code" });
    }
    await pool.query(
      "UPDATE queue_sessions SET lobby_code = $2, lobby_note = $3 WHERE id = $1",
      [sess.id, code || null, note || null]);
    res.json({ ok: true, lobbyCode: code || null, lobbyNote: note || null });
  } catch (e) {
    console.error("[queue/code]", e.message);
    res.status(500).json({ error: "Could not post the code" });
  }
});

// A free seat and somebody standing behind the table is a problem that
// solves itself. Called wherever a seat count is read, so a waiter is
// promoted the moment one opens rather than when someone refreshes.
async function _qPromoteWaiting(sessionId) {
  try {
    const r = await pool.query(`
      SELECT s.players,
             (SELECT COUNT(*)::int FROM queue_members m
               WHERE m.session_id = s.id AND m.left_at IS NULL) AS filled
        FROM queue_sessions s WHERE s.id = $1 AND s.locked = FALSE
    `, [sessionId]);
    const row = r.rows[0];
    if (!row) return;
    let free = (row.players || 0) - (row.filled || 0);
    while (free > 0) {
      const w = await pool.query(
        "SELECT * FROM queue_waitlist WHERE session_id = $1 ORDER BY created_at ASC LIMIT 1",
        [sessionId]);
      const next = w.rows[0];
      if (!next) return;
      await pool.query("DELETE FROM queue_waitlist WHERE id = $1", [next.id]);
      await pool.query(`
        INSERT INTO queue_members (session_id, user_id, skill) VALUES ($1,$2,$3)
        ON CONFLICT (session_id, user_id)
        DO UPDATE SET left_at = NULL, kicked = FALSE
      `, [sessionId, next.user_id, next.skill]);
      free--;
    }
  } catch (e) { console.error("[queue/promote]", e.message); }
}

// POST /queue/:id/waitlist -- stand behind a full table.
app.post("/queue/:id/waitlist", requireAuth, async (req, res) => {
  const on = (req.body || {}).waiting !== false;
  try {
    if (!on) {
      await pool.query("DELETE FROM queue_waitlist WHERE session_id = $1 AND user_id = $2",
                       [req.params.id, req.userId]);
      return res.json({ ok: true, waiting: false });
    }
    const seat = await pool.query(
      "SELECT 1 FROM queue_members WHERE session_id = $1 AND user_id = $2 AND left_at IS NULL",
      [req.params.id, req.userId]);
    if (seat.rowCount) return res.status(400).json({ error: "You already have a seat" });

    await pool.query(`
      INSERT INTO queue_waitlist (session_id, user_id, skill) VALUES ($1,$2,$3)
      ON CONFLICT (session_id, user_id) DO NOTHING
    `, [req.params.id, req.userId, (req.body || {}).skill || null]);
    // A seat may already be free, in which case standing in line for it
    // would be a strange thing to make someone do.
    await _qPromoteWaiting(req.params.id);
    res.json({ ok: true, waiting: true });
  } catch (e) {
    console.error("[queue/waitlist]", e.message);
    res.status(500).json({ error: "Could not join the line" });
  }
});

// POST /queue/:id/invite -- offer a specific seat to a specific person.
app.post("/queue/:id/invite", requireAuth, async (req, res) => {
  const to = parseInt((req.body || {}).userId, 10);
  if (!to) return res.status(400).json({ error: "userId is required" });
  try {
    const seat = await pool.query(
      "SELECT 1 FROM queue_members WHERE session_id = $1 AND user_id = $2 AND left_at IS NULL",
      [req.params.id, req.userId]);
    if (!seat.rowCount) return res.status(403).json({ error: "You are not at this table" });

    // Blocked in either direction is still blocked. Inviting around a
    // block would make the block worthless.
    const blocked = await pool.query(`
      SELECT 1 FROM user_blocks
       WHERE (user_id = $1 AND blocked_id = $2) OR (user_id = $2 AND blocked_id = $1)
    `, [req.userId, to]);
    if (blocked.rowCount) return res.status(403).json({ error: "You cannot invite them" });

    await pool.query(`
      INSERT INTO queue_invites (session_id, from_id, to_id) VALUES ($1,$2,$3)
      ON CONFLICT (session_id, to_id) DO UPDATE SET status = 'pending', created_at = NOW()
    `, [req.params.id, req.userId, to]);
    res.json({ ok: true });
  } catch (e) {
    console.error("[queue/invite]", e.message);
    res.status(500).json({ error: "Could not send that invite" });
  }
});

// GET /queue/invites -- tables you have been asked to sit at.
app.get("/queue/invites", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT i.id, i.session_id, i.created_at, u.username, u.avatar_url,
             s.game, s.players, s.state,
             (SELECT COUNT(*)::int FROM queue_members m
               WHERE m.session_id = s.id AND m.left_at IS NULL) AS filled
        FROM queue_invites i
        JOIN users u ON u.id = i.from_id
        JOIN queue_sessions s ON s.id = i.session_id
       WHERE i.to_id = $1 AND i.status = 'pending'
         AND s.state IN ('searching','matched')
         AND i.created_at > NOW() - INTERVAL '30 minutes'
       ORDER BY i.created_at DESC LIMIT 5
    `, [req.userId]);
    res.json(r.rows.map(x => ({
      id: x.id, queueId: x.session_id, from: x.username, fromAvatar: x.avatar_url,
      game: x.game, players: x.players, filled: x.filled, at: x.created_at,
    })));
  } catch (e) {
    console.error("[queue/invites]", e.message);
    res.status(500).json({ error: "Could not read your invites" });
  }
});

// POST /queue/invite/:id/decline -- no thanks. (Accepting is just
// joining the table, which /queue/:id/join already does properly,
// rank window and all -- an invite does not buy a seat you would not
// otherwise be allowed to take.)
app.post("/queue/invite/:id/decline", requireAuth, async (req, res) => {
  try {
    await pool.query("UPDATE queue_invites SET status = 'declined' WHERE id = $1 AND to_id = $2",
                     [req.params.id, req.userId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "Could not decline" }); }
});

// POST /queue/:id/befriend -- keep the group.
//
// "Make it a lobby" is the heavy version of this and most good
// sessions do not warrant a whole server. This is the light one:
// friend requests to everyone who was there, in one press.
app.post("/queue/:id/befriend", requireAuth, async (req, res) => {
  try {
    const roster = await _qRoster(req.params.id);
    let sent = 0;
    for (const m of roster) {
      if (m.userId === req.userId) continue;
      const r = await pool.query(`
        INSERT INTO friends (user_id, friend_id, status) VALUES ($1,$2,'pending')
        ON CONFLICT DO NOTHING
      `, [req.userId, m.userId]).catch(() => null);
      if (r && r.rowCount) sent++;
    }
    res.json({ ok: true, sent });
  } catch (e) {
    console.error("[queue/befriend]", e.message);
    res.status(500).json({ error: "Could not send the requests" });
  }
});

// POST /queue/:id/rate -- one score per person per table.
app.post("/queue/:id/rate", requireAuth, async (req, res) => {
  const target = parseInt((req.body || {}).targetUserId, 10);
  const score = Math.max(-1, Math.min(1, parseInt((req.body || {}).score, 10) || 0));
  if (!target || target === req.userId) return res.status(400).json({ error: "Invalid target" });
  try {
    const both = await pool.query(`
      SELECT COUNT(*)::int AS n FROM queue_members
       WHERE session_id = $1 AND user_id IN ($2,$3)
    `, [req.params.id, req.userId, target]);
    if ((both.rows[0] || {}).n < 2) {
      return res.status(400).json({ error: "You did not play with them" });
    }
    await pool.query(`
      INSERT INTO queue_ratings (session_id, rater_id, target_id, score) VALUES ($1,$2,$3,$4)
      ON CONFLICT (session_id, rater_id, target_id) DO UPDATE SET score = EXCLUDED.score
    `, [req.params.id, req.userId, target, score]);
    res.json({ ok: true });
  } catch (e) {
    console.error("[queue/rate]", e.message);
    res.status(500).json({ error: "Could not save that" });
  }
});

// POST /queue/:id/net -- your own round trip, self-reported.
app.post("/queue/:id/net", requireAuth, async (req, res) => {
  const ping = Math.max(0, Math.min(5000, parseInt((req.body || {}).pingMs, 10) || 0));
  const region = String((req.body || {}).region || "").trim().slice(0, 24) || null;
  const hours = Math.max(0, Math.min(100000, parseInt((req.body || {}).hours, 10) || 0));
  try {
    await pool.query(`
      UPDATE queue_members
         SET ping_ms = $3,
             region = COALESCE($4, region),
             hours = COALESCE($5, hours)
       WHERE session_id = $1 AND user_id = $2
    `, [req.params.id, req.userId, ping || null, region, hours || null]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "Could not record that" }); }
});

// GET /queue/history -- the tables you sat at, most recent first.
//
// Most people play with the same handful of others, and making them
// re-queue from nothing every night throws that away.
app.get("/queue/history", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT s.id, s.game, s.players, s.created_at,
             (SELECT json_agg(json_build_object(
                       'userId', u2.id, 'username', u2.username, 'avatar', u2.avatar_url))
                FROM queue_members m2 JOIN users u2 ON u2.id = m2.user_id
               WHERE m2.session_id = s.id AND m2.user_id <> $1) AS others
        FROM queue_sessions s
        JOIN queue_members m ON m.session_id = s.id AND m.user_id = $1
       WHERE s.created_at > NOW() - INTERVAL '30 days'
       ORDER BY s.created_at DESC LIMIT 12
    `, [req.userId]);
    res.json(r.rows
      .map(x => ({
        queueId: x.id, game: x.game, players: x.players, at: x.created_at,
        others: (x.others || []).filter(Boolean),
      }))
      // A table you sat at alone is not a group worth offering back.
      .filter(x => x.others.length));
  } catch (e) {
    console.error("[queue/history]", e.message);
    res.status(500).json({ error: "Could not read your history" });
  }
});

// POST /queue/schedule -- the same table, agreed for later.
app.post("/queue/schedule", requireAuth, async (req, res) => {
  const b = req.body || {};
  const at = new Date(b.startsAt);
  if (isNaN(at.getTime())) return res.status(400).json({ error: "When?" });
  if (at.getTime() < Date.now() - 60000) {
    return res.status(400).json({ error: "That time has passed" });
  }
  try {
    const r = await pool.query(`
      INSERT INTO queue_scheduled (owner_id, game, players, skill, starts_at, note)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING id
    `, [req.userId, String(b.game || "").slice(0, 64),
        Math.max(2, Math.min(10, parseInt(b.players, 10) || 2)),
        b.skill || null, at.toISOString(),
        String(b.note || "").slice(0, 200) || null]);
    const id = r.rows[0].id;

    const invite = Array.isArray(b.userIds) ? b.userIds : [];
    await pool.query("INSERT INTO queue_scheduled_members (scheduled_id, user_id, rsvp) VALUES ($1,$2,'going') ON CONFLICT DO NOTHING",
                     [id, req.userId]).catch(() => {});
    for (const uid of invite) {
      const n = parseInt(uid, 10);
      if (!n || n === req.userId) continue;
      await pool.query(
        "INSERT INTO queue_scheduled_members (scheduled_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [id, n]).catch(() => {});
    }
    res.json({ ok: true, id });
  } catch (e) {
    console.error("[queue/schedule]", e.message);
    res.status(500).json({ error: "Could not schedule that" });
  }
});

// GET /queue/scheduled -- what is coming up, yours and the ones you
// have been asked to.
app.get("/queue/scheduled", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT q.*, u.username AS owner_name,
             (SELECT rsvp FROM queue_scheduled_members x
               WHERE x.scheduled_id = q.id AND x.user_id = $1) AS my_rsvp,
             (SELECT COUNT(*)::int FROM queue_scheduled_members y
               WHERE y.scheduled_id = q.id AND y.rsvp = 'going') AS going
        FROM queue_scheduled q
        JOIN users u ON u.id = q.owner_id
       WHERE q.starts_at > NOW() - INTERVAL '2 hours'
         AND (q.owner_id = $1 OR EXISTS (SELECT 1 FROM queue_scheduled_members z
                                          WHERE z.scheduled_id = q.id AND z.user_id = $1))
       ORDER BY q.starts_at ASC LIMIT 10
    `, [req.userId]);
    res.json(r.rows.map(x => ({
      id: x.id, game: x.game, players: x.players, skill: x.skill,
      startsAt: x.starts_at, note: x.note, owner: x.owner_name,
      isMine: x.owner_id === req.userId, myRsvp: x.my_rsvp || null, going: x.going,
    })));
  } catch (e) {
    console.error("[queue/scheduled]", e.message);
    res.status(500).json({ error: "Could not read your sessions" });
  }
});

// POST /queue/scheduled/:id/rsvp
app.post("/queue/scheduled/:id/rsvp", requireAuth, async (req, res) => {
  const going = (req.body || {}).going !== false;
  try {
    await pool.query(`
      INSERT INTO queue_scheduled_members (scheduled_id, user_id, rsvp) VALUES ($1,$2,$3)
      ON CONFLICT (scheduled_id, user_id) DO UPDATE SET rsvp = EXCLUDED.rsvp
    `, [req.params.id, req.userId, going ? 'going' : 'out']);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "Could not RSVP" }); }
});

// DELETE /queue/scheduled/:id -- called off.
app.delete("/queue/scheduled/:id", requireAuth, async (req, res) => {
  try {
    await pool.query("DELETE FROM queue_scheduled WHERE id = $1 AND owner_id = $2",
                     [req.params.id, req.userId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "Could not cancel that" }); }
});

// POST /queue/:id/chat -- say something at the table.
//
// Deliberately not the app's message system: this belongs to the
// session and dies with it. A table is a conversation you are having
// for twenty minutes, not a channel anyone will scroll back through.
app.post("/queue/:id/chat", requireAuth, async (req, res) => {
  const body = String((req.body || {}).body || "").trim().slice(0, 500);
  if (!body) return res.status(400).json({ error: "Nothing to say" });
  try {
    const seat = await pool.query(
      "SELECT 1 FROM queue_members WHERE session_id = $1 AND user_id = $2 AND left_at IS NULL",
      [req.params.id, req.userId]);
    if (!seat.rowCount) return res.status(403).json({ error: "You are not at this table" });

    const r = await pool.query(`
      INSERT INTO queue_messages (session_id, user_id, body) VALUES ($1,$2,$3)
      RETURNING id, created_at
    `, [req.params.id, req.userId, body]);
    res.json({ ok: true, id: r.rows[0].id, at: r.rows[0].created_at });
  } catch (e) {
    console.error("[queue/chat]", e.message);
    res.status(500).json({ error: "Could not send that" });
  }
});

// POST /queue/:id/role -- claim a position.
//
// First come, first served, and one role per seat: a role two people
// have both claimed is worse than no role at all, so taking one that
// is held is refused rather than silently shared.
app.post("/queue/:id/role", requireAuth, async (req, res) => {
  const role = String((req.body || {}).role || "").trim().slice(0, 32) || null;
  try {
    const seat = await pool.query(
      "SELECT 1 FROM queue_members WHERE session_id = $1 AND user_id = $2 AND left_at IS NULL",
      [req.params.id, req.userId]);
    if (!seat.rowCount) return res.status(403).json({ error: "You are not at this table" });

    if (role) {
      const taken = await pool.query(`
        SELECT 1 FROM queue_members
         WHERE session_id = $1 AND left_at IS NULL AND role = $2 AND user_id <> $3
      `, [req.params.id, role, req.userId]);
      if (taken.rowCount) return res.status(409).json({ error: "Someone already has that role" });
    }
    await pool.query(
      "UPDATE queue_members SET role = $3 WHERE session_id = $1 AND user_id = $2",
      [req.params.id, req.userId, role]);
    res.json({ ok: true, role });
  } catch (e) {
    console.error("[queue/role]", e.message);
    res.status(500).json({ error: "Could not claim that role" });
  }
});

// GET /queue/code/:code -- find a table by the code you were given.
//
// Returns what it is, not a seat. Joining still goes through
// /queue/:id/join, which is what enforces the rank window, the
// blocks and the door policy -- a code is an address, not a pass.
app.get("/queue/code/:code", requireAuth, async (req, res) => {
  const code = String(req.params.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length < 5) return res.status(400).json({ error: "That is not a code" });
  const dashed = code.slice(0, 3) + "-" + code.slice(3, 6);
  try {
    const r = await pool.query(`
      SELECT s.*,
             (SELECT COUNT(*)::int FROM queue_members m
               WHERE m.session_id = s.id AND m.left_at IS NULL) AS filled
        FROM queue_sessions s
       WHERE s.join_code = $1
         AND s.state IN ('searching','matched') AND s.ended_at IS NULL
       LIMIT 1
    `, [dashed]);
    const sess = r.rows[0];
    if (!sess) return res.status(404).json({ error: "No table with that code" });
    res.json({
      queueId: sess.id, game: sess.game, players: sess.players,
      filled: sess.filled || 0, skill: sess.skill,
      locked: !!sess.locked, full: (sess.filled || 0) >= sess.players,
      joinCode: sess.join_code,
    });
  } catch (e) {
    console.error("[queue/code]", e.message);
    res.status(500).json({ error: "Could not look that up" });
  }
});

// POST /queue/:id/keep -- we are still here.
//
// The idle rule exists to reclaim tables nobody is sitting at, and
// the only evidence it accepts is somebody doing something. This is
// that evidence, for a table where everyone is simply waiting.
app.post("/queue/:id/keep", requireAuth, async (req, res) => {
  try {
    const seat = await pool.query(
      "SELECT 1 FROM queue_members WHERE session_id = $1 AND user_id = $2 AND left_at IS NULL",
      [req.params.id, req.userId]);
    if (!seat.rowCount) return res.status(403).json({ error: "You are not at this table" });
    await pool.query("UPDATE queue_sessions SET kept_at = NOW() WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error("[queue/keep]", e.message);
    res.status(500).json({ error: "Could not do that" });
  }
});

// POST /queue/:id/start -- we are playing; keep the seat open.
//
// Locking already existed and does the opposite of what a group
// usually wants at this moment: they are starting the game, and they
// still want the fourth. This marks the table as in play WITHOUT
// closing it, which also stops the idle sweep reclaiming a table
// whose members are all busy inside a match and not typing.
app.post("/queue/:id/start", requireAuth, async (req, res) => {
  const keepOpen = (req.body || {}).keepOpen !== false;
  try {
    const seat = await pool.query(
      "SELECT 1 FROM queue_members WHERE session_id = $1 AND user_id = $2 AND left_at IS NULL",
      [req.params.id, req.userId]);
    if (!seat.rowCount) return res.status(403).json({ error: "You are not at this table" });

    await pool.query(`
      UPDATE queue_sessions
         SET started_at = COALESCE(started_at, NOW()),
             locked = CASE WHEN $2 THEN locked ELSE TRUE END
       WHERE id = $1
    `, [req.params.id, keepOpen]);
    res.json({ ok: true, inPlay: true, keepOpen });
  } catch (e) {
    console.error("[queue/start]", e.message);
    res.status(500).json({ error: "Could not start the table" });
  }
});

// POST /queue/:id/stop -- back to waiting, not playing.
app.post("/queue/:id/stop", requireAuth, async (req, res) => {
  try {
    await pool.query("UPDATE queue_sessions SET started_at = NULL WHERE id = $1",
                     [req.params.id]);
    res.json({ ok: true, inPlay: false });
  } catch (e) { res.status(500).json({ error: "Could not do that" }); }
});

// POST /queue/:id/lock -- stop the matcher sending anyone else.
//
// A three-of-four table that is happy as it is should be able to say so
// without leaving and re-queueing.
app.post("/queue/:id/lock", requireAuth, async (req, res) => {
  const on = (req.body || {}).locked !== false;
  try {
    const sess = await _qSession(req.params.id);
    if (!sess) return res.status(404).json({ error: "No such table" });
    if (sess.owner_id !== req.userId) {
      return res.status(403).json({ error: "Only the table leader can lock the table" });
    }
    await pool.query(`
      UPDATE queue_sessions SET locked = $2,
             state = CASE WHEN $2 THEN 'matched' ELSE state END,
             matched_at = CASE WHEN $2 AND matched_at IS NULL THEN NOW() ELSE matched_at END
       WHERE id = $1
    `, [sess.id, on]);
    res.json({ ok: true, locked: on });
  } catch (e) {
    console.error("[queue/lock]", e.message);
    res.status(500).json({ error: "Could not lock the table" });
  }
});

// POST /queue/:id/fill — reopen a short-handed group to the pool.
app.post("/queue/:id/fill", requireAuth, async (req, res) => {
  try {
    await pool.query(`
      UPDATE queue_sessions s SET state = 'searching', matched_at = NULL
      WHERE s.id = $1 AND s.state IN ('matched','searching')
        AND (SELECT COUNT(*) FROM queue_members m
              WHERE m.session_id = s.id AND m.left_at IS NULL) < s.players
    `, [req.params.id]);
    const sess = await _qSession(req.params.id);
    res.json(_qPayload(sess, await _qRoster(req.params.id)));
  } catch (e) {
    console.error("[queue/fill]", e.message);
    res.status(500).json({ error: "Could not reopen the queue" });
  }
});

// POST /queue/:id/search-again — keep who you liked, drop the rest.
app.post("/queue/:id/search-again", requireAuth, async (req, res) => {
  const keep = Array.isArray((req.body || {}).keepUserIds)
    ? req.body.keepUserIds.map(x => parseInt(x, 10)).filter(Boolean)
    : [];
  try {
    // The caller is always kept -- they are the one still searching.
    const keepAll = keep.concat([req.userId]);
    await pool.query(`
      UPDATE queue_members SET left_at = NOW()
      WHERE session_id = $1 AND left_at IS NULL AND NOT (user_id = ANY($2::int[]))
    `, [req.params.id, keepAll]);
    await pool.query(
      "UPDATE queue_sessions SET state = 'searching', matched_at = NULL WHERE id = $1",
      [req.params.id]
    );
    const sess = await _qSession(req.params.id);
    res.json(_qPayload(sess, await _qRoster(req.params.id)));
  } catch (e) {
    console.error("[queue/search-again]", e.message);
    res.status(500).json({ error: "Could not search again" });
  }
});

// POST /queue/:id/convert-to-lobby — make the group permanent.
app.post("/queue/:id/convert-to-lobby", requireAuth, async (req, res) => {
  try {
    const sess = await _qSession(req.params.id);
    if (!sess) return res.status(404).json({ error: "No such queue" });
    if (sess.server_id) {
      // Already converted. Hand back the same lobby rather than making a
      // second one -- two members can press this at the same moment.
      return res.json({ ok: true, serverId: sess.server_id, alreadyConverted: true });
    }
    const members = await _qRoster(sess.id);
    if (!members.length) return res.status(400).json({ error: "Queue is empty" });

    const name = (req.body || {}).name ||
      ((members[0] && members[0].username ? members[0].username + "'s" : "Queue") + " squad");

    const srv = await pool.query(`
      INSERT INTO servers (name, owner_id, description, tags)
      VALUES ($1, $2, $3, $4) RETURNING *
    `, [name, req.userId, "Formed from a queue match.", JSON.stringify([sess.game])]);
    const serverId = srv.rows[0].id;

    for (const m of members) {
      await pool.query(
        "INSERT INTO server_members (server_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [serverId, m.userId]
      ).catch(() => {});
    }

    await pool.query(`
      UPDATE queue_sessions SET server_id = $1, state = 'converted', ended_at = NOW()
      WHERE id = $2
    `, [serverId, sess.id]);

    res.json({ ok: true, serverId, name });
  } catch (e) {
    console.error("[queue/convert-to-lobby]", e.message);
    res.status(500).json({ error: "Could not create the lobby" });
  }
});

// GET /me/queue/match-finder/:userId — the ribbon on a profile.
//
// directMatches: sessions the two of you were both in.
// halfMatches:   people who have queued with BOTH of you -- a shared
//                regular. That is a real, checkable relationship;
//                "nearly matched once" would not be.
app.get("/me/queue/match-finder/:userId", requireAuth, async (req, res) => {
  const other = parseInt(req.params.userId, 10);
  if (!other || other === req.userId) {
    return res.json({ directMatches: 0, halfMatches: 0 });
  }
  try {
    const direct = await pool.query(`
      SELECT COUNT(DISTINCT a.session_id)::int AS n, MAX(s.matched_at) AS last_at
      FROM queue_members a
      JOIN queue_members b ON b.session_id = a.session_id AND b.user_id = $2
      JOIN queue_sessions s ON s.id = a.session_id
      WHERE a.user_id = $1 AND s.matched_at IS NOT NULL
    `, [req.userId, other]);

    const half = await pool.query(`
      WITH mine AS (
        SELECT DISTINCT b.user_id FROM queue_members a
        JOIN queue_members b ON b.session_id = a.session_id AND b.user_id <> a.user_id
        JOIN queue_sessions s ON s.id = a.session_id
        WHERE a.user_id = $1 AND s.matched_at IS NOT NULL
      ), theirs AS (
        SELECT DISTINCT b.user_id FROM queue_members a
        JOIN queue_members b ON b.session_id = a.session_id AND b.user_id <> a.user_id
        JOIN queue_sessions s ON s.id = a.session_id
        WHERE a.user_id = $2 AND s.matched_at IS NOT NULL
      )
      SELECT COUNT(*)::int AS n FROM mine
      WHERE user_id IN (SELECT user_id FROM theirs)
        AND user_id NOT IN ($1, $2)
    `, [req.userId, other]);

    const u = await pool.query("SELECT username FROM users WHERE id = $1", [other]);
    const d = direct.rows[0] || {};
    res.json({
      directMatches: d.n || 0,
      halfMatches: (half.rows[0] || {}).n || 0,
      lastQueuedWith: d.last_at || null,
      lastQueuedWithUsername: (u.rows[0] || {}).username || null,
    });
  } catch (e) {
    console.error("[queue/match-finder]", e.message);
    res.json({ directMatches: 0, halfMatches: 0 });
  }
});

// GET /me/queue/recent — people you were matched with lately, for the
// "recently played with" list on the setup screen.
app.get("/me/queue/recent", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT DISTINCT ON (u.id) u.id, u.username, u.avatar_url, s.game, m2.joined_at
      FROM queue_members m1
      JOIN queue_sessions s ON s.id = m1.session_id
      JOIN queue_members m2 ON m2.session_id = s.id AND m2.user_id <> $1
      JOIN users u ON u.id = m2.user_id
      WHERE m1.user_id = $1 AND s.matched_at IS NOT NULL
      ORDER BY u.id, m2.joined_at DESC
      LIMIT 24
    `, [req.userId]);
    res.json(r.rows.map(x => ({
      id: x.id, userId: x.id, username: x.username,
      avatar_url: x.avatar_url, game: x.game, lastPlayed: x.joined_at,
    })));
  } catch (e) {
    console.error("[me/queue/recent]", e.message);
    res.json([]);
  }
});

// ══════════════════════════════════════════════════════════════════
// HUB ENDPOINTS — Discover and Tournaments
//
// These pages already call all of this and every call is wrapped in
// .catch(() => null), so their absence was invisible: the pages fell
// back to seeded placeholder data and looked like they worked. They
// were showing fiction. These make them show the database.
//
// ORDER MATTERS. Everything two-segment under /tournaments/ MUST be
// declared above /tournaments/:tournamentId or Express matches it as an
// id -- /tournaments/global would look up a tournament called "global".
// That is why this block sits here rather than at the end of the file.
// ══════════════════════════════════════════════════════════════════

// The client speaks LIVE / STARTING / OPEN; the table speaks setup /
// registration / in-progress / completed. One translation, in one place.
function _tourneyStatus(row) {
  const st = String(row.status || "").toLowerCase();
  if (st === "in-progress") return "LIVE";
  if (st === "completed")   return "DONE";
  if (st === "cancelled")   return "CANCELLED";
  if (st === "registration" || st === "setup") {
    const t = row.scheduled_start || row.start_time;
    // "Starting" is a real, checkable claim: inside the next hour.
    if (t && new Date(t).getTime() - Date.now() < 60 * 60 * 1000) return "STARTING";
    return "OPEN";
  }
  return "OPEN";
}

const _TOURNEY_SELECT = `
  SELECT t.*,
    (SELECT COUNT(*)::int FROM tournament_players WHERE tournament_id = t.id) AS entrants,
    -- The first few entrants, for the card that shows who is actually in
    -- a bracket rather than only how many. LIMIT 6 against an indexed
    -- tournament_id, so it costs a fraction of the count above it.
    (SELECT COALESCE(json_agg(f), '[]'::json) FROM (
      SELECT tp.user_id AS id, tp.username, u.avatar_url
      FROM tournament_players tp
      LEFT JOIN users u ON u.id = tp.user_id
      WHERE tp.tournament_id = t.id
      ORDER BY tp.joined_at LIMIT 6
    ) f) AS faces,
    u.username AS host_name,
    s.name     AS lobby_name
  FROM tournaments t
  LEFT JOIN users u ON u.id = t.host_id
  LEFT JOIN servers s ON s.id::text = t.lobby_id
`;

function _tourneyCard(r) {
  return {
    id: r.id,
    name: r.name,
    game: r.game_tag || r.api_game || null,
    status: _tourneyStatus(r),
    entrants: r.entrants || 0,
    faces: (r.faces || []).map(f => ({
      id: f.id, name: f.username || null, avatar: f.avatar_url || null,
    })),
    maxPlayers: r.max_players || r.player_count || null,
    prize: r.prize || null,
    format: r.format,
    host: r.host_name || null,
    lobbyId: r.lobby_id,
    lobbyName: r.lobby_name || null,
    startTime: r.scheduled_start || r.start_time || null,
    createdAt: r.created_at,
    scope: r.scope || 'lobby',
    visibility: r.visibility || 'public',
    /* The code itself is a credential and is never in a browse payload.
       Saying one EXISTS is not sensitive and is what the card needs to
       draw the private badge. _tourneyCardFor() adds the real code for
       the people entitled to it. */
    hasCode: !!r.join_code,
  };
}

/* The same card, plus the join code, for someone entitled to see it:
   the host, or a player already in the bracket. Everyone else gets the
   plain card — a private tournament's code must not leak through a
   listing the way a name or an entrant count can. */
function _tourneyCardFor(row, viewerId, isEntrant) {
  const card = _tourneyCard(row);
  const maySee = viewerId != null &&
    (row.host_id === viewerId || isEntrant === true);
  if (maySee && row.join_code) card.joinCode = row.join_code;
  return card;
}

/* ── Join codes ──────────────────────────────────────────────────
   Four letters then four digits: KRVX4417. Its own code type — the
   lobby invite codes and the queue codes elsewhere in the app have
   different shapes on purpose, so a code pasted into the wrong box
   fails cleanly instead of half-matching something.

   I, O, S and Z are out of the letters and 0 and 1 out of the digits:
   these get read aloud and typed off screenshots, and every pair there
   is a known misread. That leaves 22^4 * 8^4 ≈ 960 million codes, which
   is ample, but the uniqueness that matters is enforced by the partial
   unique index on join_code, not by this arithmetic. */
const _CODE_LETTERS = "ABCDEFGHJKLMNPQRTUVWXY";   // no I, O, S, Z
const _CODE_DIGITS  = "23456789";                 // no 0, 1

function _mintCodeString() {
  const crypto = require("crypto");
  let out = "";
  for (let i = 0; i < 4; i++) {
    out += _CODE_LETTERS[crypto.randomInt(_CODE_LETTERS.length)];
  }
  for (let i = 0; i < 4; i++) {
    out += _CODE_DIGITS[crypto.randomInt(_CODE_DIGITS.length)];
  }
  return out;
}

/* Normalises what a human typed: case, spaces, and the dash people add
   because the UI shows one. "krvx-4417" and "KRVX 4417" are the same
   code, and neither should be a failed lookup. */
function normaliseTourneyCode(raw) {
  const c = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return /^[A-Z]{4}[0-9]{4}$/.test(c) ? c : null;
}

/* Asks the database, rather than assuming. Retries on the unique index
   because that is the only authority on whether a code is free. */
async function mintTourneyCode(tries = 12) {
  for (let i = 0; i < tries; i++) {
    const c = _mintCodeString();
    const r = await pool.query(
      "SELECT 1 FROM tournaments WHERE join_code = $1 LIMIT 1", [c]);
    if (!r.rows.length) return c;
  }
  throw new Error("could not mint a free tournament code");
}

// GET /tournaments/global — every tournament worth showing, across lobbies.
// status=live returns brackets in progress, status=open those still
// taking entrants, anything else both. Filtering server-side matters
// for paging: a client that pulled a mixed page and split it locally
// would have an offset that means nothing for either half.
app.get("/tournaments/global", async (req, res) => {
  try {
    const { limit, offset } = _page(req);
    const want = String(req.query.status || "").toLowerCase();
    const statuses = want === "live" ? ["in-progress"]
                   : want === "open" ? ["setup", "registration"]
                   : ["setup", "registration", "in-progress"];
    const r = await pool.query(_TOURNEY_SELECT +
      ` WHERE t.status = ANY($3::text[])` +
      `   AND ` + _HUB_TOURNEY_WHERE +
      ` ORDER BY (t.status = 'in-progress') DESC, entrants DESC, t.created_at DESC` +
      ` LIMIT $1 OFFSET $2`, [limit, offset, statuses]);
    res.json(r.rows.map(_tourneyCard));
  } catch (e) {
    console.error("[tournaments/global]", e.message);
    res.json([]);   // the hub falls back to its own list rather than breaking
  }
});

// GET /featured/tournaments — the spotlight rotation.
// Ranked by entrants, because "featured" with nothing behind it is just
// a random pick dressed up as editorial.
app.get("/featured/tournaments", async (req, res) => {
  try {
    /* This had no public filter, which meant the spotlight could put a
       private lobby's bracket — its name, its host, its entrants — in
       front of strangers. Same predicate as every other public route. */
    const r = await pool.query(_TOURNEY_SELECT +
      ` WHERE t.status IN ('registration','in-progress')` +
      `   AND ` + _HUB_TOURNEY_WHERE +
      ` ORDER BY entrants DESC, t.created_at DESC LIMIT 6`);
    res.json(r.rows.map(_tourneyCard));
  } catch (e) {
    console.error("[featured/tournaments]", e.message);
    res.json([]);
  }
});

// GET /me/tournaments — hosting or entered.
app.get("/me/tournaments", requireAuth, async (req, res) => {
  try {
    const { limit, offset } = _page(req);
    const r = await pool.query(_TOURNEY_SELECT +
      ` WHERE t.host_id = $1
         OR EXISTS (SELECT 1 FROM tournament_players tp
                     WHERE tp.tournament_id = t.id AND tp.user_id = $1)
       ORDER BY t.created_at DESC LIMIT $2 OFFSET $3`,
      [req.userId, limit, offset]);
    /* Every row here is one the caller hosts or plays in, which is
       exactly the entitlement _tourneyCardFor checks — so this is where
       a private tournament's code legitimately reaches its people. */
    res.json(r.rows.map((row) => Object.assign(
      _tourneyCardFor(row, req.userId, true), { isHost: row.host_id === req.userId }
    )));
  } catch (e) {
    console.error("[me/tournaments]", e.message);
    res.json([]);
  }
});

// How many live tournaments a free account may host at once. The client
// shows this; the server is what enforces it.
const TOURNAMENT_FREE_CAP = Number(process.env.TOURNAMENT_FREE_CAP) || 3;

/* The single answer to "may this person start another one", used by both
   the counter the page shows and the route that creates. Returning the
   REASON as well as the verdict is what lets the page say something
   true — "unlimited, you are a dev" is a different message from "three
   of three used". */
async function tournamentAllowance(userId) {
  const [{ isAdmin, isOverlord }, active, unlimited] = await Promise.all([
    getUserFlags(userId),
    pool.query(
      `SELECT COUNT(*)::int AS n FROM tournaments
        WHERE host_id = $1 AND status IN ('setup','registration','in-progress')`,
      [userId]).then((r) => (r.rows[0] ? r.rows[0].n : 0)),
    /* Ownership must come from the server's own record of what was
       bought, never from the client, because the unlock is a paid
       feature and a client that can claim it can have it for free.

       There is NO purchase table on the server yet — cosmetics live only
       in the client's `me.cosmetics`. So this resolves false for
       everybody today, and the honest consequence is that the unlock
       cannot currently be honoured server-side. That is the safe
       direction to be wrong in: nobody is wrongly granted a paid
       feature, and devs are exempt by flag regardless. When purchases
       are recorded, this query is the one place to point at them. */
    pool.query(
      `SELECT 1 FROM user_cosmetics
        WHERE user_id = $1 AND cosmetic_id = 'feature-tournaments-unlimited'
        LIMIT 1`, [userId])
      .then((r) => r.rows.length > 0)
      .catch(() => false),   /* table does not exist yet -> not owned */
  ]);

  const dev = isAdmin || isOverlord;
  const cap = (dev || unlimited) ? null : TOURNAMENT_FREE_CAP;
  return {
    active,
    cap,
    unlimited: cap === null,
    reason: dev ? "dev" : unlimited ? "unlocked" : "free",
    mayCreate: cap === null || active < cap,
  };
}

// GET /me/tournaments/active-count — for the cap counter.
app.get("/me/tournaments/active-count", requireAuth, async (req, res) => {
  try {
    const a = await tournamentAllowance(req.userId);
    /* `count` stays for older clients that only read that. */
    res.json({ count: a.active, cap: a.cap, unlimited: a.unlimited,
               reason: a.reason, mayCreate: a.mayCreate });
  } catch (e) {
    console.error("[me/tournaments/active-count]", e.message);
    res.json({ count: 0 });
  }
});

// GET /tournaments/me/stats — the player banner.
//
// Every number here is counted from the tables. The client is explicit
// that it renders an honest zero rather than a mock, so anything this
// cannot prove is returned as null, not invented. tier and rankLabel are
// null for that reason: there is no tournament ranking system yet, and a
// made-up "Gold III" would be exactly the fiction that comment warns
// against.
app.get("/tournaments/me/stats", requireAuth, async (req, res) => {
  const empty = {
    tier: null, rankLabel: null,
    wins: 0, losses: 0, tournaments: 0, won: 0,
    bestFinish: null, streak: 0, recent: null,
  };
  try {
    const q = await pool.query(`
      WITH mine AS (
        SELECT id, tournament_id, status FROM tournament_players WHERE user_id = $1
      )
      SELECT
        (SELECT COUNT(*)::int FROM mine) AS tournaments,
        (SELECT COUNT(*)::int FROM mine WHERE status = 'winner') AS won,
        (SELECT COUNT(*)::int FROM tournament_matches m
           WHERE m.winner_id IN (SELECT id FROM mine)) AS wins,
        (SELECT COUNT(*)::int FROM tournament_matches m
           WHERE m.status = 'completed' AND m.winner_id IS NOT NULL
             AND (m.player1_id IN (SELECT id FROM mine) OR m.player2_id IN (SELECT id FROM mine))
             AND m.winner_id NOT IN (SELECT id FROM mine)) AS losses
    `, [req.userId]);

    const row = q.rows[0] || {};
    const recentQ = await pool.query(`
      SELECT t.name, t.id, tp.status
      FROM tournament_players tp JOIN tournaments t ON t.id = tp.tournament_id
      WHERE tp.user_id = $1 ORDER BY tp.joined_at DESC LIMIT 1
    `, [req.userId]);

    res.json({
      tier: null, rankLabel: null,
      wins: row.wins || 0,
      losses: row.losses || 0,
      tournaments: row.tournaments || 0,
      won: row.won || 0,
      bestFinish: (row.won || 0) > 0 ? "Winner" : null,
      streak: 0,
      recent: recentQ.rows[0] || null,
    });
  } catch (e) {
    console.error("[tournaments/me/stats]", e.message);
    res.json(empty);
  }
});

// ── Discover ──────────────────────────────────────────────────────

// A lobby is public when it has tags -- the same rule /servers/search
// already uses, kept identical so the two cannot disagree about what
// "discoverable" means.
const _PUBLIC_LOBBY_WHERE =
  "s.tags IS NOT NULL AND s.tags::text NOT IN ('[]','','null')";

// A tournament is exactly as public as the lobby holding it. Discover
// is a browse surface for strangers, so a bracket run inside a private
// lobby must not appear on it -- its name, its host and its entrant
// list are all as private as the room they are in.
//
// Deliberately NOT folded into _TOURNEY_SELECT. That constant also
// backs a lobby's own tournament list, where members are entitled to
// see their own private brackets; this belongs only to the routes that
// serve the public.
//
// lobby_id is TEXT NOT NULL so every tournament has one, and the join
// in _TOURNEY_SELECT is a LEFT JOIN -- a lobby_id pointing at a row
// that no longer exists yields NULL tags and is excluded, which is the
// safe direction to fail.
// What the TOURNAMENTS HUB lists: its own tournaments, the public ones.
// A code-private tournament is reachable only through its code, and a
// lobby tournament never appears here at all.
const _HUB_TOURNEY_WHERE =
  "t.scope = 'global' AND t.visibility = 'public'";

// What DISCOVER may show a stranger: a bracket in a public lobby (the
// original rule, unchanged) or a public hub tournament. Both are things
// their owner chose to make browsable; nothing else is.
const _PUBLIC_TOURNEY_WHERE =
  "((t.scope = 'lobby' AND " + _PUBLIC_LOBBY_WHERE + ") OR (" + _HUB_TOURNEY_WHERE + "))";

// Shared paging for the browse endpoints. Caps the page so a caller
// cannot ask for the whole table, and floors the offset so a negative
// one cannot walk backwards off the start.
function _page(req, def = 50, max = 100) {
  const limit  = Math.min(max, Math.max(1, parseInt(req.query.limit, 10)  || def));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  return { limit, offset };
}

function _lobbyCard(s) {
  let tags = [];
  try { tags = Array.isArray(s.tags) ? s.tags : JSON.parse(s.tags || "[]"); }
  catch (e) { tags = String(s.tags || "").split(",").map(x => x.trim()).filter(Boolean); }
  return {
    id: s.id,
    name: s.name,
    tag: tags[0] || null,
    tags,
    members: s.member_count || 0,
    // online is deliberately ABSENT, not zero. Presence lives in the
    // websocket process, not this one, so this service genuinely does
    // not know it -- and "0 online" beside a live pulsing dot is a
    // confident claim that nobody is there. The card renders an
    // em-dash when the field is missing, which is the truth.
    cover: s.banner_url || s.icon_url || "",
    icon: s.icon_url || "",
    fallback: "linear-gradient(135deg,#2a2d3a,#15161e)",
    initial: String(s.name || "?").charAt(0).toUpperCase(),
    description: s.description || "",
    faces: (s.faces || []).map(f => ({
      id: f.id,
      name: f.display_name || f.username || null,
      avatar: f.avatar_url || null,
    })),
    badge: null,
  };
}

// GET /lobbies/public — the Discover grid.
app.get("/lobbies/public", async (req, res) => {
  try {
    const { limit, offset } = _page(req);
    const r = await pool.query(`
      SELECT s.*,
        (SELECT COUNT(*)::int FROM server_members WHERE server_id = s.id) AS member_count,
        -- Who is actually in there. Owner and moderators first so the
        -- faces on the card are the people you would meet, not whoever
        -- happened to join first.
        (SELECT COALESCE(json_agg(f), '[]'::json) FROM (
          SELECT u.id, u.username, u.display_name, u.avatar_url
          FROM server_members sm
          JOIN users u ON u.id = sm.user_id
          WHERE sm.server_id = s.id
          -- sm.id, not a timestamp. db.js declares this table with a
          -- joined_at column but the live table predates it and has
          -- created_at instead, and CREATE TABLE IF NOT EXISTS never
          -- reconciles an existing table. id is SERIAL, so ascending id
          -- IS join order, and it is the one column both versions have.
          ORDER BY CASE sm.role WHEN 'owner' THEN 0 WHEN 'moderator' THEN 1 ELSE 2 END,
                   sm.id
          LIMIT 6
        ) f) AS faces
      FROM servers s
      WHERE ` + _PUBLIC_LOBBY_WHERE + `
      ORDER BY member_count DESC, s.created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);
    res.json(r.rows.map(_lobbyCard));
  } catch (e) {
    console.error("[lobbies/public]", e.message);
    res.json([]);
  }
});

// GET /featured/spotlight — one editorial pick for the carousel.
//
// There is no curation table, so rather than pretend there is, this
// returns the most defensible real thing: the busiest live tournament,
// or failing that the largest public lobby. It is honest about which,
// via `kind`, and returns nothing at all when there is nothing worth
// featuring -- the client then falls through to its own recommendation.
app.get("/featured/spotlight", async (req, res) => {
  try {
    const t = await pool.query(_TOURNEY_SELECT +
      ` WHERE t.status = 'in-progress' AND ` + _PUBLIC_TOURNEY_WHERE +
      ` ORDER BY entrants DESC LIMIT 1`);
    if (t.rows.length && (t.rows[0].entrants || 0) > 0) {
      return res.json(Object.assign(_tourneyCard(t.rows[0]), { kind: "tournament" }));
    }
    const l = await pool.query(`
      SELECT s.*,
        (SELECT COUNT(*)::int FROM server_members WHERE server_id = s.id) AS member_count
      FROM servers s
      WHERE ` + _PUBLIC_LOBBY_WHERE + `
      ORDER BY member_count DESC LIMIT 1
    `);
    if (l.rows.length) {
      return res.json(Object.assign(_lobbyCard(l.rows[0]), { kind: "lobby" }));
    }
    res.json(null);
  } catch (e) {
    console.error("[featured/spotlight]", e.message);
    res.json(null);
  }
});

// GET /tournaments/code/:code — resolve a private tournament's code.
//
// Thin on purpose. It answers one question, for one exact code, and it
// gives the same answer for "no such code" and "that code is not a
// private hub tournament" -- a caller able to tell those apart could
// walk the code space and learn which brackets exist.
//
// A correct code is proof of invitation, so this returns the tournament
// itself; entering it still goes through /register like any other.
app.get("/tournaments/code/:code", async (req, res) => {
  try {
    const code = normaliseTourneyCode(req.params.code);
    if (!code) return res.status(404).json({ error: "No tournament with that code" });

    const r = await pool.query(_TOURNEY_SELECT +
      ` WHERE t.join_code = $1 AND t.scope = 'global' LIMIT 1`, [code]);
    if (!r.rows.length) return res.status(404).json({ error: "No tournament with that code" });

    res.json(_tourneyCard(r.rows[0]));
  } catch (e) {
    console.error("[tournaments/code]", e.message);
    res.status(404).json({ error: "No tournament with that code" });
  }
});

// ══════════════════════════════════════════════════════════════════
// MAJORS -- real-world events, curated.
//
// Evo, CEO, ECW, championship finals. These are NOT run here: there is
// no bracket, no entrant list and no way to join. What the app can
// honestly offer is "this is on, here is when, here is where to watch",
// plus a follow so it can remind you.
//
// Nothing seeds this table and nothing here invents a fixture. Until
// real events are entered, GET /majors returns [] and the rail hides
// itself. Writes are admin-only.
// ══════════════════════════════════════════════════════════════════

function _majorCard(r) {
  return {
    id: r.id,
    name: r.name,
    game: r.game || null,
    organiser: r.organiser || null,
    location: r.location || null,
    startsAt: r.starts_at || null,
    endsAt: r.ends_at || null,
    url: r.url || null,
    streamUrl: r.stream_url || null,
    art: r.art_url || null,
    tier: r.tier || "major",
    followers: r.followers || 0,
  };
}

/* The app never needs to know whether a row is published -- it only
   ever receives published ones -- or how it is weighted. The screen
   that sets those does. */
function _majorAdminCard(r) {
  return Object.assign(_majorCard(r), {
    published: !!r.is_published,
    sortOrder: r.sort_order || 0,
  });
}

// GET /majors -- what is on, live first, then soonest.
//
// "Live" is computed from the window rather than stored as a flag, so
// nobody has to remember to flip it. An event with no end date is live
// for the day it starts.
app.get("/majors", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT m.*,
        (SELECT COUNT(*)::int FROM major_follows f WHERE f.major_id = m.id) AS followers,
        (m.starts_at IS NOT NULL AND m.starts_at <= NOW()
          AND COALESCE(m.ends_at, m.starts_at + INTERVAL '1 day') >= NOW()) AS is_live
      FROM majors m
      WHERE m.is_published = TRUE
        AND COALESCE(m.ends_at, m.starts_at, NOW()) >= NOW() - INTERVAL '1 day'
      ORDER BY is_live DESC, m.sort_order DESC, m.starts_at ASC NULLS LAST
      LIMIT 12`);
    res.json(r.rows.map((row) => Object.assign(_majorCard(row), { live: !!row.is_live })));
  } catch (e) {
    console.error("[majors]", e.message);
    res.json([]);   // an empty rail is correct here, not an error state
  }
});

// GET /majors/following -- ids only. Kept separate from /majors so that
// route can stay unauthenticated and cacheable.
app.get("/majors/following", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT major_id FROM major_follows WHERE user_id = $1", [req.userId]);
    res.json(r.rows.map((x) => x.major_id));
  } catch (e) {
    console.error("[majors/following]", e.message);
    res.json([]);
  }
});

app.post("/majors/:id/follow", requireAuth, async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO major_follows (major_id, user_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`, [req.params.id, req.userId]);
    res.json({ following: true });
  } catch (e) {
    console.error("[majors/follow]", e.message);
    res.status(500).json({ error: "Could not follow that event" });
  }
});

app.delete("/majors/:id/follow", requireAuth, async (req, res) => {
  try {
    await pool.query(
      "DELETE FROM major_follows WHERE major_id = $1 AND user_id = $2",
      [req.params.id, req.userId]);
    res.json({ following: false });
  } catch (e) {
    console.error("[majors/unfollow]", e.message);
    res.status(500).json({ error: "Could not unfollow that event" });
  }
});

// GET /admin/majors — everything, drafts and finished included.
//
// Deliberately not a query flag on /majors. That route is public and
// unauthenticated; giving it a parameter that reveals unpublished rows
// would mean one misplaced `if` exposes editorial drafts to everyone.
// A separate route behind requireAdmin cannot be got wrong that way.
app.get("/admin/majors", requireAuth, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT m.*,
        (SELECT COUNT(*)::int FROM major_follows f WHERE f.major_id = m.id) AS followers
      FROM majors m
      ORDER BY m.is_published DESC, m.starts_at DESC NULLS LAST, m.id DESC`);
    res.json(r.rows.map(_majorAdminCard));
  } catch (e) {
    console.error("[admin/majors]", e.message);
    res.status(500).json({ error: "Could not load the events" });
  }
});

// ══════════════════════════════════════════════════════════════════
// STREAM DISCOVERY
//
// Finds what is actually live across the channels worth watching, and
// what is scheduled next when nothing is. See the notes on quota in the
// poller: RSS is free and does the finding, videos.list costs 1 unit a
// call and does the confirming.
// ══════════════════════════════════════════════════════════════════
const YT_KEY = process.env.YOUTUBE_API_KEY || "";
const _POLL_EVERY_MS = 5 * 60 * 1000;
let _pollTimer = null;
let _pollRunning = false;

/* Pull recent video ids off a channel's public feed. Free, unauthenticated,
   and no quota — which is the whole reason the poller can run at all. */
async function _ytRecentIds(channelId) {
  const axios = require("axios");
  const url = "https://www.youtube.com/feeds/videos.xml?channel_id=" +
              encodeURIComponent(channelId);
  const r = await axios.get(url, { timeout: 8000, responseType: "text" });
  const ids = [];
  const re = /<yt:videoId>([\w-]{6,})<\/yt:videoId>/g;
  let m;
  while ((m = re.exec(r.data)) && ids.length < 15) ids.push(m[1]);
  return ids;
}

/* One call, up to fifty ids, one quota unit. Returns only the ones that
   are live or scheduled — a finished upload is not something to show. */
async function _ytLiveInfo(ids) {
  if (!ids.length || !YT_KEY) return [];
  const axios = require("axios");
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const r = await axios.get("https://www.googleapis.com/youtube/v3/videos", {
      timeout: 10000,
      params: {
        part: "snippet,liveStreamingDetails",
        id: chunk.join(","),
        key: YT_KEY,
      },
    });
    for (const v of (r.data && r.data.items) || []) {
      const state = v.snippet && v.snippet.liveBroadcastContent;
      if (state !== "live" && state !== "upcoming") continue;
      const d = v.liveStreamingDetails || {};
      const th = (v.snippet.thumbnails || {});
      out.push({
        videoId: v.id,
        channelId: v.snippet.channelId,
        title: v.snippet.title,
        thumb: (th.maxres || th.standard || th.high || th.medium || th.default || {}).url || null,
        state,
        scheduledAt: d.scheduledStartTime || d.actualStartTime || null,
        viewers: d.concurrentViewers ? Number(d.concurrentViewers) : null,
      });
    }
  }
  return out;
}

async function pollStreamSources() {
  if (!YT_KEY || _pollRunning) return;
  _pollRunning = true;
  try {
    const src = await pool.query(
      `SELECT id, channel_id FROM stream_sources
         WHERE is_enabled = TRUE AND platform = 'youtube'`);
    if (!src.rows.length) return;

    const byChannel = new Map();
    const allIds = [];
    for (const row of src.rows) {
      byChannel.set(row.channel_id, row.id);
      try {
        const ids = await _ytRecentIds(row.channel_id);
        allIds.push(...ids);
        await pool.query(
          "UPDATE stream_sources SET last_checked_at = NOW(), last_error = NULL WHERE id = $1",
          [row.id]);
      } catch (e) {
        /* One dead channel must not stop the cycle, but it should be
           visible in the admin screen rather than silently skipped. */
        await pool.query(
          "UPDATE stream_sources SET last_checked_at = NOW(), last_error = $2 WHERE id = $1",
          [row.id, String(e.message || e).slice(0, 200)]).catch(() => {});
      }
    }

    const found = await _ytLiveInfo(allIds);

    /* Replace rather than merge: a stream that has ENDED simply stops
       appearing in the feed, so anything not in this pass is over. */
    await pool.query("DELETE FROM stream_cache");
    for (const f of found) {
      const sid = byChannel.get(f.channelId);
      if (!sid) continue;
      await pool.query(`
        INSERT INTO stream_cache (source_id, video_id, title, thumb_url, state, scheduled_at, viewers, fetched_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
        ON CONFLICT (source_id, video_id) DO UPDATE SET
          title = EXCLUDED.title, thumb_url = EXCLUDED.thumb_url,
          state = EXCLUDED.state, scheduled_at = EXCLUDED.scheduled_at,
          viewers = EXCLUDED.viewers, fetched_at = NOW()`,
        [sid, f.videoId, f.title, f.thumb, f.state,
         f.scheduledAt ? new Date(f.scheduledAt) : null, f.viewers]).catch(() => {});
    }
    console.log("[streams] polled " + src.rows.length + " sources, " +
                found.length + " live/upcoming");
  } catch (e) {
    console.error("[streams/poll]", e.message);
  } finally {
    _pollRunning = false;
  }
}

if (YT_KEY) {
  /* A short delay so a cold boot serves requests before it starts
     fetching thirty feeds. */
  setTimeout(pollStreamSources, 15000);
  _pollTimer = setInterval(pollStreamSources, _POLL_EVERY_MS);
} else {
  console.log("[streams] YOUTUBE_API_KEY not set — discovery is off, " +
              "the stage falls back to curated majors");
}

// GET /arena/stage — what to play, in the order to play it.
//
// One endpoint so the client does not have to merge two feeds and pick a
// winner. Live first, ordered by audience; then whatever is scheduled
// soonest, which is the "if nothing is live, show the next one up" rule.
// Discovered streams and curated majors are the same shape here, tagged
// with `kind` so the page can say which it is.
app.get("/arena/stage", async (req, res) => {
  try {
    const out = [];

    const disc = await pool.query(`
      SELECT c.*, s.name AS source_name, s.game, s.organiser, s.weight, s.platform
      FROM stream_cache c JOIN stream_sources s ON s.id = c.source_id
      WHERE s.is_enabled = TRUE
      ORDER BY (c.state = 'live') DESC, c.viewers DESC NULLS LAST,
               c.scheduled_at ASC NULLS LAST
      LIMIT 20`).catch(() => ({ rows: [] }));

    for (const r of disc.rows) {
      out.push({
        kind: "stream",
        id: "yt:" + r.video_id,
        live: r.state === "live",
        name: r.title,
        game: r.game || null,
        organiser: r.organiser || r.source_name || null,
        platform: r.platform || "youtube",
        videoId: r.video_id,
        art: r.thumb_url || null,
        startsAt: r.scheduled_at || null,
        viewers: r.viewers || null,
        url: "https://www.youtube.com/watch?v=" + r.video_id,
        weight: r.weight || 0,
      });
    }

    /* Curated majors sit alongside, not underneath: a hand-entered event
       that is on right now outranks a discovered stream that is not. */
    const maj = await pool.query(`
      SELECT m.*,
        (SELECT COUNT(*)::int FROM major_follows f WHERE f.major_id = m.id) AS followers,
        (m.starts_at IS NOT NULL AND m.starts_at <= NOW()
          AND COALESCE(m.ends_at, m.starts_at + INTERVAL '1 day') >= NOW()) AS is_live
      FROM majors m
      WHERE m.is_published = TRUE
        AND COALESCE(m.ends_at, m.starts_at, NOW()) >= NOW() - INTERVAL '1 day'
      ORDER BY is_live DESC, m.sort_order DESC, m.starts_at ASC NULLS LAST
      LIMIT 12`).catch(() => ({ rows: [] }));

    for (const r of maj.rows) {
      out.push(Object.assign(_majorCard(r), {
        kind: "major",
        live: !!r.is_live,
        videoId: null,
        weight: r.sort_order || 0,
      }));
    }

    /* One ordering over both. Live wins; among the live, editorial weight
       then audience; among the rest, soonest first — and anything with no
       date at all goes last rather than being treated as imminent. */
    out.sort((a, b) => {
      if (a.live !== b.live) return a.live ? -1 : 1;
      if (a.live) {
        if ((b.weight || 0) !== (a.weight || 0)) return (b.weight || 0) - (a.weight || 0);
        return (b.viewers || 0) - (a.viewers || 0);
      }
      const ta = a.startsAt ? new Date(a.startsAt).getTime() : Infinity;
      const tb = b.startsAt ? new Date(b.startsAt).getTime() : Infinity;
      return ta - tb;
    });

    res.json(out.slice(0, 16));
  } catch (e) {
    console.error("[arena/stage]", e.message);
    res.json([]);
  }
});

// ── Admin: the channels being watched ─────────────────────────────
app.get("/admin/stream-sources", requireAuth, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT s.*,
        (SELECT COUNT(*)::int FROM stream_cache c
           WHERE c.source_id = s.id AND c.state = 'live') AS live_now
      FROM stream_sources s ORDER BY s.weight DESC, s.name ASC`);
    res.json(r.rows.map((x) => ({
      id: x.id, platform: x.platform, channelId: x.channel_id,
      name: x.name, game: x.game, organiser: x.organiser,
      weight: x.weight || 0, enabled: !!x.is_enabled,
      lastCheckedAt: x.last_checked_at, lastError: x.last_error,
      liveNow: x.live_now || 0,
    })));
  } catch (e) {
    console.error("[admin/stream-sources]", e.message);
    res.status(500).json({ error: "Could not load the sources" });
  }
});

app.post("/admin/stream-sources", requireAuth, requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const given = String(b.channel || b.channelId || "").trim();
    if (!given) return res.status(400).json({ error: "Paste a channel URL, @handle or ID." });

    /* Resolved rather than demanded. A UC id passes straight through, a
       URL or @handle is looked up — one quota unit either way. Storing
       an unresolved handle would create a source that silently never
       polls, which is the failure this replaces. */
    let found = null;
    try {
      found = await _ytLookupChannel(given);
    } catch (e) {
      return res.status(500).json({
        error: String(e.message || "").indexOf("YOUTUBE_API_KEY") >= 0
          ? "YOUTUBE_API_KEY is not set on the server, so channels cannot be looked up."
          : "Could not reach YouTube to look that channel up.",
      });
    }
    if (!found) {
      return res.status(404).json({
        error: "No channel found for that. Paste the channel URL, its @handle, or its UC… id.",
      });
    }
    const channelId = found.channelId;
    const r = await pool.query(`
      INSERT INTO stream_sources (platform, channel_id, name, game, organiser, weight, is_enabled)
      VALUES ('youtube',$1,$2,$3,$4,$5,$6)
      ON CONFLICT (platform, channel_id) DO UPDATE SET
        name = EXCLUDED.name, game = EXCLUDED.game,
        organiser = EXCLUDED.organiser, weight = EXCLUDED.weight,
        is_enabled = EXCLUDED.is_enabled
      RETURNING *`,
      [channelId, (b.name || found.title || null), b.game || null,
       b.organiser || null, Number(b.weight) || 0, b.enabled !== false]);
    /* Poll straight away so a source added now shows something now,
       rather than at the top of the next five-minute cycle. */
    setTimeout(pollStreamSources, 500);
    res.status(201).json({
      id: r.rows[0].id, channelId, name: r.rows[0].name,
      title: found.title, thumb: found.thumb,
    });
  } catch (e) {
    console.error("[admin/stream-sources/create]", e.message);
    res.status(500).json({ error: "Could not save that source" });
  }
});

// POST /admin/stream-sources/bulk { items:[{channel,game,organiser,weight}] }
//
// Resolves each one and reports per item. Deliberately not atomic: if
// forty-six of fifty resolve, those forty-six are worth having, and the
// four that did not are worth naming.
app.post("/admin/stream-sources/bulk", requireAuth, requireAdmin, async (req, res) => {
  const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: "Nothing to add." });
  if (items.length > 100) return res.status(400).json({ error: "Too many at once — 100 max." });
  if (!YT_KEY) return res.status(400).json({ error: "YOUTUBE_API_KEY is not set on the server." });

  const added = [], failed = [];
  for (const it of items) {
    const given = String((it && (it.channel || it.channelId)) || "").trim();
    if (!given) { failed.push({ channel: "(blank)", reason: "no channel given" }); continue; }
    try {
      const found = await _ytLookupChannel(given);
      if (!found) { failed.push({ channel: given, reason: "no such channel" }); continue; }
      await pool.query(`
        INSERT INTO stream_sources (platform, channel_id, name, game, organiser, weight, is_enabled)
        VALUES ('youtube',$1,$2,$3,$4,$5,TRUE)
        ON CONFLICT (platform, channel_id) DO UPDATE SET
          name = COALESCE(stream_sources.name, EXCLUDED.name),
          game = COALESCE(EXCLUDED.game, stream_sources.game),
          organiser = COALESCE(EXCLUDED.organiser, stream_sources.organiser)`,
        [found.channelId, (it.name || found.title || null), it.game || null,
         it.organiser || null, Number(it.weight) || 0]);
      added.push({ channel: given, channelId: found.channelId, title: found.title });
    } catch (e) {
      failed.push({ channel: given, reason: String(e.message || "lookup failed").slice(0, 120) });
    }
  }

  /* Poll once at the end rather than per item. */
  if (added.length) setTimeout(pollStreamSources, 800);
  res.json({ added: added.length, failed: failed.length, addedList: added, failedList: failed });
});

app.delete("/admin/stream-sources/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM stream_sources WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Could not delete that source" });
  }
});

app.post("/admin/stream-sources/poll", requireAuth, requireAdmin, async (req, res) => {
  if (!YT_KEY) return res.status(400).json({ error: "YOUTUBE_API_KEY is not set on the server" });
  await pollStreamSources();
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════
// LINK A YOUTUBE CHANNEL BY PROVING YOU CAN EDIT IT
//
// The same shape as the Chess verification above: issue a code, the
// owner puts it somewhere only an owner can put it, we read it back
// from public data. Uses YOUTUBE_API_KEY — the key discovery already
// needs — so there is no consent screen, no Google review, no test-user
// list and nothing that expires.
// ══════════════════════════════════════════════════════════════════

/* One quota unit per call, whichever form the caller gave us. forHandle
   takes @name, id takes a UC…, and a full URL is reduced to one of
   those first so people can paste whatever they have to hand. */
async function _ytLookupChannel(input) {
  if (!YT_KEY) throw new Error("YOUTUBE_API_KEY is not set on the server");
  const axios = require("axios");
  const raw = String(input || "").trim();

  let params = null;
  const byId = raw.match(/(UC[\w-]{20,24})/);
  const byHandle = raw.match(/@([\w.-]{3,})/);
  if (byId) params = { id: byId[1] };
  else if (byHandle) params = { forHandle: "@" + byHandle[1] };
  else if (/^[\w.-]{3,}$/.test(raw)) params = { forHandle: "@" + raw };
  if (!params) return null;

  const r = await axios.get("https://www.googleapis.com/youtube/v3/channels", {
    timeout: 10000,
    params: Object.assign({ part: "snippet", key: YT_KEY }, params),
  });
  const item = r.data && r.data.items && r.data.items[0];
  if (!item) return null;
  return {
    channelId: item.id,
    title: (item.snippet && item.snippet.title) || item.id,
    handle: (item.snippet && item.snippet.customUrl) || null,
    description: (item.snippet && item.snippet.description) || "",
    thumb: (item.snippet && item.snippet.thumbnails &&
      (item.snippet.thumbnails.medium || item.snippet.thumbnails.default) || {}).url || null,
  };
}

/* Unambiguous alphabet, same reasoning as the tournament codes: this
   gets copied by hand between two windows. */
function _ytMakeCode() {
  const crypto = require("crypto");
  const A = "ABCDEFGHJKLMNPQRTUVWXY23456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += A[crypto.randomInt(A.length)];
  return "LOBBY-" + out;
}

// POST /me/streams/youtube/start { channel } — find it, issue a code.
app.post("/me/streams/youtube/start", requireAuth, async (req, res) => {
  try {
    const found = await _ytLookupChannel(req.body && req.body.channel);
    if (!found) {
      return res.status(404).json({
        error: "No channel found. Paste your channel URL, your @handle, or your UC… id.",
      });
    }

    /* Someone else having already PROVED this channel is theirs ends it
       here: one channel, one owner. An unproven claim does not block. */
    const taken = await pool.query(
      `SELECT user_id FROM user_streams
        WHERE platform = 'youtube' AND channel_id = $1 AND verified = TRUE
          AND user_id <> $2 LIMIT 1`, [found.channelId, req.userId]);
    if (taken.rows.length) {
      return res.status(409).json({ error: "That channel is already linked to another account." });
    }

    const code = _ytMakeCode();
    await pool.query(`
      INSERT INTO user_streams (user_id, platform, channel_id, handle, url, verified,
                                verify_code, verify_expires_at)
      VALUES ($1,'youtube',$2,$3,$4,FALSE,$5, NOW() + INTERVAL '2 hours')
      ON CONFLICT (user_id, platform, channel_id) DO UPDATE SET
        handle = EXCLUDED.handle, url = EXCLUDED.url,
        verify_code = EXCLUDED.verify_code,
        verify_expires_at = EXCLUDED.verify_expires_at`,
      [req.userId, found.channelId, found.handle || found.title,
       "https://www.youtube.com/channel/" + found.channelId, code]);

    res.json({
      channelId: found.channelId, title: found.title,
      handle: found.handle, thumb: found.thumb, code,
    });
  } catch (e) {
    console.error("[youtube/start]", e.message);
    res.status(500).json({ error: e.message.indexOf("YOUTUBE_API_KEY") >= 0
      ? "YouTube lookups are not configured on the server yet."
      : "Could not look that channel up." });
  }
});

// POST /me/streams/youtube/check — read the description back.
app.post("/me/streams/youtube/check", requireAuth, async (req, res) => {
  try {
    const row = await pool.query(
      `SELECT id, channel_id, verify_code, verify_expires_at FROM user_streams
        WHERE user_id = $1 AND platform = 'youtube' AND verify_code IS NOT NULL
        ORDER BY id DESC LIMIT 1`, [req.userId]);
    if (!row.rows.length) {
      return res.status(400).json({ error: "Start the link first." });
    }
    const v = row.rows[0];
    if (v.verify_expires_at && new Date(v.verify_expires_at) < new Date()) {
      return res.status(400).json({ error: "That code expired. Start again for a fresh one." });
    }

    const found = await _ytLookupChannel(v.channel_id);
    if (!found) return res.status(404).json({ error: "Could not read that channel." });

    if (found.description.indexOf(v.verify_code) < 0) {
      return res.status(409).json({
        verified: false,
        error: "The code is not in the channel description yet. YouTube can take a minute to publish an edit.",
      });
    }

    /* Proved. The code is cleared so the description can go back to
       normal — it was a one-time demonstration, not a permanent tag. */
    await pool.query(
      `UPDATE user_streams SET verified = TRUE, verify_code = NULL,
              verify_expires_at = NULL, handle = $2 WHERE id = $1`,
      [v.id, found.handle || found.title]);

    res.json({ verified: true, channelId: found.channelId, title: found.title });
  } catch (e) {
    console.error("[youtube/check]", e.message);
    res.status(500).json({ error: "Could not check that channel." });
  }
});

// ══════════════════════════════════════════════════════════════════
// SIGN IN WITH GOOGLE -> LINK YOUR YOUTUBE CHANNEL
//
// Needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, and the callback
// below registered as an authorised redirect URI on the Google Cloud
// OAuth client. Without those the endpoints say so plainly rather than
// bouncing the user to a broken consent screen.
// ══════════════════════════════════════════════════════════════════
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ||
  "https://lobby-auth-server.onrender.com").replace(/\/+$/, "");
const YT_REDIRECT = PUBLIC_BASE_URL + "/youtube/callback";

/* The page the browser tab lands on at the end. Plain, self-closing,
   and it never echoes anything the caller supplied. */
function _ytDone(title, detail, ok) {
  const esc = (x) => String(x == null ? "" : x)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>` +
    `<body style="background:#0d0a10;color:#fff;font-family:system-ui,sans-serif;` +
    `display:grid;place-content:center;height:100vh;margin:0;text-align:center;gap:10px">` +
    `<div style="font-size:34px">${ok ? "\u2713" : "\u2717"}</div>` +
    `<h1 style="margin:0;font-size:19px">${esc(title)}</h1>` +
    `<p style="margin:0;opacity:.7;font-size:13px;max-width:44ch">${esc(detail)}</p>` +
    `<p style="margin:8px 0 0;opacity:.4;font-size:11px">You can close this window.</p>` +
    `<script>setTimeout(function(){window.close()},${ok ? 2500 : 6000})<\/script>`;
}

// GET /youtube/auth?token=<jwt> — start the flow.
//
// The token comes in the query because this URL is opened in a browser,
// which cannot set an Authorization header. It is verified immediately
// and exchanged for a short-lived state; the long-lived token never
// travels to Google.
app.get("/youtube/auth", async (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.status(500).send(_ytDone("Not configured",
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set on the server.", false));
  }
  let userId = null;
  try {
    const raw = String(req.query.token || "");
    if (raw) userId = jwt.verify(raw, SECRET).id;
  } catch (e) { userId = null; }
  if (!userId) return res.status(401).send(_ytDone("Not signed in",
    "Open this from the app so it knows who you are.", false));

  /* Signed and short-lived. This is the whole defence against someone
     forging a callback for an account that is not theirs. */
  const state = jwt.sign({ id: userId, k: "yt" }, SECRET, { expiresIn: "5m" });

  const url = "https://accounts.google.com/o/oauth2/v2/auth" +
    "?client_id=" + encodeURIComponent(GOOGLE_CLIENT_ID) +
    "&redirect_uri=" + encodeURIComponent(YT_REDIRECT) +
    "&response_type=code" +
    /* readonly: enough to read which channel this account owns, and
       nothing that could post, delete or change anything. */
    "&scope=" + encodeURIComponent("https://www.googleapis.com/auth/youtube.readonly") +
    "&access_type=offline&include_granted_scopes=true&prompt=consent" +
    "&state=" + encodeURIComponent(state);
  res.redirect(url);
});

// GET /youtube/callback — Google comes back here.
app.get("/youtube/callback", async (req, res) => {
  const axios = require("axios");
  try {
    if (req.query.error) {
      return res.send(_ytDone("Not linked", "You cancelled the Google sign-in.", false));
    }
    let userId = null;
    try {
      const st = jwt.verify(String(req.query.state || ""), SECRET);
      if (st && st.k === "yt") userId = st.id;
    } catch (e) { userId = null; }
    if (!userId) {
      return res.status(400).send(_ytDone("Link expired",
        "That sign-in took too long or did not start here. Try again from the app.", false));
    }

    const code = String(req.query.code || "");
    if (!code) return res.status(400).send(_ytDone("Not linked", "Google sent no code back.", false));

    const tok = await axios.post("https://oauth2.googleapis.com/token", null, {
      timeout: 12000,
      params: {
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: YT_REDIRECT,
        grant_type: "authorization_code",
      },
    });
    const access = tok.data && tok.data.access_token;
    if (!access) return res.status(502).send(_ytDone("Not linked",
      "Google did not return an access token.", false));

    /* mine=true is the point of the whole flow: the channel is the one
       the signed-in account actually owns, so the link is proof rather
       than a claim. */
    const ch = await axios.get("https://www.googleapis.com/youtube/v3/channels", {
      timeout: 12000,
      headers: { Authorization: "Bearer " + access },
      params: { part: "snippet", mine: "true" },
    });
    const item = ch.data && ch.data.items && ch.data.items[0];
    if (!item) {
      return res.send(_ytDone("No channel on that account",
        "That Google account does not have a YouTube channel yet. Create one, then link again.", false));
    }

    const channelId = item.id;
    const handle = (item.snippet && (item.snippet.customUrl || item.snippet.title)) || channelId;
    const expires = tok.data.expires_in
      ? new Date(Date.now() + Number(tok.data.expires_in) * 1000) : null;

    await pool.query(`
      INSERT INTO user_streams (user_id, platform, channel_id, handle, url, verified,
                                access_token, refresh_token, token_expires_at, scope)
      VALUES ($1,'youtube',$2,$3,$4,TRUE,$5,$6,$7,$8)
      ON CONFLICT (user_id, platform, channel_id) DO UPDATE SET
        handle = EXCLUDED.handle, url = EXCLUDED.url, verified = TRUE,
        access_token = EXCLUDED.access_token,
        /* Google only returns a refresh token on the first consent, so a
           re-link must not overwrite a stored one with null. */
        refresh_token = COALESCE(EXCLUDED.refresh_token, user_streams.refresh_token),
        token_expires_at = EXCLUDED.token_expires_at, scope = EXCLUDED.scope`,
      [userId, channelId, handle,
       "https://www.youtube.com/channel/" + channelId,
       access, tok.data.refresh_token || null, expires,
       tok.data.scope || null]);

    res.send(_ytDone("YouTube linked",
      "Linked " + handle + ". You can go back to Lobby.", true));
  } catch (e) {
    console.error("[youtube/callback]", e.response ? e.response.status : "", e.message);
    res.status(500).send(_ytDone("Not linked",
      "Something went wrong talking to Google. Try again.", false));
  }
});

// ── A user's own channels ─────────────────────────────────────────
// A link is a claim. `verified` stays false and nothing is granted on the
// strength of it — no badge, no placement, no cosmetic. When a real
// verification exists it writes to that column and the rules can change
// then; until it does, this is contact information, not proof.
const _STREAM_PLATFORMS = ["youtube", "twitch", "kick"];

app.get("/me/streams", requireAuth, async (req, res) => {
  try {
    /* Columns named explicitly, and deliberately: access_token and
       refresh_token live on this table, and a SELECT * here would put
       Google credentials in a response the client can read. */
    const r = await pool.query(
      `SELECT id, platform, channel_id, handle, url, verified, created_at
         FROM user_streams WHERE user_id = $1 ORDER BY created_at`, [req.userId]);
    res.json(r.rows.map((x) => ({
      id: x.id, platform: x.platform, channelId: x.channel_id,
      handle: x.handle, url: x.url, verified: !!x.verified,
    })));
  } catch (e) {
    console.error("[me/streams]", e.message);
    res.json([]);
  }
});

app.post("/me/streams", requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const platform = String(b.platform || "").toLowerCase();
    if (!_STREAM_PLATFORMS.includes(platform)) {
      return res.status(400).json({ error: "Unsupported platform" });
    }
    const channelId = String(b.channelId || b.handle || "").trim();
    if (!channelId) return res.status(400).json({ error: "Which channel?" });
    if (channelId.length > 120) return res.status(400).json({ error: "That is not a channel" });

    /* The URL is built here rather than accepted from the client: a
       free-text url on a public profile is somewhere to put a link to
       anywhere at all. */
    const url = platform === "youtube"
      ? (/^UC[\w-]{20,24}$/.test(channelId)
          ? "https://www.youtube.com/channel/" + channelId
          : "https://www.youtube.com/@" + channelId.replace(/^@/, ""))
      : platform === "twitch" ? "https://www.twitch.tv/" + channelId.replace(/^@/, "")
      : "https://kick.com/" + channelId.replace(/^@/, "");

    const r = await pool.query(`
      INSERT INTO user_streams (user_id, platform, channel_id, handle, url)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (user_id, platform, channel_id) DO UPDATE SET handle = EXCLUDED.handle
      RETURNING id`, [req.userId, platform, channelId, b.handle || channelId, url]);
    res.status(201).json({ id: r.rows[0].id, platform, channelId, url, verified: false });
  } catch (e) {
    console.error("[me/streams/create]", e.message);
    res.status(500).json({ error: "Could not link that channel" });
  }
});

app.delete("/me/streams/:id", requireAuth, async (req, res) => {
  try {
    await pool.query("DELETE FROM user_streams WHERE id = $1 AND user_id = $2",
      [req.params.id, req.userId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Could not unlink that channel" });
  }
});

// ── Admin: entering the events ────────────────────────────────────
// Rows are created unpublished, so a half-entered event cannot appear
// on the rail. Publishing is a deliberate second step.
const _MAJOR_FIELDS = ["name","game","organiser","location","starts_at",
  "ends_at","url","stream_url","art_url","tier","sort_order","is_published"];

app.post("/majors", requireAuth, requireAdmin, async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "An event needs a name" });
    const b = req.body;
    const r = await pool.query(`
      INSERT INTO majors (name, game, organiser, location, starts_at, ends_at,
                          url, stream_url, art_url, tier, sort_order, is_published)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [name, b.game || null, b.organiser || null, b.location || null,
       b.startsAt ? new Date(b.startsAt) : null,
       b.endsAt ? new Date(b.endsAt) : null,
       b.url || null, b.streamUrl || null, b.art || null,
       b.tier || "major", Number(b.sortOrder) || 0, b.isPublished === true]);
    res.status(201).json(_majorAdminCard(r.rows[0]));
  } catch (e) {
    console.error("[majors/create]", e.message);
    res.status(500).json({ error: "Could not save that event" });
  }
});

app.patch("/majors/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const map = {
      name:"name", game:"game", organiser:"organiser", location:"location",
      startsAt:"starts_at", endsAt:"ends_at", url:"url", streamUrl:"stream_url",
      art:"art_url", tier:"tier", sortOrder:"sort_order", isPublished:"is_published",
    };
    const sets = [], vals = [];
    for (const [k, col] of Object.entries(map)) {
      if (!(k in req.body)) continue;
      if (!_MAJOR_FIELDS.includes(col)) continue;   // belt and braces
      let v = req.body[k];
      if (col === "starts_at" || col === "ends_at") v = v ? new Date(v) : null;
      if (col === "sort_order") v = Number(v) || 0;
      if (col === "is_published") v = v === true;
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: "Nothing to change" });
    vals.push(req.params.id);
    const r = await pool.query(
      `UPDATE majors SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING *`, vals);
    if (!r.rows.length) return res.status(404).json({ error: "No such event" });
    res.json(_majorAdminCard(r.rows[0]));
  } catch (e) {
    console.error("[majors/update]", e.message);
    res.status(500).json({ error: "Could not save that event" });
  }
});

app.delete("/majors/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM majors WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error("[majors/delete]", e.message);
    res.status(500).json({ error: "Could not delete that event" });
  }
});

app.get("/tournaments/:tournamentId", async (req, res) => {
  try {
    const { tournamentId } = req.params;

    // Get tournament
    const tournamentResult = await pool.query(
      "SELECT * FROM tournaments WHERE id = $1;",
      [tournamentId]
    );

    if (tournamentResult.rows.length === 0) {
      return res.status(404).json({ error: "Tournament not found" });
    }

    const tournament = tournamentResult.rows[0];

    // Get registered players
    const playersResult = await pool.query(
      `SELECT id, user_id, username, joined_at, status 
       FROM tournament_players 
       WHERE tournament_id = $1 
       ORDER BY joined_at ASC;`,
      [tournamentId]
    );

    // Get bracket rounds and matches
    const bracketResult = await pool.query(
      `SELECT 
        r.id as round_id,
        r.round_number,
        m.id as match_id,
        m.match_number,
        p1.id as player1_id,
        p1.username as player1_username,
        p2.id as player2_id,
        p2.username as player2_username,
        pw.id as winner_id,
        pw.username as winner_username,
        m.status as match_status,
        m.created_at,
        m.completed_at
      FROM tournament_rounds r
      LEFT JOIN tournament_matches m ON r.id = m.round_id
      LEFT JOIN tournament_players p1 ON m.player1_id = p1.id
      LEFT JOIN tournament_players p2 ON m.player2_id = p2.id
      LEFT JOIN tournament_players pw ON m.winner_id = pw.id
      WHERE r.tournament_id = $1
      ORDER BY r.round_number ASC, m.match_number ASC;`,
      [tournamentId]
    );

    // Build bracket structure
    const rounds = [];
    bracketResult.rows.forEach(row => {
      let round = rounds.find(r => r.roundNumber === row.round_number);
      if (!round) {
        round = {
          roundNumber: row.round_number,
          matches: []
        };
        rounds.push(round);
      }

      if (row.match_id) {
        round.matches.push({
          matchId: row.match_id,
          matchNumber: row.match_number,
          player1: row.player1_id ? { userId: row.player1_id, username: row.player1_username } : null,
          player2: row.player2_id ? { userId: row.player2_id, username: row.player2_username } : null,
          winner: row.winner_id,
          status: row.match_status,
          createdAt: row.created_at,
          completedAt: row.completed_at
        });
      }
    });

    res.json({
      ...tournament,
      registeredPlayers: playersResult.rows,
      bracket: { rounds }
    });
  } catch (error) {
    console.error("[tournament/get error]", error);
    res.status(500).json({ error: "Failed to fetch tournament" });
  }
});

// Get tournaments for a lobby
app.get("/tournaments/lobby/:lobbyId", async (req, res) => {
  try {
    const { lobbyId } = req.params;

    const result = await pool.query(
      `SELECT 
        t.*,
        COUNT(tp.id) as registered_count
      FROM tournaments t
      LEFT JOIN tournament_players tp ON t.id = tp.tournament_id
      -- scope, not just lobby_id: a hub tournament must never surface
      -- through a lobby's list, and the two are separate things now.
      WHERE t.lobby_id = $1 AND COALESCE(t.scope, 'lobby') = 'lobby'
      GROUP BY t.id
      ORDER BY t.created_at DESC;`,
      [lobbyId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("[tournament/lobby error]", error);
    res.status(500).json({ error: "Failed to fetch tournaments" });
  }
});

// Register player for tournament
app.post("/tournaments/:tournamentId/register", requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { tournamentId } = req.params;
    const userId = req.userId;
    const username = req.username;

    await client.query('BEGIN');

    // Check tournament exists and get player count
    const tournamentResult = await client.query(
      `SELECT t.*, COUNT(tp.id) as current_players
       FROM tournaments t
       LEFT JOIN tournament_players tp ON t.id = tp.tournament_id
       WHERE t.id = $1
       GROUP BY t.id;`,
      [tournamentId]
    );

    if (tournamentResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: "Tournament not found" });
    }

    const tournament = tournamentResult.rows[0];

    // Check invite-only restriction (host is always allowed)
    if (tournament.join_type === 'invite_only' && tournament.host_id !== userId) {
      const inviteResult = await client.query(
        `SELECT id FROM tournament_invites
         WHERE tournament_id = $1 AND invited_user = $2 AND status = 'pending';`,
        [tournamentId, userId]
      );
      if (inviteResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: "This tournament is invite-only" });
      }
      // Mark invite accepted
      await client.query(
        `UPDATE tournament_invites SET status = 'accepted'
         WHERE tournament_id = $1 AND invited_user = $2;`,
        [tournamentId, userId]
      );
    }

    // Check if already registered
    const checkResult = await client.query(
      "SELECT id FROM tournament_players WHERE tournament_id = $1 AND user_id = $2;",
      [tournamentId, userId]
    );

    if (checkResult.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: "Already registered for this tournament" });
    }

    // Check if tournament is full
    if (tournament.current_players >= tournament.max_players) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: "Tournament is full" });
    }

    // Register player
    await client.query(
      `INSERT INTO tournament_players (tournament_id, user_id, username, status)
       VALUES ($1, $2, $3, 'registered')
       RETURNING *;`,
      [tournamentId, userId, username]
    );

    await client.query('COMMIT');

    res.json({ success: true, message: "Successfully registered for tournament" });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error("[tournament/register error]", error);
    res.status(500).json({ error: "Failed to register for tournament" });
  } finally {
    client.release();
  }
});

// Invite a player to an invite-only tournament (host only)
app.post("/tournaments/:tournamentId/invite", requireAuth, async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const { userId: invitedUserId } = req.body;

    if (!invitedUserId) {
      return res.status(400).json({ error: "Missing userId" });
    }

    // Verify caller is the host
    const tResult = await pool.query(
      "SELECT host_id, join_type, name FROM tournaments WHERE id = $1;",
      [tournamentId]
    );
    if (tResult.rows.length === 0) {
      return res.status(404).json({ error: "Tournament not found" });
    }
    const tournament = tResult.rows[0];
    if (tournament.host_id !== req.userId) {
      return res.status(403).json({ error: "Only the host can send invites" });
    }
    if (tournament.join_type !== 'invite_only') {
      return res.status(400).json({ error: "Tournament is not invite-only" });
    }

    // Check invited user exists
    const userResult = await pool.query(
      "SELECT id, username FROM users WHERE id = $1;",
      [invitedUserId]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    // Upsert invite (re-invite if previously declined)
    await pool.query(
      `INSERT INTO tournament_invites (tournament_id, invited_by, invited_user, status)
       VALUES ($1, $2, $3, 'pending')
       ON CONFLICT (tournament_id, invited_user)
       DO UPDATE SET status = 'pending', created_at = NOW();`,
      [tournamentId, req.userId, invitedUserId]
    );

    res.json({ success: true, message: `Invite sent to ${userResult.rows[0].username}` });
  } catch (error) {
    console.error("[tournament/invite error]", error);
    res.status(500).json({ error: "Failed to send invite" });
  }
});

// Get pending invites for current user
app.get("/tournaments/invites/mine", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ti.id, ti.tournament_id, ti.status, ti.created_at,
              t.name AS tournament_name, t.format, t.player_count, t.status AS tournament_status,
              u.username AS invited_by_username
       FROM tournament_invites ti
       JOIN tournaments t ON ti.tournament_id = t.id
       JOIN users u ON ti.invited_by = u.id
       WHERE ti.invited_user = $1 AND ti.status = 'pending'
       ORDER BY ti.created_at DESC;`,
      [req.userId]
    );
    res.json({ invites: result.rows });
  } catch (error) {
    console.error("[tournament/invites/mine error]", error);
    res.status(500).json({ error: "Failed to fetch invites" });
  }
});

// Decline a tournament invite
app.post("/tournaments/:tournamentId/invite/decline", requireAuth, async (req, res) => {
  try {
    const { tournamentId } = req.params;
    await pool.query(
      `UPDATE tournament_invites SET status = 'declined'
       WHERE tournament_id = $1 AND invited_user = $2;`,
      [tournamentId, req.userId]
    );
    res.json({ success: true });
  } catch (error) {
    console.error("[tournament/invite/decline error]", error);
    res.status(500).json({ error: "Failed to decline invite" });
  }
});

// Generate bracket (called when tournament starts)
app.post("/tournaments/:tournamentId/generate-bracket", requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { tournamentId } = req.params;

    await client.query('BEGIN');

    // Check tournament and verify host
    const tournamentResult = await client.query(
      "SELECT * FROM tournaments WHERE id = $1;",
      [tournamentId]
    );

    if (tournamentResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: "Tournament not found" });
    }

    const tournament = tournamentResult.rows[0];

    if (tournament.host_id !== req.userId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: "Only tournament host can generate bracket" });
    }

    // Get registered players (randomized)
    const playersResult = await client.query(
      `SELECT id, user_id, username FROM tournament_players 
       WHERE tournament_id = $1 
       ORDER BY RANDOM();`,
      [tournamentId]
    );
    const players = playersResult.rows;

    if (players.length < tournament.player_count) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: "Not enough players registered" });
    }

    // Generate bracket rounds
    const numRounds = Math.log2(tournament.player_count);

    for (let roundNum = 1; roundNum <= numRounds; roundNum++) {
      const roundResult = await client.query(
        `INSERT INTO tournament_rounds (tournament_id, round_number)
         VALUES ($1, $2)
         RETURNING id;`,
        [tournamentId, roundNum]
      );
      const roundId = roundResult.rows[0].id;

      let matchCount = tournament.player_count / Math.pow(2, roundNum - 1);

      if (roundNum === 1) {
        // First round - pair up players
        for (let i = 0; i < players.length; i += 2) {
          await client.query(
            `INSERT INTO tournament_matches 
             (round_id, tournament_id, match_number, player1_id, player2_id, status)
             VALUES ($1, $2, $3, $4, $5, 'pending');`,
            [
              roundId,
              tournamentId,
              i / 2 + 1,
              players[i].id,
              players[i + 1]?.id || null
            ]
          );
        }
      } else {
        // Subsequent rounds - TBD players
        for (let i = 0; i < matchCount; i++) {
          await client.query(
            `INSERT INTO tournament_matches 
             (round_id, tournament_id, match_number, status)
             VALUES ($1, $2, $3, 'pending');`,
            [roundId, tournamentId, i + 1]
          );
        }
      }
    }

    // Update tournament status
    const updateResult = await client.query(
      `UPDATE tournaments 
       SET status = 'in-progress', start_time = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *;`,
      [tournamentId]
    );

    await client.query('COMMIT');

    res.json({ success: true, tournament: updateResult.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error("[tournament/bracket error]", error);
    res.status(500).json({ error: "Failed to generate bracket" });
  } finally {
    client.release();
  }
});

// Record match result
app.post("/tournaments/:tournamentId/match-result", requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { tournamentId } = req.params;
    const { matchId, winnerId } = req.body;

    await client.query('BEGIN');

    // Update match with result
    const result = await client.query(
      `UPDATE tournament_matches 
       SET winner_id = $1, status = 'completed', completed_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND tournament_id = $3
       RETURNING *;`,
      [winnerId, matchId, tournamentId]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: "Match not found" });
    }

    await client.query('COMMIT');
    res.json({ success: true, match: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error("[tournament/match-result error]", error);
    res.status(500).json({ error: "Failed to record match result" });
  } finally {
    client.release();
  }
});

// Declare tournament winner / finalize (host only) — also auto-captures HOF event
app.post("/tournaments/:tournamentId/complete", requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { tournamentId } = req.params;
    const { winnerPlayerId } = req.body; // tournament_players.id (not user id)

    await client.query('BEGIN');

    const tResult = await client.query("SELECT * FROM tournaments WHERE id = $1;", [tournamentId]);
    if (!tResult.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: "Tournament not found" }); }
    const t = tResult.rows[0];
    if (t.host_id !== req.userId) { await client.query('ROLLBACK'); return res.status(403).json({ error: "Only host can finalize" }); }

    // Resolve winner username
    let winnerUsername = null;
    if (winnerPlayerId) {
      const wp = await client.query("SELECT username FROM tournament_players WHERE id = $1;", [winnerPlayerId]);
      winnerUsername = wp.rows[0]?.username || null;
    }

    await client.query(
      `UPDATE tournaments SET status = 'completed', winner_id = $1 WHERE id = $2;`,
      [winnerPlayerId || null, tournamentId]
    );

    // Auto-capture Hall of Fame entry
    const playerCountRow = await client.query(
      "SELECT COUNT(*) AS cnt FROM tournament_players WHERE tournament_id = $1;", [tournamentId]
    );
    const playerCount = parseInt(playerCountRow.rows[0]?.cnt || 0);
    const winnerLine = winnerUsername ? ` — Winner: ${winnerUsername}` : "";
    await client.query(
      `INSERT INTO lobby_timeline_events (server_id, type, title, description, ref_id, ref_type, pinned)
       VALUES ($1, 'tournament', $2, $3, $4, 'tournament', false)
       ON CONFLICT DO NOTHING;`,
      [
        parseInt(t.lobby_id),
        `🏆 ${t.name}`,
        `${t.format} · ${playerCount} players${winnerLine}`,
        parseInt(tournamentId)
      ]
    );

    await client.query('COMMIT');
    res.json({ success: true, winnerUsername });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error("[tournament/complete error]", error);
    res.status(500).json({ error: "Failed to complete tournament" });
  } finally {
    client.release();
  }
});

// ==================== END TOURNAMENT ROUTES ====================

// ==================== HALL OF FAME / TIMELINE ====================

// GET /servers/:id/timeline — fetch all timeline events for this lobby
app.get("/servers/:id/timeline", requireAuth, async (req, res) => {
  try {
    const serverId = parseInt(req.params.id);
    // Check membership
    const mem = await pool.query("SELECT 1 FROM server_members WHERE server_id=$1 AND user_id=$2", [serverId, req.userId]);
    if (!mem.rows.length) return res.status(403).json({ error: "Not a member" });

    const result = await pool.query(
      `SELECT te.*, u.username AS created_by_username, u.avatar_url AS created_by_avatar
       FROM lobby_timeline_events te
       LEFT JOIN users u ON te.created_by = u.id
       WHERE te.server_id = $1
       ORDER BY te.captured_at DESC
       LIMIT 100;`,
      [serverId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("[timeline/get]", err);
    res.status(500).json({ error: "Failed to fetch timeline" });
  }
});

// POST /servers/:id/timeline — admin manually adds a moment
app.post("/servers/:id/timeline", requireAuth, async (req, res) => {
  try {
    const serverId = parseInt(req.params.id);
    const { title, description, image_url } = req.body;
    if (!title) return res.status(400).json({ error: "Title required" });

    const mem = await pool.query("SELECT role FROM server_members WHERE server_id=$1 AND user_id=$2", [serverId, req.userId]);
    const role = mem.rows[0]?.role;
    if (role !== 'owner' && role !== 'moderator') return res.status(403).json({ error: "Admins only" });

    const r = await pool.query(
      `INSERT INTO lobby_timeline_events (server_id, type, title, description, image_url, pinned, created_by)
       VALUES ($1, 'manual', $2, $3, $4, true, $5) RETURNING *;`,
      [serverId, title, description || null, image_url || null, req.userId]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error("[timeline/post]", err);
    res.status(500).json({ error: "Failed to add moment" });
  }
});

// PATCH /servers/:id/timeline/:eventId/pin — toggle pin (admin)
app.patch("/servers/:id/timeline/:eventId/pin", requireAuth, async (req, res) => {
  try {
    const serverId = parseInt(req.params.id);
    const eventId  = parseInt(req.params.eventId);
    const mem = await pool.query("SELECT role FROM server_members WHERE server_id=$1 AND user_id=$2", [serverId, req.userId]);
    const role = mem.rows[0]?.role;
    if (role !== 'owner' && role !== 'moderator') return res.status(403).json({ error: "Admins only" });

    const r = await pool.query(
      `UPDATE lobby_timeline_events SET pinned = NOT pinned WHERE id=$1 AND server_id=$2 RETURNING pinned;`,
      [eventId, serverId]
    );
    res.json({ pinned: r.rows[0]?.pinned });
  } catch (err) {
    console.error("[timeline/pin]", err);
    res.status(500).json({ error: "Failed to toggle pin" });
  }
});

// DELETE /servers/:id/timeline/:eventId — remove a moment (admin)
app.delete("/servers/:id/timeline/:eventId", requireAuth, async (req, res) => {
  try {
    const serverId = parseInt(req.params.id);
    const eventId  = parseInt(req.params.eventId);
    const mem = await pool.query("SELECT role FROM server_members WHERE server_id=$1 AND user_id=$2", [serverId, req.userId]);
    const role = mem.rows[0]?.role;
    if (role !== 'owner' && role !== 'moderator') return res.status(403).json({ error: "Admins only" });

    await pool.query("DELETE FROM lobby_timeline_events WHERE id=$1 AND server_id=$2;", [eventId, serverId]);
    res.json({ success: true });
  } catch (err) {
    console.error("[timeline/delete]", err);
    res.status(500).json({ error: "Failed to delete moment" });
  }
});

// ==================== END HALL OF FAME ROUTES ====================
// ── Global error handlers ────────────────────────────────────
process.on("unhandledRejection", (reason, promise) => {
  console.error("[UNHANDLED REJECTION]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT EXCEPTION]", err);
});

// ── Home Section Order Endpoints ─────────────────────────────────
// ── Generic per-user UI preferences ──────────────────────────────
//
// Reorderable surfaces should not each need their own table and their
// own pair of routes. Key is whitelisted rather than free-form so this
// cannot become a per-user blob store, and the body is capped.
const UI_PREF_KEYS = new Set(["discover_rail_order"]);

app.get("/me/prefs/:key", requireAuth, async (req, res) => {
  const key = String(req.params.key || "");
  if (!UI_PREF_KEYS.has(key)) return res.status(404).json({ error: "unknown pref" });
  try {
    const r = await pool.query(
      "SELECT value_json FROM ui_prefs WHERE user_id = $1 AND pref_key = $2",
      [req.userId, key]
    );
    if (!r.rows.length) return res.json(null);
    try { return res.json(JSON.parse(r.rows[0].value_json)); }
    catch { return res.json(null); }
  } catch (err) {
    console.error("[prefs GET]", err.message);
    res.json(null);
  }
});

app.post("/me/prefs/:key", requireAuth, async (req, res) => {
  const key = String(req.params.key || "");
  if (!UI_PREF_KEYS.has(key)) return res.status(404).json({ error: "unknown pref" });
  const body = JSON.stringify(req.body === undefined ? null : req.body);
  if (body.length > 4000) return res.status(413).json({ error: "too large" });
  try {
    await pool.query(
      "INSERT INTO ui_prefs (user_id, pref_key, value_json) VALUES ($1, $2, $3) " +
      "ON CONFLICT (user_id, pref_key) DO UPDATE SET value_json = $3, updated_at = NOW()",
      [req.userId, key, body]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("[prefs POST]", err.message);
    res.status(500).json({ error: "save failed" });
  }
});

app.get("/home/section-order", requireAuth, async (req, res) => {
  try {
    const header = req.headers.authorization || "";
    const payload = jwt.verify(header.slice(7), SECRET);
    const userId = payload.id;

    const row = await pool.query(
      "SELECT order_json FROM home_section_order WHERE user_id = $1",
      [userId]
    );

    if (row.rows.length === 0) {
      // Create default order if doesn't exist
      await pool.query(
        "INSERT INTO home_section_order (user_id, order_json) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING",
        [userId, JSON.stringify(["homeRecents", "homeSpotlight", "homeCommunities"])]
      );
      return res.json(["homeRecents", "homeSpotlight", "homeCommunities"]);
    }

    const order = JSON.parse(row.rows[0].order_json);
    res.json(order);
  } catch (err) {
    console.error("[home/section-order GET]", err);
    res.status(500).json({ error: "Failed to get section order" });
  }
});

app.post("/home/section-order", requireAuth, async (req, res) => {
  try {
    const header = req.headers.authorization || "";
    const payload = jwt.verify(header.slice(7), SECRET);
    const userId = payload.id;
    const { order } = req.body;

    if (!Array.isArray(order) || order.length !== 3) {
      return res.status(400).json({ error: "Order must be an array of 3 section IDs" });
    }

    const validIds = new Set(["homeRecents", "homeSpotlight", "homeCommunities"]);
    if (!order.every(id => validIds.has(id))) {
      return res.status(400).json({ error: "Invalid section ID in order" });
    }

    await pool.query(
      "INSERT INTO home_section_order (user_id, order_json) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET order_json = $2, updated_at = NOW()",
      [userId, JSON.stringify(order)]
    );

    res.json({ success: true, order });
  } catch (err) {
    console.error("[home/section-order POST]", err);
    res.status(500).json({ error: "Failed to save section order" });
  }
});

// ════════════════════════════════════════════════════════════════════════════════
// LOBBY CALENDAR EVENTS API
// ════════════════════════════════════════════════════════════════════════════════

// ── GET /api/events/lobby/:lobbyId — Get all events for a lobby ────────────────
app.get('/api/events/lobby/:lobbyId', requireAuth, async (req, res) => {
  const { lobbyId } = req.params;
  const userId = req.user.id;

  try {
    // Get custom events (filter private events — only show if user created them)
    const eventsResult = await pool.query(
      `SELECT 
        id, lobby_id, created_by, event_type, title, description,
        event_date, location, is_private, created_at
       FROM lobby_events
       WHERE lobby_id = $1 
       AND (is_private = FALSE OR created_by = $2)
       ORDER BY event_date ASC`,
      [lobbyId, userId]
    );

    // Get scheduled tournaments for this lobby
    const tournamentsResult = await pool.query(
      `SELECT id, name, description, scheduled_start, host_id
       FROM tournaments
       WHERE lobby_id = $1 AND scheduled_start IS NOT NULL
       ORDER BY scheduled_start ASC`,
      [lobbyId]
    );

    // Convert tournaments to event format
    const tournamentEvents = tournamentsResult.rows.map(t => ({
      id: `tournament_${t.id}`,
      type: 'tournament',
      title: t.name,
      description: t.description,
      event_date: t.scheduled_start,
      location: null,
      is_private: false,
      created_by: t.host_id,
      tournament_id: t.id
    }));

    // Combine and return
    const allEvents = [
      ...eventsResult.rows.map(e => ({
        id: e.id,
        type: e.event_type,
        title: e.title,
        description: e.description,
        event_date: e.event_date,
        location: e.location,
        is_private: e.is_private,
        created_by: e.created_by
      })),
      ...tournamentEvents
    ];

    res.json({ events: allEvents });

  } catch (err) {
    console.error('[GET /api/events/lobby]', err);
    res.status(500).json({ error: 'Failed to load events' });
  }
});

// ── POST /api/events/create — Create a new lobby event ─────────────────────────
app.post('/api/events/create', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const {
    lobbyId,
    eventType,    // 'public', 'online', 'private'
    title,
    description,
    eventDate,
    location,
    isPrivate
  } = req.body;

  if (!lobbyId || !eventType || !title || !eventDate) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO lobby_events 
       (lobby_id, created_by, event_type, title, description, event_date, location, is_private)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [lobbyId, userId, eventType, title, description || null, eventDate, location || null, isPrivate || false]
    );

    console.log(`[events] ✅ Created event "${title}" in lobby ${lobbyId}`);

    res.json({
      success: true,
      event: result.rows[0]
    });

  } catch (err) {
    console.error('[POST /api/events/create]', err);
    res.status(500).json({ error: 'Failed to create event' });
  }
});

// ── DELETE /api/events/:id — Delete an event (creator only) ────────────────────
app.delete('/api/events/:id', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;

  try {
    // Check if event exists and user is the creator
    const eventResult = await pool.query(
      `SELECT * FROM lobby_events WHERE id = $1`,
      [id]
    );

    if (eventResult.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const event = eventResult.rows[0];

    if (event.created_by !== userId) {
      return res.status(403).json({ error: 'Only the event creator can delete this event' });
    }

    await pool.query(`DELETE FROM lobby_events WHERE id = $1`, [id]);

    console.log(`[events] ✅ Deleted event ${id}`);

    res.json({ success: true });

  } catch (err) {
    console.error('[DELETE /api/events]', err);
    res.status(500).json({ error: 'Failed to delete event' });
  }
});

// ── PUT /api/events/:id — Update an event (creator only) ───────────────────────
app.put('/api/events/:id', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;
  const {
    eventType,
    title,
    description,
    eventDate,
    location,
    isPrivate
  } = req.body;

  try {
    // Check if event exists and user is the creator
    const eventResult = await pool.query(
      `SELECT * FROM lobby_events WHERE id = $1`,
      [id]
    );

    if (eventResult.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const event = eventResult.rows[0];

    if (event.created_by !== userId) {
      return res.status(403).json({ error: 'Only the event creator can edit this event' });
    }

    const result = await pool.query(
      `UPDATE lobby_events
       SET event_type = $1, title = $2, description = $3, 
           event_date = $4, location = $5, is_private = $6
       WHERE id = $7
       RETURNING *`,
      [
        eventType || event.event_type,
        title || event.title,
        description !== undefined ? description : event.description,
        eventDate || event.event_date,
        location !== undefined ? location : event.location,
        isPrivate !== undefined ? isPrivate : event.is_private,
        id
      ]
    );

    console.log(`[events] ✅ Updated event ${id}`);

    res.json({
      success: true,
      event: result.rows[0]
    });

  } catch (err) {
    console.error('[PUT /api/events]', err);
    res.status(500).json({ error: 'Failed to update event' });
  }
});

// ════════════════════════════════════════════════════════════════════════════════
// LOBBY CALENDAR EVENTS API
// ════════════════════════════════════════════════════════════════════════════════

// GET /api/events/lobby/:lobbyId — Get all events for a lobby
app.get('/api/events/lobby/:lobbyId', requireAuth, async (req, res) => {
  const { lobbyId } = req.params;
  const userId = req.user.id;

  try {
    // Get custom events (filter private events — only show if user created them)
    const eventsResult = await pool.query(
      `SELECT 
        id, lobby_id, created_by, event_type, title, description,
        event_date, location, is_private, created_at
       FROM lobby_events
       WHERE lobby_id = $1 
       AND (is_private = FALSE OR created_by = $2)
       ORDER BY event_date ASC`,
      [lobbyId, userId]
    );

    // Get scheduled tournaments for this lobby
    const tournamentsResult = await pool.query(
      `SELECT id, name, description, scheduled_start, host_id
       FROM tournaments
       WHERE lobby_id = $1 AND scheduled_start IS NOT NULL
       ORDER BY scheduled_start ASC`,
      [lobbyId]
    );

    // Convert tournaments to event format
    const tournamentEvents = tournamentsResult.rows.map(t => ({
      id: `tournament_${t.id}`,
      type: 'tournament',
      title: t.name,
      description: t.description,
      event_date: t.scheduled_start,
      location: null,
      is_private: false,
      created_by: t.host_id,
      tournament_id: t.id
    }));

    // Combine and return
    const allEvents = [
      ...eventsResult.rows.map(e => ({
        id: e.id,
        type: e.event_type,
        title: e.title,
        description: e.description,
        event_date: e.event_date,
        location: e.location,
        is_private: e.is_private,
        created_by: e.created_by
      })),
      ...tournamentEvents
    ];

    res.json({ events: allEvents });

  } catch (err) {
    console.error('[GET /api/events/lobby]', err);
    res.status(500).json({ error: 'Failed to load events' });
  }
});

// POST /api/events/create — Create a new lobby event
app.post('/api/events/create', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const {
    lobbyId,
    eventType,    // 'public', 'online', 'private'
    title,
    description,
    eventDate,
    location,
    isPrivate
  } = req.body;

  if (!lobbyId || !eventType || !title || !eventDate) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO lobby_events 
       (lobby_id, created_by, event_type, title, description, event_date, location, is_private)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [lobbyId, userId, eventType, title, description || null, eventDate, location || null, isPrivate || false]
    );

    console.log(`[events] ✅ Created event "${title}" in lobby ${lobbyId}`);

    res.json({
      success: true,
      event: result.rows[0]
    });

  } catch (err) {
    console.error('[POST /api/events/create]', err);
    res.status(500).json({ error: 'Failed to create event' });
  }
});

// DELETE /api/events/:id — Delete an event (creator only)
app.delete('/api/events/:id', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;

  try {
    // Check if event exists and user is the creator
    const eventResult = await pool.query(
      `SELECT * FROM lobby_events WHERE id = $1`,
      [id]
    );

    if (eventResult.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const event = eventResult.rows[0];

    if (event.created_by !== userId) {
      return res.status(403).json({ error: 'Only the event creator can delete this event' });
    }

    await pool.query(`DELETE FROM lobby_events WHERE id = $1`, [id]);

    console.log(`[events] ✅ Deleted event ${id}`);

    res.json({ success: true });

  } catch (err) {
    console.error('[DELETE /api/events]', err);
    res.status(500).json({ error: 'Failed to delete event' });
  }
});

// ── Ladder Routes (mounted here so they're served by the running auth.js entry point) ───
// ladder.js expects req.user.id (set by this shim), not req.userId (set by requireAuth above).
function ladderAuthMiddleware(req, res, next) {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });
    const decoded = jwt.verify(token, SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

try {
  const ladderRoutes = require('./ladder.js');
  // Mutating verbs always require auth. GETs are public so the leaderboard
  // can be browsed without login, EXCEPT /me which is always personal.
  app.use('/api/ladder', (req, res, next) => {
    if (['POST','PUT','PATCH','DELETE'].includes(req.method)) return ladderAuthMiddleware(req, res, next);
    if (req.method === 'GET' && req.path === '/me') return ladderAuthMiddleware(req, res, next);
    // Optional auth on public GETs: decode token if present so personalised features work,
    // but don't reject the request if it's missing/invalid.
    const token = req.headers.authorization?.split(' ')[1];
    if (token) { try { req.user = jwt.verify(token, SECRET); } catch {} }
    next();
  });
  app.use('/api/ladder', ladderRoutes);
  console.log('[✓] Ladder routes loaded');

  // Season rollover: check once shortly after boot, then every hour.
  try {
    const ratingEngine = require('./rating-engine.js');
    setTimeout(() => { ratingEngine.checkSeasonRollover().catch(e => console.warn('[ladder] initial rollover check:', e.message)); }, 5000);
    setInterval(() => { ratingEngine.checkSeasonRollover().catch(e => console.warn('[ladder] periodic rollover check:', e.message)); }, 60 * 60 * 1000);
  } catch (e) { console.warn('[ladder] rollover scheduler not attached:', e.message); }
} catch (err) {
  console.warn('[!] Ladder routes not loaded:', err.message);
}

// Express error-catching middleware (must be last, before listen)
app.use((err, req, res, next) => {
  console.error(`[EXPRESS ERROR] ${req.method} ${req.url}:`, err);
  if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
});

// ── Start ────────────────────────────────────────────────────
initDb().then(() => {
  app.listen(PORT, () => console.log(`[auth] HTTP server on http://localhost:${PORT}`));
}).catch(err => {
  console.error("[auth] Failed to init DB, retrying in 3s…", err.message || err);
  setTimeout(() => {
    initDb().then(() => {
      app.listen(PORT, () => console.log(`[auth] HTTP server on http://localhost:${PORT}`));
    }).catch(e => { console.error("[auth] DB init failed again:", e); process.exit(1); });
  }, 3000);
});
