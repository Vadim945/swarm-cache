#!/usr/bin/env node
'use strict';
/**
 * swarm.mjs — узел роя Swarm Cache для OpenClaw.
 *
 * Работает БЕЗ сервера: общая база ответов живёт в GitHub-репо
 * (https://github.com/Vadim945/swarm-cache-data) и масштабируется шардированием:
 *
 *   shards/YYYY-MM-DD.json   — ответы за день (публикация пишет только файл дня)
 *   full-YYYY-MM-DD.json     — полный снапшот для новых узлов (пересобирается Actions)
 *
 * Поиск — локально. Генерация новых ответов — через LLM-ключ пользователя
 * (хранится в конфиге). Сгенерированный ответ сразу возвращается рою.
 *
 * Все секреты — в ~/.swarm-cache/config.json (chmod 600):
 *   { name, key, llmUrl, llmKey, llmModel, githubToken }
 * Настраиваются командой: node swarm.mjs config set <поле> <значение>
 *
 * Использование:
 *   node swarm.mjs register [имя]              — регистрация узла
 *   node swarm.mjs ask "вопрос"                — поиск в базе роя
 *   node swarm.mjs publish "вопрос" "ответ"    — добавить ответ в базу + push
 *   node swarm.mjs sync                        — синхронизация с GitHub
 *   node swarm.mjs config set <поле> <знач>    — настройка (llmUrl/llmKey/llmModel/githubToken/name)
 *   node swarm.mjs balance                     — статус узла
 *   node swarm.mjs stats                       — статистика базы
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const CONFIG_DIR = path.join(os.homedir(), '.swarm-cache');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const DB_PATH = path.join(CONFIG_DIR, 'cache.json');
const REPO = 'Vadim945/swarm-cache-data';
const API_BASE = `https://api.github.com/repos/${REPO}/contents`;
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/main`;
const SHARDS_DIR = 'shards';

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
const todayStr = () => new Date().toISOString().slice(0, 10);

/* ---- семантический поиск: локальный, лёгкий ---- */
const STOP = new Set(['что', 'как', 'это', 'такое', 'для', 'при', 'зачем', 'почему', 'какие', 'какой', 'какая', 'можно', 'нужно', 'помоги', 'расскажи', 'объясни', 'работает', 'использовать', 'используется', 'используют', 'между', 'через', 'когда', 'который', 'которая', 'которые', 'свои', 'своего', 'есть', 'всего', 'основные', 'основной', 'разница', 'отличие', 'лучше', 'какой', 'про', 'без', 'над', 'под', 'или', 'либо', 'все', 'всё', 'очень', 'более']);

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
  for (const r of db) if (qhash(r.q) === h) return { ...r, match: 'exact' };
  let best = null, bestScore = 0;
  for (const r of db) {
    const s = similarity(q, r.q);
    const common = [...tokenize(q)].filter(w => tokenize(r.q).includes(w)).length;
    if (s > bestScore && common >= 2) { bestScore = s; best = r; }
  }
  if (best && bestScore >= 0.45) return { ...best, match: 'semantic', score: Math.round(bestScore * 100) };
  return null;
}

