require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function addPasswordColumn() {
  try {
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS password TEXT NOT NULL DEFAULT '';
    `);
    console.log("✅ Password column added");
    
    // Also make sure all columns exist
    const alters = [
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT DEFAULT NULL",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT FALSE",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_until TIMESTAMPTZ DEFAULT NULL",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason TEXT DEFAULT NULL",
    ];
    
    for (const sql of alters) {
      await pool.query(sql);
    }
    console.log("✅ All columns verified");
    process.exit(0);
  } catch (err) {
    console.error("❌ Error:", err);
    process.exit(1);
  }
}

addPasswordColumn();
