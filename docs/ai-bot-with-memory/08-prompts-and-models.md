# 08. Промпты, прокси и выбор моделей

## Вкратце

Все запросы к моделям идут через LLM-прокси (OpenAI-совместимый API), а не напрямую в публичный API `api.openai.com`.
Клиент (`src/llm.js`) даёт три операции: обычный чат с инструментами, строгий JSON по схеме (`chatJSON`) и эмбеддинги.
Каждый вспомогательный этап использует структурированный вывод по JSON-схеме. Основной ответ даёт модель среднего
уровня, вспомогательные задачи — самая дешёвая быстрая модель.

## Зачем структурированный вывод через описание схемы

Строгий режим OpenAI (`json_schema` с `additionalProperties:false` у всех объектов) несовместим со свободными полями
`data` и `entities`, где ключи зависят от домена. Поэтому для таких схем используется режим `json_object` с описанием
JSON-схемы прямо в системном промпте, а соответствие обеспечивается её текстовым описанием и разбором ответа.

---

## [PROMPT-1] Клиент и строгий JSON

```js
export async function chatJSON({ model = config.llm.auxModel, system, user, schema, schemaName = 'result' }) {
  const sys = `${system || ''}

Ответь СТРОГО одним JSON-объектом, который соответствует следующей JSON Schema (${schemaName}):
${JSON.stringify(schema)}
Без markdown, без пояснений, без текста до или после JSON. Только сам объект.`;
  const res = await client.chat.completions.create({
    model,
    messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
    response_format: { type: 'json_object' },
  });
  const content = res.choices[0].message.content;
  try { return JSON.parse(content); }
  catch {
    const m = content.match(/\{[\s\S]*\}/);     // запасной разбор, если модель обернула JSON в текст
    if (m) return JSON.parse(m[0]);
    throw new Error('Модель вернула не-JSON: ' + content.slice(0, 200));
  }
}
```

Эмбеддинги получает функция `embed`; при ошибке она возвращает `null`, и вся система откатывается на полнотекстовый и
структурный поиск без векторов. Это делает векторный слой опциональным и устойчивым к недоступности модели.

---

## Промпты всех этапов

### [PROMPT-2] Классификатор запроса

Дешёвая модель определяет намерение, домен, сущности и то, какие виды памяти и инструменты нужны. Возвращает строгий JSON,
а не ответ пользователю. Перечень доменов в системный промпт намеренно не зашит: функция `buildSystemPrompt`
(`src/pipeline/classify.js`) подтягивает список доменов из таблицы `mem.agent_domains` через `repo.listDomains` (с кэшем) и
подставляет ключ, название и описание каждого домена. Благодаря этому добавление нового домена в базу сразу отражается в
классификаторе, и список доменов не приходится дублировать вручную в коде. Сама сборка промпта выглядит так
(`src/pipeline/classify.js`):

```js
async function buildSystemPrompt() {
  const domains = await listDomains();
  const domainsList = domains
    .map((d) => `  - ${d.domain_key} (${d.title})${d.description ? `: ${d.description}` : ''}`)
    .join('\n');
  return `Ты классификатор входящего сообщения для агентского приложения с памятью.
Определи: намерение пользователя; домен; важные сущности; какие виды памяти нужны; нужны ли инструменты.
В поле domain_key укажи ключ одного из доступных доменов:
${domainsList}
Если ни один домен не подходит, используй general.
Не отвечай пользователю. Верни только JSON по схеме.`;
}
```

Подстановка `${domainsList}` и есть точка параметризации: каждая строка списка собирается из ключа `domain_key`,
названия `title` и необязательного описания `description` домена. Ниже показан промпт, собранный для текущего набора
засеянных доменов:

```text
Ты классификатор входящего сообщения для агентского приложения с памятью.
Определи: намерение пользователя; домен; важные сущности; какие виды памяти нужны; нужны ли инструменты.
В поле domain_key укажи ключ одного из доступных доменов:
  - general (Универсальный помощник): Базовый домен без узкой специализации
  - flight_search (Поиск авиабилетов): Авиабилеты, рейсы, аэропорты, даты вылета и пересадки
  - joke_teller (Знаток анекдотов): Поиск свежих анекдотов в интернете и их рассказ
  - math_tutor (Репетитор по математике): Темы, ошибки, прогресс ученика
Если ни один домен не подходит, используй general.
Не отвечай пользователю. Верни только JSON по схеме.
```

