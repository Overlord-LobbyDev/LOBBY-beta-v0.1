// ============================================================
// backend/rating-engine.js
// LOBBY Ladder System — core math + DB plumbing
//
// See LADDER_SYSTEM_DESIGN.md for the full design rationale.
// This module is the single source of truth for:
//   - Tournament credibility / auto-tier classification
//   - RP awards (winner_rp_base + placement distribution)
//   - Elo updates (per match)
//   - Anti-abuse (diminishing returns, smurf detection, host cooldown)
//   - Season lifecycle (active season lookup, soft reset)
//   - Rank tier mapping (RP → tier name + sub-division)
//   - Host rank-gate enforcement
//   - Game-tag normalization
//
// Public API (consumed by tournaments.js and the upcoming /api/ladder router):
//   getCurrentSeason()
//   ensureUserRating(userId, gameTagNormalized)
//   getUserTier(userId, gameTagNormalized)
//   canHostAtTier(userId, gameTagNormalized, requestedTier)
//   normalizeGameTag(raw)
//   upsertGame(rawTag)
//   rankFromRp(rp)
//   computeHostTrustScore(hostId)
//   computeTournamentCredibility(tournamentId)
//   applyEloUpdate(ratingA, ratingB, scoreA, kFactor)
//   applyTournamentResults(tournamentId)      <-- main entry point
//   runSeasonRollover()
//   checkSeasonRollover()
//   flagSmurfIfNeeded(userId, gameTagNormalized)
//
// Pure helpers (exported for unit tests):
//   distributeRpShare(placement, totalPlayers)
//   computeWinnerRpBase(credibility, autoTier)
//   computeAutoTier(credibility, playerCount, hostTrust, publicBracket)
//   computeOpponentMultiplier(userElo, fieldAvgElo)
//   computeRepeatOpponentMultiplier(priorWins)
//   softResetRp(oldRp)
//   kFactor(matchesPlayed)
// ============================================================

'use strict';

const { Pool } = require('pg');
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

// Allow injection of a different pool (for testing). Otherwise everything uses the module-level pool.
function _pool() { return module.exports._poolOverride || pool; }

// ============================================================
//  RANK TIERS
// ============================================================
// Tier thresholds — see design doc §9.
// Each entry: { tier: 'Tier Name III', minRp: int }
// Sorted ascending. rankFromRp() does a reverse-walk to find the highest matching.
const RANK_TIERS = Object.freeze([
  { tier: 'Wanderer III',   minRp: 0,    base: 'Wanderer',   sub: 'III' },
  { tier: 'Wanderer II',    minRp: 100,  base: 'Wanderer',   sub: 'II'  },
  { tier: 'Wanderer I',     minRp: 200,  base: 'Wanderer',   sub: 'I'   },
  { tier: 'Challenger III', minRp: 300,  base: 'Challenger', sub: 'III' },
  { tier: 'Challenger II',  minRp: 450,  base: 'Challenger', sub: 'II'  },
  { tier: 'Challenger I',   minRp: 600,  base: 'Challenger', sub: 'I'   },
  { tier: 'Contender III',  minRp: 750,  base: 'Contender',  sub: 'III' },
  { tier: 'Contender II',   minRp: 900,  base: 'Contender',  sub: 'II'  },
  { tier: 'Contender I',    minRp: 1050, base: 'Contender',  sub: 'I'   },
  { tier: 'Elite III',      minRp: 1200, base: 'Elite',      sub: 'III' },
  { tier: 'Elite II',       minRp: 1400, base: 'Elite',      sub: 'II'  },
  { tier: 'Elite I',        minRp: 1600, base: 'Elite',      sub: 'I'   },
  { tier: 'Overlord III',   minRp: 1800, base: 'Overlord',   sub: 'III' },
  { tier: 'Overlord II',    minRp: 2000, base: 'Overlord',   sub: 'II'  },
  { tier: 'Overlord I',     minRp: 2200, base: 'Overlord',   sub: 'I'   },
  { tier: 'Ascendant III',  minRp: 2400, base: 'Ascendant',  sub: 'III' },
  { tier: 'Ascendant II',   minRp: 2600, base: 'Ascendant',  sub: 'II'  },
  { tier: 'Ascendant I',    minRp: 2800, base: 'Ascendant',  sub: 'I'   },
  { tier: 'Mythic III',     minRp: 3000, base: 'Mythic',     sub: 'III' },
  { tier: 'Mythic II',      minRp: 3200, base: 'Mythic',     sub: 'II'  },
  { tier: 'Mythic I',       minRp: 3400, base: 'Mythic',     sub: 'I'   },
  { tier: 'Legend',         minRp: 3600, base: 'Legend',     sub: null  },
]);

// Ordered base tier names (low → high) for rank-gate comparisons.
const BASE_TIER_ORDER = Object.freeze([
  'Wanderer', 'Challenger', 'Contender', 'Elite', 'Overlord', 'Ascendant', 'Mythic', 'Legend'
]);

/**
 * Map an RP value to a rank tier (e.g. 1450 → "Elite II").
 * @param {number} rp
 * @returns {{tier: string, base: string, sub: string|null, minRp: number}}
 */
function rankFromRp(rp) {
  const safeRp = Math.max(0, Math.floor(Number(rp) || 0));
  for (let i = RANK_TIERS.length - 1; i >= 0; i--) {
    if (safeRp >= RANK_TIERS[i].minRp) return { ...RANK_TIERS[i] };
  }
  return { ...RANK_TIERS[0] };
}

/**
 * Compare two base tier names (e.g. "Elite" vs "Mythic"). Returns -1 / 0 / 1.
 */
