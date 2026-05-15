#!/usr/bin/env node
/**
 * Discover Lobbies Seeder
 * ──────────────────────────────────────────────────────────────────
 *
 * Creates the 13 placeholder lobbies that ship in DISCOVER_LOBBIES (in
 * index.html) as REAL server-side lobbies owned by Overlord (#1226).
 * Once seeded, the Discover panel pulls them via /lobbies/public and
 * the member counts shown in the UI become honest (no more fake stats).
 *
 * Usage:
 *   node backend/seed-discover-lobbies.js
 *   node backend/seed-discover-lobbies.js --owner 1226
 *   node backend/seed-discover-lobbies.js --owner 1226 --dry-run
 *
 * The script is IDEMPOTENT — running it twice will only update existing
 * rows that match by `discover_id`, never duplicate. Lobbies that have
 * been deleted by the owner (#1226) post-seed will be re-created on the
 * next run.
 *
 * If you want to delete them later (per the spec: "I can delete them
 * later if need be"), just delete them from the lobby list as Overlord
 * normally would, OR run this script with --delete to nuke them all.
 */

'use strict';

const path = require('path');
const args = process.argv.slice(2);
const flag = (k) => args.includes(`--${k}`);
const arg  = (k, def) => {
  const i = args.indexOf(`--${k}`);
  return (i >= 0 && args[i+1]) ? args[i+1] : def;
};

const OWNER_ID = parseInt(arg('owner', '1226'), 10);
const DRY      = flag('dry-run');
const DELETE   = flag('delete');

// ──────────────────────────────────────────────────────────────────
// Catalog — must stay in sync with DISCOVER_LOBBIES in index.html.
// `discover_id` is the stable reference key that lets re-runs find the
// existing row instead of creating a duplicate. `tags` powers the
// Discover category filter chips. `cover` / `heroHi` are CDN URLs.
// ──────────────────────────────────────────────────────────────────
const SEED_LOBBIES = [
  { discover_id:'spotlight-1', name:'Tekken Pro Circuit', tag:'fighting',
    description:'Where the Tekken 8 pros warm up. Daily ranked rooms, weekly $500 throwdowns, frame-data nerds welcome.',
    tags:['Fighting','Competitive','Verified'],
    cover:'https://cdn.cloudflare.steamstatic.com/steam/apps/1778820/header.jpg',
    heroHi:'https://cdn.cloudflare.steamstatic.com/steam/apps/1778820/library_hero.jpg',
    is_public:true, is_featured:true },

  { discover_id:'demo-1',  name:'CS2 Premier Hub', tag:'shooter',
    description:'Premier ranked grinders, daily 5-stack scrims, IGL coaching every Sunday.',
    tags:['Shooter','Ranked'],
    cover:'https://cdn.cloudflare.steamstatic.com/steam/apps/730/header.jpg',
    heroHi:'https://cdn.cloudflare.steamstatic.com/steam/apps/730/library_hero.jpg',
    is_public:true, badge:'trending' },

  { discover_id:'demo-2',  name:'Apex Squads', tag:'shooter',
    description:'Trios looking for trios. Ranked, scrims, and tournament practice.',
    tags:['Shooter','Battle Royale'],
    cover:'https://cdn.cloudflare.steamstatic.com/steam/apps/1172470/header.jpg',
    heroHi:'https://cdn.cloudflare.steamstatic.com/steam/apps/1172470/library_hero.jpg',
    is_public:true, badge:'live' },

  { discover_id:'demo-3',  name:'Street Fighter Salty', tag:'fighting',
    description:'Casual SF6 lobbies, salty ladders, set-running 24/7.',
    tags:['Fighting','Casual'],
    cover:'https://cdn.cloudflare.steamstatic.com/steam/apps/1364780/header.jpg',
    heroHi:'https://cdn.cloudflare.steamstatic.com/steam/apps/1364780/library_hero.jpg',
    is_public:true },

  { discover_id:'demo-4',  name:'Rocket League 3v3', tag:'shooter',
    description:'Open ranked queues every night, 6-mans on weekends.',
    tags:['Sports','Arcade'],
    cover:'https://cdn.cloudflare.steamstatic.com/steam/apps/252950/header.jpg',
    heroHi:'https://cdn.cloudflare.steamstatic.com/steam/apps/252950/library_hero.jpg',
    is_public:true, badge:'fresh' },

  { discover_id:'demo-5',  name:'Valorant Ranked Hub', tag:'shooter',
    description:'5-stack queues, IGL nights, agent-comp workshops.',
    tags:['Shooter','Ranked'],
    cover:'',
    is_public:true, badge:'trending' },

  { discover_id:'demo-6',  name:'Smash Bros Weekly', tag:'fighting',
    description:'Friday-night brackets, training-mode tips, Melee & Ultimate.',
    tags:['Fighting','Tournaments'],
    cover:'',
    is_public:true },

  { discover_id:'demo-7',  name:'League of Legends LCQ', tag:'strategy',
    description:'5-stack ranked, scrim partners, coach-led VOD reviews.',
    tags:['MOBA','Competitive'],
    cover:'',
    is_public:true },

  { discover_id:'demo-8',  name:'StarCraft GMs', tag:'strategy',
    description:'1v1 ladder grind, tournament practice, BO matches every week.',
    tags:['Strategy','RTS'],
    cover:'',
    is_public:true },

  { discover_id:'demo-9',  name:'Indie Game Night', tag:'indie',
    description:'A different indie multiplayer every Friday. Cult classics & hidden gems.',
    tags:['Indie','Co-op'],
    cover:'',
    is_public:true, badge:'fresh' },

  { discover_id:'demo-10', name:'Couch Co-op Chill', tag:'casual',
    description:'No ranked, no toxicity. Co-op nights, movie watch-alongs, just hanging out.',
    tags:['Casual','Chill'],
    cover:'',
    is_public:true },

  { discover_id:'demo-11', name:'EA FC Pro Clubs', tag:'shooter',
    description:'Pro Clubs squads recruiting all positions. Division 1 grinders.',
    tags:['Sports','Pro Clubs'],
    cover:'https://cdn.cloudflare.steamstatic.com/steam/apps/2669320/header.jpg',
    heroHi:'https://cdn.cloudflare.steamstatic.com/steam/apps/2669320/library_hero.jpg',
    is_public:true },

  { discover_id:'demo-12', name:'Warzone Trio Grind', tag:'shooter',
    description:'Nightly trios, ranked grinders, gulag tactics breakdowns.',
    tags:['Shooter','Battle Royale'],
    cover:'https://cdn.cloudflare.steamstatic.com/steam/apps/1938090/header.jpg',
    heroHi:'https://cdn.cloudflare.steamstatic.com/steam/apps/1938090/library_hero.jpg',
    is_public:true },
];

