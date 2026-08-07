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
const { LightningEmulator, OWN_AGENT, NETWORK_REWARD_ACCOUNT } = require('./lightning-emulator.js');

const EMBED_DIM = 384;
const SIM_THRESHOLD = 0.92;
const PUBSUB_TOPIC = 'swarm-cache';
const IPFS_URL = process.env.IPFS_URL || 'http://127.0.0.1:5001';
const LOCAL_AGENT = OWN_AGENT;

class CacheKeeper {
  constructor(opts = {}) {
    this.dir = __dirname;
    this.dbPath = opts.dbPath || path.join(this.dir, 'cache.db');
    this.logPath = opts.logPath || path.join(this.dir, 'payments.log');
    this.threshold = opts.threshold ?? SIM_THRESHOLD;
    this.modelName = opts.model || 'Xenova/all-MiniLM-L6-v2';
    this.onMessage = opts.onMessage || null; // хук для тестов/интеграции: вызывается после обработки pubsub-сообщения
    this.embedder = null;
    this.ipfs = null;
    this.p2pEnabled = false;
    this.ln = null;
    this._db = null;
    this._seenQhashes = new Set(); // синхронный барьер дедупликации входящих pubsub-сообщений
  }

  /* ---------- lifecycle ---------- */

  async init() {
    this._openDb();
    this._ensureSchema();
    // L402-эмулятор (Фаза 5): балансы + журнал платежей
    this.ln = new LightningEmulator(this._db, this.logPath);
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
      CREATE TABLE IF NOT EXISTS ipfs_index (
        qhash TEXT PRIMARY KEY,
        cid TEXT,
        agent TEXT,
        created_at INTEGER
      );
    `);
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
      // 5.2: платим автору 1 сатоши (или network_reward, если автор неизвестен)
      const payment = this.ln.payToAuthor(p2p.agent, 1, 'p2p cache hit');
      return {
        answer: p2p.answer, cached: true, p2p: true,
        source: 'p2p', agent: p2p.agent, payment,
        timeMs: Date.now() - t0,
      };
    }

    // 3) Генерация + публикация в рой
    const gen = await this.generate(question);
    this.addToCache(question, gen.answer, emb, { source: 'generated', agent: LOCAL_AGENT });
    this.publishP2P(qhash, question, gen.answer).catch(() => {});
    return {
      answer: gen.answer, cached: false, p2p: false,
      source: 'generated', tokens: gen.tokens,
      timeMs: Date.now() - t0,
    };
  }

  /* ---------- «LLM» (заглушка-генератор) ---------- */

  /**
   * Генерация ответа: реальный LLM (DeepSeek API, ключ из env DEEPSEEK_API_KEY)
   * или локальная заглушка, если ключа нет. Токены — из usage ответа API (честные метрики).
   */
  async generate(question) {
    const key = process.env.DEEPSEEK_API_KEY;
    if (key) {
      try {
        const resp = await fetch('https://api.deepseek.com/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
          body: JSON.stringify({
            model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
            messages: [
              { role: 'system', content: 'Ты — экспертный помощник. Отвечай кратко, по делу, по-русски.' },
              { role: 'user', content: question },
            ],
            temperature: 0.3,
            max_tokens: 512,
            stream: false,
          }),
        });
        if (!resp.ok) throw new Error('DeepSeek API HTTP ' + resp.status);
        const data = await resp.json();
        const answer = (data.choices && data.choices[0] && data.choices[0].message.content) || '';
        if (!answer) throw new Error('empty answer');
        const tokens = (data.usage && data.usage.total_tokens) || null;
        this._log(`LLM: question="${question.slice(0, 50)}..." tokens=${tokens} (usage)`);
        return { answer, tokens, provider: 'deepseek' };
      } catch (e) {
        this._log('⚠ DeepSeek API error: ' + e.message + ' — fallback to simulator');
      }
    }
    // Фолбэк: локальная заглушка (без API-ключа)
    const words = question.trim().split(/\s+/).length;
    const tokens = Math.max(24, Math.round(words * 2.4));
    const answer =
      `[simulated-LLM] Разбор запроса: «${question}». ` +
      `Это комплексная тема: ключевые аспекты — архитектура решения, принципы работы и практическое применение. ` +
      `Рекомендуется изучить профильную документацию и специализированные источники для полного ответа.`;
    return { answer, tokens, provider: 'simulator' };
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
    // Игнорируем свои же сообщения: kubo может вернуть эхо при нескольких соединениях между узлами.
    // Идентификатор автора в сообщении = peerId узла-отправителя (уникален), LOCAL_AGENT — для совместимости.
    if (parsed.agent === this._peerId || parsed.agent === LOCAL_AGENT) return;
    await this.handlePeerMessage(parsed);
    if (this.onMessage) {
      try { await this.onMessage(parsed); } catch (e) { this._log('⚠ onMessage hook: ' + e.message); }
    }
  }

  async handlePeerMessage({ question_hash, answer_cid, agent = 'peer' }) {
    if (!question_hash || !answer_cid) return { ok: false, reason: 'bad message' };
    // Синхронный барьер: JS однопоточен, поэтому Set-проверка на входе исключает гонку
    // при одновременной доставке дубликатов pubsub-сообщения
    if (this._seenQhashes.has(question_hash)) {
      return { ok: true, duplicate: true, payment: { ok: true, sats: 0, note: 'duplicate, already processed' } };
    }
    this._seenQhashes.add(question_hash);
    try {
      // Дедупликация по БД: платим и кэшируем только первое получение (актуально после перезапуска)
      const existing = this._db.prepare('SELECT id FROM cache WHERE qhash = ?').get(question_hash);
      const data = await this.ipfs.dag.get(this.CID.parse(answer_cid));
      const val = data.value || data;
      if (!val || val.question_hash !== question_hash || !val.answer) {
        return { ok: false, reason: 'hash mismatch' };
      }
      if (!existing && val.question) {
        const emb = await this.embed(val.question);
        this.addToCache(val.question, val.answer, emb, { source: 'p2p', agent });
      }
      // 5.2: автор представился в pubsub — регистрируем его, чтобы платёж шёл ему напрямую
      this.ln.ensureAgent(agent, 0);
      // L402: платим 1 сатоши только за новое получение (5.2); дубликаты не тарифицируются
      const pay = existing
        ? { ok: true, from: LOCAL_AGENT, to: agent, sats: 0, note: 'p2p duplicate, already paid', duplicate: true }
        : this.ln.payToAuthor(agent, 1, 'p2p answer reward');
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
      question_hash: qhash, question, answer, agent: this._peerId, ts: Date.now(),
    });
    this._db.prepare('INSERT OR REPLACE INTO ipfs_index (qhash, cid, agent, created_at) VALUES (?,?,?,?)')
      .run(qhash, cid.toString(), this._peerId, Date.now());
    await this.ipfs.pubsub.publish(PUBSUB_TOPIC, new TextEncoder().encode(JSON.stringify({
      question_hash: qhash, answer_cid: cid.toString(), agent: this._peerId,
    })));
    return cid.toString();
  }

  /* ---------- payments (делегируется lightning-emulator, Фаза 5) ---------- */

  ensureAgent(agent, initial = 0) {
    this.ln.ensureAgent(agent, initial);
  }

  balance(agent) {
    return this.ln.getBalance(agent);
  }

  pay(from, to, sats, note) {
    return this.ln.pay(from, to, sats, note);
  }

  payToAuthor(author, sats, note) {
    return this.ln.payToAuthor(author, sats, note);
  }

  /* ---------- helpers ---------- */

  stats() {
    const cacheCount = this._db.prepare('SELECT COUNT(*) c FROM cache').get().c;
    const p2pCount = this._db.prepare("SELECT COUNT(*) c FROM cache WHERE source = 'p2p'").get().c;
    const published = this._db.prepare('SELECT COUNT(*) c FROM ipfs_index').get().c;
    return {
      cacheSize: cacheCount,
      p2pEntries: p2pCount,
      txCount: this.ln.txCount(),
      publishedCids: published,
      balances: this.ln.allBalances(),
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
