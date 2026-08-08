# 🐝 Swarm Cache — скилл для OpenClaw (рой без сервера)

**Коллективная память для твоего ИИ-агента: повторные вопросы отвечаются мгновенно, без траты токенов. И всё это — без единого сервера.**

Установи скилл → твой агент подключится к рою: общая база ответов живёт в GitHub,
поиск идёт локально, генерация — через твой LLM-ключ. Свои ответы ты возвращаешь
рою, и они помогают другим.

> Каждый установивший скилл = новый узел роя. Чем больше узлов — тем больше
> ответов в общей базе и тем чаще кэш-хиты для всех.

## 🚀 Установка одной командой

Скорми своему OpenClaw:

```bash
openclaw skills install git:Vadim945/openclaw-swarm-cache
```

Или просто скажи своему агенту: *«установи скилл по ссылке
https://github.com/Vadim945/openclaw-swarm-cache»* — он сделает сам.

Затем зарегистрируй узел (скачает базу роя):

```bash
node ~/.openclaw/workspace/skills/swarm-cache/swarm.mjs register "Твоё имя"
```

Всё. Никаких npm-зависимостей — только встроенный `fetch` (Node 18+).

## 🎯 Как это работает

| Шаг | Действие | Результат |
|---|---|---|
| 1 | `swarm ask "вопрос"` | Кэш-хит: ответ из базы роя, 0 токенов |
| 2 | Промах → своя LLM | Генерация через твой ключ (config set llmKey) |
| 3 | `swarm publish "вопрос" "ответ"` | Ответ возвращается рою (GitHub) |

**Семантика, не строки:** «расскажи про dropout» и «что такое dropout» — один
кэш-хит. Стоп-слова отсекаются, считаются значимые.

## 🏗 Архитектура — без сервера

```
[узел A] --(publish)--> [GitHub: Vadim945/swarm-cache-data] <--(pull)-- [узел B]
```

- **Никаких VPS и хабов.** Общая память роя — публичный репозиторий `cache.json`.
- **LLM — своя.** Рой не тратит ни копейки: генерация через ключ пользователя.
- **Узел не зависит ни от чего** — база локальная, поиск локальный.

## 🔧 Команды

```bash
node swarm.mjs register [имя]            # регистрация + синхронизация
node swarm.mjs ask "вопрос"              # поиск в базе роя
node swarm.mjs publish "вопрос" "ответ"  # вклад в рой (+ push в GitHub)
node swarm.mjs sync                      # синхронизация с GitHub
node swarm.mjs config set <поле> <знач>  # настройка (llmUrl/llmKey/llmModel/githubToken)
node swarm.mjs balance                   # статус узла
node swarm.mjs stats                     # статистика базы
```

## ⚙️ Настройка (всё опционально)

```bash
node swarm.mjs config set llmUrl "https://api.timeweb.ai/v1/chat/completions"
node swarm.mjs config set llmKey "ваш-ключ"
node swarm.mjs config set llmModel "deepseek/deepseek-v4-flash"
node swarm.mjs config set githubToken "ваш-токен"   # возвращать ответы рою
```

Секреты лежат в `~/.swarm-cache/config.json` (права 600).

## 📦 Требования

- Node.js ≥ 18 (встроенный fetch)
- Ноль npm-зависимостей
- Доступ к GitHub (raw + API, бесплатно)

## 🌐 Ссылки

- База роя: https://github.com/Vadim945/swarm-cache-data
- Исходники проекта: https://github.com/Vadim945/swarm-cache

---

**Почему это выгодно каждому участнику:** твой агент отвечает на повторные
вопросы мгновенно и бесплатно, а с каждым новым узлом база роя становится
больше — выигрывают все.
