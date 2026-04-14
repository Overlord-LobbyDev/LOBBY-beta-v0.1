// routes/tournaments.js - ENHANCED VERSION WITH SCORING, CLOSURE, AND AUTO-HOST REGISTRATION
// FIXED VERSION — PostgreSQL syntax
const express = require('express');
const router = express.Router();

// ── Inline DB pool (no dependency on db.js) ──────────────────
const { Pool } = require('pg');
let pool;
if (process.env.DATABASE_URL) {
  const url = require('url');
  const dbUrl = url.parse(process.env.DATABASE_URL);
  const [dbUser, dbPass] = (dbUrl.auth || ':').split(':');
  pool = new Pool({ user: dbUser, password: dbPass, host: dbUrl.hostname, port: dbUrl.port || 5432, database: dbUrl.pathname.slice(1), ssl: { rejectUnauthorized: false } });
} else {
  pool = new Pool({ host: process.env.PG_HOST || 'localhost', port: process.env.PG_PORT || 5432, database: process.env.PG_DB || 'lobby', user: process.env.PG_USER || 'postgres', password: process.env.PG_PASSWORD, ssl: false });
}

// ── Ensure required columns exist ────────────────────────────
(async () => {
  const migrations = [
    "ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS winner_id INTEGER REFERENCES tournament_players(id) ON DELETE SET NULL",
    "ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS has_losers_bracket BOOLEAN DEFAULT FALSE",
    "ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS has_points_tally BOOLEAN DEFAULT TRUE",
    "ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS scheduled_start TIMESTAMPTZ DEFAULT NULL",
    "ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS alert_before_minutes INTEGER DEFAULT 15",
    "ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS locked_players JSONB DEFAULT '[]'",
    "ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS round_locked BOOLEAN DEFAULT FALSE",
    "ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS player1_score INTEGER DEFAULT 0",
    "ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS player2_score INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS tournament_card_image_url TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS tournament_card_bg_colour TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS tournament_card_border_colour TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS tournament_card_name_colour TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS tournament_card_bg_pos TEXT DEFAULT NULL",
  ];
  for (const sql of migrations) {
    try { await pool.query(sql); } catch(e) { /* column may already exist */ }
  }
  console.log('[✓] Tournament columns verified');
})();

