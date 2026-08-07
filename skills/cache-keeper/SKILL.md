# cache-keeper

Универсальный семантический кэш ответов LLM для агентов «Коллективного Разума» (Swarm Cache).

## Description
Навык кэширует ответы LLM по семантике (векторный поиск, порог сходства 0.92), обменивается
кэшем с другими агентами через IPFS pubsub (топик `swarm-cache`) и проводит микро-платежи
L402 (эмуляция Lightning: 1 сатоши за P2P-ответ) с логом `payments.log`.

## Когда использовать
- Агент получил вопрос и хочет проверить, не отвечал ли уже кто-то из роя на похожий вопрос.
- Нужно сэкономить токены: повторные и семантически близкие вопросы обслуживаются из кэша.
- Нужно раздать свои ответы другим агентам роя через IPFS.

## Установка (для любого агента)
Путь навыка: `skills/cache-keeper/`. Зависимости (в корне проекта агента):
```
npm install better-sqlite3 sqlite-vec @xenova/transformers ipfs-http-client
```
IPFS-нода: `docker run -d --name ipfs-node -v ~/ipfs-data:/data/ipfs -p 4001:4001 -p 5001:5001 ipfs/kubo:latest`

## Интеграция
```js
const { CacheKeeper } = require('./skills/cache-keeper/handler.js');
const keeper = await new CacheKeeper().init();
const r = await keeper.ask('Объясни, как работает Attention в трансформерах');
// r.answer, r.cached (true/false), r.p2p (true/false), r.timeMs
```

## Логика
1. Вопрос -> SHA-256 (qhash) + эмбеддинг (локальный all-MiniLM-L6-v2, 384d).
2. Поиск в SQLite (sqlite-vec, cosine). Сходство >= 0.92 -> ответ `[Cached]`.
3. Иначе поиск по IPFS: qhash -> CID (индекс в БД) -> `dag.get`. Найдено -> `[P2P Cached]`,
   платим автору 1 сатоши (балансы в SQLite, лог `payments.log`).
4. Иначе генерируем ответ, кладём в кэш и публикуем в IPFS (dag.put + pubsub в `swarm-cache`).

## Выход
- `cache.db` — кэш, векторы (vec0), балансы, индекс CID, журнал транзакций.
- `payments.log` — все микро-платежи построчно.
- `cache-keeper.log` — служебный лог.
