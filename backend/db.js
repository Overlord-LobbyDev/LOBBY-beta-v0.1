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

    // Reactions on comments. Deliberately the same shape as
    // post_reactions -- one row per user per comment with the emoji on
    // the row, and UNIQUE(comment_id, user_id) -- so the toggle /
    // switch / remove behaviour and the aggregate queries are identical
    // to the ones already written for posts.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS comment_reactions (
        id         SERIAL PRIMARY KEY,
        comment_id INTEGER REFERENCES post_comments(id) ON DELETE CASCADE,
        user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
        emoji      TEXT NOT NULL DEFAULT '👍',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(comment_id, user_id)
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
      -- Generic per-user UI preferences, keyed by surface.
      --
      -- home_section_order is a table that can hold exactly one kind of
      -- preference. Rather than add a second single-purpose table every
      -- time a surface becomes reorderable, this one is keyed by (user,
      -- key) and holds arbitrary JSON. Discover rail order is the first
      -- tenant.
      CREATE TABLE IF NOT EXISTS ui_prefs (
        user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
        pref_key   TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (user_id, pref_key)
      );

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

      // ── Tournaments: hub tournaments vs Lobby tournaments ──────────
      // scope tells the two apart instead of inferring it from whether
      // the holding lobby happens to be public. Defaults keep every
      // existing row exactly what it already was: a lobby tournament.
      "ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS scope      TEXT DEFAULT 'lobby'",
      "ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS visibility TEXT DEFAULT 'public'",
      // Four letters then four digits, e.g. KRVX4417. Its own code type —
      // nothing else in the app uses this shape.
      "ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS join_code  TEXT DEFAULT NULL",
      // A hub tournament has no lobby, and NULL is how it says so.
      "ALTER TABLE tournaments ALTER COLUMN lobby_id DROP NOT NULL",
    ];
    for (const sql of alters) await pool.query(sql).catch(() => {});

    // Uniqueness is the index's job, not the generator's. Partial, so the
    // NULL join_code every public tournament carries does not collide.
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_tourney_join_code
         ON tournaments(join_code) WHERE join_code IS NOT NULL;`
    ).catch(() => {});
    // The hub's browse query filters on both of these together.
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_tourney_scope_vis
         ON tournaments(scope, visibility, status);`
    ).catch(() => {});

    // ── Majors: real-world events, curated ─────────────────────────
    // Evo, CEO, ECW, championship finals. These are NOT playable here —
    // there is no bracket, no entrants and no join. They are a followable
    // countdown and a link out, which is the only honest thing to offer
    // for an event this app does not run.
    //
    // Nothing seeds this table. It stays empty until a real event is put
    // in it, and the rail hides itself when it is empty rather than
    // showing invented fixtures.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS majors (
        id           SERIAL PRIMARY KEY,
        name         TEXT NOT NULL,
        game         TEXT,
        organiser    TEXT,
        location     TEXT,
        starts_at    TIMESTAMPTZ,
        ends_at      TIMESTAMPTZ,
        url          TEXT,
        stream_url   TEXT,
        art_url      TEXT,
        tier         TEXT DEFAULT 'major',
        sort_order   INTEGER DEFAULT 0,
        is_published BOOLEAN DEFAULT FALSE,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      );
    `).catch((e) => console.error("[majors]", e.message));
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_majors_window
         ON majors(is_published, starts_at);`
    ).catch(() => {});

    // ── Stream discovery ───────────────────────────────────────────
    // A source is a CHANNEL, not an event. Nobody should have to type in
    // that ESL is running a StarCraft final tonight -- the channel is
    // known, so what is on it can be discovered.
    //
    // Deliberately platform-tagged rather than YouTube-only: Twitch
    // cannot be embedded from a file:// renderer today, but a Twitch row
    // is still worth storing so it can be linked out to, and so nothing
    // has to be migrated when the renderer gets a real origin.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS stream_sources (
        id         SERIAL PRIMARY KEY,
        platform   TEXT NOT NULL DEFAULT 'youtube',
        channel_id TEXT NOT NULL,
        name       TEXT,
        game       TEXT,
        organiser  TEXT,
        weight     INTEGER DEFAULT 0,
        is_enabled BOOLEAN DEFAULT TRUE,
        last_checked_at TIMESTAMPTZ,
        last_error TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (platform, channel_id)
      );
    `).catch((e) => console.error("[stream_sources]", e.message));

    // What the poller last saw. In the database, not in memory: a restart
    // must not blank the page, and two instances must not disagree about
    // what is live.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS stream_cache (
        source_id    INTEGER REFERENCES stream_sources(id) ON DELETE CASCADE,
        video_id     TEXT NOT NULL,
        title        TEXT,
        thumb_url    TEXT,
        state        TEXT,               -- live | upcoming
        scheduled_at TIMESTAMPTZ,
        viewers      INTEGER,
        fetched_at   TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (source_id, video_id)
      );
    `).catch((e) => console.error("[stream_cache]", e.message));
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_stream_cache_state
         ON stream_cache(state, scheduled_at);`
    ).catch(() => {});

    // ── A user's own channels ──────────────────────────────────────
    // Linking is a claim, not proof. `verified` stays FALSE until a real
    // check exists, and nothing is granted on the strength of it -- the
    // column is there so a later verification flow has somewhere to write.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_streams (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
        platform   TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        handle     TEXT,
        url        TEXT,
        verified   BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (user_id, platform, channel_id)
      );
    `).catch((e) => console.error("[user_streams]", e.message));
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_user_streams_user ON user_streams(user_id);`
    ).catch(() => {});

    // The OAuth result. access_token / refresh_token are CREDENTIALS:
    // never select them into anything a client reads, and never widen a
    // query on this table to SELECT *. They are here so a link can be
    // refreshed without sending the user back through consent.
    for (const sql of [
      "ALTER TABLE user_streams ADD COLUMN IF NOT EXISTS access_token     TEXT",
      "ALTER TABLE user_streams ADD COLUMN IF NOT EXISTS refresh_token    TEXT",
      "ALTER TABLE user_streams ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ",
      "ALTER TABLE user_streams ADD COLUMN IF NOT EXISTS scope            TEXT",
      // The one-time code a channel owner puts in their description to
      // prove they can edit it. Cleared the moment it is matched.
      "ALTER TABLE user_streams ADD COLUMN IF NOT EXISTS verify_code       TEXT",
      "ALTER TABLE user_streams ADD COLUMN IF NOT EXISTS verify_expires_at TIMESTAMPTZ",
    ]) await pool.query(sql).catch(() => {});

    await pool.query(`
      CREATE TABLE IF NOT EXISTS major_follows (
        major_id   INTEGER REFERENCES majors(id) ON DELETE CASCADE,
        user_id    INTEGER REFERENCES users(id)  ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (major_id, user_id)
      );
    `).catch((e) => console.error("[major_follows]", e.message));

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

    // ==================== HALL OF FAME / TIMELINE ====================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lobby_timeline_events (
        id           SERIAL PRIMARY KEY,
        server_id    INTEGER REFERENCES servers(id) ON DELETE CASCADE,
        type         TEXT NOT NULL DEFAULT 'manual'
                       CHECK (type IN ('tournament','viral_post','milestone','manual')),
        title        TEXT NOT NULL,
        description  TEXT DEFAULT NULL,
        image_url    TEXT DEFAULT NULL,
        ref_id       INTEGER DEFAULT NULL,
        ref_type     TEXT DEFAULT NULL,
        captured_at  TIMESTAMPTZ DEFAULT NOW(),
        pinned       BOOLEAN DEFAULT FALSE,
        created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_timeline_server_id ON lobby_timeline_events(server_id);`).catch(()=>{});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_timeline_captured_at ON lobby_timeline_events(server_id, captured_at DESC);`).catch(()=>{});

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

    // ── Speedrunning ───────────────────────────────────────────────
    // Reference data -- games, categories, world records -- comes from
    // speedrun.com directly in the client, which is CORS-open. What
    // lives here is only the part speedrun.com has no equivalent for:
    // Lobby's own submissions, scheduled attempts with RSVPs, and races.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS speedrun_runs (
        id           SERIAL PRIMARY KEY,
        user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
        game         TEXT NOT NULL,
        category     TEXT NOT NULL DEFAULT 'Any%',
        time_text    TEXT NOT NULL,
        -- Parsed alongside the text so runs can be ranked. The text is
        -- kept exactly as entered, because that is what gets displayed
        -- and reformatting someone's time is not this table's job.
        time_ms      BIGINT,
        video_url    TEXT DEFAULT NULL,
        notes        TEXT DEFAULT NULL,
        status       TEXT NOT NULL DEFAULT 'pending',
        submitted_at TIMESTAMPTZ DEFAULT NOW(),
        verified_at  TIMESTAMPTZ DEFAULT NULL
      );
    `);

    // An attempt is somebody saying "I am running this, now or later".
    await pool.query(`
      CREATE TABLE IF NOT EXISTS speedrun_attempts (
        id            SERIAL PRIMARY KEY,
        user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
        game          TEXT NOT NULL,
        category      TEXT DEFAULT NULL,
        state         TEXT NOT NULL DEFAULT 'scheduled',
        scheduled_for TIMESTAMPTZ DEFAULT NULL,
        started_at    TIMESTAMPTZ DEFAULT NULL,
        ended_at      TIMESTAMPTZ DEFAULT NULL,
        video_url     TEXT DEFAULT NULL,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS speedrun_attempt_rsvps (
        id         SERIAL PRIMARY KEY,
        attempt_id INTEGER REFERENCES speedrun_attempts(id) ON DELETE CASCADE,
        user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(attempt_id, user_id)
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS speedrun_races (
        id            SERIAL PRIMARY KEY,
        host_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
        title         TEXT NOT NULL,
        game          TEXT NOT NULL,
        category      TEXT DEFAULT NULL,
        prize         TEXT DEFAULT NULL,
        status        TEXT NOT NULL DEFAULT 'upcoming',
        scheduled_for TIMESTAMPTZ DEFAULT NULL,
        started_at    TIMESTAMPTZ DEFAULT NULL,
        ended_at      TIMESTAMPTZ DEFAULT NULL,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS speedrun_race_entrants (
        id          SERIAL PRIMARY KEY,
        race_id     INTEGER REFERENCES speedrun_races(id) ON DELETE CASCADE,
        user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
        joined_at   TIMESTAMPTZ DEFAULT NOW(),
        finished_at TIMESTAMPTZ DEFAULT NULL,
        time_ms     BIGINT DEFAULT NULL,
        UNIQUE(race_id, user_id)
      );
    `);

    // ── Matchmaking queue ──────────────────────────────────────────
    // A session is one group being assembled. People join an existing
    // searching session rather than being paired off in a separate
    // step, so "a match" and "a party" are the same row and there is
    // no window where a match exists but the group does not.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS queue_sessions (
        id          SERIAL PRIMARY KEY,
        game        TEXT NOT NULL,
        players     INTEGER NOT NULL,
        skill       TEXT NOT NULL DEFAULT 'plat',
        state       TEXT NOT NULL DEFAULT 'searching',
        owner_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        matched_at  TIMESTAMPTZ DEFAULT NULL,
        ended_at    TIMESTAMPTZ DEFAULT NULL,
        server_id   INTEGER DEFAULT NULL
      );
    `);

    // ── Blocking ───────────────────────────────────────────────────
    // The queue puts you in a voice call with strangers, and until this
    // existed nothing stopped it putting you back with someone you had
    // already left. queue_members.kicked is per-session; this is not.
    //
    // Read in BOTH directions when matching: if either party has blocked
    // the other, neither should be offered the other's table. Blocking
    // someone who can still be matched with you is not blocking.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_blocks (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
        blocked_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        reason     TEXT DEFAULT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, blocked_id)
      );
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_user_blocks_pair ON user_blocks(user_id, blocked_id);`
    );

    // Reports raised from a queue session. Kept separate from blocks:
    // blocking is a private preference and takes effect immediately,
    // reporting is a request for someone to look.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS queue_reports (
        id          SERIAL PRIMARY KEY,
        session_id  INTEGER REFERENCES queue_sessions(id) ON DELETE SET NULL,
        reporter_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        target_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
        reason      TEXT NOT NULL,
        detail      TEXT DEFAULT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Filters added after the table shipped. Idempotent, so an existing
    // database picks them up on the next boot.
    //
    // NULL means "no preference" throughout, which is what makes the
    // matching rule symmetrical: two sides agree when either has no
    // preference or both want the same thing. A default of 'casual'
    // would silently exclude everyone who never touched the control.
    await pool.query(`
      ALTER TABLE queue_sessions ADD COLUMN IF NOT EXISTS mic       BOOLEAN DEFAULT NULL;
      ALTER TABLE queue_sessions ADD COLUMN IF NOT EXISTS playstyle TEXT    DEFAULT NULL;
      ALTER TABLE queue_sessions ADD COLUMN IF NOT EXISTS mode      TEXT    DEFAULT NULL;
      ALTER TABLE queue_sessions ADD COLUMN IF NOT EXISTS width     TEXT    DEFAULT NULL;
      ALTER TABLE queue_sessions ADD COLUMN IF NOT EXISTS steam_only    BOOLEAN DEFAULT FALSE;
      ALTER TABLE queue_sessions ADD COLUMN IF NOT EXISTS min_age_days  INTEGER DEFAULT 0;
      ALTER TABLE queue_sessions ADD COLUMN IF NOT EXISTS verified_tier BOOLEAN DEFAULT FALSE;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS queue_members (
        id         SERIAL PRIMARY KEY,
        session_id INTEGER REFERENCES queue_sessions(id) ON DELETE CASCADE,
        user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
        skill      TEXT DEFAULT NULL,
        proof      TEXT DEFAULT NULL,
        joined_at  TIMESTAMPTZ DEFAULT NOW(),
        left_at    TIMESTAMPTZ DEFAULT NULL,
        kicked     BOOLEAN DEFAULT FALSE,
        UNIQUE(session_id, user_id)
      );
    `);

    // One row per voter per target. The UNIQUE is what stops a member
    // voting twice to force a kick through on their own.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS queue_votes (
        id         SERIAL PRIMARY KEY,
        session_id INTEGER REFERENCES queue_sessions(id) ON DELETE CASCADE,
        voter_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
        target_id  INTEGER REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(session_id, voter_id, target_id)
      );
    `);

    // A table decides things out loud. One row per question asked at a
    // table -- "what are we playing", "ready?", "one more?" -- and one
    // row per vote cast, with the UNIQUE doing the same job it does for
    // kicks: you get one voice, not as many as you can click.
    //
    // kind separates a plain poll from one with consequences. A kick
    // still runs through queue_votes, which already enforces the
    // majority; a poll of kind 'kick' is the visible face of it, so
    // nobody is removed by a mechanism the table cannot see.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS queue_polls (
        id         SERIAL PRIMARY KEY,
        session_id INTEGER REFERENCES queue_sessions(id) ON DELETE CASCADE,
        author_id  INTEGER REFERENCES users(id) ON DELETE CASCADE,
        kind       TEXT NOT NULL DEFAULT 'poll',
        question   TEXT NOT NULL,
        options    JSONB NOT NULL DEFAULT '[]'::jsonb,
        target_id  INTEGER REFERENCES users(id) ON DELETE CASCADE,
        closes_at  TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '60 seconds',
        closed     BOOLEAN DEFAULT FALSE,
        result     TEXT DEFAULT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS queue_poll_votes (
        id         SERIAL PRIMARY KEY,
        poll_id    INTEGER REFERENCES queue_polls(id) ON DELETE CASCADE,
        voter_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
        choice     INTEGER NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(poll_id, voter_id)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_queue_polls_session ON queue_polls(session_id);`).catch(() => {});

    // The invite code for the actual game lobby, posted once and copied
    // by everyone. It lives on the session so a member who arrives late,
    // or reloads, gets it without asking anyone to paste it again.
    // locked closes the door on a table that is short-handed but happy.
    await pool.query(`ALTER TABLE queue_sessions ADD COLUMN IF NOT EXISTS lobby_code TEXT DEFAULT NULL;`).catch(() => {});
    await pool.query(`ALTER TABLE queue_sessions ADD COLUMN IF NOT EXISTS lobby_note TEXT DEFAULT NULL;`).catch(() => {});
    await pool.query(`ALTER TABLE queue_sessions ADD COLUMN IF NOT EXISTS locked BOOLEAN DEFAULT FALSE;`).catch(() => {});

    // What was said at the table. Voice is the main channel, but a
    // lobby code, a tracker link or a name is something you paste and
    // read back -- reading a code out loud over a mic is the worst
    // possible way to transmit it. Short-lived: the table is.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS queue_messages (
        id         SERIAL PRIMARY KEY,
        session_id INTEGER REFERENCES queue_sessions(id) ON DELETE CASCADE,
        user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
        body       TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_queue_messages_session ON queue_messages(session_id, created_at);`).catch(() => {});

    // Which position each player has claimed. Games with roles turn
    // "who is playing what" from an argument into a glance, and a
    // table that knows its unfilled role can eventually ask the
    // matcher for that one specifically.
    await pool.query(`ALTER TABLE queue_members ADD COLUMN IF NOT EXISTS role TEXT DEFAULT NULL;`).catch(() => {});

    // An invite to a specific empty seat. Kept in the database rather
    // than pushed and forgotten: the most likely person to fill a seat
    // is a friend who is three minutes from looking at their screen.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS queue_invites (
        id         SERIAL PRIMARY KEY,
        session_id INTEGER REFERENCES queue_sessions(id) ON DELETE CASCADE,
        from_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
        to_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
        status     TEXT DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(session_id, to_id)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_queue_invites_to ON queue_invites(to_id, status);`).catch(() => {});

    // Standing behind a full table. A popular table currently turns
    // people away at the door with nothing they can do about it.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS queue_waitlist (
        id         SERIAL PRIMARY KEY,
        session_id INTEGER REFERENCES queue_sessions(id) ON DELETE CASCADE,
        user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
        skill      TEXT DEFAULT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(session_id, user_id)
      );
    `);

    // One score per person per table. This is what makes the trust
    // filters in the queue bar mean anything -- they were filtering on
    // data almost nobody was generating.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS queue_ratings (
        id         SERIAL PRIMARY KEY,
        session_id INTEGER REFERENCES queue_sessions(id) ON DELETE CASCADE,
        rater_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
        target_id  INTEGER REFERENCES users(id) ON DELETE CASCADE,
        score      INTEGER NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(session_id, rater_id, target_id)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_queue_ratings_target ON queue_ratings(target_id);`).catch(() => {});

    // The right four people at the wrong hour is the commonest way a
    // group fails. A scheduled table is the same table, agreed early.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS queue_scheduled (
        id         SERIAL PRIMARY KEY,
        owner_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
        game       TEXT,
        players    INTEGER DEFAULT 2,
        skill      TEXT DEFAULT NULL,
        starts_at  TIMESTAMPTZ NOT NULL,
        note       TEXT DEFAULT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS queue_scheduled_members (
        id           SERIAL PRIMARY KEY,
        scheduled_id INTEGER REFERENCES queue_scheduled(id) ON DELETE CASCADE,
        user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
        rsvp         TEXT DEFAULT 'invited',
        UNIQUE(scheduled_id, user_id)
      );
    `);

    // Self-reported, because only the client can measure its own round
    // trip. Shown so a table can see it straddles two regions BEFORE
    // everyone has loaded in, which is when it still costs nothing.
    await pool.query(`ALTER TABLE queue_members ADD COLUMN IF NOT EXISTS ping_ms INTEGER DEFAULT NULL;`).catch(() => {});
    await pool.query(`ALTER TABLE queue_members ADD COLUMN IF NOT EXISTS region TEXT DEFAULT NULL;`).catch(() => {});

    // Started, but not closed. A group that begins playing three-handed
    // is still a group that wants a fourth -- locking was the only way
    // to say "we have started", and it slammed the door at the same
    // time. This separates the two.
    await pool.query(`ALTER TABLE queue_sessions ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ DEFAULT NULL;`).catch(() => {});

    // "We are still here." The idle rule reclaims a quiet short-handed
    // table after twenty minutes; this is how a table says it means to
    // keep waiting, without having to type something to prove it.
    await pool.query(`ALTER TABLE queue_sessions ADD COLUMN IF NOT EXISTS kept_at TIMESTAMPTZ DEFAULT NULL;`).catch(() => {});

    // A table's own short code, so it can be found by being told rather
    // than by being browsed. Distinct from lobby_code, which is the
    // GAME's invite code -- this one addresses the Lobby table itself.
    await pool.query(`ALTER TABLE queue_sessions ADD COLUMN IF NOT EXISTS join_code TEXT DEFAULT NULL;`).catch(() => {});
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_join_code ON queue_sessions(join_code) WHERE join_code IS NOT NULL;`).catch(() => {});

    // Hours in THIS game, reported by the client when it sits down.
    // Only the client knows it -- it comes from the Steam library the
    // queue page already loaded -- and it is the single most useful
    // thing to know about somebody you are about to play with.
    await pool.query(`ALTER TABLE queue_members ADD COLUMN IF NOT EXISTS hours INTEGER DEFAULT NULL;`).catch(() => {});

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

    // speedrun — the PB lookup ranks within a game+category, and the
    // hub lists by state on every open.
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sr_runs_board   ON speedrun_runs(game, category, status, time_ms);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sr_runs_user    ON speedrun_runs(user_id, status);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sr_attempts     ON speedrun_attempts(state, scheduled_for);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sr_races        ON speedrun_races(status, scheduled_for);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sr_race_entrants ON speedrun_race_entrants(race_id);`).catch(() => {});

    // queue — the matcher scans open sessions by game on every intent,
    // and the roster is read on every status poll.
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_queue_sessions_open  ON queue_sessions(state, game);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_queue_members_session ON queue_members(session_id);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_queue_members_user    ON queue_members(user_id);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_queue_votes_session   ON queue_votes(session_id);`).catch(() => {});

    // post_comments — comment counts per post
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_post_comments_post_id ON post_comments(post_id);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_post_comments_user_id ON post_comments(user_id);`).catch(() => {});

    // comment_reactions -- the per-comment aggregate runs once for every
    // comment in a thread, so comment_id is the index that matters.
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_comment_reactions_comment      ON comment_reactions(comment_id);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_comment_reactions_comment_user ON comment_reactions(comment_id, user_id);`).catch(() => {});

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

    // ============================================================
    // ── LADDER SYSTEM: seasons, ratings, transactions, anti-abuse
    //    See LADDER_SYSTEM_DESIGN.md for design rationale.
    // ============================================================

    // Seasons (Spring '27, Summer '27, etc.)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS seasons (
        id                     SERIAL PRIMARY KEY,
        code                   TEXT UNIQUE NOT NULL,
        name                   TEXT NOT NULL,
        start_at               TIMESTAMPTZ NOT NULL,
        end_at                 TIMESTAMPTZ NOT NULL,
        status                 TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming','active','archived')),
        compression_multiplier NUMERIC NOT NULL DEFAULT 0.5,
        compression_anchor     INTEGER NOT NULL DEFAULT 500,
        created_at             TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Games registry
    await pool.query(`
      CREATE TABLE IF NOT EXISTS games (
        id                 SERIAL PRIMARY KEY,
        tag_normalized     TEXT UNIQUE NOT NULL,
        display_name       TEXT NOT NULL,
        tournaments_count  INTEGER NOT NULL DEFAULT 0,
        first_seen         TIMESTAMPTZ DEFAULT NOW(),
        last_seen          TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // User ratings (per-user per-game per-season; game_tag_normalized = '__global__' for Global ladder)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_ratings (
        id                          SERIAL PRIMARY KEY,
        user_id                     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        game_tag_normalized         TEXT NOT NULL,
        season_id                   INTEGER REFERENCES seasons(id) ON DELETE SET NULL,
        current_rp                  INTEGER NOT NULL DEFAULT 0,
        current_elo                 INTEGER NOT NULL DEFAULT 1200,
        peak_rp                     INTEGER NOT NULL DEFAULT 0,
        peak_tier                   TEXT,
        previous_season_peak_tier   TEXT,
        placement_matches_remaining INTEGER NOT NULL DEFAULT 5,
        ranked_matches_played       INTEGER NOT NULL DEFAULT 0,
        ranked_tournaments_played   INTEGER NOT NULL DEFAULT 0,
        ranked_wins                 INTEGER NOT NULL DEFAULT 0,
        last_active                 TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (user_id, game_tag_normalized, season_id)
      );
    `);

    // Archived per-season snapshots
    await pool.query(`
      CREATE TABLE IF NOT EXISTS season_ratings (
        id                  SERIAL PRIMARY KEY,
        user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        season_id           INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
        game_tag_normalized TEXT NOT NULL,
        final_rp            INTEGER NOT NULL,
        peak_rp             INTEGER NOT NULL,
        final_tier          TEXT NOT NULL,
        peak_tier           TEXT NOT NULL,
        final_placement     INTEGER,
        tournaments_played  INTEGER NOT NULL DEFAULT 0,
        archived_at         TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (user_id, season_id, game_tag_normalized)
      );
    `);

    // RP audit log
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rp_transactions (
        id                  SERIAL PRIMARY KEY,
        user_id             INTEGER REFERENCES users(id) ON DELETE SET NULL,
        tournament_id       INTEGER REFERENCES tournaments(id) ON DELETE SET NULL,
        season_id           INTEGER REFERENCES seasons(id) ON DELETE SET NULL,
        game_tag_normalized TEXT NOT NULL,
        delta               INTEGER NOT NULL,
        reason              TEXT NOT NULL,
        breakdown           JSONB,
        rp_before           INTEGER NOT NULL,
        rp_after            INTEGER NOT NULL,
        created_at          TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Per-match per-player confirmation log
    await pool.query(`
      CREATE TABLE IF NOT EXISTS match_confirmations (
        id           SERIAL PRIMARY KEY,
        match_id     INTEGER NOT NULL REFERENCES tournament_matches(id) ON DELETE CASCADE,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        confirmed_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (match_id, user_id)
      );
    `);

    // Cached host trust scores
    await pool.query(`
      CREATE TABLE IF NOT EXISTS host_trust_scores (
        host_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        score         NUMERIC NOT NULL DEFAULT 0.2,
        components    JSONB,
        last_computed TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Smurf flags
    await pool.query(`
      CREATE TABLE IF NOT EXISTS smurf_flags (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reason      TEXT NOT NULL,
        score       NUMERIC NOT NULL,
        flagged_at  TIMESTAMPTZ DEFAULT NOW(),
        cleared_at  TIMESTAMPTZ DEFAULT NULL,
        cleared_by  INTEGER REFERENCES users(id) ON DELETE SET NULL
      );
    `);

    // Ladder columns added to existing tables (idempotent)
    await pool.query(`
      ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS game_tag                    TEXT;
      ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS game_tag_normalized         TEXT;
      ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS is_ranked                   BOOLEAN DEFAULT TRUE;
      ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS recommended_skill_tier      TEXT DEFAULT 'open';
      ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS host_rank_at_creation_global TEXT;
      ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS host_rank_at_creation_game  TEXT;
      ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS auto_tier                   TEXT;
      ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS credibility_score           NUMERIC;
      ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS computed_winner_rp          INTEGER;
      ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS is_featured                 BOOLEAN DEFAULT FALSE;
      ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS admin_rp_override           INTEGER;
      ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS featured_tier_label         TEXT;
      ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS featured_by                 INTEGER REFERENCES users(id) ON DELETE SET NULL;
      ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS featured_at                 TIMESTAMPTZ;
      ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS rp_awarded                  BOOLEAN DEFAULT FALSE;
      ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS season_id_at_completion     INTEGER REFERENCES seasons(id) ON DELETE SET NULL;
    `);

    await pool.query(`
      ALTER TABLE servers ADD COLUMN IF NOT EXISTS lobby_verified BOOLEAN DEFAULT FALSE;
      ALTER TABLE servers ADD COLUMN IF NOT EXISTS verified_at    TIMESTAMPTZ;
      ALTER TABLE servers ADD COLUMN IF NOT EXISTS verified_by    INTEGER REFERENCES users(id) ON DELETE SET NULL;
    `);

    await pool.query(`
      ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS confirmed_by_p1 BOOLEAN DEFAULT FALSE;
      ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS confirmed_by_p2 BOOLEAN DEFAULT FALSE;
    `);

    // Ladder indexes
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_ratings_user_id        ON user_ratings(user_id);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_ratings_game_season    ON user_ratings(game_tag_normalized, season_id);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_ratings_global_rp      ON user_ratings(game_tag_normalized, season_id, current_rp DESC);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_ratings_last_active    ON user_ratings(last_active DESC);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_season_ratings_user         ON season_ratings(user_id);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_season_ratings_season_game  ON season_ratings(season_id, game_tag_normalized, final_rp DESC);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_rp_transactions_user        ON rp_transactions(user_id, created_at DESC);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_rp_transactions_tournament  ON rp_transactions(tournament_id);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_match_confirmations_match   ON match_confirmations(match_id);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_match_confirmations_user    ON match_confirmations(user_id);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_smurf_flags_user            ON smurf_flags(user_id) WHERE cleared_at IS NULL;`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_games_tag                   ON games(tag_normalized);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_seasons_status              ON seasons(status);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_seasons_dates               ON seasons(start_at, end_at);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tournaments_game_normalized ON tournaments(game_tag_normalized);`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tournaments_is_featured     ON tournaments(is_featured) WHERE is_featured = TRUE;`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tournaments_rp_awarded      ON tournaments(rp_awarded);`).catch(() => {});

    // Seed the initial season if none active.
    try {
      const existing = await pool.query(`SELECT id FROM seasons WHERE status = 'active' LIMIT 1`);
      if (!existing.rows.length) {
        const now = new Date();
        const month = now.getUTCMonth();
        const year  = now.getUTCFullYear();
        let seasonName, startMonth, endMonth, startYear = year, endYear = year;
        if (month >= 2 && month <= 4)       { seasonName='Spring'; startMonth=2;  endMonth=4;  }
        else if (month >= 5 && month <= 7)  { seasonName='Summer'; startMonth=5;  endMonth=7;  }
        else if (month >= 8 && month <= 10) { seasonName='Fall';   startMonth=8;  endMonth=10; }
        else                                { seasonName='Winter'; startMonth=11; endMonth=1;
          if (month < 2) { startYear = year - 1; endYear = year; } else { endYear = year + 1; }
        }
        const seasonCode = `${seasonName.toLowerCase()}-${startYear}`;
        const startAt = new Date(Date.UTC(startYear, startMonth, 1, 0, 0, 0));
        const endAt   = new Date(Date.UTC(endYear,   endMonth + 1, 1, 0, 0, 0));
        const displayName = `${seasonName} '${String(startYear).slice(-2)}`;
        await pool.query(
          `INSERT INTO seasons (code, name, start_at, end_at, status)
           VALUES ($1, $2, $3, $4, 'active')
           ON CONFLICT (code) DO UPDATE SET status = 'active'`,
          [seasonCode, displayName, startAt, endAt]
        );
        console.log(`[OK] Seeded initial season: ${displayName}`);
      }
    } catch (e) {
      console.warn('[db] season seeding warning:', e.message);
    }

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

    console.log("Database initialized successfully!");
  } catch (error) {
    console.error("Database initialization failed:", error.message);
    console.error("Error details:", error);
    throw error;
  }
}

module.exports = { pool, initDb };
