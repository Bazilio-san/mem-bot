# План-промпт: логирование LLM-запросов, токенов и стоимости в базу данных

Это исчерпывающее техническое задание для реализации в проекте `mem-bot`. Документ написан так, чтобы по нему
можно было выполнить работу за один заход без дополнительных уточнений: он описывает цель, модель данных, точные
правки в коде, порядок реализации и тесты. Раздел «Открытые решения» в конце фиксирует значения по умолчанию,
которые приняты, чтобы не блокировать реализацию.

> **Окружение проекта.** Конфигурирование `mem-bot` построено на node-config: значения по умолчанию лежат в
> `config/default.yaml`, переменные окружения отображаются через `config/custom-environment-variables.yaml`, объект
> `config` — это снимок дерева YAML (`nodeConfig.util.toObject()`), булевы флаги хранятся как `true`/`false`. Доступ
> к базе данных идёт через пакет `af-db-ts`; тонкая обёртка `query(text, params)` из `src/db.js` направляет запросы в
> рабочее подключение (`connectionId: 'main'`). Прикладной код читает параметры только через `config`, а не из
> `process.env`.

## 1. Цель и общие принципы

Нужно сохранять в базу данных сведения о **каждом** обращении к языковой модели (LLM) и к смежным сервисам
(распознавание речи, синтез речи, эмбеддинги). Логирование преследует две независимые задачи:

1. **Полный журнал запросов для разбора и будущего интерфейса.** Для текстовых запросов сохраняется весь объект,
   отправленный модели (системные и пользовательские сообщения, определения инструментов, параметры). Для бинарных
   данных (звук, видео, присланные файлы) сохраняются только сведения о файле — тип, размер, длительность, имя —
   но **никогда не сами байты** и не их содержимое.
2. **Быстрый подсчёт затрат.** Стоимость и количество токенов каждого обращения попадают в отдельную узкую таблицу,
   оптимизированную под быстрые агрегаты (суммарная стоимость за период, по пользователю, по типу запроса, по модели).

Ключевые принципы реализации:

- **Асинхронность и неблокирование.** Каждый запрос «выплёвывает» сведения для лога, не задерживая ответ пользователю.
  Запись в БД идёт через буфер с пакетной выгрузкой в фоне. Ошибка логирования **никогда** не должна ломать основной
  ответ агента — весь код логирования обёрнут в защиту от исключений.
- **Разделение по типам запросов.** У каждого обращения есть машинно-различимый тип (`request_kind`), чтобы в будущем
  интерфейсе разные виды запросов отображались по-разному (как на референсных скриншотах: «Intent detection»,
  «Tool call», «Request for embedding», «Answer to user» и так далее).
- **Единая точка перехвата.** Почти все обращения уже проходят через `src/llm.js`. Логирование встраивается туда,
  а не размазывается по два десятка мест вызова. Голосовые модули (`src/voice/transcribe.js`, `src/voice/tts.js`)
  обращаются к сети напрямую через `fetch`, поэтому в них логирование добавляется отдельными точечными правками.
- **Декуплинг от прикладной схемы.** Журнальные таблицы живут в отдельной схеме `log`, не имеют внешних ключей
  (foreign keys) на прикладные таблицы `mem.*` и не участвуют в каскадах. Это делает логирование устойчивым: удаление
  пользователя или разговора не должно зависеть от журнала и наоборот.

## 2. Каталог точек вызова LLM и их типы

Ниже — все существующие места обращения к моделям и закреплённый за каждым тип запроса (`request_kind`). Этот перечень
задаёт исчерпывающий словарь типов. Новый тип добавляется централизованно (см. раздел 6).

| `request_kind`       | Где вызывается                                        | Функция        | Конечная точка (endpoint)   | Бинарный |
|----------------------|------------------------------------------------------|----------------|-----------------------------|----------|
| `agent_answer`       | `src/agent.js` (основной ответ агента)               | `chat`/`chatStream` | `chat.completions`     | нет      |
| `intent_classify`    | `src/pipeline/classify.js`                           | `chatJSON`     | `chat.completions`          | нет      |
| `fact_extract`       | `src/pipeline/extract.js` (извлечение фактов)        | `chatJSON`     | `chat.completions`          | нет      |
| `topic_extract`      | `src/pipeline/extract.js` (извлечение тем)           | `chatJSON`     | `chat.completions`          | нет      |
| `event_relevance`    | `src/pipeline/events.js` (оценка релевантности)      | `chatJSON`     | `chat.completions`          | нет      |
| `proactive_message`  | `src/pipeline/events.js`, `proactiveMessage.js`      | `chat`         | `chat.completions`          | нет      |
| `history_compress`   | `src/pipeline/history-compress.js`                   | `chatJSON`     | `chat.completions`          | нет      |
| `skill_authoring`    | `src/pipeline/skills/author.js`                      | `chatJSON`     | `chat.completions`          | нет      |
| `voice_summary`      | `src/voice/tts.js` (резюме длинного ответа)          | `chat`         | `chat.completions`          | нет      |
| `embedding`          | `retrieve.js`, `schema/validate.js`, `admin.js`, `global-memory.js`, `memory-dedupe.js`, `agent-tools/memory/memory-search.js` | `embed` | `embeddings` | нет |
| `stt`                | `src/voice/transcribe.js` (речь в текст)             | `fetch`        | `audio.transcriptions`      | **да**   |
| `tts`                | `src/voice/tts.js` (синтез речи)                     | `fetch`        | `audio.speech`              | **да** (выход) |

