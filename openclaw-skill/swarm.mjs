#!/usr/bin/env node
'use strict';
/**
 * swarm.mjs — узел роя Swarm Cache для OpenClaw.
 *
 * Работает БЕЗ сервера: общая база ответов синхронизируется через GitHub
 * (https://github.com/Vadim945/swarm-cache-data), эмбеддинги и поиск — локально.
 * Генерация новых ответов — через LLM-ключ пользователя (env LLM_API_URL/LLM_API_KEY/LLM_MODEL).
 *
 * Режимы:
 *   1) GitHub-синхронизация (по умолчанию) — узел тянет cache.json с GitHub,
 *      отвечает из базы, свои ответы возвращает в репо (если настроен GITHUB_TOKEN).
 *   2) Хаб (опция SWARM_HUB) — если хаб доступен, узел дополнительно
 *      синхронизируется с ним (онлайн-обмен с другими узлами).
 *
 * Использование:
 *   node swarm.mjs register [имя]             — локальная регистрация узла
 *   node swarm.mjs ask "вопрос"               — поиск в базе роя
 *   node swarm.mjs publish "вопрос" "ответ"   — добавить ответ в локальную базу
 *   node swarm.mjs sync                       — синхронизация с GitHub (pull+push)
 *   node swarm.mjs balance                    — статус узла
 *   node swarm.mjs stats                      — статистика базы
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const CONFIG_DIR = path.join(os.homedir(), '.swarm-cache');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const DB_PATH = path.join(CONFIG_DIR, 'cache.json');
const GITHUB_RAW = 'https://raw.githubusercontent.com/Vadim945/swarm-cache-data/main/cache.json';
const GITHUB_RAW_BUST = 'https://raw.githubusercontent.com/Vadim945/swarm-cache-data/main/cache.json?t='; // cache-busting
const GITHUB_API = 'https://api.github.com/repos/Vadim945/swarm-cache-data/contents/cache.json';

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return { key: null, name: null }; }
}
function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}
function loadDb() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch { return []; }
}
function saveDb(db) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 0));
}
const qhash = (q) => crypto.createHash('sha256').update(q.toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex');

/* ---- семантический поиск: локальный, лёгкий (без тяжёлых моделей) ---- */
// Ищем по: 1) точному qhash, 2) нормализованному совпадению, 3) общим словам.
const STOP = new Set(['что', 'как', 'это', 'такое', 'для', 'при', 'зачем', 'почему', 'какие', 'какой', 'какая', 'можно', 'нужно', 'помоги', 'расскажи', 'объясни', 'работает', 'использовать', 'используется', 'используют', 'между', 'через', 'когда', 'который', 'которая', 'которые', 'свои', 'своего', 'есть', 'всего', 'основные', 'основной', 'разница', 'отличие', 'лучше', 'какой', 'про', 'для', 'при', 'без', 'над', 'под', 'или', 'либо', 'все', 'всё', 'очень', 'более']);

function normalize(s) {
  return s.toLowerCase().replace(/[^a-zа-яё0-9\s]/gi, ' ').replace(/\s+/g, ' ').trim();
}
function tokenize(s) { return normalize(s).split(' ').filter(w => w.length > 2 && !STOP.has(w)); }
function similarity(a, b) {
  const ta = new Set(tokenize(a)), tb = new Set(tokenize(b));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  return inter / Math.sqrt(ta.size * tb.size);
}

function searchLocal(q) {
  const db = loadDb();
  const h = qhash(q);
  // 1) точное совпадение
  for (const r of db) if (qhash(r.q) === h) return { ...r, match: 'exact' };
  // 2) семантическое (по словам): минимум 2 общих значимых слова + порог
  let best = null, bestScore = 0;
  for (const r of db) {
    const s = similarity(q, r.q);
    const common = [...tokenize(q)].filter(w => tokenize(r.q).includes(w)).length;
    if (s > bestScore && common >= 2) { bestScore = s; best = r; }
  }
  if (best && bestScore >= 0.45) return { ...best, match: 'semantic', score: Math.round(bestScore * 100) };
  return null;
}

