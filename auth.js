'use strict';
/**
 * auth.js — API-ключи пользователей + rate limiting для Swarm Cache.
 *
 * Ключи хранятся в виде SHA-256 хэшей (не в открытом виде) в data/users.db.
 * Rate limit: скользящее окно (in-memory) — RATE_LIMIT_PER_MIN запросов/мин на пользователя.
 *
 * CLI (apikey.js): add <name> | list | revoke <id>
 */
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'data', 'users.db');
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 30);

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

class UserAuth {
  constructor(dbPath = DB_PATH) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0
      );
    `);
    // окна rate limit: userId -> [timestamps]
    this.windows = new Map();
  }

  createKey(name) {
    const key = crypto.randomBytes(24).toString('base64url');
    this.db.prepare('INSERT INTO users (name, key_hash, created_at) VALUES (?,?,?)')
      .run(name, hashKey(key), Date.now());
    return { id: this.db.prepare('SELECT last_insert_rowid() id').get().id, name, key };
  }

  list() {
    return this.db.prepare('SELECT id, name, created_at, revoked FROM users ORDER BY id').all();
  }

  revoke(id) {
    const r = this.db.prepare('UPDATE users SET revoked = 1 WHERE id = ?').run(id);
    return r.changes > 0;
  }

  /** Проверка ключа: возвращает пользователя или null */
  auth(key) {
    if (!key) return null;
    const user = this.db.prepare('SELECT * FROM users WHERE key_hash = ? AND revoked = 0').get(hashKey(key));
    return user || null;
  }

  /** Rate limit: true = разрешено, false = превышен лимит */
  rateLimit(userId, now = Date.now()) {
    const windowMs = 60_000;
    let arr = this.windows.get(userId);
    if (!arr) { arr = []; this.windows.set(userId, arr); }
    // выкидываем записи старше окна
    while (arr.length && arr[0] <= now - windowMs) arr.shift();
    if (arr.length >= RATE_LIMIT_PER_MIN) return false;
    arr.push(now);
    return true;
  }
}

module.exports = { UserAuth, RATE_LIMIT_PER_MIN, DB_PATH };