Тип запроса не может быть надёжно выведен внутри `src/llm.js` (туда приходят только сообщения), поэтому он передаётся
снаружи через контекст корреляции (раздел 5). Если тип не задан, по конечной точке выбирается значение по умолчанию:
`chat.completions` → `agent_answer`, `embeddings` → `embedding`.

## 3. Модель данных

Создаётся новая схема `log` и две таблицы. Узкая таблица `log.llm_usage` заполняется автоматически триггером БД при
вставке в `log.llm_request` — благодаря этому прикладной код делает **один** insert, а согласованность двух таблиц
гарантируется на стороне базы.

### 3.1. Таблица `log.llm_request` — полный журнал

Одна строка на каждое обращение. Хранит полный объект запроса (для текста) либо метаданные файла (для бинарных данных).

| Колонка             | Тип                       | Назначение                                                                 |
|---------------------|---------------------------|----------------------------------------------------------------------------|
| `llm_request_id`    | `bigserial` PK            | Уникальный идентификатор записи                                            |
| `created_at`        | `timestamptz` DEFAULT now | Время записи                                                               |
| `request_id`        | `text`                    | Идентификатор хода диалога (turn). Группирует все запросы одного ответа.   |
| `request_kind`      | `text`                    | Тип запроса из словаря раздела 2                                           |
| `endpoint`          | `text`                    | `chat.completions` \| `embeddings` \| `audio.transcriptions` \| `audio.speech` |
| `provider`          | `text`                    | `openai` \| `groq` \| `proxy` (выводится из base URL)                       |
| `model`             | `text`                    | Имя модели как отправлено провайдеру                                       |
| `model_priced`      | `text`                    | Нормализованное имя, по которому рассчитана цена (или NULL, если не нашли)  |
| `user_id`           | `text`                    | Идентификатор пользователя (строкой, без внешнего ключа). Может быть NULL.  |
| `conversation_id`   | `text`                    | Идентификатор разговора. Может быть NULL.                                  |
| `domain_key`        | `text`                    | Доменный ключ / активный навык. Может быть NULL.                           |
| `channel`           | `text`                    | Канал доставки (`telegram` \| `plain` \| `html` …). Может быть NULL.        |
| `is_binary`         | `boolean` DEFAULT false   | Признак бинарного обращения                                               |
| `payload`           | `jsonb`                   | Для текста — весь объект запроса. Для бинарного — текстовая часть, если есть. |
| `binary_meta`       | `jsonb`                   | Сведения о файле: `kind`, `mimeType`, `fileName`, `fileSize`, `durationSeconds`, `byteLength`. NULL для текстовых. |
| `payload_truncated` | `boolean` DEFAULT false   | Признак, что `payload` был усечён по предельному размеру                   |
| `prompt_tokens`     | `integer`                 | Входящие токены (из ответа провайдера). NULL, если провайдер не вернул.    |
| `completion_tokens` | `integer`                 | Исходящие токены. NULL для эмбеддингов и часто для STT/TTS.                |
| `total_tokens`      | `integer`                 | Сумма токенов                                                             |
| `price_usd`         | `numeric(12,6)`           | Рассчитанная стоимость в долларах США. NULL, если цена модели неизвестна.  |
| `duration_ms`       | `integer`                 | Длительность запроса в миллисекундах                                       |
| `status`            | `text` DEFAULT `'ok'`     | `ok` \| `error`                                                            |
| `error`             | `text`                    | Текст ошибки, если запрос завершился неудачей                             |
| `is_test`           | `boolean` DEFAULT false   | Признак записи, сделанной прогоном тестов (для последующей подчистки)      |

Индексы: по `created_at`, по `request_id`, по `request_kind`, по `(user_id, created_at)`, по `model`. Частичный
индекс `WHERE is_test` ускоряет подчистку тестовых записей.

