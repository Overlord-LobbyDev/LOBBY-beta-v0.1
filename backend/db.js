require("dotenv").config();
// ============================================================
//  db.js  —  PostgreSQL connection + auto-init tables
// ============================================================

const { Pool } = require("pg");

// Create pool with SSL for Render
const pool = new Pool(
  process.env.DATABASE_URL ? { 
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }  // Required for Render PostgreSQL
  } : {
    host:     process.env.PG_HOST     || "localhost",
    port:     process.env.PG_PORT     || 5432,
    database: process.env.PG_DB       || "discordclone",
    user:     process.env.PG_USER     || "postgres",
    password: process.env.PG_PASSWORD || "8AuqFFqdyde3pN7yXT9X",
  }
);

async function initDb() {
  try {
    console.log("🔄 Initializing database tables...");

    // Users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id           SERIAL PRIMARY KEY,
        username     TEXT UNIQUE NOT NULL,
        email        TEXT UNIQUE,
        password     TEXT NOT NULL,
        avatar_url   TEXT DEFAULT NULL,
        is_admin     BOOLEAN DEFAULT FALSE,
        is_banned    BOOLEAN DEFAULT FALSE,
        banned_until TIMESTAMPTZ DEFAULT NULL,
        ban_reason   TEXT DEFAULT NULL,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Friends table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS friends (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
        friend_id  INTEGER REFERENCES users(id) ON DELETE CASCADE,
        status     TEXT DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, friend_id)
      );
    `);

    // Servers table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS servers (
        id          SERIAL PRIMARY KEY,
        name        TEXT NOT NULL,
        icon_url    TEXT DEFAULT NULL,
        owner_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Server members table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS server_members (
        id         SERIAL PRIMARY KEY,
        server_id  INTEGER REFERENCES servers(id) ON DELETE CASCADE,
        user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
        role       TEXT DEFAULT 'member',
        joined_at  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(server_id, user_id)
      );
    `);

    // Server invites table
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

    // Channels table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS channels (
        id          SERIAL PRIMARY KEY,
        server_id   INTEGER REFERENCES servers(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        type        TEXT DEFAULT 'text',
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Messages table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id          SERIAL PRIMARY KEY,
        channel_id  INTEGER REFERENCES channels(id) ON DELETE CASCADE,
        user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
        content     TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Direct messages table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS direct_messages (
        id           SERIAL PRIMARY KEY,
        from_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        to_user_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
        content      TEXT,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Attachments table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS attachments (
        id           SERIAL PRIMARY KEY,
        message_id   INTEGER REFERENCES messages(id) ON DELETE CASCADE,
        dm_id        INTEGER REFERENCES direct_messages(id) ON DELETE CASCADE,
        file_url     TEXT NOT NULL,
        file_type    TEXT,
        file_size    INTEGER,
        uploaded_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    console.log("✅ Database tables initialized successfully!");
  } catch (error) {
    console.error("❌ Database initialization error:", error);
    process.exit(1);
  }
}

// Auto-initialize on module load
initDb();

module.exports = pool;
