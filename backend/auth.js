const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Import database pool
const pool = require('./db');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Multer setup for file uploads
const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB max
});

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// Health check
app.get('/auth/health', (req, res) => {
  res.json({ status: 'ok', message: 'Auth server is running' });
});

// ============ AUTHENTICATION ============

// Register endpoint
app.post('/auth/register', async (req, res) => {
  try {
    const { username, password, email } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await pool.query(
      'INSERT INTO users (username, password_hash, email) VALUES ($1, $2, $3) RETURNING id, username, is_admin',
      [username, hashedPassword, email || null]
    );

    const user = result.rows[0];
    const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '24h' });

    res.status(201).json({
      message: 'User registered successfully',
      token,
      user: { id: user.id, username: user.username, isAdmin: user.is_admin }
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Login endpoint
app.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const result = await pool.query(
      'SELECT id, username, password_hash, is_admin FROM users WHERE username = $1',
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const passwordMatch = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '24h' });

    res.json({
      message: 'Login successful',
      token,
      user: { id: user.id, username: user.username, isAdmin: user.is_admin }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Middleware to verify JWT
function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Token required' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ============ USER ENDPOINTS ============

// Get current user
app.get('/auth/me', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, email, is_admin, avatar_url, banner_url, bio FROM users WHERE id = $1',
      [req.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get user profile by ID
app.get('/auth/profile/:userId', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, avatar_url, banner_url, bio, created_at FROM users WHERE id = $1',
      [req.params.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get user's friends
app.get('/auth/profile/:userId/friends', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.username, u.avatar_url FROM friends f
       JOIN users u ON f.friend_id = u.id
       WHERE f.user_id = $1`,
      [req.params.userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get user's posts
app.get('/auth/profile/:userId/posts', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, content, image_url, created_at FROM posts WHERE user_id = $1 ORDER BY created_at DESC',
      [req.params.userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Search users
app.get('/auth/users/search', async (req, res) => {
  try {
    const query = req.query.q || '';
    const result = await pool.query(
      'SELECT id, username, avatar_url FROM users WHERE username ILIKE $1 LIMIT 10',
      [`%${query}%`]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get public data
app.get('/auth/public', async (req, res) => {
  try {
    const users = await pool.query('SELECT id, username, avatar_url FROM users LIMIT 20');
    const posts = await pool.query('SELECT p.id, p.content, u.username FROM posts p JOIN users u ON p.user_id = u.id ORDER BY p.created_at DESC LIMIT 20');
    res.json({ users: users.rows, posts: posts.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ FRIENDS ============

// Get friends list
app.get('/auth/friends/:userId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.username, u.avatar_url FROM friends f
       JOIN users u ON f.friend_id = u.id
       WHERE f.user_id = $1`,
      [req.params.userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add friend
app.post('/auth/friends/add', verifyToken, async (req, res) => {
  try {
    const { friendId } = req.body;
    await pool.query(
      'INSERT INTO friends (user_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.userId, friendId]
    );
    res.json({ message: 'Friend added' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove friend
app.post('/auth/friends/remove', verifyToken, async (req, res) => {
  try {
    const { friendId } = req.body;
    await pool.query('DELETE FROM friends WHERE user_id = $1 AND friend_id = $2', [req.userId, friendId]);
    res.json({ message: 'Friend removed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ MESSAGES ============

// Get messages with a friend
app.get('/auth/messages/:userId/:friendId', verifyToken, async (req, res) => {
  try {
    const { userId, friendId } = req.params;
    const result = await pool.query(
      `SELECT id, sender_id, content, created_at FROM messages
       WHERE (sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)
       ORDER BY created_at ASC`,
      [userId, friendId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send message
app.post('/auth/messages', verifyToken, async (req, res) => {
  try {
    const { recipientId, content } = req.body;
    const result = await pool.query(
      'INSERT INTO messages (sender_id, recipient_id, content) VALUES ($1, $2, $3) RETURNING *',
      [req.userId, recipientId, content]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ SOCIAL FEED ============

// Get feed
app.get('/auth/feed', verifyToken, async (req, res) => {
  try {
    const tab = req.query.tab || 'friends';
    let query;

    if (tab === 'friends') {
      query = `SELECT p.id, p.content, p.image_url, p.created_at, u.id as user_id, u.username, u.avatar_url
               FROM posts p
               JOIN users u ON p.user_id = u.id
               WHERE p.user_id IN (SELECT friend_id FROM friends WHERE user_id = $1)
               ORDER BY p.created_at DESC`;
    } else {
      query = `SELECT p.id, p.content, p.image_url, p.created_at, u.id as user_id, u.username, u.avatar_url
               FROM posts p
               JOIN users u ON p.user_id = u.id
               ORDER BY p.created_at DESC`;
    }

    const result = await pool.query(query, [req.userId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create post
app.post('/auth/posts', verifyToken, upload.single('image'), async (req, res) => {
  try {
    const { content } = req.body;
    const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;

    const result = await pool.query(
      'INSERT INTO posts (user_id, content, image_url) VALUES ($1, $2, $3) RETURNING *',
      [req.userId, content, imageUrl]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all posts
app.get('/auth/posts', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.id, p.content, p.image_url, p.created_at, u.id as user_id, u.username, u.avatar_url
       FROM posts p
       JOIN users u ON p.user_id = u.id
       ORDER BY p.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ SERVERS ============

// Get all servers
app.get('/auth/servers', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM servers ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Search servers
app.get('/auth/servers/search', async (req, res) => {
  try {
    const query = req.query.q || '';
    const result = await pool.query(
      'SELECT * FROM servers WHERE name ILIKE $1 ORDER BY created_at DESC',
      [`%${query}%`]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get server by ID
app.get('/auth/servers/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM servers WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Server not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create server
app.post('/auth/servers', verifyToken, async (req, res) => {
  try {
    const { name, description } = req.body;
    const result = await pool.query(
      'INSERT INTO servers (creator_id, name, description) VALUES ($1, $2, $3) RETURNING *',
      [req.userId, name, description]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload server banner
app.post('/auth/servers/:id/banner', verifyToken, upload.single('banner'), async (req, res) => {
  try {
    const bannerUrl = req.file ? `/uploads/${req.file.filename}` : null;
    const result = await pool.query(
      'UPDATE servers SET banner_url = $1 WHERE id = $2 RETURNING *',
      [bannerUrl, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Server not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload server icon
app.post('/auth/servers/:id/icon', verifyToken, upload.single('icon'), async (req, res) => {
  try {
    const iconUrl = req.file ? `/uploads/${req.file.filename}` : null;
    const result = await pool.query(
      'UPDATE servers SET icon_url = $1 WHERE id = $2 RETURNING *',
      [iconUrl, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Server not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ PROFILE UPLOADS ============

// Upload avatar
app.post('/auth/avatar', verifyToken, upload.single('avatar'), async (req, res) => {
  try {
    const avatarUrl = req.file ? `/uploads/${req.file.filename}` : null;
    const result = await pool.query(
      'UPDATE users SET avatar_url = $1 WHERE id = $2 RETURNING *',
      [avatarUrl, req.userId]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload banner
app.post('/auth/banner', verifyToken, upload.single('banner'), async (req, res) => {
  try {
    const bannerUrl = req.file ? `/uploads/${req.file.filename}` : null;
    const result = await pool.query(
      'UPDATE users SET banner_url = $1 WHERE id = $2 RETURNING *',
      [bannerUrl, req.userId]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generic upload endpoint
app.post('/auth/upload', verifyToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    res.json({ url: `/uploads/${req.file.filename}`, filename: req.file.filename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ STEAM ============

// Get recent Steam games
app.get('/auth/steam/recent', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM steam_accounts WHERE user_id = $1',
      [req.userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ Auth server running on port ${PORT}`);
  console.log(`📍 Available at https://lobby-auth-server.onrender.com`);
});