// Auth middleware - expects req.user to be set by your auth system
function verifyAuth(req, res, next) {
  if (!req.user || !req.user.id) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ============================================================
// CREATE TOURNAMENT (FIXED: Auto-register host)
// ============================================================
router.post('/create', verifyAuth, async (req, res) => {
  try {
    const { lobbyId, name, description, format, playerCount, rules, prize, startTime, hasLosersBracket, hasPointsTally, scheduledStart, alertBeforeMinutes } = req.body;
    
    // Validate input
    if (!lobbyId || !name || !format || !playerCount) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const validFormats = ['single', 'double', 'round-robin'];
    const validPlayerCounts = [4, 8, 16, 32, 64, 128];
    
    if (!validFormats.includes(format)) {
      return res.status(400).json({ error: 'Invalid tournament format' });
    }
    
    if (!validPlayerCounts.includes(playerCount)) {
      return res.status(400).json({ error: 'Invalid player count' });
    }
    
    const result = await pool.query(
      `INSERT INTO tournaments 
        (lobby_id, host_id, name, description, format, player_count, 
         max_players, status, rules, prize, start_time, has_losers_bracket, has_points_tally,
         scheduled_start, alert_before_minutes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING *`,
      [
        lobbyId,
        req.user.id,
        name,
        description || null,
        format,
        playerCount,
        playerCount,
        'setup',
        rules || null,
        prize || null,
        startTime ? new Date(startTime) : null,
        hasLosersBracket ? true : false,
        hasPointsTally !== false,
        scheduledStart ? new Date(scheduledStart) : null,
        alertBeforeMinutes ? parseInt(alertBeforeMinutes) : 15
      ]
    );
    
    const tournament = result.rows[0];
    
    // AUTO-REGISTER THE HOST AS A PLAYER
    await pool.query(
      `INSERT INTO tournament_players (tournament_id, user_id, username, joined_at, status)
       VALUES ($1, $2, $3, $4, $5)`,
      [tournament.id, req.user.id, req.user.username, new Date(), 'registered']
    );
    
    // Convert database format to JSON format for frontend
    const responseData = {
      id: tournament.id,
      lobbyId: tournament.lobby_id,
      hostId: tournament.host_id,
      name: tournament.name,
      description: tournament.description,
      format: tournament.format,
      playerCount: tournament.player_count,
      registeredPlayers: [{
        userId: req.user.id,
        username: req.user.username,
        joinedAt: new Date(),
        status: 'registered'
      }],
      bracket: { rounds: [] },
      status: tournament.status,
      createdAt: tournament.created_at,
      startTime: tournament.start_time,
      endTime: tournament.end_time,
      rules: tournament.rules,
      prize: tournament.prize
    };
    
    res.status(201).json({
      success: true,
      tournament: responseData
    });
  } catch (error) {
    console.error('Tournament creation error:', error);
    res.status(500).json({ error: 'Failed to create tournament' });
  }
});

// ============================================================
// GET TOURNAMENTS FOR A LOBBY
// ============================================================
router.get('/lobby/:lobbyId', async (req, res) => {
  try {
    const { lobbyId } = req.params;
    
    const result = await pool.query(
      'SELECT * FROM tournaments WHERE lobby_id = $1 ORDER BY created_at DESC',
      [lobbyId]
    );
    
    const tournaments = await Promise.all(
      result.rows.map(async (tournament) => {
        // Get registered players WITH avatars
        const playersResult = await pool.query(
          `SELECT tp.user_id, tp.username, tp.joined_at, tp.status,
                  u.avatar_url,
                  u.tournament_card_image_url,
                  u.tournament_card_bg_colour,
                  u.tournament_card_border_colour,
                  u.tournament_card_name_colour,
                  u.tournament_card_bg_pos
           FROM tournament_players tp
           LEFT JOIN users u ON tp.user_id = u.id
           WHERE tp.tournament_id = $1`,
          [tournament.id]
        );
        
        const registeredPlayers = playersResult.rows.map(p => ({
          userId: p.user_id,
          username: p.username,
          joinedAt: p.joined_at,
          status: p.status,
          avatar_url: p.avatar_url,
          tournamentCard: {
            imageUrl:      p.tournament_card_image_url     || null,
            bgColour:      p.tournament_card_bg_colour     || '#2c3440',
            borderColour:  p.tournament_card_border_colour || '#f9a8d4',
            nameColour:    p.tournament_card_name_colour   || '#fdf2f8',
            bgPos:         p.tournament_card_bg_pos        || '50% 50%',
          }
        }));
        
        return {
          id: tournament.id,
          lobbyId: tournament.lobby_id,
          hostId: tournament.host_id,
          name: tournament.name,
          description: tournament.description,
          format: tournament.format,
          playerCount: tournament.player_count,
          registeredPlayers,
          status: tournament.status,
          createdAt: tournament.created_at,
          startTime: tournament.start_time,
          scheduledStart: tournament.scheduled_start || null,
          alertBeforeMinutes: tournament.alert_before_minutes || 15,
          hasLosersBracket: tournament.has_losers_bracket || false,
          hasPointsTally: tournament.has_points_tally !== false
        };
      })
    );
    
    res.json(tournaments);
  } catch (error) {
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
    
    // Get tournament
    const tourResult = await pool.query(
      'SELECT * FROM tournaments WHERE id = $1',
      [tournamentId]
    );
    
    if (tourResult.rows.length === 0) {
      return res.status(404).json({ error: 'Tournament not found' });
    }
    
    const tournament = tourResult.rows[0];
    
    // Get registered players WITH AVATARS
    const playersResult = await pool.query(
      `SELECT tp.user_id, tp.username, tp.joined_at, tp.status,
              u.avatar_url,
              u.tournament_card_image_url,
              u.tournament_card_bg_colour,
              u.tournament_card_border_colour,
              u.tournament_card_name_colour,
              u.tournament_card_bg_pos
       FROM tournament_players tp
       LEFT JOIN users u ON tp.user_id = u.id
       WHERE tp.tournament_id = $1`,
      [tournamentId]
    );
    
    const registeredPlayers = playersResult.rows.map(p => ({
      userId: p.user_id,
      username: p.username,
      joinedAt: p.joined_at,
      status: p.status,
      avatar_url: p.avatar_url,
      tournamentCard: {
        imageUrl:      p.tournament_card_image_url     || null,
        bgColour:      p.tournament_card_bg_colour     || '#2c3440',
        borderColour:  p.tournament_card_border_colour || '#f9a8d4',
        nameColour:    p.tournament_card_name_colour   || '#fdf2f8',
        bgPos:         p.tournament_card_bg_pos        || '50% 50%',
      }
    }));
    
    // Get bracket data
    const bracket = await getBracketData(tournamentId);
    
    const responseData = {
      id: tournament.id,
      lobbyId: tournament.lobby_id,
      hostId: tournament.host_id,
      name: tournament.name,
      description: tournament.description,
      format: tournament.format,
      playerCount: tournament.player_count,
      registeredPlayers,
      bracket,
      hasLosersBracket: tournament.has_losers_bracket || false,
      hasPointsTally: tournament.has_points_tally !== false,
      status: tournament.status,
      createdAt: tournament.created_at,
      startTime: tournament.start_time,
      endTime: tournament.end_time,
      rules: tournament.rules,
      prize: tournament.prize,
      winnerId: null,
      scheduledStart: tournament.scheduled_start || null,
      alertBeforeMinutes: tournament.alert_before_minutes || 15
    };

    // Resolve winner_id (tournament_players.id) → user_id
    if (tournament.winner_id) {
      const winnerRow = await pool.query(
        'SELECT user_id FROM tournament_players WHERE id = $1', [tournament.winner_id]
      );
      if (winnerRow.rows.length > 0) responseData.winnerId = winnerRow.rows[0].user_id;
    }
    
    res.json(responseData);
  } catch (error) {
    console.error('Get tournament error:', error);
    res.status(500).json({ error: 'Failed to fetch tournament' });
  }
});

// ============================================================
// GET USER PROFILE (for profile pictures)
// ============================================================
router.get('/users/:userId/profile', verifyAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    
    const result = await pool.query(
      'SELECT id, username, profile_picture FROM users WHERE id = $1',
      [userId]
    );
    
    if (result.rows.length === 0) {
      return res.json({
        userId,
        username: 'Unknown',
        profilePicture: null
      });
    }
    
    const user = result.rows[0];
    res.json({
      userId: user.id,
      username: user.username,
      profilePicture: user.profile_picture
    });
  } catch (error) {
    console.error('Get user profile error:', error);
    res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});

