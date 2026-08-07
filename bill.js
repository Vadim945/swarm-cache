'use strict';
/**
 * bill.js — CLI для пользовательского биллинга.
 *
 *   node bill.js credit <userId> <amount> [note]  — начислить/пополнить (бонус беты: 10 ед)
 *   node bill.js list                             — балансы всех пользователей
 *   node bill.js price                            — тарифы
 *   node bill.js log <userId>                     — история операций
 */
const { Billing, GEN_COST, CACHE_COST, FREE_BONUS } = require('./billing.js');

const [,, cmd, ...args] = process.argv;
const bill = new Billing();

switch (cmd) {
  case 'credit': {
    const [userId, amount, ...noteParts] = args;
    if (!userId || !amount) { console.error('usage: node bill.js credit <userId> <amount> [note]'); process.exit(1); }
    const bal = bill.credit(Number(userId), Number(amount), noteParts.join(' ') || 'credit');
    console.log(`✅ Пользователь #${userId}: +${amount} ед → баланс ${bal} ед`);
    break;
  }
  case 'list': {
    const rows = bill.list();
    if (!rows.length) { console.log('Пользователей нет.'); break; }
    console.log('ID  name        status    credits');
    for (const r of rows) {
      console.log(`${String(r.id).padEnd(3)} ${String(r.name).padEnd(11)} ${r.revoked ? '🔴' : '🟢'}       ${r.credits}`);
    }
    break;
  }
  case 'price': {
    console.log(`Тарифы (единицы):`);
    console.log(`  Генерация (LLM): ${GEN_COST} ед`);
    console.log(`  Кэш-хит:         ${CACHE_COST} ед (в ${GEN_COST / CACHE_COST}× дешевле генерации)`);
    console.log(`  Бонус бета-ключа: ${FREE_BONUS} ед`);
    break;
  }
  case 'log': {
    const userId = Number(args[0]);
    if (!userId) { console.error('usage: node bill.js log <userId>'); process.exit(1); }
    for (const l of bill.log(userId)) {
      console.log(`${new Date(l.ts).toISOString()}  ${l.kind.padEnd(8)} ${l.delta > 0 ? '+' : ''}${l.delta}  ${l.note || ''}`);
    }
    break;
  }
  default:
    console.log('usage: node bill.js <credit <userId> <amount> [note] | list | price | log <userId>>');
}
