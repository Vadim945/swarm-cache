'use strict';
/**
 * billing.js — пользовательский биллинг Swarm Cache (рубли/единицы).
 *
 * Модель (лестница монетизации, шаг 2):
 *   - генерация (LLM):   1.0 ед
 *   - кэш-хит:           0.1 ед   ← фишка: кэш в 10 раз дешевле генерации
 * Баланс хранится в data/users.db (таблица user_balances: user_id, credits REAL),
 * защита от отрицательного баланса, журнал user_billing_log.
 *
 * CLI:
 *   node billing.js credit <userId> <amount>   — начислить/пополнить
 *   node billing.js list                       — балансы всех пользователей
 *   node billing.js price                      — показать тарифы
 */
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'data', 'users.db');
const GEN_COST = Number(process.env.GEN_COST || 1.0);      // единиц за генерацию
const CACHE_COST = Number(process.env.CACHE_COST || 0.1);  // единиц за кэш-хит
const MIN_COST = Math.min(GEN_COST, CACHE_COST);
const FREE_BONUS = Number(process.env.FREE_BONUS || 10.0); // стартовый бонус бета-ключам

class Billing {
  constructor(dbPath = DB_PATH) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_balances (
        user_id INTEGER PRIMARY KEY,
        credits REAL NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_billing_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        delta REAL NOT NULL,
        kind TEXT NOT NULL,          -- 'bonus' | 'credit' | 'charge'
        note TEXT,
        ts INTEGER NOT NULL
      );
    `);
  }

  getBalance(userId) {
    const r = this.db.prepare('SELECT credits FROM user_balances WHERE user_id = ?').get(userId);
    return r ? r.credits : 0;
  }

  /** Начисление (бонус/пополнение). Возвращает новый баланс. */
  credit(userId, amount, note = 'credit') {
    if (amount <= 0) throw new Error('amount must be > 0');
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO user_balances (user_id, credits, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET credits = credits + excluded.credits, updated_at = excluded.updated_at
    `).run(userId, amount, now);
    this.db.prepare('INSERT INTO user_billing_log (user_id, delta, kind, note, ts) VALUES (?,?,?,?,?)')
      .run(userId, amount, note, note, now);
    return this.getBalance(userId);
  }

  /** Списание с защитой от минуса. Возвращает {ok, balance} или {ok:false, reason}. */
  debit(userId, amount, note = 'charge') {
    if (amount <= 0) return { ok: true, balance: this.getBalance(userId) };
    const bal = this.getBalance(userId);
    if (bal < amount) return { ok: false, reason: 'insufficient balance', balance: bal, need: amount };
    const now = Date.now();
    this.db.prepare('UPDATE user_balances SET credits = credits - ?, updated_at = ? WHERE user_id = ?')
      .run(amount, now, userId);
    this.db.prepare('INSERT INTO user_billing_log (user_id, delta, kind, note, ts) VALUES (?,?,?,?,?)')
      .run(userId, -amount, 'charge', note, now);
    return { ok: true, balance: this.getBalance(userId) };
  }

  /** Списывает по факту: cached → CACHE_COST, иначе GEN_COST. */
  charge(userId, cached) {
    return this.debit(userId, cached ? CACHE_COST : GEN_COST, cached ? 'cache hit' : 'llm generation');
  }

  list() {
    return this.db.prepare(`
      SELECT u.id, u.name, u.revoked, COALESCE(b.credits, 0) AS credits
      FROM users u LEFT JOIN user_balances b ON b.user_id = u.id
      ORDER BY u.id
    `).all();
  }

  log(userId, limit = 15) {
    return this.db.prepare('SELECT * FROM user_billing_log WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit);
  }
}

module.exports = { Billing, GEN_COST, CACHE_COST, MIN_COST, FREE_BONUS };
