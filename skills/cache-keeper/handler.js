'use strict';
/**
 * cache-keeper — семантический кэш ответов LLM с P2P-обменом (IPFS pubsub)
 * и эмулированными микро-платежами Lightning (L402).
 * Проект «Коллективный Разум v2.0» (Swarm Cache).
 *
 * Стек: better-sqlite3 + sqlite-vec (cosine, порог 0.92),
 * локальные эмбеддинги Xenova/all-MiniLM-L6-v2 (384d),
 * ipfs-http-client -> kubo (pubsub топик swarm-cache, DAG API).
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');
const { pipeline } = require('@xenova/transformers');

const EMBED_DIM = 384;
const SIM_THRESHOLD = 0.92;
const PUBSUB_TOPIC = 'swarm-cache';
const IPFS_URL = process.env.IPFS_URL || 'http://127.0.0.1:5001';
const LOCAL_AGENT = 'local';

class CacheKeeper {
  constructor(opts = {}) {
    this.dir = __dirname;
    this.dbPath = opts.dbPath || path.join(this.dir, 'cache.db');
    this.logPath = opts.logPath || path.join(this.dir, 'payments.log');
    this.threshold = opts.threshold ?? SIM_THRESHOLD;
    this.modelName = opts.model || 'Xenova/all-MiniLM-L6-v2';
    this.embedder = null;
    this.ipfs = null;
    this.p2pEnabled = false;
    this._db = null;
  }

  /* ---------- lifecycle ---------- */

  async init() {
    this._openDb();
    this._ensureSchema();
    this._ensureAgents();
    // Локальная модель эмбеддингов (приоритет — по ТЗ)
    try {
      this.embedder = await pipeline('feature-extraction', this.modelName);
    } catch (e) {
      throw new Error('embedding model load failed: ' + e.message);
    }
    // P2P (IPFS) — опционально, не роняет кэш (ipfs-http-client — ESM, грузим динамически)
    try {
      const [{ create: createIpfsClient }, { CID }] = await Promise.all([
        import('ipfs-http-client'),
        import('multiformats/cid'),
      ]);
      this.CID = CID;
      this.ipfs = createIpfsClient({ url: IPFS_URL });
      // id() у новых версий клиента парсит multiaddr ноды (webrtc-direct и др.) —
      // проверяем доступность ноды напрямую по HTTP API, а не через id()
      const resp = await fetch(IPFS_URL + '/api/v0/id', { method: 'POST' });
      if (!resp.ok) throw new Error('IPFS API returned HTTP ' + resp.status);
      const info = await resp.json();
      this._peerId = info.ID;
      this.p2pEnabled = true;
      this._subscribe();
      this._log('✅ IPFS connected, pubsub topic: ' + PUBSUB_TOPIC);
    } catch (e) {
      this.p2pEnabled = false;
      this._log('⚠ IPFS недоступен, P2P отключён: ' + e.message);
    }
    return this;
  }

  close() {
    if (this._db) this._db.close();
  }

  /* ---------- storage ---------- */

  _openDb() {
    this._db = new Database(this.dbPath);
    this._db.loadExtension(sqliteVec.getLoadablePath());
    this._db.pragma('journal_mode = WAL');
  }

  _ensureSchema() {
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        question TEXT NOT NULL,
        qhash TEXT UNIQUE NOT NULL,
        answer TEXT NOT NULL,
        source TEXT DEFAULT 'generated',
        agent TEXT DEFAULT 'local',
        vec_rowid INTEGER,
        created_at INTEGER
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_cache USING vec0(
        embedding float[${EMBED_DIM}] distance_metric=cosine
      );
      CREATE TABLE IF NOT EXISTS balances (
        agent TEXT PRIMARY KEY,
        balance INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ipfs_index (
        qhash TEXT PRIMARY KEY,
        cid TEXT,
        agent TEXT,
        created_at INTEGER
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

  _ensureAgents() {
    for (const [a, initial] of [[LOCAL_AGENT, 1000], ['peer-A', 0], ['peer-B', 0]]) {
      this._db.prepare('INSERT OR IGNORE INTO balances (agent, balance) VALUES (?, ?)').run(a, initial);
    }
  }

  /* ---------- embeddings ---------- */

  hash(text) {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  }

  async embed(text) {
    const out = await this.embedder(text, { pooling: 'mean', normalize: true });
    return Array.from(out.data); // Float32Array -> number[]
  }

  /* ---------- semantic cache ---------- */

  semanticSearch(emb, k = 10) {
    const rows = this._db.prepare(
      'SELECT rowid, distance FROM vec_cache WHERE embedding MATCH ? AND k = ?'
    ).all(JSON.stringify(emb), k);
    for (const r of rows) {
      const sim = 1 - r.distance;
      if (sim >= this.threshold) {
        const c = this._db.prepare('SELECT * FROM cache WHERE vec_rowid = ?').get(r.rowid);
        if (c) return { ...c, similarity: sim };
      }
    }
    return null;
  }

  addToCache(question, answer, emb, { source = 'generated', agent = LOCAL_AGENT } = {}) {
    const qhash = this.hash(question);
    const existing = this._db.prepare('SELECT id FROM cache WHERE qhash = ?').get(qhash);
    if (existing) return existing.id;
    const tx = this._db.transaction(() => {
      const vecInfo = this._db.prepare('INSERT INTO vec_cache (embedding) VALUES (?)').run(JSON.stringify(emb));
      const info = this._db.prepare(
        'INSERT INTO cache (question, qhash, answer, source, agent, vec_rowid, created_at) VALUES (?,?,?,?,?,?,?)'
      ).run(question, qhash, answer, source, agent, vecInfo.lastInsertRowid, Date.now());
      return info.lastInsertRowid;
    });
    return tx();
  }

  /* ---------- main entry ---------- */

  async ask(question, opts = {}) {
    const t0 = Date.now();
    const qhash = this.hash(question);
    const emb = await this.embed(question);

    // 1) Локальный семантический кэш (sqlite-vec, cosine >= 0.92)
    const hit = this.semanticSearch(emb);
    if (hit) {
      return {
        answer: hit.answer, cached: true, p2p: false,
        source: hit.source, similarity: hit.similarity,
        timeMs: Date.now() - t0,
      };
    }

    // 2) P2P-поиск по хэшу вопроса (IPFS DAG + pubsub-индекс)
    const p2p = await this.p2pLookup(qhash);
    if (p2p) {
      this.addToCache(question, p2p.answer, emb, { source: 'p2p', agent: p2p.agent });
      const payment = this.pay(LOCAL_AGENT, p2p.agent, 1, 'p2p cache hit');
      return {
        answer: p2p.answer, cached: true, p2p: true,
        source: 'p2p', agent: p2p.agent, payment,
        timeMs: Date.now() - t0,
      };
    }

    // 3) Генерация + публикация в рой
    const gen = this.generate(question);
    this.addToCache(question, gen.answer, emb, { source: 'generated', agent: LOCAL_AGENT });
    this.publishP2P(qhash, question, gen.answer).catch(() => {});
    return {
      answer: gen.answer, cached: false, p2p: false,
      source: 'generated', tokens: gen.tokens,
      timeMs: Date.now() - t0,
    };
  }

  /* ---------- «LLM» (заглушка-генератор) ---------- */

  generate(question) {
    const words = question.trim().split(/\s+/).length;
    const tokens = Math.max(24, Math.round(words * 2.4));
    const answer =
      `[simulated-LLM] Разбор запроса: «${question}». ` +
      `Это комплексная тема: ключевые аспекты — архитектура решения, принципы работы и практическое применение. ` +
      `Рекомендуется изучить профильную документацию и специализированные источники для полного ответа.`;
    return { answer, tokens };
  }

  /* ---------- P2P / IPFS ---------- */

  _subscribe() {
    this.ipfs.pubsub.subscribe(PUBSUB_TOPIC, (msg) => {
      this._onPubsub(msg).catch((e) => this._log('⚠ pubsub handler: ' + e.message));
    }).catch((e) => this._log('⚠ subscribe failed: ' + e.message));
  }

  async _onPubsub(msg) {
    let parsed;
    try { parsed = JSON.parse(new TextDecoder().decode(msg.data)); } catch { return; }
    if (!parsed) return;
    // kubo не доставляет свои же сообщения, но защита от циклов не помешает
    if (parsed.agent === LOCAL_AGENT) return;
    await this.handlePeerMessage(parsed);
  }

  async handlePeerMessage({ question_hash, answer_cid, agent = 'peer' }) {
    if (!question_hash || !answer_cid) return { ok: false, reason: 'bad message' };
    try {
      const data = await this.ipfs.dag.get(this.CID.parse(answer_cid));
      const val = data.value || data;
      if (!val || val.question_hash !== question_hash || !val.answer) {
        return { ok: false, reason: 'hash mismatch' };
      }
      const existing = this._db.prepare('SELECT id FROM cache WHERE qhash = ?').get(question_hash);
      if (!existing && val.question) {
        const emb = await this.embed(val.question);
        this.addToCache(val.question, val.answer, emb, { source: 'p2p', agent });
      }
      // L402: платим автору 1 сатоши за полученный ответ
      const pay = this.pay(LOCAL_AGENT, agent, 1, 'p2p answer reward');
      return { ok: true, payment: pay };
    } catch (e) {
      this._log('⚠ handlePeerMessage: ' + e.message);
      return { ok: false, reason: e.message };
    }
  }

  async p2pLookup(qhash) {
    if (!this.p2pEnabled) return null;
    const row = this._db.prepare('SELECT cid, agent FROM ipfs_index WHERE qhash = ?').get(qhash);
    if (!row) return null;
    try {
      const data = await this.ipfs.dag.get(this.CID.parse(row.cid));
      const val = data.value || data;
      if (val && val.question_hash === qhash && val.answer) {
        return { answer: val.answer, agent: row.agent || val.agent || 'peer' };
      }
    } catch (e) {
      this._log('⚠ dag.get failed: ' + e.message);
    }
    return null;
  }

  async publishP2P(qhash, question, answer) {
    if (!this.p2pEnabled) return null;
    const cid = await this.ipfs.dag.put({
      question_hash: qhash, question, answer, agent: LOCAL_AGENT, ts: Date.now(),
    });
    this._db.prepare('INSERT OR REPLACE INTO ipfs_index (qhash, cid, agent, created_at) VALUES (?,?,?,?)')
      .run(qhash, cid.toString(), LOCAL_AGENT, Date.now());
    await this.ipfs.pubsub.publish(PUBSUB_TOPIC, new TextEncoder().encode(JSON.stringify({
      question_hash: qhash, answer_cid: cid.toString(), agent: LOCAL_AGENT,
    })));
    return cid.toString();
  }

  /* ---------- payments (L402 эмуляция) ---------- */

  ensureAgent(agent, initial = 0) {
    this._db.prepare('INSERT OR IGNORE INTO balances (agent, balance) VALUES (?, ?)').run(agent, initial);
  }

  balance(agent) {
    const r = this._db.prepare('SELECT balance FROM balances WHERE agent = ?').get(agent);
    return r ? r.balance : null;
  }

  pay(from, to, sats, note) {
    const row = this._db.prepare('SELECT balance FROM balances WHERE agent = ?').get(from);
    if (!row) return { ok: false, reason: 'unknown sender: ' + from };
    if (row.balance < sats) {
      return { ok: false, reason: 'insufficient balance', from, to, sats, balance: row.balance };
    }
    const tx = this._db.transaction(() => {
      this._db.prepare('UPDATE balances SET balance = balance - ? WHERE agent = ?').run(sats, from);
      this._db.prepare('UPDATE balances SET balance = balance + ? WHERE agent = ?').run(sats, to);
      this._db.prepare('INSERT INTO tx_log (ts, from_agent, to_agent, sats, note) VALUES (?,?,?,?,?)')
        .run(Date.now(), from, to, sats, note);
    });
    tx();
    this._appendLog(`${new Date().toISOString()} | ${from} -> ${to} | ${sats} sat | ${note}`);
    return { ok: true, from, to, sats, note };
  }

  /* ---------- helpers ---------- */

  stats() {
    const cacheCount = this._db.prepare('SELECT COUNT(*) c FROM cache').get().c;
    const p2pCount = this._db.prepare("SELECT COUNT(*) c FROM cache WHERE source = 'p2p'").get().c;
    const txCount = this._db.prepare('SELECT COUNT(*) c FROM tx_log').get().c;
    const balances = this._db.prepare('SELECT agent, balance FROM balances ORDER BY agent').all();
    const published = this._db.prepare('SELECT COUNT(*) c FROM ipfs_index').get().c;
    return {
      cacheSize: cacheCount,
      p2pEntries: p2pCount,
      txCount,
      publishedCids: published,
      balances,
      p2pEnabled: this.p2pEnabled,
      peerId: this.p2pEnabled ? (this._peerId || null) : null,
      threshold: this.threshold,
    };
  }

  _appendLog(line) {
    fs.appendFileSync(this.logPath, line + '\n');
  }

  _log(line) {
    const stamp = new Date().toISOString();
    fs.appendFileSync(path.join(this.dir, 'cache-keeper.log'), `[${stamp}] ${line}\n`);
    console.log(`[cache-keeper ${stamp}] ${line}`);
  }
}

module.exports = { CacheKeeper, LOCAL_AGENT, PUBSUB_TOPIC, SIM_THRESHOLD };