**Правила формирования `payload`:**

- Для `chat.completions` сохраняется объект `{ model, messages, tools, tool_choice, response_format, stream }`
  ровно в том виде, в каком он уходит провайдеру. Содержимое сообщений (системные инструкции, память, реплика
  пользователя, результаты инструментов) — это и есть «весь объект, отправляемый LLM».
- Для `embeddings` сохраняется `{ model, input }`. Если `input` длиннее предельного размера, он усекается
  (см. усечение ниже).
- Для `audio.transcriptions` (STT) `payload` содержит только нетекстовые параметры запроса (`model`, `language`,
  `response_format`), а само вложение описывается в `binary_meta`. Байты файла **не сохраняются**.
- Для `audio.speech` (TTS) вход — это текст, он сохраняется в `payload` (`{ model, voice, format, input }`),
  а синтезированное аудио на выходе описывается в `binary_meta` (`{ format, byteLength }`).
- **Усечение размера.** Перед записью `payload` сериализуется в строку; если её длина превышает предел
  (по умолчанию 100 000 символов), длинные строковые значения внутри (тексты сообщений, `input` эмбеддинга)
  обрезаются до разумной длины, а флаг `payload_truncated` ставится в `true`. Это защищает журнал от разрастания
  на больших историях и батч-эмбеддингах.

### 3.2. Таблица `log.llm_usage` — узкий журнал для подсчёта затрат

Заполняется триггером. Содержит только то, что нужно для быстрых агрегатов.

| Колонка             | Тип               | Назначение                                  |
|---------------------|-------------------|---------------------------------------------|
| `llm_usage_id`      | `bigserial` PK    | Уникальный идентификатор                     |
| `created_at`        | `timestamptz`     | Копируется из запроса                        |
| `llm_request_id`    | `bigint`          | Ссылка на строку `log.llm_request` (без FK)  |
| `request_kind`      | `text`            | Тип запроса                                  |
| `model`             | `text`            | Нормализованное имя модели (`model_priced`)  |
| `user_id`           | `text`            | Пользователь                                 |
| `prompt_tokens`     | `integer`         | Входящие токены                              |
| `completion_tokens` | `integer`         | Исходящие токены                             |
| `total_tokens`      | `integer`         | Сумма токенов                                |
| `price_usd`         | `numeric(12,6)`   | Стоимость                                    |
| `duration_ms`       | `integer`         | Длительность                                 |
| `is_test`           | `boolean` DEFAULT false | Копируется из запроса; помечает тестовые записи |

Индексы: по `created_at`, по `(user_id, created_at)`, по `model`, по `request_kind`. Частичный индекс `WHERE is_test`
ускоряет подчистку тестовых записей.

Триггер `AFTER INSERT` на `log.llm_request` вставляет строку в `log.llm_usage` только тогда, когда есть что считать,
то есть когда `total_tokens` или `price_usd` не равны NULL. Запросы без полезной нагрузки для биллинга (например,
неудавшийся вызов без токенов) в узкую таблицу не попадают и не засоряют агрегаты.

### 3.3. Миграция `migrations/017_llm_logging.sql`

**Критически важно:** файл `src/migrate.js` применяет **все** миграции при каждом запуске, прогоняя их через рабочее
подключение `main`. Значит, схема `log` и обе таблицы создаются в той же базе памяти, куда пишет эмиттер своей
`query()` (тоже `connectionId: 'main'`), — отдельная база не нужна. Из-за повторного применения миграция должна быть
полностью идемпотентной. Запрещено использовать `DROP TABLE` (как в референсных DDL) — иначе журнал будет стираться при
каждом старте бота. Используются `CREATE SCHEMA IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT
EXISTS`, `CREATE OR REPLACE FUNCTION`, а пересоздание триггера выполняется через `DROP TRIGGER IF EXISTS` с последующим
`CREATE TRIGGER` (это безопасно — пересоздаётся только триггер, данные не трогаются).

