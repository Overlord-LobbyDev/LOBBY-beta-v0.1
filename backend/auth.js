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
  const { username, password, email } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Username and password required" });
  if (username.length < 2 || username.length > 32) return res.status(400).json({ error: "Username must be 2-32 characters" });
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
        "SELECT id, username, password_hash, avatar_url, is_admin, is_banned, banned_until, ban_reason, email FROM users WHERE LOWER(email) = $1",
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
        "SELECT id, username, password_hash, avatar_url, is_admin, is_banned, banned_until, ban_reason, email FROM users WHERE username = $1",
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
        "SELECT id, username, password_hash, avatar_url, is_admin, is_banned, banned_until, ban_reason, email FROM users WHERE username = $1",
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
    res.json({ token, user: { id: user.id, username: user.username, avatarUrl: user.avatar_url, isAdmin: user.is_admin }, needs_email: !user.email });
  } catch (err) { console.error("[login error]", err); res.status(500).json({ error: "Server error" }); }
});

app.get("/me", requireAuth, async (req, res) => {
  const r = await pool.query(
    `SELECT id, username, avatar_url, is_admin, is_banned, banned_until,
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

    await pool.query("DELETE FROM email_verifications WHERE user_id = $1", [req.userId]);
    await pool.query(
      "INSERT INTO email_verifications (user_id, email, verification_code, code_expires_at) VALUES ($1,$2,$3,$4)",
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
    const transporter = require("nodemailer").createTransport({
      service: process.env.EMAIL_SERVICE || "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });

    await transporter.sendMail({
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
      to: userEmail,
      subject: `Verify your Chess.com account for LOBBY`,
      html: emailHtml
    });

    console.log(`[/link-chess] Sent verification email to ${userEmail} for Chess.com account "${username}"`);

    res.json({
      success: true,
      message: `Verification email sent to ${userEmail}. Check your email to confirm linking your Chess.com account.`
    });

  } catch (err) {
    console.error("[/link-chess]", err);
    res.status(500).json({ error: "Failed to send verification email" });
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
      `SELECT id, username, avatar_url, bio, status, banner_url, banner_colour,
              display_name, status_emoji, status_text, location, website,
              created_at AS joined_at, steam_id, steam_name, steam_avatar
       FROM users WHERE id = $1`,
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
  const { messageId, dmId, groupMsgId, url, filename, mimeType, sizeBytes } = req.body;
  const r = await pool.query(
    "INSERT INTO attachments (message_id, dm_id, group_msg_id, url, filename, mime_type, size_bytes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *",
    [messageId || null, dmId || null, groupMsgId || null, url, filename, mimeType, sizeBytes]
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

app.delete("/posts/:id", requireAuth, async (req, res) => {
  const r = await pool.query("SELECT user_id FROM posts WHERE id = $1", [req.params.id]);
  const isAdmin = (await pool.query("SELECT is_admin FROM users WHERE id = $1", [req.userId])).rows[0]?.is_admin;
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
    return res.json({ reacted: true, emoji });
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
  const r = await pool.query(`
    SELECT c.*, u.username, u.avatar_url
    FROM post_comments c JOIN users u ON u.id = c.user_id
    WHERE c.post_id = $1 ORDER BY c.created_at ASC
  `, [req.params.id]);
  res.json(r.rows);
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
    console.error("[steam/recent/:userId]", err);
    res.status(500).json({ error: "Could not reach Steam API" });
  }
});
// ==================== TOURNAMENT ROUTES ====================
// Add these routes to your auth.js file (before the global error handlers section)

// Create a new tournament
app.post("/tournaments/create", requireAuth, async (req, res) => {
  const { lobbyId, name, description, format, playerCount, rules, prize, startTime } = req.body;
  
  // Validate input
  if (!lobbyId || !name || !format || !playerCount) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  
  const validFormats = ['single', 'double', 'round-robin'];
  const validPlayerCounts = [4, 8, 16, 32, 64, 128];
  
  if (!validFormats.includes(format)) {
    return res.status(400).json({ error: "Invalid tournament format" });
  }
  
  if (!validPlayerCounts.includes(playerCount)) {
    return res.status(400).json({ error: "Invalid player count" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO tournaments 
        (lobby_id, host_id, name, description, format, player_count, max_players, status, rules, prize, start_time)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'setup', $8, $9, $10)
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
        startTime ? new Date(startTime) : null
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

// ==================== END TOURNAMENT ROUTES ====================
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