/* ---- LLM-генерация через ключ пользователя ---- */
async function generate(q) {
  const url = process.env.LLM_API_URL;
  const key = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL || 'deepseek-v4-flash';
  if (!url || !key) return null;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: q }], max_tokens: 800 }),
  });
  if (!resp.ok) throw new Error('LLM HTTP ' + resp.status);
  const d = await resp.json();
  return d.choices?.[0]?.message?.content || null;
}

/* ---- GitHub sync ---- */
async function pullFromGitHub() {
  const token = process.env.GITHUB_TOKEN;
  // Основной путь: GitHub API (актуальные данные, без CDN-кэша)
  try {
    const headers = { 'User-Agent': 'swarm-cache-node', 'Accept': 'application/vnd.github+json' };
    if (token) headers['Authorization'] = 'token ' + token;
    const resp = await fetch(GITHUB_API, { headers });
    if (resp.ok) {
      const d = await resp.json();
      const remote = JSON.parse(Buffer.from(d.content, 'base64').toString('utf8'));
      if (Array.isArray(remote)) return remote;
    }
  } catch { /* fallback ниже */ }
  // Fallback: raw.githubusercontent (CDN, может быть закэширован)
  const resp = await fetch(GITHUB_RAW_BUST + Date.now(), { headers: { 'User-Agent': 'swarm-cache-node' } });
  if (!resp.ok) throw new Error('GitHub pull HTTP ' + resp.status);
  const remote = await resp.json();
  if (!Array.isArray(remote)) throw new Error('bad remote format');
  return remote;
}
async function pushToGitHub(db) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN not set — push skipped');
  const body = JSON.stringify(db);
  const sha = await getRemoteSha();
  const resp = await fetch(GITHUB_API, {
    method: 'PUT',
    headers: { 'Authorization': 'token ' + token, 'Content-Type': 'application/json', 'User-Agent': 'swarm-cache-node' },
    body: JSON.stringify({ message: 'sync from node', content: Buffer.from(body).toString('base64'), sha: sha || undefined }),
  });
  if (!resp.ok) throw new Error('GitHub push HTTP ' + resp.status + ' ' + await resp.text());
  return true;
}
async function getRemoteSha() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return null;
  const resp = await fetch(GITHUB_API, { headers: { 'Authorization': 'token ' + token, 'User-Agent': 'swarm-cache-node' } });
  if (!resp.ok) return null;
  const d = await resp.json();
  return d.sha || null;
}

/* ---- merge баз ---- */
function merge(remote, local) {
  const seen = new Set();
  const out = [];
  for (const r of [...remote, ...local]) {
    const h = qhash(r.q);
    if (!seen.has(h)) { seen.add(h); out.push(r); }
  }
  return out;
}

/* ---- команды ---- */
async function cmdRegister(name) {
  const cfg = loadConfig();
  const finalName = name || cfg.name || process.env.USER || 'openclaw-user';
  cfg.name = finalName;
  cfg.key = cfg.key || 'node-' + crypto.randomBytes(8).toString('hex');
  cfg.created = cfg.created || Date.now();
  saveConfig(cfg);
  // стартовый pull
  try {
    const remote = await pullFromGitHub();
    const db = merge(remote, loadDb());
    saveDb(db);
    console.log(`✅ Узел зарегистрирован: ${finalName} (key=${cfg.key})`);
    console.log(`   База: ${db.length} ответов роя (синхронизировано с GitHub)`);
  } catch (e) {
    console.log(`✅ Узел зарегистрирован: ${finalName} (key=${cfg.key})`);
    console.log(`   ⚠ GitHub недоступен: ${e.message}. База: ${loadDb().length} локальных ответов`);
  }
  return cfg;
}

