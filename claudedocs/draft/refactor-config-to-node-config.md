# План-промпт: миграция конфигурации mem-bot с `.env` на node-config (YAML-иерархия)

> Этот документ — самодостаточное техническое задание для Claude Code. В нём собрано всё необходимое,
> чтобы перевести конфигурирование проекта `mem-bot` с плоского файла `.env` (через `dotenv`) на пакет
> **node-config** (`config`) с иерархией YAML-файлов по образцу проекта `D:\DEV\FA\_pub\fa-mcp-sdk`.
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

**Важное требование совместимости:** существующие имена переменных окружения (`OPENAI_API_KEY`,
`MEM_DATABASE_URL`, `PROACTIVE_ENABLED` и так далее) должны продолжать работать. Достигается это тем,
что `dotenv` по-прежнему загружает `.env` в `process.env`, а `custom-environment-variables.yaml`
сопоставляет эти имена с путями в дереве конфигурации.

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

Поддерживаемые значения `__format`: `boolean`, `number`, `json`. **Осторожно с булевыми:**
`__format: boolean` принимает только строки `"true"` и `"false"`. В текущем проекте флаги задаются
значениями `on`/`off`/`1`/`yes` (через помощник `flag()`), поэтому такие переменные **нельзя**
помечать `__format: boolean` — их нужно отображать как обычные строки и нормализовать в коде
(см. раздел 6.3, это критичный момент миграции).

---

## 3. Образец из проекта fa-mcp-sdk (на что ориентироваться)

В `D:\DEV\FA\_pub\fa-mcp-sdk\config\` уже реализован нужный паттерн. Из него берём идиомы, не копируя
содержимое (там другой домен — MCP-сервер):

- `default.yaml` — полная схема со всеми секциями и подробными комментариями. Комментарии оформлены
  префиксом `#>` для «документирующих» пояснений и обычным `#` для второстепенных заметок. Каждый
  параметр снабжён человекочитаемым описанием прямо в YAML.
- `custom-environment-variables.yaml` — карта «путь → имя ENV», с формами `__name`/`__format` для
  чисел и булевых. Пример строк оттуда:
  ```yaml
  db:
    postgres:
      dbs:
        main:
          database: DB_NAME
          host: DB_HOST
          port: DB_PORT
  logger:
    disableMasking:
      __name: LOGGER_NO_MASK_VALUES
      __format: boolean
  ```
- `development.yaml` / `production.yaml` — в эталоне почти пустые (`---` и пара переопределений):
  значения по умолчанию живут в `default.yaml`, а окруженческие файлы держат только различия.
- `local.yaml` — реальные секреты и локальные значения (пароли, токены, ключи LLM, строки подключения).
  Этот файл **не коммитится** и предназначен для конкретной машины разработчика.

Вывод для нас: основная работа — наполнить `default.yaml` структурой и значениями по умолчанию,
собрать карту `custom-environment-variables.yaml` со всеми текущими именами переменных, оставить
`development.yaml`/`production.yaml` минимальными, а секреты увести в `local.yaml`.

---

## 4. Полный инвентарь текущих параметров

Ниже — все параметры, которые сейчас читаются из окружения. Источник «config.js» означает, что
переменная попадает в экспортируемый объект `config`. Источник «прямой» означает чтение
`process.env.*` напрямую в модуле-потребителе.

### 4.1. Параметры из `src/config.js`

| Переменная окружения | Путь в `config` (текущая форма) | Тип | Значение по умолчанию |
|----------------------|--------------------------------|-----|----------------------|
| `DATABASE_URL` | (вход для `adminDatabaseUrl`/`databaseUrl`) | string | `postgresql://postgres:1@localhost:5432/postgres` |
| `MEM_DB_NAME` | `memDbName` | string | `agent_mem` |
| `MEM_DATABASE_URL` | `databaseUrl` (если задан) | string | вычисляется из `DATABASE_URL` + `MEM_DB_NAME` |
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
  чтения и решить, заводить ли их в дерево конфигурации (раздел `providers`) или оставить прямым
  чтением `process.env` (для секретов-ключей это допустимо — см. раздел 6.4).
- `TELEGRAM_BOT_URL`, `TELEGRAM_BOT_ID`, `TELEGRAM_BOT_NAME`, `TELEGRAM_BOT_USERNAME` — метаданные
  бота. Проверить потребителей; если используются — завести в `telegram.*`, иначе убрать.
- `PUBLIC_URL`, `PORT`, `LOG_LEVEL` — не используются текущим кодом (есть только `SANDBOX_PORT`).
  Проверить и, скорее всего, удалить из примера.
- `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USERNAME`, `DB_PASSWORD` — **дублируют** `DATABASE_URL` и кодом
  не читаются (config.js использует только строки подключения). Решить: либо ввести раздельную форму
  подключения к БД (`database.host/port/...`) и собирать строку в коде, либо удалить эти переменные
  из примера. Рекомендуется оставить строки подключения (`DATABASE_URL`/`MEM_DATABASE_URL`) как есть и
  удалить разрозненные `DB_*` из примера, чтобы не было двух конкурирующих способов задать одну БД.
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
- **`custom-environment-variables.yaml`** — мост обратной совместимости: каждая текущая переменная
  окружения отображается на свой путь в дереве. Благодаря этому существующий `.env` и реальное
  окружение продолжают переопределять конфигурацию без изменений в эксплуатации.