function compareBaseTiers(a, b) {
  const ai = BASE_TIER_ORDER.indexOf(a);
  const bi = BASE_TIER_ORDER.indexOf(b);
  if (ai === -1 || bi === -1) return 0;
  return Math.sign(ai - bi);
}

// ============================================================
//  GAME TAG NORMALIZATION
// ============================================================
// Map of known aliases → canonical normalized form. Editable as we learn.
const GAME_ALIASES = Object.freeze({
  'csgo': 'counter-strike', 'cs:go': 'counter-strike', 'cs-go': 'counter-strike',
  'cs2':  'counter-strike', 'counter-strike-2': 'counter-strike',
  'lol':  'league-of-legends', 'league': 'league-of-legends',
  'rl':   'rocket-league',
  'r6':   'rainbow-six', 'r6s': 'rainbow-six', 'siege': 'rainbow-six',
  'sf6':  'street-fighter-6',
  'mk1':  'mortal-kombat-1',
});

/**
 * Normalize a free-text game name into a canonical tag.
 * Examples:
 *   "Counter-Strike 2" → "counter-strike"
 *   "Rocket League"    → "rocket-league"
 *   "Chess"            → "chess"
 *   ""                 → "other"
 */
function normalizeGameTag(raw) {
  if (raw == null) return 'other';
  let s = String(raw).trim().toLowerCase();
  if (!s) return 'other';
  // Replace any run of non-alphanumeric with a single hyphen, trim hyphens.
  s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!s) return 'other';
  return GAME_ALIASES[s] || s;
}

/**
 * Insert (or update) a row in `games`. Called when a tournament is created
 * and again at completion to bump tournaments_count.
 */
async function upsertGame(rawTag, { incrementCount = false } = {}) {
  const normalized = normalizeGameTag(rawTag);
  if (normalized === '__global__') return null; // reserved
  const display = (rawTag && String(rawTag).trim()) || 'Other';
  await _pool().query(
    `INSERT INTO games (tag_normalized, display_name, tournaments_count, last_seen)
     VALUES ($1, $2, ${incrementCount ? 1 : 0}, NOW())
     ON CONFLICT (tag_normalized) DO UPDATE SET
       display_name = CASE
         WHEN LENGTH($2) > LENGTH(games.display_name) THEN $2  -- prefer fuller form
         ELSE games.display_name
       END,
       tournaments_count = games.tournaments_count + ${incrementCount ? 1 : 0},
       last_seen = NOW()`,
    [normalized, display]
  );
  return normalized;
}

// ============================================================
//  SEASONS
// ============================================================

/**
 * Return the currently active season, or null if none.
 * Defensive: if multiple are active (data bug), returns the earliest one.
 */
async function getCurrentSeason() {
  const r = await _pool().query(
    `SELECT * FROM seasons WHERE status = 'active' ORDER BY start_at ASC LIMIT 1`
  );
  return r.rows[0] || null;
}

/**
 * If the current active season's end_at is past, run rollover.
 * Safe to call on every server boot and periodically.
 */
async function checkSeasonRollover() {
  const cur = await getCurrentSeason();
  if (!cur) return null;
  if (new Date(cur.end_at) > new Date()) return null;
  return runSeasonRollover();
}

/**
 * Compress an old RP value toward the anchor (the "soft reset" formula).
 * Pure function.
 */
function softResetRp(oldRp, multiplier = 0.5, anchor = 500) {
  return Math.max(0, Math.round((Number(oldRp) || 0) * multiplier + anchor));
}

/**
 * Roll the active season forward: archive everyone, compress RP, activate next.
 */
async function runSeasonRollover() {
  const cur = await getCurrentSeason();
  if (!cur) throw new Error('No active season to roll over');

  // 1. Snapshot every user_ratings row into season_ratings.
  const ratings = await _pool().query(
    `SELECT * FROM user_ratings WHERE season_id = $1`, [cur.id]
  );
  for (const r of ratings.rows) {
    const finalTier = rankFromRp(r.current_rp).tier;
    const peakTier  = r.peak_tier || finalTier;
    await _pool().query(
      `INSERT INTO season_ratings
       (user_id, season_id, game_tag_normalized, final_rp, peak_rp, final_tier, peak_tier, tournaments_played)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (user_id, season_id, game_tag_normalized) DO NOTHING`,
      [r.user_id, cur.id, r.game_tag_normalized, r.current_rp, r.peak_rp, finalTier, peakTier, r.ranked_tournaments_played]
    );
  }

  // 2. Compress RP and reset placement matches, carrying peak_tier forward as previous_season_peak_tier.
  await _pool().query(
    `UPDATE user_ratings
     SET previous_season_peak_tier = peak_tier,
         current_rp                = GREATEST(0, ROUND(current_rp * $1 + $2)::int),
         peak_rp                   = GREATEST(0, ROUND(current_rp * $1 + $2)::int),
         peak_tier                 = NULL,
         placement_matches_remaining = 5
     WHERE season_id = $3`,
    [Number(cur.compression_multiplier), Number(cur.compression_anchor), cur.id]
  );

  // 3. Apply rank floor: a user can't drop more than 2 base tiers below their previous peak.
  //    Compute new minimum RP per row and bump if needed.
  const compressed = await _pool().query(
    `SELECT id, current_rp, previous_season_peak_tier FROM user_ratings WHERE season_id = $1`,
    [cur.id]
  );
  for (const row of compressed.rows) {
    if (!row.previous_season_peak_tier) continue;
    const peakInfo = RANK_TIERS.find(t => t.tier === row.previous_season_peak_tier);
    if (!peakInfo) continue;
    const peakBaseIdx = BASE_TIER_ORDER.indexOf(peakInfo.base);
    if (peakBaseIdx <= 0) continue;
    const floorBase = BASE_TIER_ORDER[Math.max(0, peakBaseIdx - 2)];
    const floorEntry = RANK_TIERS.find(t => t.base === floorBase && t.sub === 'III');
    if (floorEntry && row.current_rp < floorEntry.minRp) {
      await _pool().query(
        `UPDATE user_ratings SET current_rp = $1, peak_rp = GREATEST(peak_rp, $1) WHERE id = $2`,
        [floorEntry.minRp, row.id]
      );
    }
  }

  // 4. Archive the season.
  await _pool().query(`UPDATE seasons SET status = 'archived' WHERE id = $1`, [cur.id]);

  // 5. Create the next season.
  const next = nextSeasonAfter(cur);
  const ins = await _pool().query(
    `INSERT INTO seasons (code, name, start_at, end_at, status)
     VALUES ($1, $2, $3, $4, 'active')
     ON CONFLICT (code) DO UPDATE SET status = 'active'
     RETURNING *`,
    [next.code, next.name, next.startAt, next.endAt]
  );

  // 6. Re-point all user_ratings to the new season_id (they're keyed on user+game+season).
  //    Strategy: upsert a fresh row per (user, game) for the new season carrying forward the compressed RP/Elo.
  const carry = await _pool().query(
    `SELECT user_id, game_tag_normalized, current_rp, current_elo, peak_rp, peak_tier, previous_season_peak_tier,
            ranked_matches_played, ranked_tournaments_played, ranked_wins
     FROM user_ratings WHERE season_id = $1`, [cur.id]
  );
  for (const r of carry.rows) {
    await _pool().query(
      `INSERT INTO user_ratings
       (user_id, game_tag_normalized, season_id, current_rp, current_elo, peak_rp, peak_tier,
        previous_season_peak_tier, placement_matches_remaining,
        ranked_matches_played, ranked_tournaments_played, ranked_wins)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,5,$9,$10,$11)
       ON CONFLICT (user_id, game_tag_normalized, season_id) DO NOTHING`,
      [r.user_id, r.game_tag_normalized, ins.rows[0].id, r.current_rp, r.current_elo, r.current_rp,
       null, r.previous_season_peak_tier,
       r.ranked_matches_played, r.ranked_tournaments_played, r.ranked_wins]
    );
  }

  return ins.rows[0];
}

