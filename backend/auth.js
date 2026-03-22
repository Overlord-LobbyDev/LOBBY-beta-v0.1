const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { pool, initDb } = require('./db_complete');

const app = express();
app.use(express.json());
app.use(cors());

// JWT secret
const JWT_SECRET = process.env.JWT_SECRET || 'yFLyUwQDkz¿Y3u9RmRMtRxFejhh9';

// Multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});
const upload = multer({ storage });

// Middleware to verify JWT
function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.id;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ============================================
// AUTH ENDPOINTS
// ============================================

app.post('/auth/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;

    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (username, email, password) VALUES ($1, $2, $3) RETURNING id, username, email, is_admin',
      [username, email, hashedPassword]
    );

    const token = jwt.sign(
      { id: result.rows[0].id, username: result.rows[0].username },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      message: 'User registered successfully',
      token,
      user: result.rows[0]
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    const result = await pool.query(
      'SELECT * FROM users WHERE username = $1',
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const user = result.rows[0];
    const passwordMatch = await bcrypt.compare(password, user.password);

    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        isAdmin: user.is_admin,
        avatar: user.avatar_url
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// USER PROFILE ENDPOINTS
// ============================================

app.get('/auth/me', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, email, avatar_url, banner_url, bio, is_admin FROM users WHERE id = $1',
      [req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    res.json({
      id: user.id,
      username: user.username,
      email: user.email,
      avatar: user.avatar_url,
      banner: user.banner_url,
      bio: user.bio,
      isAdmin: user.is_admin
    });
  } catch (error) {
    console.error('Get me error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/auth/profile/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await pool.query(
      'SELECT id, username, avatar_url, banner_url, bio FROM users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    res.json({
      id: user.id,
      username: user.username,
      avatar: user.avatar_url,
      banner: user.banner_url,
      bio: user.bio
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// AVATAR & BANNER UPLOAD
// ============================================

app.post('/auth/avatar', verifyToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const avatar_url = `/uploads/${req.file.filename}`;
    await pool.query('UPDATE users SET avatar_url = $1 WHERE id = $2', [avatar_url, req.userId]);

    res.json({ avatar: avatar_url });
  } catch (error) {
    console.error('Avatar upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/auth/banner', verifyToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const banner_url = `/uploads/${req.file.filename}`;
    await pool.query('UPDATE users SET banner_url = $1 WHERE id = $2', [banner_url, req.userId]);

    res.json({ banner: banner_url });
  } catch (error) {
    console.error('Banner upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// SOCIAL FEED ENDPOINTS
// ============================================

app.get('/auth/feed', verifyToken, async (req, res) => {
  try {
    const tab = req.query.tab || 'public'; // 'friends' or 'public'

    let query = `
      SELECT p.id, p.user_id, p.content, p.image_url, p.likes, p.created_at,
             u.username, u.avatar_url
      FROM posts p
      JOIN users u ON p.user_id = u.id
    `;

    if (tab === 'friends') {
      query += `
        WHERE p.user_id IN (
          SELECT friend_id FROM friends WHERE user_id = $1 AND status = 'accepted'
          UNION
          SELECT user_id FROM friends WHERE friend_id = $1 AND status = 'accepted'
        )
      `;
    }

    query += ` ORDER BY p.created_at DESC LIMIT 50`;

    const result = await pool.query(query, [req.userId]);

    res.json(result.rows.map(post => ({
      id: post.id,
      userId: post.user_id,
      username: post.username,
      avatar: post.avatar_url,
      content: post.content,
      image: post.image_url,
      likes: post.likes,
      createdAt: post.created_at
    })));
  } catch (error) {
    console.error('Get feed error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/auth/posts', verifyToken, async (req, res) => {
  try {
    const { content, image_url } = req.body;

    const result = await pool.query(
      'INSERT INTO posts (user_id, content, image_url) VALUES ($1, $2, $3) RETURNING *',
      [req.userId, content, image_url]
    );

    res.status(201).json({
      id: result.rows[0].id,
      userId: result.rows[0].user_id,
      content: result.rows[0].content,
      image: result.rows[0].image_url,
      likes: result.rows[0].likes,
      createdAt: result.rows[0].created_at
    });
  } catch (error) {
    console.error('Create post error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// SERVERS ENDPOINTS
// ============================================

app.get('/auth/servers', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.id, s.creator_id, s.name, s.description, s.game_type, s.region,
             s.max_players, s.current_players, s.icon_url, s.created_at,
             u.username as creator_username
      FROM servers s
      JOIN users u ON s.creator_id = u.id
      ORDER BY s.created_at DESC
      LIMIT 50
    `);

    res.json(result.rows.map(server => ({
      id: server.id,
      creatorId: server.creator_id,
      creatorName: server.creator_username,
      name: server.name,
      description: server.description,
      gameType: server.game_type,
      region: server.region,
      maxPlayers: server.max_players,
      currentPlayers: server.current_players,
      icon: server.icon_url,
      createdAt: server.created_at
    })));
  } catch (error) {
    console.error('Get servers error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/auth/servers', verifyToken, async (req, res) => {
  try {
    const { name, description, game_type, region, max_players, icon_url } = req.body;

    const result = await pool.query(
      `INSERT INTO servers (creator_id, name, description, game_type, region, max_players, icon_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.userId, name, description, game_type, region, max_players, icon_url]
    );

    res.status(201).json({
      id: result.rows[0].id,
      creatorId: result.rows[0].creator_id,
      name: result.rows[0].name,
      description: result.rows[0].description,
      gameType: result.rows[0].game_type,
      region: result.rows[0].region,
      maxPlayers: result.rows[0].max_players,
      icon: result.rows[0].icon_url
    });
  } catch (error) {
    console.error('Create server error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/auth/servers/search', async (req, res) => {
  try {
    const { q, region, game_type } = req.query;

    let query = 'SELECT * FROM servers WHERE 1=1';
    const params = [];

    if (q) {
      query += ` AND (name ILIKE $${params.length + 1} OR description ILIKE $${params.length + 1})`;
      params.push(`%${q}%`);
    }
    if (region) {
      query += ` AND region = $${params.length + 1}`;
      params.push(region);
    }
    if (game_type) {
      query += ` AND game_type = $${params.length + 1}`;
      params.push(game_type);
    }

    query += ' ORDER BY created_at DESC LIMIT 50';

    const result = await pool.query(query, params);

    res.json(result.rows.map(server => ({
      id: server.id,
      name: server.name,
      description: server.description,
      gameType: server.game_type,
      region: server.region,
      maxPlayers: server.max_players,
      currentPlayers: server.current_players,
      icon: server.icon_url
    })));
  } catch (error) {
    console.error('Search servers error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/auth/servers/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM servers WHERE id = $1',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const server = result.rows[0];
    res.json({
      id: server.id,
      creatorId: server.creator_id,
      name: server.name,
      description: server.description,
      gameType: server.game_type,
      region: server.region,
      maxPlayers: server.max_players,
      currentPlayers: server.current_players,
      ipAddress: server.ip_address,
      port: server.port,
      icon: server.icon_url,
      createdAt: server.created_at
    });
  } catch (error) {
    console.error('Get server error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// STEAM INTEGRATION
// ============================================

app.get('/auth/steam/recent', verifyToken, async (req, res) => {
  try {
    // Mock Steam recent games - in real app, call Steam API
    const result = await pool.query(
      'SELECT steam_id FROM steam_accounts WHERE user_id = $1',
      [req.userId]
    );

    if (result.rows.length === 0) {
      return res.json({
        recentGames: [
          { name: 'Counter-Strike 2', playtime: 145, icon: 'https://via.placeholder.com/64' },
          { name: 'Dota 2', playtime: 89, icon: 'https://via.placeholder.com/64' },
          { name: 'Rust', playtime: 56, icon: 'https://via.placeholder.com/64' }
        ]
      });
    }

    // In production, use Steam API here
    res.json({
      recentGames: [
        { name: 'CS2', playtime: 145, icon: 'https://via.placeholder.com/64' },
        { name: 'Dota 2', playtime: 89, icon: 'https://via.placeholder.com/64' }
      ]
    });
  } catch (error) {
    console.error('Get Steam games error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// FRIENDS ENDPOINTS
// ============================================

app.get('/auth/friends/:userId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.username, u.avatar_url
       FROM friends f
       JOIN users u ON (f.friend_id = u.id OR f.user_id = u.id)
       WHERE (f.user_id = $1 OR f.friend_id = $1) AND f.status = 'accepted'
       AND u.id != $1`,
      [req.params.userId]
    );

    res.json(result.rows.map(friend => ({
      id: friend.id,
      username: friend.username,
      avatar: friend.avatar_url
    })));
  } catch (error) {
    console.error('Get friends error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/auth/friends/add', verifyToken, async (req, res) => {
  try {
    const { friend_id } = req.body;

    const result = await pool.query(
      `INSERT INTO friends (user_id, friend_id, status) VALUES ($1, $2, 'pending')
       ON CONFLICT (user_id, friend_id) DO NOTHING
       RETURNING *`,
      [req.userId, friend_id]
    );

    res.status(201).json({ message: 'Friend request sent', request: result.rows[0] });
  } catch (error) {
    console.error('Add friend error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/auth/friends/remove', verifyToken, async (req, res) => {
  try {
    const { friend_id } = req.body;

    await pool.query(
      `DELETE FROM friends WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)`,
      [req.userId, friend_id]
    );

    res.json({ message: 'Friend removed' });
  } catch (error) {
    console.error('Remove friend error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// MESSAGES ENDPOINTS
// ============================================

app.get('/auth/messages/:userId/:friendId', async (req, res) => {
  try {
    const { userId, friendId } = req.params;

    const result = await pool.query(
      `SELECT * FROM messages
       WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)
       ORDER BY created_at ASC`,
      [userId, friendId]
    );

    res.json(result.rows.map(msg => ({
      id: msg.id,
      senderId: msg.sender_id,
      receiverId: msg.receiver_id,
      content: msg.content,
      read: msg.read,
      createdAt: msg.created_at
    })));
  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/auth/messages', verifyToken, async (req, res) => {
  try {
    const { receiver_id, content } = req.body;

    const result = await pool.query(
      `INSERT INTO messages (sender_id, receiver_id, content) VALUES ($1, $2, $3) RETURNING *`,
      [req.userId, receiver_id, content]
    );

    res.status(201).json({
      id: result.rows[0].id,
      senderId: result.rows[0].sender_id,
      receiverId: result.rows[0].receiver_id,
      content: result.rows[0].content,
      read: result.rows[0].read,
      createdAt: result.rows[0].created_at
    });
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// SEARCH ENDPOINTS
// ============================================

app.get('/auth/users/search', async (req, res) => {
  try {
    const { q } = req.query;

    const result = await pool.query(
      `SELECT id, username, avatar_url FROM users WHERE username ILIKE $1 LIMIT 20`,
      [`%${q}%`]
    );

    res.json(result.rows.map(user => ({
      id: user.id,
      username: user.username,
      avatar: user.avatar_url
    })));
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// PUBLIC DATA ENDPOINT
// ============================================

app.get('/auth/public', async (req, res) => {
  try {
    const topServers = await pool.query(
      `SELECT id, name, current_players, max_players, icon_url FROM servers 
       ORDER BY current_players DESC LIMIT 5`
    );

    const topUsers = await pool.query(
      `SELECT id, username, avatar_url FROM users LIMIT 10`
    );

    res.json({
      topServers: topServers.rows,
      topUsers: topUsers.rows,
      totalUsers: (await pool.query('SELECT COUNT(*) FROM users')).rows[0].count,
      totalServers: (await pool.query('SELECT COUNT(*) FROM servers')).rows[0].count
    });
  } catch (error) {
    console.error('Get public data error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// HEALTH CHECK
// ============================================

app.get('/health', (req, res) => {
  res.json({ status: 'Auth server is running!' });
});

// ============================================
// START SERVER
// ============================================

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ Auth server running on port ${PORT}`);
});
