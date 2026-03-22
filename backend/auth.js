const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const pool = require('./db');

const app = express();
const upload = multer({ dest: 'uploads/' });

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use('/uploads', express.static('uploads'));

// JWT Middleware
function authenticateToken(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
}

// ==================== AUTH ENDPOINTS ====================

// Register
app.post('/auth/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await pool.query(
      'INSERT INTO users (username, email, password) VALUES ($1, $2, $3) RETURNING id, username, email, is_admin',
      [username, email, hashedPassword]
    );

    res.json(result.rows[0]);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Login
app.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid username' });

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.status(401).json({ error: 'Invalid password' });

    const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, id: user.id, username: user.username, isAdmin: user.is_admin });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Get current user (me)
app.get('/auth/me', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, email, avatar, banner, bio, is_admin, created_at FROM users WHERE id = $1',
      [req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ==================== USER PROFILE ENDPOINTS ====================

// Get user profile by ID
app.get('/auth/profile/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await pool.query(
      'SELECT id, username, avatar, banner, bio, created_at FROM users WHERE id = $1',
      [userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Get user's friends (for profile view)
app.get('/auth/profile/:userId/friends', async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await pool.query(
      `SELECT u.id, u.username, u.avatar FROM users u
       JOIN friends f ON (f.friend_id = u.id OR f.user_id = u.id)
       WHERE (f.user_id = $1 OR f.friend_id = $1) AND f.status = 'accepted'
       AND u.id != $1`,
      [userId]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Get user's posts (for profile view)
app.get('/auth/profile/:userId/posts', async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await pool.query(
      `SELECT p.*, u.username, u.avatar,
          (SELECT COUNT(*) FROM post_likes WHERE post_id = p.id) as likes
       FROM posts p
       JOIN users u ON p.user_id = u.id
       WHERE p.user_id = $1
       ORDER BY p.created_at DESC LIMIT 50`,
      [userId]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Update profile
app.put('/auth/profile', authenticateToken, async (req, res) => {
  try {
    const { bio } = req.body;
    const result = await pool.query(
      'UPDATE users SET bio = $1, updated_at = NOW() WHERE id = $2 RETURNING id, username, avatar, banner, bio',
      [bio, req.user.id]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Upload avatar
app.post('/auth/avatar', authenticateToken, upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const avatarUrl = `/uploads/${req.file.filename}`;
    await pool.query('UPDATE users SET avatar = $1 WHERE id = $2', [avatarUrl, req.user.id]);
    res.json({ avatar: avatarUrl });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Upload banner
app.post('/auth/banner', authenticateToken, upload.single('banner'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const bannerUrl = `/uploads/${req.file.filename}`;
    await pool.query('UPDATE users SET banner = $1 WHERE id = $2', [bannerUrl, req.user.id]);
    res.json({ banner: bannerUrl });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Generic upload endpoint (used by frontend)
app.post('/auth/upload', authenticateToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const fileUrl = `/uploads/${req.file.filename}`;
    res.json({ url: fileUrl, filename: req.file.filename });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Search users
app.get('/auth/users/search', async (req, res) => {
  try {
    const { q } = req.query;
    const result = await pool.query(
      'SELECT id, username, avatar, bio FROM users WHERE username ILIKE $1 LIMIT 10',
      [`%${q}%`]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ==================== POSTS/FEED ENDPOINTS ====================

// Get feed
app.get('/auth/feed', authenticateToken, async (req, res) => {
  try {
    const { tab } = req.query;
    let query;

    if (tab === 'friends') {
      query = `
        SELECT p.*, u.username, u.avatar,
          (SELECT COUNT(*) FROM post_likes WHERE post_id = p.id) as likes,
          EXISTS(SELECT 1 FROM post_likes WHERE post_id = p.id AND user_id = $1) as liked
        FROM posts p
        JOIN users u ON p.user_id = u.id
        WHERE p.user_id IN (
          SELECT friend_id FROM friends WHERE user_id = $1 AND status = 'accepted'
          UNION
          SELECT user_id FROM friends WHERE friend_id = $1 AND status = 'accepted'
        )
        ORDER BY p.created_at DESC LIMIT 50
      `;
    } else {
      query = `
        SELECT p.*, u.username, u.avatar,
          (SELECT COUNT(*) FROM post_likes WHERE post_id = p.id) as likes,
          EXISTS(SELECT 1 FROM post_likes WHERE post_id = p.id AND user_id = $1) as liked
        FROM posts p
        JOIN users u ON p.user_id = u.id
        WHERE p.user_id = $1
        ORDER BY p.created_at DESC LIMIT 50
      `;
    }

    const result = await pool.query(query, [req.user.id]);
    res.json(result.rows);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Create post
app.post('/auth/posts', authenticateToken, upload.single('image'), async (req, res) => {
  try {
    const { content } = req.body;
    const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;

    const result = await pool.query(
      'INSERT INTO posts (user_id, content, image_url) VALUES ($1, $2, $3) RETURNING *',
      [req.user.id, content, imageUrl]
    );

    res.json(result.rows[0]);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Like post
app.post('/auth/posts/:id/like', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(
      'INSERT INTO post_likes (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [id, req.user.id]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ==================== SERVERS ENDPOINTS ====================

// List servers
app.get('/auth/servers', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, description, icon_url, genre, member_count, max_members, is_public FROM servers WHERE is_public = TRUE ORDER BY member_count DESC LIMIT 20'
    );
    res.json(result.rows);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Search servers
app.get('/auth/servers/search', async (req, res) => {
  try {
    const { q, genre } = req.query;
    let queryStr = 'SELECT * FROM servers WHERE is_public = TRUE';
    const params = [];

    if (q) {
      queryStr += ` AND name ILIKE $${params.length + 1}`;
      params.push(`%${q}%`);
    }

    if (genre) {
      queryStr += ` AND genre = $${params.length + 1}`;
      params.push(genre);
    }

    queryStr += ' LIMIT 20';
    const result = await pool.query(queryStr, params);
    res.json(result.rows);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Get server by ID
app.get('/auth/servers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM servers WHERE id = $1', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Server not found' });

    const membersResult = await pool.query(
      'SELECT u.id, u.username, u.avatar FROM server_members sm JOIN users u ON sm.user_id = u.id WHERE sm.server_id = $1',
      [id]
    );

    res.json({ ...result.rows[0], members: membersResult.rows });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Create server
app.post('/auth/servers', authenticateToken, async (req, res) => {
  try {
    const { name, description, genre, icon_url, max_members } = req.body;

    const result = await pool.query(
      'INSERT INTO servers (owner_id, name, description, genre, icon_url, max_members) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [req.user.id, name, description, genre, icon_url, max_members]
    );

    const serverId = result.rows[0].id;
    await pool.query('INSERT INTO server_members (server_id, user_id) VALUES ($1, $2)', [serverId, req.user.id]);

    res.json(result.rows[0]);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Upload server banner
app.post('/auth/servers/:id/banner', authenticateToken, upload.single('banner'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    
    const bannerUrl = `/uploads/${req.file.filename}`;
    await pool.query('UPDATE servers SET icon_url = $1 WHERE id = $2', [bannerUrl, id]);
    res.json({ banner: bannerUrl });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Upload server icon
app.post('/auth/servers/:id/icon', authenticateToken, upload.single('icon'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    
    const iconUrl = `/uploads/${req.file.filename}`;
    await pool.query('UPDATE servers SET icon_url = $1 WHERE id = $2', [iconUrl, id]);
    res.json({ icon: iconUrl });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Join server
app.post('/auth/servers/:id/join', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(
      'INSERT INTO server_members (server_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [id, req.user.id]
    );
    await pool.query('UPDATE servers SET member_count = member_count + 1 WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ==================== FRIENDS ENDPOINTS ====================

// Get friends
app.get('/auth/friends/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await pool.query(
      `SELECT u.id, u.username, u.avatar FROM users u
       JOIN friends f ON (f.friend_id = u.id OR f.user_id = u.id)
       WHERE (f.user_id = $1 OR f.friend_id = $1) AND f.status = 'accepted'
       AND u.id != $1`,
      [userId]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Add friend
app.post('/auth/friends/add', authenticateToken, async (req, res) => {
  try {
    const { friendId } = req.body;
    const result = await pool.query(
      'INSERT INTO friends (user_id, friend_id, status) VALUES ($1, $2, $3) ON CONFLICT (user_id, friend_id) DO UPDATE SET status = $3 RETURNING *',
      [req.user.id, friendId, 'pending']
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Accept friend request
app.post('/auth/friends/accept', authenticateToken, async (req, res) => {
  try {
    const { friendId } = req.body;
    await pool.query(
      'UPDATE friends SET status = $1 WHERE (user_id = $2 AND friend_id = $3) OR (user_id = $3 AND friend_id = $2)',
      ['accepted', req.user.id, friendId]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Remove friend
app.post('/auth/friends/remove', authenticateToken, async (req, res) => {
  try {
    const { friendId } = req.body;
    await pool.query(
      'DELETE FROM friends WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)',
      [req.user.id, friendId]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ==================== MESSAGES ENDPOINTS ====================

// Get messages
app.get('/auth/messages/:friendId', authenticateToken, async (req, res) => {
  try {
    const { friendId } = req.params;
    const result = await pool.query(
      `SELECT * FROM messages
       WHERE (sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)
       ORDER BY created_at ASC`,
      [req.user.id, friendId]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Send message
app.post('/auth/messages', authenticateToken, async (req, res) => {
  try {
    const { recipientId, content } = req.body;
    const result = await pool.query(
      'INSERT INTO messages (sender_id, recipient_id, content) VALUES ($1, $2, $3) RETURNING *',
      [req.user.id, recipientId, content]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ==================== STEAM ENDPOINTS ====================

// Get recent Steam games
app.get('/auth/steam/recent', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT steam_id, steam_username, avatar_url FROM steam_accounts WHERE user_id = $1',
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.json({ games: [] });
    }

    // For now, return empty games array (Steam API would go here)
    res.json({ games: [] });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Link Steam account
app.post('/auth/steam/link', authenticateToken, async (req, res) => {
  try {
    const { steamId, steamUsername } = req.body;
    const result = await pool.query(
      'INSERT INTO steam_accounts (user_id, steam_id, steam_username) VALUES ($1, $2, $3) ON CONFLICT (steam_id) DO UPDATE SET steam_username = $3 RETURNING *',
      [req.user.id, steamId, steamUsername]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ==================== PUBLIC ENDPOINTS ====================

// Get public profile data
app.get('/auth/public', async (req, res) => {
  try {
    const usersCount = await pool.query('SELECT COUNT(*) FROM users');
    const serversCount = await pool.query('SELECT COUNT(*) FROM servers');
    const postsCount = await pool.query('SELECT COUNT(*) FROM posts');

    res.json({
      totalUsers: usersCount.rows[0].count,
      totalServers: serversCount.rows[0].count,
      totalPosts: postsCount.rows[0].count
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Auth server running on port ${PORT}`);
});
