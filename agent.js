'use strict';
/**
 * agent.js — живой HTTP-сервис Swarm Cache (рантайм навыка cache-keeper).
 *
 * POST /ask    { "question": "..." }  -> ответ с метками cached/p2p и временем
 * GET  /balance [/?agent=peer-A]      -> балансы (L402-эмулятор)
 * GET  /stats                         -> статистика кэша/P2P/платежей
 * GET  /health                        -> живость сервиса
 *
 * Порт 3333, слушает 127.0.0.1 (безопасно; наружу не торчит).
 */
const path = require('path');
const fs = require('fs');
const express = require('express');
const { CacheKeeper, LOCAL_AGENT } = require('./skills/cache-keeper/handler.js');
const { UserAuth } = require('./auth.js');
const { Billing, GEN_COST, CACHE_COST, FREE_BONUS, REFERRAL_BONUS } = require('./billing.js');

const PORT = Number(process.env.SWARM_PORT || 3333);
const HOST = process.env.SWARM_HOST || '127.0.0.1';

async function main() {
  const keeper = await new CacheKeeper({
    model: process.env.EMBED_MODEL || 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
    threshold: Number(process.env.SIM_THRESHOLD || 0.70),
    dbPath: process.env.SWARM_DB ? path.resolve(process.env.SWARM_DB) : undefined,
  }).init();

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // --- Аутентификация и rate limit (публичный доступ) ---
  const auth = new UserAuth();
  const billing = new Billing();
  // Лимит self-serve регистраций: N ключей с одного IP в сутки (защита от накрутки)
  const REG_DAILY_LIMIT = Number(process.env.REG_DAILY_LIMIT || 3);
  const regCounters = new Map(); // ip -> [даты (ms)]
  const clientIp = (req) => {
    const fwd = req.headers['x-forwarded-for'];
    return fwd ? String(fwd).split(',')[0].trim() : req.ip;
  };
  const canRegister = (ip) => {
    const now = Date.now();
    const day = 24 * 3600 * 1000;
    let arr = regCounters.get(ip) || [];
    arr = arr.filter((t) => now - t < day);
    regCounters.set(ip, arr);
    return arr.length < REG_DAILY_LIMIT;
  };
  const markRegistered = (ip) => {
    const arr = regCounters.get(ip) || [];
    arr.push(Date.now());
    regCounters.set(ip, arr);
  };

  // --- Демо-режим: бесплатные вопросы без ключа (DEMO_DAILY/сутки с IP) ---
  const DEMO_DAILY = Number(process.env.DEMO_DAILY || 3);
  const demoTimestamps = new Map(); // ip -> [ts]
  const demoLeft = (ip) => {
    const now = Date.now();
    const day = 24 * 3600 * 1000;
    let arr = demoTimestamps.get(ip) || [];
    arr = arr.filter((t) => now - t < day);
    demoTimestamps.set(ip, arr);
    return Math.max(0, DEMO_DAILY - arr.length);
  };
  const canDemo = (ip) => demoLeft(ip) > 0;
  const markDemo = (ip) => {
    const arr = demoTimestamps.get(ip) || [];
    arr.push(Date.now());
    demoTimestamps.set(ip, arr);
  };
  const requireKey = (req, res, next) => {
    const key = req.headers['x-api-key'];
    const user = auth.auth(key);
    if (!user) return res.status(401).json({ error: 'invalid or missing X-API-Key' });
    if (!auth.rateLimit(user.id)) {
      return res.status(429).json({ error: 'rate limit exceeded (per minute)', retryAfterSec: 60 });
    }
    req.user = user;
    next();
  };

  app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

  // --- Лендинг (корень) ---
  app.get('/', (req, res) => {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    res.type('html').send(html);
  });

  // --- Self-serve регистрация: имя -> ключ + бонус (без ручной раздачи) ---
  // Поддерживает реферальный код: body.ref или query ?ref= (для share-ссылок)
  app.post('/register', (req, res) => {
    const name = req.body && typeof req.body.name === 'string' ? req.body.name.trim().slice(0, 40) : '';
    if (!name) return res.status(400).json({ error: 'field "name" (string) is required' });
    const ref = (req.body && typeof req.body.ref === 'string' ? req.body.ref : (req.query.ref || '')).toString().trim().slice(0, 24);
    const ip = clientIp(req);
    if (!canRegister(ip)) {
      return res.status(429).json({ error: 'registration limit reached for this IP (max ' + REG_DAILY_LIMIT + ' per day)' });
    }
    try {
      const { id, key, ref_code } = auth.createKey(name);
      const referral = ref ? billing.applyReferral(id, ref) : null;
      billing.credit(id, FREE_BONUS, 'self-serve beta bonus');
      markRegistered(ip);
      res.json({
        ok: true,
        user_id: id,
        name,
        key,
        ref_code,
        share_link: 'https://swarm.telscan.ru/?ref=' + ref_code,
        bonus: FREE_BONUS,
        referral_bonus: REFERRAL_BONUS,
        referral: referral ? { ok: referral.ok, bonus: referral.ok ? referral.bonus : 0, reason: referral.ok ? null : referral.reason } : null,
        credits: billing.getBalance(id),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/ask', async (req, res) => {
    const question = req.body && typeof req.body.question === 'string' ? req.body.question.trim() : '';
    if (!question) return res.status(400).json({ error: 'field "question" (string) is required' });

    // 1) зарегистрированный пользователь (ключ) ИЛИ демо-режим (без ключа, DEMO_DAILY/сутки с IP)
    const key = req.headers['x-api-key'];
    const user = key ? auth.auth(key) : null;
    let demo = false;
    let ip = null;
    if (user) {
      if (!auth.rateLimit(user.id)) {
        return res.status(429).json({ error: 'rate limit exceeded (per minute)', retryAfterSec: 60 });
      }
    } else {
      ip = clientIp(req);
      if (!canDemo(ip)) {
        return res.status(429).json({ error: 'demo limit reached: ' + DEMO_DAILY + ' free questions per day — register to continue', demo_left: 0 });
      }
      if (!auth.rateLimit(ip)) {
        return res.status(429).json({ error: 'rate limit exceeded (per minute)', retryAfterSec: 60 });
      }
      markDemo(ip);
      demo = true;
    }

    // 2) проверка баланса (только для зарегистрированных)
    if (!demo) {
      const bal = billing.getBalance(user.id);
      if (bal < CACHE_COST) {
        return res.status(402).json({ error: 'insufficient balance', balance: bal, minCost: CACHE_COST });
      }
    }

    try {
      const r = await keeper.ask(question);
      const prefix = r.cached ? (r.p2p ? '[P2P Cached] ' : '[Cached] ') : '';
      const base = {
        answer: prefix + r.answer,
        cached: r.cached,
        p2p: r.p2p,
        source: r.source,
        similarity: r.similarity ?? null,
        tokens: r.tokens ?? null,
        provider: r.provider ?? (r.cached ? 'cache' : null),
        timeMs: r.timeMs,
        payment: r.payment ?? null,
      };
      if (demo) {
        return res.json({ ...base, demo: true, demo_left: demoLeft(ip), cost: 0, balance_after: null });
      }
      const charge = billing.charge(user.id, !!r.cached);
      if (!charge.ok) {
        return res.status(402).json({ error: charge.reason, balance: charge.balance, need: charge.need });
      }
      res.json({
        ...base,
        demo: false,
        cost: r.cached ? CACHE_COST : GEN_COST,
        balance_after: charge.balance,
        ref_code: user.ref_code || null,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // --- Публикация ответа в рой (для OpenClaw-скилла и API-клиентов) ---
  // Юзер присылает question + answer -> хаб эмбеддит вопрос, кладёт в общий кэш,
  // публикует в P2P и начисляет автору награду (publish_reward).
  const PUBLISH_REWARD = Number(process.env.PUBLISH_REWARD || 0.5);
  app.post('/publish', async (req, res) => {
    const key = req.headers['x-api-key'];
    const user = key ? auth.auth(key) : null;
    if (!user) return res.status(401).json({ error: 'invalid or missing X-API-Key' });
    if (!auth.rateLimit(user.id)) {
      return res.status(429).json({ error: 'rate limit exceeded (per minute)', retryAfterSec: 60 });
    }
    const question = req.body && typeof req.body.question === 'string' ? req.body.question.trim() : '';
    const answer = req.body && typeof req.body.answer === 'string' ? req.body.answer.trim() : '';
    if (!question || !answer) return res.status(400).json({ error: 'fields "question" and "answer" (strings) are required' });
    if (question.length > 2000 || answer.length > 20000) {
      return res.status(400).json({ error: 'question <= 2000 chars, answer <= 20000 chars' });
    }
    try {
      const emb = await keeper.embed(question);
      const qhash = keeper.hash(question);
      const existing = keeper._db.prepare('SELECT id FROM cache WHERE qhash = ?').get(qhash);
      if (!existing) {
        keeper.addToCache(question, answer, emb, { source: 'published', agent: 'peer-' + user.id });
      }
      keeper.publishP2P(qhash, question, answer).catch(() => {});
      const reward = existing ? 0 : PUBLISH_REWARD;
      const balanceAfter = reward > 0 ? billing.credit(user.id, reward, 'publish reward') : billing.getBalance(user.id);
      res.json({
        ok: true,
        stored: !existing,
        duplicate: !!existing,
        reward,
        balance_after: balanceAfter,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/balance', requireKey, (req, res) => {
    const agent = (req.query.agent || LOCAL_AGENT).toString();
    res.json({
      user_id: req.user.id,
      user_name: req.user.name,
      ref_code: req.user.ref_code || null,
      share_link: 'https://swarm.telscan.ru/?ref=' + (req.user.ref_code || ''),
      credits: billing.getBalance(req.user.id),
      gen_cost: GEN_COST,
      cache_cost: CACHE_COST,
      agent_balance_sats: keeper.balance(agent),
    });
  });

  app.get('/pricing', (req, res) => {
    res.json({
      gen_cost: GEN_COST,
      cache_cost: CACHE_COST,
      free_bonus: FREE_BONUS,
      referral_bonus: REFERRAL_BONUS,
      demo_free_questions: Number(process.env.DEMO_DAILY || 3),
      unit: 'credits',
    });
  });

  // --- Активация промо-кода пополнения (монетизация) ---
  app.post('/redeem', requireKey, (req, res) => {
    const user = auth.auth(req.headers['x-api-key']);
    if (!user) return res.status(401).json({ error: 'invalid key' });
    const code = req.body && typeof req.body.code === 'string' ? req.body.code.trim() : '';
    if (!code) return res.status(400).json({ error: 'field "code" is required' });
    const r = billing.redeemCode(user.id, code);
    if (!r.ok) return res.status(400).json({ error: r.reason });
    res.json(r);
  });

  // --- Админ: генерация промо-кодов (защищено ADMIN_TOKEN) ---
  app.post('/admin/redeem-gen', (req, res) => {
    const admin = process.env.ADMIN_TOKEN;
    if (!admin || req.headers['x-admin-token'] !== admin) return res.status(403).json({ error: 'forbidden' });
    const credits = Number(req.body && req.body.credits);
    const count = Number((req.body && req.body.count) || 1);
    if (!credits || credits <= 0 || count <= 0 || count > 100) return res.status(400).json({ error: 'credits>0, 1<=count<=100' });
    res.json({ codes: billing.createRedeemCode(credits, count) });
  });

  app.get('/stats', requireKey, (req, res) => {
    res.json(keeper.stats());
  });

  app.listen(PORT, HOST, () => {
    console.log(`[swarm-agent] HTTP сервис слушает http://${HOST}:${PORT}`);
    console.log(`[swarm-agent] P2P: ${keeper.p2pEnabled ? 'вкл (peer ' + keeper._peerId + ')' : 'выкл'}`);
    console.log(`[swarm-agent] LLM: ${process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY ? 'TimeWeb DeepSeek V4 Flash' : 'заглушка (нет LLM_API_KEY)'}`);
  });
}

main().catch((e) => { console.error('[swarm-agent] FATAL:', e); process.exit(1); });