```sql
CREATE SCHEMA IF NOT EXISTS log;

CREATE TABLE IF NOT EXISTS log.llm_request (
  llm_request_id    bigserial PRIMARY KEY,
  created_at        timestamptz NOT NULL DEFAULT now(),
  request_id        text,
  request_kind      text,
  endpoint          text,
  provider          text,
  model             text,
  model_priced      text,
  user_id           text,
  conversation_id   text,
  domain_key        text,
  channel           text,
  is_binary         boolean NOT NULL DEFAULT false,
  payload           jsonb,
  binary_meta       jsonb,
  payload_truncated boolean NOT NULL DEFAULT false,
  prompt_tokens     integer,
  completion_tokens integer,
  total_tokens      integer,
  price_usd         numeric(12,6),
  duration_ms       integer,
  status            text NOT NULL DEFAULT 'ok',
  error             text,
  is_test           boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS llm_request_created_at_ix  ON log.llm_request (created_at);
CREATE INDEX IF NOT EXISTS llm_request_request_id_ix  ON log.llm_request (request_id);
CREATE INDEX IF NOT EXISTS llm_request_kind_ix        ON log.llm_request (request_kind);
CREATE INDEX IF NOT EXISTS llm_request_user_ix        ON log.llm_request (user_id, created_at);
CREATE INDEX IF NOT EXISTS llm_request_model_ix       ON log.llm_request (model);
CREATE INDEX IF NOT EXISTS llm_request_is_test_ix     ON log.llm_request (is_test) WHERE is_test;

CREATE TABLE IF NOT EXISTS log.llm_usage (
  llm_usage_id      bigserial PRIMARY KEY,
  created_at        timestamptz NOT NULL DEFAULT now(),
  llm_request_id    bigint,
  request_kind      text,
  model             text,
  user_id           text,
  prompt_tokens     integer,
  completion_tokens integer,
  total_tokens      integer,
  price_usd         numeric(12,6),
  duration_ms       integer,
  is_test           boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS llm_usage_created_at_ix ON log.llm_usage (created_at);
CREATE INDEX IF NOT EXISTS llm_usage_user_ix       ON log.llm_usage (user_id, created_at);
CREATE INDEX IF NOT EXISTS llm_usage_model_ix      ON log.llm_usage (model);
CREATE INDEX IF NOT EXISTS llm_usage_kind_ix       ON log.llm_usage (request_kind);
CREATE INDEX IF NOT EXISTS llm_usage_is_test_ix    ON log.llm_usage (is_test) WHERE is_test;

CREATE OR REPLACE FUNCTION log.llm_request_to_usage() RETURNS trigger AS $$
BEGIN
  IF NEW.total_tokens IS NOT NULL OR NEW.price_usd IS NOT NULL THEN
    INSERT INTO log.llm_usage (
      created_at, llm_request_id, request_kind, model, user_id,
      prompt_tokens, completion_tokens, total_tokens, price_usd, duration_ms, is_test
    ) VALUES (
      NEW.created_at, NEW.llm_request_id, NEW.request_kind, NEW.model_priced, NEW.user_id,
      NEW.prompt_tokens, NEW.completion_tokens, NEW.total_tokens, NEW.price_usd, NEW.duration_ms, NEW.is_test
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS llm_request_to_usage_trg ON log.llm_request;
CREATE TRIGGER llm_request_to_usage_trg
  AFTER INSERT ON log.llm_request
  FOR EACH ROW EXECUTE FUNCTION log.llm_request_to_usage();

COMMENT ON TABLE log.llm_request IS 'Полный журнал обращений к LLM и смежным сервисам. Текст — целиком, бинарь — только метаданные файла';
COMMENT ON TABLE log.llm_usage   IS 'Узкий журнал токенов и стоимости для быстрого подсчёта затрат на LLM';
```

## 4. Расчёт стоимости — модуль `src/pipeline/llm-pricing.js`

Цены берутся из `src/data/model-list.js` (`openAiModelMeta`). В этой структуре поля `inp`/`out` — цена за **один миллион**
входящих/исходящих токенов в долларах, а `inpB`/`outB` — половинная цена для кэшированного/батч-режима. Поля `kT`
(размер контекста в тысячах токенов) и `mot` (предел вывода) к расчёту цены отношения не имеют.

Формула стоимости одного обращения:

```
price_usd = prompt_tokens / 1e6 * inp + completion_tokens / 1e6 * out
```

Для эмбеддингов есть только входящие токены: `price_usd = total_tokens / 1e6 * inp`.

Модуль экспортирует:

- `normalizeModelName(model)` — приводит имя к ключу из `openAiModelMeta`. Шаги: убрать ведущий префикс провайдера
  (`openai/gpt-4o-mini` → `gpt-4o-mini`); если точного ключа нет, попробовать отбросить хвостовой штамп даты
  (`gpt-4o-2024-08-06` → `gpt-4o`). Вернуть найденный ключ или `null`.
- `priceUsd({ model, promptTokens = 0, completionTokens = 0, cachedTokens = 0 })` — возвращает
  `{ priceUsd, modelPriced }`. Если модель не найдена в прайс-листе, возвращает `{ priceUsd: null, modelPriced: null }`
  и логирует предупреждение **один раз на каждое неизвестное имя модели** (через `Set` уже предупреждённых), чтобы
  не засорять консоль. Кэшированные входящие токены (если провайдер сообщает `prompt_tokens_details.cached_tokens`)
  тарифицируются по `inpB` — это опциональное уточнение, при отсутствии данных считаем всё по `inp`.