// ============================================================
// REGISTER PLAYER FOR TOURNAMENT
// ============================================================
router.post('/:tournamentId/register', verifyAuth, async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const userId = req.user.id;
    const username = req.user.username;
    
    // Get tournament
    const tourResult = await pool.query(
      'SELECT * FROM tournaments WHERE id = $1',
      [tournamentId]
    );
    
    if (tourResult.rows.length === 0) {
      return res.status(404).json({ error: 'Tournament not found' });
    }
    
    const tournament = tourResult.rows[0];
    
    // Check if already registered
    const existingResult = await pool.query(
      'SELECT id FROM tournament_players WHERE tournament_id = $1 AND user_id = $2',
      [tournamentId, userId]
    );
    
    if (existingResult.rows.length > 0) {
      return res.status(400).json({ error: 'Already registered' });
    }
    
    // Check if tournament is full
    const countResult = await pool.query(
      'SELECT COUNT(*) as count FROM tournament_players WHERE tournament_id = $1',
      [tournamentId]
    );
    
    const currentCount = parseInt(countResult.rows[0].count);
    if (currentCount >= tournament.max_players) {
      return res.status(400).json({ error: 'Tournament is full' });
    }
    
    // Register player
    await pool.query(
      `INSERT INTO tournament_players (tournament_id, user_id, username, joined_at, status)
       VALUES ($1, $2, $3, $4, $5)`,
      [tournamentId, userId, username, new Date(), 'registered']
    );
    
    res.json({ success: true, message: 'Registered for tournament' });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Failed to register' });
  }
});

// ============================================================
// LEAVE TOURNAMENT
// ============================================================
router.post('/:tournamentId/leave', verifyAuth, async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const userId = req.user.id;

    // Get tournament
    const tourResult = await pool.query(
      'SELECT * FROM tournaments WHERE id = $1',
      [tournamentId]
    );

    if (tourResult.rows.length === 0) {
      return res.status(404).json({ error: 'Tournament not found' });
    }

    const tournament = tourResult.rows[0];

    // Cannot leave once tournament has started
    if (tournament.status !== 'setup') {
      return res.status(400).json({ error: 'Cannot leave a tournament that has already started' });
    }

    // Host cannot leave their own tournament
    if (tournament.host_id === userId) {
      return res.status(400).json({ error: 'Host cannot leave their own tournament. End the tournament instead.' });
    }

    // Check if registered
    const existing = await pool.query(
      'SELECT id FROM tournament_players WHERE tournament_id = $1 AND user_id = $2',
      [tournamentId, userId]
    );

    if (existing.rows.length === 0) {
      return res.status(400).json({ error: 'You are not registered in this tournament' });
    }

    // Remove player
    await pool.query(
      'DELETE FROM tournament_players WHERE tournament_id = $1 AND user_id = $2',
      [tournamentId, userId]
    );

    res.json({ success: true, message: 'Left tournament successfully' });
  } catch (error) {
    console.error('Leave tournament error:', error);
    res.status(500).json({ error: 'Failed to leave tournament' });
  }
});

