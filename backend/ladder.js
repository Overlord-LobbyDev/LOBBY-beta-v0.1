// backend/ladder.js — LOBBY Ladder API  (scale edition)
// Endpoints under /api/ladder/*  (mounted in server.js)
//
// Scale improvements over the original:
//   • Cursor-based pagination on all three leaderboard routes
//     (no more full-table sorts on every request)
//   • In-memory TTL caching (cache.js) — 60 s for boards, 5 min for stats
//   • Cache invalidation header (X-Cache: HIT | MISS)
//   • /api/ladder/stats — aggregate hero-stats without full-board fetch
//   • Season rollover runs asynchronously (returns 202 immediately)
//   • Bulk SQL in rollover loops → orders-of-magnitude faster at scale
'use strict';

const express = require('express');
const router  = express.Router();
const { Pool } = require('pg');
const cache   = require('./cache');

// ── DB pool ─────────────────────────────────────────────────
let pool;
if (process.env.DATABASE_URL) {
  const url   = require('url');
  const dbUrl = url.parse(process.env.DATABASE_URL);
  const [dbUser, dbPass] = (dbUrl.auth || ':').split(':');
  pool = new Pool({
    user: dbUser, password: dbPass, host: dbUrl.hostname, port: dbUrl.port || 5432,
    database: dbUrl.pathname.slice(1), ssl: { rejectUnauthorized: false }
  });
} else {
  pool = new Pool({
    host: process.env.PG_HOST || 'localhost', port: process.env.PG_PORT || 5432,
    database: process.env.PG_DB || 'lobby', user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD, ssl: false
  });
}

let ratingEngine = null;
try { ratingEngine = require('./rating-engine.js'); } catch (e) { console.warn('[ladder] rating-engine not loaded:', e.message); }

// ── Middleware ───────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.user || !req.user.id) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

async function requireAdmin(req, res, next) {
  if (!req.user || !req.user.id) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const r = await pool.query('SELECT is_admin FROM users WHERE id = $1', [req.user.id]);
    if (!r.rows.length || !r.rows[0].is_admin) return res.status(403).json({ error: 'Admin only' });
    next();
  } catch (e) {
    res.status(500).json({ error: 'Admin check failed' });
  }
}

// ── Helpers ──────────────────────────────────────────────────
async function getActiveSeason() {
  const r = await pool.query(`SELECT * FROM seasons WHERE status = 'active' ORDER BY start_at ASC LIMIT 1`);
  return r.rows[0] || null;
}

function publicSeasonShape(s) {
  if (!s) return null;
  return { id: s.id, code: s.code, name: s.name, startAt: s.start_at, endAt: s.end_at, status: s.status };
}

function shapeLadderRow(row) {
  return {
    userId:                   row.user_id,
    username:                 row.username || null,
    avatarUrl:                row.avatar_url || null,
    rp:                       Number(row.current_rp || 0),
    tier:                     row.tier || null,
    peakRp:                   Number(row.peak_rp || 0),
    peakTier:                 row.peak_tier || null,
    previousSeasonPeakTier:   row.previous_season_peak_tier || null,
    rankedTournamentsPlayed:  Number(row.ranked_tournaments_played || 0),
    rankedWins:               Number(row.ranked_wins || 0),
    lastActive:               row.last_active || null,
  };
}

// ── Cursor helpers ───────────────────────────────────────────
// Cursor encodes  rank:rp:userId  as base64url so the URL stays clean.
function encodeCursor(rank, rp, userId) {
  return Buffer.from(`${rank}:${rp}:${userId}`).toString('base64url');
}

function decodeCursor(cursor) {
  try {
    const parts = Buffer.from(cursor, 'base64url').toString().split(':');
    if (parts.length !== 3) return null;
    const [rank, rp, userId] = parts.map(Number);
    if ([rank, rp, userId].some(n => !Number.isFinite(n))) return null;
    return { rank, rp, userId };
  } catch {
    return null;
  }
}

// ── Leaderboard cache TTLs ───────────────────────────────────
const TTL_BOARD = 60_000;        // 60 s — leaderboard pages
const TTL_STATS = 5 * 60_000;   // 5 min — hero stats
const TTL_GAMES = 2 * 60_000;   // 2 min — games list