**Прайс-лист.** Настроенные по умолчанию модели — `gpt-5.4-mini` и `gpt-5.4-nano` — присутствуют в `openAiModelMeta`,
поэтому стоимость основного ответа и классификации рассчитывается корректно. Общее правило: если встретится модель,
которой нет в прайс-листе, токены логируются всегда, а `price_usd` пишется как `NULL` (пробел в ценах виден через
строки с `price_usd IS NULL`, данные при этом не теряются). Поэтому `normalizeModelName` мягко деградирует на
неизвестном имени, а не бросает исключение.

## 5. Контекст корреляции через AsyncLocalStorage

Чтобы внутри `src/llm.js` знать, к какому пользователю, разговору, домену и типу запроса относится обращение, не
протаскивая параметры через каждую функцию, используется `AsyncLocalStorage` из стандартного модуля Node
`node:async_hooks`.

Новый модуль `src/pipeline/llm-context.js`:

- `llmContext` — экземпляр `AsyncLocalStorage`.
- `runWithLlmContext(meta, fn)` — выполняет `fn` внутри хранилища с метаданными
  `{ requestId, userId, conversationId, domainKey, channel, kind }`.
- `getLlmContext()` — возвращает текущие метаданные или пустой объект.
- `withKind(kind)` — вспомогательная обёртка, которая дополняет текущий контекст конкретным типом запроса для одного
  вложенного вызова (например, классификация и извлечение фактов выполняются внутри хода диалога, но это разные типы).

Где устанавливается контекст:

- В `src/agent.js::handleMessage` — обернуть тело `runAgent()` в `runWithLlmContext`. Идентификатор хода
  `requestId` генерируется в начале как `llm_${Date.now()}_${случайный суффикс}` (формат совпадает с тем, что виден на
  референсных скриншотах: `Request ID: llm_…`). `userId`, `conversationId`, `domainKey`, `channel` подставляются по мере
  появления (можно положить мутируемый объект в хранилище и дополнять его, как уже сделано с `eventMeta`).
- В `src/pipeline/scheduler.js` и проактивных контурах (`events.js`, `proactiveMessage.js`) — оборачивать единицу
  работы своим контекстом, чтобы фоновые обращения тоже были атрибутированы (с `userId` адресата, если он известен).
- Точечно задавать `kind` на конкретных вызовах: классификация (`intent_classify`), извлечение фактов/тем
  (`fact_extract`/`topic_extract`), сжатие истории (`history_compress`), резюме для голоса (`voice_summary`),
  авторинг навыков (`skill_authoring`), оценка релевантности (`event_relevance`), проактивное сообщение
  (`proactive_message`). Это делается либо через `withKind`, либо передачей необязательного параметра `kind` в
  функции `src/llm.js` (см. раздел 6) — параметр имеет приоритет над контекстом.

Для путей вне какого-либо хода диалога (например, разовые эмбеддинги при админском наполнении базы) контекст просто
пуст: запрос всё равно логируется, но `user_id`/`conversation_id` будут `NULL`. Это допустимо.

## 6. Эмиттер логов — модуль `src/pipeline/llm-log.js`

Единая точка записи. Реализует асинхронную пакетную выгрузку, устойчивую к ошибкам.

- Внутренний буфер — массив подготовленных записей.
- `logLlmRequest(record)` — кладёт запись в буфер и немедленно возвращает управление (ничего не ждёт). Никогда не
  бросает исключений: любая ошибка подготовки записи гасится внутри.
- Фоновая выгрузка: таймер раз в ~1000 мс (как в референсе) забирает из буфера пакет (до 200 записей) и одним
  многострочным `INSERT` пишет его в `log.llm_request` через `query(text, params)` из `src/db.js` (эта обёртка
  направляет запрос в рабочее подключение `af-db-ts`, `connectionId: 'main'`). Дополнительно выгрузка запускается
  досрочно, если буфер превысил порог (например, 50 записей).
- Ошибка вставки логируется в консоль и **не** роняет процесс; записи из неудавшегося пакета можно вернуть в буфер
  с ограничением на число повторов, чтобы при недоступной БД буфер не рос бесконечно (при переполнении — отбрасывать
  самые старые записи с предупреждением, как описано в правиле «никаких тихих усечений»).
