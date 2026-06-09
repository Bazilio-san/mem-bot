# План-промпт: миграция конфигурации mem-bot с `.env` на node-config (YAML-иерархия)

> Этот документ — самодостаточное техническое задание для Claude Code. В нём собрано всё необходимое,
> чтобы перевести конфигурирование проекта `mem-bot` с плоского файла `.env` (через `dotenv`) на пакет
> **node-config** (`config`) с иерархией YAML-файлов.
> Выполнять задачу следует в отдельной git-ветке (или worktree), с прогоном тестов в конце.

---

## 1. Зачем это нужно (контекст и цель)

Сейчас все параметры приложения хранятся в одном плоском файле `.env`, читаются через `dotenv` и
вручную приводятся к типам в `src/config.js` (обёртки `Number(...)`, `flag(...)`, разбор строк через
`split`). У такого подхода есть недостатки:

- Плоское пространство имён: десятки переменных без структуры, легко ошибиться в названии.
- Дублирование значений по умолчанию между `.env.example` и `src/config.js`.
- Нет различения окружений (разработка/продакшен) средствами самого механизма конфигурации —
  всё держится на одном `.env` и ручной логике.
- Секреты и несекретные значения свалены в один файл.

Цель — перейти на **node-config**, где:

- Структура и значения по умолчанию задаются один раз в `config/default.yaml` с подробными комментариями.
- Окружение выбирается переменной `NODE_ENV` (или `NODE_CONFIG_ENV`): подхватываются
  `config/development.yaml` либо `config/production.yaml`.
- Локальные переопределения и секреты лежат в `config/local.yaml` (он в `.gitignore`).
- Переменные окружения по-прежнему могут переопределять любое значение через карту
  `config/custom-environment-variables.yaml` — это обеспечивает обратную совместимость с текущими
  деплоями и с существующим `.env`.

**Требование совместимости:** существующие имена переменных окружения (`OPENAI_API_KEY`,
`PROACTIVE_ENABLED` и так далее) продолжают работать. Достигается это тем, что `dotenv` по-прежнему
загружает `.env` в `process.env`, а `custom-environment-variables.yaml` сопоставляет эти имена с путями
в дереве конфигурации.

**Сознательные исключения из совместимости** (меняются намеренно, см. разделы 6.2–6.6):

- Подключение к БД переводится на пакет `af-db-ts`: строки `DATABASE_URL`/`MEM_DATABASE_URL`/
  `MEM_DB_NAME` упраздняются, вместо них — раздельные `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/
  `DB_PASSWORD` (раздел `db.postgres.dbs`).
- Булевы флаги переходят с `on`/`off` на `true`/`false`.
- Вся конфигурация Telegram сводится в ветку `telegram:` (включая отображение потока —
  `telegram.streaming.*`), а имена новых/перемещённых переменных приводятся к иерархии YAML
  (например, `OUTBOX_SAFETY_INTERVAL_MS` → `TELEGRAM_OUTBOX_SAFETY_INTERVAL_MS`,
  `LLM_STREAMING_ENABLED` → `STREAMING_ENABLED`, `WORKER_ID` → `SCHEDULER_WORKER_ID`). Полный список —
  раздел 7.0a.

---

## 2. Как устроен node-config (краткая справка по документации)

Источник: официальная вики `https://github.com/node-config/node-config/wiki`.

### 2.1. Каталог и формат файлов

- Все файлы конфигурации лежат в каталоге `config/` в корне проекта (каталог можно переопределить
  переменной `NODE_CONFIG_DIR`).
- Поддерживаются форматы JSON, JSON5, YAML, JS и другие. Для YAML node-config подгружает пакет
  `js-yaml`, поэтому его нужно добавить в зависимости.
- Доступ к значениям в коде: `config.get('путь.до.значения')` возвращает значение или бросает
  исключение, если ключа нет; `config.has('путь')` возвращает булево, есть ли ключ.

### 2.2. Порядок загрузки и приоритет (важнейшая часть)

Файлы загружаются в строго определённом порядке, каждый следующий переопределяет предыдущий.
Упрощённо (полный список в вики, раздел «Configuration Files → File Load Order»):

1. `default.{EXT}` — базовые значения для всех окружений.
2. `default-{instance}.{EXT}` — необязательно, по имени инстанса (`NODE_APP_INSTANCE`).
3. `{deployment}.{EXT}` — файл окружения, где `{deployment}` равно значению `NODE_ENV`
   (или `NODE_CONFIG_ENV`, если она задана). Например `development.yaml` или `production.yaml`.
4. `{deployment}-{instance}.{EXT}` — необязательно.
5. `{hostname}.{EXT}` и его варианты — по имени хоста (используется редко).
6. `local.{EXT}` — локальные переопределения конкретной машины (не коммитится).
7. `local-{deployment}.{EXT}` — локальные переопределения для конкретного окружения.
8. **`custom-environment-variables.{EXT}`** — карта «путь конфигурации → имя переменной окружения».
   Переменные окружения переопределяют значения из всех файлов выше.
9. Переменная `NODE_CONFIG` (JSON-строка) и аргумент командной строки `--NODE_CONFIG` —
   наивысший приоритет.

Иными словами: **значения из файлов перекрываются переменными окружения, а те — прямым
`NODE_CONFIG`.** Это именно то, что нужно: YAML задаёт структуру и значения по умолчанию,
а текущие переменные окружения (через `.env` или реальное окружение) продолжают всё переопределять.

### 2.3. Выбор окружения

- `NODE_ENV=production` заставит node-config подхватить `config/production.yaml`.
- `NODE_ENV=development` (или не задано — по умолчанию node-config считает окружение `development`)
  подхватит `config/development.yaml`.
- `NODE_CONFIG_ENV` имеет приоритет над `NODE_ENV` для выбора файла окружения (удобно, когда
  `NODE_ENV` нужно держать в `production`, а конфигурацию брать, например, `qa`).

### 2.4. Карта переменных окружения (`custom-environment-variables.yaml`)

Файл повторяет структуру дерева конфигурации, но вместо значений в листьях стоят **имена переменных
окружения**. Если переменная задана в окружении — её значение переопределяет файл. Для типизации и
сложных значений используется расширенная форма:

```yaml
someSection:
  simpleString: SOME_ENV_NAME            # строка как есть
  numericValue:
    __name: SOME_NUMBER_ENV              # имя переменной окружения
    __format: number                     # привести к числу
  jsonValue:
    __name: SOME_JSON_ENV
    __format: json                       # распарсить как JSON (массивы, объекты)
```

Поддерживаемые значения `__format`: `boolean`, `number`, `json`. **Решение по булевым (принято):**
все флаги переводятся на канонические значения `true`/`false`. Прежний формат `on`/`off` и помощник
`flag()` **упраздняются**. В `default.yaml` флаги хранятся как нативные булевы YAML (`true`/`false`),
в `custom-environment-variables.yaml` помечаются `__format: boolean`, а в коде читаются напрямую как
булевы — без нормализации (см. раздел 6.3). При миграции значения `on`/`off` в `.env.example` и в
документации заменяются на `true`/`false`.

---

## 3. Роли файлов node-config (на что ориентироваться)

Канонический паттерн node-config распределяет конфигурацию по нескольким файлам в каталоге `config/`:

- `default.yaml` — полная схема со всеми секциями, значениями по умолчанию и подробными комментариями.
  Удобно оформлять «документирующие» пояснения префиксом `#>`, а второстепенные заметки — обычным `#`.
  Каждый параметр снабжается человекочитаемым описанием прямо в YAML.
- `custom-environment-variables.yaml` — карта «путь конфигурации → имя переменной окружения», с формами
  `__name`/`__format` для чисел и булевых. Пример строк:
  ```yaml
  db:
    postgres:
      dbs:
        main:
          database: DB_NAME
          host: DB_HOST
          port:
            __name: DB_PORT
            __format: number
  ```
- `development.yaml` / `production.yaml` / `test.yaml` — почти пустые (`---` и пара переопределений):
  значения по умолчанию живут в `default.yaml`, а окруженческие файлы держат только различия.
- `local.yaml` — реальные секреты и локальные значения (пароли, токены, ключи LLM, параметры
  подключения). Этот файл **не коммитится** и предназначен для конкретной машины разработчика.

Вывод для нас: основная работа — наполнить `default.yaml` структурой и значениями по умолчанию,
собрать карту `custom-environment-variables.yaml` со всеми текущими именами переменных, оставить
`development.yaml`/`production.yaml`/`test.yaml` минимальными, а секреты увести в `local.yaml`.

---

## 4. Полный инвентарь текущих параметров

Ниже — все параметры, которые сейчас читаются из окружения. Источник «config.js» означает, что
переменная попадает в экспортируемый объект `config`. Источник «прямой» означает чтение
`process.env.*` напрямую в модуле-потребителе.

### 4.1. Параметры из `src/config.js`

| Переменная окружения | Путь в `config` (текущая форма) | Тип | Значение по умолчанию |
|----------------------|--------------------------------|-----|----------------------|
| `DB_HOST` | `db.postgres.dbs.main.host` | string | `localhost` (пусто → БД выключена) |
| `DB_PORT` | `db.postgres.dbs.main.port` | number | `5432` |
| `DB_NAME` | `db.postgres.dbs.main.database` | string | `mem_bot` |
| `DB_USER` | `db.postgres.dbs.main.user` | string (секрет) | — |
| `DB_PASSWORD` | `db.postgres.dbs.main.password` | string (секрет) | — |

