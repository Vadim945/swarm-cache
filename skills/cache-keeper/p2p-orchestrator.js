'use strict';
/** Оркестратор теста 4.6: запускает agentA (subscriber) и agentB (publisher), синхронизирует, собирает вывод. */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const DIR = __dirname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(name, args, timeoutMs = 45000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: DIR });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => resolve({ name, code, out }));
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
  });
}

async function main() {
  for (const f of ['cache-a.db', 'cache-a.db-wal', 'cache-a.db-shm', 'cache-b.db', 'cache-b.db-wal', 'cache-b.db-shm', 'payments.log', 'cache-keeper.log']) {
    try { fs.unlinkSync(path.join(DIR, f)); } catch {}
  }
  console.log('=== 4.6: two isolated processes, IPFS pubsub (node1 <-> node2) ===\n');
  const aPromise = run('agentA', ['p2p-two-process-agent-a.js'], 50000);
  await sleep(8000); // даём agentA подписаться
  const b = await run('agentB', ['p2p-two-process-agent-b.js'], 20000);
  console.log(b.out);
  const a = await aPromise;
  console.log('\n=== agentA (subscriber on node1) ===');
  console.log(a.out);
  console.log('=== payments.log ===');
  try { console.log(fs.readFileSync(path.join(DIR, 'payments.log'), 'utf8')); } catch {}
  const ok = a.out.includes('✅ P2P-обмен через pubsub подтверждён') && a.out.includes('+1');
  console.log(ok ? '\n✅ TEST 4.6 PASSED' : '\n❌ TEST 4.6 FAILED');
  process.exit(ok ? 0 : 1);
}

main();