- `flushLlmLog()` — принудительная выгрузка остатка; вызывается при штатной остановке, чтобы не потерять хвост
  журнала. У точек входа уже есть функция `shutdown()`, которая вызывает `closePool()` из `src/db.js` (а тот —
  `closeAllDb()` пакета `af-db-ts`); в `src/telegram/bot.js` и `src/sandbox/server.js` она навешена на обработчики
  `SIGINT`/`SIGTERM`, в `src/cli.js` и `src/pipeline/skills/cli.js` вызывается по завершении. Вставить `await
  flushLlmLog()` в каждый такой `shutdown()` **перед** `closePool()`, чтобы буфер слился в БД до закрытия пулов.
- Словарь типов запросов (`REQUEST_KINDS`) и значения по умолчанию по конечной точке объявляются здесь же —
  это единственное место, куда добавляется новый тип.
- `deleteTestLlmLogs()` — подчистка тестовых записей: сначала `DELETE FROM log.llm_usage WHERE is_test`, затем
  `DELETE FROM log.llm_request WHERE is_test`. Перед удалением вызывает `flushLlmLog()`, чтобы в буфере не осталось
  невыгруженных тестовых записей. Вызывается из обвязки тестов после прогона (раздел 11).

Сборка одной записи (`buildRecord`) делает следующее: берёт метаданные из `getLlmContext()`, накладывает явный `kind`
и `endpoint`, считает `duration_ms` (замер времени делается в `src/llm.js` вокруг сетевого вызова), извлекает токены из
ответа провайдера, вызывает `priceUsd(...)` из модуля цен, формирует `payload`/`binary_meta` с усечением, проставляет
`is_test` (истина, если процесс запущен в тестовом окружении — `process.env.NODE_ENV === 'test'`; обращение к
`NODE_ENV` допустимо, это служебная переменная node-config, а не прикладной параметр) и собирает итоговый объект под
колонки `log.llm_request`.

## 7. Изменения в `src/llm.js`

Во всех функциях добавляется замер времени, перехват `usage` из ответа и вызов `logLlmRequest(...)`. **Форма
возвращаемого значения каждой функции остаётся прежней** — вызывающий код менять не нужно. Логирование выполняется
как побочный эффект.

- **`chat({ model, messages, tools, toolChoice, kind })`** — добавить необязательный параметр `kind`. После
  `client.chat.completions.create(body)` взять `res.usage` (`prompt_tokens`, `completion_tokens`, `total_tokens`)
  и вызвать `logLlmRequest` с `endpoint: 'chat.completions'`, телом `body` в качестве `payload`, токенами и временем.
  Вернуть `res.choices[0].message`, как сейчас.
- **`chatStream(...)`** — чтобы получить токены при потоковом ответе, в тело запроса добавить
  `stream_options: { include_usage: true }`. Тогда провайдер пришлёт финальный чанк с заполненным `usage` и обычно
  пустым `choices`. Накапливать `usage` из чанков (брать последний непустой). После завершения потока залогировать
  запрос с фактическими токенами. Учесть путь отката на непотоковый `chat` (в блоке `catch`) — там логирование делает
  уже сам `chat`, повторно логировать не нужно.
- **`chatJSON({ ..., kind })`** — добавить необязательный `kind`. После создания ответа взять `res.usage`, залогировать
  с `endpoint: 'chat.completions'` и `payload`, содержащим реально отправленные `messages` и `response_format`.
- **`embed(text, { kind } = {})`** — после `client.embeddings.create(...)` взять `res.usage` (у эмбеддингов есть
  `prompt_tokens`/`total_tokens`, поля `completion_tokens` нет). Залогировать с `endpoint: 'embeddings'`, `payload`
  вида `{ model, input }` (с усечением длинного `input`). На ветке ошибки (когда эмбеддинг недоступен и функция
  возвращает `null`) тоже залогировать запись со `status: 'error'` и текстом ошибки, без токенов.

Во всех функциях логирование оборачивается так, чтобы исключение в нём не помешало вернуть результат модели.

## 8. Изменения в голосовых модулях (бинарные данные)

- **`src/voice/transcribe.js` (STT, вход — аудио/видео файл).** В `transcribeTelegramAttachment` (и во внутренних
  `transcribeOpenAICompatible` / `transcribeAssemblyAI`) после получения результата залогировать запрос с
  `is_binary: true`, `endpoint: 'audio.transcriptions'`, `request_kind: 'stt'`. В `binary_meta` положить
  `{ kind, mimeType, fileName, fileSize, durationSeconds }` из объекта `attachment`; в `payload` — только нетекстовые
  параметры (`model`, `language`, `response_format`). **Содержимое файла и распознанный текст в `payload` не кладём**
  (распознанный текст — это пользовательские данные, для журнала запросов достаточно метаданных файла). Токены у
  большинства распознавателей отсутствуют — логируем `NULL`, цена остаётся `NULL` (для Whisper/Groq тарификация идёт по
  длительности, её можно добавить позже отдельной формулой; пока не блокирует). Ошибку распознавания логируем со
  `status: 'error'`.
