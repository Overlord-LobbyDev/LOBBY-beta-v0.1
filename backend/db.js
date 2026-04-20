require("dotenv").config();
// ============================================================
//  db.js  —  PostgreSQL connection + full schema
// ============================================================

const { Pool } = require("pg");

let pool;

if (process.env.DATABASE_URL) {
  // Using Render or cloud database - explicit URL parsing
  const url = require("url");
  const dbUrl = url.parse(process.env.DATABASE_URL);
  const [user, password] = dbUrl.auth.split(":");
  
  pool = new Pool({
    user: user,
    password: password,
    host: dbUrl.hostname,
    port: dbUrl.port || 5432,
    database: dbUrl.pathname.slice(1),
    ssl: { rejectUnauthorized: false }
  });
}else {
  // Fallback to individual environment variables
  pool = new Pool({
    host: process.env.PG_HOST || 'localhost',
    port: process.env.PG_PORT || 5432,
    database: process.env.PG_DB || 'lobby',
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD,
    ssl: false
  });
}

async function initDb() {
  try {
    console.log("🚀 Initializing database...");
    
    // Users
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id           SERIAL PRIMARY KEY,
        username     TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
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
    // Migration: older databases were created before the attachment columns existed.
    // CREATE TABLE IF NOT EXISTS does NOT alter an existing table, so we add any
    // missing columns here. Using ADD COLUMN IF NOT EXISTS is idempotent.
    await pool.query(`
      ALTER TABLE attachments ADD COLUMN IF NOT EXISTS message_id   INTEGER DEFAULT NULL;
      ALTER TABLE attachments ADD COLUMN IF NOT EXISTS dm_id        INTEGER DEFAULT NULL;
      ALTER TABLE attachments ADD COLUMN IF NOT EXISTS group_msg_id INTEGER DEFAULT NULL;
      ALTER TABLE attachments ADD COLUMN IF NOT EXISTS url          TEXT;
      ALTER TABLE attachments ADD COLUMN IF NOT EXISTS filename     TEXT;
      ALTER TABLE attachments ADD COLUMN IF NOT EXISTS mime_type    TEXT;
      ALTER TABLE attachments ADD COLUMN IF NOT EXISTS size_bytes   INTEGER;
      ALTER TABLE attachments ADD COLUMN IF NOT EXISTS created_at   TIMESTAMPTZ DEFAULT NOW();
    `);

    // Legacy-column migration:
    // The previous schema used "file_url" (NOT NULL) instead of "url".
    // On databases created with that older schema the INSERT into "url"
    // fails with: null value in column "file_url" violates not-null constraint.
    // We:
    //   1. Add file_url if it's somehow missing (no-op on fresh DBs).
    //   2. Drop the NOT NULL constraint so new INSERTs that only set "url" succeed.
    //   3. Backfill file_url from url (and vice-versa) so either column works
    //      for code that reads the legacy name.
    // All statements are idempotent and safe to run on every boot.
    try {
      await pool.query(`
        ALTER TABLE attachments ADD COLUMN IF NOT EXISTS file_url TEXT;
        ALTER TABLE attachments ALTER COLUMN file_url DROP NOT NULL;
        UPDATE attachments SET file_url = url      WHERE file_url IS NULL AND url      IS NOT NULL;
        UPDATE attachments SET url      = file_url WHERE url      IS NULL AND file_url IS NOT NULL;
      `);
    } catch (e) {
      console.warn("[db] legacy file_url migration warning:", e.message);
    }

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

    // Post reactions (replaces post_likes)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS post_reactions (
        id         SERIAL PRIMARY KEY,
        post_id    INTEGER REFERENCES posts(id) ON DELETE CASCADE,
        user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
        emoji      TEXT NOT NULL DEFAULT '❤️',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(post_id, user_id)
      );
    `);

    // One-time migration: copy post_likes → post_reactions as ❤️, then drop old table
    const likesTableExists = await pool.query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_name = 'post_likes'
    `);
    if (likesTableExists.rows.length) {
      await pool.query(`
        INSERT INTO post_reactions (post_id, user_id, emoji)
        SELECT post_id, user_id, '❤️' FROM post_likes
        ON CONFLICT (post_id, user_id) DO NOTHING
      `).catch(() => {});
      await pool.query(`DROP TABLE IF EXISTS post_likes`).catch(() => {});
      console.log("✓ Migrated post_likes → post_reactions");
    }

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

    // Home section order (user preference for Recently Played, Spotlight, Lobbies)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS home_section_order (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE UNIQUE,
        order_json TEXT DEFAULT '[\"homeRecents\",\"homeSpotlight\",\"homeCommunities\"]',
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Add visibility column to users for profile privacy
    const alters = [
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT DEFAULT ''",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin       BOOLEAN DEFAULT FALSE",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned      BOOLEAN DEFAULT FALSE",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_until   TIMESTAMPTZ DEFAULT NULL",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason     TEXT DEFAULT NULL",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS bio            TEXT DEFAULT NULL",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS status         TEXT DEFAULT 'online'",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_url     TEXT DEFAULT NULL",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_colour  TEXT DEFAULT '#5865f2'",
      // App wallpaper settings (global blurred background behind every panel)
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS wallpaper_url      TEXT DEFAULT NULL",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS wallpaper_preset   TEXT DEFAULT NULL",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS wallpaper_use_cover BOOLEAN DEFAULT FALSE",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS wallpaper_blur     INTEGER DEFAULT 40",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS wallpaper_dim      INTEGER DEFAULT 60",
      // When true, the side panels (server list, channel list, members list,
      // home header) stay opaque with their normal background instead of
      // getting a semi-transparent backdrop-blur tint. The wallpaper still
      // shows through the main content area; this just keeps the chrome solid.
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS wallpaper_solid_sidebars BOOLEAN DEFAULT FALSE",
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
      "ALTER TABLE servers ADD COLUMN IF NOT EXISTS unique_id             TEXT DEFAULT NULL",
      "ALTER TABLE servers ADD COLUMN IF NOT EXISTS sidebar_section_order TEXT DEFAULT NULL",
      "ALTER TABLE server_members ADD COLUMN IF NOT EXISTS role  TEXT DEFAULT 'member'",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS presence_status VARCHAR(20) DEFAULT 'online'",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS tournament_card_image_url    TEXT DEFAULT NULL",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS tournament_card_bg_colour    TEXT DEFAULT NULL",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS tournament_card_border_colour TEXT DEFAULT NULL",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS tournament_card_name_colour  TEXT DEFAULT NULL",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS tournament_card_bg_pos       TEXT DEFAULT NULL",
      "ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS has_losers_bracket BOOLEAN DEFAULT FALSE",
      "ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS player1_score   INTEGER DEFAULT 0",
      "ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS player2_score   INTEGER DEFAULT 0",
      // Self-report / API result mode columns
      "ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS result_mode       TEXT DEFAULT 'manual'",
      "ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS api_game          TEXT DEFAULT NULL",
      "ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS dispute_timeout   INTEGER DEFAULT 30",
      "ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS has_points_tally  BOOLEAN DEFAULT TRUE",
      "ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS scheduled_start   TIMESTAMPTZ DEFAULT NULL",
      "ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS alert_before_minutes INTEGER DEFAULT 15",
      "ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS winner_id         INTEGER DEFAULT NULL",
      "ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS join_type         TEXT DEFAULT 'open'",
      "ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS locked_players  JSONB DEFAULT '[]'",
      "ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS round_locked    BOOLEAN DEFAULT FALSE",
      "ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS p1_report       JSONB DEFAULT NULL",
      "ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS p2_report       JSONB DEFAULT NULL",
      "ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS dispute_status  TEXT DEFAULT NULL",
      "ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS dispute_resolved_by INTEGER DEFAULT NULL",
      // Linked game accounts (for API result modes)
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS riot_puuid        TEXT DEFAULT NULL",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS riot_gamename     TEXT DEFAULT NULL",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS riot_tagline      TEXT DEFAULT NULL",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS chess_username    TEXT DEFAULT NULL",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS lichess_username  TEXT DEFAULT NULL",
      // Email — existing users prompted on next login
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS email             TEXT DEFAULT NULL",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_overlord       BOOLEAN DEFAULT FALSE",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS twitch_url        TEXT DEFAULT NULL",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS youtube_url       TEXT DEFAULT NULL",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS twitter_url       TEXT DEFAULT NULL",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS pinned_post_id    INTEGER DEFAULT NULL",
    ];
    for (const sql of alters) await pool.query(sql).catch(() => {});

    // ── Email verification codes (for email prompt on login) ──
    await pool.query(`
      CREATE TABLE IF NOT EXISTS email_verifications (
        id                SERIAL PRIMARY KEY,
        user_id           INTEGER REFERENCES users(id) ON DELETE CASCADE,
        email             TEXT NOT NULL,
        verification_code TEXT NOT NULL,
        code_expires_at   TIMESTAMPTZ NOT NULL,
        attempts          INTEGER NOT NULL DEFAULT 0,
        created_at        TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_email_verif_user ON email_verifications(user_id);`).catch(() => {});

    // ==================== CHESS VERIFICATION ====================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chess_verifications (
        id                SERIAL PRIMARY KEY,
        user_id           INTEGER REFERENCES users(id) ON DELETE CASCADE,
        platform          TEXT NOT NULL CHECK (platform IN ('chess.com', 'lichess')),
        username          TEXT NOT NULL,
        verification_code TEXT NOT NULL,
        code_expires_at   TIMESTAMPTZ NOT NULL,
        attempts          INTEGER NOT NULL DEFAULT 0,
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, platform)
      );
    `);
    
    // Migration: Add code_expires_at column if it doesn't exist (for existing databases)
    try {
      const checkCol = await pool.query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'chess_verifications' AND column_name = 'code_expires_at'
      `);
      if (!checkCol.rows.length) {
        console.log("⚠️  Adding missing code_expires_at column to chess_verifications...");
        await pool.query(`
          ALTER TABLE chess_verifications 
          ADD COLUMN code_expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '15 minutes'
        `);
      }
    } catch (err) {
      console.warn("⚠️  Could not check/add code_expires_at column:", err.message);
    }
    
    // Migration: Add attempts column if it doesn't exist
    try {
      const checkCol = await pool.query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'chess_verifications' AND column_name = 'attempts'
      `);
      if (!checkCol.rows.length) {
        console.log("⚠️  Adding missing attempts column to chess_verifications...");
        await pool.query(`
          ALTER TABLE chess_verifications 
          ADD COLUMN attempts INTEGER DEFAULT 0
        `);
      }
    } catch (err) {
      console.warn("⚠️  Could not check/add attempts column:", err.message);
    }

    // Migration: Add unique constraint on (user_id, platform) if it doesn't exist
    try {
      const checkConstraint = await pool.query(`
        SELECT constraint_name FROM information_schema.table_constraints 
        WHERE table_name = 'chess_verifications' AND constraint_name = 'chess_verifications_user_id_platform_key'
      `);
      if (!checkConstraint.rows.length) {
        console.log("⚠️  Adding missing unique constraint to chess_verifications...");
        await pool.query(`
          ALTER TABLE chess_verifications 
          ADD CONSTRAINT chess_verifications_user_id_platform_key UNIQUE(user_id, platform)
        `);
      }
    } catch (err) {
      console.warn("⚠️  Could not add unique constraint:", err.message);
    }
    
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_chess_verifications_user_id ON chess_verifications(user_id);`).catch(() => {});

    // Back-fill unique_id for any servers that don't have one yet
    await pool.query(`
      UPDATE servers SET unique_id = UPPER(SUBSTRING(MD5(id::text || name), 1, 6))
      WHERE unique_id IS NULL
    `).catch(() => {});

    // ==================== TOURNAMENTS ====================
    // Tournaments
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tournaments (
        id          SERIAL PRIMARY KEY,
        lobby_id    TEXT NOT NULL,
        host_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        description TEXT DEFAULT NULL,
        format      TEXT NOT NULL CHECK (format IN ('single', 'double', 'round-robin')),
        player_count INTEGER NOT NULL CHECK (player_count IN (4, 8, 16, 32, 64, 128)),
        max_players INTEGER NOT NULL,
        status      TEXT NOT NULL DEFAULT 'setup' CHECK (status IN ('setup', 'registration', 'in-progress', 'completed', 'cancelled')),
        rules       TEXT DEFAULT NULL,
        prize       TEXT DEFAULT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        start_time  TIMESTAMPTZ DEFAULT NULL,
        end_time    TIMESTAMPTZ DEFAULT NULL
      );
    `);

    // Tournament Players (registered players)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tournament_players (
        id            SERIAL PRIMARY KEY,
        tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
        user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
        username      TEXT NOT NULL,
        joined_at     TIMESTAMPTZ DEFAULT NOW(),
        status        TEXT NOT NULL DEFAULT 'registered' CHECK (status IN ('registered', 'checked-in', 'eliminated', 'winner')),
        UNIQUE(tournament_id, user_id)
      );
    `);

    // Tournament Rounds
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tournament_rounds (
        id            SERIAL PRIMARY KEY,
        tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
        round_number  INTEGER NOT NULL,
        UNIQUE(tournament_id, round_number)
      );
    `);

    // Tournament Matches
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tournament_matches (
        id            SERIAL PRIMARY KEY,
        round_id      INTEGER REFERENCES tournament_rounds(id) ON DELETE CASCADE,
        tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
        match_number  INTEGER NOT NULL,
        player1_id    INTEGER REFERENCES tournament_players(id) ON DELETE SET NULL,
        player2_id    INTEGER REFERENCES tournament_players(id) ON DELETE SET NULL,
        winner_id     INTEGER REFERENCES tournament_players(id) ON DELETE SET NULL,
        status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in-progress', 'completed', 'bye')),
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        completed_at  TIMESTAMPTZ DEFAULT NULL
      );
    `);

    // Tournament Invites (for invite-only tournaments)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tournament_invites (
        id            SERIAL PRIMARY KEY,
        tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
        invited_by    INTEGER REFERENCES users(id) ON DELETE CASCADE,
        invited_user  INTEGER REFERENCES users(id) ON DELETE CASCADE,
        status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(tournament_id, invited_user)
      );
    `);

    // ── Core performance indexes ─────────────────────────────────
    // users — login lookups and search
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_username       ON users(username);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_username_lower ON users(lower(username));`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_email          ON users(email) WHERE email IS NOT NULL;`).catch(() => {});

    // messages — channel history (most-queried table)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_channel_id         ON messages(channel_id);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_channel_created    ON messages(channel_id, created_at DESC);`).catch(() => {});

    // direct_messages — DM conversation queries
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_dm_from_user   ON direct_messages(from_user_id);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_dm_to_user     ON direct_messages(to_user_id);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_dm_convo       ON direct_messages(LEAST(from_user_id,to_user_id), GREATEST(from_user_id,to_user_id), created_at DESC);`).catch(() => {});

    // friends — friend list and request lookups
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_friends_user_id   ON friends(user_id);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_friends_friend_id ON friends(friend_id);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_friends_status    ON friends(user_id, status);`).catch(() => {});

    // follows — follower/following counts
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_follows_follower  ON follows(follower_id);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);`).catch(() => {});

    // server_members — role checks (hit on almost every server request)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_server_members_server_user ON server_members(server_id, user_id);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_server_members_user        ON server_members(user_id);`).catch(() => {});

    // posts — feed and profile page
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_posts_user_id     ON posts(user_id);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_posts_created_at  ON posts(created_at DESC);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_posts_visibility  ON posts(visibility);`).catch(() => {});

    // post_reactions — reaction counts and per-user checks
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_post_reactions_post       ON post_reactions(post_id);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_post_reactions_post_user  ON post_reactions(post_id, user_id);`).catch(() => {});

    // post_comments — comment counts per post
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_post_comments_post_id ON post_comments(post_id);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_post_comments_user_id ON post_comments(user_id);`).catch(() => {});

    // group_members / group_messages — group chat performance
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_group_members_group   ON group_members(group_id);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_group_members_user    ON group_members(user_id);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_group_messages_group  ON group_messages(group_id);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_group_messages_group_created ON group_messages(group_id, created_at DESC);`).catch(() => {});

    // ── Tournament performance indexes ───────────────────────────
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tournaments_lobby_id ON tournaments(lobby_id);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tournaments_host_id ON tournaments(host_id);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tournaments_status ON tournaments(status);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tournament_players_tournament_id ON tournament_players(tournament_id);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tournament_players_user_id ON tournament_players(user_id);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tournament_rounds_tournament_id ON tournament_rounds(tournament_id);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tournament_matches_round_id ON tournament_matches(round_id);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tournament_matches_tournament_id ON tournament_matches(tournament_id);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tournament_invites_tournament_id ON tournament_invites(tournament_id);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tournament_invites_invited_user ON tournament_invites(invited_user);`).catch(() => {});

    // Profanity words list
    await pool.query(`
      CREATE TABLE IF NOT EXISTS profanity_words (
        id         SERIAL PRIMARY KEY,
        word       TEXT UNIQUE NOT NULL,
        added_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Admin announcements
    await pool.query(`
      CREATE TABLE IF NOT EXISTS announcements (
        id          SERIAL PRIMARY KEY,
        title       TEXT NOT NULL,
        body        TEXT NOT NULL,
        link        TEXT DEFAULT NULL,
        server_id   INTEGER REFERENCES servers(id) ON DELETE CASCADE DEFAULT NULL,
        sent_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    console.log("✅ Database initialized successfully!");
    // process.exit(0) removed — let caller handle startup
  } catch (error) {
    console.error("❌ Database initialization failed:", error.message);
    console.error("Error details:", error);
    throw error;
  }
}

module.exports = { pool, initDb };