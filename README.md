# 🐝 Swarm Cache — коллективный разум v2.0

Семантический кэш ответов LLM + P2P-обмен через IPFS + микро-платежи (L402).

Один агент спросил — весь рой знает. Повторные и семантически похожие вопросы отдаются из локального кэша за **~15 мс** вместо 5–9 секунд генерации LLM. Кэш-хит стоит **в 10× дешевле** генерации.

**Живое демо:** https://swarm.telscan.ru (self-serve: ввёл имя → получил API-ключ + 10 ед бонуса)

## Возможности

| Возможность | Детали |
|---|---|
| ⚡ Семантический кэш | SQLite + sqlite-vec (vec0, cosine), эмбеддинги локально через transformers.js, порог сходства 0.70 (калибруется) |
| 🧠 Реальный LLM | DeepSeek V4 Flash через OpenAI-совместимый API (TimeWeb Cloud), честный подсчёт токенов из `usage` |
| 🔄 P2P-обмен | IPFS kubo + pubsub: ответы распространяются между агентами роя (dag.put → pubsub-анонс → индекс qhash→CID) |
| ⚡️ Микро-платежи | L402-совместимая модель: 1 сатоши автору за P2P-ответ, балансы в SQLite, защита от отрицательного баланса |
| 🔑 API-ключи | SHA-256 хэши, rate limit 30 req/мин, self-serve регистрация, бонус беты 10 ед |
| 💰 Биллинг | генерация 1 ед, кэш-хит 0.1 ед, HTTP 402 при нехватке баланса |

## Быстрый старт

```bash
# 1. Зависимости
npm install better-sqlite3 sqlite-vec @xenova/transformers ipfs-http-client express

# 2. IPFS-нода (Docker)
docker run -d --name ipfs-node -v ~/ipfs-data:/data/ipfs \
  -p 4001:4001 -p 127.0.0.1:5001:5001 ipfs/kubo:latest
docker exec ipfs-node ipfs config Pubsub.Enabled --bool=true

# 3. Ключ LLM (опционально, без него — локальная заглушка)
cat > .env <<EOF
LLM_API_KEY=sk-...
LLM_BASE_URL=https://api.timeweb.ai/v1
LLM_MODEL=deepseek/deepseek-v4-flash
EOF

# 4. Запуск
node agent.js   # HTTP API на 127.0.0.1:3333
```

## API

```bash
# Получить ключ (self-serve)
curl -X POST https://swarm.telscan.ru/register -H "Content-Type: application/json" -d '{"name":"Иван"}'

# Задать вопрос
curl -X POST https://swarm.telscan.ru/ask \
  -H "X-API-Key: <KEY>" -H "Content-Type: application/json" \
  -d '{"question":"Объясни, как работает Attention в трансформерах"}'

# Баланс и тарифы
curl https://swarm.telscan.ru/balance -H "X-API-Key: <KEY>"
curl https://swarm.telscan.ru/pricing
```

Ответ `/ask`:
```json
{
  "answer": "[Cached] ...",
  "cached": true,
  "p2p": false,
  "similarity": 1.0,
  "tokens": 0,
  "timeMs": 18,
  "cost": 0.1,
  "balance_after": 8.8
}
```

## Рой из нескольких агентов

Каждый агент — свой kubo-узел, своя БД, свой peerId. Подписка на pubsub-топик `swarm-cache`.
Ответ агента публикуется в DAG, анонсируется в топик, другие агенты находят его по qhash→CID индексу
и получают по CID. Автору начисляется 1 сатоши за первый полученный ответ (дедупликация).

```bash
# Агент B (второй узел)
IPFS_URL=http://127.0.0.1:5002 SWARM_PORT=3334 node agent.js
```

## Управление

```bash
node apikey.js add <имя>            # создать ключ (+10 ед бонуса)
node apikey.js list                 # пользователи
node apikey.js revoke <id>          # отозвать
node bill.js credit <id> <кол-во>   # пополнить баланс
node bill.js list                   # балансы
node bill.js log <id>               # история операций
```

## Метрики (E2E)

- Холодный ответ (генерация LLM): **~650–750 токенов**, 4–9 с
- Кэш-хит: **0 токенов**, **12–30 мс** (sim=1.0 для повторов, ~0.72+ для парафраз)
- Экономия токенов: **~70–80%** на серии повторных запросов
- P2P-обмен между двумя агентами: ответ получен через pubsub за **9–18 мс**
- Платежи: ровно 1 сатоши за первое получение, защита от отрицательного баланса

## Тесты

```bash
node skills/cache-keeper/test.js   # unit
node e2e.js                        # end-to-end
```

## Лицензия

MIT
