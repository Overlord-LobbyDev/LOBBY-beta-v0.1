const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
require('dotenv').config();

// Import the pool from db.js
const { pool } = require('./db');

const app = express();
const upload = multer({ dest: 'uploads/' });

// Middleware
app.use(express.json());

// ==================== AUTHENTICATION ====================

// Register
app.post('/auth/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await pool.query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email',
      [username, email, hashedPassword]
    );

    res.status(201).json({ 
      message: 'User registered successfully',
      user: result.rows[0]
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Login
app.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const result = await pool.query(
      'SELECT id, username, email, password_hash, is_admin FROM users WHERE username = $1',
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

    const token = jwt.sign(
      { id: user.id, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        isAdmin: user.is_admin
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Middleware to verify token
function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ==================== USER ENDPOINTS ====================

// Get current user
app.get('/auth/me', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, email, avatar_url, banner_url, bio FROM users WHERE id = $1',
      [req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
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
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get user's friends
app.get('/auth/profile/:userId/friends', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.username, u.avatar_url FROM users u
       INNER JOIN friends f ON u.id = f.friend_id
       WHERE f.user_id = $1 AND f.status = 'accepted'`,
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
      'SELECT id, content, created_at FROM posts WHERE user_id = $1 ORDER BY created_at DESC',
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
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Search query required' });

    const result = await pool.query(
      "SELECT id, username, avatar_url FROM users WHERE username ILIKE $1 LIMIT 20",
      [`%${q}%`]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== FRIENDS ====================

app.get('/auth/friends/:userId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.username, u.avatar_url, f.status FROM users u
       INNER JOIN friends f ON u.id = f.friend_id
       WHERE f.user_id = $1`,
      [req.params.userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/auth/friends/add', verifyToken, async (req, res) => {
  try {
    const { friendId } = req.body;
    await pool.query(
      'INSERT INTO friends (user_id, friend_id, status) VALUES ($1, $2, $3)',
      [req.user.id, friendId, 'pending']
    );
    res.json({ message: 'Friend request sent' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/auth/friends/remove', verifyToken, async (req, res) => {
  try {
    const { friendId } = req.body;
    await pool.query(
      'DELETE FROM friends WHERE user_id = $1 AND friend_id = $2',
      [req.user.id, friendId]
    );
    res.json({ message: 'Friend removed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== MESSAGES ====================

app.get('/auth/messages/:userId/:friendId', verifyToken, async (req, res) => {
  try {
    const { userId, friendId } = req.params;
    const result = await pool.query(
      `SELECT id, sender_id, content, created_at FROM messages
       WHERE (sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)
       ORDER BY created_at DESC LIMIT 50`,
      [userId, friendId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== POSTS & SOCIAL ====================

app.get('/auth/feed', async (req, res) => {
  try {
    const { tab } = req.query;
    const query = tab === 'friends'
      ? `SELECT p.id, p.content, p.created_at, u.username, u.avatar_url FROM posts p
         JOIN users u ON p.user_id = u.id ORDER BY p.created_at DESC LIMIT 50`
      : `SELECT p.id, p.content, p.created_at, u.username, u.avatar_url FROM posts p
         JOIN users u ON p.user_id = u.id ORDER BY p.created_at DESC LIMIT 50`;
    
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/auth/posts', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT p.id, p.content, p.created_at, u.username FROM posts p JOIN users u ON p.user_id = u.id ORDER BY p.created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/auth/posts', verifyToken, async (req, res) => {
  try {
    const { content } = req.body;
    const result = await pool.query(
      'INSERT INTO posts (user_id, content) VALUES ($1, $2) RETURNING *',
      [req.user.id, content]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== SERVERS ====================

app.get('/auth/servers', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, description, icon_url, created_at FROM servers'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/auth/servers/search', async (req, res) => {
  try {
    const { q } = req.query;
    const result = await pool.query(
      "SELECT id, name, description, icon_url FROM servers WHERE name ILIKE $1 LIMIT 20",
      [`%${q}%`]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/auth/servers/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM servers WHERE id = $1',
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Server not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/auth/servers', verifyToken, async (req, res) => {
  try {
    const { name, description } = req.body;
    const result = await pool.query(
      'INSERT INTO servers (owner_id, name, description) VALUES ($1, $2, $3) RETURNING *',
      [req.user.id, name, description]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/auth/servers/:id/banner', verifyToken, upload.single('banner'), async (req, res) => {
  try {
    const bannerUrl = req.file ? `/uploads/${req.file.filename}` : null;
    await pool.query(
      'UPDATE servers SET banner_url = $1 WHERE id = $2',
      [bannerUrl, req.params.id]
    );
    res.json({ message: 'Banner updated', bannerUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/auth/servers/:id/icon', verifyToken, upload.single('icon'), async (req, res) => {
  try {
    const iconUrl = req.file ? `/uploads/${req.file.filename}` : null;
    await pool.query(
      'UPDATE servers SET icon_url = $1 WHERE id = $2',
      [iconUrl, req.params.id]
    );
    res.json({ message: 'Icon updated', iconUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== AVATARS & BANNERS ====================

app.post('/auth/avatar', verifyToken, upload.single('avatar'), async (req, res) => {
  try {
    const avatarUrl = req.file ? `/uploads/${req.file.filename}` : null;
    await pool.query(
      'UPDATE users SET avatar_url = $1 WHERE id = $2',
      [avatarUrl, req.user.id]
    );
    res.json({ message: 'Avatar updated', avatarUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/auth/banner', verifyToken, upload.single('banner'), async (req, res) => {
  try {
    const bannerUrl = req.file ? `/uploads/${req.file.filename}` : null;
    await pool.query(
      'UPDATE users SET banner_url = $1 WHERE id = $2',
      [bannerUrl, req.user.id]
    );
    res.json({ message: 'Banner updated', bannerUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== FILE UPLOAD ====================

app.post('/auth/upload', upload.single('file'), (req, res) => {
  try {
    const fileUrl = req.file ? `/uploads/${req.file.filename}` : null;
    res.json({ message: 'File uploaded', fileUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== PUBLIC ====================

app.get('/auth/public', async (req, res) => {
  try {
    const users = await pool.query('SELECT id, username, avatar_url FROM users LIMIT 10');
    const posts = await pool.query('SELECT id, content, created_at FROM posts LIMIT 10');
    res.json({
      users: users.rows,
      posts: posts.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== STEAM (PLACEHOLDER) ====================

app.get('/auth/steam/recent', verifyToken, async (req, res) => {
  try {
    // Placeholder - would integrate with Steam API
    res.json({ games: [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== HEALTH CHECK ====================

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Auth server running on port ${PORT}`);
});
