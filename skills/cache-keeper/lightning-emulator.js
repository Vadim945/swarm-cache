'use strict';
/**
 * lightning-emulator.js — эмулятор микроплатежей Lightning/L402 (MVP, Фаза 5).
 *
 * Хранит балансы агентов в SQLite (таблица balances: agent_id, balance_sats),
 * ведёт журнал транзакций (tx_log) и payments.log, защищает от отрицательного
 * баланса. Позже заменяется на gRPC-клиент к LND (порт 10009 уже открыт в UFW).
 *
 * API:
 *   new LightningEmulator(db, logPath)
 *   emu.ensureAgent(agentId, initialSats)
 *   emu.getBalance(agentId)          -> number|null
 *   emu.pay(senderId, receiverId, sats, note)  -> {ok, ...}
 *   emu.payToAuthor(authorId, sats, note)      -> pay(own, author | network_reward)
 *   emu.txCount()                    -> number
 *   emu.allBalances()                -> [{agent, balance}]
 *
 * CLI:
 *   node lightning-emulator.js balance [agent]
 *   node lightning-emulator.js pay <from> <to> <sats> [note]
 */

const fs = require('fs');

const OWN_AGENT = 'local';
const NETWORK_REWARD_ACCOUNT = 'network_reward';
const INITIAL_BALANCE = 1000;

class LightningEmulator {
  constructor(db, logPath) {
    this.db = db;
    this.logPath = logPath;
    this.ensureSchema();
    // 5.1: при запуске создаём запись локального агента с начальным балансом 1000 сатоши
    this.ensureAgent(OWN_AGENT, INITIAL_BALANCE);
    this.ensureAgent(NETWORK_REWARD_ACCOUNT, 0);
  }

  ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS balances (
        agent_id TEXT PRIMARY KEY,
        balance_sats INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tx_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER,
        from_agent TEXT,
        to_agent TEXT,
        sats INTEGER,
        note TEXT
      );
    `);
  }

  ensureAgent(agentId, initial = 0) {
    this.db.prepare('INSERT OR IGNORE INTO balances (agent_id, balance_sats) VALUES (?, ?)')
      .run(agentId, initial);
  }

  getBalance(agentId) {
    const r = this.db.prepare('SELECT balance_sats AS b FROM balances WHERE agent_id = ?').get(agentId);
    return r ? r.b : null;
  }

  pay(senderId, receiverId, amountSats, note = '') {
    if (!Number.isInteger(amountSats) || amountSats <= 0) {
      return { ok: false, reason: 'amount must be positive integer' };
    }
    const sender = this.db.prepare('SELECT balance_sats AS b FROM balances WHERE agent_id = ?').get(senderId);
    if (!sender) return { ok: false, reason: 'unknown sender: ' + senderId };
    // 5.2: баланс не должен уходить в минус
    if (sender.b < amountSats) {
      return { ok: false, reason: 'insufficient balance', from: senderId, to: receiverId, sats: amountSats, balance: sender.b };
    }
    this.ensureAgent(receiverId, 0);
    const tx = this.db.transaction(() => {
      this.db.prepare('UPDATE balances SET balance_sats = balance_sats - ? WHERE agent_id = ?').run(amountSats, senderId);
      this.db.prepare('UPDATE balances SET balance_sats = balance_sats + ? WHERE agent_id = ?').run(amountSats, receiverId);
      this.db.prepare('INSERT INTO tx_log (ts, from_agent, to_agent, sats, note) VALUES (?,?,?,?,?)')
        .run(Date.now(), senderId, receiverId, amountSats, note);
    });
    tx();
    this._appendLog(`${new Date().toISOString()} | ${senderId} -> ${receiverId} | ${amountSats} sat | ${note}`);
    return { ok: true, from: senderId, to: receiverId, sats: amountSats, note };
  }

  // 5.2: если автор неизвестен — зачисляем на специальный счёт network_reward
  payToAuthor(authorId, amountSats, note) {
    const known = this.db.prepare('SELECT 1 FROM balances WHERE agent_id = ?').get(authorId);
    const receiver = known ? authorId : NETWORK_REWARD_ACCOUNT;
    return this.pay(OWN_AGENT, receiver, amountSats, note);
  }

  txCount() {
    return this.db.prepare('SELECT COUNT(*) AS c FROM tx_log').get().c;
  }

  allBalances() {
    return this.db.prepare('SELECT agent_id AS agent, balance_sats AS balance FROM balances ORDER BY agent_id').all();
  }

  _appendLog(line) {
    fs.appendFileSync(this.logPath, line + '\n');
  }
}

// CLI (5.3): команда навыка для проверки балансов/переводов
if (require.main === module) {
  const path = require('path');
  const Database = require('better-sqlite3');
  const dbPath = process.env.CACHE_DB || path.join(__dirname, 'cache.db');
  const logPath = process.env.PAYMENTS_LOG || path.join(__dirname, 'payments.log');
  const db = new Database(dbPath);
  const emu = new LightningEmulator(db, logPath);
  const [cmd, a, b, c, ...rest] = process.argv.slice(2);
  if (cmd === 'balance') {
    if (a) console.log(`${a}: ${emu.getBalance(a) ?? 'unknown'} sat`);
    else for (const r of emu.allBalances()) console.log(`${r.agent}: ${r.balance} sat`);
  } else if (cmd === 'pay') {
    console.log(JSON.stringify(emu.pay(a, b, parseInt(c, 10), rest.join(' '))));
  } else {
    console.log('usage: node lightning-emulator.js balance [agent] | pay <from> <to> <sats> [note]');
  }
  db.close();
}

module.exports = { LightningEmulator, OWN_AGENT, NETWORK_REWARD_ACCOUNT, INITIAL_BALANCE };
