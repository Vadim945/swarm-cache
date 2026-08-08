#!/usr/bin/env node
/**
 * hub-sync.mjs — мост ХАБ ↔ GITHUB (сопряжение БД, по крону).
 *
 * Двусторонняя синхронизация:
 *   1. GITHUB → ХАБ: новые ответы из GitHub-репо (шарды) добавляются в SQLite хаба
 *      (которой уже нет — сгенерированные юзерами ответы попадают в общий кэш).
 *   2. ХАБ → GITHUB: ответы из SQLite хаба, которых нет в GitHub, пушатся
 *      в шард текущего дня (shards/YYYY-MM-DD.json).
 *
 * Так база на VPS всегда сопряжена с GitHub и юзером: что бы ни упало,
 * обмен идёт через открытый источник, и БД пополняется в любом случае.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import Database from 'better-sqlite3';

const HUB_DB = '/clients/322265183/swarm-cache/skills/cache-keeper/cache.db';
const REPO = 'Vadim945/swarm-cache-data';
const API_BASE = `https://api.github.com/repos/${REPO}/contents`;
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/main`;
const SHARDS_DIR = 'shards';
const WORK = '/tmp/hub-sync-work';

// токен из remote основного репо (не хардкод)
function getToken() {
  // токен из remote основного репо (не хардкод)
  try {
    const out = execSync(
      'git -C /clients/322265183/swarm-cache remote get-url origin',
      { encoding: 'utf8' }
    ).trim();
    const m = out.match(/x-access-token:([^@]+)@/);
    return m ? m[1] : null;
  } catch { return null; }
}

const qhash = (q) => crypto.createHash('sha256').update(q.toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex');
const todayStr = () => new Date().toISOString().slice(0, 10);

async function ghList(dir, token) {
  const resp = await fetch(dir ? `${API_BASE}/${dir}` : API_BASE, {
    headers: { 'User-Agent': 'swarm-hub-sync', 'Accept': 'application/vnd.github+json', ...(token ? { Authorization: 'token ' + token } : {}) },
  });
  if (!resp.ok) throw new Error('ghList ' + resp.status);
  const d = await resp.json();
  return Array.isArray(d) ? d.map(f => f.name).filter(n => n.endsWith('.json')) : [];
}
async function ghFetch(file, token) {
  const resp = await fetch(`${RAW_BASE}/${file}?t=${Date.now()}`, { headers: { 'User-Agent': 'swarm-hub-sync' } });
  if (!resp.ok) throw new Error('ghFetch ' + file + ' ' + resp.status);
  const d = await resp.json();
  return Array.isArray(d) ? d : [];
}
async function ghFileSha(file, token) {
  const resp = await fetch(`${API_BASE}/${file}`, {
    headers: { 'User-Agent': 'swarm-hub-sync', 'Accept': 'application/vnd.github+json', ...(token ? { Authorization: 'token ' + token } : {}) },
  });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error('ghSha ' + resp.status);
  const d = await resp.json();
  return d.sha;
}
async function ghPushShard(records, token) {
  const day = todayStr();
  const file = `${SHARDS_DIR}/${day}.json`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await ghFetch(file, token).catch(() => []);
    const arr = existing;
    let added = 0;
    for (const r of records) {
      if (!arr.some(x => qhash(x.q) === qhash(r.q))) { arr.push(r); added++; }
    }
    if (!added) return { ok: true, added: 0 };
    const sha = await ghFileSha(file, token);
    const resp = await fetch(`${API_BASE}/${file}`, {
      method: 'PUT',
      headers: { 'Authorization': 'token ' + token, 'Content-Type': 'application/json', 'User-Agent': 'swarm-hub-sync' },
      body: JSON.stringify({ message: 'hub sync', content: Buffer.from(JSON.stringify(arr)).toString('base64'), ...(sha ? { sha } : {}) }),
    });
    if (resp.ok) return { ok: true, added };
    if (attempt === 2) throw new Error('ghPush ' + resp.status);
  }
  return { ok: false, added: 0 };
}

// ---- 1. GitHub → Хаб ----
async function syncGitHubToHub(db, token) {
  const shards = await ghList(SHARDS_DIR, token);
  const add = db.prepare('INSERT OR IGNORE INTO cache (question, qhash, answer, source, agent, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  let added = 0;
  for (const s of shards) {
    const arr = await ghFetch(SHARDS_DIR + '/' + s, token);
    for (const r of arr) {
      if (!r.q || !r.a) continue;
      const info = add.run(r.q, qhash(r.q), r.a, 'github', 'github-sync', r.ts || Math.floor(Date.now() / 1000));
      if (info.changes) added++;
    }
  }
  return added;
}

// ---- 2. Хаб → GitHub ----
async function syncHubToGitHub(db, token) {
  const rows = db.prepare('SELECT question, answer, created_at FROM cache').all();
  const records = rows.map(r => ({ q: r.question, a: r.answer, ts: r.created_at || Math.floor(Date.now() / 1000) }));
  const res = await ghPushShard(records, token);
  return res;
}

async function main() {
  const token = getToken();
  if (!token) { console.error('нет токена GitHub'); process.exit(1); }
  fs.mkdirSync(WORK, { recursive: true });
  const db = new Database(HUB_DB, { readonly: false });

  // GitHub → Хаб
  let g2h = 0;
  try { g2h = await syncGitHubToHub(db, token); console.log(`GitHub → Хаб: +${g2h} ответов`); }
  catch (e) { console.log('GitHub → Хаб: ошибка ' + e.message); }

  // Хаб → GitHub
  let h2g = 0;
  try { const r = await syncHubToGitHub(db, token); h2g = r.added; console.log(`Хаб → GitHub: +${h2g} ответов`); }
  catch (e) { console.log('Хаб → GitHub: ошибка ' + e.message); }

  const total = db.prepare('SELECT COUNT(*) c FROM cache').get().c;
  console.log(`Всего в хабе: ${total} ответов`);
  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