> **Изменение модели подключения к БД.** Прежние строки подключения (`DATABASE_URL`, `MEM_DATABASE_URL`,
> `MEM_DB_NAME`) **упраздняются**. Доступ к БД переводится на пакет **`af-db-ts`**, который читает
> параметры подключения из node-config по пути `db.postgres.dbs.<connectionId>`. Поэтому структура
> раздела `db:` строится **в точности** под ожидания `af-db-ts` (см. разделы 5.2, 6.6, 7.1 и README
> пакета). Логическое имя рабочего подключения — `main`. Для административного
> подключения (создание БД памяти в `src/migrate.js`) заводится второй алиас (`bootstrap`),
> подключённый к служебной базе `postgres`.
| `OPENAI_API_KEY` | `llm.apiKey` | string (секрет) | — |
| `OPENAI_BASE_URL` | `llm.baseURL` | string | пусто → прямой OpenAI API |
| `MAIN_MODEL` | `llm.mainModel` | string | `gpt-5.4-mini` |
| `AUX_MODEL` | `llm.auxModel` | string | `gpt-5.4-nano` |
| `EXTRACT_MODEL` | `llm.extractModel` | string | `gpt-5.4-mini` |
| `EMBED_MODEL` | `llm.embedModel` | string | `text-embedding-3-small` |
| (константа) | `llm.embedDim` | number | `1536` |
| `AUTH_SECRET` | `authSecret` | string (секрет) | `dev-insecure-secret-change-me` |
| `TZ_DEFAULT` | `timezone` | string | `Europe/Moscow` |
| `DEBUG` | `debug` (массив категорий) | string→array | пусто |
| `COMPANION_MODE` | `companion.enabled` | flag | `false` |
| `PROACTIVE_ENABLED` | `proactive.enabled` | flag | `false` |
| `PROACTIVE_INTERVAL_MS` | `proactive.intervalMs` | number | `300000` |
| `PROACTIVE_INACTIVITY_MIN` | `proactive.inactivityMinutes` | number | `1440` |
| `PROACTIVE_CHECKIN_HOUR` | `proactive.checkinHour` | number | `10` |
| `PROACTIVE_GOAL_INTERVAL_MIN` | `proactive.goalIntervalMinutes` | number | `2880` |
| `PROACTIVE_WELCOME_GAP_MIN` | `proactive.welcomeBackGapMinutes` | number | `60` |
| `PROACTIVE_SOFT_DAILY_LIMIT` | `proactive.contactPolicy.softDailyLimit` | number | `1` |
| `PROACTIVE_SOFT_WEEKLY_LIMIT` | `proactive.contactPolicy.softWeeklyLimit` | number | `3` |
| `PROACTIVE_REQUESTED_REMINDER_DAILY_LIMIT` | `proactive.contactPolicy.requestedReminderDailyLimit` | number | `2` |
| `PROACTIVE_MIN_SOFT_PAUSE_MIN` | `proactive.contactPolicy.minSoftPauseMinutes` | number | `360` |
| `PROACTIVE_QUIET_AFTER_UNANSWERED` | `proactive.contactPolicy.quietAfterUnanswered` | number | `2` |
| `PROACTIVE_QUIET_HOURS_AFTER_IGNORES` | `proactive.contactPolicy.quietHoursAfterIgnores` | number | `24` |
| `PROACTIVE_EVENTS_ENABLED` | `proactive.events.enabled` | flag | `false` |
| `NEWS_RELEVANCE_THRESHOLD` | `proactive.events.relevanceThreshold` | number | `0.6` |
| `SCHEMA_KEY_EMBED_THRESHOLD` | `schema.keyEmbedThreshold` | number | `0.82` |
| `SKILLS_DIR` | `skills.dir` | string | `skills` |
| `SKILLS_SWITCH_THRESHOLD` | `skills.switchThreshold` | number | `0.65` |
| `SKILL_REFERENCE_MAX_BYTES` | `skills.referenceMaxBytes` | number | `50000` |
| `SKILL_AUTHORING_ENABLED` | `skills.authoring.enabled` | flag | `false` |
| `SKILL_AUTHORING_MODEL` | `skills.authoring.model` | string\|null | `null` (→ `llm.mainModel`) |
| `MEMORY_LIMIT_PROFILE` | `memoryLimits.profile` | number | `7` |
| `MEMORY_LIMIT_DIALOG` | `memoryLimits.dialog` | number | `5` |
| `MEMORY_LIMIT_DOMAIN` | `memoryLimits.domain` | number | `12` |
| `MEMORY_LIMIT_REMINDER` | `memoryLimits.reminder` | number | `3` |
| `MEMORY_LIMIT_SECURE` | `memoryLimits.secure` | number | `3` |
| `MEMORY_LIMIT_TOTAL` | `memoryLimits.total` | number | `30` |
| `GLOBAL_MEMORY_ENABLED` | `globalMemory.factsEnabled` | flag | `false` |
| `GLOBAL_FACTS_LIMIT` | `globalMemory.factsLimit` | number | `5` |
| `GLOBAL_RAG_ENABLED` | `globalMemory.ragEnabled` | flag | `false` |
| `GLOBAL_RAG_LIMIT` | `globalMemory.ragLimit` | number | `5` |
| `GLOBAL_RAG_MIN_RELEVANCE` | `globalMemory.ragMinRelevance` | number | `0.3` |
| `VOICE_INPUT_ENABLED` | `voiceInput.enabled` | flag | `false` |
| `VOICE_INPUT_PROVIDER` | `voiceInput.provider` | string | `groq-whisper-large-v3-turbo` |
| `VOICE_INPUT_MAX_SECONDS` | `voiceInput.maxSeconds` | number | `300` |
| `VOICE_INPUT_MAX_BYTES` | `voiceInput.maxBytes` | number | `25000000` |
| `VOICE_INPUT_LANG` | `voiceInput.language` | string | `ru` |
| `VOICE_OUTPUT_ENABLED` | `voiceOutput.enabled` | flag | `false` |
| `VOICE_OUTPUT_MODEL` | `voiceOutput.model` | string | зависит от `OPENAI_BASE_URL` |
| `VOICE_OUTPUT_VOICE` | `voiceOutput.voice` | string | `alloy` (через `normalizeVoiceId`) |
| `VOICE_OUTPUT_FORMAT` | `voiceOutput.format` | string | `opus` |
| `VOICE_OUTPUT_MAX_CHARS` | `voiceOutput.maxChars` | number (≤500) | `500` |
| `VOICE_OUTPUT_SUMMARY_MAX_CHARS` | `voiceOutput.summaryMaxChars` | number | `500` |
| `VOICE_OUTPUT_SUMMARY_MODEL` | `voiceOutput.summaryModel` | string | `AUX_MODEL` → `gpt-5.4-nano` |
| `LLM_STREAMING_ENABLED` | `streaming.enabled` | flag | `true` |
| `TELEGRAM_STREAMING_ENABLED` | `streaming.telegramEnabled` | flag | `true` |
| `TELEGRAM_STREAM_EDIT_INTERVAL_MS` | `streaming.editIntervalMs` | number | `500` |
| `TELEGRAM_STREAM_MIN_EDIT_CHARS` | `streaming.minEditChars` | number | `20` |
| `TELEGRAM_STREAM_MIN_FIRST_DRAFT_CHARS` | `streaming.minFirstDraftChars` | number | `50` |
| `TELEGRAM_TOOL_STATUS_ENABLED` | `streaming.toolStatuses` | flag | `true` |
| `HISTORY_COMPRESSION_ENABLED` | `historyCompression.enabled` | flag | `false` |
| `HISTORY_HOT_WINDOW` | `historyCompression.hotWindow` | number | `8` |
| `HISTORY_MAX_TOKENS` | `historyCompression.maxTokens` | number | `2000` |
| `HISTORY_SHRINK_TOKENS` | `historyCompression.shrinkTokens` | number | `800` |
| `HISTORY_ZONE_WEIGHTS` | `historyCompression.zoneWeights` | string→array | `0.55,0.30,0.15` |
| `HISTORY_SUMMARY_MODEL` | `historyCompression.model` | string | `AUX_MODEL` → `gpt-5.4-nano` |
| `HISTORY_MIN_COMPRESS_GAIN` | `historyCompression.minCompressGain` | number | `0.35` |

### 4.2. Прямые потребители `process.env` (вне `config.js`)

| Переменная | Файл и строка | Назначение | Значение по умолчанию |
|-----------|---------------|-----------|----------------------|
| `TELEGRAM_API_KEY` | `src/telegram/bot.js:37` | токен Telegram-бота (секрет) | — (обязателен) |
| `TELEGRAM_MAX_CONCURRENCY` | `src/telegram/bot.js:57` | предел параллельных обработок | `5` |
| `OUTBOX_SAFETY_INTERVAL_MS` | `src/telegram/bot.js:54` | период страховочного слива очереди | `30000` |
| `SCHEDULER_MIN_SLEEP_MS` | `src/telegram/bot.js:49`, `src/scheduler-run.js:17` | нижняя граница сна воркера | `250` |
| `SCHEDULER_MAX_SLEEP_MS` | `src/telegram/bot.js:50`, `src/scheduler-run.js:20` | верхняя граница сна воркера | `30000` |
| `WORKER_ID` | `src/pipeline/scheduler.js:19` | идентификатор воркера планировщика | `scheduler-1` |
| `SANDBOX_PORT` | `src/sandbox/server.js:13` | порт песочницы | `3000` |
| `MCP_CONFIG_PATH` | `src/mcp/config.js:10` | путь к файлу `.mcp.json` | `.mcp.json` |

### 4.3. Переменные, присутствующие в `.env.example`, но НЕ читаемые кодом

Эти переменные есть в примере, но `src/config.js` и другие модули их не используют. На этапе миграции
нужно **проверить** их реальных потребителей (grep по всему репозиторию) и либо учесть, либо удалить
из примера, чтобы не плодить мёртвую конфигурацию. Кандидаты:

- `LLM_PROVIDER`, `CEREBRAS_API_KEY`, `CEREBRAS_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` —
  заготовки под альтернативных провайдеров LLM.
- `TAVILY_API_KEY` — веб-поиск (проверить, используется ли в навыках/инструментах).
- `ASSEMBLYAI_API_KEY`, `GROQ_API_KEY` — ключи распознавания речи. **Скорее всего используются**
  в `src/voice/transcribe.js` и в экспериментальных скриптах `scripts/*-experiment.js`. Обязательно
  выполнить `grep -rn "ASSEMBLYAI_API_KEY\|GROQ_API_KEY\|TAVILY_API_KEY" src scripts`, найти точки
  чтения и **завести их в дерево конфигурации** (раздел `providers`), читая через `config`. Прямое
  чтение `process.env` для них недопустимо — всё проходит через `config` (см. раздел 6.4).
- `TELEGRAM_BOT_URL`, `TELEGRAM_BOT_ID`, `TELEGRAM_BOT_NAME`, `TELEGRAM_BOT_USERNAME` — метаданные
  бота. Проверить потребителей; если используются — завести в `telegram.*`, иначе убрать.
- `PUBLIC_URL`, `PORT`, `LOG_LEVEL` — не используются текущим кодом (есть только `SANDBOX_PORT`).
  Проверить и, скорее всего, удалить из примера.
- `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` — **становятся каноническими** параметрами
  подключения к БД (раздел `db.postgres.dbs.main`), так как доступ переводится на `af-db-ts`. Прежние
  `DATABASE_URL`/`MEM_DATABASE_URL`/`MEM_DB_NAME` удаляются из примера. Имя `DB_USERNAME` из старого
  примера приводится к `DB_USER` (соглашение `af-db-ts`).
- `NODE_ENV` — **сохранить**: теперь это селектор окружения node-config (выбор `development.yaml`
  или `production.yaml`).

> Требование: на шаге реализации обязательно прогнать `grep` по каждому «подозрительному» имени и
> зафиксировать в коде или в `default.yaml` только то, что реально используется. Мёртвые переменные —
> удалить, не перенося в YAML.

---

## 5. Проектируемая иерархия хранения параметров

### 5.1. Каталог `config/` (новый)

```
config/
  default.yaml                       # полная схема + значения по умолчанию + комментарии (коммитится)
  development.yaml                   # переопределения для разработки (коммитится, минимальный)
  production.yaml                    # переопределения для продакшена (коммитится, минимальный)
  test.yaml                          # переопределения для тестов (NODE_ENV=test) (коммитится)
  custom-environment-variables.yaml  # карта «путь конфигурации → имя ENV» (коммитится)
  local.yaml                         # секреты и локальные значения машины (НЕ коммитится)
  local.example.yaml                 # пример local.yaml без секретов (коммитится, для онбординга)
```

Принципы распределения:

- **`default.yaml`** — единственный источник значений по умолчанию и структуры. Здесь живёт всё дерево
  с безопасными значениями (всё необязательное выключено: проактивность, голос, сжатие истории и так
  далее — `false`/выключено, как сейчас). Секретные поля оставляем пустыми (`''`) или с пометкой `***`.