- **`local.yaml`** — реальные секреты разработчика (`OPENAI_API_KEY`, `TELEGRAM_API_KEY`, `AUTH_SECRET`,
  строки подключения к БД). Добавляется в `.gitignore`. Это рекомендуемый способ хранения секретов
  локально вместо `.env`.
- **`local.example.yaml`** — обезличенный шаблон `local.yaml` для нового разработчика.

### 5.2. Целевая структура дерева конфигурации

Дерево сохраняет текущую форму экспортируемого объекта `config` (чтобы потребители почти не менялись)
и добавляет новые секции `telegram`, `scheduler`, `sandbox`, `mcp`, опционально `providers`:

```
database:            # было: adminDatabaseUrl / databaseUrl / memDbName
  url                #   ← DATABASE_URL (базовая строка подключения)
  memDbName          #   ← MEM_DB_NAME
  memUrl             #   ← MEM_DATABASE_URL (если задан — полная строка рабочей БД)
llm:
  apiKey, baseURL, mainModel, auxModel, extractModel, embedModel, embedDim
security:
  authSecret         # было top-level authSecret
timezone
debug                # строка категорий через запятую (в коде разбирается в массив)
companion: { enabled }
proactive:
  enabled, intervalMs, inactivityMinutes, checkinHour, goalIntervalMinutes, welcomeBackGapMinutes
  contactPolicy: { softDailyLimit, softWeeklyLimit, requestedReminderDailyLimit,
                   minSoftPauseMinutes, quietAfterUnanswered, quietHoursAfterIgnores }
  events: { enabled, relevanceThreshold }
schema: { keyEmbedThreshold }
skills:
  dir, switchThreshold, referenceMaxBytes
  authoring: { enabled, model }
memoryLimits: { profile, dialog, domain, reminder, secure, total }
globalMemory: { factsEnabled, factsLimit, ragEnabled, ragLimit, ragMinRelevance }
voiceInput: { enabled, provider, maxSeconds, maxBytes, language }
voiceOutput: { enabled, model, voice, format, maxChars, summaryMaxChars, summaryModel }
streaming:
  enabled, telegramEnabled, editIntervalMs, minEditChars, minFirstDraftChars, toolStatuses
historyCompression:
  enabled, hotWindow, maxTokens, shrinkTokens, zoneWeights, model, minCompressGain
telegram:            # новые: ранее читались напрямую в bot.js
  apiKey, maxConcurrency, outboxSafetyIntervalMs
  # при необходимости: botUrl, botId, botName, botUsername (если используются)
scheduler:           # новые: ранее читались напрямую
  minSleepMs, maxSleepMs, workerId
sandbox: { port }
mcp: { configPath }
providers:           # опционально, если решено завести ключи в дерево (см. 6.4)
  tavilyApiKey, assemblyaiApiKey, groqApiKey
  cerebras: { apiKey, baseURL }     # только если реально используется
```

Замечания по форме:

- `database.url`/`database.memUrl`/`database.memDbName` — это **входные** значения. Производные
  `adminDatabaseUrl` и `databaseUrl` (с подстановкой имени БД через `withDb`) вычисляются в коде
  обёртки (раздел 6).
- `debug` остаётся строкой в YAML и разбирается в массив категорий в коде (как сейчас).
- `zoneWeights` остаётся строкой `"0.55,0.30,0.15"` в YAML (чтобы переопределение через ENV
  оставалось одной переменной) и разбирается в массив чисел в коде. Альтернатива — хранить YAML-массив
  `[0.55, 0.30, 0.15]`, но тогда переопределение через одну переменную окружения усложняется; выбрать
  строковую форму ради совместимости с текущим `HISTORY_ZONE_WEIGHTS`.

---

## 6. Рефакторинг кода

Ключевая идея: **сохранить публичный контракт** — экспортируемый объект `config` из
`src/config.js` должен иметь ту же форму, что и сейчас. Тогда десятки потребителей (`src/agent.js`,
`src/pipeline/*`, `src/telegram/*` и т. д.) менять не нужно — они продолжают писать
`config.proactive.contactPolicy.softDailyLimit` и так далее.

### 6.1. Зависимости и порядок загрузки

1. Добавить зависимости: `config` и `js-yaml`.
2. **Критично:** `dotenv` должен отработать **до** первого импорта пакета `config`, иначе значения из
   `.env` не попадут в `process.env` к моменту, когда node-config применяет
   `custom-environment-variables.yaml`. Поэтому в самом верху `src/config.js` оставить
   `import 'dotenv/config';` ПЕРВОЙ строкой, и только потом импортировать `config`. Поскольку
   `src/config.js` импортируется раньше всех прочих модулей приложения, этого достаточно. Проверить,
   что ни один модуль не импортирует `config` (node-config) в обход `src/config.js`.

### 6.2. Новый `src/config.js` (эскиз)

