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
const REFERRAL_BONUS = Number(process.env.REFERRAL_BONUS || 2.0);        // бонус за приглашение (обоим)
const REFERRAL_MAX_PER_DAY = Number(process.env.REFERRAL_MAX_PER_DAY || 5); // лимит начислений рефереру/сутки

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
      CREATE TABLE IF NOT EXISTS user_referrals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL UNIQUE,
        referred_by INTEGER NOT NULL,
        bonus REAL NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS redeem_codes (
        code TEXT PRIMARY KEY,
        credits REAL NOT NULL,
        used_by INTEGER,
        used_at INTEGER,
        created_at INTEGER NOT NULL
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

  /**
   * Реферальная программа: новый пользователь регистрируется с кодом пригласившего.
   * Обоим начисляется REFERRAL_BONUS. Защита: само-рефералка, повторные начисления,
   * лимит начислений рефереру в сутки.
   */
  applyReferral(newUserId, refCode) {
    if (!refCode || typeof refCode !== 'string') return { ok: false, reason: 'empty ref code' };
    const referrer = this.db.prepare('SELECT id FROM users WHERE ref_code = ? AND revoked = 0').get(refCode.trim());
    if (!referrer) return { ok: false, reason: 'invalid ref code' };
    if (referrer.id === newUserId) return { ok: false, reason: 'self referral not allowed' };
    const exists = this.db.prepare('SELECT id FROM user_referrals WHERE user_id = ?').get(newUserId);
    if (exists) return { ok: false, reason: 'already referred' };
    const dayAgo = Date.now() - 24 * 3600 * 1000;
    const cnt = this.db.prepare('SELECT COUNT(*) c FROM user_referrals WHERE referred_by = ? AND ts > ?')
      .get(referrer.id, dayAgo).c;
    if (cnt >= REFERRAL_MAX_PER_DAY) return { ok: false, reason: 'referrer daily limit reached' };
    this.credit(newUserId, REFERRAL_BONUS, 'referral bonus (invited)');
    this.credit(referrer.id, REFERRAL_BONUS, 'referral reward (new user via ref)');
    this.db.prepare('INSERT INTO user_referrals (user_id, referred_by, bonus, ts) VALUES (?,?,?,?)')
      .run(newUserId, referrer.id, REFERRAL_BONUS, Date.now());
    return { ok: true, bonus: REFERRAL_BONUS, referrer_id: referrer.id, referrer_balance: this.getBalance(referrer.id) };
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

  /* ---- промо-коды пополнения (монетизация) ---- */

  createRedeemCode(credits, count = 1) {
    const crypto = require('crypto');
    const codes = [];
    const stmt = this.db.prepare('INSERT OR IGNORE INTO redeem_codes (code, credits, used_by, used_at, created_at) VALUES (?,?,NULL,NULL,?)');
    for (let i = 0; i < count; i++) {
      const code = 'SW-' + crypto.randomBytes(4).toString('hex').toUpperCase();
      stmt.run(code, credits, Date.now());
      codes.push(code);
    }
    return codes;
  }

  redeemCode(userId, code) {
    const c = this.db.prepare('SELECT * FROM redeem_codes WHERE code = ?').get(String(code).trim().toUpperCase());
    if (!c) return { ok: false, reason: 'invalid code' };
    if (c.used_by) return { ok: false, reason: 'code already used' };
    this.credit(userId, c.credits, 'redeem code ' + c.code);
    this.db.prepare('UPDATE redeem_codes SET used_by = ?, used_at = ? WHERE code = ?').run(userId, Date.now(), c.code);
    return { ok: true, credits: c.credits, balance: this.getBalance(userId) };
  }

  redeemStats() {
    return this.db.prepare(`
      SELECT COUNT(*) total, COALESCE(SUM(CASE WHEN used_by IS NOT NULL THEN credits END), 0) used_credits,
             COUNT(used_by) used_count FROM redeem_codes
    `).get();
  }
}

/* ---- CLI ---- */
if (process.argv[1] && process.argv[1].endsWith('billing.js')) {
  const [,, cmd, a, b] = process.argv;
  const billing = new Billing();
  switch (cmd) {
    case 'credit':
      billing.credit(Number(a), Number(b));
      console.log('OK, balance:', billing.getBalance(Number(a)));
      break;
    case 'redeem-gen': {
      const codes = billing.createRedeemCode(Number(a), Number(b || 1));
      console.log(codes.join('\n'));
      break;
    }
    case 'redeem-stats':
      console.log(billing.redeemStats());
      break;
    case 'price':
      console.log({ GEN_COST, CACHE_COST, FREE_BONUS, REFERRAL_BONUS });
      break;
    default:
      console.log('Usage: billing.js credit <userId> <amount> | redeem-gen <credits> [count] | redeem-stats | price');
  }
}

module.exports = { Billing, GEN_COST, CACHE_COST, MIN_COST, FREE_BONUS, REFERRAL_BONUS };