- **`src/voice/tts.js` (TTS, выход — аудио).** В `synthesizeSpeech` после успешного синтеза залогировать запрос с
  `is_binary: true`, `endpoint: 'audio.speech'`, `request_kind: 'tts'`. Здесь вход — это **текст**, поэтому он
  сохраняется в `payload` (`{ model, voice, format, input: text }`), а в `binary_meta` кладётся описание выходного
  аудио (`{ format, byteLength: buf.length }`). При ошибке — `status: 'error'`.

## 9. Конфигурация

Настройки логирования задаются в YAML-иерархии node-config, а не в `src/config.js`. В `src/config.js` руками ничего
не дописывается: объект `config` — это снимок дерева (`nodeConfig.util.toObject()`), и секция `llmLog` попадает в него
автоматически. Потребители читают её как `config.llmLog.*`.

Что сделать:

1. **В `config/default.yaml`** добавить секцию `llmLog` (соблюдая алфавитный порядок ключей верхнего уровня — она
   встаёт между `llm` и `mcp`), с человекочитаемыми комментариями к каждому параметру:

   ```yaml
   #> Логирование обращений к LLM и смежным сервисам в БД (журнал запросов + узкий журнал затрат).
   llmLog:
     #> Размер пакета фоновой выгрузки буфера в БД (число записей за один INSERT).
     batchSize: 200
     #> Включить логирование. false → эмиттер становится пустышкой (ничего не пишет).
     enabled: true
     #> Период фоновой выгрузки буфера в БД (мс).
     flushIntervalMs: 1000
     #> Предельная длина сериализованного payload (символы). Сверх — усечение и payload_truncated=true.
     maxPayloadChars: 100000
   ```

2. **В `config/custom-environment-variables.yaml`** добавить карту переменных окружения (имена соответствуют
   иерархии YAML, числа — `__format: number`, флаг — `__format: boolean`):

   ```yaml
   llmLog:
     batchSize:
       __name: LLM_LOG_BATCH_SIZE
       __format: number
     enabled:
       __name: LLM_LOG_ENABLED
       __format: boolean
     flushIntervalMs:
       __name: LLM_LOG_FLUSH_INTERVAL_MS
       __format: number
     maxPayloadChars:
       __name: LLM_LOG_MAX_PAYLOAD_CHARS
       __format: number
   ```

3. **В коде** читать значения как `config.llmLog.enabled`, `config.llmLog.flushIntervalMs`, `config.llmLog.batchSize`,
   `config.llmLog.maxPayloadChars`. Никаких `flag()`/`Number()`/`process.env` — типы уже приведены node-config.

При `config.llmLog.enabled === false` эмиттер становится пустышкой (`logLlmRequest` ничего не делает), что удобно для
изолированных запусков. Сами таблицы при этом всё равно создаются миграцией. Тесты логирование **не** выключают: они
пишут реальные записи с флагом `is_test` и подчищают их после прогона (раздел 11).

## 10. Вспомогательный модуль агрегатов — `src/pipeline/llm-usage-stats.js`

Небольшой модуль для быстрого подсчёта затрат поверх `log.llm_usage` (по образцу `log-llm-usage-api.ts` из референса,
но на нашем `query()` и без socket-слоя):

- `getCost({ from, to, userId, kind, model })` → `{ tokens, priceUsd }` — сумма `total_tokens` и `price_usd` с
  фильтрами по периоду, пользователю, типу и модели.
- `getCostByKind({ from, to })` → массив `{ requestKind, tokens, priceUsd }` с группировкой по типу запроса
  (для будущего интерфейса, где разные типы показываются отдельно).
- `getDialogCost(requestId)` → `{ tokens, priceUsd }` — затраты на один ход диалога (по `request_id` из
  `log.llm_request`, соединённому с `log.llm_usage`). Это аналог суммы «токенов и стоимости», которая на референсных
  скриншотах показана сверху и на каждой строке лога.

Интерфейс не реализуется в рамках этой задачи (по условию), но эти функции готовят почву для него.

## 11. Тесты

Добавить в каталог `tests/` (стиль существующих `*.test.mjs`, запуск через `node`):

- `tests/llm-pricing.test.mjs` — проверка `priceUsd`: корректный расчёт для известной модели (например, `gpt-4o`
  и `text-embedding-3-small`), `null` для неизвестной модели, нормализация имени с префиксом `openai/` и со штампом
  даты.
- `tests/llm-log-buffer.test.mjs` — проверка эмиттера с подменённым `query`: записи буферизуются, выгружаются пакетом,
  ошибка вставки не бросается наружу, `flushLlmLog` выгружает остаток, усечение `payload` выставляет
  `payload_truncated`.
