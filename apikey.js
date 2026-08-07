'use strict';
/**
 * apikey.js — управление API-ключами Swarm Cache.
 *
 *   node apikey.js add <имя>     — создать ключ (показывается ОДИН раз)
 *   node apikey.js list          — список пользователей
 *   node apikey.js revoke <id>   — отозвать ключ
 */
const { UserAuth } = require('./auth.js');

const [,, cmd, arg] = process.argv;
const auth = new UserAuth();

switch (cmd) {
  case 'add': {
    if (!arg) { console.error('usage: node apikey.js add <name>'); process.exit(1); }
    const { id, name, key } = auth.createKey(arg);
    console.log(`✅ Пользователь #${id} «${name}» создан.`);
    console.log(`\n🔑 API-ключ (сохраните, показывается один раз):\n${key}\n`);
    console.log(`Использование: curl -X POST https://<host>/ask -H "X-API-Key: ${key}" -H "Content-Type: application/json" -d '{"question":"..."}'`);
    break;
  }
  case 'list': {
    const rows = auth.list();
    if (!rows.length) { console.log('Пользователей пока нет.'); break; }
    for (const r of rows) {
      console.log(`#${r.id}  ${r.name}  ${new Date(r.created_at).toISOString()}  ${r.revoked ? '🔴 revoked' : '🟢 active'}`);
    }
    break;
  }
  case 'revoke': {
    if (!arg) { console.error('usage: node apikey.js revoke <id>'); process.exit(1); }
    console.log(auth.revoke(Number(arg)) ? `✅ Ключ #${arg} отозван` : `❌ Пользователь #${arg} не найден`);
    break;
  }
  default:
    console.log('usage: node apikey.js <add <name> | list | revoke <id>>');
}
