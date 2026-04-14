// backend/tournaments.js — LOBBY Tournament Router
// Full version: Manual + Self-Report + Riot API + Chess API result modes
// Includes: lock-in, dispute, auto-advance, game_url for live embeds
const express = require('express');
const router  = express.Router();

// ── DB pool ──────────────────────────────────────────────────
const { Pool } = require('pg');
let pool;
if (process.env.DATABASE_URL) {
  const url    = require('url');
  const dbUrl  = url.parse(process.env.DATABASE_URL);
  const [dbUser, dbPass] = (dbUrl.auth || ':').split(':');
  pool = new Pool({ user: dbUser, password: dbPass, host: dbUrl.hostname, port: dbUrl.port || 5432, database: dbUrl.pathname.slice(1), ssl: { rejectUnauthorized: false } });
} else {
  pool = new Pool({ host: process.env.PG_HOST || 'localhost', port: process.env.PG_PORT || 5432, database: process.env.PG_DB || 'lobby', user: process.env.PG_USER || 'postgres', password: process.env.PG_PASSWORD, ssl: false });
}

// ── Run migrations on startup ─────────────────────────────────
(async () => {
  const migrations = [
    "ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS winner_id INTEGER REFERENCES tournament_players(id) ON DELETE SET NULL",
    "ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS has_losers_bracket BOOLEAN DEFAULT FALSE",
    "ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS has_points_tally BOOLEAN DEFAULT TRUE",
    "ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS scheduled_start TIMESTAMPTZ DEFAULT NULL",
    "ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS alert_before_minutes INTEGER DEFAULT 15",
    "ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS result_mode TEXT DEFAULT 'manual'",
    "ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS api_game TEXT DEFAULT NULL",
    "ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS dispute_timeout INTEGER DEFAULT 30",
    "ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS locked_players JSONB DEFAULT '[]'",
    "ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS round_locked BOOLEAN DEFAULT FALSE",
    "ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS p1_report JSONB DEFAULT NULL",
    "ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS p2_report JSONB DEFAULT NULL",
    "ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS dispute_status TEXT DEFAULT NULL",
    "ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS dispute_resolved_by INTEGER DEFAULT NULL",
    "ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS player1_score INTEGER DEFAULT 0",
    "ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS player2_score INTEGER DEFAULT 0",
    "ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS game_url TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS tournament_card_image_url TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS tournament_card_bg_colour TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS tournament_card_border_colour TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS tournament_card_name_colour TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS tournament_card_bg_pos TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS riot_puuid TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS riot_gamename TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS riot_tagline TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS chess_username TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS lichess_username TEXT DEFAULT NULL",
  ];
  for (const sql of migrations) {
    try { await pool.query(sql); } catch(e) { /* column exists — skip */ }
  }
  console.log('[✓] Tournament columns verified');
})();