async function cmdAsk(q) {
  const hit = searchLocal(q);
  if (hit) {
    console.log(`[CACHED ${hit.match}${hit.score ? ' ' + hit.score + '%' : ''}]`);
    console.log('---');
    console.log(hit.a);
    return hit;
  }
  // промах: пробуем генерацию через LLM пользователя
  console.log('[MISS] нет в базе роя');
  const ans = await generate(q).catch(e => { console.error('⚠ LLM: ' + e.message); return null; });
  if (ans) {
    console.log('---');
    console.log(ans);
    console.log('---');
    console.log('(сгенерировано вашей LLM; опубликуйте: node swarm.mjs publish "вопрос" "ответ")');
  }
  return null;
}

async function cmdPublish(q, a) {
  const db = loadDb();
  const h = qhash(q);
  if (db.some(r => qhash(r.q) === h)) { console.log('⏭ Дубль — уже есть в базе'); return; }
  db.push({ q, a, ts: Math.floor(Date.now() / 1000) });
  saveDb(db);
  console.log(`✅ Добавлено в локальную базу (всего ${db.length})`);
  // пытаемся вернуть в общий репо
  try {
    await pushToGitHub(db);
    console.log('   Пуш в общий репо: OK');
  } catch (e) {
    console.log(`   Пуш в общий репо: пропущен (${e.message})`);
    console.log('   (задайте GITHUB_TOKEN, чтобы возвращать ответы рою)');
  }
}

async function cmdSync() {
  const local = loadDb();
  const remote = await pullFromGitHub().catch(e => { console.error('⚠ pull: ' + e.message); return null; });
  if (remote) {
    const merged = merge(remote, local);
    saveDb(merged);
    console.log(`✅ Синхронизировано: ${merged.length} ответов (было локально ${local.length})`);
    if (merged.length > remote.length) {
      try { await pushToGitHub(merged); console.log('   Новые ответы вернулись в общий репо'); }
      catch (e) { console.log('   ⚠ push: ' + e.message); }
    }
  } else {
    console.log(`Локальная база: ${local.length} ответов (GitHub недоступен)`);
  }
}

async function cmdBalance() {
  const cfg = loadConfig();
  const db = loadDb();
  console.log(`Узел: ${cfg.name || 'не зарегистрирован'} | key: ${cfg.key || '-'}`);
  console.log(`Локальная база: ${db.length} ответов`);
  console.log(`Режим: GitHub-рой (без сервера)`);
  if (process.env.LLM_API_URL) console.log(`LLM: ${process.env.LLM_MODEL || 'default'} (ваш ключ)`);
  else console.log('LLM: не настроена (env LLM_API_URL/LLM_API_KEY) — только поиск по базе');
  if (process.env.GITHUB_TOKEN) console.log('GitHub push: включён (ответы возвращаются рою)');
  else console.log('GitHub push: выключен (задайте GITHUB_TOKEN для возврата ответов)');
}

async function cmdStats() {
  const db = loadDb();
  const words = db.reduce((s, r) => s + (r.q + ' ' + r.a).split(' ').length, 0);
  console.log(JSON.stringify({ answers: db.length, words, topics: new Set(db.map(r => qhash(r.q))).size }, null, 2));
}

const [, , cmd, ...args] = process.argv;
const main = async () => {
  try {
    switch (cmd) {
      case 'register': await cmdRegister(args[0]); break;
      case 'ask': await cmdAsk(args.join(' ').trim()); break;
      case 'publish': {
        if (args.length < 2) throw new Error('Нужно: publish "вопрос" "ответ"');
        await cmdPublish(args[0], args.slice(1).join(' '));
        break;
      }
      case 'sync': await cmdSync(); break;
      case 'balance': await cmdBalance(); break;
      case 'stats': await cmdStats(); break;
      default:
        console.log('Swarm Cache узел (без сервера)\n  register [имя] | ask "вопрос" | publish "вопрос" "ответ" | sync | balance | stats');
    }
  } catch (e) {
    console.error('❌ ' + e.message);
    process.exitCode = 1;
  }
};
main();