// ──────────────────────────────────────────────────────────────────
// DB layer — adapts to whatever client this server uses. The
// existing repo has a `db.js` module — we require it dynamically and
// call generic queries.
// ──────────────────────────────────────────────────────────────────
let db;
try { db = require('./db.js'); }
catch (e) {
  console.error('[seed] Could not require ./db.js — make sure you run this from the backend/ directory or fix the path.');
  console.error(e.message);
  process.exit(1);
}

async function query(sql, params = []) {
  if (typeof db.query === 'function') return db.query(sql, params);
  if (typeof db.run   === 'function') return db.run(sql, params);     // SQLite-style
  throw new Error('No query/run method found on db.js — adapt this script to your DB client.');
}

async function ensureColumn() {
  // Idempotent — adds discover_id, is_featured, badge columns if missing.
  // Postgres syntax; for SQLite the ADD COLUMN equivalent is similar.
  const stmts = [
    `ALTER TABLE servers ADD COLUMN IF NOT EXISTS discover_id  TEXT UNIQUE`,
    `ALTER TABLE servers ADD COLUMN IF NOT EXISTS description  TEXT`,
    `ALTER TABLE servers ADD COLUMN IF NOT EXISTS cover        TEXT`,
    `ALTER TABLE servers ADD COLUMN IF NOT EXISTS hero_hi      TEXT`,
    `ALTER TABLE servers ADD COLUMN IF NOT EXISTS tag          TEXT`,
    `ALTER TABLE servers ADD COLUMN IF NOT EXISTS tags         JSONB`,
    `ALTER TABLE servers ADD COLUMN IF NOT EXISTS is_public    BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE servers ADD COLUMN IF NOT EXISTS is_featured  BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE servers ADD COLUMN IF NOT EXISTS badge        TEXT`,
  ];
  for (const s of stmts) {
    try { await query(s); }
    catch (e) {
      // SQLite doesn't support `ADD COLUMN IF NOT EXISTS` — fall back.
      const fallback = s.replace(/ADD COLUMN IF NOT EXISTS/i, 'ADD COLUMN');
      try { await query(fallback); } catch (_) { /* column already exists */ }
    }
  }
}