/**
 * Given a season row, compute the next one (3-month cadence).
 */
function nextSeasonAfter(season) {
  const end = new Date(season.end_at);
  // end_at is the first day of the month AFTER the season ends.
  // The next season starts there.
  const startAt = new Date(end);
  const startMonth = startAt.getUTCMonth();
  const startYear = startAt.getUTCFullYear();
  const endAt = new Date(Date.UTC(startYear + (startMonth + 3 >= 12 ? 1 : 0), (startMonth + 3) % 12, 1));
  // Determine season name from start month
  let seasonName;
  if (startMonth >= 2 && startMonth <= 4) seasonName = 'Spring';
  else if (startMonth >= 5 && startMonth <= 7) seasonName = 'Summer';
  else if (startMonth >= 8 && startMonth <= 10) seasonName = 'Fall';
  else seasonName = 'Winter';
  const codeYear = seasonName === 'Winter' && startMonth === 11 ? startYear : startYear;
  const displayYear = String(seasonName === 'Winter' && startMonth === 11 ? startYear : startYear).slice(-2);
  return {
    code: `${seasonName.toLowerCase()}-${codeYear}`,
    name: `${seasonName} '${displayYear}`,
    startAt, endAt,
  };
}

// ============================================================
//  USER RATINGS
// ============================================================

/**
 * Ensure a user_ratings row exists for (user, game, currentSeason). Returns the row.
 */
async function ensureUserRating(userId, gameTagNormalized) {
  const season = await getCurrentSeason();
  if (!season) throw new Error('No active season — cannot create user rating');

  const existing = await _pool().query(
    `SELECT * FROM user_ratings WHERE user_id = $1 AND game_tag_normalized = $2 AND season_id = $3`,
    [userId, gameTagNormalized, season.id]
  );
  if (existing.rows.length) return existing.rows[0];

  const ins = await _pool().query(
    `INSERT INTO user_ratings
     (user_id, game_tag_normalized, season_id, current_rp, current_elo, peak_rp, placement_matches_remaining)
     VALUES ($1, $2, $3, 0, 1200, 0, 5)
     ON CONFLICT (user_id, game_tag_normalized, season_id) DO NOTHING
     RETURNING *`,
    [userId, gameTagNormalized, season.id]
  );
  if (ins.rows.length) return ins.rows[0];
  // Lost the race — re-fetch.
  const refetch = await _pool().query(
    `SELECT * FROM user_ratings WHERE user_id = $1 AND game_tag_normalized = $2 AND season_id = $3`,
    [userId, gameTagNormalized, season.id]
  );
  return refetch.rows[0];
}

/**
 * Return the user's current tier object for a given game.
 * If the user has no rating for that game yet, returns Wanderer III.
 */
async function getUserTier(userId, gameTagNormalized) {
  const r = await ensureUserRating(userId, gameTagNormalized);
  return rankFromRp(r.current_rp);
}

/**
 * Can this user host a tournament at the requested recommended skill tier in this game?
 * Compares the host's CURRENT per-game tier base name vs the requested tier.
 * - 'open' is always allowed (no skill restriction).
 * - For a specific tier, the host's tier must be >= requested.
 * - Users with no history in the game default to Wanderer (max-cap = Wanderer-tier).
 *
 * @param {number} userId
 * @param {string} gameTagNormalized
 * @param {string} requestedTier — 'open' or one of BASE_TIER_ORDER values
 * @returns {Promise<boolean>}
 */
