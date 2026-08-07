'use strict';
/**
 * Тест 4.6/5.4: два изолированных процесса агента, обмен через IPFS pubsub.
 * - agentA: подписан на swarm-cache (kubo node1, 127.0.0.1:5001), БД cache-a.db
 * - agentB: публикует ответ (kubo node2, 127.0.0.1:5002), БД cache-b.db
 * Оба узла соединены в swarm (docker bridge 172.17.0.1).
 * Запуск: node p2p-two-process-agent-a.js  (ожидает сообщение)
 *          node p2p-two-process-agent-b.js  (публикует)
 */
process.env.IPFS_URL = 'http://127.0.0.1:5001';
const { CacheKeeper } = require('./handler.js');

const QUESTION = 'Как работает консенсус в распределённых системах?';
const TIMEOUT_MS = 30000;

async function main() {
  const keeper = new CacheKeeper({
    dbPath: __dirname + '/cache-a.db',
    model: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
    threshold: 0.70,
    onMessage: async (msg) => {
      console.log(`[agentA] ✅ pubsub-сообщение получено от ${msg.agent}: qhash=${msg.question_hash.slice(0, 12)}...`);
      // платёж уже выполнен в handlePeerMessage — проверяем итоговый баланс автора
      const bal = keeper.balance(msg.agent);
      const r = await keeper.ask(QUESTION);
      console.log(`[agentA] ask(${QUESTION.slice(0, 40)}...) -> cached=${r.cached} p2p=${r.p2p} source=${r.source} time=${r.timeMs}ms`);
      console.log(`[agentA] баланс ${msg.agent}: ${bal} sat ${bal === 1 ? '✅ (+1, оплата автору)' : '❌ expected 1'}`);
      console.log('[agentA] ответ:', r.answer.slice(0, 100));
      console.log('[agentA] stats:', JSON.stringify(keeper.stats().balances));
      console.log('[agentA] ✅ P2P-обмен через pubsub подтверждён');
      process.exit(0);
    },
  });
  await keeper.init();
  console.log(`[agentA] слушаю топик swarm-cache (node1:${keeper._peerId})...`);
  setTimeout(() => {
    console.log('[agentA] ❌ TIMEOUT: сообщение не пришло за ' + TIMEOUT_MS + 'ms');
    process.exit(1);
  }, TIMEOUT_MS).unref();
}

main().catch((e) => { console.error('[agentA] ❌', e.message); process.exit(1); });