- **`development.yaml`** — то, что удобно включить именно в разработке (например, можно включить
  `historyCompression.enabled: true`, как стоит в текущем `.env.example`). Держать минимальным.
- **`production.yaml`** — продакшен-различия (например, уровень логирования, выключенные отладочные
  категории). Держать минимальным. Секреты сюда не писать.
- **`test.yaml`** — переопределения для тестов. Запуск тестов идёт с `NODE_ENV=test`, и node-config
  подхватывает этот файл поверх `default.yaml`. Сюда выносятся любые значения, нужные именно тестам
  (отдельная тестовая БД, выключенные внешние контуры и так далее). Это **единственный** механизм
  переопределения параметров для тестов — прямого чтения `process.env` в коде быть не должно.
- **`custom-environment-variables.yaml`** — мост обратной совместимости: каждая текущая переменная
  окружения отображается на свой путь в дереве. Благодаря этому существующий `.env` и реальное
  окружение продолжают переопределять конфигурацию без изменений в эксплуатации.
- **`local.yaml`** — реальные секреты разработчика (`OPENAI_API_KEY`, `TELEGRAM_API_KEY`, `AUTH_SECRET`,
  строки подключения к БД). Добавляется в `.gitignore`. Это рекомендуемый способ хранения секретов
  локально вместо `.env`.
- **`local.example.yaml`** — обезличенный шаблон `local.yaml` для нового разработчика.

### 5.2. Целевая структура дерева конфигурации

Дерево сохраняет текущую форму экспортируемого объекта `config` (чтобы потребители почти не менялись)
и добавляет новые секции `telegram`, `scheduler`, `sandbox`, `mcp`, `providers`:

Ключи на каждом уровне отсортированы по алфавиту (соглашение раздела 7.0):

```
authSecret           # верхний ключ (config.authSecret) — секрет шифрования
companion: { enabled }
db:                  # структура под пакет af-db-ts (читается по db.postgres.dbs.<connectionId>)
  postgres:
    dbs:
      bootstrap:     # служебное подключение к базе 'postgres' для CREATE DATABASE в migrate.js
        database, host, label, password, port, usedExtensions, user
      main:          # рабочая БД памяти (connectionId = 'main')
        database, host, label, password, port, usedExtensions, user   # usedExtensions: [pgvector]
debug                # строка категорий через запятую (разбирается только в debugEnabled())
globalMemory: { factsEnabled, factsLimit, ragEnabled, ragLimit, ragMinRelevance }
historyCompression:
  enabled, hotWindow, maxTokens, minCompressGain, model, shrinkTokens, zoneWeights
llm:
  apiKey, auxModel, baseURL, embedDim, embedModel, extractModel, mainModel
mcp: { configPath }
memoryLimits: { dialog, domain, profile, reminder, secure, total }
proactive:
  checkinHour, contactPolicy, enabled, events, goalIntervalMinutes, inactivityMinutes,
  intervalMs, welcomeBackGapMinutes
  contactPolicy: { minSoftPauseMinutes, quietAfterUnanswered, quietHoursAfterIgnores,
                   requestedReminderDailyLimit, softDailyLimit, softWeeklyLimit }
  events: { enabled, relevanceThreshold }
providers:           # ключи внешних провайдеров — читаются через config (см. 6.4)
  assemblyaiApiKey, groqApiKey, tavilyApiKey
sandbox: { port }
schema: { keyEmbedThreshold }
scheduler:           # новые: ранее читались напрямую
  maxSleepMs, minSleepMs, workerId
skills:
  authoring, dir, referenceMaxBytes, switchThreshold
  authoring: { enabled, model }
streaming: { enabled }   # ядро: потоковый вызов модели (канал-независимый)
telegram:            # ВСЁ про Telegram-адаптер — в этой ветке
  apiKey, maxConcurrency, outboxSafetyIntervalMs
  streaming: { editIntervalMs, enabled, minEditChars, minFirstDraftChars, toolStatuses }
timezone
voiceInput: { enabled, language, maxBytes, maxSeconds, provider }
voiceOutput: { enabled, format, maxChars, model, summaryMaxChars, summaryModel, voice }
```

Замечания по форме:

- `db.postgres.dbs.main`/`bootstrap` — параметры подключения в форме `af-db-ts` (раздел 6.6).
  Производных строк подключения в коде больше нет: `af-db-ts` сам читает их из node-config по
  `connectionId`. Раздел отдаётся приложению как `config.db` для тонкого слоя `src/db.js`.
- `debug` остаётся **строкой** категорий через запятую в YAML и окружении; разбор в список — только
  внутри `debugEnabled()`. `config.debug` для потребителей — строка.
- `zoneWeights` хранится **YAML-массивом** чисел (`[0.55, 0.30, 0.15]`), потребитель получает массив
  без преобразований. Переопределение из окружения — через `__format: json` (переменная
  `HISTORY_ZONE_WEIGHTS` принимает JSON-массив).

---

## 6. Рефакторинг кода

Ключевая идея: **`config` — это снимок дерева node-config, а не пересобранный вручную объект.** Всю
работу (слияние файлов, переменные окружения, типы) делает node-config; все дефолты живут в
`config/default.yaml`. Чтобы десятки потребителей (`src/agent.js`, `src/pipeline/*`, `src/telegram/*`
и т. д.) не менялись, **структура `default.yaml` спроектирована так, чтобы совпадать с формой, которую
они уже ожидают** (`config.proactive.contactPolicy.softDailyLimit`, `config.memoryLimits.total`,
`config.authSecret` и так далее). Единственные осознанные изменения формы — раздел БД (`config.db`
вместо строк подключения, потому что доступ идёт через `af-db-ts`, раздел 6.6) и места, перечисленные
в разделе 6.7 «Соответствие формы».

### 6.1. Зависимости и порядок загрузки (bootstrap-паттерн)

1. Добавить зависимости: `config` и `js-yaml`.
2. **Критично:** `dotenv` обязан отработать **до** первого импорта пакета `config`, иначе значения из
   `.env` не попадут в `process.env` к моменту, когда node-config применяет
   `custom-environment-variables.yaml`. Гарантируется это отдельным bootstrap-модулем, который
   импортируется самым первым.

Канонический bootstrap-паттерн node-config:

- Отдельный модуль-загрузчик `.env` с единственной задачей:
  ```js
  import * as dotenv from 'dotenv';
  export const dotEnvResult = dotenv.config({ quiet: true });
  ```
- Модуль инициализации конфигурации **первой строкой** импортирует загрузчик `.env`, и только затем —
  пакет `config`:
  ```js
  import './dotenv.js'; // загрузить переменные окружения первыми
  import configModule from 'config';
  export const config = configModule.util.toObject();
  ```
- В стартовом скрипте сервиса **первым импортом** идёт модуль инициализации конфигурации, чтобы
  окружение и конфигурация поднялись раньше любого прикладного модуля.

Перенос на `mem-bot` (проект на JavaScript, ESM):

- Создать `src/bootstrap/dotenv.js`:
  ```js
  // Единственная задача — загрузить .env в process.env как можно раньше.
  import * as dotenv from 'dotenv';
  export const dotEnvResult = dotenv.config({ quiet: true });
  ```
- Сделать `src/config.js` ролью init-config: его **первая строка** импортирует bootstrap-загрузчик
  `.env`, и только затем импортируется пакет `config` (см. эскиз 6.2).
- Во всех точках входа (`src/telegram/bot.js`, `src/scheduler-run.js`, `src/cli.js`,
  `src/sandbox/server.js`, `src/migrate.js`) **первым импортом** поставить `./config.js`
  (или `../config.js`). Так гарантируется, что загрузка `.env` и node-config происходит до любых
  прочих модулей. Проверить, что ни один модуль не импортирует пакет `config` (node-config) в обход
  `src/config.js`.

> Почему `util.toObject()`: метод возвращает обычный изменяемый объект-снимок, а не иммутабельное
> дерево node-config. Это снимает любые вопросы про иммутабельность (раздел 11, пункт 3): обёртка
> спокойно достраивает производные значения, ничего не мутируя в самом node-config.

### 6.2. Новый `src/config.js` (минимальный)

**Главный принцип: `src/config.js` НЕ пересобирает структуру конфигурации.** Всю работу по слиянию
файлов, применению переменных окружения и приведению типов делает node-config. Все значения по
умолчанию заданы в `config/default.yaml`. Поэтому `config` — это просто снимок готового дерева
(`nodeConfig.util.toObject()`), а код добавляет только две вещи:

1. **Проверку обязательных параметров**, без которых запускать сервис бессмысленно: если их нет —
   падаем сразу с понятным сообщением, что именно не задано и где это задать.
2. **Несколько валидаций-инвариантов** (тоже падение с понятным текстом) и пару неизбежных
   нормализаций, которые node-config выразить не может.

Никаких `get(path, default)` с дублированием дефолтов из YAML, никакого ручного перечисления всех
полей — этого больше нет.

```js
// Конфигурация приложения. Полностью строится пакетом node-config из YAML-иерархии config/:
// значения по умолчанию — config/default.yaml; окружение — development/production/test.yaml;
// секреты — local.yaml; переопределения окружением — custom-environment-variables.yaml.
// Здесь структура НЕ пересобирается: config — снимок готового дерева. Код только проверяет
// обязательные параметры и инварианты и в случае ошибки валит процесс с понятным сообщением.
import './bootstrap/dotenv.js';    // ПЕРВОЙ строкой: наполняет process.env до загрузки node-config
import nodeConfig from 'config';   // node-config читает каталог config/ при первом импорте
import { normalizeVoiceId } from './voice/voices.js';

// Готовое дерево конфигурации как обычный объект. Форма == структуре config/default.yaml.
export const config = nodeConfig.util.toObject();

// Падение с понятным сообщением, если обязательные параметры не заданы.
// Пустая строка/null/отсутствие ключа считаются «не задано» (пустой host у af-db-ts = выключенная БД).
export function requireConfig(paths) {
  const missing = paths.filter((p) => {
    const v = nodeConfig.has(p) ? nodeConfig.get(p) : undefined;
    return v === undefined || v === null || v === '';
  });
  if (missing.length) {
    throw new Error(
      `Не заданы обязательные параметры конфигурации: ${missing.join(', ')}. ` +
        `Задайте их в config/local.yaml или через переменные окружения ` +
        `(см. config/custom-environment-variables.yaml).`,
    );
  }
}

// Универсальный минимум для любого процесса: рабочая БД и доступ к LLM.
// Канальные/частные требования каждая точка входа проверяет сама (см. ниже).
requireConfig([
  'db.postgres.dbs.main.host',
  'db.postgres.dbs.main.database',
  'db.postgres.dbs.main.user',
  'db.postgres.dbs.main.password',
  'llm.apiKey',
]);

// --- Инварианты: тоже падаем с понятным сообщением ---
// Гистерезис: целевой размер дайджеста строго меньше порога запуска, иначе сжатие зациклится.
if (config.historyCompression.shrinkTokens >= config.historyCompression.maxTokens) {
  throw new Error('historyCompression.shrinkTokens должен быть строго меньше historyCompression.maxTokens.');
}
// Жёсткий потолок длины озвучиваемого текста.
if (config.voiceOutput.maxChars > 500) {
  throw new Error('voiceOutput.maxChars не может превышать 500.');
}

// --- Минимальные неизбежные нормализации (то, что нельзя выразить в YAML) ---
// Пустой baseURL означает «прямой OpenAI API» — приводим '' к undefined для клиента OpenAI.
if (!config.llm.baseURL) {
  config.llm.baseURL = undefined;
}
// Тембр голоса канонизируем и проверяем на известность (только если синтез включён).
if (config.voiceOutput.enabled) {
  const v = normalizeVoiceId(config.voiceOutput.voice);
  if (!v) {
    throw new Error(`Неизвестный voiceOutput.voice: "${config.voiceOutput.voice}".`);
  }
  config.voiceOutput.voice = v;
}

// debug в YAML/окружении — строка категорий через запятую; парсим её только здесь.
export function debugEnabled(category) {
  const list = String(config.debug || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.includes('*') || list.includes(category);
}
```

