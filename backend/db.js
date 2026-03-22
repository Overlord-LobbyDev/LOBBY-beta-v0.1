const { Pool } = require('pg');
require('dotenv').config();

console.log('🔧 Initializing database connection...');
console.log('DATABASE_URL exists:', !!process.env.DATABASE_URL);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.on('error', (err) => {
  console.error('❌ Unexpected error on idle client:', err);
});

async function initializeDatabase() {
  try {
    console.log('📊 Initializing database schema...');
    
    // Drop old tables if they exist (fresh start)
    await pool.query(`DROP TABLE IF EXISTS post_likes CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS server_members CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS messages CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS friends CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS posts CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS servers CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS steam_accounts CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS users CASCADE`);

    // Create users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE,
        is_admin BOOLEAN DEFAULT FALSE,
        avatar_url TEXT,
        banner_url TEXT,
        bio TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ users table created');

    // Create steam_accounts table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS steam_accounts (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        steam_id VARCHAR(255) UNIQUE NOT NULL,
        steam_username VARCHAR(255),
        avatar_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ steam_accounts table created');

    // Create posts table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS posts (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        image_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ posts table created');

    // Create servers table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS servers (
        id SERIAL PRIMARY KEY,
        creator_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        banner_url TEXT,
        icon_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ servers table created');

    // Create friends table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS friends (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        friend_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, friend_id)
      )
    `);
    console.log('✅ friends table created');

    // Create messages table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ messages table created');

    // Create post_likes table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS post_likes (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, post_id)
      )
    `);
    console.log('✅ post_likes table created');

    // Create server_members table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS server_members (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, server_id)
      )
    `);
    console.log('✅ server_members table created');

    console.log('✅ Database initialized successfully!');
  } catch (err) {
    console.error('❌ Database initialization error:', err);
    process.exit(1);
  }
}

// Initialize on startup
initializeDatabase();

module.exports = pool;
