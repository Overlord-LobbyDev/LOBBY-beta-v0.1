const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const path = require('path');

// Import database pool
const pool = require('./db');

// Cloudinary configuration
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Multer setup for memory storage (files go to Cloudinary, not disk)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB max
});

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
// Get current user's friends (authenticated)
app.get('/auth/friends', verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query(
      `SELECT u.id, u.username, u.avatar_url, u.status, u.banner_colour, u.is_private FROM friends f
       JOIN users u ON f.friend_id = u.id
       WHERE f.user_id = $1 AND f.status = 'accepted'`,
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

// ============ FRIEND INVITES/REQUESTS ============

// Send friend request (creates pending friendship)
app.post('/auth/friends/request', verifyToken, async (req, res) => {
  const { friendId } = req.body;
  if (!friendId || friendId === req.userId) return res.status(400).json({ error: 'Invalid user' });
  try {
    const result = await pool.query(
      "INSERT INTO friends (user_id, friend_id, status) VALUES ($1, $2, 'pending') ON CONFLICT DO NOTHING RETURNING id",
      [req.userId, friendId]
    );
    const friendRequestId = result.rows[0]?.id;
    res.json({ success: true, id: friendRequestId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Accept friend request
app.patch('/auth/friends/:id/accept', verifyToken, async (req, res) => {
  try {
    await pool.query(
      "UPDATE friends SET status = 'accepted' WHERE id = $1 AND friend_id = $2",
      [req.params.id, req.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Decline friend request
app.patch('/auth/friends/:id/decline', verifyToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM friends WHERE id = $1 AND friend_id = $2', [req.params.id, req.userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Block user
app.post('/auth/friends/block', verifyToken, async (req, res) => {
  const { blockId } = req.body;
  try {
    await pool.query(
      `INSERT INTO friends (user_id, friend_id, status) VALUES ($1, $2, 'blocked')
       ON CONFLICT (user_id, friend_id) DO UPDATE SET status = 'blocked'`,
      [req.userId, blockId]
    );
    res.json({ success: true });
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
    const limit = req.query.limit || 10;
    const page = req.query.page || 0;
    const offset = page * limit;
    
    let query;
    let params = [req.userId];

    if (tab === 'friends') {
      query = `SELECT p.id, p.content, p.image_url, p.visibility, p.created_at, 
                      u.id as user_id, u.username, u.avatar_url, u.avatar_url as avatarUrl,
                      COALESCE(json_agg(DISTINCT ct.tag) FILTER (WHERE ct.tag IS NOT NULL), '[]'::json) as community_tags,
                      (SELECT COUNT(*) FROM post_likes WHERE post_id = p.id) as like_count,
                      (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) as comment_count,
                      EXISTS(SELECT 1 FROM post_likes WHERE post_id = p.id AND user_id = $1) as liked_by_me
               FROM posts p
               JOIN users u ON p.user_id = u.id
               LEFT JOIN post_community_tags ct ON p.id = ct.post_id
               WHERE p.user_id IN (SELECT friend_id FROM friends WHERE user_id = $1 AND status = 'accepted')
                  OR p.user_id = $1
               GROUP BY p.id, u.id
               ORDER BY p.created_at DESC
               LIMIT $2 OFFSET $3`;
      params.push(limit, offset);
    } else if (tab === 'public') {
      query = `SELECT p.id, p.content, p.image_url, p.visibility, p.created_at, 
                      u.id as user_id, u.username, u.avatar_url, u.avatar_url as avatarUrl,
                      COALESCE(json_agg(DISTINCT ct.tag) FILTER (WHERE ct.tag IS NOT NULL), '[]'::json) as community_tags,
                      (SELECT COUNT(*) FROM post_likes WHERE post_id = p.id) as like_count,
                      (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) as comment_count,
                      EXISTS(SELECT 1 FROM post_likes WHERE post_id = p.id AND user_id = $1) as liked_by_me
               FROM posts p
               JOIN users u ON p.user_id = u.id
               LEFT JOIN post_community_tags ct ON p.id = ct.post_id
               WHERE p.visibility = 'public'
               GROUP BY p.id, u.id
               ORDER BY p.created_at DESC
               LIMIT $2 OFFSET $3`;
      params.push(limit, offset);
    } else {
      // communities tab - posts with community tags
      query = `SELECT p.id, p.content, p.image_url, p.visibility, p.created_at, 
                      u.id as user_id, u.username, u.avatar_url, u.avatar_url as avatarUrl,
                      COALESCE(json_agg(DISTINCT ct.tag) FILTER (WHERE ct.tag IS NOT NULL), '[]'::json) as community_tags,
                      (SELECT COUNT(*) FROM post_likes WHERE post_id = p.id) as like_count,
                      (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) as comment_count,
                      EXISTS(SELECT 1 FROM post_likes WHERE post_id = p.id AND user_id = $1) as liked_by_me
               FROM posts p
               JOIN users u ON p.user_id = u.id
               LEFT JOIN post_community_tags ct ON p.id = ct.post_id
               WHERE ct.tag IS NOT NULL
               GROUP BY p.id, u.id
               ORDER BY p.created_at DESC
               LIMIT $2 OFFSET $3`;
      params.push(limit, offset);
    }

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Feed error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Helper function to upload to Cloudinary
async function uploadToCloudinary(fileBuffer, folder) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder: `lobby/${folder}` },
      (error, result) => {
        if (error) reject(error);
        else resolve(result.secure_url);
      }
    );
    uploadStream.end(fileBuffer);
  });
}

// Create post
app.post('/auth/posts', verifyToken, upload.single('image'), async (req, res) => {
  try {
    const { content } = req.body;
    let imageUrl = null;

    if (req.file) {
      imageUrl = await uploadToCloudinary(req.file.buffer, 'posts');
    }

    const dbResult = await pool.query(
      'INSERT INTO posts (user_id, content, image_url) VALUES ($1, $2, $3) RETURNING *',
      [req.userId, content, imageUrl]
    );
    res.status(201).json(dbResult.rows[0]);
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
    let bannerUrl = null;
    if (req.file) {
      bannerUrl = await uploadToCloudinary(req.file.buffer, 'servers');
    }
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
    let iconUrl = null;
    if (req.file) {
      iconUrl = await uploadToCloudinary(req.file.buffer, 'servers');
    }
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

// ============ SERVER MEMBERSHIP ============

// Join a server
app.post('/auth/servers/:serverId/join', verifyToken, async (req, res) => {
  try {
    const { serverId } = req.params;
    const userId = req.userId;

    // Check if server exists
    const serverCheck = await pool.query('SELECT id FROM servers WHERE id = $1', [serverId]);
    if (serverCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Server not found' });
    }

    // Check if user is already a member
    const memberCheck = await pool.query(
      'SELECT id FROM server_members WHERE server_id = $1 AND user_id = $2',
      [serverId, userId]
    );
    if (memberCheck.rows.length > 0) {
      return res.status(400).json({ error: 'Already a member of this server' });
    }

    // Add user to server_members
    const result = await pool.query(
      'INSERT INTO server_members (server_id, user_id) VALUES ($1, $2) RETURNING *',
      [serverId, userId]
    );

    res.json({ success: true, membership: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Leave a server
app.delete('/auth/servers/:serverId/leave', verifyToken, async (req, res) => {
  try {
    const { serverId } = req.params;
    const userId = req.userId;

    // Check if server exists
    const serverCheck = await pool.query('SELECT id FROM servers WHERE id = $1', [serverId]);
    if (serverCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Server not found' });
    }

    // Remove user from server_members
    const result = await pool.query(
      'DELETE FROM server_members WHERE server_id = $1 AND user_id = $2 RETURNING *',
      [serverId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Not a member of this server' });
    }

    res.json({ success: true, message: 'Left the server' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get server members
app.get('/auth/servers/:serverId/members', async (req, res) => {
  try {
    const { serverId } = req.params;

    // Check if server exists
    const serverCheck = await pool.query('SELECT id FROM servers WHERE id = $1', [serverId]);
    if (serverCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Server not found' });
    }

    // Get all members with user details
    const result = await pool.query(
      `SELECT u.id, u.username, u.avatar_url, u.status, sm.joined_at
       FROM server_members sm
       JOIN users u ON sm.user_id = u.id
       WHERE sm.server_id = $1
       ORDER BY sm.joined_at DESC`,
      [serverId]
    );

    res.json({ success: true, members: result.rows, count: result.rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ SERVER INVITES ============

// Get all pending server invites for logged-in user
app.get('/auth/me/invites', verifyToken, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT si.id, si.server_id, si.created_at,
             s.name AS server_name, s.icon_url AS server_icon,
             u.username AS inviter_username, u.id AS inviter_id,
             u.avatar_url AS inviter_avatar
      FROM server_invites si
      JOIN servers s ON s.id = si.server_id
      JOIN users u ON u.id = si.inviter_id
      WHERE si.invitee_id = $1
      ORDER BY si.created_at DESC
    `, [req.userId]);
    res.json(r.rows);
  } catch (e) {
    console.error('[/me/invites]', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Invite user to server
app.post('/auth/servers/:id/invite', verifyToken, async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    // Inviter must be a member of the server
    const membership = await pool.query(
      'SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    if (!membership.rows.length) return res.status(403).json({ error: 'You are not in this server' });

    // Don't invite someone already in the server
    const already = await pool.query(
      'SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2',
      [req.params.id, userId]
    );
    if (already.rows.length) return res.status(409).json({ error: 'User is already in this server' });

    // Store as a pending invite — recipient must accept
    const inviteResult = await pool.query(
      'INSERT INTO server_invites (server_id, inviter_id, invitee_id) VALUES ($1, $2, $3) ON CONFLICT (server_id, invitee_id) DO NOTHING RETURNING id',
      [req.params.id, req.userId, userId]
    );
    const inviteId = inviteResult.rows[0]?.id;
    res.json({ success: true, id: inviteId });
  } catch (e) {
    console.error('[/servers/invite]', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Accept server invite
app.post('/auth/servers/:id/accept-invite', verifyToken, async (req, res) => {
  try {
    const invite = await pool.query(
      'SELECT id FROM server_invites WHERE server_id = $1 AND invitee_id = $2',
      [req.params.id, req.userId]
    );
    if (!invite.rows.length) return res.status(404).json({ error: 'No pending invite found' });

    await pool.query(
      "INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING",
      [req.params.id, req.userId]
    );
    await pool.query(
      'DELETE FROM server_invites WHERE server_id = $1 AND invitee_id = $2',
      [req.params.id, req.userId]
    );
    res.json({ success: true });
  } catch (e) {
    console.error('[/servers/accept-invite]', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Decline server invite
app.post('/auth/servers/:id/decline-invite', verifyToken, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM server_invites WHERE server_id = $1 AND invitee_id = $2',
      [req.params.id, req.userId]
    );
    res.json({ success: true });
  } catch (e) {
    console.error('[/servers/decline-invite]', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ PROFILE UPLOADS ============

// Upload avatar
app.post('/auth/avatar', verifyToken, upload.single('avatar'), async (req, res) => {
  try {
    let avatarUrl = null;
    if (req.file) {
      avatarUrl = await uploadToCloudinary(req.file.buffer, 'avatars');
    }
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
    let bannerUrl = null;
    if (req.file) {
      bannerUrl = await uploadToCloudinary(req.file.buffer, 'banners');
    }
    const result = await pool.query(
      'UPDATE users SET banner_url = $1 WHERE id = $2 RETURNING *',
      [bannerUrl, req.userId]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update user profile (banner colour, bio, status, etc)
app.patch('/auth/profile', verifyToken, async (req, res) => {
  try {
    const { bannerColour, bio, status, is_private } = req.body;
    let updateFields = [];
    let updateValues = [];
    let paramCount = 1;

    if (bannerColour !== undefined) {
      updateFields.push(`banner_colour = $${paramCount}`);
      updateValues.push(bannerColour);
      paramCount++;
    }
    if (bio !== undefined) {
      updateFields.push(`bio = $${paramCount}`);
      updateValues.push(bio);
      paramCount++;
    }
    if (status !== undefined) {
      updateFields.push(`status = $${paramCount}`);
      updateValues.push(status);
      paramCount++;
    }
    if (is_private !== undefined) {
      updateFields.push(`is_private = $${paramCount}`);
      updateValues.push(is_private);
      paramCount++;
    }

    if (updateFields.length === 0) {
      return res.json({ success: false, error: 'No fields to update' });
    }

    updateValues.push(req.userId);
    const query = `UPDATE users SET ${updateFields.join(', ')} WHERE id = $${paramCount} RETURNING *`;
    const result = await pool.query(query, updateValues);
    
    if (result.rows.length === 0) {
      return res.json({ success: false, error: 'User not found' });
    }
    res.json({ success: true, ...result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Generic upload endpoint
app.post('/auth/upload', verifyToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    const url = await uploadToCloudinary(req.file.buffer, 'files');
    res.json({ url: url, filename: req.file.originalname });
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

// ── Likes ────────────────────────────────────────────────────
app.post('/auth/posts/:postId/like', verifyToken, async (req, res) => {
  try {
    const { postId } = req.params;
    
    // Check if post exists
    const postCheck = await pool.query('SELECT id FROM posts WHERE id = $1', [postId]);
    if (postCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }

    // Try to insert like (will fail if already liked due to UNIQUE constraint)
    try {
      await pool.query(
        'INSERT INTO post_likes (user_id, post_id) VALUES ($1, $2)',
        [req.userId, postId]
      );
      res.json({ success: true, liked: true });
    } catch (err) {
      // Already liked - return success anyway
      if (err.code === '23505') {
        return res.json({ success: true, liked: true });
      }
      throw err;
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/auth/posts/:postId/like', verifyToken, async (req, res) => {
  try {
    const { postId } = req.params;
    await pool.query(
      'DELETE FROM post_likes WHERE user_id = $1 AND post_id = $2',
      [req.userId, postId]
    );
    res.json({ success: true, liked: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Delete Post ──────────────────────────────────────────────────
app.delete('/auth/posts/:postId', verifyToken, async (req, res) => {
  try {
    const { postId } = req.params;
    const userId = req.userId;

    // Check if post exists and user is the owner
    const postCheck = await pool.query('SELECT user_id FROM posts WHERE id = $1', [postId]);
    if (postCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }

    if (postCheck.rows[0].user_id !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Delete associated likes and comments first
    await pool.query('DELETE FROM post_likes WHERE post_id = $1', [postId]);
    await pool.query('DELETE FROM post_comments WHERE post_id = $1', [postId]);

    // Delete the post
    await pool.query('DELETE FROM posts WHERE id = $1', [postId]);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Comments ────────────────────────────────────────────────────
app.post('/auth/posts/:postId/comments', verifyToken, async (req, res) => {
  try {
    const { postId } = req.params;
    const { content } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Comment content required' });
    }

    // Check if post exists
    const postCheck = await pool.query('SELECT id FROM posts WHERE id = $1', [postId]);
    if (postCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const result = await pool.query(
      'INSERT INTO post_comments (post_id, user_id, content) VALUES ($1, $2, $3) RETURNING id, created_at',
      [postId, req.userId, content]
    );

    res.json({
      id: result.rows[0].id,
      post_id: postId,
      user_id: req.userId,
      content: content,
      created_at: result.rows[0].created_at
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/auth/posts/:postId/comments', async (req, res) => {
  try {
    const { postId } = req.params;
    const result = await pool.query(
      `SELECT pc.id, pc.post_id, pc.user_id, pc.content, pc.created_at, u.username, u.avatar_url
       FROM post_comments pc
       JOIN users u ON pc.user_id = u.id
       WHERE pc.post_id = $1
       ORDER BY pc.created_at DESC`,
      [postId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Spotlight: Trending posts from last 48 hours ────────────────────────────────────────────────────
app.get('/auth/spotlight', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
        p.id, p.user_id, p.content, p.image_url, p.visibility, p.created_at,
        u.username, u.avatar_url,
        (SELECT COUNT(*) FROM post_likes WHERE post_id = p.id)::INT as like_count,
        (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id)::INT as comment_count,
        (SELECT EXISTS(SELECT 1 FROM post_likes WHERE post_id = p.id AND user_id = $1))::BOOLEAN as liked_by_me,
        (
          SELECT COALESCE(json_agg(json_build_object('tag', tag)), '[]'::json)
          FROM post_community_tags 
          WHERE post_id = p.id
        ) as community_tags
       FROM posts p
       JOIN users u ON p.user_id = u.id
       WHERE p.visibility = 'public'
         AND p.created_at > NOW() - INTERVAL '48 hours'
       ORDER BY (
         (SELECT COUNT(*) FROM post_likes WHERE post_id = p.id) +
         (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) * 2
       ) DESC
       LIMIT 10`,
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