// ── Auth middleware ───────────────────────────────────────────
function verifyAuth(req, res, next) {
  if (!req.user || !req.user.id) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── Helper: advance winner to next round ──────────────────────
async function advanceWinner(tournamentId, matchId, winnerDbId) {
  const curMatch = await pool.query(
    `SELECT m.match_number, r.round_number FROM tournament_matches m
     JOIN tournament_rounds r ON m.round_id = r.id WHERE m.id = $1`, [matchId]
  );
  if (!curMatch.rows.length) return;
  const { match_number, round_number } = curMatch.rows[0];
  const nextRound = await pool.query(
    'SELECT id FROM tournament_rounds WHERE tournament_id = $1 AND round_number = $2',
    [tournamentId, round_number + 1]
  );
  if (nextRound.rows.length) {
    const slot = match_number % 2 === 0 ? 'player1_id' : 'player2_id';
    await pool.query(
      `UPDATE tournament_matches SET ${slot} = $1 WHERE round_id = $2 AND match_number = $3`,
      [winnerDbId, nextRound.rows[0].id, Math.floor(match_number / 2)]
    );
  } else {
    await pool.query(
      `UPDATE tournaments SET status = 'completed', winner_id = $1 WHERE id = $2`,
      [winnerDbId, tournamentId]
    );
  }
}

// ── Helper: get bracket data ──────────────────────────────────
async function getBracketData(tournamentId) {
  const roundsResult = await pool.query(
    `SELECT id, round_number FROM tournament_rounds WHERE tournament_id = $1 ORDER BY round_number ASC`,
    [tournamentId]
  );
  const rounds = await Promise.all(roundsResult.rows.map(async (round) => {
    const matchesResult = await pool.query(
      `SELECT m.id, m.match_number,
              p1.user_id as player1_user_id, p1.username as player1_username,
              u1.avatar_url as player1_avatar,
              p2.user_id as player2_user_id, p2.username as player2_username,
              u2.avatar_url as player2_avatar,
              m.winner_id, m.status,
              m.player1_score, m.player2_score,
              m.locked_players, m.round_locked,
              m.p1_report, m.p2_report, m.dispute_status,
              m.game_url
       FROM tournament_matches m
       LEFT JOIN tournament_players p1 ON m.player1_id = p1.id
       LEFT JOIN tournament_players p2 ON m.player2_id = p2.id
       LEFT JOIN users u1 ON p1.user_id = u1.id
       LEFT JOIN users u2 ON p2.user_id = u2.id
       WHERE m.round_id = $1 ORDER BY m.match_number ASC`,
      [round.id]
    );

    // Load tournament card data
    const cardCache = {};
    const userIds = matchesResult.rows.flatMap(m => [m.player1_user_id, m.player2_user_id]).filter(Boolean);
    if (userIds.length) {
      try {
        const cr = await pool.query(
          `SELECT id, tournament_card_image_url, tournament_card_bg_colour,
                  tournament_card_border_colour, tournament_card_name_colour, tournament_card_bg_pos
           FROM users WHERE id = ANY($1)`, [userIds]
        );
        cr.rows.forEach(u => { cardCache[u.id] = u; });
      } catch(e) { /* skip */ }
    }
    const getCard = (uid) => {
      const u = cardCache[uid] || {};
      return { imageUrl: u.tournament_card_image_url||null, bgColour: u.tournament_card_bg_colour||'#2c3440', borderColour: u.tournament_card_border_colour||'#f9a8d4', nameColour: u.tournament_card_name_colour||'#fdf2f8', bgPos: u.tournament_card_bg_pos||'50% 50%' };
    };

    return {
      roundNumber: round.round_number,
      matches: matchesResult.rows.map(m => ({
        matchId:      m.id,
        matchNumber:  m.match_number,
        player1Score: m.player1_score ?? 0,
        player2Score: m.player2_score ?? 0,
        lockedPlayers: m.locked_players || [],
        roundLocked:  m.round_locked || false,
        p1Report:     m.p1_report || null,
        p2Report:     m.p2_report || null,
        disputeStatus: m.dispute_status || null,
        gameUrl:      m.game_url || null,
        player1: m.player1_user_id ? { userId: m.player1_user_id, username: m.player1_username, avatar_url: m.player1_avatar||null, tournamentCard: getCard(m.player1_user_id) } : null,
        player2: m.player2_user_id ? { userId: m.player2_user_id, username: m.player2_username, avatar_url: m.player2_avatar||null, tournamentCard: getCard(m.player2_user_id) } : null,
        winner: m.winner_id,
        status: m.status
      }))
    };
  }));
  return { rounds };
}

// ============================================================
// CREATE TOURNAMENT
// ============================================================
router.post('/create', verifyAuth, async (req, res) => {
  try {
    const { lobbyId, name, description, format, playerCount, rules, prize, startTime,
            hasLosersBracket, hasPointsTally, scheduledStart, alertBeforeMinutes,
            hostJoinsAsPlayer, resultMode, apiGame, disputeTimeout } = req.body;

    if (!lobbyId || !name || !format || !playerCount) return res.status(400).json({ error: 'Missing required fields' });
    if (!['single','double','round-robin'].includes(format)) return res.status(400).json({ error: 'Invalid format' });
    if (![4,8,16,32,64,128].includes(playerCount)) return res.status(400).json({ error: 'Invalid player count' });

    const result = await pool.query(
      `INSERT INTO tournaments
        (lobby_id, host_id, name, description, format, player_count, max_players, status,
         rules, prize, start_time, has_losers_bracket, has_points_tally,
         scheduled_start, alert_before_minutes, result_mode, api_game, dispute_timeout)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [
        lobbyId, req.user.id, name, description||null, format, playerCount, playerCount, 'setup',
        rules||null, prize||null, startTime ? new Date(startTime) : null,
        hasLosersBracket ? true : false, hasPointsTally !== false,
        scheduledStart ? new Date(scheduledStart) : null, parseInt(alertBeforeMinutes)||15,
        ['manual','self-report','riot-api','chess-api'].includes(resultMode) ? resultMode : 'manual',
        apiGame || null, parseInt(disputeTimeout)||30
      ]
    );
    const tournament = result.rows[0];

    let registeredPlayersList = [];
    if (hostJoinsAsPlayer !== false) {
      await pool.query(
        `INSERT INTO tournament_players (tournament_id, user_id, username, joined_at, status)
         VALUES ($1, $2, $3, $4, $5)`,
        [tournament.id, req.user.id, req.user.username, new Date(), 'registered']
      );
      registeredPlayersList = [{ userId: req.user.id, username: req.user.username }];
    }

    res.status(201).json({ success: true, tournament: {
      id: tournament.id, lobbyId: tournament.lobby_id, hostId: tournament.host_id,
      name: tournament.name, format: tournament.format, playerCount: tournament.player_count,
      registeredPlayers: registeredPlayersList, bracket: { rounds: [] }, status: tournament.status,
      resultMode: tournament.result_mode, apiGame: tournament.api_game
    }});
  } catch(error) {
    console.error('Tournament creation error:', error);
    res.status(500).json({ error: 'Failed to create tournament' });
  }
});

// ============================================================
// GET TOURNAMENTS FOR A LOBBY
// ============================================================
router.get('/lobby/:lobbyId', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM tournaments WHERE lobby_id = $1 ORDER BY created_at DESC',
      [req.params.lobbyId]
    );
    const tournaments = await Promise.all(result.rows.map(async (t) => {
      const playersResult = await pool.query(
        `SELECT tp.user_id, tp.username, tp.joined_at, tp.status, u.avatar_url,
                u.tournament_card_image_url, u.tournament_card_bg_colour,
                u.tournament_card_border_colour, u.tournament_card_name_colour, u.tournament_card_bg_pos
         FROM tournament_players tp LEFT JOIN users u ON tp.user_id = u.id
         WHERE tp.tournament_id = $1`, [t.id]
      );
      return {
        id: t.id, lobbyId: t.lobby_id, hostId: t.host_id, name: t.name,
        description: t.description, format: t.format, playerCount: t.player_count,
        status: t.status, createdAt: t.created_at, startTime: t.start_time,
        rules: t.rules, prize: t.prize, scheduledStart: t.scheduled_start,
        alertBeforeMinutes: t.alert_before_minutes, resultMode: t.result_mode || 'manual',
        apiGame: t.api_game || null,
        registeredPlayers: playersResult.rows.map(p => ({
          userId: p.user_id, username: p.username, joinedAt: p.joined_at, status: p.status,
          avatar_url: p.avatar_url,
          tournamentCard: { imageUrl: p.tournament_card_image_url||null, bgColour: p.tournament_card_bg_colour||'#2c3440', borderColour: p.tournament_card_border_colour||'#f9a8d4', nameColour: p.tournament_card_name_colour||'#fdf2f8', bgPos: p.tournament_card_bg_pos||'50% 50%' }
        }))
      };
    }));
    res.json(tournaments);
  } catch(error) {
    console.error('Load tournaments error:', error);
    res.status(500).json({ error: 'Failed to fetch tournaments' });
  }
});

// ============================================================
// GET TOURNAMENT DETAILS
// ============================================================
router.get('/:tournamentId', async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const tourResult = await pool.query('SELECT * FROM tournaments WHERE id = $1', [tournamentId]);
    if (!tourResult.rows.length) return res.status(404).json({ error: 'Tournament not found' });
    const tournament = tourResult.rows[0];

    const playersResult = await pool.query(
      `SELECT tp.user_id, tp.username, tp.joined_at, tp.status, u.avatar_url,
              u.tournament_card_image_url, u.tournament_card_bg_colour,
              u.tournament_card_border_colour, u.tournament_card_name_colour, u.tournament_card_bg_pos
       FROM tournament_players tp LEFT JOIN users u ON tp.user_id = u.id
       WHERE tp.tournament_id = $1`, [tournamentId]
    );

    const bracket = await getBracketData(tournamentId);

    const hostInfoResult = await pool.query(
      `SELECT id, username, avatar_url, tournament_card_image_url, tournament_card_bg_colour,
              tournament_card_border_colour, tournament_card_name_colour, tournament_card_bg_pos
       FROM users WHERE id = $1`, [tournament.host_id]
    );
    const hi = hostInfoResult.rows[0] || {};

    let winnerId = null;
    if (tournament.winner_id) {
      const wr = await pool.query('SELECT user_id FROM tournament_players WHERE id = $1', [tournament.winner_id]);
      if (wr.rows.length) winnerId = wr.rows[0].user_id;
    }

    res.json({
      id: tournament.id, lobbyId: tournament.lobby_id, hostId: tournament.host_id,
      hostInfo: { userId: tournament.host_id, username: hi.username||'Host', avatar_url: hi.avatar_url||null,
        tournamentCard: { imageUrl: hi.tournament_card_image_url||null, bgColour: hi.tournament_card_bg_colour||'#2c3440', borderColour: hi.tournament_card_border_colour||'#f9a8d4', nameColour: hi.tournament_card_name_colour||'#fdf2f8', bgPos: hi.tournament_card_bg_pos||'50% 50%' }
      },
      name: tournament.name, description: tournament.description, format: tournament.format,
      playerCount: tournament.player_count, status: tournament.status,
      createdAt: tournament.created_at, startTime: tournament.start_time, endTime: tournament.end_time,
      rules: tournament.rules, prize: tournament.prize, winnerId,
      scheduledStart: tournament.scheduled_start||null, alertBeforeMinutes: tournament.alert_before_minutes||15,
      resultMode: tournament.result_mode||'manual', apiGame: tournament.api_game||null,
      hasLosersBracket: tournament.has_losers_bracket||false, hasPointsTally: tournament.has_points_tally!==false,
      bracket,
      registeredPlayers: playersResult.rows.map(p => ({
        userId: p.user_id, username: p.username, joinedAt: p.joined_at, status: p.status,
        avatar_url: p.avatar_url,
        tournamentCard: { imageUrl: p.tournament_card_image_url||null, bgColour: p.tournament_card_bg_colour||'#2c3440', borderColour: p.tournament_card_border_colour||'#f9a8d4', nameColour: p.tournament_card_name_colour||'#fdf2f8', bgPos: p.tournament_card_bg_pos||'50% 50%' }
      }))
    });
  } catch(error) {
    console.error('Get tournament error:', error);
    res.status(500).json({ error: 'Failed to fetch tournament' });
  }
});

// ============================================================
// REGISTER PLAYER
// ============================================================
router.post('/:tournamentId/register', verifyAuth, async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const tourResult = await pool.query('SELECT * FROM tournaments WHERE id = $1', [tournamentId]);
    if (!tourResult.rows.length) return res.status(404).json({ error: 'Tournament not found' });
    const tournament = tourResult.rows[0];
    const existing = await pool.query('SELECT id FROM tournament_players WHERE tournament_id = $1 AND user_id = $2', [tournamentId, req.user.id]);
    if (existing.rows.length) return res.status(400).json({ error: 'Already registered' });
    const countResult = await pool.query('SELECT COUNT(*) as count FROM tournament_players WHERE tournament_id = $1', [tournamentId]);
    if (parseInt(countResult.rows[0].count) >= tournament.max_players) return res.status(400).json({ error: 'Tournament is full' });
    await pool.query(
      `INSERT INTO tournament_players (tournament_id, user_id, username, joined_at, status)
       VALUES ($1, $2, $3, $4, $5)`,
      [tournamentId, req.user.id, req.user.username, new Date(), 'registered']
    );
    res.json({ success: true });
  } catch(error) { res.status(500).json({ error: 'Failed to register' }); }
});

// ============================================================
// LEAVE TOURNAMENT
// ============================================================
router.post('/:tournamentId/leave', verifyAuth, async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const tourResult = await pool.query('SELECT * FROM tournaments WHERE id = $1', [tournamentId]);
    if (!tourResult.rows.length) return res.status(404).json({ error: 'Tournament not found' });
    if (tourResult.rows[0].status !== 'setup') return res.status(400).json({ error: 'Cannot leave after tournament starts' });
    const existing = await pool.query('SELECT id FROM tournament_players WHERE tournament_id = $1 AND user_id = $2', [tournamentId, req.user.id]);
    if (!existing.rows.length) return res.status(400).json({ error: 'Not registered' });
    await pool.query('DELETE FROM tournament_players WHERE tournament_id = $1 AND user_id = $2', [tournamentId, req.user.id]);
    res.json({ success: true });
  } catch(error) { res.status(500).json({ error: 'Failed to leave' }); }
});

// ============================================================
// REMOVE PLAYER (host only, setup only)
// ============================================================
router.delete('/:tournamentId/players/:userId', verifyAuth, async (req, res) => {
  try {
    const { tournamentId, userId } = req.params;
    const tourResult = await pool.query('SELECT host_id, status FROM tournaments WHERE id = $1', [tournamentId]);
    if (!tourResult.rows.length) return res.status(404).json({ error: 'Not found' });
    const t = tourResult.rows[0];
    if (t.host_id !== req.user.id) return res.status(403).json({ error: 'Only host can remove players' });
    if (t.status !== 'setup') return res.status(400).json({ error: 'Can only remove players before start' });
    await pool.query('DELETE FROM tournament_players WHERE tournament_id = $1 AND user_id = $2', [tournamentId, userId]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: 'Failed to remove player' }); }
});

// ============================================================
// GENERATE BRACKET
// ============================================================
router.post('/:tournamentId/generate-bracket', verifyAuth, async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const tourResult = await pool.query('SELECT * FROM tournaments WHERE id = $1', [tournamentId]);
    if (!tourResult.rows.length) return res.status(404).json({ error: 'Tournament not found' });
    const tournament = tourResult.rows[0];
    if (tournament.host_id !== req.user.id) return res.status(403).json({ error: 'Only host can generate bracket' });

    const playersResult = await pool.query(
      'SELECT id as tournament_player_id, user_id, username FROM tournament_players WHERE tournament_id = $1', [tournamentId]
    );
    const shuffled = [...playersResult.rows].sort(() => Math.random() - 0.5);
    const numPlayers = shuffled.length;
    const slots = Math.pow(2, Math.ceil(Math.log2(Math.max(numPlayers, 2))));
    const numRounds = Math.log2(slots);

    await pool.query('DELETE FROM tournament_rounds WHERE tournament_id = $1', [tournamentId]);

    const roundIds = {};
    for (let r = 1; r <= numRounds; r++) {
      const rResult = await pool.query(
        `INSERT INTO tournament_rounds (tournament_id, round_number) VALUES ($1, $2) RETURNING id`,
        [tournamentId, r]
      );
      roundIds[r] = rResult.rows[0].id;
      const matchCount = slots / Math.pow(2, r);
      for (let m = 0; m < matchCount; m++) {
        const p1 = r === 1 ? (shuffled[m * 2]?.tournament_player_id || null) : null;
        const p2 = r === 1 ? (shuffled[m * 2 + 1]?.tournament_player_id || null) : null;
        await pool.query(
          `INSERT INTO tournament_matches (round_id, tournament_id, match_number, player1_id, player2_id, status)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [roundIds[r], tournamentId, m, p1, p2, 'pending']
        );
      }
    }

    // Cascade byes
    let changed = true;
    while (changed) {
      changed = false;
      for (let r = 1; r < numRounds; r++) {
        const byeResult = await pool.query(
          `SELECT m.id, m.match_number, m.player1_id, m.player2_id
           FROM tournament_matches m JOIN tournament_rounds tr ON m.round_id = tr.id
           WHERE tr.tournament_id = $1 AND tr.round_number = $2
             AND m.status != 'bye' AND (m.player1_id IS NULL OR m.player2_id IS NULL)`,
          [tournamentId, r]
        );
        for (const match of byeResult.rows) {
          changed = true;
          const p1 = match.player1_id, p2 = match.player2_id;
          if (!p1 && !p2) {
            await pool.query(`UPDATE tournament_matches SET status = 'bye' WHERE id = $1`, [match.id]);
          } else {
            const winner = p1 || p2;
            await pool.query(`UPDATE tournament_matches SET winner_id = $1, status = 'bye' WHERE id = $2`, [winner, match.id]);
            const slot = match.match_number % 2 === 0 ? 'player1_id' : 'player2_id';
            await pool.query(`UPDATE tournament_matches SET ${slot} = $1 WHERE round_id = $2 AND match_number = $3`,
              [winner, roundIds[r + 1], Math.floor(match.match_number / 2)]
            );
          }
        }
      }
    }

    await pool.query(`UPDATE tournaments SET status = 'in-progress', start_time = $1 WHERE id = $2`, [new Date(), tournamentId]);
    const bracket = await getBracketData(tournamentId);
    res.json({ success: true, bracket });
  } catch(error) {
    console.error('Bracket generation error:', error);
    res.status(500).json({ error: 'Failed to generate bracket' });
  }
});