async function canHostAtTier(userId, gameTagNormalized, requestedTier) {
  if (!requestedTier || requestedTier === 'open') return true;
  if (!BASE_TIER_ORDER.includes(requestedTier)) return false;
  const userTier = await getUserTier(userId, gameTagNormalized);
  // Host's tier base must be >= requested tier base
  return compareBaseTiers(userTier.base, requestedTier) >= 0;
}

// ============================================================
//  HOST TRUST
// ============================================================

/**
 * Compute and cache a host trust score. See design doc §7.
 * Returns the numeric score (0.0–1.0).
 */
async function computeHostTrustScore(hostId) {
  const tQ = await _pool().query(
    `SELECT id, status, lobby_id FROM tournaments WHERE host_id = $1`, [hostId]
  );
  const tournaments = tQ.rows;

  if (tournaments.length === 0) {
    await _pool().query(
      `INSERT INTO host_trust_scores (host_id, score, components, last_computed)
       VALUES ($1, 0.2, $2, NOW())
       ON CONFLICT (host_id) DO UPDATE SET score = 0.2, components = $2, last_computed = NOW()`,
      [hostId, JSON.stringify({ reason: 'new_host' })]
    );
    return 0.2;
  }

  const totalCount = tournaments.length;
  const completedCount = tournaments.filter(t => t.status === 'completed').length;
  const completionRate = totalCount > 0 ? completedCount / totalCount : 0;

  // Confirm rate across all this host's matches (use match_confirmations OR p1/p2 report agreement).
  const tids = tournaments.map(t => t.id);
  let confirmRate = 0;
  let noDisputeRate = 1;
  if (tids.length > 0) {
    const matchQ = await _pool().query(
      `SELECT m.id, m.status, m.dispute_status, m.p1_report, m.p2_report,
              (SELECT COUNT(*) FROM match_confirmations mc WHERE mc.match_id = m.id) AS confirms
       FROM tournament_matches m
       WHERE m.tournament_id = ANY($1::int[])`, [tids]
    );
    const completedMatches = matchQ.rows.filter(m => m.status === 'completed');
    if (completedMatches.length > 0) {
      const confirmed = completedMatches.filter(m =>
        Number(m.confirms) >= 2 ||
        (m.p1_report && m.p2_report && m.dispute_status === 'agreed')
      ).length;
      confirmRate = confirmed / completedMatches.length;
      const disputes = completedMatches.filter(m => m.dispute_status === 'disputed' || m.dispute_status === 'resolved').length;
      noDisputeRate = 1 - (disputes / completedMatches.length);
    }
  }

  // Lobby Verified bonus: 1.0 if any of the host's tournaments are in a verified lobby
  let lobbyVerifiedBonus = 0;
  const lobbyIds = [...new Set(tournaments.map(t => t.lobby_id).filter(Boolean))];
  if (lobbyIds.length > 0) {
    const vq = await _pool().query(
      `SELECT 1 FROM servers WHERE unique_id = ANY($1::text[]) AND lobby_verified = TRUE LIMIT 1`,
      [lobbyIds]
    );
    if (vq.rows.length) lobbyVerifiedBonus = 1;
  }

  const tournamentsCompletedFactor = Math.min(1, completedCount / 20);

  const score = (
    0.25 * completionRate +
    0.25 * confirmRate +
    0.20 * noDisputeRate +
    0.15 * tournamentsCompletedFactor +
    0.15 * lobbyVerifiedBonus
  );

  const clamped = Math.max(0, Math.min(1, score));
  // Lobby Verified hosts floor at 0.7
  const final = lobbyVerifiedBonus === 1 ? Math.max(0.7, clamped) : clamped;

  const components = {
    completionRate, confirmRate, noDisputeRate, tournamentsCompletedFactor,
    lobbyVerifiedBonus, raw: clamped, final
  };

  await _pool().query(
    `INSERT INTO host_trust_scores (host_id, score, components, last_computed)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (host_id) DO UPDATE SET score = $2, components = $3, last_computed = NOW()`,
    [hostId, final, JSON.stringify(components)]
  );

  return final;
}

// ============================================================
//  TOURNAMENT CREDIBILITY / AUTO-TIER / RP COMPUTATION
// ============================================================

/**
 * Map placement (1 = winner, 2 = finalist, …) to a fractional share of winner RP.
 * The share is rounded to two decimals. Eliminated-in-R1 share is intentionally low.
 * Pure function.
 */
function distributeRpShare(placement, totalPlayers) {
  if (placement === 1) return 1.0;
  if (placement === 2) return 0.60;
  if (placement <= 4)  return 0.35;
  if (placement <= 8)  return 0.18;
  if (placement <= 16) return 0.09;
  if (placement <= 32) return 0.04;
  return 0.02;
}

/**
 * Compute auto-tier given inputs. Pure function.
 * @returns {'casual'|'verified'|'official'}
 */
function computeAutoTier(credibility, playerCount, hostTrust, publicBracket) {
  if (credibility >= 0.65 && playerCount >= 32 && hostTrust >= 0.7) return 'official';
  if (credibility >= 0.35 && playerCount >= 16 && hostTrust >= 0.5 && publicBracket) return 'verified';
  return 'casual';
}

/**
 * Compute base winner RP from credibility + tier. Smooth scaling within each tier band.
 * Pure function.
 */
function computeWinnerRpBase(credibility, autoTier) {
  const c = Math.max(0, Math.min(1, Number(credibility) || 0));
  if (autoTier === 'official') {
    return Math.round(250 + Math.min(1, (c - 0.65) / 0.35) * 250);
  }
  if (autoTier === 'verified') {
    return Math.round(50 + Math.min(1, Math.max(0, (c - 0.35) / 0.30)) * 200);
  }
  // casual
  return Math.round(5 + Math.min(1, c / 0.35) * 45);
}

