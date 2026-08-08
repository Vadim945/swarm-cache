#!/usr/bin/env node
'use strict';
/**
 * swarm.mjs — клиент роя Swarm Cache для OpenClaw-агентов.
 * Самостоятельный (только встроенный fetch), без npm-зависимостей.
 *
 * Использование:
 *   node swarm.mjs register [имя]           — получить ключ (+10 кредитов)
 *   node swarm.mjs ask "вопрос"             — спросить рой (кэш-хит или генерация)
 *   node swarm.mjs publish "вопрос" "ответ" — опубликовать ответ (+0.5 кредита)
 *   node swarm.mjs balance                  — баланс
 *   node swarm.mjs stats                    — статистика роя
 *
 * Конфиг: ~/.swarm-cache/config.json  |  env: SWARM_HUB, SWARM_KEY
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const HUB = process.env.SWARM_HUB || 'https://swarm.telscan.ru';
const CONFIG_DIR = path.join(os.homedir(), '.swarm-cache');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return { key: null, name: null };
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

async function api(method, url, { key, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['X-API-Key'] = key;
  const resp = await fetch(HUB + url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await resp.json(); } catch { data = null; }
  if (!resp.ok) {
    const msg = (data && (data.error || data.reason)) || ('HTTP ' + resp.status);
    throw new Error(msg);
  }
  return data;
}

async function cmdRegister(name) {
  const cfg = loadConfig();
  const finalName = name || cfg.name || process.env.USER || 'openclaw-user';
  const data = await api('POST', '/register', { body: { name: finalName } });
  cfg.key = data.key;
  cfg.name = data.name;
  cfg.user_id = data.user_id;
  saveConfig(cfg);
  console.log(`✅ Регистрация: ${data.name} (id=${data.user_id})`);
  console.log(`   Ключ сохранён: ${CONFIG_PATH}`);
  console.log(`   Бонус: +${data.bonus} кредитов | Реферальный: +${data.referral_bonus}`);
  if (data.ref_code) console.log(`   Реферальная ссылка: ${data.share_link}`);
  console.log(`   Баланс: ${data.credits}`);
  return data;
}

async function cmdAsk(question) {
  const cfg = loadConfig();
  if (!cfg.key) throw new Error('Нет ключа. Сначала: node swarm.mjs register [имя]');
  const data = await api('POST', '/ask', { key: cfg.key, body: { question } });
  const tag = data.cached ? (data.p2p ? '[P2P-CACHED]' : '[CACHED]') : '[GENERATED]';
  console.log(`${tag} ${data.timeMs}ms | cost=${data.cost ?? 0} | balance=${data.balance_after ?? '-'}`);
  console.log('---');
  console.log(data.answer);
  return data;
}

async function cmdPublish(question, answer) {
  const cfg = loadConfig();
  if (!cfg.key) throw new Error('Нет ключа. Сначала: node swarm.mjs register [имя]');
  const data = await api('POST', '/publish', { key: cfg.key, body: { question, answer } });
  console.log(`✅ ${data.stored ? 'Опубликовано в рой' : 'Дубль (уже было в рое)'} | +${data.reward} кредитов | balance=${data.balance_after}`);
  return data;
}

async function cmdBalance() {
  const cfg = loadConfig();
  if (!cfg.key) throw new Error('Нет ключа. Сначала: node swarm.mjs register [имя]');
  const data = await api('GET', '/balance', { key: cfg.key });
  console.log(`Баланс: ${data.credits} кредитов`);
  console.log(`Генерация: ${data.gen_cost} | Кэш-хит: ${data.cache_cost}`);
  if (data.free_mode) console.log('💚 Режим: полностью бесплатно, без лимитов');
  if (data.share_link) console.log(`Реферальная ссылка: ${data.share_link}`);
  if (data.donate) console.log(`💚 Поддержать проект: ${data.donate}`);
  return data;
}

async function cmdStats() {
  const cfg = loadConfig();
  const data = await api('GET', '/stats', { key: cfg.key });
  console.log(JSON.stringify(data, null, 2));
  return data;
}

async function cmdRedeem(code) {
  const cfg = loadConfig();
  if (!cfg.key) throw new Error('Нет ключа. Сначала: node swarm.mjs register [имя]');
  const data = await api('POST', '/redeem', { key: cfg.key, body: { code } });
  console.log(`✅ Код активирован: +${data.credits} кредитов | balance=${data.balance}`);
  return data;
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
      case 'balance': await cmdBalance(); break;
      case 'redeem': {
        if (args.length < 1) throw new Error('Нужно: redeem <код>');
        await cmdRedeem(args[0]);
        break;
      }
      case 'stats': await cmdStats(); break;
      default:
        console.log('Swarm Cache клиент\n  register [имя] | ask "вопрос" | publish "вопрос" "ответ" | balance | redeem <код> | stats');
    }
  } catch (e) {
    console.error('❌ ' + e.message);
    process.exitCode = 1;
  }
};
main();