- `tests/llm-log-stream-usage.test.mjs` — проверка, что `chatStream` накапливает `usage` из финального чанка и
  формирует запись с токенами (с подменённым клиентом OpenAI, по образцу уже имеющихся потоковых тестов).
- Включить новые тесты в `tests/run.js` и добавить npm-скрипты `test:llm-pricing` и `test:llm-log` в `package.json`.
  Новые скрипты, как и остальные, запускаются с `NODE_ENV=test` через `cross-env` (соглашение из плана миграции
  конфигурации), например: `"test:llm-log": "cross-env NODE_ENV=test node tests/llm-log-buffer.test.mjs"`.

Расчёт цены и буферизацию (`llm-pricing`, `llm-log-buffer`, `llm-log-stream-usage`) покрываем модульными тестами без
сети: они тестируют функции напрямую с подменённым `query` и явными входными данными, поэтому в реальную БД не пишут.

**Тесты, которые поднимают реальный пайплайн (интеграционные), логирование не выключают — они пишут в журнал.**
Чтобы такие записи не накапливались, действует механизм флага `is_test`:

- Эмиттер при работе в тестовом окружении (`NODE_ENV=test`) проставляет каждой записи `is_test = true`
  (см. `buildRecord`, раздел 6). Запуск тестов уже идёт с `NODE_ENV=test` через `cross-env`, поэтому отдельной
  настройки не требуется.
- После прогона тестовые записи удаляются вызовом `deleteTestLlmLogs()` (раздел 6): он сливает буфер и удаляет строки
  с `is_test` сначала из `log.llm_usage`, затем из `log.llm_request`. Подключить вызов в обвязку тестов — в `tests/run.js`
  по завершении набора (в блоке `finally`), а для отдельных интеграционных `*.mjs`, поднимающих пайплайн, — в их
  собственном завершении. Так журнал остаётся чистым независимо от исхода тестов.

## 12. Порядок реализации (с учётом параллелизации)

1. **Независимо и параллельно** (нет взаимных зависимостей):
   - Миграция `migrations/017_llm_logging.sql` (раздел 3.3).
   - Модуль цен `src/pipeline/llm-pricing.js` (цены моделей берутся из `src/data/model-list.js`).
   - Модуль контекста `src/pipeline/llm-context.js`.
   - Секция `llmLog` в `config/default.yaml` и в `config/custom-environment-variables.yaml` (раздел 9).
2. **После модуля цен и контекста:** эмиттер `src/pipeline/llm-log.js` (зависит от обоих и от секции `llmLog`).
3. **После эмиттера:** правки в `src/llm.js` (раздел 7) и в голосовых модулях (раздел 8); установка контекста в
   `src/agent.js` и фоновых контурах (раздел 5).
4. **После основной интеграции:** модуль агрегатов `src/pipeline/llm-usage-stats.js` и тесты (раздел 11).
5. **Завершение:** применить миграцию (`npm run migrate`), прогнать `npm run test`, `npm run quality`; вручную
   отправить боту текстовое и голосовое сообщение и убедиться, что в `log.llm_request` появились строки нужных типов,
   а триггер заполнил `log.llm_usage`.

## 13. Открытые решения (приняты по умолчанию, чтобы не блокировать реализацию)

- **Две таблицы вместо справочников `llm_client`/`llm_endpoint`.** В референсе есть нормализованные справочники
  клиентов и конечных точек. Здесь один экземпляр бота и один биллинговый аккаунт, поэтому провайдер и конечная точка
  хранятся текстовыми колонками с индексами — этого достаточно для агрегатов и проще в поддержке. Справочники можно
  ввести позже без миграции данных.
- **Связь таблиц триггером, а не двойной записью из кода.** Прикладной код делает один insert; согласованность узкой
  таблицы обеспечивает база. Это исключает рассинхрон и упрощает эмиттер.
- **Логируем токены даже без цены.** Если модели нет в прайс-листе, `price_usd` будет `NULL`, но токены и сам запрос
  фиксируются. Это делает пробел в ценах видимым (через строки с `price_usd IS NULL`), а не теряет данные.
- **Распознанный текст и байты файлов в журнал не попадают.** По условию для бинарных данных сохраняются только
  сведения о файле. Распознанный из речи текст трактуется как пользовательские данные и в журнал запросов не пишется
  (он и так сохраняется в обычной истории сообщений).
- **Идентификатор пользователя хранится строкой без внешнего ключа.** Журнал намеренно развязан с прикладной схемой,
  чтобы быть устойчивым к удалению пользователей и не участвовать в каскадах.
```