Точки входа доуточняют свои требования вызовом `requireConfig`. Например, в начале
`src/telegram/bot.js`:

```js
import { config, requireConfig } from '../config.js';
requireConfig(['telegram.apiKey']);   // токен бота обязателен именно для Telegram-канала
```

> Что ушло из кода и переехало в `config/default.yaml` (раздел 7.1): все числовые/строковые дефолты
> (`gpt-5.4-mini`, `300000`, `7`, `0.82` и т. д.), модель TTS (`voiceOutput.model`), модели резюме
> (`voiceOutput.summaryModel`, `historyCompression.model`), `skills.authoring.model: null`,
> доли зон сжатия (`historyCompression.zoneWeights` как YAML-массив). Дублировать их в коде запрещено —
> единственный источник дефолтов это `default.yaml`.

### 6.3. Булевы флаги (принятое решение: только `true`/`false`)

Прежний формат `on`/`off` и помощник `flag()` **упраздняются**. Все флаги переводятся на канонические
булевы значения:

- В `default.yaml` (и `development.yaml`/`production.yaml`/`test.yaml`) флаги — нативные булевы YAML:
  `true` или `false`.
- В `custom-environment-variables.yaml` каждый флаг помечается `__format: boolean` (см. 7.2).
  node-config приведёт строку переменной окружения `"true"`/`"false"` к булеву типу.
- В коде флаги читаются напрямую из дерева: `config.proactive.enabled` — значение уже булево, никакой
  нормализации не нужно.
- В `.env.example` и документации значения `on`/`off` заменяются на `true`/`false`. Предупредить в
  README, что старое `on`/`off` больше не поддерживается: при `__format: boolean` строка `"off"`
  будет интерпретирована как «не true», то есть как `false` (что совпадает по смыслу), но
  канонической формой считаются только `true`/`false`.

### 6.4. Прямые потребители `process.env` (все переводятся на `config`)

**Принцип: всё и вся читает параметры только через `config`.** Прямое чтение `process.env` в
прикладном коде не остаётся нигде. Единственные допустимые исключения — служебные переменные самого
node-config (`NODE_ENV`, `NODE_CONFIG_ENV`, `NODE_CONFIG_DIR`) и сам bootstrap-загрузчик `.env`.

- `src/telegram/bot.js` и `src/telegram/progress.js` — всё про Telegram читается из ветки
  `config.telegram.*`:
  - `process.env.TELEGRAM_API_KEY` → `config.telegram.apiKey`.
  - `process.env.TELEGRAM_MAX_CONCURRENCY` → `config.telegram.maxConcurrency`.
  - `process.env.OUTBOX_SAFETY_INTERVAL_MS` → `config.telegram.outboxSafetyIntervalMs`.
  - Параметры отображения потока: `config.telegram.streaming.enabled` (бывш.
    `streaming.telegramEnabled`), `config.telegram.streaming.editIntervalMs`/`minEditChars`/
    `minFirstDraftChars`/`toolStatuses` (бывш. `streaming.*`). Ядро же стримит по
    `config.streaming.enabled`.
  - `process.env.SCHEDULER_MIN_SLEEP_MS` / `MAX` → `config.scheduler.minSleepMs` / `maxSleepMs`.
  - Импортировать `config` из `../config.js` (он там уже импортируется — проверить).
- `src/scheduler-run.js`: `SCHEDULER_MIN_SLEEP_MS`/`MAX` → `config.scheduler.*`.
- `src/pipeline/scheduler.js`: `WORKER_ID` → `config.scheduler.workerId`.
- `src/sandbox/server.js`: `SANDBOX_PORT` → `config.sandbox.port`.
- `src/mcp/config.js`: `MCP_CONFIG_PATH` → `config.mcp.configPath` (учесть, что путь резолвится
  относительно `process.cwd()` — сохранить это поведение).
- `src/voice/transcribe.js`: ключи `ASSEMBLYAI_API_KEY`, `GROQ_API_KEY`, `OPENAI_API_KEY` →
  завести секцию `config.providers.*` (и `config.llm.apiKey` для OpenAI) и читать через `config`.
  Добавить соответствующие строки в `custom-environment-variables.yaml`, чтобы переменные окружения
  продолжали переопределять значения.
- `scripts/*-experiment.js`: тоже перевести на `config` (импортировать `../src/config.js` и читать
  `config.providers.*`/`config.llm.*`). Прямого `process.env` в скриптах не оставлять — требование
  «всё через config» распространяется и на них.

> Перед правкой и после неё обязательно выполнить `grep -rn "process\.env\." src scripts` и убедиться,
> что не осталось ни одного прикладного чтения окружения (допустимы только `NODE_ENV`/`NODE_CONFIG_*`
> и bootstrap-загрузчик `.env`). Ничего не пропустить.

### 6.5. Переопределение параметров для тестов

Прямого чтения `process.env` в тестах быть не должно. Любые значения, специфичные для тестов,
выносятся в `config/test.yaml`, а тесты запускаются с `NODE_ENV=test` — node-config подхватит этот
файл поверх `default.yaml`. Скрипты тестов в `package.json` обновить так, чтобы они выставляли
`NODE_ENV=test` (например, через `cross-env NODE_ENV=test node tests/run.js`). Если `cross-env` ещё не
в зависимостях — добавить его в `devDependencies`.

### 6.6. Переход доступа к БД на `af-db-ts`

Доступ к PostgreSQL переводится с прямого использования пакета `pg` (через строку подключения
`config.databaseUrl`) на пакет **`af-db-ts`**. Это и есть причина, по которой раздел `db:` строится
строго в форме `db.postgres.dbs.<connectionId>`: именно по этому пути `af-db-ts` читает параметры
подключения из node-config.

**Как `af-db-ts` получает конфигурацию (подтверждено по исходникам пакета `D:\DEV\FA\_pub\af-db-ts`,
файл `src/pg/pool-pg.ts`):** при импорте он сам вызывает `config.util.toObject(config)` и берёт
подключения из `cfg.db.postgres.dbs` (ключ = `connectionId`), а общие параметры пула — из
`cfg.db.postgres.options`. Значения внутри `dbs.<id>` — это стандартный `PoolConfig` пакета `pg`
(`host`, `port`, `database`, `user`, `password`), плюс необязательные `usedExtensions`, `label` и `ssh`.
Никакой отдельной регистрации пулов не требуется — достаточно правильной структуры в YAML.

Ключевые функции `af-db-ts` (импортируются из пакета):

- `queryPg(connectionId | argObj, sqlText?, sqlValues?, throwError?, prefix?, registerTypesFunctions?)`
  — выполнить запрос. Первый аргумент-строка трактуется как `connectionId`; объектная форма —
  `{ connectionId, sqlText, sqlValues, throwError, registerTypesFunctions, client }`.
- `getPoolPg(connectionId | argObj, throwError?, registerTypesFunctions?)` — получить (закэшированный)
  пул `pg`.
- `getDbConfigPg(connectionId, includeOptions?, throwError?)` — вернуть параметры подключения из
  конфигурации (удобно для отдельного LISTEN-клиента, см. ниже).
- `closeAllDb()` / `graceExit` (из `af-db-ts`) — корректное закрытие всех пулов при остановке.

Что меняется в коде:

- **`src/db.js` переписывается** на `af-db-ts`. Вместо `new pg.Pool({ connectionString })`:
  - обычные запросы — через `queryPg` с `connectionId: 'main'`. Тонкие обёртки `query()`/`getPool()`
    сохранить по сигнатуре, чтобы потребители (`src/repo.js`, `src/pipeline/*`) не менялись. Удобно
    сделать обёртку, дополняющую аргумент `connectionId: 'main'` (по образцу вторичных БД в `af-db-ts`).
  - **`pgvector` регистрируется вручную**, автоматически `af-db-ts` его НЕ включает. Добавить
    зависимость `pgvector` и при работе с `main` передавать
    `registerTypesFunctions: [pgvector.registerType]` (импорт `import pgvector from 'pgvector/pg'`),
    когда `config.db.postgres.dbs.main.usedExtensions` содержит `'pgvector'`. Тогда `vector`-колонки
    возвращаются как `number[]`. Ручная `vectorToSql()` для формирования литерала вектора при вставке
    может остаться — это просто форматирование строки.
  - **LISTEN/NOTIFY** (`createListener`, `notify`) требует выделенного долгоживущего соединения, а пулы
    `af-db-ts` для этого не предназначены. Решение: получить параметры через
    `getDbConfigPg('main', true)` и поднять отдельный `new pg.Client(params)` для `LISTEN` (как сейчас,
    но без строки `databaseUrl`). Пакет `pg` в зависимостях при этом сохраняется. `NOTIFY` можно
    выполнять обычным `queryPg`.
- **`src/migrate.js`** (создание БД памяти `CREATE DATABASE`) использует административное подключение к
  служебной базе `postgres`. Завести для него отдельный алиас `db.postgres.dbs.bootstrap`
  (`database: postgres`) и обращаться к нему по `connectionId: 'bootstrap'`. После создания БД
  основная работа идёт через `main`.
- **Признак включённости БД.** Пустой `host: ''` означает «БД выключена» (соглашение `af-db-ts`). Для
  mem-bot БД обязательна, поэтому в `default.yaml` для `main` указывается реальный `host` (по умолчанию
  `localhost`), а секрет (`user`/`password`) — в `local.yaml`/окружении.

> **Источник истины по API `af-db-ts`** — исходники пакета `D:\DEV\FA\_pub\af-db-ts` (модули
> `src/pg/query-pg.ts`, `src/pg/pool-pg.ts`, `src/index.ts`) и его справка по работе с БД. Версию
> `af-db-ts` зафиксировать актуальную на момент выполнения и сверить сигнатуры с установленной версией.

### 6.7. Соответствие формы (чтобы потребители не менялись)

`config` = снимок дерева YAML, поэтому ключи в `config/default.yaml` обязаны точно совпадать с тем, что
читают существующие модули. Точки, требующие внимания:

- **`authSecret` — на верхнем уровне** (`config.authSecret`), а не под `security`. В `default.yaml`
  держать `authSecret:` верхним ключом (раздел 7.1), иначе потребители защищённого хранилища сломаются.
- **`debug` — строка** категорий через запятую. `config.debug` остаётся строкой; разбор в список —
  только внутри `debugEnabled()`. Проверить grep’ом, что никто не читает `config.debug` как массив.
