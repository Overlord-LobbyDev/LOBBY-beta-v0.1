// models/Tournament.js
// Add this to your db.js or create a new schema

const tournamentSchema = {
  id: String, // UUID
  lobbyId: String,
  hostId: String,
  name: String,
  description: String,
  format: String, // 'single', 'double', 'round-robin'
  playerCount: Number, // 4, 8, 16, 32, 64, 128
  registeredPlayers: [
    {
      userId: String,
      username: String,
      joinedAt: Date,
      status: String // 'registered', 'checked-in', 'eliminated'
    }
  ],
  bracket: {
    rounds: [
      {
        roundNumber: Number,
        matches: [
          {
            matchId: String,
            player1: { userId: String, username: String },
            player2: { userId: String, username: String },
            winner: String, // userId of winner
            status: String // 'pending', 'in-progress', 'completed'
          }
        ]
      }
    ]
  },
  status: String, // 'setup', 'registration', 'in-progress', 'completed', 'cancelled'
  createdAt: Date,
  startTime: Date,
  endTime: Date,
  maxPlayers: Number,
  rules: String,
  prize: String
};

module.exports = tournamentSchema;