// ============================================================
// SET WINNER (host manual advance)
// ============================================================
router.post('/:tournamentId/set-winner', verifyAuth, async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const { matchId: directMatchId, roundNumber, matchNumber, winnerId } = req.body;

    const tourResult = await pool.query('SELECT * FROM tournaments WHERE id = $1', [tournamentId]);
    if (!tourResult.rows.length) return res.status(404).json({ error: 'Tournament not found' });
    if (tourResult.rows[0].host_id !== req.user.id) return res.status(403).json({ error: 'Only host can set winners' });

    let matchId = directMatchId;
    if (!matchId) {
      const mr = await pool.query(
        `SELECT m.id FROM tournament_matches m JOIN tournament_rounds r ON m.round_id = r.id
         WHERE m.tournament_id = $1 AND r.round_number = $2 AND m.match_number = $3`,
        [tournamentId, roundNumber, matchNumber]
      );
      if (!mr.rows.length) return res.status(404).json({ error: 'Match not found' });
      matchId = mr.rows[0].id;
    }

    const playerCheck = await pool.query(
      'SELECT id FROM tournament_players WHERE tournament_id = $1 AND user_id = $2', [tournamentId, winnerId]
    );
    if (!playerCheck.rows.length) return res.status(400).json({ error: 'Player not in tournament' });
    const winnerDbId = playerCheck.rows[0].id;

    await pool.query(
      `UPDATE tournament_matches SET winner_id = $1, status = 'completed', completed_at = $2 WHERE id = $3`,
      [winnerDbId, new Date(), matchId]
    );

    try { await advanceWinner(tournamentId, matchId, winnerDbId); } catch(e) { console.error('Advance error:', e.message); }

    const updatedTour = await pool.query('SELECT status, winner_id FROM tournaments WHERE id = $1', [tournamentId]);
    const ts = updatedTour.rows[0];
    let winnerData = null;
    if (ts.status === 'completed' && ts.winner_id) {
      const wp = await pool.query(
        `SELECT tp.username, tp.user_id, u.avatar_url,
                u.tournament_card_image_url, u.tournament_card_bg_colour,
                u.tournament_card_border_colour, u.tournament_card_name_colour, u.tournament_card_bg_pos
         FROM tournament_players tp LEFT JOIN users u ON tp.user_id = u.id WHERE tp.id = $1`, [ts.winner_id]
      );
      if (wp.rows.length) {
        const w = wp.rows[0];
        winnerData = { username: w.username, userId: w.user_id, avatarUrl: w.avatar_url,
          tournamentCard: { imageUrl: w.tournament_card_image_url||null, bgColour: w.tournament_card_bg_colour||'#2c3440', borderColour: w.tournament_card_border_colour||'#f9a8d4', nameColour: w.tournament_card_name_colour||'#fdf2f8', bgPos: w.tournament_card_bg_pos||'50% 50%' }
        };
      }
    }
    res.json({ success: true, tournamentStatus: ts.status, winner: winnerData });
  } catch(error) {
    console.error('Set winner error:', error);
    res.status(500).json({ error: 'Failed to set winner' });
  }
});

