// backend/cache.js — In-memory TTL cache for leaderboard data
// Interface mirrors Redis get/set/del so swapping to Redis later is one-liner:
//   module.exports = require('./redis-client');
//
// Usage:
//   const cache = require('./cache');
//   await cache.set('key', value, 60_000);  // TTL in ms
//   const v = await cache.get('key');        // null if missing/expired
//   await cache.del('key');
//   await cache.flush('lb:');               // delete all keys with prefix
'use strict';

class MemoryCache {
  constructor({ defaultTtl = 60_000, maxEntries = 5_000 } = {}) {
    this.defaultTtl = defaultTtl;
    this.maxEntries = maxEntries;
    this.store      = new Map();   // key → { value, exp }
  }

  async get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.exp) { this.store.delete(key); return null; }
    return entry.value;
  }

  async set(key, value, ttlMs) {
    const exp = Date.now() + (ttlMs ?? this.defaultTtl);
    this.store.set(key, { value, exp });
    // Lazy eviction: if we're over capacity, remove the 20% oldest entries.
    if (this.store.size > this.maxEntries) this._evict();
  }

  async del(key) {
    this.store.delete(key);
  }

  // Flush all keys that start with `prefix`.  No prefix = flush everything.
  async flush(prefix) {
    if (!prefix) { this.store.clear(); return; }
    for (const k of this.store.keys()) {
      if (k.startsWith(prefix)) this.store.delete(k);
    }
  }

  // Remove expired entries + oldest ~20% of remaining if still over limit.
  _evict() {
    const now = Date.now();
    for (const [k, v] of this.store) {
      if (now > v.exp) this.store.delete(k);
    }
    if (this.store.size > this.maxEntries) {
      const keys = [...this.store.keys()];
      const remove = Math.ceil(this.maxEntries * 0.2);
      for (let i = 0; i < remove && i < keys.length; i++) {
        this.store.delete(keys[i]);
      }
    }
  }
}

// Export singleton — shared across the whole process.
module.exports = new MemoryCache({ defaultTtl: 60_000, maxEntries: 5_000 });
