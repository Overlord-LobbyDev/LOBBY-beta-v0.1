// routes/tournaments.js
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const auth = require('../middleware/auth'); // assuming you have auth middleware

// Create a new tournament
router.post('/create', auth, async (req, res) => {
  try {
    const { lobbyId, name, description, format, playerCount, rules, prize, startTime } = req.body;
    
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
    
    const tournament = {
      id: uuidv4(),
      lobbyId,
      hostId: req.user.id,
      name,
      description: description || '',
      format,
      playerCount,
      maxPlayers: playerCount,
      registeredPlayers: [],
      bracket: {
        rounds: []
      },
      status: 'setup',
      createdAt: new Date(),
      startTime: startTime ? new Date(startTime) : null,
      endTime: null,
      rules: rules || '',
      prize: prize || ''
    };
    
    // Save to database (adjust based on your db setup)
    const db = require('../db'); // assuming you have a db module
    await db.tournaments.insertOne(tournament);
    
    res.status(201).json({
      success: true,
      tournament
    });
  } catch (error) {
    console.error('Tournament creation error:', error);
    res.status(500).json({ error: 'Failed to create tournament' });
  }
});

// Get tournament details
router.get('/:tournamentId', async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const db = require('../db');
    
    const tournament = await db.tournaments.findOne({ id: tournamentId });
    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }
    
    res.json(tournament);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch tournament' });
  }
});

// Get tournaments for a lobby
router.get('/lobby/:lobbyId', async (req, res) => {
  try {
    const { lobbyId } = req.params;
    const db = require('../db');
    
    const tournaments = await db.tournaments.find({ lobbyId }).toArray();
    res.json(tournaments);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch tournaments' });
  }
});

// Register player for tournament
router.post('/:tournamentId/register', auth, async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const userId = req.user.id;
    const username = req.user.username;
    
    const db = require('../db');
    const tournament = await db.tournaments.findOne({ id: tournamentId });
    
    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }
    
    // Check if already registered
    if (tournament.registeredPlayers.some(p => p.userId === userId)) {
      return res.status(400).json({ error: 'Already registered' });
    }
    
    // Check if tournament is full
    if (tournament.registeredPlayers.length >= tournament.maxPlayers) {
      return res.status(400).json({ error: 'Tournament is full' });
    }
    
    // Add player
    const player = {
      userId,
      username,
      joinedAt: new Date(),
      status: 'registered'
    };
    
    await db.tournaments.updateOne(
      { id: tournamentId },
      { $push: { registeredPlayers: player } }
    );
    
    // Emit event to all players in lobby
    const io = require('../socket'); // assuming you have socket.io setup
    io.to(`lobby-${tournament.lobbyId}`).emit('tournament-update', {
      tournamentId,
      registeredCount: tournament.registeredPlayers.length + 1,
      maxPlayers: tournament.maxPlayers
    });
    
    res.json({ success: true, message: 'Registered for tournament' });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Failed to register' });
  }
});

// Generate bracket (called when tournament starts)
router.post('/:tournamentId/generate-bracket', auth, async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const db = require('../db');
    
    const tournament = await db.tournaments.findOne({ id: tournamentId });
    
    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }
    
    if (tournament.hostId !== req.user.id) {
      return res.status(403).json({ error: 'Only host can generate bracket' });
    }
    
    // Generate bracket based on format
    const bracket = generateBracket(tournament);
    
    // Update tournament
    await db.tournaments.updateOne(
      { id: tournamentId },
      {
        $set: {
          bracket,
          status: 'in-progress',
          startTime: new Date()
        }
      }
    );
    
    res.json({ success: true, bracket });
  } catch (error) {
    console.error('Bracket generation error:', error);
    res.status(500).json({ error: 'Failed to generate bracket' });
  }
});

// Record match result
router.post('/:tournamentId/match-result', auth, async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const { roundNumber, matchId, winnerId } = req.body;
    
    const db = require('../db');
    const tournament = await db.tournaments.findOne({ id: tournamentId });
    
    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }
    
    // Update match result
    await db.tournaments.updateOne(
      {
        id: tournamentId,
        'bracket.rounds.roundNumber': roundNumber,
        'bracket.rounds.matches.matchId': matchId
      },
      {
        $set: {
          'bracket.rounds.$[].matches.$[m].winner': winnerId,
          'bracket.rounds.$[].matches.$[m].status': 'completed'
        }
      },
      {
        arrayFilters: [
          { 'm.matchId': matchId }
        ]
      }
    );
    
    res.json({ success: true });
  } catch (error) {
    console.error('Match result error:', error);
    res.status(500).json({ error: 'Failed to record match result' });
  }
});

// Helper function to generate bracket
function generateBracket(tournament) {
  const players = [...tournament.registeredPlayers].sort(() => Math.random() - 0.5);
  const rounds = [];
  const playerCount = tournament.playerCount;
  
  // First round matches
  const firstRoundMatches = [];
  for (let i = 0; i < playerCount; i += 2) {
    firstRoundMatches.push({
      matchId: uuidv4(),
      player1: {
        userId: players[i]?.userId || null,
        username: players[i]?.username || 'TBD'
      },
      player2: {
        userId: players[i + 1]?.userId || null,
        username: players[i + 1]?.username || 'TBD'
      },
      winner: null,
      status: 'pending'
    });
  }
  
  rounds.push({
    roundNumber: 1,
    matches: firstRoundMatches
  });
  
  // Generate subsequent rounds (single elimination)
  if (tournament.format === 'single') {
    let currentMatches = playerCount / 2;
    let roundNum = 2;
    
    while (currentMatches > 0) {
      const roundMatches = [];
      for (let i = 0; i < currentMatches; i++) {
        roundMatches.push({
          matchId: uuidv4(),
          player1: { userId: null, username: 'TBD' },
          player2: { userId: null, username: 'TBD' },
          winner: null,
          status: 'pending'
        });
      }
      rounds.push({
        roundNumber: roundNum,
        matches: roundMatches
      });
      
      currentMatches = currentMatches / 2;
      roundNum++;
    }
  }
  
  return { rounds };
}

module.exports = router;