// ============================================================
// UPDATE MATCH SCORE (host only)
// ============================================================
router.post('/:tournamentId/match-score', verifyAuth, async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const { matchId, player, score } = req.body;
    const tourResult = await pool.query('SELECT host_id FROM tournaments WHERE id = $1', [tournamentId]);
    if (!tourResult.rows.length) return res.status(404).json({ error: 'Not found' });
    if (tourResult.rows[0].host_id !== req.user.id) return res.status(403).json({ error: 'Only host can edit scores' });
    const field = player === 1 ? 'player1_score' : 'player2_score';
    await pool.query(`UPDATE tournament_matches SET ${field} = $1 WHERE id = $2`, [parseInt(score)||0, matchId]);
    res.json({ success: true });
  } catch(error) { res.status(500).json({ error: 'Failed to update score' }); }
});

// ============================================================
// CLOSE TOURNAMENT (host only)
// ============================================================
router.post('/:tournamentId/close', verifyAuth, async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const tourResult = await pool.query('SELECT * FROM tournaments WHERE id = $1', [tournamentId]);
    if (!tourResult.rows.length) return res.status(404).json({ error: 'Not found' });
    const tournament = tourResult.rows[0];
    if (tournament.host_id !== req.user.id) return res.status(403).json({ error: 'Only host can close' });
    if (tournament.status === 'completed') return res.status(400).json({ error: 'Already completed' });
    await pool.query(`UPDATE tournaments SET status = 'completed', end_time = $1 WHERE id = $2`, [new Date(), tournamentId]);
    res.json({ success: true });
  } catch(error) { res.status(500).json({ error: 'Failed to close tournament' }); }
});