/**
 * Opponent strength multiplier. Pure function.
 * Returns a number in [0.5, 1.5].
 */
function computeOpponentMultiplier(userElo, fieldAvgElo) {
  const m = 0.5 + (Number(fieldAvgElo || 1200) - Number(userElo || 1200)) / 800;
  // Wait — design doc reads: 0.5 + (winner_elo_at_start - field_avg_elo) / 800
  // That gives bonus when winner is BELOW field (upset). Higher elo than field → smaller bonus.
  // Let's recompute correctly:
  const corrected = 0.5 + (Number(userElo || 1200) - Number(fieldAvgElo || 1200)) / -800;
  // i.e. lower user_elo relative to field => higher mult (upset bonus)
  // equivalent: 0.5 + (field - user) / 800
  return Math.max(0.5, Math.min(1.5, corrected));
}

/**
 * Repeat-opponent diminishing multiplier. Pure function.
 */
function computeRepeatOpponentMultiplier(priorWins) {
  const n = Math.max(0, Math.floor(Number(priorWins) || 0));
  return [1.0, 0.5, 0.25, 0.10, 0.0][n] ?? 0.0;
}

/**
 * Elo K-factor based on matches played. Pure function.
 */
function kFactor(matchesPlayed) {
  const n = Number(matchesPlayed) || 0;
  if (n < 30) return 32;
  if (n < 100) return 24;
  return 16;
}

/**
 * Standard Elo update. Pure function.
 * @param {number} ratingA
 * @param {number} ratingB
 * @param {number} scoreA — 1 if A won, 0 if A lost, 0.5 for draw
 * @param {number} k     — K-factor
 * @returns {{newA: number, newB: number, deltaA: number, deltaB: number}}
 */
function applyEloUpdate(ratingA, ratingB, scoreA, k = 24) {
  const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  const deltaA = k * (scoreA - expectedA);
  const newA = Math.round(ratingA + deltaA);
  const newB = Math.round(ratingB - deltaA);
  return { newA, newB, deltaA: newA - ratingA, deltaB: newB - ratingB };
}

/**
 * Look at a tournament's matches + players and compute its credibility score.
 * Returns: { credibility, auto_tier, winner_rp_base, components }
 */
async function computeTournamentCredibility(tournamentId) {
  const tQ = await _pool().query(
    `SELECT t.*, s.unique_id AS server_unique_id, s.lobby_verified
     FROM tournaments t
     LEFT JOIN servers s ON s.unique_id = t.lobby_id
     WHERE t.id = $1`,
    [tournamentId]
  );
  if (!tQ.rows.length) throw new Error(`Tournament ${tournamentId} not found`);
  const t = tQ.rows[0];

  // size_factor
  const pcMap = { 4: 0.25, 8: 0.40, 16: 0.60, 32: 0.80, 64: 0.95, 128: 1.0 };
  const size_factor = pcMap[t.player_count] ?? 0.5;

  // field strength: average Elo of all players in this tournament for this game
  const gameTag = t.game_tag_normalized || 'other';
  const playersQ = await _pool().query(
    `SELECT tp.user_id, COALESCE(ur.current_elo, 1200) AS elo
     FROM tournament_players tp
     LEFT JOIN user_ratings ur ON ur.user_id = tp.user_id AND ur.game_tag_normalized = $2
       AND ur.season_id = (SELECT id FROM seasons WHERE status='active' LIMIT 1)
     WHERE tp.tournament_id = $1`, [tournamentId, gameTag]
  );
  const playerCount = playersQ.rows.length;
  const avgElo = playerCount > 0
    ? playersQ.rows.reduce((s, p) => s + Number(p.elo), 0) / playerCount
    : 1200;
  const field_strength = Math.max(0, Math.min(1, (avgElo - 1200) / 600));

  // host trust
  const host_trust = await computeHostTrustScore(t.host_id);

  // confirm rate
  const matchQ = await _pool().query(
    `SELECT m.id, m.status, m.dispute_status, m.p1_report, m.p2_report,
            (SELECT COUNT(*) FROM match_confirmations mc WHERE mc.match_id = m.id) AS confirms
     FROM tournament_matches m WHERE m.tournament_id = $1`, [tournamentId]
  );
  const completed = matchQ.rows.filter(m => m.status === 'completed');
  const confirmed = completed.filter(m =>
    Number(m.confirms) >= 2 || (m.p1_report && m.p2_report && m.dispute_status === 'agreed')
  );
  const confirm_rate = completed.length > 0 ? confirmed.length / completed.length : 0;

  // public bracket flag (we don't have a private flag yet — treat lobby_id presence + size as a proxy)
  let public_bracket = 1.0;
  if (playerCount < 16) public_bracket = 0.5;
  // (Future: if tournament_invites used as exclusive list, drop to 0.0)

  // format rigor
  const format_rigor = t.format === 'double' ? 1.0
                     : t.format === 'round-robin' ? 1.0
                     : t.format === 'single' ? 0.8
                     : 0.5;

  const match_credibility = 0.5 * confirm_rate + 0.3 * public_bracket + 0.2 * format_rigor;

  const credibility = Math.max(0, Math.min(1,
    0.30 * size_factor +
    0.25 * field_strength +
    0.25 * host_trust +
    0.20 * match_credibility
  ));

  const auto_tier = computeAutoTier(credibility, playerCount, host_trust, public_bracket >= 0.5);
  const winner_rp_base = computeWinnerRpBase(credibility, auto_tier);

  return {
    credibility,
    auto_tier,
    winner_rp_base,
    components: {
      size_factor, field_strength, host_trust, confirm_rate,
      public_bracket, format_rigor, match_credibility, avgElo, playerCount,
    }
  };
}

// ============================================================
//  APPLY TOURNAMENT RESULTS  (main hook on completion)
// ============================================================