- **`historyCompression.zoneWeights` — YAML-массив чисел** (`[0.55, 0.30, 0.15]`), потребитель получает
  массив без преобразований. Переопределение из окружения — через `__format: json` (раздел 7.2).
- **`voiceOutput.voice`** канонизируется и проверяется в `config.js` (in-place), потому что потребители
  ждут уже нормализованный идентификатор тембра.
- **`llm.baseURL`** приводится из `''` к `undefined` (пустое значение означает прямой OpenAI API).
- **Раздел БД (`config.db`)** заменяет прежние `config.databaseUrl`/`adminDatabaseUrl`/`memDbName` —
  это осознанное изменение формы, потребители БД (`src/db.js`, `src/migrate.js`) переписываются под
  `af-db-ts` (раздел 6.6).
- **Telegram-параметры сведены в ветку `config.telegram.*`** (осознанное изменение формы, см.
  раздел 7.0a). Отображение потокового ответа переезжает из `config.streaming.*` в
  `config.telegram.streaming.*`; в ядре остаётся только `config.streaming.enabled`. Потребители
  `src/telegram/bot.js` и `src/telegram/progress.js` правятся под новые пути.

После миграции снять дамп `config` и сверить с эталоном (раздел 10.1): расхождения формы недопустимы,
кроме перечисленных.

---

## 7. Содержимое файлов (заготовки для копирования)

### 7.0. Соглашение: алфавитная сортировка ключей

**Во всех файлах конфигурации (`default.yaml`, `development.yaml`, `production.yaml`, `test.yaml`,
`local.yaml`, `custom-environment-variables.yaml`) ключи сортируются по алфавиту в пределах своего
уровня вложенности.** Это касается и верхнего уровня, и каждой вложенной секции. Заготовки ниже уже
отсортированы — сохранять этот порядок при правках. Исключение — элементы YAML-массивов (например,
`usedExtensions`): там порядок задаётся смыслом, не алфавитом.

### 7.0a. Соглашения: ветка Telegram и имена переменных окружения

**Вся конфигурация, относящаяся к Telegram, живёт в ветке `telegram:`.** Не только токен и параметры
доставки, но и отображение потокового ответа: оно вынесено из `streaming.*` в `telegram.streaming.*`.
В корневом `streaming:` остаётся только `enabled` — канал-независимый признак того, что ядро вызывает
модель в потоковом режиме. Любой новый Telegram-параметр добавляется в ветку `telegram`, а не в корень.

**Имя переменной окружения для каждого НОВОГО (введённого или перемещённого) параметра соответствует
его пути в YAML** — сегменты пути в `SCREAMING_SNAKE_CASE` через подчёркивание. Если переменная
заменяет прежнюю с другим именем, рядом ставится комментарий `# замена старой переменной <OLD_NAME>`.
Примеры:

| Путь в `config` | Переменная окружения | Заменяет |
|-----------------|----------------------|----------|
| `telegram.outboxSafetyIntervalMs` | `TELEGRAM_OUTBOX_SAFETY_INTERVAL_MS` | `OUTBOX_SAFETY_INTERVAL_MS` |
| `telegram.streaming.enabled` | `TELEGRAM_STREAMING_ENABLED` | — (имя совпало) |
| `telegram.streaming.editIntervalMs` | `TELEGRAM_STREAMING_EDIT_INTERVAL_MS` | `TELEGRAM_STREAM_EDIT_INTERVAL_MS` |
| `telegram.streaming.minEditChars` | `TELEGRAM_STREAMING_MIN_EDIT_CHARS` | `TELEGRAM_STREAM_MIN_EDIT_CHARS` |
| `telegram.streaming.minFirstDraftChars` | `TELEGRAM_STREAMING_MIN_FIRST_DRAFT_CHARS` | `TELEGRAM_STREAM_MIN_FIRST_DRAFT_CHARS` |
| `telegram.streaming.toolStatuses` | `TELEGRAM_STREAMING_TOOL_STATUSES` | `TELEGRAM_TOOL_STATUS_ENABLED` |
| `streaming.enabled` | `STREAMING_ENABLED` | `LLM_STREAMING_ENABLED` |
| `scheduler.workerId` | `SCHEDULER_WORKER_ID` | `WORKER_ID` |

Существующие переменные, чьё имя уже совпадает с иерархией или которые сохраняются ради совместимости
без реструктуризации (`OPENAI_API_KEY`→`llm.apiKey`, `PROACTIVE_*`→`proactive.*`, `DB_*`→`db.postgres…`
и т. п.), не переименовываются.

### 7.1. `config/default.yaml`

Полное дерево со значениями по умолчанию и комментариями. Привести в соответствие с таблицей раздела 4.
Секреты — пустыми или `***`. Все необязательные контуры — выключены. Пример фрагмента (executor
обязан расписать ВСЕ секции аналогично):

```yaml
---
#> Ключи каждого уровня отсортированы по алфавиту (соглашение проекта, см. раздел 7.0).
#> У каждого параметра — комментарий на предшествующей строке.

#> Секрет шифрования защищённых данных (AES-256-GCM). Верхний ключ config.authSecret.
#> ОБЯЗАТЕЛЬНО заменить в проде (минимум 32 случайных байта); реальное значение — в local.yaml/окружении.
authSecret: 'dev-insecure-secret-change-me'

#> Режим собеседника: темпоральный и тематический контекст в ответах + извлечение тем после ответа.
companion:
  #> Включить режим собеседника.
  enabled: false

#> ========================================================================
#> База данных. Структура раздела db — под пакет af-db-ts: он читает параметры
#> подключения из node-config по пути db.postgres.dbs.<connectionId>. Алиас main — рабочая БД памяти,
#> bootstrap — служебное подключение к базе postgres для CREATE DATABASE.
#> ========================================================================
db:
  postgres:
    #> Именованные подключения PostgreSQL (ключ = connectionId).
    dbs:
      #> Служебное подключение к базе 'postgres' — только для CREATE DATABASE в migrate.js.
      bootstrap:
        #> Имя служебной базы (фиксировано как postgres).
        database: 'postgres'
        #> Хост PostgreSQL.
        host: 'localhost'
        #> Человекочитаемая метка для диагностики.
        label: 'postgres (bootstrap for CREATE DATABASE)'
        #> Пароль БД (секрет; держать в local.yaml или окружении).
        password: ''
        #> Порт PostgreSQL.
        port: 5432
        #> Расширения PostgreSQL (для bootstrap не нужны).
        usedExtensions: []
        #> Пользователь БД (секрет; держать в local.yaml или окружении).
        user: ''
      #> Рабочая БД памяти агента (connectionId = main).
      main:
        #> Имя рабочей БД памяти агента.
        database: 'mem_bot'
        #> Хост PostgreSQL. Пустая строка ('') ОТКЛЮЧАЕТ БД (isMainDBUsed = false).
        host: 'localhost'
        #> Человекочитаемая метка, показывается в диагностике.
        label: 'mem-bot memory'
        #> Пароль БД (секрет; держать в local.yaml или окружении).
        password: ''
        #> Порт PostgreSQL.
        port: 5432
        #> Расширения PostgreSQL. pgvector регистрируется при работе с этим подключением.
        usedExtensions:
          - pgvector
        #> Пользователь БД (секрет; держать в local.yaml или окружении).
        user: ''

#> Категории отладочной трассировки через запятую (llm, llm:summarizer, mcp:tool, * и т.д.).
debug: ''

#> Глобальная память и общая база знаний (RAG), общие для всех пользователей.
globalMemory:
  #> Включить слой глобальных фактов, подмешиваемых в каждый запрос.
  factsEnabled: false
  #> Сколько глобальных фактов подмешивать в каждый запрос.
  factsLimit: 5
  #> Включить общую RAG-базу знаний и инструменты работы с ней.
  ragEnabled: false
  #> Сколько фрагментов базы знаний подмешивать по релевантности.
  ragLimit: 5
  #> Порог релевантности фрагмента базы знаний для попадания в контекст.
  ragMinRelevance: 0.3

#> Поджатие старой части истории диалога в компактный дайджест.
historyCompression:
  #> Включить поджатие истории.
  enabled: false
  #> Сколько последних сообщений всегда передаётся дословно (горячее окно).
  hotWindow: 8
  #> Порог размера холодной зоны (в токенах), при превышении запускается сжатие.
  maxTokens: 2000
  #> Минимальный выигрыш сжатия, ниже которого дайджест не перезаписывается.
  minCompressGain: 0.35
  #> Модель суммаризатора истории. Совпадает с дефолтом llm.auxModel; при смене auxModel задать явно.
  model: 'gpt-5.4-nano'
  #> Целевой размер дайджеста (в токенах). Должен быть строго меньше maxTokens (проверяется в коде).
  shrinkTokens: 800
  #> Доли бюджета дайджеста на ближнюю/среднюю/дальнюю зоны (YAML-массив).
  zoneWeights: [0.55, 0.30, 0.15]

#> LLM-провайдер (OpenAI или совместимый прокси, например LiteLLM).
llm:
  #> Ключ API провайдера (секрет; держать в local.yaml или в окружении).
  apiKey: ''
  #> Быстрая вспомогательная модель (классификация запроса).
  auxModel: 'gpt-5.4-nano'
  #> Базовый URL OpenAI-совместимого провайдера. Пусто → прямой api.openai.com.
  baseURL: ''
  #> Размерность эмбеддингов выбранной модели.
  embedDim: 1536
  #> Модель эмбеддингов для смыслового поиска памяти.
  embedModel: 'text-embedding-3-small'
  #> Модель извлечения фактов в память.
  extractModel: 'gpt-5.4-mini'
  #> Основная модель агента (ответы пользователю, вызов инструментов).
  mainModel: 'gpt-5.4-mini'

#> Клиент MCP (подключение внешних инструментов).
mcp:
  #> Путь к файлу описания MCP-серверов (резолвится относительно process.cwd()).
  configPath: '.mcp.json'

#> Лимиты минимизации памяти: сколько фактов каждой области попадает в промпт.
memoryLimits:
  #> Факты текущего диалога.
  dialog: 5
  #> Факты предметной области (домена).
  domain: 12
  #> Устойчивые факты о пользователе и стиле общения (профильная память).
  profile: 7
  #> Активные напоминания.
  reminder: 3
  #> Безопасные резюме защищённых данных.
  secure: 3
  #> Общий потолок числа фактов в промпте.
  total: 30

#> Проактивный контур: бот пишет первым по триггерам с анти-спамом.
proactive:
  #> Час дня для планового check-in (по локальному часовому поясу).
  checkinHour: 10
  #> Политика частоты проактивных контактов (анти-спам).
  contactPolicy:
    #> Минимальная пауза в минутах между мягкими проактивными контактами.
    minSoftPauseMinutes: 360
    #> Сколько проигнорированных проактивных сообщений переводят в тишину.
    quietAfterUnanswered: 2
    #> Длительность тишины в часах после серии игноров.
    quietHoursAfterIgnores: 24
    #> Дневной лимит проактивных напоминаний, явно запрошенных пользователем.
    requestedReminderDailyLimit: 2
    #> Мягкий дневной лимит проактивных сообщений без явной просьбы.
    softDailyLimit: 1
    #> Мягкий недельный лимит проактивных сообщений без явной просьбы.
    softWeeklyLimit: 3
  #> Включить проактивный контур.
  enabled: false
  #> Контур внешних событий (новости) как поводов написать. Требует enabled.
  events:
    #> Включить контур внешних событий.
    enabled: false
    #> Порог релевантности внешнего события для повода написать.
    relevanceThreshold: 0.6
  #> Минимальный интервал в минутах между проактивными сообщениями по целям.
  goalIntervalMinutes: 2880
  #> Через сколько минут неактивности можно отправить мягкий check-in.
  inactivityMinutes: 1440
  #> Как часто (мс) воркер проверяет проактивные триггеры.
  intervalMs: 300000
  #> Минимальный разрыв в минутах для приветствия после возвращения пользователя.
  welcomeBackGapMinutes: 60

#> Внешние провайдеры (ключи-секреты; реальные значения — в local.yaml или окружении).
#> Оставить только те ключи, чьё использование подтверждено grep по src/scripts (раздел 4.3/6.4).
providers:
  #> Ключ AssemblyAI (распознавание речи).
  assemblyaiApiKey: ''
  #> Ключ Groq (распознавание речи / быстрый LLM).
  groqApiKey: ''
  #> Ключ Tavily (веб-поиск).
  tavilyApiKey: ''

#> Песочница (локальный сервер для отладки).
sandbox:
  #> TCP-порт песочницы.
  port: 3000

#> Доменные схемы памяти.
schema:
  #> Порог косинусной близости при канонизации ключей fixed_vocab по эмбеддингу.
  keyEmbedThreshold: 0.82

#> Планировщик фоновых задач.
scheduler:
  #> Верхняя граница адаптивного сна воркера (мс).
  maxSleepMs: 30000
  #> Нижняя граница адаптивного сна воркера (мс).
  minSleepMs: 250
  #> Идентификатор воркера планировщика.
  workerId: 'scheduler-1'

#> Agent Skills — доменные namespace памяти и поведение домена.
skills:
  #> Инструментарий создания и редактирования навыков моделью (только администратор).
  authoring:
    #> Включить инструменты skill_author_* у администратора.
    enabled: false
    #> Модель генерации навыков. null → берётся llm.mainModel (обрабатывается потребителем).
    model: null
  #> Каталог с навыками (читается при старте).
  dir: 'skills'
  #> Предел размера одного справочника, читаемого инструментом (в байтах).
  referenceMaxBytes: 50000
  #> Порог уверенности классификатора для переключения на другой навык.
  switchThreshold: 0.65

#> Потоковый вызов модели в ядре агента (канал-независимый). Отображение потока в конкретном
#> мессенджере настраивается в его ветке (например, telegram.streaming).
streaming:
  #> Включить потоковый вызов модели в ядре.
  enabled: true

#> Канал Telegram. Здесь — ВСЁ, что относится к Telegram-адаптеру (токен, параллелизм, доставка,
#> отображение потокового черновика). Имена переменных окружения начинаются с TELEGRAM_.
telegram:
  #> Токен бота (секрет; держать в local.yaml или окружении).
  apiKey: ''
  #> Предел одновременных тяжёлых обработок входящих сообщений (общий по всем чатам).
  maxConcurrency: 5
  #> Период (мс) страховочного слива очереди доставки.
  outboxSafetyIntervalMs: 30000
  #> Отображение потокового ответа в Telegram (редактируемый черновик, статусы инструментов).
  streaming:
    #> Минимальный интервал между редактированиями черновика (мс).
    editIntervalMs: 500
    #> Включить редактируемый черновик потокового ответа в Telegram.
    enabled: true
    #> Минимальный объём новых символов перед очередным редактированием.
    minEditChars: 20
    #> Минимальный объём текста перед созданием первого видимого черновика.
    minFirstDraftChars: 50
    #> Показывать статусы вызовов инструментов во время ответа.
    toolStatuses: true

#> Часовой пояс по умолчанию для логики дат и времени.
timezone: 'Europe/Moscow'

#> Распознавание входящего аудио (речь в текст, STT).
voiceInput:
  #> Включить распознавание входящего аудио.
  enabled: false
  #> Код языка-подсказки для распознавателя.
  language: 'ru'
  #> Предел размера вложения (байты), когда длительность неизвестна.
  maxBytes: 25000000
  #> Предел длительности входящего аудио/видео (секунды).
  maxSeconds: 300
  #> Выбор распознавателя из реестра src/voice/transcribe.js.
  provider: 'groq-whisper-large-v3-turbo'

#> Голосовой ответ бота (текст в речь, TTS). Дефолт model зависит от провайдера llm.baseURL:
#> для LiteLLM-прокси обычно 'openai/gpt-4o-mini-tts', для прямого OpenAI API — 'gpt-4o-mini-tts'.
voiceOutput:
  #> Включить синтез голосовых ответов.
  enabled: false
  #> Формат вывода. opus → OGG/OPUS для прямой отправки в Telegram sendVoice.
  format: 'opus'
  #> Жёсткий максимум длины озвучиваемого текста — 500 (код валит запуск, если больше).
  maxChars: 500
  #> Модель синтеза речи (TTS).
  model: 'gpt-4o-mini-tts'
  #> Порог длины резюме (символы), чтобы голосовое сообщение оставалось коротким.
  summaryMaxChars: 500
  #> Модель построения резюме. Совпадает с дефолтом llm.auxModel; при смене auxModel задать явно.
  summaryModel: 'gpt-5.4-nano'
  #> Идентификатор голоса (тембр). Язык подстраивается под текст ответа.
  voice: 'alloy'
```