// ============================================================
// DELETE TOURNAMENT (host only, completed only)
// ============================================================
router.delete('/:tournamentId', verifyAuth, async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const tourResult = await pool.query('SELECT * FROM tournaments WHERE id = $1', [tournamentId]);
    if (!tourResult.rows.length) return res.status(404).json({ error: 'Not found' });
    const tournament = tourResult.rows[0];
    if (tournament.host_id !== req.user.id) return res.status(403).json({ error: 'Only host can delete' });
    if (tournament.status !== 'completed') return res.status(400).json({ error: 'Only completed tournaments can be deleted' });
    await pool.query('DELETE FROM tournament_matches WHERE tournament_id = $1', [tournamentId]);
    await pool.query('DELETE FROM tournament_rounds WHERE tournament_id = $1', [tournamentId]);
    await pool.query('DELETE FROM tournament_players WHERE tournament_id = $1', [tournamentId]);
    await pool.query('DELETE FROM tournaments WHERE id = $1', [tournamentId]);
    res.json({ success: true });
  } catch(error) { res.status(500).json({ error: 'Failed to delete tournament' }); }
});

// ============================================================
// LOCK-IN
// ============================================================
router.post('/:tournamentId/lock-in', verifyAuth, async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const { matchId } = req.body;
    const userId = req.user.id;

    const matchResult = await pool.query(
      'SELECT id, locked_players, player1_id, player2_id FROM tournament_matches WHERE id = $1 AND tournament_id = $2',
      [matchId, tournamentId]
    );
    if (!matchResult.rows.length) return res.status(404).json({ error: 'Match not found' });
    const match = matchResult.rows[0];

    const playerCheck = await pool.query(
      `SELECT id FROM tournament_players WHERE tournament_id = $1 AND user_id = $2 AND id IN ($3, $4)`,
      [tournamentId, userId, match.player1_id || 0, match.player2_id || 0]
    );
    if (!playerCheck.rows.length) return res.status(403).json({ error: 'Not in this match' });

    const locked = match.locked_players || [];
    if (!locked.includes(userId)) locked.push(userId);
    await pool.query('UPDATE tournament_matches SET locked_players = $1 WHERE id = $2', [JSON.stringify(locked), matchId]);

    const p1 = await pool.query('SELECT user_id FROM tournament_players WHERE id = $1', [match.player1_id]);
    const p2 = await pool.query('SELECT user_id FROM tournament_players WHERE id = $1', [match.player2_id]);
    const p1uid = p1.rows[0]?.user_id;
    const p2uid = p2.rows[0]?.user_id;
    const bothLocked = p1uid && p2uid && locked.includes(p1uid) && locked.includes(p2uid);

    if (bothLocked) {
      await pool.query('UPDATE tournament_matches SET round_locked = TRUE WHERE id = $1', [matchId]);
    }

    res.json({ success: true, lockedPlayers: locked, bothLocked });
  } catch(err) {
    console.error('Lock-in error:', err);
    res.status(500).json({ error: 'Failed to lock in' });
  }
});