Схема `intent_classification`: обязательные поля `intent`, `domain_key`, `confidence`, `entities`, `needs_memory`,
`needed_memory_scopes`, `needs_tools`, `candidate_tools`; область памяти — одно из `dialog | profile | domain | secure |
reminder`.

### [PROMPT-2a] Выбор намерения доставки

Для коротких сообщений, где канал поддерживает компактные реакции, дешёвая модель может выбрать намерение доставки до
полного ответа агента. Входом служат текст пользователя и возможности канала (`supportsReactions`, список ключей).
Выход — строгий JSON `delivery_intent`:

```json
{
  "kind": "reaction",
  "reaction_key": "okay",
  "fallback_text": "Окей.",
  "reason": "Пользователь просит простое действие, достаточно согласия"
}
```

Допустимые `reaction_key`: `like`, `okay`, `heart`, `laugh`, `fire`, `smile`, `100`, `sad`. Модель выбирает `reaction`
только когда ответ не требует фактов, инструментов, уточнений или содержательного текста. Во всех остальных случаях она
возвращает `kind = "text_needed"`, и сообщение идёт в обычный `handleMessage`.

### [PROMPT-3] Извлечение кандидатов в память

Запускается после ответа и работает в два прохода. Первый проход перечисляет, что сохранять и что не сохранять, требует
помечать чувствительные данные как `high`/`secret` с `requires_confirmation = true` и безопасным `memory_text`, и для
домена со схемой подставляет перечень его сущностей и полей. Схема `memory_candidates`: массив объектов с полями `scope`,
`memory_kind`, `entity_type`, `entity_key`, `memory_text`, `data`, `importance`, `confidence`, `sensitivity`, `ttl_days`,
`requires_confirmation`, `reason`. Второй проход применяется к предметным кандидатам, чья сущность объявлена в схеме
домена: под каждую сущность собирается закрытая схема ответа, где `data` равно `data_schema` сущности, а `entity_key` для
режима `fixed_vocab` ограничен словарём. Модель перезаполняет ровно эти поля с точными типами и значениями, поэтому на
запись приходит уже валидный кандидат, а итоговый контроль всё равно выполняется в `validateAndCanonicalize`. Полный текст
промптов — в `src/pipeline/extract.js`, слой схем — в [11-per-domain-schema.md](11-per-domain-schema.md).

Реакции пользователя на сообщение ассистента подаются в извлечение как отдельная пользовательская реплика истории.
Промпт сохраняет факт только когда смысл реакции однозначен в контексте целевого сообщения ассистента. Например, вопрос
«Ты любишь торты?» и реакция `:heart:` дают предпочтение «Пользователь любит торты». Реакции, которые могут означать
вежливость, настроение или разовое одобрение без будущей пользы, не создают кандидатов памяти.

### [PROMPT-4] Извлечение задачи для планировщика

```text
Ты извлекаешь задачи, напоминания и фоновые проверки из сообщения пользователя.
Создавай задачу ТОЛЬКО если пользователь явно попросил: напомнить, проверить позже, следить за условием,
присылать регулярно или вернуться к теме в будущем. Не создавай задачу из обычного желания без намерения напомнить.
Для разовой задачи используй schedule_kind="one_time" и вычисли run_at как абсолютную дату-время в ISO 8601.
Для простого "каждые N минут/часов/дней" используй schedule_kind="interval" и interval_seconds.
Для календарных регулярностей с конкретным локальным временем используй schedule_kind="cron", например каждый будний
день в 09:00: cron_expr="0 9 * * 1-5". Для сложных календарных правил используй schedule_kind="rrule" и реальную
iCalendar RRULE-строку. Не вычисляй run_at для cron/rrule: ближайший запуск посчитает код планировщика.
Всегда возвращай timezone из часового пояса пользователя, если пользователь явно не указал другой IANA timezone.
Верни только JSON по схеме.
```

### [PROMPT-5] Извлечение тем диалога (режим собеседника)

Параллельно с извлечением фактов при `COMPANION_MODE` отдельный вызов возвращает темы диалога с оценкой вовлечённости.
Схема `dialog_topics`: массив объектов с `topic_key` (короткий ключ латиницей в snake_case) и `user_engagement` (0..1).
Подробнее — в [09-proactivity.md](09-proactivity.md).

### [PROMPT-6] Суммаризатор истории диалога (поджатие истории)