// ============================================================
// GET /api/ladder/season/current
// ============================================================
router.get('/season/current', async (req, res) => {
  try {
    const s = await getActiveSeason();
    res.json({ season: publicSeasonShape(s) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// GET /api/ladder/stats  — aggregate hero stats (cached 5 min)
// ============================================================
router.get('/stats', async (req, res) => {
  const cacheKey = 'lb:stats';
  try {
    const hit = await cache.get(cacheKey);
    if (hit) return res.setHeader('X-Cache', 'HIT').json(hit);

    const season = await getActiveSeason();
    if (!season) return res.json({ season: null, playerCount: 0, gameCount: 0, tournamentCount: 0, topTier: null });

    const [players, games] = await Promise.all([
      pool.query(
        `SELECT COUNT(DISTINCT user_id) AS cnt
         FROM user_ratings ur
         JOIN users u ON u.id = ur.user_id
         WHERE ur.game_tag_normalized = '__global__'
           AND ur.season_id = $1
           AND u.is_banned = FALSE
           AND ur.ranked_tournaments_played > 0`,
        [season.id]
      ),
      pool.query(`SELECT COUNT(*) AS gc, COALESCE(SUM(tournaments_count),0) AS tc FROM games`),
    ]);

    // Top tier: the tier of the #1 player
    const top1 = await pool.query(
      `SELECT ur.current_rp FROM user_ratings ur
       JOIN users u ON u.id = ur.user_id
       WHERE ur.game_tag_normalized = '__global__' AND ur.season_id = $1
         AND u.is_banned = FALSE
       ORDER BY ur.current_rp DESC LIMIT 1`,
      [season.id]
    );
    const topRp  = top1.rows[0]?.current_rp;
    const topTier = topRp != null && ratingEngine
      ? ratingEngine.rankFromRp(topRp).tier.split(' ')[0]
      : null;

    const result = {
      season: publicSeasonShape(season),
      playerCount:     Number(players.rows[0]?.cnt || 0),
      gameCount:       Number(games.rows[0]?.gc    || 0),
      tournamentCount: Number(games.rows[0]?.tc    || 0),
      topTier,
    };
    await cache.set(cacheKey, result, TTL_STATS);
    res.setHeader('X-Cache', 'MISS').json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// GET /api/ladder/games  — known game tags + tournament counts
// ============================================================
router.get('/games', async (req, res) => {
  const cacheKey = 'lb:games';
  try {
    const hit = await cache.get(cacheKey);
    if (hit) return res.setHeader('X-Cache', 'HIT').json(hit);

    const r = await pool.query(
      `SELECT tag_normalized, display_name, tournaments_count, last_seen
       FROM games ORDER BY tournaments_count DESC, display_name ASC`
    );
    const result = { games: r.rows.map(g => ({
      tag: g.tag_normalized, displayName: g.display_name,
      tournamentsCount: g.tournaments_count, lastSeen: g.last_seen
    }))};
    await cache.set(cacheKey, result, TTL_GAMES);
    res.setHeader('X-Cache', 'MISS').json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// GET /api/ladder/leaderboard/global
//   ?limit=50  (max 200)
//   ?after=<cursor>   — cursor-based pagination
// ============================================================
router.get('/leaderboard/global', async (req, res) => {
  try {
    const limit  = Math.min(200, parseInt(req.query.limit) || 50);
    const after  = req.query.after || null;
    const season = await getActiveSeason();
    if (!season) return res.json({ season: null, entries: [], hasMore: false, nextCursor: null, total: 0 });

    const cacheKey = `lb:global:${season.id}:${after || 'top'}:${limit}`;
    const hit = await cache.get(cacheKey);
    if (hit) return res.setHeader('X-Cache', 'HIT').json(hit);

    const cursor = after ? decodeCursor(after) : null;
    const startRank = cursor ? cursor.rank + 1 : 1;

    let rows;
    if (cursor) {
      const r = await pool.query(
        `SELECT ur.user_id, ur.current_rp, ur.peak_rp, ur.peak_tier,
                ur.previous_season_peak_tier, ur.ranked_tournaments_played,
                ur.ranked_wins, ur.last_active,
                u.username, u.avatar_url
         FROM user_ratings ur
         JOIN users u ON u.id = ur.user_id
         WHERE ur.game_tag_normalized = '__global__'
           AND ur.season_id = $1
           AND u.is_banned = FALSE
           AND (ur.current_rp < $2 OR (ur.current_rp = $2 AND ur.user_id > $3))
         ORDER BY ur.current_rp DESC, ur.user_id ASC
         LIMIT $4`,
        [season.id, cursor.rp, cursor.userId, limit + 1]
      );
      rows = r.rows;
    } else {
      const r = await pool.query(
        `SELECT ur.user_id, ur.current_rp, ur.peak_rp, ur.peak_tier,
                ur.previous_season_peak_tier, ur.ranked_tournaments_played,
                ur.ranked_wins, ur.last_active,
                u.username, u.avatar_url
         FROM user_ratings ur
         JOIN users u ON u.id = ur.user_id
         WHERE ur.game_tag_normalized = '__global__'
           AND ur.season_id = $1
           AND u.is_banned = FALSE
         ORDER BY ur.current_rp DESC, ur.user_id ASC
         LIMIT $2`,
        [season.id, limit + 1]
      );
      rows = r.rows;
    }

    const hasMore   = rows.length > limit;
    const pageRows  = rows.slice(0, limit);
    const entries   = pageRows.map((row, idx) => {
      const rank = startRank + idx;
      const tier = ratingEngine ? ratingEngine.rankFromRp(row.current_rp).tier : null;
      return { rank, ...shapeLadderRow({ ...row, tier }) };
    });

    let nextCursor = null;
    if (hasMore && entries.length > 0) {
      const last = entries[entries.length - 1];
      nextCursor = encodeCursor(last.rank, last.rp, last.userId);
    }

    // Total count only on first page (uses cached stats to avoid COUNT(*) on every page)
    let total = null;
    if (!after) {
      const statsHit = await cache.get('lb:stats');
      if (statsHit) total = statsHit.playerCount;
    }

    const result = { season: publicSeasonShape(season), entries, hasMore, nextCursor, total };
    await cache.set(cacheKey, result, TTL_BOARD);
    res.setHeader('X-Cache', 'MISS').json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// GET /api/ladder/leaderboard/game/:gameTag
// ============================================================
router.get('/leaderboard/game/:gameTag', async (req, res) => {
  try {
    const limit      = Math.min(200, parseInt(req.query.limit) || 50);
    const after      = req.query.after || null;
    const season     = await getActiveSeason();
    const normalized = ratingEngine ? ratingEngine.normalizeGameTag(req.params.gameTag) : req.params.gameTag;
    if (!season) return res.json({ season: null, gameTag: normalized, entries: [], hasMore: false, nextCursor: null });

    const cacheKey = `lb:game:${season.id}:${normalized}:${after || 'top'}:${limit}`;
    const hit = await cache.get(cacheKey);
    if (hit) return res.setHeader('X-Cache', 'HIT').json(hit);

    const cursor    = after ? decodeCursor(after) : null;
    const startRank = cursor ? cursor.rank + 1 : 1;

    let rows;
    if (cursor) {
      const r = await pool.query(
        `SELECT ur.user_id, ur.current_rp, ur.peak_rp, ur.peak_tier,
                ur.previous_season_peak_tier, ur.ranked_tournaments_played,
                ur.ranked_wins, ur.last_active, ur.current_elo,
                u.username, u.avatar_url
         FROM user_ratings ur
         JOIN users u ON u.id = ur.user_id
         WHERE ur.game_tag_normalized = $1
           AND ur.season_id = $2
           AND u.is_banned = FALSE
           AND (ur.current_rp < $3 OR (ur.current_rp = $3 AND ur.user_id > $4))
         ORDER BY ur.current_rp DESC, ur.user_id ASC
         LIMIT $5`,
        [normalized, season.id, cursor.rp, cursor.userId, limit + 1]
      );
      rows = r.rows;
    } else {
      const r = await pool.query(
        `SELECT ur.user_id, ur.current_rp, ur.peak_rp, ur.peak_tier,
                ur.previous_season_peak_tier, ur.ranked_tournaments_played,
                ur.ranked_wins, ur.last_active, ur.current_elo,
                u.username, u.avatar_url
         FROM user_ratings ur
         JOIN users u ON u.id = ur.user_id
         WHERE ur.game_tag_normalized = $1
           AND ur.season_id = $2
           AND u.is_banned = FALSE
         ORDER BY ur.current_rp DESC, ur.user_id ASC
         LIMIT $3`,
        [normalized, season.id, limit + 1]
      );
      rows = r.rows;
    }

    const gameMeta = await pool.query(
      `SELECT display_name, tournaments_count FROM games WHERE tag_normalized = $1`, [normalized]
    );
    const displayName = gameMeta.rows[0]?.display_name || normalized;

    const hasMore  = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const entries  = pageRows.map((row, idx) => {
      const rank = startRank + idx;
      const tier = ratingEngine ? ratingEngine.rankFromRp(row.current_rp).tier : null;
      return { rank, ...shapeLadderRow({ ...row, tier }) };
    });

    let nextCursor = null;
    if (hasMore && entries.length > 0) {
      const last = entries[entries.length - 1];
      nextCursor = encodeCursor(last.rank, last.rp, last.userId);
    }

    const result = {
      season: publicSeasonShape(season),
      game: { tag: normalized, displayName, tournamentsCount: gameMeta.rows[0]?.tournaments_count || 0 },
      entries, hasMore, nextCursor,
    };
    await cache.set(cacheKey, result, TTL_BOARD);
    res.setHeader('X-Cache', 'MISS').json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// GET /api/ladder/leaderboard/lobby/:lobbyId
// ============================================================
router.get('/leaderboard/lobby/:lobbyId', async (req, res) => {
  try {
    const limit  = Math.min(200, parseInt(req.query.limit) || 50);
    const after  = req.query.after || null;
    const season = await getActiveSeason();
    if (!season) return res.json({ season: null, lobbyId: req.params.lobbyId, entries: [], hasMore: false, nextCursor: null });

    const cacheKey = `lb:lobby:${season.id}:${req.params.lobbyId}:${after || 'top'}:${limit}`;
    const hit = await cache.get(cacheKey);
    if (hit) return res.setHeader('X-Cache', 'HIT').json(hit);

    const cursor    = after ? decodeCursor(after) : null;
    const startRank = cursor ? cursor.rank + 1 : 1;

    let rows;
    const cursorClause = cursor
      ? `AND (ur.current_rp < ${cursor.rp} OR (ur.current_rp = ${cursor.rp} AND ur.user_id > ${cursor.userId}))`
      : '';
    const r = await pool.query(
      `WITH lobby_users AS (
         SELECT DISTINCT tp.user_id
         FROM tournaments t
         JOIN tournament_players tp ON tp.tournament_id = t.id
         WHERE t.lobby_id = $1 AND t.rp_awarded = TRUE
       )
       SELECT ur.user_id, ur.current_rp, ur.peak_rp, ur.peak_tier,
              ur.previous_season_peak_tier, ur.ranked_tournaments_played,
              ur.ranked_wins, ur.last_active,
              u.username, u.avatar_url
       FROM user_ratings ur
       JOIN lobby_users lu ON lu.user_id = ur.user_id
       JOIN users u ON u.id = ur.user_id
       WHERE ur.game_tag_normalized = '__global__'
         AND ur.season_id = $2
         AND u.is_banned = FALSE
         ${cursorClause}
       ORDER BY ur.current_rp DESC, ur.user_id ASC
       LIMIT $3`,
      [req.params.lobbyId, season.id, limit + 1]
    );
    rows = r.rows;

    const hasMore  = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const entries  = pageRows.map((row, idx) => {
      const rank = startRank + idx;
      const tier = ratingEngine ? ratingEngine.rankFromRp(row.current_rp).tier : null;
      return { rank, ...shapeLadderRow({ ...row, tier }) };
    });

    let nextCursor = null;
    if (hasMore && entries.length > 0) {
      const last = entries[entries.length - 1];
      nextCursor = encodeCursor(last.rank, last.rp, last.userId);
    }

    const result = { season: publicSeasonShape(season), lobbyId: req.params.lobbyId, entries, hasMore, nextCursor };
    await cache.set(cacheKey, result, TTL_BOARD);
    res.setHeader('X-Cache', 'MISS').json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// GET /api/ladder/me
// ============================================================
router.get('/me', requireAuth, async (req, res) => {
  try {
    const season = await getActiveSeason();
    if (!season) return res.json({ season: null, ratings: [] });

    const r = await pool.query(
      `SELECT ur.game_tag_normalized, ur.current_rp, ur.current_elo, ur.peak_rp, ur.peak_tier,
              ur.previous_season_peak_tier, ur.placement_matches_remaining,
              ur.ranked_tournaments_played, ur.ranked_wins, ur.last_active,
              g.display_name
       FROM user_ratings ur
       LEFT JOIN games g ON g.tag_normalized = ur.game_tag_normalized
       WHERE ur.user_id = $1 AND ur.season_id = $2
       ORDER BY (ur.game_tag_normalized = '__global__') DESC, ur.current_rp DESC`,
      [req.user.id, season.id]
    );

    const ratings = r.rows.map(row => {
      const tier = ratingEngine ? ratingEngine.rankFromRp(row.current_rp) : null;
      return {
        gameTag:                    row.game_tag_normalized,
        gameDisplayName:            row.game_tag_normalized === '__global__' ? 'Global' : (row.display_name || row.game_tag_normalized),
        rp:                         Number(row.current_rp),
        elo:                        Number(row.current_elo),
        peakRp:                     Number(row.peak_rp),
        peakTier:                   row.peak_tier,
        previousSeasonPeakTier:     row.previous_season_peak_tier,
        tier:                       tier ? tier.tier : null,
        placementMatchesRemaining:  Number(row.placement_matches_remaining || 0),
        rankedTournamentsPlayed:    Number(row.ranked_tournaments_played || 0),
        rankedWins:                 Number(row.ranked_wins || 0),
      };
    });
    res.json({ season: publicSeasonShape(season), ratings });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// GET /api/ladder/user/:userId
// ============================================================
router.get('/user/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    if (!Number.isInteger(userId)) return res.status(400).json({ error: 'Invalid userId' });
    const season = await getActiveSeason();
    if (!season) return res.json({ season: null, user: null, ratings: [] });

    const uq = await pool.query(`SELECT id, username, avatar_url, is_banned FROM users WHERE id = $1`, [userId]);
    if (!uq.rows.length) return res.status(404).json({ error: 'User not found' });
    const u = uq.rows[0];
    if (u.is_banned) return res.status(403).json({ error: 'User unavailable' });

    const r = await pool.query(
      `SELECT ur.game_tag_normalized, ur.current_rp, ur.peak_rp, ur.peak_tier,
              ur.previous_season_peak_tier, ur.ranked_tournaments_played, ur.ranked_wins,
              g.display_name
       FROM user_ratings ur
       LEFT JOIN games g ON g.tag_normalized = ur.game_tag_normalized
       WHERE ur.user_id = $1 AND ur.season_id = $2
       ORDER BY (ur.game_tag_normalized = '__global__') DESC, ur.current_rp DESC`,
      [userId, season.id]
    );

    const ratings = r.rows.map(row => {
      const tier = ratingEngine ? ratingEngine.rankFromRp(row.current_rp) : null;
      return {
        gameTag:                  row.game_tag_normalized,
        gameDisplayName:          row.game_tag_normalized === '__global__' ? 'Global' : (row.display_name || row.game_tag_normalized),
        rp:                       Number(row.current_rp),
        peakRp:                   Number(row.peak_rp),
        peakTier:                 row.peak_tier,
        previousSeasonPeakTier:   row.previous_season_peak_tier,
        tier:                     tier ? tier.tier : null,
        rankedTournamentsPlayed:  Number(row.ranked_tournaments_played || 0),
        rankedWins:               Number(row.ranked_wins || 0),
      };
    });

    res.json({
      season: publicSeasonShape(season),
      user: { id: u.id, username: u.username, avatarUrl: u.avatar_url },
      ratings
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// GET /api/ladder/season/history/:userId
// ============================================================
router.get('/season/history/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    if (!Number.isInteger(userId)) return res.status(400).json({ error: 'Invalid userId' });
    const r = await pool.query(
      `SELECT sr.*, s.name AS season_name, s.code AS season_code, g.display_name AS game_display_name
       FROM season_ratings sr
       JOIN seasons s ON s.id = sr.season_id
       LEFT JOIN games g ON g.tag_normalized = sr.game_tag_normalized
       WHERE sr.user_id = $1
       ORDER BY s.start_at DESC, sr.final_rp DESC`,
      [userId]
    );
    res.json({ history: r.rows.map(row => ({
      season: { name: row.season_name, code: row.season_code },
      gameTag: row.game_tag_normalized,
      gameDisplayName: row.game_tag_normalized === '__global__' ? 'Global' : (row.game_display_name || row.game_tag_normalized),
      finalRp:          Number(row.final_rp),
      peakRp:           Number(row.peak_rp),
      finalTier:        row.final_tier,
      peakTier:         row.peak_tier,
      finalPlacement:   row.final_placement,
      tournamentsPlayed: Number(row.tournaments_played || 0),
      archivedAt:       row.archived_at,
    }))});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// GET /api/ladder/featured
// ============================================================
router.get('/featured', async (req, res) => {
  const cacheKey = 'lb:featured';
  try {
    const hit = await cache.get(cacheKey);
    if (hit) return res.setHeader('X-Cache', 'HIT').json(hit);

    const r = await pool.query(
      `SELECT t.id, t.lobby_id, t.host_id, t.name, t.description, t.format, t.player_count,
              t.status, t.start_time, t.end_time, t.scheduled_start, t.prize, t.rules,
              t.game_tag, t.game_tag_normalized, t.recommended_skill_tier,
              t.is_featured, t.admin_rp_override, t.featured_tier_label,
              t.featured_at, t.host_rank_at_creation_global, t.host_rank_at_creation_game,
              u.username AS host_username, u.avatar_url AS host_avatar
       FROM tournaments t
       LEFT JOIN users u ON u.id = t.host_id
       WHERE t.is_featured = TRUE AND t.status IN ('setup','registration','in-progress','completed')
       ORDER BY
         CASE t.status
           WHEN 'in-progress' THEN 1 WHEN 'registration' THEN 2
           WHEN 'setup' THEN 3 WHEN 'completed' THEN 4 ELSE 5
         END,
         t.featured_at DESC NULLS LAST, t.id DESC
       LIMIT 50`
    );
    const result = { featured: r.rows.map(t => ({
      id: t.id, lobbyId: t.lobby_id, hostId: t.host_id,
      hostUsername: t.host_username, hostAvatarUrl: t.host_avatar,
      name: t.name, description: t.description, format: t.format,
      playerCount: t.player_count, status: t.status,
      startTime: t.start_time, endTime: t.end_time, scheduledStart: t.scheduled_start,
      prize: t.prize, rules: t.rules,
      gameTag: t.game_tag, gameTagNormalized: t.game_tag_normalized,
      recommendedSkillTier: t.recommended_skill_tier,
      adminRpOverride: t.admin_rp_override,
      featuredTierLabel: t.featured_tier_label,
      featuredAt: t.featured_at,
      hostRankAtCreationGame: t.host_rank_at_creation_game,
      hostRankAtCreationGlobal: t.host_rank_at_creation_global,
    }))};
    await cache.set(cacheKey, result, 30_000); // 30 s — featured changes more often
    res.setHeader('X-Cache', 'MISS').json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// GET /api/ladder/tournament/:id/credibility
// ============================================================
router.get('/tournament/:id/credibility', async (req, res) => {
  if (!ratingEngine) return res.status(503).json({ error: 'Rating engine unavailable' });
  try {
    const tid = parseInt(req.params.id);
    if (!Number.isInteger(tid)) return res.status(400).json({ error: 'Invalid id' });
    const out = await ratingEngine.computeTournamentCredibility(tid);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// PATCH /api/ladder/admin/tournament/:id/feature
// ============================================================
router.patch('/admin/tournament/:id/feature', requireAdmin, async (req, res) => {
  try {
    const tid = parseInt(req.params.id);
    if (!Number.isInteger(tid)) return res.status(400).json({ error: 'Invalid id' });
    const { isFeatured, rpOverride, tierLabel } = req.body || {};

    const validLabels = [null, 'casual', 'verified', 'official'];
    if (tierLabel !== undefined && !validLabels.includes(tierLabel)) {
      return res.status(400).json({ error: 'Invalid tierLabel' });
    }
    let cleanRp = null;
    if (rpOverride !== undefined && rpOverride !== null) {
      const n = parseInt(rpOverride);
      if (!Number.isInteger(n) || n < 0 || n > 10000) {
        return res.status(400).json({ error: 'rpOverride must be 0–10000' });
      }
      cleanRp = n;
    }

    const r = await pool.query(
      `UPDATE tournaments
       SET is_featured         = COALESCE($1, is_featured),
           admin_rp_override   = $2,
           featured_tier_label = $3,
           featured_by         = CASE WHEN $1 = TRUE THEN $4 ELSE NULL END,
           featured_at         = CASE WHEN $1 = TRUE THEN NOW()  ELSE NULL END
       WHERE id = $5
       RETURNING id, is_featured, admin_rp_override, featured_tier_label, featured_at, featured_by`,
      [
        typeof isFeatured === 'boolean' ? isFeatured : null,
        rpOverride === null ? null : cleanRp,
        tierLabel === undefined ? null : tierLabel,
        req.user.id, tid
      ]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Tournament not found' });
    await cache.del('lb:featured'); // invalidate featured cache
    res.json({ success: true, tournament: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// PATCH /api/ladder/admin/lobby/:lobbyId/verify
// ============================================================
router.patch('/admin/lobby/:lobbyId/verify', requireAdmin, async (req, res) => {
  try {
    const { verified } = req.body || {};
    if (typeof verified !== 'boolean') return res.status(400).json({ error: 'verified must be boolean' });
    const r = await pool.query(
      `UPDATE servers
       SET lobby_verified = $1,
           verified_at    = CASE WHEN $1 = TRUE THEN NOW() ELSE NULL END,
           verified_by    = CASE WHEN $1 = TRUE THEN $2    ELSE NULL END
       WHERE unique_id = $3
       RETURNING id, name, unique_id, lobby_verified, verified_at, verified_by`,
      [verified, req.user.id, req.params.lobbyId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Lobby not found' });
    res.json({ success: true, lobby: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// POST /api/ladder/admin/clear-smurf-flag
// ============================================================
router.post('/admin/clear-smurf-flag', requireAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.body?.userId);
    if (!Number.isInteger(userId)) return res.status(400).json({ error: 'Invalid userId' });
    const r = await pool.query(
      `UPDATE smurf_flags SET cleared_at = NOW(), cleared_by = $1
       WHERE user_id = $2 AND cleared_at IS NULL RETURNING id`,
      [req.user.id, userId]
    );
    res.json({ success: true, cleared: r.rowCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// POST /api/ladder/admin/season/rollover  — ASYNC edition
// Returns 202 immediately; runs in background; busts all lb: cache on finish.
// ============================================================
const _rolloverState = { running: false, lastResult: null, lastError: null, startedAt: null };

router.post('/admin/season/rollover', requireAdmin, async (req, res) => {
  if (!ratingEngine) return res.status(503).json({ error: 'Rating engine unavailable' });
  if (_rolloverState.running) {
    return res.status(409).json({ error: 'Rollover already in progress', startedAt: _rolloverState.startedAt });
  }

  _rolloverState.running   = true;
  _rolloverState.startedAt = new Date().toISOString();
  _rolloverState.lastError = null;

  // Respond immediately with 202 Accepted
  res.status(202).json({ accepted: true, message: 'Season rollover started in background. Poll /api/ladder/admin/season/rollover/status for progress.' });

  // Run asynchronously — do NOT await
  setImmediate(async () => {
    try {
      const newSeason = await ratingEngine.runSeasonRollover();
      _rolloverState.lastResult = { newSeason: { id: newSeason.id, code: newSeason.code, name: newSeason.name } };
      // Bust all leaderboard cache
      await cache.flush('lb:');
      console.log('[ladder] season rollover complete, cache flushed. New season:', newSeason.code);
    } catch (e) {
      _rolloverState.lastError = e.message;
      console.error('[ladder] season rollover failed:', e.message);
    } finally {
      _rolloverState.running = false;
    }
  });
});

router.get('/admin/season/rollover/status', requireAdmin, (req, res) => {
  res.json({
    running:    _rolloverState.running,
    startedAt:  _rolloverState.startedAt,
    lastResult: _rolloverState.lastResult,
    lastError:  _rolloverState.lastError,
  });
});

// ============================================================
// GET /api/ladder/admin/featured
// ============================================================
router.get('/admin/featured', requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT t.id, t.name, t.status, t.lobby_id, t.is_featured, t.admin_rp_override,
              t.featured_tier_label, t.featured_at, u1.username AS host_username,
              u2.username AS featured_by_username
       FROM tournaments t
       LEFT JOIN users u1 ON u1.id = t.host_id
       LEFT JOIN users u2 ON u2.id = t.featured_by
       WHERE t.is_featured = TRUE
       ORDER BY t.featured_at DESC NULLS LAST`
    );
    res.json({ featured: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