```js
// Конфигурация приложения. Значения берутся из YAML-иерархии config/ через пакет node-config,
// а переменные окружения (включая .env) переопределяют их по карте custom-environment-variables.yaml.
import 'dotenv/config';            // ПЕРВОЙ строкой: наполняет process.env до загрузки node-config
import nodeConfig from 'config';   // node-config читает каталог config/ при первом импорте
import { normalizeVoiceId } from './voice/voices.js';

// Нормализация флагов: значения 1/true/on/yes → true; всё прочее → false.
// Нужна, потому что в проекте флаги исторически задаются как on/off, а __format: boolean
// в node-config принимает только true/false. Поэтому булевы переопределения приходят строками.
const flag = (v, d = false) =>
  v === undefined || v === null
    ? d
    : ['1', 'true', 'on', 'yes'].includes(String(v).trim().toLowerCase());

// Небольшой помощник доступа: вернуть значение по пути или undefined, не бросая исключение.
const get = (path) => (nodeConfig.has(path) ? nodeConfig.get(path) : undefined);

// --- Производные значения подключения к БД ---
const adminUrl = get('database.url') || 'postgresql://postgres:1@localhost:5432/postgres';
const memDbName = get('database.memDbName') || 'agent_mem';
const withDb = (url, dbName) => url.replace(/\/[^/]*$/, `/${dbName}`);

// --- Производные значения LLM/голоса ---
const openaiBaseURL = (get('llm.baseURL') || '').trim() || undefined;
const defaultVoiceOutputModel = openaiBaseURL ? 'openai/gpt-4o-mini-tts' : 'gpt-4o-mini-tts';
const auxModel = get('llm.auxModel') || 'gpt-5.4-nano';

export const config = {
  adminDatabaseUrl: withDb(adminUrl, 'postgres'),
  databaseUrl: get('database.memUrl') || withDb(adminUrl, memDbName),
  memDbName,

  llm: {
    apiKey: get('llm.apiKey') || undefined,
    baseURL: openaiBaseURL,
    mainModel: get('llm.mainModel') || 'gpt-5.4-mini',
    auxModel,
    extractModel: get('llm.extractModel') || 'gpt-5.4-mini',
    embedModel: get('llm.embedModel') || 'text-embedding-3-small',
    embedDim: get('llm.embedDim') || 1536,
  },

  authSecret: get('security.authSecret') || 'dev-insecure-secret-change-me',
  timezone: get('timezone') || 'Europe/Moscow',
  debug: String(get('debug') || '').split(',').map((s) => s.trim()).filter(Boolean),

  companion: { enabled: flag(get('companion.enabled'), false) },

  proactive: {
    enabled: flag(get('proactive.enabled'), false),
    intervalMs: Number(get('proactive.intervalMs') ?? 300000),
    inactivityMinutes: Number(get('proactive.inactivityMinutes') ?? 1440),
    checkinHour: Number(get('proactive.checkinHour') ?? 10),
    goalIntervalMinutes: Number(get('proactive.goalIntervalMinutes') ?? 2880),
    welcomeBackGapMinutes: Number(get('proactive.welcomeBackGapMinutes') ?? 60),
    contactPolicy: {
      softDailyLimit: Number(get('proactive.contactPolicy.softDailyLimit') ?? 1),
      softWeeklyLimit: Number(get('proactive.contactPolicy.softWeeklyLimit') ?? 3),
      requestedReminderDailyLimit: Number(get('proactive.contactPolicy.requestedReminderDailyLimit') ?? 2),
      minSoftPauseMinutes: Number(get('proactive.contactPolicy.minSoftPauseMinutes') ?? 360),
      quietAfterUnanswered: Number(get('proactive.contactPolicy.quietAfterUnanswered') ?? 2),
      quietHoursAfterIgnores: Number(get('proactive.contactPolicy.quietHoursAfterIgnores') ?? 24),
    },
    events: {
      enabled: flag(get('proactive.events.enabled'), false),
      relevanceThreshold: Number(get('proactive.events.relevanceThreshold') ?? 0.6),
    },
  },

  schema: { keyEmbedThreshold: Number(get('schema.keyEmbedThreshold') ?? 0.82) },

  skills: {
    dir: get('skills.dir') || 'skills',
    switchThreshold: Number(get('skills.switchThreshold') ?? 0.65),
    referenceMaxBytes: Number(get('skills.referenceMaxBytes') ?? 50000),
    authoring: {
      enabled: flag(get('skills.authoring.enabled'), false),
      model: get('skills.authoring.model') || null,
    },
  },

  memoryLimits: {
    profile: Number(get('memoryLimits.profile') ?? 7),
    dialog: Number(get('memoryLimits.dialog') ?? 5),
    domain: Number(get('memoryLimits.domain') ?? 12),
    reminder: Number(get('memoryLimits.reminder') ?? 3),
    secure: Number(get('memoryLimits.secure') ?? 3),
    total: Number(get('memoryLimits.total') ?? 30),
  },

  globalMemory: {
    factsEnabled: flag(get('globalMemory.factsEnabled'), false),
    factsLimit: Number(get('globalMemory.factsLimit') ?? 5),
    ragEnabled: flag(get('globalMemory.ragEnabled'), false),
    ragLimit: Number(get('globalMemory.ragLimit') ?? 5),
    ragMinRelevance: Number(get('globalMemory.ragMinRelevance') ?? 0.3),
  },

  voiceInput: {
    enabled: flag(get('voiceInput.enabled'), false),
    provider: get('voiceInput.provider') || 'groq-whisper-large-v3-turbo',
    maxSeconds: Number(get('voiceInput.maxSeconds') ?? 300),
    maxBytes: Number(get('voiceInput.maxBytes') ?? 25000000),
    language: get('voiceInput.language') || 'ru',
  },

  voiceOutput: {
    enabled: flag(get('voiceOutput.enabled'), false),
    model: get('voiceOutput.model') || defaultVoiceOutputModel,
    voice: normalizeVoiceId(get('voiceOutput.voice')) || 'alloy',
    format: get('voiceOutput.format') || 'opus',
    maxChars: Math.min(500, Number(get('voiceOutput.maxChars') ?? 500)),
    summaryMaxChars: Number(get('voiceOutput.summaryMaxChars') ?? 500),
    summaryModel: get('voiceOutput.summaryModel') || auxModel,
  },

  streaming: {
    enabled: flag(get('streaming.enabled'), true),
    telegramEnabled: flag(get('streaming.telegramEnabled'), true),
    editIntervalMs: Number(get('streaming.editIntervalMs') ?? 500),
    minEditChars: Number(get('streaming.minEditChars') ?? 20),
    minFirstDraftChars: Number(get('streaming.minFirstDraftChars') ?? 50),
    toolStatuses: flag(get('streaming.toolStatuses'), true),
  },

  historyCompression: {
    enabled: flag(get('historyCompression.enabled'), false),
    hotWindow: Number(get('historyCompression.hotWindow') ?? 8),
    maxTokens: Number(get('historyCompression.maxTokens') ?? 2000),
    shrinkTokens: Number(get('historyCompression.shrinkTokens') ?? 800),
    zoneWeights: String(get('historyCompression.zoneWeights') || '0.55,0.30,0.15').split(',').map(Number),
    model: get('historyCompression.model') || auxModel,
    minCompressGain: Number(get('historyCompression.minCompressGain') ?? 0.35),
  },

  // Новые секции, ранее читавшиеся напрямую из process.env:
  telegram: {
    apiKey: get('telegram.apiKey') || undefined,
    maxConcurrency: Number(get('telegram.maxConcurrency') ?? 5),
    outboxSafetyIntervalMs: Number(get('telegram.outboxSafetyIntervalMs') ?? 30000),
  },
  scheduler: {
    minSleepMs: Number(get('scheduler.minSleepMs') ?? 250),
    maxSleepMs: Number(get('scheduler.maxSleepMs') ?? 30000),
    workerId: get('scheduler.workerId') || 'scheduler-1',
  },
  sandbox: { port: Number(get('sandbox.port') ?? 3000) },
  mcp: { configPath: get('mcp.configPath') || '.mcp.json' },
};

// Гистерезис: целевой размер дайджеста должен быть строго меньше порога запуска.
if (config.historyCompression.shrinkTokens >= config.historyCompression.maxTokens) {
  throw new Error('historyCompression.shrinkTokens должен быть меньше historyCompression.maxTokens');
}

export function debugEnabled(category) {
  return config.debug.includes('*') || config.debug.includes(category);
}
```

