'use strict';
/**
 * agentB — публикует ответ в IPFS (node2) и анонсирует в pubsub swarm-cache.
 * Запуск ПОСЛЕ agentA (agentA должен успеть подписаться).
 */
process.env.IPFS_URL = 'http://127.0.0.1:5002';
const { CacheKeeper } = require('./handler.js');

const QUESTION = 'Как работает консенсус в распределённых системах?';

async function main() {
  const keeper = await new CacheKeeper({
    dbPath: __dirname + '/cache-b.db',
    model: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
    threshold: 0.70,
  }).init();

  const qhash = keeper.hash(QUESTION);
  // 4.5: добавляем ответ в IPFS, получаем CID (автор = уникальный peerId узла node2)
  const cid = await keeper.ipfs.dag.put({
    question_hash: qhash, question: QUESTION,
    answer: '[agentB] Консенсус в распределённых системах достигается алгоритмами Paxos, Raft, PBFT; ключевые свойства — безопасность и живость.',
    agent: keeper._peerId, ts: Date.now(),
  });
  // 4.5: публикуем анонс {question_hash, cid} в топик swarm-cache
  await keeper.ipfs.pubsub.publish('swarm-cache', new TextEncoder().encode(JSON.stringify({
    question_hash: qhash, answer_cid: cid.toString(), agent: keeper._peerId,
  })));
  console.log('[agentB] ✅ опубликовал ответ в IPFS, CID=' + cid.toString());
  console.log('[agentB] ✅ анонс отправлен в swarm-cache (node2:' + keeper._peerId + ')');
  setTimeout(() => process.exit(0), 2000);
}

main().catch((e) => { console.error('[agentB] ❌', e.message); process.exit(1); });