// ============================================================
// GENERATE BRACKET
// ============================================================
router.post('/:tournamentId/generate-bracket', verifyAuth, async (req, res) => {
  try {
    const { tournamentId } = req.params;
    
    // Get tournament
    const tourResult = await pool.query(
      'SELECT * FROM tournaments WHERE id = $1',
      [tournamentId]
    );
    
    if (tourResult.rows.length === 0) {
      return res.status(404).json({ error: 'Tournament not found' });
    }
    
    const tournament = tourResult.rows[0];
    
    // Check if user is host
    if (tournament.host_id !== req.user.id) {
      return res.status(403).json({ error: 'Only host can generate bracket' });
    }
    
    // Get registered players
    const playersResult = await pool.query(
      'SELECT id as tournament_player_id, user_id, username FROM tournament_players WHERE tournament_id = $1',
      [tournamentId]
    );
    
    const players = playersResult.rows;
    
    // Shuffle players
    const shuffled = [...players].sort(() => Math.random() - 0.5);

    // Round up to nearest power of 2 for bracket size
    const numPlayers = shuffled.length;
    const slots = Math.pow(2, Math.ceil(Math.log2(Math.max(numPlayers, 2))));
    const numRounds = Math.log2(slots);  // always an integer

    // Delete existing rounds/matches
    await pool.query('DELETE FROM tournament_rounds WHERE tournament_id = $1', [tournamentId]);

    // ── Step 1: Create all rounds and empty matches upfront ──
    const roundIds = {};
    for (let r = 1; r <= numRounds; r++) {
      const rResult = await pool.query(
        `INSERT INTO tournament_rounds (tournament_id, round_number) VALUES ($1, $2) RETURNING id`,
        [tournamentId, r]
      );
      roundIds[r] = rResult.rows[0].id;
      const matchCount = slots / Math.pow(2, r);
      for (let m = 0; m < matchCount; m++) {
        const p1 = (r === 1) ? (shuffled[m * 2]?.tournament_player_id || null) : null;
        const p2 = (r === 1) ? (shuffled[m * 2 + 1]?.tournament_player_id || null) : null;
        await pool.query(
          `INSERT INTO tournament_matches (round_id, tournament_id, match_number, player1_id, player2_id, status)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [roundIds[r], tournamentId, m, p1, p2, 'pending']
        );
      }
    }

    // ── Step 2: Cascade byes across ALL rounds iteratively ──────
    // Loop until no more changes — handles cascading byes at any depth
    let changed = true;
    while (changed) {
      changed = false;
      for (let r = 1; r < numRounds; r++) {
        const byeResult = await pool.query(
          `SELECT m.id, m.match_number, m.player1_id, m.player2_id
           FROM tournament_matches m
           JOIN tournament_rounds tr ON m.round_id = tr.id
           WHERE tr.tournament_id = $1 AND tr.round_number = $2
             AND m.status != 'bye'
             AND (m.player1_id IS NULL OR m.player2_id IS NULL)`,
          [tournamentId, r]
        );

        for (const match of byeResult.rows) {
          const p1 = match.player1_id, p2 = match.player2_id;
          changed = true;

          if (!p1 && !p2) {
            // Double-bye: mark skipped, nothing to advance
            await pool.query(
              `UPDATE tournament_matches SET status = 'bye' WHERE id = $1`, [match.id]
            );
          } else {
            // Single-bye: advance the one player automatically
            const winner = p1 || p2;
            await pool.query(
              `UPDATE tournament_matches SET winner_id = $1, status = 'bye' WHERE id = $2`,
              [winner, match.id]
            );
            const nextMatchNum = Math.floor(match.match_number / 2);
            const slot = match.match_number % 2 === 0 ? 'player1_id' : 'player2_id';
            await pool.query(
              `UPDATE tournament_matches SET ${slot} = $1
               WHERE round_id = $2 AND match_number = $3`,
              [winner, roundIds[r + 1], nextMatchNum]
            );
          }
        }
      }
    }

    // Update tournament status
    await pool.query(
      `UPDATE tournaments 
       SET status = $1, start_time = $2
       WHERE id = $3`,
      ['in-progress', new Date(), tournamentId]
    );
    
    // Get the generated bracket
    const bracket = await getBracketData(tournamentId);
    
    res.json({ success: true, bracket });
  } catch (error) {
    console.error('Bracket generation error:', error);
    res.status(500).json({ error: 'Failed to generate bracket' });
  }
});

// ============================================================
// SET MATCH WINNER (ENHANCED - SCORES + WINNER)
// ============================================================
router.post('/:tournamentId/set-winner', verifyAuth, async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const { roundNumber, matchNumber, winnerId, matchId: directMatchId } = req.body;
    
    // Get tournament
    const tourResult = await pool.query(
      'SELECT * FROM tournaments WHERE id = $1',
      [tournamentId]
    );
    
    if (tourResult.rows.length === 0) {
      return res.status(404).json({ error: 'Tournament not found' });
    }
    
    const tournament = tourResult.rows[0];
    
    // Check if user is host (HOST ONLY)
    if (tournament.host_id !== req.user.id) {
      return res.status(403).json({ error: 'Only host can set winners' });
    }
    
    // Get the match — accept direct matchId or lookup by round/match number
    let matchId;
    if (directMatchId) {
      matchId = directMatchId;
    } else {
      const matchResult = await pool.query(
        `SELECT m.id FROM tournament_matches m
         JOIN tournament_rounds r ON m.round_id = r.id
         WHERE m.tournament_id = $1 AND r.round_number = $2 AND m.match_number = $3`,
        [tournamentId, roundNumber, matchNumber]
      );
      if (matchResult.rows.length === 0) {
        return res.status(404).json({ error: 'Match not found' });
      }
      matchId = matchResult.rows[0].id;
    }
    
    // Look up tournament_players.id from user_id
    let winnerDbId = null;
    if (winnerId) {
      const playerCheck = await pool.query(
        `SELECT id FROM tournament_players WHERE tournament_id = $1 AND user_id = $2`,
        [tournamentId, winnerId]
      );
      if (playerCheck.rows.length === 0) {
        return res.status(400).json({ error: 'Player not found in this tournament' });
      }
      winnerDbId = playerCheck.rows[0].id;
    } else {
      return res.status(400).json({ error: 'Winner ID required' });
    }
    
    // Update match with winner
    await pool.query(
      `UPDATE tournament_matches 
       SET winner_id = $1, status = $2, completed_at = $3
       WHERE id = $4`,
      [winnerDbId, 'completed', new Date(), matchId]
    );

    // ── Advance winner to next round ──────────────────────────
    try {
      // Get current match info: round, match_number, player slots
      const curMatch = await pool.query(
        `SELECT m.match_number, m.player1_id, m.player2_id, r.round_number, r.tournament_id
         FROM tournament_matches m
         JOIN tournament_rounds r ON m.round_id = r.id
         WHERE m.id = $1`,
        [matchId]
      );
      console.log('[advance] curMatch rows:', curMatch.rows.length, curMatch.rows[0] || '');

      if (curMatch.rows.length > 0) {
        const { match_number, round_number } = curMatch.rows[0];

        // Find next round
        console.log('[advance] looking for round', round_number + 1, 'in tournament', tournamentId);
        const nextRound = await pool.query(
          `SELECT r.id FROM tournament_rounds r
           WHERE r.tournament_id = $1 AND r.round_number = $2`,
          [tournamentId, round_number + 1]
        );
        console.log('[advance] nextRound rows:', nextRound.rows.length);

        if (nextRound.rows.length > 0) {
          const nextRoundId = nextRound.rows[0].id;
          const nextMatchNumber = Math.floor(match_number / 2);
          const slot = match_number % 2 === 0 ? 'player1_id' : 'player2_id';

          // Use UPDATE directly — no need to SELECT first
          const updateResult = await pool.query(
            `UPDATE tournament_matches SET ${slot} = $1
             WHERE round_id = $2 AND match_number = $3`,
            [winnerDbId, nextRoundId, nextMatchNumber]
          );
          console.log('[advance] advanced to round', round_number + 1, 'match', nextMatchNumber, 'slot', slot, '— rows updated:', updateResult.rowCount);
        } else {
          // No next round — this is the final round. Tournament complete.
          await pool.query(
            `UPDATE tournaments SET status = 'completed', winner_id = $1 WHERE id = $2`,
            [winnerDbId, tournamentId]
          );
          console.log('[advance] Tournament', tournamentId, 'completed. Winner db id:', winnerDbId);
        }
      }
    } catch (advanceErr) {
      console.error('Advance winner error (non-fatal):', advanceErr.message);
    }

    // Return updated tournament data so frontend can check for winner
    const updatedTour = await pool.query('SELECT status, winner_id FROM tournaments WHERE id = $1', [tournamentId]);
    const tourStatus = updatedTour.rows[0];

    // Get winner username if tournament just completed
    let winnerData = null;
    if (tourStatus.status === 'completed' && tourStatus.winner_id) {
      const winnerPlayer = await pool.query(
        `SELECT tp.username, tp.user_id, u.avatar_url,
                u.tournament_card_image_url, u.tournament_card_bg_colour,
                u.tournament_card_border_colour, u.tournament_card_name_colour,
                u.tournament_card_bg_pos
         FROM tournament_players tp
         LEFT JOIN users u ON tp.user_id = u.id
         WHERE tp.id = $1`,
        [tourStatus.winner_id]
      );
      if (winnerPlayer.rows.length > 0) {
        const w = winnerPlayer.rows[0];
        winnerData = {
          username: w.username,
          userId: w.user_id,
          avatarUrl: w.avatar_url,
          tournamentCard: {
            imageUrl: w.tournament_card_image_url || null,
            bgColour: w.tournament_card_bg_colour || '#2c3440',
            borderColour: w.tournament_card_border_colour || '#f9a8d4',
            nameColour: w.tournament_card_name_colour || '#fdf2f8',
            bgPos: w.tournament_card_bg_pos || '50% 50%',
          }
        };
      }
    }

    res.json({ success: true, message: 'Winner set successfully', tournamentStatus: tourStatus.status, winner: winnerData });
  } catch (error) {
    console.error('Set winner error:', error);
    res.status(500).json({ error: 'Failed to set winner' });
  }
});

// ============================================================
// CLOSE/END TOURNAMENT (HOST ONLY)
// ============================================================
router.post('/:tournamentId/close', verifyAuth, async (req, res) => {
  try {
    const { tournamentId } = req.params;
    
    // Get tournament
    const tourResult = await pool.query(
      'SELECT * FROM tournaments WHERE id = $1',
      [tournamentId]
    );
    
    if (tourResult.rows.length === 0) {
      return res.status(404).json({ error: 'Tournament not found' });
    }
    
    const tournament = tourResult.rows[0];
    
    // Check if user is host (HOST ONLY)
    if (tournament.host_id !== req.user.id) {
      return res.status(403).json({ error: 'Only host can close tournaments' });
    }
    
    // Check if already completed
    if (tournament.status === 'completed') {
      return res.status(400).json({ error: 'Tournament is already completed' });
    }
    
    // Update tournament status to completed
    const result = await pool.query(
      `UPDATE tournaments 
       SET status = $1, end_time = $2
       WHERE id = $3
       RETURNING *`,
      ['completed', new Date(), tournamentId]
    );
    
    const completedTournament = result.rows[0];
    
    res.json({
      success: true,
      message: 'Tournament closed successfully',
      tournament: {
        id: completedTournament.id,
        name: completedTournament.name,
        status: completedTournament.status,
        endTime: completedTournament.end_time
      }
    });
  } catch (error) {
    console.error('Close tournament error:', error);
    res.status(500).json({ error: 'Failed to close tournament' });
  }
});

// ============================================================
// DELETE TOURNAMENT (HOST ONLY - COMPLETED TOURNAMENTS ONLY)
// ============================================================
router.delete('/:tournamentId', verifyAuth, async (req, res) => {
  try {
    const { tournamentId } = req.params;
    
    // Get tournament
    const tourResult = await pool.query(
      'SELECT * FROM tournaments WHERE id = $1',
      [tournamentId]
    );
    
    if (tourResult.rows.length === 0) {
      return res.status(404).json({ error: 'Tournament not found' });
    }
    
    const tournament = tourResult.rows[0];
    
    // Check if user is host (HOST ONLY)
    if (tournament.host_id !== req.user.id) {
      return res.status(403).json({ error: 'Only host can delete tournaments' });
    }
    
    // Check if tournament is completed
    if (tournament.status !== 'completed') {
      return res.status(400).json({ error: 'Only completed tournaments can be deleted' });
    }
    
    // Delete matches
    await pool.query(
      'DELETE FROM tournament_matches WHERE tournament_id = $1',
      [tournamentId]
    );
    
    // Delete rounds
    await pool.query(
      'DELETE FROM tournament_rounds WHERE tournament_id = $1',
      [tournamentId]
    );
    
    // Delete players
    await pool.query(
      'DELETE FROM tournament_players WHERE tournament_id = $1',
      [tournamentId]
    );
    
    // Delete tournament
    await pool.query(
      'DELETE FROM tournaments WHERE id = $1',
      [tournamentId]
    );
    
    res.json({ 
      success: true, 
      message: 'Tournament deleted successfully' 
    });
  } catch (error) {
    console.error('Delete tournament error:', error);
    res.status(500).json({ error: 'Failed to delete tournament' });
  }
});

// ============================================================
// UPDATE MATCH SCORE (host only)
router.post('/:tournamentId/match-score', verifyAuth, async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const { matchId, player, score } = req.body; // player: 1 or 2

    const tourResult = await pool.query('SELECT host_id FROM tournaments WHERE id = $1', [tournamentId]);
    if (!tourResult.rows.length) return res.status(404).json({ error: 'Tournament not found' });
    if (tourResult.rows[0].host_id !== req.user.id) return res.status(403).json({ error: 'Only host can edit scores' });

    const field = player === 1 ? 'player1_score' : 'player2_score';
    await pool.query(`UPDATE tournament_matches SET ${field} = $1 WHERE id = $2`, [parseInt(score) || 0, matchId]);

    res.json({ success: true });
  } catch (error) {
    console.error('Match score error:', error);
    res.status(500).json({ error: 'Failed to update score' });
  }
});

// RECORD MATCH RESULT (LEGACY - can be deprecated in favor of set-winner)
// ============================================================
router.post('/:tournamentId/match-result', verifyAuth, async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const { roundNumber, matchNumber, winnerId } = req.body;
    
    // Get tournament
    const tourResult = await pool.query(
      'SELECT * FROM tournaments WHERE id = $1',
      [tournamentId]
    );
    
    if (tourResult.rows.length === 0) {
      return res.status(404).json({ error: 'Tournament not found' });
    }
    
    const tournament = tourResult.rows[0];
    
    // Check if user is host
    if (tournament.host_id !== req.user.id) {
      return res.status(403).json({ error: 'Only host can record results' });
    }
    
    // Get the match
    const matchResult = await pool.query(
      `SELECT m.id FROM tournament_matches m
       JOIN tournament_rounds r ON m.round_id = r.id
       WHERE m.tournament_id = $1 AND r.round_number = $2 AND m.match_number = $3`,
      [tournamentId, roundNumber, matchNumber]
    );
    
    if (matchResult.rows.length === 0) {
      return res.status(404).json({ error: 'Match not found' });
    }
    
    const matchId = matchResult.rows[0].id;
    
    // Update match with winner
    await pool.query(
      `UPDATE tournament_matches 
       SET winner_id = $1, status = $2, completed_at = $3
       WHERE id = $4`,
      [winnerId, 'completed', new Date(), matchId]
    );
    
    res.json({ success: true });
  } catch (error) {
    console.error('Match result error:', error);
    res.status(500).json({ error: 'Failed to record match result' });
  }
});

// ============================================================
// HELPER FUNCTIONS
// ============================================================

async function getBracketData(tournamentId) {
  const roundsResult = await pool.query(
    `SELECT r.id, r.round_number 
     FROM tournament_rounds r 
     WHERE r.tournament_id = $1 
     ORDER BY r.round_number ASC`,
    [tournamentId]
  );
  
  const rounds = await Promise.all(
    roundsResult.rows.map(async (round) => {
      const matchesResult = await pool.query(
        `SELECT m.id, m.match_number,
                p1.user_id as player1_user_id, p1.username as player1_username,
                u1.avatar_url as player1_avatar,
                p2.user_id as player2_user_id, p2.username as player2_username,
                u2.avatar_url as player2_avatar,
                m.winner_id, m.status,
                m.player1_score, m.player2_score,
                m.locked_players, m.round_locked
         FROM tournament_matches m
         LEFT JOIN tournament_players p1 ON m.player1_id = p1.id
         LEFT JOIN tournament_players p2 ON m.player2_id = p2.id
         LEFT JOIN users u1 ON p1.user_id = u1.id
         LEFT JOIN users u2 ON p2.user_id = u2.id
         WHERE m.round_id = $1
         ORDER BY m.match_number ASC`,
        [round.id]
      );

      // Load tournament card data separately (safe — columns may not exist yet)
      const cardCache = {};
      const userIds = matchesResult.rows.flatMap(m => [m.player1_user_id, m.player2_user_id]).filter(Boolean);
      if (userIds.length > 0) {
        try {
          const cardResult = await pool.query(
            `SELECT id, tournament_card_image_url, tournament_card_bg_colour,
                    tournament_card_border_colour, tournament_card_name_colour, tournament_card_bg_pos
             FROM users WHERE id = ANY($1)`,
            [userIds]
          );
          cardResult.rows.forEach(u => { cardCache[u.id] = u; });
        } catch(e) { /* columns don't exist yet — skip */ }
      }

      const getCard = (userId) => {
        const u = cardCache[userId] || {};
        return { imageUrl: u.tournament_card_image_url || null, bgColour: u.tournament_card_bg_colour || '#2c3440', borderColour: u.tournament_card_border_colour || '#f9a8d4', nameColour: u.tournament_card_name_colour || '#fdf2f8', bgPos: u.tournament_card_bg_pos || '50% 50%' };
      };

      const matches = matchesResult.rows.map(m => ({
        matchId: m.id,
        matchNumber: m.match_number,
        player1Score: m.player1_score ?? 0,
        player2Score: m.player2_score ?? 0,
        lockedPlayers: m.locked_players || [],
        roundLocked: m.round_locked || false,
        player1: m.player1_user_id ? {
          userId: m.player1_user_id, username: m.player1_username, avatar_url: m.player1_avatar || null,
          tournamentCard: getCard(m.player1_user_id)
        } : null,
        player2: m.player2_user_id ? {
          userId: m.player2_user_id, username: m.player2_username, avatar_url: m.player2_avatar || null,
          tournamentCard: getCard(m.player2_user_id)
        } : null,
        winner: m.winner_id,
        status: m.status
      }));
      
      return {
        roundNumber: round.round_number,
        matches
      };
    })
  );
  
  return { rounds };
}

// ── LOCK-IN: player confirms ready for their match ───────────
router.post('/:tournamentId/lock-in', verifyAuth, async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const { matchId } = req.body;
    const userId = req.user.id;

    // Get the match
    const matchResult = await pool.query(
      `SELECT id, locked_players, player1_id, player2_id, round_locked
       FROM tournament_matches WHERE id = $1 AND tournament_id = $2`,
      [matchId, tournamentId]
    );
    if (!matchResult.rows.length) return res.status(404).json({ error: 'Match not found' });

    const match = matchResult.rows[0];

    // Verify this user is in this match
    const playerCheck = await pool.query(
      `SELECT id FROM tournament_players WHERE tournament_id = $1 AND user_id = $2 AND id IN ($3, $4)`,
      [tournamentId, userId, match.player1_id || 0, match.player2_id || 0]
    );
    if (!playerCheck.rows.length) return res.status(403).json({ error: 'You are not in this match' });

    // Add user to locked_players list
    const locked = match.locked_players || [];
    if (!locked.includes(userId)) locked.push(userId);
    await pool.query(
      `UPDATE tournament_matches SET locked_players = $1 WHERE id = $2`,
      [JSON.stringify(locked), matchId]
    );

    // Check if both players locked in — get the other player's user_id
    const p1 = await pool.query('SELECT user_id FROM tournament_players WHERE id = $1', [match.player1_id]);
    const p2 = await pool.query('SELECT user_id FROM tournament_players WHERE id = $1', [match.player2_id]);
    const p1uid = p1.rows[0]?.user_id;
    const p2uid = p2.rows[0]?.user_id;
    const bothLocked = p1uid && p2uid && locked.includes(p1uid) && locked.includes(p2uid);

    if (bothLocked) {
      await pool.query(`UPDATE tournament_matches SET round_locked = TRUE WHERE id = $1`, [matchId]);
    }

    res.json({ success: true, lockedPlayers: locked, bothLocked });
  } catch (err) {
    console.error('Lock-in error:', err);
    res.status(500).json({ error: 'Failed to lock in' });
  }
});

// ── SCHEDULE: get upcoming scheduled tournaments (for scheduler loop) ──
router.get('/scheduled/upcoming', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.id, t.name, t.scheduled_start, t.alert_before_minutes, t.lobby_id, t.host_id,
              ARRAY_AGG(tp.user_id) as player_user_ids
       FROM tournaments t
       LEFT JOIN tournament_players tp ON tp.tournament_id = t.id
       WHERE t.status = 'setup'
         AND t.scheduled_start IS NOT NULL
         AND t.scheduled_start > NOW()
       GROUP BY t.id`,
      []
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;