> Примечание по `??` против `||`: для числовых значений предпочтительнее `??` (нулевой допустимый ноль
> не должен заменяться на значение по умолчанию). Но так как все значения по умолчанию уже заданы в
> `default.yaml`, ветка `?? default` срабатывает только если ключ отсутствует целиком. Оставить
> `?? default` как страховку и для самодокументирования.

### 6.3. Обработка булевых флагов (критичный момент)

В текущем `.env` флаги задаются значениями `on`/`off`. Пакет node-config с `__format: boolean`
понимает только `"true"`/`"false"`. Поэтому в `custom-environment-variables.yaml` все флаги
отображать **без** `__format` (как простые строки), а нормализацию делать в коде помощником `flag()`.

В `default.yaml` те же флаги хранить как настоящие булевы YAML (`true`/`false`) — `flag()` корректно
пропускает булев `true`/`false` (через `String(v)`), так что обе формы работают.

Альтернатива (по желанию): мигрировать значения в `.env.example` и документацию на `true`/`false` и
тогда можно использовать `__format: boolean`, убрав помощник `flag()`. Это чище, но ломает привычку
`on`/`off`. **Рекомендация:** на первом этапе сохранить `flag()` и строковое отображение ради
обратной совместимости; смену на нативные булевы вынести в отдельную задачу.

### 6.4. Прямые потребители `process.env`

Привести к чтению из `config` все прикладные параметры; секреты-ключи допустимо оставить прямым
чтением окружения, если их не заводят в дерево.

- `src/telegram/bot.js`:
  - `process.env.TELEGRAM_API_KEY` → `config.telegram.apiKey`.
  - `process.env.TELEGRAM_MAX_CONCURRENCY` → `config.telegram.maxConcurrency`.
  - `process.env.OUTBOX_SAFETY_INTERVAL_MS` → `config.telegram.outboxSafetyIntervalMs`.
  - `process.env.SCHEDULER_MIN_SLEEP_MS` / `MAX` → `config.scheduler.minSleepMs` / `maxSleepMs`.
  - Импортировать `config` из `../config.js` (он там уже импортируется — проверить).
