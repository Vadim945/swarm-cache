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
const { Billing, GEN_COST, CACHE_COST, FREE_BONUS } = require('./billing.js');

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
  app.post('/register', (req, res) => {
    const name = req.body && typeof req.body.name === 'string' ? req.body.name.trim().slice(0, 40) : '';
    if (!name) return res.status(400).json({ error: 'field "name" (string) is required' });
    const ip = clientIp(req);
    if (!canRegister(ip)) {
      return res.status(429).json({ error: 'registration limit reached for this IP (max ' + REG_DAILY_LIMIT + ' per day)' });
    }
    try {
      const { id, key } = auth.createKey(name);
      billing.credit(id, FREE_BONUS, 'self-serve beta bonus');
      markRegistered(ip);
      res.json({ ok: true, user_id: id, name, key, bonus: FREE_BONUS, credits: FREE_BONUS });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/ask', requireKey, async (req, res) => {
    const question = req.body && typeof req.body.question === 'string' ? req.body.question.trim() : '';
    if (!question) return res.status(400).json({ error: 'field "question" (string) is required' });
    const bal = billing.getBalance(req.user.id);
    if (bal < CACHE_COST) {
      return res.status(402).json({ error: 'insufficient balance', balance: bal, minCost: CACHE_COST });
    }
    try {
      const r = await keeper.ask(question);
      // списываем по факту: кэш-хит дешевле генерации
      const charge = billing.charge(req.user.id, !!r.cached);
      if (!charge.ok) {
        return res.status(402).json({ error: charge.reason, balance: charge.balance, need: charge.need });
      }
      const prefix = r.cached ? (r.p2p ? '[P2P Cached] ' : '[Cached] ') : '';
      res.json({
        answer: prefix + r.answer,
        cached: r.cached,
        p2p: r.p2p,
        source: r.source,
        similarity: r.similarity ?? null,
        tokens: r.tokens ?? null,
        provider: r.provider ?? (r.cached ? 'cache' : null),
        timeMs: r.timeMs,
        payment: r.payment ?? null,
        cost: r.cached ? CACHE_COST : GEN_COST,
        balance_after: charge.balance,
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
      credits: billing.getBalance(req.user.id),
      gen_cost: GEN_COST,
      cache_cost: CACHE_COST,
      agent_balance_sats: keeper.balance(agent),
    });
  });

  app.get('/pricing', (req, res) => {
    res.json({ gen_cost: GEN_COST, cache_cost: CACHE_COST, free_bonus: FREE_BONUS, unit: 'credits' });
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
