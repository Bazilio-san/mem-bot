# План-промпт: просмотрщик логов LLM-запросов в админке mem-bot

Этот документ — исчерпывающее задание на реализацию. Он написан как промпт для будущей сессии: в нём
зафиксировано текущее состояние кода, заимствования из референсной реализации, необходимые доработки данных,
API, структура интерфейса и порядок работ. Прототип внешнего вида лежит рядом: `prototype.html`.

---

## 1. Цель

Добавить в админку (Vue 3 + Vite, каталог `web/`, API в `src/server/admin-api.js`) страницу просмотра логов
обращений к LLM. Страница состоит из трёх зон: поиск пользователя (с подсказками), панель чата слева
(история диалога, как в Telegram, с ленивой подгрузкой вверх) и основная панель журнала справа, куда по клику
на сообщении или на бэйдже сервисного запроса выводится цепочка событий соответствующего цикла. Ключевой
принцип интерфейса — многослойное прогрессивное раскрытие информации: сначала компактные заголовки, затем
краткое содержимое, затем полное содержимое с авто-определением формата (JSON/MD/HTML/RAW).

## 2. Текущее состояние mem-bot (зафиксировано исследованием 2026-06-10)

### 2.1. Админка

- Сервер: Express 5, точка входа `src/server/index.js`, API-роутер `src/server/admin-api.js` (префикс `/api`),
  порт `config.admin.port` (по умолчанию 9019). Слой данных переиспользуется из `src/sandbox/data.js`.
- Фронтенд: Vue 3 + Vite в `web/` (`web/src/App.vue` — единственная страница «память пользователя»,
  `web/src/api.js` — обёртка fetch, `web/src/styles.css` — стили). Роутера нет, состояние на `ref()`.
  UI-кит PrimeVue v4 с темой Aura уже подключён и используется (`DataTable`, `MultiSelect`, `Button`).
- В dev-режиме Vite-сервер на :5173 проксирует `/api` на :9019; в production Express отдаёт `web/dist`.

### 2.2. Журнал LLM-запросов (уже есть)

- Единая точка всех вызовов LLM — `src/llm.js`: функции `chat()`, `chatStream()`, `chatJSON()`, `embed()`.
  Каждая вызывает `safeLog()` → `logLlmRequest()` из `src/pipeline/llm-log.js` (буфер + батч-вставка).
- Таблица `log.llm_request` (полный журнал): `llm_request_id, created_at, request_id, request_kind, endpoint,
  provider, model, model_priced, user_id, conversation_id, domain_key, channel, is_binary, payload (jsonb),
  binary_meta, payload_truncated, prompt_tokens, completion_tokens, total_tokens, price_usd, duration_ms,
  status, error, is_test`. Узкая таблица `log.llm_usage` заполняется триггером — для агрегатов стоимости.
- Корреляция: `request_id` вида `llm_<ts>_<rnd>` генерируется на каждый ход диалога в `src/agent.js:342` и
  пробрасывается через `AsyncLocalStorage` (`src/pipeline/llm-context.js`). Все LLM-вызовы хода (классификация,
  основной ответ, выгрузка фактов и т. д.) получают общий `request_id`.
- Виды запросов `REQUEST_KINDS` (`src/pipeline/llm-log.js:16`): `main_agent_answer, delivery_intent,
  intent_classify, fact_extract, topic_extract, event_relevance, proactive_message, history_compress,
  skill_authoring, voice_summary, embedding, stt, tts, untyped`.

### 2.3. Хранение диалога

- `mem.conversation_messages` (`migrations/001_init.sql:116`): `id, conversation_id, user_id, role
  (system|user|assistant|tool), content, tool_name, tool_call_id, token_count, metadata jsonb, created_at`.
- `mem.message_external_refs` — связь с Telegram message id. `mem.users` — `id uuid, external_id, display_name…`.

### 2.4. Обнаруженные пробелы (их закрывает этот план)

1. **Ответ модели не сохраняется.** В `payload` пишется только тело запроса (`src/llm.js:71,186,236,266`).
   Без ответа просмотрщик неполон: нечего показать в строке «← LLM» и не из чего синтезировать tool-вызовы.
2. **`request_id` не привязан к сообщению.** `saveMessage()` в `src/agent.js:626-627` не кладёт `request_id`
   в `metadata`, поэтому по сообщению чата нельзя напрямую найти его цикл логов.

## 3. Референс: multi-bot `events-log` — что заимствуем