При `HISTORY_COMPRESSION_ENABLED` отдельный вызов сжимает холодную часть диалога. Промпт требует сохранить только то, что
нужно для продолжения разговора, не трогать последние сообщения (они не переданы и добавятся отдельно), не дублировать
факты из `active_memory`, описывать ближний контекст подробнее дальнего, выносить устойчивые факты в `facts_to_memory`,
не сохранять секреты в открытом виде и не выдумывать факты.

```text
Ты сжимаешь старую часть истории диалога для чат-бота с долговременной памятью.
Сохрани только то, что нужно для продолжения текущего диалога. Не дублируй факты из active_memory.
Ближний к текущему моменту контекст описывай подробнее, дальний — сжимай сильнее. Не сохраняй секреты и мусор.
Устойчивые факты для долговременной памяти вынеси в facts_to_memory. Верни только JSON по схеме.
```

Схема `history_summary`: обязательные поля `summary_text`, `state_json`, `facts_to_memory`, `dropped_because_in_memory`,
`sensitive_mentions_redacted`. Размеры в токенах в схему **намеренно не входят** — их считает код по `token_count`
сообщений, потому что модель ненадёжно меряет собственные токены. Полная схема и разбор — в
[13-history-compression.md](13-history-compression.md).

### Служебный блок MEMORY_CONTEXT

Подаётся отдельным system-сообщением после стабильного системного промпта и всегда предваряется правилами, объявляющими
его справочными данными. Полный вид — в [06-memory.md](06-memory.md).

### [PROMPT-7] Решение о слиянии факта (опциональная схема-расширение)

Конфликт нового факта с уже сохранённым по умолчанию разрешается детерминированными правилами `decideMerge`
(см. [06-memory.md](06-memory.md)). На случай сложных конфликтов, которые правилами разрешить трудно, предусмотрена
опциональная альтернатива — отдельный вызов модели, возвращающий решение о слиянии по строгой JSON-схеме
`MergeDecision`. Эта схема описывает расширение поверх базовых правил и может подключаться там, где требуется более
тонкое разрешение конфликтов:

```json
{
  "type": "object", "additionalProperties": false,
  "required": ["decision", "target_memory_id", "merged_memory_text", "merged_data", "reason"],
  "properties": {
    "decision": { "type": "string",
      "enum": ["create_new","update_existing","replace_existing","archive_existing","ignore","ask_confirmation"] },
    "target_memory_id":   { "type": ["string","null"] },
    "merged_memory_text": { "type": ["string","null"] },
    "merged_data":        { "type": ["object","null"], "additionalProperties": true },
    "reason":             { "type": "string" }
  }
}
```

Поле `decision` выбирает одно из шести действий: создать новый факт, обновить существующий, заменить его целиком,
архивировать, проигнорировать кандидата или переспросить пользователя. Поля `target_memory_id`, `merged_memory_text` и
`merged_data` заполняются, когда действие затрагивает конкретную запись, а `reason` хранит обоснование решения для аудита.

---

## [PROMPT-8] Конфигурация

Конфигурация (`src/config.js`) читается из `.env`. Модели можно переопределить переменными окружения, флаги собеседника и
проактивности по умолчанию выключены. Полный список флагов — в [03-quickstart.md](03-quickstart.md).