### 7.2. `config/custom-environment-variables.yaml`

Карта обратной совместимости: каждая текущая переменная окружения → её путь. Числа помечать
`__format: number`, флаги — `__format: boolean` (значения `"true"`/`"false"`, см. 6.3). Полный файл:

```yaml
---
# Ключи каждого уровня отсортированы по алфавиту (соглашение проекта, см. раздел 7.0).
authSecret: AUTH_SECRET

companion:
  enabled:
    __name: COMPANION_MODE
    __format: boolean

db:
  postgres:
    dbs:
      bootstrap:               # те же креды/хост, БД фиксирована как 'postgres'
        host: DB_HOST
        password: DB_PASSWORD
        port:
          __name: DB_PORT
          __format: number
        user: DB_USER
      main:
        database: DB_NAME
        host: DB_HOST
        password: DB_PASSWORD
        port:
          __name: DB_PORT
          __format: number
        user: DB_USER

debug: DEBUG

globalMemory:
  factsEnabled:
    __name: GLOBAL_MEMORY_ENABLED
    __format: boolean
  factsLimit:
    __name: GLOBAL_FACTS_LIMIT
    __format: number
  ragEnabled:
    __name: GLOBAL_RAG_ENABLED
    __format: boolean
  ragLimit:
    __name: GLOBAL_RAG_LIMIT
    __format: number
  ragMinRelevance:
    __name: GLOBAL_RAG_MIN_RELEVANCE
    __format: number

historyCompression:
  enabled:
    __name: HISTORY_COMPRESSION_ENABLED
    __format: boolean
  hotWindow:
    __name: HISTORY_HOT_WINDOW
    __format: number
  maxTokens:
    __name: HISTORY_MAX_TOKENS
    __format: number
  minCompressGain:
    __name: HISTORY_MIN_COMPRESS_GAIN
    __format: number
  model: HISTORY_SUMMARY_MODEL
  shrinkTokens:
    __name: HISTORY_SHRINK_TOKENS
    __format: number
  zoneWeights:
    __name: HISTORY_ZONE_WEIGHTS    # JSON-массив, например [0.55,0.30,0.15]
    __format: json

llm:
  apiKey: OPENAI_API_KEY
  auxModel: AUX_MODEL
  baseURL: OPENAI_BASE_URL
  embedModel: EMBED_MODEL
  extractModel: EXTRACT_MODEL
  mainModel: MAIN_MODEL

mcp:
  configPath: MCP_CONFIG_PATH

memoryLimits:
  dialog:
    __name: MEMORY_LIMIT_DIALOG
    __format: number
  domain:
    __name: MEMORY_LIMIT_DOMAIN
    __format: number
  profile:
    __name: MEMORY_LIMIT_PROFILE
    __format: number
  reminder:
    __name: MEMORY_LIMIT_REMINDER
    __format: number
  secure:
    __name: MEMORY_LIMIT_SECURE
    __format: number
  total:
    __name: MEMORY_LIMIT_TOTAL
    __format: number

proactive:
  checkinHour:
    __name: PROACTIVE_CHECKIN_HOUR
    __format: number
  contactPolicy:
    minSoftPauseMinutes:
      __name: PROACTIVE_MIN_SOFT_PAUSE_MIN
      __format: number
    quietAfterUnanswered:
      __name: PROACTIVE_QUIET_AFTER_UNANSWERED
      __format: number
    quietHoursAfterIgnores:
      __name: PROACTIVE_QUIET_HOURS_AFTER_IGNORES
      __format: number
    requestedReminderDailyLimit:
      __name: PROACTIVE_REQUESTED_REMINDER_DAILY_LIMIT
      __format: number
    softDailyLimit:
      __name: PROACTIVE_SOFT_DAILY_LIMIT
      __format: number
    softWeeklyLimit:
      __name: PROACTIVE_SOFT_WEEKLY_LIMIT
      __format: number
  enabled:
    __name: PROACTIVE_ENABLED
    __format: boolean
  events:
    enabled:
      __name: PROACTIVE_EVENTS_ENABLED
      __format: boolean
    relevanceThreshold:
      __name: NEWS_RELEVANCE_THRESHOLD
      __format: number
  goalIntervalMinutes:
    __name: PROACTIVE_GOAL_INTERVAL_MIN
    __format: number
  inactivityMinutes:
    __name: PROACTIVE_INACTIVITY_MIN
    __format: number
  intervalMs:
    __name: PROACTIVE_INTERVAL_MS
    __format: number
  welcomeBackGapMinutes:
    __name: PROACTIVE_WELCOME_GAP_MIN
    __format: number

providers:   # оставить только подтверждённые grep ключи (раздел 4.3/6.4)
  assemblyaiApiKey: ASSEMBLYAI_API_KEY
  groqApiKey: GROQ_API_KEY
  tavilyApiKey: TAVILY_API_KEY

sandbox:
  port:
    __name: SANDBOX_PORT
    __format: number

schema:
  keyEmbedThreshold:
    __name: SCHEMA_KEY_EMBED_THRESHOLD
    __format: number

scheduler:
  maxSleepMs:
    __name: SCHEDULER_MAX_SLEEP_MS
    __format: number
  minSleepMs:
    __name: SCHEDULER_MIN_SLEEP_MS
    __format: number
  workerId: SCHEDULER_WORKER_ID    # замена старой переменной WORKER_ID

skills:
  authoring:
    enabled:
      __name: SKILL_AUTHORING_ENABLED
      __format: boolean
    model: SKILL_AUTHORING_MODEL
  dir: SKILLS_DIR
  referenceMaxBytes:
    __name: SKILL_REFERENCE_MAX_BYTES
    __format: number
  switchThreshold:
    __name: SKILLS_SWITCH_THRESHOLD
    __format: number

streaming:
  enabled:
    __name: STREAMING_ENABLED        # замена старой переменной LLM_STREAMING_ENABLED
    __format: boolean

telegram:
  apiKey: TELEGRAM_API_KEY
  maxConcurrency:
    __name: TELEGRAM_MAX_CONCURRENCY
    __format: number
  outboxSafetyIntervalMs:
    __name: TELEGRAM_OUTBOX_SAFETY_INTERVAL_MS   # замена старой переменной OUTBOX_SAFETY_INTERVAL_MS
    __format: number
  streaming:
    editIntervalMs:
      __name: TELEGRAM_STREAMING_EDIT_INTERVAL_MS    # замена TELEGRAM_STREAM_EDIT_INTERVAL_MS
      __format: number
    enabled:
      __name: TELEGRAM_STREAMING_ENABLED
      __format: boolean
    minEditChars:
      __name: TELEGRAM_STREAMING_MIN_EDIT_CHARS      # замена TELEGRAM_STREAM_MIN_EDIT_CHARS
      __format: number
    minFirstDraftChars:
      __name: TELEGRAM_STREAMING_MIN_FIRST_DRAFT_CHARS   # замена TELEGRAM_STREAM_MIN_FIRST_DRAFT_CHARS
      __format: number
    toolStatuses:
      __name: TELEGRAM_STREAMING_TOOL_STATUSES       # замена TELEGRAM_TOOL_STATUS_ENABLED
      __format: boolean

timezone: TZ_DEFAULT

voiceInput:
  enabled:
    __name: VOICE_INPUT_ENABLED
    __format: boolean
  language: VOICE_INPUT_LANG
  maxBytes:
    __name: VOICE_INPUT_MAX_BYTES
    __format: number
  maxSeconds:
    __name: VOICE_INPUT_MAX_SECONDS
    __format: number
  provider: VOICE_INPUT_PROVIDER

voiceOutput:
  enabled:
    __name: VOICE_OUTPUT_ENABLED
    __format: boolean
  format: VOICE_OUTPUT_FORMAT
  maxChars:
    __name: VOICE_OUTPUT_MAX_CHARS
    __format: number
  model: VOICE_OUTPUT_MODEL
  summaryMaxChars:
    __name: VOICE_OUTPUT_SUMMARY_MAX_CHARS
    __format: number
  summaryModel: VOICE_OUTPUT_SUMMARY_MODEL
  voice: VOICE_OUTPUT_VOICE
```