async function findExisting(discoverId) {
  const r = await query('SELECT id, owner_id FROM servers WHERE discover_id = $1', [discoverId])
    .catch(() => null);
  if (!r) return null;
  if (Array.isArray(r))      return r[0] || null;
  if (Array.isArray(r.rows)) return r.rows[0] || null;
  return r;
}

async function seedOne(lobby) {
  const existing = await findExisting(lobby.discover_id);
  if (existing) {
    if (DRY) {
      console.log(`[seed] (dry-run) UPDATE existing #${existing.id} — ${lobby.name}`);
      return { action: 'update', id: existing.id };
    }
    await query(
      `UPDATE servers
          SET name = $1, tag = $2, tags = $3, description = $4,
              cover = $5, hero_hi = $6, is_public = $7,
              is_featured = $8, badge = $9
        WHERE id = $10`,
      [
        lobby.name, lobby.tag, JSON.stringify(lobby.tags||[]), lobby.description,
        lobby.cover||'', lobby.heroHi||'', !!lobby.is_public,
        !!lobby.is_featured, lobby.badge||null, existing.id,
      ]
    );
    return { action: 'updated', id: existing.id };
  }
  if (DRY) {
    console.log(`[seed] (dry-run) INSERT new — ${lobby.name}`);
    return { action: 'insert' };
  }
  const r = await query(
    `INSERT INTO servers
       (name, owner_id, tag, tags, description, cover, hero_hi,
        is_public, is_featured, badge, discover_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
     RETURNING id`,
    [
      lobby.name, OWNER_ID, lobby.tag, JSON.stringify(lobby.tags||[]),
      lobby.description, lobby.cover||'', lobby.heroHi||'',
      !!lobby.is_public, !!lobby.is_featured, lobby.badge||null,
      lobby.discover_id,
    ]
  );
  const rowId = (r && (r.rows ? r.rows[0]?.id : (Array.isArray(r) ? r[0]?.id : r.id))) || null;
  // Add the owner as the first member (roles table varies by app — adapt).
  if (rowId) {
    try {
      await query(
        `INSERT INTO server_members (server_id, user_id, role, joined_at)
         VALUES ($1, $2, 'owner', NOW())
         ON CONFLICT (server_id, user_id) DO NOTHING`,
        [rowId, OWNER_ID]
      );
    } catch (e) { /* role table may not exist — OK */ }
    // Seed default channels (#announcements, #general, voice "General Voice")
    try {
      await query(
        `INSERT INTO channels (server_id, name, type, position) VALUES
           ($1, 'announcements', 'announcement', 0),
           ($1, 'general',       'text',         1),
           ($1, 'general voice', 'voice',        2)
         ON CONFLICT DO NOTHING`,
        [rowId]
      );
    } catch (e) { /* channels table may not exist — OK */ }
  }
  return { action: 'created', id: rowId };
}

async function deleteAll() {
  console.log('[seed] DELETE mode — removing every Discover-seeded lobby.');
  for (const l of SEED_LOBBIES) {
    if (DRY) { console.log(`  (dry-run) would delete ${l.discover_id}`); continue; }
    try {
      await query(`DELETE FROM servers WHERE discover_id = $1 AND owner_id = $2`, [l.discover_id, OWNER_ID]);
      console.log(`  deleted ${l.discover_id}`);
    } catch (e) { console.error(`  failed to delete ${l.discover_id}:`, e.message); }
  }
}

(async function main() {
  console.log(`[seed] Discover lobby seeder — owner: ${OWNER_ID}${DRY ? ' (dry-run)' : ''}`);
  await ensureColumn();
  if (DELETE) { await deleteAll(); process.exit(0); }
  let created = 0, updated = 0;
  for (const lobby of SEED_LOBBIES) {
    try {
      const r = await seedOne(lobby);
      if (r.action === 'created' || r.action === 'insert') created++;
      else if (r.action === 'updated' || r.action === 'update') updated++;
      console.log(`  ${r.action.padEnd(7)} #${r.id||'—'} — ${lobby.name}`);
    } catch (e) {
      console.error(`  FAILED ${lobby.discover_id}:`, e.message);
    }
  }
  console.log(`[seed] Done. ${created} created, ${updated} updated.`);
  console.log(`[seed] Discover panel will now show real member counts on the next page open.`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