/* ---- LLM-генерация через ключ из конфига ---- */
async function generate(q, cfg) {
  const url = cfg.llmUrl;
  const key = cfg.llmKey;
  const model = cfg.llmModel || 'deepseek-v4-flash';
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

/* ---- GitHub: helpers ---- */
function apiHeaders(cfg) {
  const h = { 'User-Agent': 'swarm-cache-node', 'Accept': 'application/vnd.github+json' };
  if (cfg.githubToken) h['Authorization'] = 'token ' + cfg.githubToken;
  return h;
}
async function listDir(dir, cfg) {
  const url = dir ? `${API_BASE}/${dir}` : API_BASE;
  const resp = await fetch(url, { headers: apiHeaders(cfg) });
  if (!resp.ok) throw new Error('list ' + dir + ' HTTP ' + resp.status);
  const d = await resp.json();
  if (!Array.isArray(d)) throw new Error('bad listing');
  return d.map(f => f.name).filter(n => n.endsWith('.json'));
}
async function fetchRaw(file, cfg) {
  const resp = await fetch(`${RAW_BASE}/${file}?t=${Date.now()}`, { headers: { 'User-Agent': 'swarm-cache-node' } });
  if (!resp.ok) throw new Error('raw ' + file + ' HTTP ' + resp.status);
  const d = await resp.json();
  if (!Array.isArray(d)) throw new Error('bad format ' + file);
  return d;
}
async function fetchApiFile(file, cfg) {
  const resp = await fetch(`${API_BASE}/${file}`, { headers: apiHeaders(cfg) });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error('api ' + file + ' HTTP ' + resp.status);
  const d = await resp.json();
  return { sha: d.sha, content: JSON.parse(Buffer.from(d.content, 'base64').toString('utf8')) };
}
async function putFile(file, content, sha, cfg) {
  const body = { message: 'sync from node', content: Buffer.from(content).toString('base64') };
  if (sha) body.sha = sha;
  const resp = await fetch(`${API_BASE}/${file}`, {
    method: 'PUT',
    headers: { 'Authorization': 'token ' + cfg.githubToken, 'Content-Type': 'application/json', 'User-Agent': 'swarm-cache-node' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error('push ' + file + ' HTTP ' + resp.status + ' ' + await resp.text());
  return true;
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

/* ---- синхронизация ---- */
// Полная загрузка для нового узла: последний full-снапшот + шарды новее него
async function pullAll(cfg) {
  const root = await listDir('', cfg);
  const fulls = root.filter(n => /^full-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
  let base = [];
  let from = '2000-01-01';
  if (fulls.length) {
    const latest = fulls[fulls.length - 1];
    from = latest.match(/\d{4}-\d{2}-\d{2}/)[0];
    base = await fetchRaw(latest, cfg);
  }
  const shards = await listDir(SHARDS_DIR, cfg);
  const newShards = shards.filter(n => {
    const d = n.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
    return d && d[1] >= from;
  });
  for (const s of newShards) base = merge(base, await fetchRaw(SHARDS_DIR + '/' + s, cfg));
  return base;
}
// Инкрементальная загрузка: только шарды новее lastSync
async function pullNew(cfg, local) {
  const from = cfg.lastSync || '2000-01-01';
  const shards = await listDir(SHARDS_DIR, cfg);
  const newShards = shards.filter(n => {
    const d = n.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
    return d && d[1] > from;
  });
  let db = local;
  let added = 0;
  for (const s of newShards) {
    const arr = await fetchRaw(SHARDS_DIR + '/' + s, cfg);
    const before = db.length;
    db = merge(db, arr);
    added += db.length - before;
  }
  return { db, added };
}
// Публикация одной записи в шард текущего дня (с ретраями на конфликт sha)
async function pushRecord(record, cfg) {
  const day = todayStr();
  const file = `${SHARDS_DIR}/${day}.json`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await fetchApiFile(file, cfg);
    const arr = existing ? existing.content : [];
    if (arr.some(r => qhash(r.q) === qhash(record.q))) return true; // уже там
    arr.push(record);
    try {
      await putFile(file, JSON.stringify(arr), existing?.sha, cfg);
      return true;
    } catch (e) {
      if (attempt === 2) throw e; // конфликт sha — перечитываем и пробуем снова
    }
  }
  return false;
}

/* ---- команды ---- */
async function cmdRegister(name, cfg) {
  const finalName = name || cfg.name || os.userInfo().username || 'openclaw-user';
  cfg.name = finalName;
  cfg.key = cfg.key || 'node-' + crypto.randomBytes(8).toString('hex');
  cfg.created = cfg.created || Date.now();
  saveConfig(cfg);
  try {
    const db = await pullAll(cfg);
    saveDb(db);
    cfg.lastSync = todayStr();
    saveConfig(cfg);
    console.log(`✅ Узел зарегистрирован: ${finalName}`);
    console.log(`   База: ${db.length} ответов роя (полная синхронизация)`);
  } catch (e) {
    console.log(`✅ Узел зарегистрирован: ${finalName}`);
    console.log(`   ⚠ GitHub недоступен: ${e.message}. База: ${loadDb().length} локальных ответов`);
  }
  return cfg;
}

async function cmdAsk(q, cfg) {
  const hit = searchLocal(q);
  if (hit) {
    console.log(`[CACHED ${hit.match}${hit.score ? ' ' + hit.score + '%' : ''}]`);
    console.log('---');
    console.log(hit.a);
    return hit;
  }
  console.log('[MISS] ответа в рое нет');
  const ans = await generate(q, cfg).catch(e => { console.error('⚠ LLM: ' + e.message); return null; });
  if (ans) {
    console.log('---');
    console.log(ans);
    console.log('---');
    // Авто-пополнение: сгенерированный ответ сразу уходит в рой
    await autoPublish(q, ans, cfg);
  } else {
    console.log('Рекомендация: ответьте своим обычным способом (скилл не блокирует работу).');
    if (!cfg.llmUrl || !cfg.llmKey) {
      console.log('Хотите, чтобы рой сам генерировал ответы? Настройте LLM: node swarm.mjs config set llmUrl/llmKey');
    }
    console.log('После ответа опубликуйте его в рой: node swarm.mjs publish "вопрос" "ответ" — так база растёт и другим станет быстрее.');
  }
  return null;
}

/* Авто-пополнение: сохранить сгенерированный ответ в локальную базу и в шард дня */
async function autoPublish(q, a, cfg) {
  const db = loadDb();
  const h = qhash(q);
  if (db.some(r => qhash(r.q) === h)) return; // уже есть — не дублируем
  const rec = { q, a, ts: Math.floor(Date.now() / 1000) };
  db.push(rec);
  saveDb(db);
  console.log(`✅ Ответ добавлен в базу роя (всего ${db.length})`);
  if (cfg.githubToken) {
    try {
      await pushRecord(rec, cfg);
      console.log('   Пуш в общий репо: OK — другие узлы скоро получат этот ответ');
    } catch (e) {
      console.log(`   Пуш в общий репо: пропущен (${e.message})`);
    }
  } else {
    console.log('   (без githubToken ответ пока только у вас; настройте: config set githubToken)');
  }
}

async function cmdPublish(q, a, cfg) {
  const db = loadDb();
  const h = qhash(q);
  if (db.some(r => qhash(r.q) === h)) { console.log('⏭ Дубль — уже есть в базе'); return; }
  const rec = { q, a, ts: Math.floor(Date.now() / 1000) };
  db.push(rec);
  saveDb(db);
  console.log(`✅ Добавлено в локальную базу (всего ${db.length})`);
  try {
    await pushRecord(rec, cfg);
    console.log('   Пуш в общий репо: OK');
  } catch (e) {
    console.log(`   Пуш в общий репо: пропущен (${e.message})`);
  }
}

async function cmdSync(cfg) {
  const local = loadDb();
  try {
    const { db, added } = await pullNew(cfg, local);
    saveDb(db);
    cfg.lastSync = todayStr();
    saveConfig(cfg);
    console.log(`✅ Синхронизировано: +${added} новых, всего ${db.length}`);
  } catch (e) {
    console.log(`⚠ pull: ${e.message}. Локальная база: ${local.length} ответов`);
  }
}

function cmdConfig(args, cfg) {
  if (args.length < 2) {
    console.log('Текущий конфиг (~/.swarm-cache/config.json):');
    const show = { ...cfg };
    if (show.llmKey) show.llmKey = '***';
    if (show.githubToken) show.githubToken = '***';
    console.log(JSON.stringify(show, null, 2));
    console.log('\nУстановка: node swarm.mjs config set <поле> <значение>');
    console.log('Поля: name, llmUrl, llmKey, llmModel, githubToken');
    return;
  }
  const [field, value] = args[0] === 'set' ? [args[1], args[2]] : [args[0], args[1]];
  const allowed = ['name', 'llmUrl', 'llmKey', 'llmModel', 'githubToken'];
  if (!allowed.includes(field)) { console.error('❌ Неизвестное поле: ' + field); process.exitCode = 1; return; }
  cfg[field] = value;
  saveConfig(cfg);
  console.log(`✅ ${field} сохранён`);
}

async function cmdBalance(cfg) {
  const db = loadDb();
  console.log(`Узел: ${cfg.name || 'не зарегистрирован'} | key: ${cfg.key || '-'}`);
  console.log(`Локальная база: ${db.length} ответов`);
  console.log(`Режим: GitHub-рой (без сервера), шардирование по дням`);
  if (cfg.llmUrl && cfg.llmKey) console.log(`LLM: ${cfg.llmModel || 'default'} (ваш ключ)`);
  else console.log('LLM: не настроена (config set llmUrl/llmKey) — только поиск по базе');
  if (cfg.githubToken) console.log('GitHub push: включён (ответы возвращаются рою)');
  else console.log('GitHub push: выключен (config set githubToken для возврата ответов)');
}

async function cmdStats() {
  const db = loadDb();
  const words = db.reduce((s, r) => s + (r.q + ' ' + r.a).split(' ').length, 0);
  console.log(JSON.stringify({ answers: db.length, words, topics: new Set(db.map(r => qhash(r.q))).size }, null, 2));
}

const [, , cmd, ...args] = process.argv;
const main = async () => {
  try {
    const cfg = loadConfig();
    switch (cmd) {
      case 'register': await cmdRegister(args[0], cfg); break;
      case 'ask': await cmdAsk(args.join(' ').trim(), cfg); break;
      case 'publish': {
        if (args.length < 2) throw new Error('Нужно: publish "вопрос" "ответ"');
        await cmdPublish(args[0], args.slice(1).join(' '), cfg);
        break;
      }
      case 'sync': await cmdSync(cfg); break;
      case 'config': cmdConfig(args, cfg); break;
      case 'balance': await cmdBalance(cfg); break;
      case 'stats': await cmdStats(); break;
      default:
        console.log('Swarm Cache узел (без сервера)\n  register [имя] | ask "вопрос" | publish "вопрос" "ответ" | sync | config | balance | stats');
    }
  } catch (e) {
    console.error('❌ ' + e.message);
    process.exitCode = 1;
  }
};
main();