// ============================================================
// SCHEDULED TOURNAMENTS (for schedule checker)
// ============================================================
router.get('/scheduled/upcoming', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.id, t.name, t.scheduled_start, t.alert_before_minutes, t.lobby_id, t.host_id,
              ARRAY_AGG(tp.user_id) as player_user_ids
       FROM tournaments t LEFT JOIN tournament_players tp ON tp.tournament_id = t.id
       WHERE t.status = 'setup' AND t.scheduled_start IS NOT NULL AND t.scheduled_start > NOW()
       GROUP BY t.id`
    );
    res.json(result.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// SELF-REPORT: Submit result
// ============================================================
router.post('/:tournamentId/report-result', verifyAuth, async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const { matchId, myScore, opponentScore, screenshotUrl } = req.body;
    const userId = req.user.id;

    const tourResult = await pool.query('SELECT host_id, status, result_mode FROM tournaments WHERE id = $1', [tournamentId]);
    if (!tourResult.rows.length) return res.status(404).json({ error: 'Not found' });
    const t = tourResult.rows[0];
    if (t.status !== 'in-progress') return res.status(400).json({ error: 'Tournament not in progress' });
    if (t.result_mode !== 'self-report') return res.status(400).json({ error: 'Not a self-report tournament' });

    const matchResult = await pool.query(
      'SELECT id, player1_id, player2_id, p1_report, p2_report, status, round_locked FROM tournament_matches WHERE id = $1 AND tournament_id = $2',
      [matchId, tournamentId]
    );
    if (!matchResult.rows.length) return res.status(404).json({ error: 'Match not found' });
    const match = matchResult.rows[0];
    if (match.status === 'completed') return res.status(400).json({ error: 'Match already completed' });
    if (!match.round_locked) return res.status(400).json({ error: 'Both players must lock in first' });

    const p1Check = await pool.query('SELECT user_id FROM tournament_players WHERE id = $1', [match.player1_id]);
    const p2Check = await pool.query('SELECT user_id FROM tournament_players WHERE id = $1', [match.player2_id]);
    const isP1 = p1Check.rows[0]?.user_id === userId;
    const isP2 = p2Check.rows[0]?.user_id === userId;
    if (!isP1 && !isP2) return res.status(403).json({ error: 'Not in this match' });

    const reportField = isP1 ? 'p1_report' : 'p2_report';
    const report = { myScore: parseInt(myScore)||0, opponentScore: parseInt(opponentScore)||0, screenshotUrl: screenshotUrl||null, submittedAt: new Date().toISOString(), userId };
    await pool.query(`UPDATE tournament_matches SET ${reportField} = $1 WHERE id = $2`, [JSON.stringify(report), matchId]);

    const updatedMatch = await pool.query('SELECT p1_report, p2_report FROM tournament_matches WHERE id = $1', [matchId]);
    const p1r = updatedMatch.rows[0].p1_report;
    const p2r = updatedMatch.rows[0].p2_report;

    if (p1r && p2r) {
      const p1WinsByP1 = p1r.myScore > p1r.opponentScore;
      const p1WinsByP2 = p2r.opponentScore > p2r.myScore;
      const agree = p1WinsByP1 === p1WinsByP2;

      if (agree) {
        const winnerId = p1WinsByP1 ? match.player1_id : match.player2_id;
        await pool.query(
          `UPDATE tournament_matches SET winner_id = $1, status = 'completed', completed_at = NOW(),
           player1_score = $2, player2_score = $3, dispute_status = 'agreed' WHERE id = $4`,
          [winnerId, p1r.myScore, p1r.opponentScore, matchId]
        );
        try { await advanceWinner(tournamentId, matchId, winnerId); } catch(e) {}
        const winnerUserId = p1WinsByP1 ? p1Check.rows[0].user_id : p2Check.rows[0].user_id;
        return res.json({ status: 'agreed', autoAdvanced: true, winnerId: winnerUserId, matchId });
      } else {
        await pool.query(`UPDATE tournament_matches SET dispute_status = 'disputed' WHERE id = $1`, [matchId]);
        return res.json({ status: 'disputed', p1Report: p1r, p2Report: p2r });
      }
    }
    res.json({ status: 'submitted', waiting: true });
  } catch(err) {
    console.error('Report result error:', err);
    res.status(500).json({ error: 'Failed to submit result' });
  }
});

// ============================================================
// SELF-REPORT: Resolve dispute (host only)
// ============================================================
router.post('/:tournamentId/resolve-dispute', verifyAuth, async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const { matchId, winnerId, p1Score, p2Score } = req.body;

    const tourResult = await pool.query('SELECT host_id FROM tournaments WHERE id = $1', [tournamentId]);
    if (!tourResult.rows.length) return res.status(404).json({ error: 'Not found' });
    if (tourResult.rows[0].host_id !== req.user.id) return res.status(403).json({ error: 'Only host can resolve' });

    const playerResult = await pool.query(
      'SELECT id FROM tournament_players WHERE tournament_id = $1 AND user_id = $2', [tournamentId, winnerId]
    );
    if (!playerResult.rows.length) return res.status(400).json({ error: 'Winner not found' });
    const winnerDbId = playerResult.rows[0].id;

    await pool.query(
      `UPDATE tournament_matches SET winner_id = $1, status = 'completed', completed_at = NOW(),
       player1_score = $2, player2_score = $3, dispute_status = 'resolved', dispute_resolved_by = $4
       WHERE id = $5`,
      [winnerDbId, parseInt(p1Score)||0, parseInt(p2Score)||0, req.user.id, matchId]
    );
    try { await advanceWinner(tournamentId, matchId, winnerDbId); } catch(e) {}
    res.json({ success: true, winnerDbId, matchId });
  } catch(err) {
    console.error('Resolve dispute error:', err);
    res.status(500).json({ error: 'Failed to resolve dispute' });
  }
});

// ============================================================
// SELF-REPORT: Confirm result (opponent confirms)
// ============================================================
router.post('/:tournamentId/confirm-result', verifyAuth, async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const { matchId, action } = req.body;

    const matchResult = await pool.query(
      'SELECT id, player1_id, player2_id, p1_report, p2_report, dispute_status FROM tournament_matches WHERE id = $1 AND tournament_id = $2',
      [matchId, tournamentId]
    );
    if (!matchResult.rows.length) return res.status(404).json({ error: 'Match not found' });

    if (action === 'dispute') {
      await pool.query(`UPDATE tournament_matches SET dispute_status = 'disputed' WHERE id = $1`, [matchId]);
      const tourResult = await pool.query('SELECT host_id FROM tournaments WHERE id = $1', [tournamentId]);
      return res.json({ status: 'disputed', hostId: tourResult.rows[0]?.host_id });
    }
    res.json({ status: 'confirmed' });
  } catch(err) {
    res.status(500).json({ error: 'Failed to confirm result' });
  }
});

// ============================================================
// API POLL — auto-pull result from Riot / Chess.com / Lichess
// Saves game_url to match for live embed support
// ============================================================
router.post('/:tournamentId/api-poll', verifyAuth, async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const { matchId } = req.body;
    const axios = require('axios');

    const tourResult = await pool.query('SELECT result_mode, api_game, host_id FROM tournaments WHERE id = $1', [tournamentId]);
    if (!tourResult.rows.length) return res.status(404).json({ error: 'Not found' });
    const t = tourResult.rows[0];
    if (!['riot-api','chess-api'].includes(t.result_mode)) return res.status(400).json({ error: 'Not in API mode' });

    const matchResult = await pool.query(
      'SELECT id, player1_id, player2_id, status FROM tournament_matches WHERE id = $1 AND tournament_id = $2',
      [matchId, tournamentId]
    );
    if (!matchResult.rows.length) return res.status(404).json({ error: 'Match not found' });
    const match = matchResult.rows[0];
    if (match.status === 'completed') return res.json({ status: 'already_completed' });

    const p1 = await pool.query('SELECT user_id FROM tournament_players WHERE id = $1', [match.player1_id]);
    const p2 = await pool.query('SELECT user_id FROM tournament_players WHERE id = $1', [match.player2_id]);
    if (!p1.rows.length || !p2.rows.length) return res.status(400).json({ error: 'Players not found' });
    const p1uid = p1.rows[0].user_id;
    const p2uid = p2.rows[0].user_id;

    let winnerUserId = null;
    let gameUrl = null;

    // ── RIOT API ─────────────────────────────────────────────
    if (t.result_mode === 'riot-api') {
      const RIOT_API_KEY = process.env.RIOT_API_KEY;
      if (!RIOT_API_KEY) return res.status(503).json({ error: 'Riot API key not configured' });
      const game = t.api_game || 'lol';
      const REGIONAL = 'europe';

      const usersResult = await pool.query('SELECT id, riot_puuid FROM users WHERE id = ANY($1)', [[p1uid, p2uid]]);
      const um = {};
      usersResult.rows.forEach(u => { um[u.id] = u.riot_puuid; });
      if (!um[p1uid] || !um[p2uid]) return res.json({ status: 'not_found', reason: 'One or both players have not linked their Riot account.' });

      const puuid1 = um[p1uid], puuid2 = um[p2uid];
      const baseUrl = game === 'valorant'
        ? `https://${REGIONAL}.api.riotgames.com/val/match/v1/matchlists/by-puuid/${puuid1}`
        : `https://${REGIONAL}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid1}/ids?count=10`;
      const mlResp = await axios.get(baseUrl, { headers: { 'X-Riot-Token': RIOT_API_KEY } });
      const matchIds = Array.isArray(mlResp.data) ? mlResp.data : (mlResp.data?.history?.map(h => h.matchId) || []);

      let foundWinnerPuuid = null;
      for (const riotMatchId of matchIds.slice(0, 10)) {
        const detailUrl = game === 'valorant'
          ? `https://${REGIONAL}.api.riotgames.com/val/match/v1/matches/${riotMatchId}`
          : `https://${REGIONAL}.api.riotgames.com/lol/match/v5/matches/${riotMatchId}`;
        const detail = (await axios.get(detailUrl, { headers: { 'X-Riot-Token': RIOT_API_KEY } })).data;
        const participants = detail.info?.participants || detail.players?.all_players || [];
        const puuids = participants.map(p => p.puuid);
        if (puuids.includes(puuid1) && puuids.includes(puuid2)) {
          if (game === 'tft') {
            const pp1 = participants.find(p => p.puuid === puuid1);
            const pp2 = participants.find(p => p.puuid === puuid2);
            foundWinnerPuuid = (pp1?.placement||99) < (pp2?.placement||99) ? puuid1 : puuid2;
          } else if (game === 'valorant') {
            const pp1 = participants.find(p => p.puuid === puuid1);
            foundWinnerPuuid = detail.teams?.[pp1?.team_id?.toLowerCase()]?.won ? puuid1 : puuid2;
          } else {
            const pp1 = participants.find(p => p.puuid === puuid1);
            foundWinnerPuuid = pp1?.win ? puuid1 : puuid2;
          }
          break;
        }
      }
      if (!foundWinnerPuuid) return res.json({ status: 'not_found', reason: 'No recent shared match found.' });
      winnerUserId = foundWinnerPuuid === puuid1 ? p1uid : p2uid;
    }

    // ── CHESS API ─────────────────────────────────────────────
    if (t.result_mode === 'chess-api') {
      const platform = t.api_game || 'chess.com';
      const col = platform === 'lichess' ? 'lichess_username' : 'chess_username';
      const usersResult = await pool.query(`SELECT id, ${col} AS chess_user FROM users WHERE id = ANY($1)`, [[p1uid, p2uid]]);
      const um = {};
      usersResult.rows.forEach(u => { um[u.id] = u.chess_user; });
      const cu1 = um[p1uid], cu2 = um[p2uid];
      if (!cu1 || !cu2) return res.json({ status: 'not_found', reason: `One or both players have not set their ${platform} username.` });

      let winnerChessUser = null;

      if (platform === 'lichess') {
        const resp = await axios.get(
          `https://lichess.org/api/games/user/${cu1.toLowerCase()}?opponent=${cu2.toLowerCase()}&max=1`,
          { headers: { 'Accept': 'application/x-ndjson' } }
        );
        const lines = (resp.data || '').trim().split('\n').filter(Boolean);
        if (lines.length) {
          const game = JSON.parse(lines[0]);
          const winner = game.winner;
          if (winner) {
            const whiteUser = game.players?.white?.user?.name?.toLowerCase();
            winnerChessUser = winner === 'white'
              ? (whiteUser === cu1.toLowerCase() ? cu1 : cu2)
              : (whiteUser === cu1.toLowerCase() ? cu2 : cu1);
            // Build Lichess game URL for live embed
            gameUrl = `https://lichess.org/${game.id}`;
          }
        }
      } else {
        const today = new Date();
        const url = `https://api.chess.com/pub/player/${cu1.toLowerCase()}/games/${today.getFullYear()}/${String(today.getMonth()+1).padStart(2,'0')}`;
        const resp = await axios.get(url, { headers: { 'User-Agent': 'LOBBY-App/1.0' } });
        const games = resp.data.games || [];
        const u1l = cu1.toLowerCase(), u2l = cu2.toLowerCase();
        const relevant = games.filter(g => {
          const w = g.white?.username?.toLowerCase(), b = g.black?.username?.toLowerCase();
          return (w === u1l && b === u2l) || (w === u2l && b === u1l);
        });
        if (relevant.length) {
          const latest = relevant[relevant.length - 1];
          if (latest.white?.result === 'win') winnerChessUser = latest.white.username;
          else if (latest.black?.result === 'win') winnerChessUser = latest.black.username;
          // Chess.com game URL
          if (latest.url) gameUrl = latest.url;
        }
      }

      if (!winnerChessUser) return res.json({ status: 'not_found', reason: 'No recent game found between these two players.' });
      winnerUserId = winnerChessUser.toLowerCase() === cu1.toLowerCase() ? p1uid : p2uid;
    }

    if (!winnerUserId) return res.json({ status: 'not_found' });

    // ── Auto-advance ─────────────────────────────────────────
    const wpResult = await pool.query(
      'SELECT id FROM tournament_players WHERE tournament_id = $1 AND user_id = $2', [tournamentId, winnerUserId]
    );
    if (!wpResult.rows.length) return res.status(400).json({ error: 'Winner not in tournament' });
    const winnerDbId = wpResult.rows[0].id;

    await pool.query(
      `UPDATE tournament_matches SET winner_id = $1, status = 'completed', completed_at = NOW(),
       dispute_status = 'api-resolved', game_url = $2 WHERE id = $3`,
      [winnerDbId, gameUrl, matchId]
    );

    try { await advanceWinner(tournamentId, matchId, winnerDbId); } catch(e) { console.error('Advance error:', e.message); }

    return res.json({ status: 'found', autoAdvanced: true, winnerId: winnerUserId, matchId, gameUrl });

  } catch(err) {
    console.error('API poll error:', err.message);
    return res.status(500).json({ status: 'error', error: err.message });
  }
});