- `src/scheduler-run.js`: `SCHEDULER_MIN_SLEEP_MS`/`MAX` → `config.scheduler.*`.
- `src/pipeline/scheduler.js`: `WORKER_ID` → `config.scheduler.workerId`.
- `src/sandbox/server.js`: `SANDBOX_PORT` → `config.sandbox.port`.
- `src/mcp/config.js`: `MCP_CONFIG_PATH` → `config.mcp.configPath` (учесть, что путь резолвится
  относительно `process.cwd()` — сохранить это поведение).
- `src/voice/transcribe.js` и `scripts/*-experiment.js`: ключи `ASSEMBLYAI_API_KEY`, `GROQ_API_KEY`,
  `OPENAI_API_KEY`. Решение: для ключей-секретов либо завести `config.providers.*` и читать оттуда,
  либо оставить прямое `process.env` (ключи всё равно приходят из окружения/`.env`/`local.yaml`).
  Если завести в дерево — добавить соответствующие строки в `custom-environment-variables.yaml`,
  чтобы переменные окружения продолжали работать. **Скрипты-эксперименты** (`scripts/`) можно оставить
  на прямом `process.env`, так как они автономны и не часть основного потока.

> Перед правкой обязательно выполнить `grep -rn "process\.env\." src scripts` и убедиться, что
> охвачены все точки. Ничего не пропустить.

---

## 7. Содержимое файлов (заготовки для копирования)

### 7.1. `config/default.yaml`

Полное дерево со значениями по умолчанию и комментариями. Привести в соответствие с таблицей раздела 4.
Секреты — пустыми или `***`. Все необязательные контуры — выключены. Пример фрагмента (executor
обязан расписать ВСЕ секции аналогично):

```yaml
---
#> ========================================================================
#> База данных. database.url — базовая строка подключения, из неё выводится
#> административное подключение (CREATE DATABASE) и рабочая БД памяти.
#> ========================================================================
database:
  #> Базовая строка подключения к Postgres (из неё создаётся/выбирается БД памяти)
  url: 'postgresql://postgres:1@localhost:5432/postgres'
  #> Имя отдельной БД памяти агента, если memUrl не задан
  memDbName: 'agent_mem'
  #> Полная строка подключения к рабочей БД памяти; переопределяет url + memDbName
  memUrl: ''

#> LLM-провайдер (OpenAI или совместимый прокси, например LiteLLM)
llm:
  #> Ключ API провайдера (секрет; держать в local.yaml или в окружении)
  apiKey: ''
  #> Базовый URL OpenAI-совместимого провайдера. Пусто → прямой api.openai.com
  baseURL: ''
  #> Основная модель агента (ответы пользователю, вызов инструментов)
  mainModel: 'gpt-5.4-mini'
  #> Быстрая вспомогательная модель (классификация запроса)
  auxModel: 'gpt-5.4-nano'
  #> Модель извлечения фактов в память
  extractModel: 'gpt-5.4-mini'
  #> Модель эмбеддингов для смыслового поиска памяти
  embedModel: 'text-embedding-3-small'
  #> Размерность эмбеддингов выбранной модели
  embedDim: 1536

#> Шифрование защищённых данных (AES-256-GCM)
security:
  #> Секрет для шифрования. ОБЯЗАТЕЛЬНО заменить в проде (минимум 32 случайных байта)
  authSecret: 'dev-insecure-secret-change-me'

#> Часовой пояс по умолчанию для логики дат и времени
timezone: 'Europe/Moscow'

#> Категории отладочной трассировки через запятую (llm, llm:summarizer, mcp:tool, * и т.д.)
debug: ''

#> Режим собеседника (темпоральный и тематический контекст + извлечение тем)
companion:
  enabled: false

#> Проактивный контур: бот пишет первым по триггерам с анти-спамом
proactive:
  enabled: false
  intervalMs: 300000
  inactivityMinutes: 1440
  checkinHour: 10
  goalIntervalMinutes: 2880
  welcomeBackGapMinutes: 60
  contactPolicy:
    softDailyLimit: 1
    softWeeklyLimit: 3
    requestedReminderDailyLimit: 2
    minSoftPauseMinutes: 360
    quietAfterUnanswered: 2
    quietHoursAfterIgnores: 24
  events:
    enabled: false
    relevanceThreshold: 0.6

#> Канонизация ключей доменной памяти по эмбеддингу
schema:
  keyEmbedThreshold: 0.82

#> Agent Skills — доменные namespace памяти и поведение домена
skills:
  dir: 'skills'
  switchThreshold: 0.65
  referenceMaxBytes: 50000
  authoring:
    enabled: false
    model: null    # пусто → берётся llm.mainModel

#> Лимиты минимизации памяти (сколько фактов каждой области попадает в промпт)
memoryLimits:
  profile: 7
  dialog: 5
  domain: 12
  reminder: 3
  secure: 3
  total: 30

#> Глобальная память и общая база знаний (RAG)
globalMemory:
  factsEnabled: false
  factsLimit: 5
  ragEnabled: false
  ragLimit: 5
  ragMinRelevance: 0.3

#> Распознавание входящего аудио (речь в текст)
voiceInput:
  enabled: false
  provider: 'groq-whisper-large-v3-turbo'
  maxSeconds: 300
  maxBytes: 25000000
  language: 'ru'

#> Голосовой ответ бота (текст в речь). model по умолчанию выбирается кодом
#> по наличию llm.baseURL (прокси → 'openai/gpt-4o-mini-tts', прямой API → 'gpt-4o-mini-tts')
voiceOutput:
  enabled: false
  model: ''          # пусто → код подставит модель по llm.baseURL
  voice: 'alloy'
  format: 'opus'
  maxChars: 500      # жёсткий максимум — 500, код ограничивает Math.min(500, ...)
  summaryMaxChars: 500
  summaryModel: ''   # пусто → берётся llm.auxModel

#> Потоковая обратная связь
streaming:
  enabled: true
  telegramEnabled: true
  editIntervalMs: 500
  minEditChars: 20
  minFirstDraftChars: 50
  toolStatuses: true

#> Поджатие старой части истории диалога
historyCompression:
  enabled: false
  hotWindow: 8
  maxTokens: 2000
  shrinkTokens: 800        # должен быть строго меньше maxTokens (проверяется в коде)
  zoneWeights: '0.55,0.30,0.15'   # доли бюджета: ближняя/средняя/дальняя
  model: ''                # пусто → берётся llm.auxModel
  minCompressGain: 0.35

#> Канал Telegram (ранее читалось напрямую из окружения в bot.js)
telegram:
  apiKey: ''               # токен бота (секрет; держать в local.yaml или окружении)
  maxConcurrency: 5
  outboxSafetyIntervalMs: 30000

#> Планировщик фоновых задач
scheduler:
  minSleepMs: 250
  maxSleepMs: 30000
  workerId: 'scheduler-1'

#> Песочница
sandbox:
  port: 3000

#> Клиент MCP
mcp:
  configPath: '.mcp.json'

#> Внешние провайдеры (ключи; завести только если реально используются — см. раздел 4.3/6.4)
# providers:
#   tavilyApiKey: ''
#   assemblyaiApiKey: ''
#   groqApiKey: ''
```