```js
export const config = {
  databaseUrl: ..., memDbName: ...,
  llm: {
    apiKey: env.OPENAI_API_KEY,
    baseURL: env.OPENAI_BASE_URL || '<LLM_PROXY_BASE_URL>',
    mainModel: env.MAIN_MODEL || '<MAIN_MODEL>',
    auxModel: env.AUX_MODEL || '<AUX_MODEL>',
    extractModel: env.EXTRACT_MODEL || '<MAIN_MODEL>',
    embedModel: env.EMBED_MODEL || '<EMBED_MODEL>',
    embedDim: 1536,
  },
  authSecret: env.AUTH_SECRET || 'dev-insecure-secret-change-me',
  timezone: env.TZ_DEFAULT || 'Europe/Moscow',
  debug: (env.DEBUG || '').split(',').map((s) => s.trim()).filter(Boolean),
  companion: { enabled: flag(env.COMPANION_MODE, false) },
  globalMemory: {
    factsEnabled: flag(env.GLOBAL_MEMORY_ENABLED, false), // глобальные факты (always-on)
    factsLimit: Number(env.GLOBAL_FACTS_LIMIT || 5),
    ragEnabled: flag(env.GLOBAL_RAG_ENABLED, false),       // общая база знаний (RAG)
    ragLimit: Number(env.GLOBAL_RAG_LIMIT || 5),
    ragMinRelevance: Number(env.GLOBAL_RAG_MIN_RELEVANCE || 0.3),
  },
  proactive: {
    enabled: flag(env.PROACTIVE_ENABLED, false),
    intervalMs: Number(env.PROACTIVE_INTERVAL_MS || 300000),
    inactivityMinutes: Number(env.PROACTIVE_INACTIVITY_MIN || 1440),
    checkinHour: Number(env.PROACTIVE_CHECKIN_HOUR || 10),
    goalIntervalMinutes: Number(env.PROACTIVE_GOAL_INTERVAL_MIN || 2880),
    welcomeBackGapMinutes: Number(env.PROACTIVE_WELCOME_GAP_MIN || 60),
    events: { enabled: flag(env.PROACTIVE_EVENTS_ENABLED, false),
              relevanceThreshold: Number(env.NEWS_RELEVANCE_THRESHOLD || 0.6) },
  },
  historyCompression: {
    enabled: flag(env.HISTORY_COMPRESSION_ENABLED, false),
    hotWindow: Number(env.HISTORY_HOT_WINDOW || 8),
    maxTokens: Number(env.HISTORY_MAX_TOKENS || 2000),
    shrinkTokens: Number(env.HISTORY_SHRINK_TOKENS || 800),
    zoneWeights: String(env.HISTORY_ZONE_WEIGHTS || '0.55,0.30,0.15').split(',').map(Number),
    model: env.HISTORY_SUMMARY_MODEL || env.AUX_MODEL || '<AUX_MODEL>',
    minCompressGain: Number(env.HISTORY_MIN_COMPRESS_GAIN || 0.35),
  },
};
```

При старте проверяется инвариант гистерезиса: `shrinkTokens` должен быть строго меньше `maxTokens`.

---

## [PROMPT-9] Выбор моделей по этапам

Принцип: основной ответ даёт модель среднего уровня, все вспомогательные JSON-задачи — самая дешёвая быстрая модель,
память пишется асинхронно, чтобы не тормозить ответ.

| Этап | Что используется | Переменная |
|------|------------------|------------|
| Основной ответ агента | `<MAIN_MODEL>` | `MAIN_MODEL` |
| Классификация запроса | `<AUX_MODEL>` | `AUX_MODEL` |
| Выбор намерения доставки | `<AUX_MODEL>` | `AUX_MODEL` |
| Извлечение фактов в память | `<MAIN_MODEL>` | `EXTRACT_MODEL` |
| Извлечение тем диалога | `<AUX_MODEL>` | `AUX_MODEL` |
| Суммаризатор истории диалога | `<AUX_MODEL>` | `HISTORY_SUMMARY_MODEL` |
| Слияние фактов | детерминированные правила, без вызова модели | — |
| Эмбеддинги | `<EMBED_MODEL>` (1536) | `EMBED_MODEL` |

Перед выводом в продакшен следует проверить доступность и возможности выбранных моделей (чат, строгий JSON, вызов
инструментов и эмбеддинги) через прокси скриптом проверки `tests/check-llm.js` (`npm run check:llm`).

### Рекомендованные модели (примеры подбора)

Ориентиры подбора для двух провайдеров; подойдёт любая модель сопоставимого класса, проходящая `npm run check:llm`.

| Класс модели | OpenAI-совместимый прокси | Аналог на Groq |
|--------------|---------------------------|----------------|
| `<MAIN_MODEL>` — основной ответ | `gpt-5.4-mini` | `llama-3.3-70b-versatile` |
| `<AUX_MODEL>` — дешёвый вспомогательный | `gpt-5.4-nano` | `openai/gpt-oss-20b` или `llama-3.1-8b-instant` |
| `<EMBED_MODEL>` — эмбеддинги (1536) | `text-embedding-3-small` | у Groq нет эмбеддингов: взять другого провайдера или отключить векторный слой |

---

## Связанные документы

- Контур ответа — [04-architecture.md](04-architecture.md)
- Память и извлечение — [06-memory.md](06-memory.md)
- Флаги и команды — [03-quickstart.md](03-quickstart.md)
- Слой per-domain-схем (где строгий режим снова применим) — [11-per-domain-schema.md](11-per-domain-schema.md)
- Поджатие истории и схема суммаризатора — [13-history-compression.md](13-history-compression.md)