### 7.3. `config/development.yaml`

Минимальный, держит только различия для разработки. В текущем `.env.example` в разработке включено
сжатие истории — отразить это здесь (по желанию):

```yaml
---
# Переопределения для разработки. Значения по умолчанию — в default.yaml.
historyCompression:
  enabled: true
```

### 7.4. `config/production.yaml`

Минимальный. Сюда — только продакшен-различия (например, отключить отладочные категории). Секреты
НЕ писать.

```yaml
---
# Переопределения для продакшена. Секреты — через окружение или local.yaml, не здесь.
debug: ''
```

### 7.4a. `config/test.yaml`

Переопределения для тестов. Подхватывается при `NODE_ENV=test`. Сюда — всё, что тестам нужно иначе,
чем в разработке (например, отдельная тестовая БД, выключенные внешние контуры, детерминированные
лимиты). Это единственный способ менять конфигурацию под тесты — прямого `process.env` в коде нет.

```yaml
---
# Переопределения для тестов (запуск с NODE_ENV=test).
# Пример: при необходимости указать отдельную тестовую БД и стабилизировать значения.
# db:
#   postgres:
#     dbs:
#       main:
#         database: 'agent_mem_test'
```

### 7.5. `config/local.example.yaml` (шаблон для разработчика)

```yaml
---
# Скопируйте этот файл в config/local.yaml и впишите реальные секреты.
# config/local.yaml в .gitignore и не коммитится.
db:
  postgres:
    dbs:
      main:
        host: 'localhost'
        database: 'mem_bot'
        user: 'ПОЛЬЗОВАТЕЛЬ_БД'
        password: 'ПАРОЛЬ_БД'
      bootstrap:
        host: 'localhost'
        user: 'ПОЛЬЗОВАТЕЛЬ_БД'
        password: 'ПАРОЛЬ_БД'
llm:
  apiKey: 'sk-...'
  baseURL: 'https://litellm.my-proxy.com/v1'
authSecret: 'СГЕНЕРИРУЙТЕ_ДЛИННУЮ_СЛУЧАЙНУЮ_СТРОКУ'
telegram:
  apiKey: 'ТОКЕН_БОТА'
```

---

## 8. Изменения вспомогательных файлов

### 8.1. `package.json`

- Добавить зависимости:
  ```jsonc
  "dependencies": {
    "config": "^4.x",       // актуальную мажорную версию проверить на npm на момент выполнения
    "js-yaml": "^4.x",
    "af-db-ts": "^x.y.z",   // доступ к PostgreSQL; точную версию взять с npm (раздел 6.6)
    "pgvector": "^x.y.z"    // регистрация типа vector для af-db-ts (registerTypesFunctions)
    // ... существующие
  }
  ```
  `dotenv` оставить (он по-прежнему нужен как мост `.env` → `process.env`). `pg` оставить — его
  использует тонкий слой LISTEN/NOTIFY в `src/db.js` (раздел 6.6).
- Добавить `cross-env` в `devDependencies` (его сейчас нет) для кроссплатформенной установки
  `NODE_ENV` в скриптах (Windows/Linux).
- Обновить скрипты тестов на запуск с `NODE_ENV=test`, например:
  ```jsonc
  "scripts": {
    "test": "cross-env NODE_ENV=test node tests/run.js",
    "test:skills": "cross-env NODE_ENV=test node tests/skills.test.mjs",
    "telegram:prod": "cross-env NODE_ENV=production node src/telegram/bot.js"
  }
  ```
  Аналогично снабдить `NODE_ENV=test` все прочие `test:*` скрипты, чтобы они подхватывали `test.yaml`.

### 8.2. `.gitignore`

Добавить:
```
config/local.yaml
config/local-*.yaml
```
(`.env` оставить в `.gitignore` как и раньше — он всё ещё поддерживается через `dotenv`.)

### 8.3. `.env.example`

Решить судьбу: либо оставить как «легаси-способ» с пометкой, что предпочтительный способ —
`config/local.yaml`, либо удалить и перенести онбординг на `config/local.example.yaml`.
**Рекомендация:** оставить `.env.example` на переходный период, добавив сверху комментарий о том, что
основной механизм теперь YAML-конфигурация, а `.env`/`custom-environment-variables.yaml` —
совместимый мост. Удалить из `.env.example` мёртвые переменные (раздел 4.3). **Все флаги в
`.env.example` перевести с `on`/`off` на `true`/`false`** (новый канонический формат, см. 6.3):
`VOICE_INPUT_ENABLED=false`, `PROACTIVE_ENABLED=false`, `HISTORY_COMPRESSION_ENABLED=true` и так далее.
**Переименованные переменные** заменить на новые имена по разделу 7.0a (например, вместо
`OUTBOX_SAFETY_INTERVAL_MS` — `TELEGRAM_OUTBOX_SAFETY_INTERVAL_MS`, вместо `TELEGRAM_STREAM_*` —
`TELEGRAM_STREAMING_*`, вместо `LLM_STREAMING_ENABLED` — `STREAMING_ENABLED`, вместо `WORKER_ID` —
`SCHEDULER_WORKER_ID`).

### 8.4. Документация

Обновить `README.md` (и/или `AGENTS.md`): описать новую иерархию `config/`, порядок приоритета,
где хранить секреты (`config/local.yaml`), как выбрать окружение (`NODE_ENV`). Текст на русском —
полными предложениями, по правилам проекта.

---

## 9. Порядок выполнения (пошагово)

1. Создать ветку/worktree для задачи.
2. `npm install config js-yaml af-db-ts pgvector` и `npm install -D cross-env` (зафиксируется в
   `package.json`/`package-lock.json`). Точные версии уточнить на npm (раздел 6.6).
3. Создать каталог `config/` и все файлы из раздела 7. Раздел `db:` оформить в форме `af-db-ts`
   (`db.postgres.dbs.<connectionId>`, раздел 7.1).
4. Создать `src/bootstrap/dotenv.js`; переписать `src/config.js` по эскизу 6.2: `config` —
   снимок дерева (`nodeConfig.util.toObject()`), плюс `requireConfig` (проверка обязательных
   параметров) и инварианты. Структуру руками не пересобирать; дефолты — только в `default.yaml`.
   В точках входа добавить `requireConfig([...])` под их требования (например, `telegram.apiKey`).
5. Перевести доступ к БД на `af-db-ts` (раздел 6.6): переписать `src/db.js` и `src/migrate.js`
   (алиасы `main`/`bootstrap`, pgvector, LISTEN/NOTIFY). Тонкие обёртки `query()`/`getPool()`
   сохранить по сигнатуре, чтобы потребители не менялись.
6. Перевести прямых потребителей `process.env` на `config` (раздел 6.4). Сделать `grep` и не пропустить.
7. Прогнать `grep -rn "process\.env\." src scripts` — убедиться, что НЕ осталось прикладных чтений
   окружения. Допустимы только служебные переменные node-config (`NODE_ENV`/`NODE_CONFIG_*`) и
   bootstrap-загрузчик `.env`. Всё остальное идёт через `config`.
8. Обновить `package.json` (скрипты с `NODE_ENV=test`), `.gitignore`, `.env.example`.
9. Прогнать линтер и форматтер: `npm run lint && npm run format` (проект уже использует oxlint/oxfmt).
10. Прогнать тесты (раздел 10). Исправить регрессии.
11. **Обновить документацию** под новую конфигурацию (раздел 12): привести в соответствие
    `docs/ai-bot-with-memory/**` и `docs/telegram/telegram-bot.md`, следуя их принципам оформления.
12. Закоммитить. В сообщении коммита описать суть и обратную совместимость.

---

## 10. Тестирование и приёмка

### 10.1. Проверка эквивалентности конфигурации

Самый надёжный тест — убедиться, что итоговый объект `config` идентичен прежнему при тех же входных
данных. Рекомендуется:

- Снять «эталон»: на текущей ветке (до миграции) сериализовать `config` в JSON
  (`node -e "import('./src/config.js').then(m=>console.log(JSON.stringify(m.config,null,2)))"`)
  при заданном наборе переменных окружения (например, из рабочего `.env`).
- После миграции снять тот же дамп и сравнить. Различий быть не должно (кроме осознанных
  переименований верхнего уровня, если они вводились). Учесть, что `apiKey`/секреты будут зависеть
  от наличия `local.yaml`/окружения.
- Дополнительно проверить три сценария приоритета:
  1. Только YAML (без переменных окружения) → значения из `default.yaml`/`development.yaml`.
  2. YAML + переменная окружения → переменная окружения побеждает (например,
     `MEMORY_LIMIT_TOTAL=99 node -e "..."` даёт `memoryLimits.total === 99`).
  3. `NODE_ENV=production` → подхватывается `production.yaml`.

### 10.2. Прогон тестов проекта

Полный набор требует реальную БД (Postgres) и LLM-прокси. Для прогона нужны секреты — положить их в
`config/local.yaml` (или оставить рабочий `.env`, он всё ещё читается через `dotenv`). Тесты
запускаются с `NODE_ENV=test`, поэтому подхватывают `config/test.yaml`. Команды:

- Модульные (без БД): `npm run test:telegram-format`, `test:progress-format`, `test:voice-selector`,
  `test:schema`, `test:skills`, `test:tts-strip` и прочие `.mjs`.
- Полный интеграционный: `npm test` (использует БД и модели). Ожидаемый результат — без провалов
  (на момент написания задания базовый прогон даёт «135 пройдено, 0 провалено»).

### 10.3. Критерии приёмки

- [ ] Создан bootstrap-загрузчик `src/bootstrap/dotenv.js`; `src/config.js` импортирует его первой
      строкой, затем пакет `config`; все точки входа импортируют `src/config.js` первым импортом.
- [ ] Каталог `config/` создан, содержит `default.yaml`, `development.yaml`, `production.yaml`,
      `test.yaml`, `custom-environment-variables.yaml`, `local.example.yaml`.
- [ ] `config/local.yaml` и `config/local-*.yaml` добавлены в `.gitignore`.
- [ ] `src/config.js` НЕ пересобирает структуру: `config = nodeConfig.util.toObject()`. В коде только
      `requireConfig` (обязательные параметры → падение с понятным сообщением) и инварианты
      (гистерезис истории, потолок `voiceOutput.maxChars`, нормализация `voice`/`baseURL`).
- [ ] Все значения по умолчанию заданы в `config/default.yaml`; дублей дефолтов в коде нет.
- [ ] Форма дерева в `default.yaml` совпадает с тем, что читают потребители (раздел 6.7): `authSecret`
      верхним ключом, `debug` строкой, `zoneWeights` массивом и т. д.
- [ ] Отсутствие обязательных параметров (БД, ключ LLM, токен Telegram для бота) валит запуск с
      понятным сообщением.
- [ ] **Ни одного** прямого чтения `process.env.*` прикладных параметров не осталось в `src` и
      `scripts` (допустимы только `NODE_ENV`/`NODE_CONFIG_*` и bootstrap-загрузчик). Подтверждено grep.
- [ ] Существующие переменные окружения (и значения из `.env` через `dotenv`) по-прежнему
      переопределяют конфигурацию (обратная совместимость подтверждена сценарием 10.1.2).
- [ ] Гистерезис `historyCompression.shrinkTokens < maxTokens` проверяется и бросает понятную ошибку.
- [ ] Все флаги переведены на `true`/`false`; помощник `flag()` удалён; в карте флаги помечены
      `__format: boolean`; в `.env.example` значения `on`/`off` заменены на `true`/`false`.
- [ ] Тесты запускаются с `NODE_ENV=test` и подхватывают `config/test.yaml`; `cross-env` добавлен.
- [ ] Вся конфигурация Telegram сведена в ветку `config.telegram.*` (включая `telegram.streaming.*`);
      в корне `streaming` остался только `enabled`. Потребители `bot.js`/`progress.js` правлены.
- [ ] Имена новых/перемещённых переменных окружения соответствуют иерархии YAML (раздел 7.0a), у
      переименованных стоит комментарий `# замена старой переменной <OLD_NAME>`.
- [ ] Раздел `db:` оформлен в форме `af-db-ts` (`db.postgres.dbs.main` + `bootstrap`); доступ к БД
      переведён на `af-db-ts`; `src/db.js` и `src/migrate.js` переписаны; pgvector и LISTEN/NOTIFY
      работают; строки `DATABASE_URL`/`MEM_DATABASE_URL`/`MEM_DB_NAME` удалены.
- [ ] `npm run lint` и `npm run format` — чисто.
- [ ] Дамп `config` до и после миграции совпадает на одинаковых входных данных.
- [ ] Тесты проходят: модульные — все; полный набор `npm test` — без провалов (при доступной БД/прокси).
- [ ] Мёртвые переменные из `.env.example` (раздел 4.3) проверены и удалены/учтены.
- [ ] Документация (README/AGENTS) описывает новую иерархию и хранение секретов.
- [ ] `docs/ai-bot-with-memory/**` обновлена по `docs/ai-bot-with-memory/00-documentation-principles.md`
      (единое состояние, без истории, канал-независимо), `docs/telegram/telegram-bot.md` — по
      `docs/telegram/00-documentation-principles.md` (конфигурация Telegram-адаптера в новой форме).

---

## 11. Риски и тонкие места (на что обратить внимание)

1. **Порядок загрузки dotenv vs node-config.** Загрузка `.env` обязана произойти до первого импорта
   пакета `config`. Реализуется bootstrap-паттерном: модуль
   `src/bootstrap/dotenv.js` грузит `.env`, а `src/config.js` импортирует его **первой строкой** и
   только затем импортирует `config`. Во всех точках входа `src/config.js` — первый импорт. Нарушение
   порядка приведёт к тому, что значения из `.env` молча не применятся (раздел 6.1).
2. **Булевы только `true`/`false`.** Формат `on`/`off` и помощник `flag()` упразднены. В карте
   переменных флаги помечаются `__format: boolean`, в YAML и коде — нативные булевы. В `.env.example`
   и документации заменить `on`/`off` на `true`/`false` (раздел 6.3).
3. **Иммутабельность node-config — не проблема.** Через `nodeConfig.util.toObject()` берётся обычный
   изменяемый снимок, само дерево node-config не мутируется. Правило простое: в коде значения только
   читать, не менять (раздел 6.1).
4. **Доступ к БД через `af-db-ts`.** Структура `db:` обязана точно соответствовать форме
   `db.postgres.dbs.<connectionId>`, иначе `af-db-ts` не найдёт параметры подключения (он читает их сам
   через `config.util.toObject`). API и сигнатуры (`queryPg`/`getPoolPg`/`getDbConfigPg`/`closeAllDb`,
   ручная регистрация pgvector через `registerTypesFunctions`, поведение при `host: ''`) сверить с
   исходниками пакета `D:\DEV\FA\_pub\af-db-ts` под установленную версию. LISTEN/NOTIFY: пулы
   `af-db-ts` не дают выделенного клиента — поднять `pg.Client` по `getDbConfigPg('main', true)`
   (раздел 6.6).
5. **Типы и значения по умолчанию — на стороне node-config.** Числа приводит `__format: number`,
   дефолты берутся из `default.yaml`. Кода-приведения (`Number(...)`, `?? default`) в `config.js` нет,
   поэтому и проблемы «ноль подменился дефолтом» не возникает: `0` в YAML/окружении остаётся `0`.
6. **Модели по умолчанию — конкретные значения в YAML, без вычислений.** `voiceOutput.model`,
   `voiceOutput.summaryModel`, `historyCompression.model` заданы в `default.yaml` явными значениями
   (дефолт TTS рассчитан на прокси; модели резюме совпадают с дефолтом `auxModel`). Прежней логики
   «пусто → подставить auxModel/по baseURL» в коде нет. Если меняете `auxModel` и хотите, чтобы модели
   резюме следовали за ним, задайте их явно. Для прямого OpenAI API поменяйте `voiceOutput.model`.
7. **Потолок `voiceOutput.maxChars`.** Жёсткий предел 500. Если в YAML/окружении задано больше — это
   ошибка конфигурации: `config.js` валит запуск с понятным сообщением (а не молча обрезает).
8. **`zoneWeights` и `debug`.** `zoneWeights` — YAML-массив чисел, из окружения переопределяется через
   `__format: json`. `debug` — строка категорий, разбирается только в `debugEnabled()`. Проверить, что
   `config.debug` нигде не читают как массив.
9. **Секреты в репозитории.** Ни `default.yaml`, ни `development.yaml`, ни `production.yaml` не должны
   содержать реальных секретов. Только `local.yaml` (в `.gitignore`) или переменные окружения.
10. **Всё через `config`, включая скрипты.** Прямого чтения `process.env` в прикладном коде и в
    `scripts/*` не остаётся (исключения — только `NODE_ENV`/`NODE_CONFIG_*` и bootstrap-загрузчик).
    Переопределения для тестов — только через `config/test.yaml` с запуском `NODE_ENV=test`
    (разделы 6.4, 6.5).
11. **Один источник чтения `config` (node-config).** Только `src/config.js` импортирует пакет `config`.
    Все остальные модули импортируют объект из `src/config.js`. Не плодить параллельные точки входа.

---

## 12. Обновление документации (обязательный финальный шаг)

После реализации привести документацию в соответствие с новой моделью конфигурации. Правки вносятся
строго по принципам ведения каждого каталога.

### 12.1. `docs/ai-bot-with-memory/**`

Соблюдать `docs/ai-bot-with-memory/00-documentation-principles.md`. Ключевое:

- **Единое действующее состояние, настоящее время.** Описывать конфигурацию так, будто система всегда
  была устроена через node-config и YAML. **Никаких отсылок к прошлому** — ни «раньше через `.env`»,
  ни «теперь перенесено», ни «новый способ». История — в системе контроля версий, не в спецификации.
- **Канал-независимость.** Эти документы не привязаны к Telegram: конфигурацию канала
  (`telegram.apiKey` и прочее) сюда не вносить — её место в `docs/telegram/telegram-bot.md`.
- **Отчуждаемость.** Не ссылаться на внешние файлы (в т. ч. на этот план); только перекрёстные ссылки
  внутри каталога.
- **Где править (проверить и согласовать между документами):** упоминания моделей и провайдера LLM
  (`08-prompts-and-models.md`), флагов и параметров проактивности (`09-proactivity.md`), поджатия
  истории (`13-history-compression.md`), глобальной памяти (`14-global-memory.md`), секретов и
  шифрования (`07-secure-privacy.md`), эксплуатации и параметров запуска (`10-operations.md`),
  быстрого старта (`03-quickstart.md`), а также приложение с перечнем параметров (`12-appendix.md`),
  если оно перечисляет переменные окружения. Привести имена и форму параметров к разделам `config`
  (например, `config.proactive.*`, `config.historyCompression.*`), не упоминая конкретный мессенджер.

### 12.2. `docs/telegram/telegram-bot.md`

Соблюдать `docs/telegram/00-documentation-principles.md`. Ключевое:

- **Единое состояние, настоящее время, без истории.**
- **Сюда — только привязка к Telegram.** Описать конфигурацию телеграм-адаптера в новой форме:
  `config.telegram.apiKey` (токен бота), `config.telegram.maxConcurrency`,
  `config.telegram.outboxSafetyIntervalMs`, параметры потокового черновика `config.streaming.*`,
  планировщик `config.scheduler.*`. Указать, что значения задаются в YAML-иерархии `config/`
  (секреты — в `config/local.yaml` или через переменные окружения), без отсылок к прежнему `.env`.
  Бизнес-логику ядра не дублировать — только её отображение в Telegram.

---

## 13. Итог

После выполнения проект конфигурируется иерархией YAML-файлов node-config с чётким разделением
«структура и значения по умолчанию (`default.yaml`) → окружение (`development`/`production`/`test`) →
локальные секреты (`local.yaml`) → переопределение переменными окружения
(`custom-environment-variables.yaml`)». Существующие деплои и `.env` продолжают работать за счёт карты
переменных окружения и сохранённого `dotenv` (кроме осознанно изменённых параметров БД и булевых
флагов). `src/config.js` не пересобирает структуру — отдаёт снимок дерева и проверяет обязательные
параметры. Доступ к БД идёт через `af-db-ts`. Документация обновлена по принципам своих каталогов.
```
