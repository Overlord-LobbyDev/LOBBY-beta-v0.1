     // v2 redeploy - FIXED with server startup
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('./db');
const { Pool } = require('pg');
const cors = require('cors');
const bodyParser = require('body-parser');

const router = express.Router();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }  // Required for Render PostgreSQL
});

const JWT_SECRET = process.env.JWT_SECRET || 'yFLyUwQDkz¿Y3u9RmRMtRxFejhh9';

// Register route
router.post('/register', async (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // Check if user exists
    const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userResult.rows.length > 0) {
      return res.status(409).json({ error: 'User already exists' });
    }

    // Hash password
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Create user
    const newUserResult = await pool.query(
      'INSERT INTO users (username, email, password) VALUES ($1, $2, $3) RETURNING id, username, email',
      [username, email, hashedPassword]
    );

    const user = newUserResult.rows[0];

    // Generate JWT
    const token = jwt.sign(
      { userId: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.status(201).json({
      message: 'User registered successfully',
      token,
      user: { id: user.id, username: user.username, email: user.email }
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Login route
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Generate JWT
    const token = jwt.sign(
      { userId: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.status(200).json({
      message: 'Login successful',
      token,
      user: { 
        id: user.id, 
        username: user.username, 
        email: user.email,
        isAdmin: user.is_admin || false
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user profile
router.get('/profile/:userId', async (req, res) => {
  const { userId } = req.params;

  if (!userId) {
    return res.status(400).json({ error: 'Missing user ID' });
  }

  try {
    const result = await pool.query('SELECT id, username, email, created_at FROM users WHERE id = $1', [userId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update profile
router.put('/profile/:userId', async (req, res) => {
  const { userId } = req.params;
  const { username, email } = req.body;

  if (!userId || (!username && !email)) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    let query = 'UPDATE users SET ';
    const values = [];
    let paramIndex = 1;

    if (username) {
      query += `username = $${paramIndex}`;
      values.push(username);
      paramIndex++;
    }

    if (email) {
      if (username) query += ', ';
      query += `email = $${paramIndex}`;
      values.push(email);
      paramIndex++;
    }

    query += ` WHERE id = $${paramIndex} RETURNING id, username, email`;
    values.push(userId);

    const result = await pool.query(query, values);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.status(200).json({
      message: 'Profile updated successfully',
      user: result.rows[0]
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Add friend
router.post('/friends/add', async (req, res) => {
  const { userId, friendId } = req.body;

  if (!userId || !friendId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (userId === friendId) {
    return res.status(400).json({ error: 'Cannot add yourself as a friend' });
  }

  try {
    // Check if friend exists
    const friendResult = await pool.query('SELECT id FROM users WHERE id = $1', [friendId]);
    if (friendResult.rows.length === 0) {
      return res.status(404).json({ error: 'Friend not found' });
    }

    // Check if already friends
    const existingResult = await pool.query(
      'SELECT * FROM friends WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)',
      [userId, friendId]
    );

    if (existingResult.rows.length > 0) {
      return res.status(409).json({ error: 'Already friends' });
    }

    // Add friend
    await pool.query(
      'INSERT INTO friends (user_id, friend_id) VALUES ($1, $2)',
      [userId, friendId]
    );

    res.status(200).json({ message: 'Friend added successfully' });
  } catch (error) {
    console.error('Add friend error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Remove friend
router.post('/friends/remove', async (req, res) => {
  const { userId, friendId } = req.body;

  if (!userId || !friendId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    await pool.query(
      'DELETE FROM friends WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)',
      [userId, friendId]
    );

    res.status(200).json({ message: 'Friend removed successfully' });
  } catch (error) {
    console.error('Remove friend error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get friends list
router.get('/friends/:userId', async (req, res) => {
  const { userId } = req.params;

  if (!userId) {
    return res.status(400).json({ error: 'Missing user ID' });
  }

  try {
    const result = await pool.query(
      `SELECT u.id, u.username, u.email FROM users u
       INNER JOIN friends f ON (u.id = f.friend_id AND f.user_id = $1) OR (u.id = f.user_id AND f.friend_id = $1)
       WHERE u.id != $1`,
      [userId]
    );

    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Get friends error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Send message
router.post('/messages/send', async (req, res) => {
  const { senderId, recipientId, message } = req.body;

  if (!senderId || !recipientId || !message) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO messages (sender_id, recipient_id, message_text, created_at) VALUES ($1, $2, $3, NOW()) RETURNING *',
      [senderId, recipientId, message]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get messages
router.get('/messages/:userId/:friendId', async (req, res) => {
  const { userId, friendId } = req.params;

  if (!userId || !friendId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const result = await pool.query(
      `SELECT * FROM messages 
       WHERE (sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)
       ORDER BY created_at ASC`,
      [userId, friendId]
    );

    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ===== SERVER STARTUP (FIXED) =====
const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Routes
app.use('/auth', router);

// Health check
app.get('/', (req, res) => {
  res.status(200).json({ message: 'Auth server is running' });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Auth server running on port ${PORT}`);
});

module.exports = router;
