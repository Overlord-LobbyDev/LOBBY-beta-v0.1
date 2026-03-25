require("dotenv").config();
// ============================================================
//  db.js  —  PostgreSQL connection + full schema
// ============================================================

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Required for Render PostgreSQL
});

async function initDb() {
  // Users
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id           SERIAL PRIMARY KEY,
      username     TEXT UNIQUE NOT NULL,
      password     TEXT NOT NULL,
      avatar_url   TEXT DEFAULT NULL,
      is_admin       BOOLEAN DEFAULT FALSE,
      is_banned      BOOLEAN DEFAULT FALSE,
      banned_until   TIMESTAMPTZ DEFAULT NULL,
      ban_reason     TEXT DEFAULT NULL,
      bio            TEXT DEFAULT NULL,
      status         TEXT DEFAULT NULL,
      banner_url     TEXT DEFAULT NULL,
      banner_colour  TEXT DEFAULT NULL,
      display_name   TEXT DEFAULT NULL,
      status_emoji   TEXT DEFAULT NULL,
      status_text    TEXT DEFAULT NULL,
      location       TEXT DEFAULT NULL,
      website        TEXT DEFAULT NULL,
      steam_id       TEXT DEFAULT NULL,
      steam_name     TEXT DEFAULT NULL,
      steam_avatar   TEXT DEFAULT NULL,
      post_visibility TEXT DEFAULT 'public',
      created_at     TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Friends
  await pool.query(`
    CREATE TABLE IF NOT EXISTS friends (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
      friend_id  INTEGER REFERENCES users(id) ON DELETE CASCADE,
      status     TEXT DEFAULT 'pending', -- pending, accepted, blocked
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, friend_id)
    );
  `);

  // Servers (like Discord guilds)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS servers (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      icon_url      TEXT DEFAULT NULL,
      description   TEXT DEFAULT '',
      unique_id     TEXT DEFAULT NULL,
      banner_url    TEXT DEFAULT NULL,
      tags          TEXT DEFAULT NULL,
      owner_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Server members
  await pool.query(`
    CREATE TABLE IF NOT EXISTS server_members (
      id         SERIAL PRIMARY KEY,
      server_id  INTEGER REFERENCES servers(id) ON DELETE CASCADE,
      user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
      role       TEXT DEFAULT 'member', -- owner, moderator, member
      joined_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(server_id, user_id)
    );
  `);


  // Pending server invites (invite must be accepted before user joins)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS server_invites (
      id          SERIAL PRIMARY KEY,
      server_id   INTEGER REFERENCES servers(id) ON DELETE CASCADE,
      inviter_id  INTEGER REFERENCES users(id) ON DELETE CASCADE,
      invitee_id  INTEGER REFERENCES users(id) ON DELETE CASCADE,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(server_id, invitee_id)
    );
  `);

  // Channels inside servers
  await pool.query(`
    CREATE TABLE IF NOT EXISTS channels (
      id          SERIAL PRIMARY KEY,
      server_id   INTEGER REFERENCES servers(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      type        TEXT DEFAULT 'text', -- text, voice, announcement
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Messages (server channels)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id          SERIAL PRIMARY KEY,
      channel_id  INTEGER REFERENCES channels(id) ON DELETE CASCADE,
      user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      content     TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Direct messages
  await pool.query(`
    CREATE TABLE IF NOT EXISTS direct_messages (
      id           SERIAL PRIMARY KEY,
      from_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      to_user_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
      content      TEXT,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Attachments (for both messages and DMs)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS attachments (
      id           SERIAL PRIMARY KEY,
      message_id   INTEGER DEFAULT NULL,
      dm_id        INTEGER DEFAULT NULL,
      group_msg_id INTEGER DEFAULT NULL,
      url          TEXT NOT NULL,
      filename     TEXT NOT NULL,
      mime_type    TEXT NOT NULL,
      size_bytes   INTEGER NOT NULL,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Group chats (like Discord group DMs)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS group_chats (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      icon_url   TEXT DEFAULT NULL,
      owner_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
      max_members INTEGER DEFAULT 5,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Group chat members
  await pool.query(`
    CREATE TABLE IF NOT EXISTS group_members (
      id         SERIAL PRIMARY KEY,
      group_id   INTEGER REFERENCES group_chats(id) ON DELETE CASCADE,
      user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
      joined_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(group_id, user_id)
    );
  `);

  // Group messages
  await pool.query(`
    CREATE TABLE IF NOT EXISTS group_messages (
      id         SERIAL PRIMARY KEY,
      group_id   INTEGER REFERENCES group_chats(id) ON DELETE CASCADE,
      user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      content    TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Social posts
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
      content      TEXT,
      image_url    TEXT DEFAULT NULL,
      visibility       TEXT DEFAULT 'public', -- public, friends
      community_tags   JSONB DEFAULT '[]',
      created_at       TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Post likes
  await pool.query(`
    CREATE TABLE IF NOT EXISTS post_likes (
      id         SERIAL PRIMARY KEY,
      post_id    INTEGER REFERENCES posts(id) ON DELETE CASCADE,
      user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(post_id, user_id)
    );
  `);

  // Post comments
  await pool.query(`
    CREATE TABLE IF NOT EXISTS post_comments (
      id         SERIAL PRIMARY KEY,
      post_id    INTEGER REFERENCES posts(id) ON DELETE CASCADE,
      user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
      content    TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Follows
  await pool.query(`
    CREATE TABLE IF NOT EXISTS follows (
      id          SERIAL PRIMARY KEY,
      follower_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      following_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(follower_id, following_id)
    );
  `);

  // Add visibility column to users for profile privacy
  const alters = [
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS password       TEXT DEFAULT ''",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin       BOOLEAN DEFAULT FALSE",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned      BOOLEAN DEFAULT FALSE",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_until   TIMESTAMPTZ DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason     TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS bio            TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS status         TEXT DEFAULT 'online'",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_url     TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_colour  TEXT DEFAULT '#5865f2'",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS post_visibility TEXT DEFAULT 'public'",
    // Profile fields used by the frontend
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name   TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS status_emoji   TEXT DEFAULT '💬'",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS status_text    TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS location       TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS website        TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS steam_id       TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS steam_name     TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS steam_avatar   TEXT DEFAULT NULL",
    // Server settings columns
    "ALTER TABLE servers ADD COLUMN IF NOT EXISTS description  TEXT DEFAULT ''",
    "ALTER TABLE servers ADD COLUMN IF NOT EXISTS banner_url   TEXT DEFAULT NULL",
    "ALTER TABLE servers ADD COLUMN IF NOT EXISTS tags         TEXT DEFAULT '[]'",
    "ALTER TABLE servers ADD COLUMN IF NOT EXISTS unique_id    TEXT DEFAULT NULL",
    "ALTER TABLE server_members ADD COLUMN IF NOT EXISTS role  TEXT DEFAULT 'member'",
  ];
  for (const sql of alters) await pool.query(sql).catch(() => {});

  // Back-fill unique_id for any servers that don't have one yet
  await pool.query(`
    UPDATE servers SET unique_id = UPPER(SUBSTRING(MD5(id::text || name), 1, 6))
    WHERE unique_id IS NULL
  `).catch(() => {});

  console.log("[db] Schema ready");
}

module.exports = { pool, initDb };