### 7.2. `config/custom-environment-variables.yaml`

Карта обратной совместимости: каждая текущая переменная окружения → её путь. Числа помечать
`__format: number`. Флаги — БЕЗ `__format` (строкой; нормализует код, см. 6.3). Полный файл:

```yaml
---
database:
  url: DATABASE_URL
  memDbName: MEM_DB_NAME
  memUrl: MEM_DATABASE_URL

llm:
  apiKey: OPENAI_API_KEY
  baseURL: OPENAI_BASE_URL
  mainModel: MAIN_MODEL
  auxModel: AUX_MODEL
  extractModel: EXTRACT_MODEL
  embedModel: EMBED_MODEL

security:
  authSecret: AUTH_SECRET

timezone: TZ_DEFAULT
debug: DEBUG

companion:
  enabled: COMPANION_MODE        # флаг (on/off) — нормализует код

proactive:
  enabled: PROACTIVE_ENABLED
  intervalMs:
    __name: PROACTIVE_INTERVAL_MS
    __format: number
  inactivityMinutes:
    __name: PROACTIVE_INACTIVITY_MIN
    __format: number
  checkinHour:
    __name: PROACTIVE_CHECKIN_HOUR
    __format: number
  goalIntervalMinutes:
    __name: PROACTIVE_GOAL_INTERVAL_MIN
    __format: number
  welcomeBackGapMinutes:
    __name: PROACTIVE_WELCOME_GAP_MIN
    __format: number
  contactPolicy:
    softDailyLimit:
      __name: PROACTIVE_SOFT_DAILY_LIMIT
      __format: number
    softWeeklyLimit:
      __name: PROACTIVE_SOFT_WEEKLY_LIMIT
      __format: number
    requestedReminderDailyLimit:
      __name: PROACTIVE_REQUESTED_REMINDER_DAILY_LIMIT
      __format: number
    minSoftPauseMinutes:
      __name: PROACTIVE_MIN_SOFT_PAUSE_MIN
      __format: number
    quietAfterUnanswered:
      __name: PROACTIVE_QUIET_AFTER_UNANSWERED
      __format: number
    quietHoursAfterIgnores:
      __name: PROACTIVE_QUIET_HOURS_AFTER_IGNORES
      __format: number
  events:
    enabled: PROACTIVE_EVENTS_ENABLED
    relevanceThreshold:
      __name: NEWS_RELEVANCE_THRESHOLD
      __format: number

schema:
  keyEmbedThreshold:
    __name: SCHEMA_KEY_EMBED_THRESHOLD
    __format: number

skills:
  dir: SKILLS_DIR
  switchThreshold:
    __name: SKILLS_SWITCH_THRESHOLD
    __format: number
  referenceMaxBytes:
    __name: SKILL_REFERENCE_MAX_BYTES
    __format: number
  authoring:
    enabled: SKILL_AUTHORING_ENABLED
    model: SKILL_AUTHORING_MODEL

memoryLimits:
  profile:
    __name: MEMORY_LIMIT_PROFILE
    __format: number
  dialog:
    __name: MEMORY_LIMIT_DIALOG
    __format: number
  domain:
    __name: MEMORY_LIMIT_DOMAIN
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

globalMemory:
  factsEnabled: GLOBAL_MEMORY_ENABLED
  factsLimit:
    __name: GLOBAL_FACTS_LIMIT
    __format: number
  ragEnabled: GLOBAL_RAG_ENABLED
  ragLimit:
    __name: GLOBAL_RAG_LIMIT
    __format: number
  ragMinRelevance:
    __name: GLOBAL_RAG_MIN_RELEVANCE
    __format: number

voiceInput:
  enabled: VOICE_INPUT_ENABLED
  provider: VOICE_INPUT_PROVIDER
  maxSeconds:
    __name: VOICE_INPUT_MAX_SECONDS
    __format: number
  maxBytes:
    __name: VOICE_INPUT_MAX_BYTES
    __format: number
  language: VOICE_INPUT_LANG

voiceOutput:
  enabled: VOICE_OUTPUT_ENABLED
  model: VOICE_OUTPUT_MODEL
  voice: VOICE_OUTPUT_VOICE
  format: VOICE_OUTPUT_FORMAT
  maxChars:
    __name: VOICE_OUTPUT_MAX_CHARS
    __format: number
  summaryMaxChars:
    __name: VOICE_OUTPUT_SUMMARY_MAX_CHARS
    __format: number
  summaryModel: VOICE_OUTPUT_SUMMARY_MODEL

streaming:
  enabled: LLM_STREAMING_ENABLED
  telegramEnabled: TELEGRAM_STREAMING_ENABLED
  editIntervalMs:
    __name: TELEGRAM_STREAM_EDIT_INTERVAL_MS
    __format: number
  minEditChars:
    __name: TELEGRAM_STREAM_MIN_EDIT_CHARS
    __format: number
  minFirstDraftChars:
    __name: TELEGRAM_STREAM_MIN_FIRST_DRAFT_CHARS
    __format: number
  toolStatuses: TELEGRAM_TOOL_STATUS_ENABLED

historyCompression:
  enabled: HISTORY_COMPRESSION_ENABLED
  hotWindow:
    __name: HISTORY_HOT_WINDOW
    __format: number
  maxTokens:
    __name: HISTORY_MAX_TOKENS
    __format: number
  shrinkTokens:
    __name: HISTORY_SHRINK_TOKENS
    __format: number
  zoneWeights: HISTORY_ZONE_WEIGHTS
  model: HISTORY_SUMMARY_MODEL
  minCompressGain:
    __name: HISTORY_MIN_COMPRESS_GAIN
    __format: number

telegram:
  apiKey: TELEGRAM_API_KEY
  maxConcurrency:
    __name: TELEGRAM_MAX_CONCURRENCY
    __format: number
  outboxSafetyIntervalMs:
    __name: OUTBOX_SAFETY_INTERVAL_MS
    __format: number

scheduler:
  minSleepMs:
    __name: SCHEDULER_MIN_SLEEP_MS
    __format: number
  maxSleepMs:
    __name: SCHEDULER_MAX_SLEEP_MS
    __format: number
  workerId: WORKER_ID

sandbox:
  port:
    __name: SANDBOX_PORT
    __format: number

mcp:
  configPath: MCP_CONFIG_PATH

# providers:   # раскомментировать, если ключи заведены в дерево
#   tavilyApiKey: TAVILY_API_KEY
#   assemblyaiApiKey: ASSEMBLYAI_API_KEY
#   groqApiKey: GROQ_API_KEY
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

### 7.5. `config/local.example.yaml` (шаблон для разработчика)

```yaml
---
# Скопируйте этот файл в config/local.yaml и впишите реальные секреты.
# config/local.yaml в .gitignore и не коммитится.
database:
  url: 'postgresql://postgres:ПАРОЛЬ@localhost:5432/postgres'
