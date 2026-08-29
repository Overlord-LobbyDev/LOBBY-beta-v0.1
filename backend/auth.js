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
        const mk = (f) =>
          f ? STEAM_ASSET_HOST + a.asset_url_format.replace("${FILENAME}", f) : null;
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

      const art = await steamArt(g.appid);

      return {
        appid:       g.appid,
        name:        g.name,
        header_img:  art.header_img,
        capsule_img: art.capsule_img,
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

// GET /steam/recent/:userId — get recently played games + achievements for any user
app.get("/steam/recent/:userId", requireAuth, async (req, res) => {
  const { userId } = req.params;
  const userRow = await pool.query("SELECT steam_id FROM users WHERE id = $1", [userId]);
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

      const art = await steamArt(g.appid);

      return {
        appid:       g.appid,
        name:        g.name,
        header_img:  art.header_img,
        capsule_img: art.capsule_img,
        hours_recent: hoursRecent,
        hours_total:  hoursTotal,
        achievements,
      };
    }));

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

  // Validate input
  if (!lobbyId || !name || !format || !playerCount) {
    return res.status(400).json({ error: "Missing required fields" });
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
    const result = await pool.query(
      `INSERT INTO tournaments
        (lobby_id, host_id, name, description, format, player_count, max_players, status, rules, prize, start_time, join_type)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'setup', $8, $9, $10, $11)
      RETURNING *;`,
      [
        lobbyId,
        req.userId,
        name,
        description || null,
        format,
        playerCount,
        playerCount,
        rules || null,
        prize || null,
        startTime ? new Date(startTime) : null,
        resolvedJoinType
      ]
    );

    res.status(201).json({
      success: true,
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
const Q_TIERS = ["bronze","silver","gold","plat","diamond","master","pro"];
const Q_SESSION_MAX_MS = 3 * 60 * 60 * 1000;   // the UI promises 3 hours

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

async function _qRoster(sessionId) {
  const r = await pool.query(`
    SELECT m.user_id, m.skill, m.proof, m.joined_at,
           u.username, u.avatar_url,
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
  }));
}

async function _qSession(id) {
  const r = await pool.query("SELECT * FROM queue_sessions WHERE id = $1", [id]);
  return r.rows[0] || null;
}

// A session that has run past its cap is closed on read rather than by a
// sweeper: there is no scheduler in this service, and a session nobody
// looks at does no harm.
async function _qExpireIfStale(sess) {
  if (!sess || sess.ended_at) return sess;
  const started = new Date(sess.matched_at || sess.created_at).getTime();
  if (Date.now() - started < Q_SESSION_MAX_MS) return sess;
  await pool.query(
    "UPDATE queue_sessions SET state = 'expired', ended_at = NOW() WHERE id = $1",
    [sess.id]
  );
  return Object.assign({}, sess, { state: "expired" });
}

function _qPayload(sess, members) {
  return {
    queueId: sess.id,
    state: sess.state,
    game: sess.game,
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
  };
}

// POST /queue/intent — join a compatible session, or open one.
app.post("/queue/intent", requireAuth, async (req, res) => {
  const { game, players, skill, proof } = req.body || {};
  if (!game) return res.status(400).json({ error: "game is required" });
  const size = Math.max(2, Math.min(10, parseInt(players, 10) || 2));
  const tier = String(skill || "plat").toLowerCase();

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

    const mine = _qTierIdx(tier);
    const fit = open.rows.find(row => {
      if ((row.filled || 0) >= row.players) return false;
      // Both sides must accept: the waiting session has widened by age,
      // and the arriving player has not waited at all. Using the widest
      // of the two is what lets a long-waiting group take anyone.
      const win = Math.max(_qWindowFor(Number(row.age_ms) || 0), 0);
      return Math.abs(_qTierIdx(row.skill) - mine) <= win;
    });

    let sessionId;
    if (fit) {
      sessionId = fit.id;
      await pool.query(`
        INSERT INTO queue_members (session_id, user_id, skill, proof)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (session_id, user_id)
        DO UPDATE SET left_at = NULL, skill = EXCLUDED.skill, proof = EXCLUDED.proof
      `, [sessionId, req.userId, tier, proof || null]);
    } else {
      const created = await pool.query(`
        INSERT INTO queue_sessions (game, players, skill, owner_id)
        VALUES ($1,$2,$3,$4) RETURNING *
      `, [game, size, tier, req.userId]);
      sessionId = created.rows[0].id;
      await pool.query(
        "INSERT INTO queue_members (session_id, user_id, skill, proof) VALUES ($1,$2,$3,$4)",
        [sessionId, req.userId, tier, proof || null]
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
    maxPlayers: r.max_players || r.player_count || null,
    prize: r.prize || null,
    format: r.format,
    host: r.host_name || null,
    lobbyId: r.lobby_id,
    lobbyName: r.lobby_name || null,
    startTime: r.scheduled_start || r.start_time || null,
    createdAt: r.created_at,
  };
}

// GET /tournaments/global — every tournament worth showing, across lobbies.
app.get("/tournaments/global", async (req, res) => {
  try {
    const r = await pool.query(_TOURNEY_SELECT +
      ` WHERE t.status IN ('setup','registration','in-progress')` +
      ` ORDER BY (t.status = 'in-progress') DESC, entrants DESC, t.created_at DESC LIMIT 60`);
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
    const r = await pool.query(_TOURNEY_SELECT +
      ` WHERE t.status IN ('registration','in-progress')` +
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
    const r = await pool.query(_TOURNEY_SELECT +
      ` WHERE t.host_id = $1
         OR EXISTS (SELECT 1 FROM tournament_players tp
                     WHERE tp.tournament_id = t.id AND tp.user_id = $1)
       ORDER BY t.created_at DESC LIMIT 100`, [req.userId]);
    res.json(r.rows.map((row) => Object.assign(_tourneyCard(row), {
      isHost: row.host_id === req.userId,
    })));
  } catch (e) {
    console.error("[me/tournaments]", e.message);
    res.json([]);
  }
});

// GET /me/tournaments/active-count — for the cap counter.
app.get("/me/tournaments/active-count", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS count FROM tournaments
        WHERE host_id = $1 AND status IN ('setup','registration','in-progress')`,
      [req.userId]
    );
    res.json({ count: r.rows[0] ? r.rows[0].count : 0 });
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
    badge: null,
  };
}

// GET /lobbies/public — the Discover grid.
app.get("/lobbies/public", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT s.*,
        (SELECT COUNT(*)::int FROM server_members WHERE server_id = s.id) AS member_count
      FROM servers s
      WHERE ` + _PUBLIC_LOBBY_WHERE + `
      ORDER BY member_count DESC, s.created_at DESC
      LIMIT 100
    `);
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
      ` WHERE t.status = 'in-progress' ORDER BY entrants DESC LIMIT 1`);
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
      WHERE t.lobby_id = $1
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