/**
 * Idempotently award RP for a completed tournament.
 * - Reads tournament + bracket
 * - Computes credibility (or honours admin override)
 * - Determines placements
 * - Writes rp_transactions and updates user_ratings (+per-game and +__global__)
 * - Updates Elo per match
 * - Applies diminishing returns + smurf penalties + opponent multiplier
 *
 * Safe to call multiple times: the tournaments.rp_awarded flag prevents double-payment.
 */
async function applyTournamentResults(tournamentId) {
  const client = await _pool().connect();
  try {
    await client.query('BEGIN');

    const tQ = await client.query(`SELECT * FROM tournaments WHERE id = $1 FOR UPDATE`, [tournamentId]);
    if (!tQ.rows.length) throw new Error(`Tournament ${tournamentId} not found`);
    const t = tQ.rows[0];

    if (t.rp_awarded) {
      await client.query('ROLLBACK');
      return { skipped: true, reason: 'already_awarded' };
    }
    if (t.status !== 'completed') {
      await client.query('ROLLBACK');
      return { skipped: true, reason: 'not_completed' };
    }
    if (t.is_ranked === false) {
      await client.query('UPDATE tournaments SET rp_awarded = TRUE WHERE id = $1', [tournamentId]);
      await client.query('COMMIT');
      return { skipped: true, reason: 'unranked' };
    }

    const season = await getCurrentSeason();
    if (!season) throw new Error('No active season');

    const gameTag = t.game_tag_normalized || 'other';

    // Compute credibility (this runs queries — that's fine inside the txn,
    // even though it doesn't strictly need to be in the txn).
    const cred = await computeTournamentCredibility(tournamentId);

    // Determine effective winner_rp_base (admin override?)
    let effectiveBase = cred.winner_rp_base;
    let usedOverride = false;
    if (t.is_featured && t.admin_rp_override != null) {
      effectiveBase = Math.max(0, Math.floor(Number(t.admin_rp_override)));
      usedOverride = true;
    }

    // Persist credibility on tournament row (for transparency)
    await client.query(
      `UPDATE tournaments
       SET credibility_score = $1, auto_tier = $2, computed_winner_rp = $3,
           season_id_at_completion = $4
       WHERE id = $5`,
      [cred.credibility, cred.auto_tier, effectiveBase, season.id, tournamentId]
    );

    // Read all players + their matches to determine placements
    const playersQ = await client.query(
      `SELECT id, user_id, username FROM tournament_players WHERE tournament_id = $1`,
      [tournamentId]
    );
    const matchesQ = await client.query(
      `SELECT m.id, m.player1_id, m.player2_id, m.winner_id, m.status, r.round_number
       FROM tournament_matches m
       JOIN tournament_rounds r ON r.id = m.round_id
       WHERE m.tournament_id = $1
       ORDER BY r.round_number ASC, m.match_number ASC`, [tournamentId]
    );

    // Build a map: tournament_player_id → { eliminationRound, isWinner }
    const placementMap = new Map();
    const totalRounds = matchesQ.rows.reduce((m, r) => Math.max(m, r.round_number), 0);
    for (const p of playersQ.rows) placementMap.set(p.id, { eliminationRound: 0, userId: p.user_id });

    for (const m of matchesQ.rows) {
      if (m.status !== 'completed' || !m.winner_id) continue;
      const loser = (m.player1_id === m.winner_id) ? m.player2_id : m.player1_id;
      if (loser && placementMap.has(loser)) {
        // Loser eliminated in this round; record the round number (higher = later)
        const cur = placementMap.get(loser);
        if (m.round_number > cur.eliminationRound) cur.eliminationRound = m.round_number;
      }
    }
    // Winner: the player listed as tournaments.winner_id
    const winnerTpId = t.winner_id;
    // Convert elimination rounds to placement ordering.
    // Placement 1 = winner. Placement 2 = lost in final. Placement 3-4 = lost in semis. Etc.
    // Players who never lost (other than winner) shouldn't exist in a clean bracket.
    const placements = [];
    placementMap.forEach((v, tpId) => {
      placements.push({ tpId, userId: v.userId, eliminationRound: v.eliminationRound });
    });
    // Sort: higher eliminationRound = better placement. Winner gets Infinity.
    for (const pl of placements) {
      if (pl.tpId === winnerTpId) pl.eliminationRound = Infinity;
    }
    placements.sort((a, b) => b.eliminationRound - a.eliminationRound);

    // Assign placement numbers (1-based).
    placements.forEach((p, idx) => { p.placement = idx + 1; });

    // Field-average Elo (game-specific) for opponent multiplier — already computed in credibility.
    const fieldAvgElo = cred.components.avgElo;

    // Per-player RP awards
    const totalPlayers = placements.length;
    const awards = [];
    for (const pl of placements) {
      const share = distributeRpShare(pl.placement, totalPlayers);
      const baseRp = effectiveBase * share;
      awards.push({ ...pl, baseRp });
    }

    // For each player: apply multipliers and write transactions for BOTH per-game and __global__ ladders.
    for (const aw of awards) {
      // Ensure rating rows
      const perGame = await ensureUserRating(aw.userId, gameTag);
      const global  = await ensureUserRating(aw.userId, '__global__');

      // Opponent multiplier (uses winner's Elo vs field; we approximate by user's Elo)
      const userElo = perGame.current_elo || 1200;
      const oppMult = computeOpponentMultiplier(userElo, fieldAvgElo);

      // Confirmation multiplier — fraction of this user's matches in this tournament that were confirmed
      const userMatchesQ = await client.query(
        `SELECT m.id, m.dispute_status,
                (SELECT COUNT(*) FROM match_confirmations mc WHERE mc.match_id = m.id) AS confirms,
                m.p1_report, m.p2_report
         FROM tournament_matches m
         WHERE m.tournament_id = $1 AND (m.player1_id = $2 OR m.player2_id = $2) AND m.status = 'completed'`,
        [tournamentId, aw.tpId]
      );
      const userCompleted = userMatchesQ.rows;
      const userConfirmed = userCompleted.filter(m =>
        Number(m.confirms) >= 2 || (m.p1_report && m.p2_report && m.dispute_status === 'agreed')
      );
      const confirmFrac = userCompleted.length > 0 ? userConfirmed.length / userCompleted.length : 1;
      const confirmMult = 0.4 + 0.6 * confirmFrac;

      // Placement-match multiplier
      const placementMult = perGame.placement_matches_remaining > 0 ? 2.0 : 1.0;

      // Smurf penalty
      const smurfQ = await client.query(
        `SELECT 1 FROM smurf_flags WHERE user_id = $1 AND cleared_at IS NULL LIMIT 1`, [aw.userId]
      );
      const smurfMult = smurfQ.rows.length ? 0.5 : 1.0;

      // Diminishing-returns: average over all matches the user won in this tournament
      // (we apply DR pre-aggregation per match win against same opponent in the last 30 days)
      let drMult = 1.0;
      const winsQ = await client.query(
        `SELECT m.id,
                CASE WHEN m.player1_id = $2 THEN p2.user_id ELSE p1.user_id END AS opp_user_id
         FROM tournament_matches m
         JOIN tournament_players p1 ON p1.id = m.player1_id
         JOIN tournament_players p2 ON p2.id = m.player2_id
         WHERE m.tournament_id = $1 AND m.winner_id = $2 AND m.status = 'completed'`,
        [tournamentId, aw.tpId]
      );
      if (winsQ.rows.length > 0) {
        let multSum = 0;
        for (const w of winsQ.rows) {
          if (!w.opp_user_id) { multSum += 1.0; continue; }
          const priorQ = await client.query(
            `SELECT COUNT(*)::int AS cnt
             FROM tournament_matches m2
             JOIN tournament_players wp ON wp.id = m2.winner_id
             JOIN tournament_players lp ON lp.id = CASE WHEN m2.player1_id = m2.winner_id THEN m2.player2_id ELSE m2.player1_id END
             WHERE wp.user_id = $1 AND lp.user_id = $2
               AND m2.status = 'completed'
               AND m2.completed_at >= NOW() - INTERVAL '30 days'
               AND m2.tournament_id <> $3`,
            [aw.userId, w.opp_user_id, tournamentId]
          );
          multSum += computeRepeatOpponentMultiplier(Number(priorQ.rows[0].cnt));
        }
        drMult = multSum / winsQ.rows.length;
      }

      // Final RP delta
      const finalDelta = Math.round(aw.baseRp * oppMult * confirmMult * placementMult * smurfMult * drMult);

      // Apply to per-game rating
      const newPerGameRp = Math.max(0, perGame.current_rp + finalDelta);
      const newPeakPerGame = Math.max(perGame.peak_rp, newPerGameRp);
      const newPeakTierPG = rankFromRp(newPeakPerGame).tier;
      const newPlacementRemaining = Math.max(0, perGame.placement_matches_remaining - 1);
      await client.query(
        `UPDATE user_ratings
         SET current_rp = $1, peak_rp = $2, peak_tier = $3,
             ranked_tournaments_played = ranked_tournaments_played + 1,
             ranked_wins = ranked_wins + $4,
             placement_matches_remaining = $5,
             last_active = NOW()
         WHERE id = $6`,
        [newPerGameRp, newPeakPerGame, newPeakTierPG, aw.placement === 1 ? 1 : 0, newPlacementRemaining, perGame.id]
      );

      // rp_transaction (per-game)
      await client.query(
        `INSERT INTO rp_transactions
         (user_id, tournament_id, season_id, game_tag_normalized, delta, reason, breakdown, rp_before, rp_after)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [aw.userId, tournamentId, season.id, gameTag, finalDelta,
         aw.placement === 1 ? 'tournament_win' : 'tournament_placement',
         JSON.stringify({
           base: aw.baseRp, oppMult, confirmMult, placementMult, smurfMult, drMult,
           placement: aw.placement, totalPlayers, usedOverride,
           credibility: cred.credibility, autoTier: cred.auto_tier
         }),
         perGame.current_rp, newPerGameRp]
      );

      // Global ladder: half the per-game delta (top-up so being good in multiple games is rewarded)
      const globalDelta = Math.round(finalDelta * 0.5);
      const newGlobalRp = Math.max(0, global.current_rp + globalDelta);
      const newPeakGlobal = Math.max(global.peak_rp, newGlobalRp);
      const newPeakTierGlobal = rankFromRp(newPeakGlobal).tier;
      await client.query(
        `UPDATE user_ratings
         SET current_rp = $1, peak_rp = $2, peak_tier = $3,
             ranked_tournaments_played = ranked_tournaments_played + 1,
             ranked_wins = ranked_wins + $4,
             last_active = NOW()
         WHERE id = $5`,
        [newGlobalRp, newPeakGlobal, newPeakTierGlobal,
         aw.placement === 1 ? 1 : 0, global.id]
      );
      await client.query(
        `INSERT INTO rp_transactions
         (user_id, tournament_id, season_id, game_tag_normalized, delta, reason, breakdown, rp_before, rp_after)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [aw.userId, tournamentId, season.id, '__global__', globalDelta,
         aw.placement === 1 ? 'tournament_win' : 'tournament_placement',
         JSON.stringify({ derivedFromPerGame: finalDelta, ratio: 0.5 }),
         global.current_rp, newGlobalRp]
      );
    }

    // Elo updates per completed match
    for (const m of matchesQ.rows) {
      if (m.status !== 'completed' || !m.winner_id || !m.player1_id || !m.player2_id) continue;
      const p1User = playersQ.rows.find(p => p.id === m.player1_id)?.user_id;
      const p2User = playersQ.rows.find(p => p.id === m.player2_id)?.user_id;
      if (!p1User || !p2User) continue;
      const winnerUser = playersQ.rows.find(p => p.id === m.winner_id)?.user_id;
      if (!winnerUser) continue;

      const p1Rating = await ensureUserRating(p1User, gameTag);
      const p2Rating = await ensureUserRating(p2User, gameTag);
      const scoreA = winnerUser === p1User ? 1 : 0;
      const k = kFactor(Math.min(p1Rating.ranked_matches_played, p2Rating.ranked_matches_played));
      const { newA, newB } = applyEloUpdate(p1Rating.current_elo, p2Rating.current_elo, scoreA, k);
      await client.query(
        `UPDATE user_ratings SET current_elo = $1, ranked_matches_played = ranked_matches_played + 1 WHERE id = $2`,
        [newA, p1Rating.id]
      );
      await client.query(
        `UPDATE user_ratings SET current_elo = $1, ranked_matches_played = ranked_matches_played + 1 WHERE id = $2`,
        [newB, p2Rating.id]
      );
    }

    // Mark tournament as awarded
    await client.query(`UPDATE tournaments SET rp_awarded = TRUE WHERE id = $1`, [tournamentId]);

    // Bump games tournaments_count
    await upsertGame(t.game_tag || gameTag, { incrementCount: true });

    await client.query('COMMIT');

    // Post-commit: flag smurfs (non-critical, runs outside txn)
    for (const aw of awards) {
      flagSmurfIfNeeded(aw.userId, gameTag).catch(() => {});
    }

    return {
      awarded: true,
      credibility: cred.credibility,
      auto_tier: cred.auto_tier,
      winner_rp_base: effectiveBase,
      usedOverride,
      players: awards.length,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ============================================================
//  SMURF DETECTION
// ============================================================

/**
 * Check whether a user matches the smurf profile and flag them if so.
 * Non-throwing; logs warnings on failure.
 */
async function flagSmurfIfNeeded(userId, gameTagNormalized) {
  try {
    const uQ = await _pool().query(
      `SELECT u.id, u.created_at, ur.ranked_tournaments_played, ur.ranked_wins, ur.current_elo
       FROM users u
       LEFT JOIN user_ratings ur ON ur.user_id = u.id AND ur.game_tag_normalized = $2
         AND ur.season_id = (SELECT id FROM seasons WHERE status='active' LIMIT 1)
       WHERE u.id = $1`, [userId, gameTagNormalized]
    );
    if (!uQ.rows.length) return;
    const u = uQ.rows[0];
    const accountAgeDays = (Date.now() - new Date(u.created_at).getTime()) / 86400000;
    const played = Number(u.ranked_tournaments_played || 0);
    const wins   = Number(u.ranked_wins || 0);
    const winRate = played > 0 ? wins / played : 0;
    const startingElo = 1200;

    // Average opponent Elo this user has faced (in this game)
    const avgQ = await _pool().query(
      `SELECT COALESCE(AVG(ur2.current_elo), 1200) AS avg_opp
       FROM tournament_matches m
       JOIN tournament_players p1 ON p1.id = m.player1_id
       JOIN tournament_players p2 ON p2.id = m.player2_id
       JOIN tournaments t ON t.id = m.tournament_id
       JOIN user_ratings ur2 ON ur2.user_id = CASE WHEN p1.user_id = $1 THEN p2.user_id ELSE p1.user_id END
                            AND ur2.game_tag_normalized = $2
                            AND ur2.season_id = (SELECT id FROM seasons WHERE status='active' LIMIT 1)
       WHERE (p1.user_id = $1 OR p2.user_id = $1)
         AND t.game_tag_normalized = $2 AND m.status='completed'`,
      [userId, gameTagNormalized]
    );
    const avgOpp = Number(avgQ.rows[0]?.avg_opp || 1200);

    const conditions = [
      accountAgeDays < 14,
      played < 10,
      winRate > 0.85,
      avgOpp - startingElo > 200,
    ];
    const matchCount = conditions.filter(Boolean).length;
    if (matchCount >= 3) {
      // Check if already flagged
      const existing = await _pool().query(
        `SELECT 1 FROM smurf_flags WHERE user_id = $1 AND cleared_at IS NULL LIMIT 1`, [userId]
      );
      if (!existing.rows.length) {
        await _pool().query(
          `INSERT INTO smurf_flags (user_id, reason, score)
           VALUES ($1, $2, $3)`,
          [userId, 'auto_detected', matchCount / 4]
        );
      }
    }
  } catch (e) {
    console.warn('[rating-engine] smurf flag check failed for user', userId, e.message);
  }
}

// ============================================================
//  EXPORTS
// ============================================================
module.exports = {
  // Public API
  getCurrentSeason,
  ensureUserRating,
  getUserTier,
  canHostAtTier,
  normalizeGameTag,
  upsertGame,
  rankFromRp,
  computeHostTrustScore,
  computeTournamentCredibility,
  applyEloUpdate,
  applyTournamentResults,
  runSeasonRollover,
  checkSeasonRollover,
  flagSmurfIfNeeded,

  // Pure helpers (exported for unit tests)
  distributeRpShare,
  computeWinnerRpBase,
  computeAutoTier,
  computeOpponentMultiplier,
  computeRepeatOpponentMultiplier,
  softResetRp,
  kFactor,

  // Constants
  RANK_TIERS,
  BASE_TIER_ORDER,

  // Internal pool override for testing
  _poolOverride: null,
};