// ============================================================
// DISPUTE TIMEOUT CHECK — self-report mode
// ============================================================
router.post('/:tournamentId/check-timeout', verifyAuth, async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const { matchId } = req.body;

    const tourResult = await pool.query('SELECT host_id, result_mode, dispute_timeout FROM tournaments WHERE id = $1', [tournamentId]);
    if (!tourResult.rows.length) return res.status(404).json({ error: 'Not found' });
    const t = tourResult.rows[0];
    if (t.result_mode !== 'self-report') return res.json({ timedOut: false });

    const matchResult = await pool.query(
      'SELECT p1_report, p2_report, status, dispute_status FROM tournament_matches WHERE id = $1 AND tournament_id = $2',
      [matchId, tournamentId]
    );
    if (!matchResult.rows.length) return res.status(404).json({ error: 'Match not found' });
    const m = matchResult.rows[0];
    if (m.status === 'completed') return res.json({ timedOut: false, reason: 'completed' });
    if (m.dispute_status) return res.json({ timedOut: false, reason: 'already_flagged' });

    const timeoutMs = (t.dispute_timeout || 30) * 60 * 1000;
    const now = Date.now();
    const p1r = m.p1_report, p2r = m.p2_report;

    const checkTimeout = async (submittedAt) => {
      if (now - new Date(submittedAt).getTime() > timeoutMs) {
        await pool.query(`UPDATE tournament_matches SET dispute_status = 'timeout' WHERE id = $1`, [matchId]);
        return true;
      }
      return false;
    };

    if (p1r && !p2r && await checkTimeout(p1r.submittedAt)) return res.json({ timedOut: true, hostId: t.host_id, reason: 'p2_no_response' });
    if (p2r && !p1r && await checkTimeout(p2r.submittedAt)) return res.json({ timedOut: true, hostId: t.host_id, reason: 'p1_no_response' });

    res.json({ timedOut: false });
  } catch(err) {
    res.status(500).json({ error: 'Failed to check timeout' });
  }
});

module.exports = router;