Изучена реализация `D:\DEV\FA\_cur\multi-bot\src\components\pg\_common\events-log` (Vue 3 + Quasar):
`events-log-area.vue`, `event-log.sass`, типы в `_types_/i-chat-event.d.ts`, рендер в
`api/orm/log/event/chat-event.ts`. Заимствуем проверенные решения:

- **Строка события** = раскрываемый элемент: номер, иконка с отступом-иерархией, заголовок, токены и цена
  (серым, мелко), время справа, стрелка раскрытия. Раскрытая часть — моноширинный блок содержимого.
- **Пастельная палитра по категориям** (точные значения из референса, адаптируем под наши kind'ы — §7).
- **Шапка журнала**: суммарные токены и стоимость, кнопки «развернуть всё»/«свернуть всё».
- **Отступ-иерархия** через margin-left иконки: 0 / 20 / 40 px (мы добавим явные группы-заголовки, §6.3).
- **Ссылка «more»** для длинного содержимого, pretty-print JSON, таблицы для табличных данных.

Чего в референсе не хватает (и что мы делаем иначе): нет вызовов LLM вне циклов (у нас — сервисные бэйджики в
ленте чата), нет переключателя формата содержимого, нет прогрессивного раскрытия `messages` и `tools`, нет
кнопки AI-анализа контекста, плоская структура без группировки по стадиям.

## 4. Доработки бэкенда: данные

### 4.1. Миграция: ответ модели в журнале

В `migrations/001_init.sql` (идемпотентно, по образцу существующих `ADD COLUMN IF NOT EXISTS`):

```sql
ALTER TABLE log.llm_request ADD COLUMN IF NOT EXISTS response jsonb;
ALTER TABLE log.llm_request ADD COLUMN IF NOT EXISTS response_truncated boolean NOT NULL DEFAULT false;
```

В `src/pipeline/llm-log.js`: добавить колонки в `COLUMNS`, в `buildRecord()` обрезать `response` тем же
`buildPayloadJson()` (лимит `config.llmLog.maxPayloadChars`). В `src/llm.js` передавать в `safeLog()`:

- `chat()` / `chatJSON()` — `response: res.choices[0].message` (плюс `finish_reason`);
- `chatStream()` — собранное финальное сообщение `message` (оно уже есть после `finalizeChatMessage`);
- `embed()` — НЕ сохранять векторы (тяжело и бесполезно), писать `{ dims, count }`;
- STT/TTS (`src/voice/transcribe.js`, `src/voice/tts.js`) — текст распознавания / метаданные аудио.

### 4.2. Привязка цикла к сообщению

В `src/agent.js` при сохранении сообщений хода (строки ~626-627, а также ветки реакций ~691-692, ~736)
передавать `extra.metadata.request_id = llmMeta.requestId` и для user-, и для assistant-сообщения. Для старых
сообщений без `request_id` предусмотреть в API fallback: поиск записей `log.llm_request` по `conversation_id`
в окне времени от данного user-сообщения до следующего user-сообщения.

### 4.3. Журнал агентных событий `log.agent_event` (ОБЯЗАТЕЛЬНО — решение 2026-06-10)

Цепочка цикла строится не синтезом из payload'ов, а по явному журналу событий: нужна исчерпывающая картина,
включая тайминги инструментов, ошибки между итерациями и служебные шаги, которых в payload'ах нет.

Таблица (в БД логов, см. §4.4):

```sql
CREATE TABLE IF NOT EXISTS log.agent_event (
    agent_event_id  bigserial PRIMARY KEY,
    created_at      timestamptz NOT NULL DEFAULT now(),
    request_id      text,               -- тот же корреляционный id, что в log.llm_request
    user_id         text,
    conversation_id text,
    event_type      text NOT NULL,      -- таксономия ниже
    title           text,               -- готовый человекочитаемый заголовок строки журнала
    data            jsonb,              -- аргументы/результат/детали (обрезка как у payload)
    duration_ms     integer,            -- для *.completed — длительность от парного *.started
    status          text NOT NULL DEFAULT 'ok',  -- ok | error
    error           text,
    is_test         boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS agent_event_request_ix ON log.agent_event (request_id, agent_event_id);
CREATE INDEX IF NOT EXISTS agent_event_created_ix ON log.agent_event (created_at);
CREATE INDEX IF NOT EXISTS agent_event_user_ix    ON log.agent_event (user_id, created_at);
```

Таксономия `event_type` (стартовый набор, расширяемый): `agent.started`, `stage.started`,
`tool.started`, `tool.completed`, `mcp.connected`, `mcp.failed`, `assistant.completed`, `agent.completed`,
`agent.failed`. Базируется на уже существующих событиях `emit()` в `src/agent.js` (строки 283-662); событие
`assistant.delta` (стриминговые дельты) в журнал НЕ пишется — это шум, итог есть в `assistant.completed`.

Точка записи. ВАЖНО: не перехватывать `emit()` как есть, по двум причинам. Во-первых, `emit()` срабатывает
только при подключённом адаптере доставки (`onEvent`), а журнал должен писаться всегда. Во-вторых, события
для канала доставки сознательно НЕ содержат аргументов инструментов (приватность, `src/agent.js:596`) — а в
журнале аргументы и результат нужны (админка локальная, §10.3). Поэтому добавляется отдельный модуль
`src/pipeline/agent-event-log.js` с функцией `logAgentEvent({eventType, title, data, durationMs, status,
error})`: контекст (`request_id`, `user_id`, `conversation_id`) она берёт сама из `getLlmContext()`, пишет
через тот же буферно-батчевый механизм, что `llm-log.js` (общую часть — буфер, таймер, multi-row INSERT,
drain при выключении — вынести в разделяемый помощник, чтобы не дублировать). Вызовы `logAgentEvent`
ставятся рядом с существующими `emit()` в `src/agent.js`, плюс в местах вызова/результата инструментов —
с полными аргументами и результатом (`toolsUsed` уже собирает `{name, args, result}`, строка 607), и в
`src/mcp/client.js` — события подключения MCP-серверов.

В просмотрщике события и LLM-записи сливаются в одну ленту по `request_id` и времени (§5.3).

### 4.4. Отдельная база данных для логов (решение 2026-06-10)

Объёмные быстрорастущие логи отделяются от пользовательских данных: таблицы `log.llm_request`,
`log.llm_usage` и `log.agent_event` живут в ОТДЕЛЬНОЙ базе PostgreSQL (например, `mem_bot_logs`), а не в
рабочей `mem_bot`. Мотивация: независимые бэкапы и ретеншн, рост логов не раздувает базу памяти, чистка
логов не трогает пользовательские данные.

Инфраструктура уже готова к этому: `af-db-ts` работает с именованными подключениями
(`config.db.postgres.dbs.<connectionId>`, сейчас есть `bootstrap` и `main`). Доработки:

1. **Конфиг**: новое подключение `logs` в `config/default.yaml` (`database: 'mem_bot_logs'`, хост/порт/пароль
   аналогично `main`; pgvector ему не нужен) + зеркало в `local.example.yaml`.
2. **`src/db.js`**: экспортировать `queryLog(text, params)` и `getLogPool()` — тонкие обёртки с
   `connectionId: 'logs'` по образцу существующих `query()`/`getPool()`.
3. **`src/migrate.js`**: вторым проходом создавать базу логов (через то же служебное подключение `bootstrap`)
   и применять к ней миграции из нового каталога `migrations-log/`.
4. **Перенос DDL**: блок `log.*` (схема, обе таблицы, функция и триггер `llm_request_to_usage`,
   `migrations/001_init.sql:602-682`) переезжает в `migrations-log/001_log_init.sql` (плюс новые колонки
   `response`/`response_truncated` из §4.1 и таблица `agent_event` из §4.3). Из `001_init.sql` блок удалить.
5. **Точки записи/чтения**: `src/pipeline/llm-log.js` (INSERT) и `src/pipeline/llm-usage-stats.js` (SELECT
   по `log.llm_usage`) переводятся с `query` на `queryLog`; новый `agent-event-log.js` сразу пишет через
   `queryLog`. Других обращений к `log.*` в коде нет (проверено поиском).
6. **Существующие установки**: после применения миграций старые таблицы `log.*` в `mem_bot` остаются с
   историческими данными. Одноразовый перенос — скриптом `scripts/migrate-llm-log-db.js` (читает из старой
   базы порциями, пишет в новую, по завершении старые таблицы можно удалить вручную). Скрипт — часть этапа 1.
7. **Следствие для API**: JOIN между базами невозможен. Лента чата (§5.2) собирается двумя запросами
   (сообщения — из `main`, группы логов — из `logs`) и сливается в JS по времени; стоимость цикла — тоже
   отдельным запросом в `logs`. На объёмах админки (десятки строк на экран) это не проблема.

### 4.5. Ретеншн логов (решение 2026-06-10)

Чистка по возрасту — часть этой задачи. Новый модуль `src/pipeline/log-retention.js`: при старте сервера и
далее раз в сутки (`setInterval` с `unref()`, по образцу таймера в `llm-log.js`) выполняет через `queryLog`
удаление устаревших записей. Полные журналы (`log.llm_request` с payload/response и `log.agent_event`) —
тяжёлые, у них свой срок; узкая `log.llm_usage` хранится дольше или бессрочно — она маленькая и нужна для
статистики затрат. Удаление — порциями (`DELETE … WHERE created_at < now() - interval ... LIMIT` через
подзапрос по PK), чтобы не держать долгие блокировки. Конфиг:

```yaml
llmLog:
  retention:
    llmRequestDays: 90    # полный журнал запросов/ответов
    agentEventDays: 90    # журнал агентных событий
    llmUsageDays: 0       # 0 = хранить бессрочно (узкая таблица для статистики затрат)
```

## 5. Доработки бэкенда: API админки

Все новые маршруты — в `src/server/admin-api.js`, запросы к БД — в новом модуле `src/server/llm-log-data.js`
(не раздувать `src/sandbox/data.js`; он для песочницы и памяти). Только параметризованные запросы.

### 5.1. Поиск пользователей

`GET /api/users/search?q=<строка>` → `[{ id, externalId, displayName, lastMessageAt }]` (limit 10).
Поиск: `ILIKE` по `display_name`, `external_id`, точное совпадение по `id::text`. Для подсказок в шапке.

### 5.2. Лента чата с сервисными бэйджами

`GET /api/users/:id/timeline?before=<iso>&limit=50` → элементы двух типов, отсортированные по времени:

```jsonc
{ "items": [
  { "type": "message", "id": "...", "role": "user|assistant", "content": "...", "createdAt": "...",
    "requestId": "llm_…|null", "telegramMessageId": "…|null", "hasLog": true },
  { "type": "service", "requestId": "llm_…|null", "llmRequestIds": [123], "kind": "history_compress",
    "title": "Сжатие истории", "createdAt": "...", "totalTokens": 3412, "priceUsd": 0.0021 }
], "hasMore": true }
```

Сервисный элемент — группа записей `log.llm_request` пользователя, чей `request_id` не встречается в
`metadata` ни одного user-сообщения (или `request_id IS NULL` — тогда группа из одной записи). Так бэйджи
покрывают пост-обработчики и фоновые вызовы: `history_compress`, `proactive_message`, `event_relevance`,
отвязанные `embedding` и пр. Пагинация — keyset по `createdAt` (скролл вверх → `before=`). Сообщения берутся
из базы `main`, группы логов — из базы `logs` (§4.4); слияние по времени выполняется в JS на сервере.

### 5.3. Журнал цикла и одиночного запроса

- `GET /api/llm-log/cycle/:requestId` → шапка (суммы токенов/стоимости, модели, длительность) + массив строк
  журнала (см. модель строки в §6.3). Сервер двумя запросами к базе `logs` достаёт записи
  `log.llm_request WHERE request_id=$1` и события `log.agent_event WHERE request_id=$1` и **сливает** их в
  одну ленту по времени: события дают строки стадий, «Tool call» / «Tool result» (с точными длительностями и
  ошибками), подключения MCP; LLM-записи дают пары «Запрос → LLM» / «Ответ ← LLM» с payload и response.
  Слияние — чистая функция `buildCycleRows(records, events)` в `src/server/llm-log-data.js`, покрывается
  unit-тестом. Для исторических циклов, записанных до появления `agent_event` (массив событий пуст),
  функция деградирует к синтезу tool-строк из `response.tool_calls` и diff'а массива `messages` между
  соседними запросами — старые логи остаются читаемыми.
- `GET /api/llm-log/request/:llmRequestId` → те же строки для одиночной сервисной записи.
- Полные payload/response уже в составе строк; отдельная догрузка не нужна (объёмы ограничены
  `maxPayloadChars`). Если на практике ответ окажется тяжёлым — добавить `?slim=1` без payload'ов.

### 5.4. AI-анализ контекста запроса

`POST /api/llm-log/analyze` с телом `{ llmRequestId, question, engine: "llm"|"cli", model? }`. Сервер собирает
промпт: системная инструкция («ты анализируешь запрос к LLM и её ответ…») + payload + response + вопрос
администратора. Два движка:

- `engine: "llm"` — штатный вызов через `chat()` с новым `REQUEST_KINDS.LOG_ANALYSIS = 'log_analysis'`
  (добавить в словарь) и моделью из запроса (валидировать по списку из конфига). `request_id` контекста НЕ
  наследовать (анализ не должен подмешиваться в анализируемый цикл) — запускать вне `runWithLlmContext` или с
  собственным `requestId`.
- `engine: "cli"` — запуск CLI-инструмента из конфига (`child_process.spawn`, cwd = корень проекта), промпт —
  через stdin или аргумент `-p`. Ответ стримить клиенту построчно через SSE (`text/event-stream`); таймаут и
  максимальный размер вывода — из конфига. Команда берётся ТОЛЬКО из конфига, от клиента — лишь выбор
  пресета по имени (никакого исполнения произвольных строк из браузера). Движок CLI доступен только при
  `config.admin.host === 'localhost'` — сервер проверяет это при каждом запросе и иначе отвечает 403 (§10.3).

Конфиг (`config/default.yaml`):

```yaml
admin:
  logAnalysis:
    llm:
      models: ['gpt-5.4-mini', 'gpt-5.4']   # разрешённый список для селекта
      defaultModel: 'gpt-5.4-mini'
    cli:
      presets:
        - { name: 'claude-code', command: 'claude', args: ['-p'], timeoutSec: 300 }
      maxOutputChars: 200000
```

### 5.5. Отправка сообщения из админки (зона чата)

`POST /api/users/:id/chat-message { text }` — вызывает существующий конвейер (`handleUserMessage` из
`src/agent.js`) с `channel: 'admin'` (зарегистрировать профиль канала в `src/pipeline/channels.js`, разметка —
как у `html` или без разметки). Ответ — итоговый текст + `requestId`, лента перезапрашивается. Это позволяет
админу «чатиться» и сразу смотреть журнал свежего цикла. Фаза 3; стриминг в админку — не нужен на старте.

## 6. Фронтенд: структура интерфейса

### 6.1. Каркас и навигация

В `App.vue` добавить простое переключение разделов (две вкладки: «Память», «Логи LLM») без vue-router —
по образцу текущей минималистичной архитектуры. Новые компоненты в `web/src/components/llm-log/`:

| Компонент            | Ответственность                                                                    |
|----------------------|------------------------------------------------------------------------------------|
| `LlmLogPage.vue`     | Каркас страницы: шапка с поиском, левая панель чата, правая панель журнала          |
| `UserSearch.vue`     | Инпут с подсказками (debounce 250 мс, `/api/users/search`)                          |
| `ChatPane.vue`       | Лента сообщений + сервисные бэйджи, ленивая подгрузка вверх, поле отправки          |
| `LogPane.vue`        | Шапка журнала (суммы, развернуть/свернуть всё, кнопка AI-анализа) + список строк    |
| `LogRow.vue`         | Одна строка: цвет, иконка, отступ, заголовок, токены/цена, время, раскрытие         |
| `PayloadView.vue`    | Тело запроса: параметры, блок `messages`, блок `tools` — прогрессивное раскрытие    |
| `ContentViewer.vue`  | Содержимое с плавающим селектом формата JSON/MD/HTML/RAW и авто-детектом            |
| `AnalyzeDialog.vue`  | Модал AI-анализа: движок, модель/пресет CLI, вопрос, стрим результата               |

**UI-кит: PrimeVue v4 с темой Aura** — УЖЕ ПОДКЛЮЧЁН (проверено 2026-06-10): в `web/package.json` есть
`primevue` 4.5.5, `@primeuix/themes` (пресет Aura) и `primeicons`; `web/src/main.js` ставит Aura в
styled-режиме с принудительно отключённой тёмной темой (`darkModeSelector` указывает на несуществующий
класс); `App.vue` уже использует `DataTable`, `Column`, `MultiSelect`, `Button`. Остаётся (по желанию, при
работе над страницей логов): обернуть Aura в `definePreset` из `@primeuix/themes` и переопределить токены под
палитру прототипа — `primary` → акцентный оранжевый `#e8a33d`, радиусы и плотность компактнее дефолта.
Документация по темингу: https://primevue.org/theming/styled/.

Разделение ответственности между библиотекой и кастомной вёрсткой:

- **Из PrimeVue берём «обвязку»**: `AutoComplete` (поиск пользователей с подсказками), `Dialog` (модал
  крупного содержимого и диалог AI-анализа), `Splitter` (разделитель панелей чата и журнала), `Select` и
  `RadioButton` (формат содержимого, движок анализа, модель), `Tabs` (вкладки «Память» / «Логи LLM» в
  `App.vue`), `VirtualScroller` (журнал из сотен строк), `Toast` (ошибки API), `Button`.
- **Кастомными остаются** строки журнала (`LogRow` — пастельные цвета категорий, плотность, отступы-иерархия),
  `PayloadView` и `ContentViewer` (прогрессивное раскрытие, плавающий селект формата), пузыри и бэйджи в
  `ChatPane`. Не натягивать библиотечные `Accordion`/`Tree` на лог — своя разметка проще и точнее прототипа.

Прочие зависимости фронтенда: `marked` (рендер MD) и `dompurify` (санитизация перед `v-html` для режимов
HTML и MD — обязательно, содержимое логов недоверенное). Сверх этого ничего не тянуть.

### 6.2. Панель чата (слева)

- Пузыри как в Telegram: пользователь справа (жёлтый из палитры `#ffffdc`), бот слева (белый/зелёный
  `#ebffe8`), у каждого время; разделители по дням.
- У каждого user-сообщения — маленькая кнопка «журнал» (иконка списка); клик подсвечивает сообщение и грузит
  цикл в правую панель (`/api/llm-log/cycle/:requestId`; если `requestId` нет — fallback из §4.2).
- Между пузырями — компактные бэйджики сервисных запросов (узкая серая капсула: иконка ⚙, kind по-русски,
  токены, цена, время). Клик — журнал этой группы в правой панели.
- Скролл вверх → подгрузка предыдущей страницы `timeline` с сохранением позиции скролла.
- Внизу поле отправки сообщения (фаза 3, §5.5).

### 6.3. Панель журнала (справа)

Модель строки, которую отдаёт сервер (`buildCycleRows`):

```jsonc
{ "n": 7, "rowType": "llm_request", "title": "Основной ответ → LLM (итерация 1)", "indent": 1,
  "groupId": "main_1", "isGroupHeader": false, "createdAt": "...", "model": "gpt-5.4-mini",
  "tokens": 9938, "priceUsd": 0.0203, "durationMs": 6400, "status": "ok",
  "body": { "kind": "payload", "payload": {...}, "response": null } }
```

- **Группы-стадии**: строки группируются заголовками «Классификация интента», «Основной ответ (итерация N)»,
  «Пост-обработка: выгрузка фактов» и т. д. Заголовок группы — раскрываемая строка уровня 0; клик по стрелке
  сворачивает всю группу (отвечает на замечание «не хватает иерархичности в заголовках»).
- **Шапка журнала**: «Цикл <requestId>» или название сервисного запроса; сумма токенов и цены по всем строкам;
  использованные модели; общая длительность; кнопки «развернуть всё», «свернуть всё», «Спросить ИИ».
- В заголовке каждой строки: токены, цена, модель (серым), время, длительность. Ошибочные строки
  (`status='error'`) — розовый фон `#faabda` и текст ошибки в раскрытии.
- Состояние раскрытия — локальное (`expanded` на строке), как в референсе.

### 6.4. Прогрессивное раскрытие payload (ключевое требование)

`PayloadView.vue` показывает три зоны, каждая со своим уровнем раскрытия:

1. **Параметры**: компактная строка чипов — `model`, `temperature`, `max_tokens`, `response_format` и прочие
   скалярные поля тела запроса. Раскрытие не требуется.
2. **`messages` (N сообщений)**: свёрнуто — по одной строке на элемент: чип роли (system/user/assistant/tool —
   свои цвета) + первые ~120 символов содержимого + счётчик длины. Клик по элементу: если содержимое
   ≤ ~2000 символов — раскрыть тут же (инлайн `ContentViewer`); если больше — модальное окно с тем же
   `ContentViewer` на весь экран. Для сообщений с `tool_calls` — показать имя инструмента и аргументы
   (pretty-print). Кнопки «раскрыть все сообщения» / «свернуть все» над списком.
3. **`tools` (M инструментов)**: свёрнуто — строка на инструмент: имя + первые слова описания. Первый клик —
   полное описание. Второй уровень (отдельная кнопка «параметры») — JSON Schema параметров pretty-print.

`ContentViewer.vue`: плавающий селект формата в правом верхнем углу блока (`JSON | MD | HTML | RAW`).
Стартовое значение — авто-детект: содержимое парсится как JSON (после trim начинается с `{`/`[` и
`JSON.parse` успешен) → JSON pretty-print с подсветкой; есть HTML-теги → HTML (рендер через DOMPurify);
есть маркеры разметки (`#`, `**`, ```` ``` ````, списки) → MD (marked + DOMPurify); иначе RAW (`<pre>`).
Переключение доступно всегда, RAW есть для любого формата. Кнопка «копировать» в том же углу.

### 6.5. Диалог AI-анализа

Открывается кнопкой «Спросить ИИ» в шапке журнала (контекст — выбранная строка с payload'ом, по умолчанию —
последний `main_agent_answer` цикла). Поля: движок (радио: «Штатная LLM» / «CLI-инструмент»), при LLM — селект
модели (список из `/api/config/log-analysis`, читающего конфиг §5.4), при CLI — селект пресета; textarea
вопроса с заготовкой «Посмотри на запрос и ответ модели. Почему она ответила именно так? Что посоветуешь
изменить в промпте или контексте?». Результат стримится в блок ниже (SSE), рендер — MD через `ContentViewer`.

## 7. Маппинг видов на визуальный ряд

Палитра взята из референса multi-bot (там она доказала читаемость). Иконки — простые Unicode/SVG, без
иконочного шрифта Quasar. Отступ: 0 — стадии и события пользователя, 1 (20px) — запрос/ответ LLM, 2 (40px) —
вложенные tool-вызовы и эмбеддинги.

| rowType / kind                  | Заголовок (рус.)                  | Фон       | Отступ |
|---------------------------------|-----------------------------------|-----------|--------|
| `user_say`                      | Сообщение пользователя            | `#ffffdc` | 0      |
| `intent_classify`               | Классификация интента             | `#fff5e3` | 0      |
| stage header (`main_agent_answer`) | Основной ответ (итерация N)    | `#d6cffd` | 0      |
| `llm_request` («→ LLM»)         | Запрос → LLM                      | `#e3f2fd` | 1      |
| `llm_response` («← LLM»)        | Ответ ← LLM                       | `#e8f5e8` | 1      |
| `tool_call`                     | Вызов инструмента: <имя>          | `#d2f5e8` | 2      |
| `tool_result`                   | Результат инструмента: <имя>      | `#eafbda` | 2      |
| `embedding`                     | Запрос эмбеддинга                 | `#f5edff` | 2      |
| `fact_extract` / `topic_extract`| Пост-обработка: факты / темы      | `#ffe7e3` | 0      |
| `history_compress`              | Сжатие истории                    | `#ffebd9` | 0      |
| `proactive_message` / `event_relevance` | Проактивность             | `#c5ebf1` | 0      |
| `stt` / `tts` / `voice_summary` | Голос: распознавание / синтез     | `#f0e6af` | 0      |
| `answer_user`                   | Ответ пользователю                | `#ebffe8` | 0      |
| ошибка (`status='error'`)       | (любой) + текст ошибки            | `#faabda` | как у строки |
| `untyped` / прочее              | Без типа (нарушение контракта)    | `#e5e5e5` | 0      |

Бэйджи сервисных запросов в чате используют тот же цвет фона, что их kind в журнале, — визуальная связка.

## 8. Этапы реализации

1. **Данные** (§4.1–§4.4): отдельная база логов (подключение `logs`, `queryLog`, второй проход `migrate.js`,
   каталог `migrations-log/`, перенос DDL `log.*`, скрипт переноса исторических данных); колонки
   `response`/`response_truncated` и их запись во всех функциях `src/llm.js` и голосовых модулях; журнал
   `log.agent_event` с модулем `agent-event-log.js` и вызовами в `agent.js` и `mcp/client.js`; `request_id`
   в `metadata` сообщений. Unit-тесты `llm-log` обновить (там есть подмена `dbQuery`).
2. **API** (§5.1–5.3): `users/search`, `timeline` (слияние двух баз), `cycle`, `request`; чистая функция
   `buildCycleRows(records, events)` + unit-тест на слияние (фикстура: классификация → основной ответ с
   tool-вызовом → итерация 2 → выгрузка фактов) и на деградацию к синтезу при пустом массиве событий.
3. **UI-каркас** (§6.1–6.3): вкладки, поиск, панель чата с бэйджами и ленивой подгрузкой, панель журнала со
   строками, цветами, группами и раскрытием (PrimeVue уже подключён; опционально — `definePreset` с нашими
   токенами). Сверяться с `prototype.html`.
4. **Прогрессивное раскрытие** (§6.4): `PayloadView`, `ContentViewer` с авто-детектом и селектом формата,
   модал для крупного содержимого, «раскрыть/свернуть все».
5. **AI-анализ** (§5.4, §6.5): endpoint + SSE, конфиг, диалог. CLI-пресет проверить на Windows (spawn
   `claude.cmd` / `cmd /c`).
6. **Чат из админки** (§5.5), ретеншн (§4.5) и полировка: fallback для старых сообщений, пустые состояния,
   обработка `payload_truncated` (плашка «обрезано»), индикатор загрузки.

Каждый этап завершается работающим состоянием (без заглушек), прогоном lint и существующих тестов.

## 9. Список затрагиваемых файлов

- `migrations/001_init.sql` — УДАЛИТЬ блок `log.*` (строки 602-682, переезжает в базу логов).
- `migrations-log/001_log_init.sql` — НОВЫЙ: схема `log`, таблицы `llm_request` (с `response`,
  `response_truncated`), `llm_usage`, `agent_event`, функция и триггер `llm_request_to_usage`.
- `config/default.yaml`, `config/local.example.yaml` — подключение `db.postgres.dbs.logs`.
- `src/db.js` — `queryLog()`, `getLogPool()` (connectionId `logs`).
- `src/migrate.js` — создание базы логов и применение `migrations-log/`.
- `scripts/migrate-llm-log-db.js` — НОВЫЙ: одноразовый перенос исторических `log.*` из `mem_bot`.
- `src/pipeline/llm-log.js` — `COLUMNS`, `buildRecord`, обрезка response, kind `log_analysis`, запись через
  `queryLog`; общий буферный помощник для обоих журналов.
- `src/pipeline/agent-event-log.js` — НОВЫЙ: `logAgentEvent()` (§4.3).
- `src/pipeline/log-retention.js` — НОВЫЙ: суточная чистка логов по возрасту (§4.5); запуск из
  `src/server/index.js`.
- `src/pipeline/llm-usage-stats.js` — чтение `log.llm_usage` через `queryLog`.
- `src/mcp/client.js` — события `mcp.connected` / `mcp.failed` в журнал.
- `src/llm.js`, `src/voice/transcribe.js`, `src/voice/tts.js` — передача response в `safeLog`.
- `src/agent.js` — `metadata.request_id` при `saveMessage` (~626, ~691, ~736); вызовы `logAgentEvent` рядом
  с `emit()` и в цикле инструментов (аргументы и результат — в журнал, в `emit()` их по-прежнему нет).
- `src/pipeline/channels.js` — профиль канала `admin` (этап 6).
- `src/server/llm-log-data.js` — НОВЫЙ: запросы + `buildCycleRows`.
- `src/server/admin-api.js` — новые маршруты.
- `config/default.yaml` (+ `local.example.yaml`) — секция `admin.logAnalysis`.
- `web/src/App.vue`, `web/src/api.js`, `web/src/styles.css` — вкладки, методы API, базовые стили.
- `web/src/components/llm-log/*.vue` — НОВЫЕ компоненты из §6.1.
- `web/package.json` — добавить только `marked` и `dompurify` (`primevue`, `@primeuix/themes`, `primeicons`
  уже установлены).
- `web/src/main.js` — PrimeVue с Aura уже подключён; опционально обернуть в `definePreset` (токены под
  палитру прототипа: `primary` → `#e8a33d`, компактные радиусы).
- `tests/…` — unit на `buildCycleRows`, обновление тестов `llm-log`.

## 10. Открытые вопросы (решить по ходу, дефолты указаны)

1. РЕШЕНО (2026-06-10): при ошибке посреди стрима писать уже собранную часть ответа в `response` со
   `status='error'` — частичный ответ ценен для диагностики, терять его нельзя.
2. РЕШЕНО (2026-06-10): журнал `log.agent_event` обязателен (§4.3) — нужна исчерпывающая картина цикла,
   включая тайминги инструментов и ошибки между итерациями. Синтез из payload/response остаётся только как
   fallback для исторических данных.
3. РЕШЕНО (2026-06-10): AI-анализ через CLI доступен только при `config.admin.host === 'localhost'` —
   проверка на сервере при обработке `POST /api/llm-log/analyze` с `engine: "cli"` (при другом хосте — 403 с
   пояснением); LLM-движок доступен всегда.
4. РЕШЕНО (2026-06-10): чистка по возрасту входит в задачу — см. §4.5 (`log-retention.js`, суточный
   интервал, конфиг `llmLog.retention`, узкая `llm_usage` бессрочно). Бэкап отдельной базы логов — на уровне
   эксплуатации, вне плана.