llm:
  apiKey: 'sk-...'
  baseURL: 'https://litellm.my-proxy.com/v1'
security:
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
    "js-yaml": "^4.x"
    // ... существующие
  }
  ```
  `dotenv` оставить (он по-прежнему нужен как мост `.env` → `process.env`).
- При желании добавить скрипты запуска с явным окружением, например:
  ```jsonc
  "scripts": {
    "telegram:prod": "cross-env NODE_ENV=production node src/telegram/bot.js"
  }
  ```
  (но `cross-env` в зависимостях сейчас нет — либо добавить, либо задавать переменную в окружении).

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
совместимый мост. Удалить из `.env.example` мёртвые переменные (раздел 4.3).

### 8.4. Документация

Обновить `README.md` (и/или `AGENTS.md`): описать новую иерархию `config/`, порядок приоритета,
где хранить секреты (`config/local.yaml`), как выбрать окружение (`NODE_ENV`). Текст на русском —
полными предложениями, по правилам проекта.

---

## 9. Порядок выполнения (пошагово)

1. Создать ветку/worktree для задачи.
2. `npm install config js-yaml` (зафиксируется в `package.json` и `package-lock.json`).
3. Создать каталог `config/` и все файлы из раздела 7.
4. Переписать `src/config.js` по эскизу раздела 6.2, сохранив форму экспортируемого `config`.
5. Перевести прямых потребителей `process.env` на `config` (раздел 6.4). Сделать `grep` и не пропустить.
6. Прогнать `grep -rn "process\.env\." src` — убедиться, что остались только осознанно оставленные
   места (например, секреты-ключи в `transcribe.js`/скриптах, если решено не заводить их в дерево, и
   служебные переменные node-config вроде `NODE_ENV`).
7. Обновить `.gitignore`, `.env.example`, документацию.
8. Прогнать линтер и форматтер: `npm run lint && npm run format` (проект уже использует oxlint/oxfmt).
9. Прогнать тесты (раздел 10). Исправить регрессии.
10. Закоммитить. В сообщении коммита описать суть и обратную совместимость.

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
`config/local.yaml` (или оставить рабочий `.env`, он всё ещё читается через `dotenv`). Команды:

- Модульные (без БД): `npm run test:telegram-format`, `test:progress-format`, `test:voice-selector`,
  `test:schema`, `test:skills`, `test:tts-strip` и прочие `.mjs`.
- Полный интеграционный: `npm test` (использует БД и модели). Ожидаемый результат — без провалов
  (на момент написания задания базовый прогон даёт «135 пройдено, 0 провалено»).

### 10.3. Критерии приёмки

- [ ] Каталог `config/` создан, содержит `default.yaml`, `development.yaml`, `production.yaml`,
      `custom-environment-variables.yaml`, `local.example.yaml`.
- [ ] `config/local.yaml` и `config/local-*.yaml` добавлены в `.gitignore`.
- [ ] `src/config.js` читает значения через node-config, форма экспортируемого `config` не изменилась
      (или изменения учтены во всех потребителях).
- [ ] Все прямые чтения `process.env.*` прикладных параметров переведены на `config` (кроме осознанно
      оставленных секретов-ключей и служебных переменных node-config).
- [ ] Существующие переменные окружения (и значения из `.env` через `dotenv`) по-прежнему
      переопределяют конфигурацию (обратная совместимость подтверждена сценарием 10.1.2).
- [ ] Гистерезис `historyCompression.shrinkTokens < maxTokens` проверяется и бросает понятную ошибку.
- [ ] Булевы флаги в форме `on`/`off` корректно интерпретируются (через `flag()`).
- [ ] `npm run lint` и `npm run format` — чисто.
- [ ] Дамп `config` до и после миграции совпадает на одинаковых входных данных.
- [ ] Тесты проходят: модульные — все; полный набор `npm test` — без провалов (при доступной БД/прокси).
- [ ] Мёртвые переменные из `.env.example` (раздел 4.3) проверены и удалены/учтены.
- [ ] Документация (README/AGENTS) описывает новую иерархию и хранение секретов.

---

## 11. Риски и тонкие места (на что обратить внимание)

1. **Порядок загрузки dotenv vs node-config.** `import 'dotenv/config'` обязан выполниться до первого
   импорта `config`. Нарушение приведёт к тому, что значения из `.env` молча не применятся.
2. **Булевы `on`/`off`.** Нельзя помечать флаги `__format: boolean`. Сохранить `flag()`-нормализацию.
3. **Иммутабельность node-config.** После первого доступа дерево становится неизменяемым. Наша обёртка
   только читает — это безопасно. Не пытаться мутировать `nodeConfig`.
4. **Числовой ноль.** Использовать `??` вместо `||` там, где `0` — допустимое значение, чтобы не
   подменять его значением по умолчанию.
5. **Вычисляемые значения по умолчанию.** `voiceOutput.model`, `voiceOutput.summaryModel`,
   `historyCompression.model` зависят от других значений (`llm.baseURL`, `llm.auxModel`). В YAML
   хранить пустую строку/`null`, а финальный выбор делать в коде обёртки (как в эскизе 6.2).
6. **`Math.min(500, ...)` для `voiceOutput.maxChars`.** Сохранить жёсткий потолок 500 в коде, даже если
   в YAML/окружении задано больше.
7. **`zoneWeights` и `debug`** — строки, разбираемые в массивы в коде. Не превращать в YAML-массивы,
   иначе сломается переопределение одной переменной окружения.
8. **Секреты в репозитории.** Ни `default.yaml`, ни `development.yaml`, ни `production.yaml` не должны
   содержать реальных секретов. Только `local.yaml` (в `.gitignore`) или переменные окружения.
9. **Скрипты `scripts/*-experiment.js`.** Автономны; их перевод на `config` не обязателен — допустимо
   оставить прямое чтение `process.env`.
10. **Один источник чтения `config` (node-config).** Только `src/config.js` импортирует пакет `config`.
    Все остальные модули импортируют объект из `src/config.js`. Не плодить параллельные точки входа.

---

## 12. Итог

После выполнения проект будет конфигурироваться иерархией YAML-файлов node-config с чётким разделением
«структура и значения по умолчанию (`default.yaml`) → окружение (`development`/`production`) → локальные
секреты (`local.yaml`) → переопределение переменными окружения (`custom-environment-variables.yaml`)».
Существующие деплои и `.env` продолжат работать без изменений за счёт карты переменных окружения и
сохранённого `dotenv`. Публичный контракт `src/config.js` (форма объекта `config`) сохраняется, поэтому
прикладной код менять почти не придётся.
```
