# 08. Промпты, прокси и выбор моделей

## Вкратце

Все запросы к моделям идут через корпоративный LiteLLM-прокси (OpenAI-совместимый API), а не на `api.openai.com`. Клиент
(`src/llm.js`) даёт три операции: обычный чат с инструментами, строгий JSON по схеме (`chatJSON`) и эмбеддинги. Каждый
вспомогательный этап использует структурированный вывод по JSON-схеме. Основной ответ даёт модель среднего уровня,
вспомогательные задачи — самая дешёвая быстрая модель.

## Зачем структурированный вывод через описание схемы

Строгий режим OpenAI (`json_schema` с `additionalProperties:false` у всех объектов) несовместим со свободными полями
`data` и `entities`, где ключи зависят от домена. Поэтому для таких схем используется режим `json_object` с описанием
JSON-схемы прямо в системном промпте, а соответствие обеспечивается её текстовым описанием и разбором ответа.

---

## Клиент и строгий JSON

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

### Классификатор запроса

Дешёвая модель определяет намерение, домен, сущности и то, какие виды памяти и инструменты нужны. Возвращает строгий JSON,
а не ответ пользователю.

```text
Ты классификатор входящего сообщения для агентского приложения с памятью.
Определи: намерение пользователя; домен (general, travel, landing_sales, math_tutor или другой явно указанный);
важные сущности; какие виды памяти нужны; нужны ли инструменты.
Не отвечай пользователю. Верни только JSON по схеме.
```

Схема `intent_classification`: обязательные поля `intent`, `domain_key`, `confidence`, `entities`, `needs_memory`,
`needed_memory_scopes`, `needs_tools`, `candidate_tools`; область памяти — одно из `dialog | profile | domain | secure |
reminder`.

### Извлечение кандидатов в память

Запускается после ответа. Промпт перечисляет, что сохранять и что не сохранять, требует помечать чувствительные данные как
`high`/`secret` с `requires_confirmation = true` и безопасным `memory_text`. Схема `memory_candidates`: массив объектов с
полями `scope`, `memory_kind`, `entity_type`, `entity_key`, `memory_text`, `data`, `importance`, `confidence`,
`sensitivity`, `ttl_days`, `requires_confirmation`, `reason`. Полный текст промпта с примерами — в `src/pipeline/extract.js`.

### Извлечение задачи для планировщика

```text
Ты извлекаешь задачи, напоминания и фоновые проверки из сообщения пользователя.
Создавай задачу ТОЛЬКО если пользователь явно попросил: напомнить, проверить позже, следить за условием,
присылать регулярно или вернуться к теме в будущем. Не создавай задачу из обычного желания без намерения напомнить.
Вычисли run_at как абсолютную дату-время в ISO 8601 относительно текущего времени.
Верни только JSON по схеме.
```

### Извлечение тем диалога (режим собеседника)

Параллельно с извлечением фактов при `COMPANION_MODE` отдельный вызов возвращает темы диалога с оценкой вовлечённости.
Схема `dialog_topics`: массив объектов с `topic_key` (короткий ключ латиницей в snake_case) и `user_engagement` (0..1).
Подробнее — в [09-proactivity.md](09-proactivity.md).

### Служебный блок MEMORY_CONTEXT

Подаётся отдельным system-сообщением после стабильного системного промпта и всегда предваряется правилами, объявляющими
его справочными данными. Полный вид — в [06-memory.md](06-memory.md).

### Решение о слиянии факта (схема для доделки)

В текущей реализации конфликт нового факта с уже сохранённым решается детерминированными правилами `decideMerge`
(см. [06-memory.md](06-memory.md)). На случай сложных конфликтов, которые правилами разрешить трудно, в архитектуре
заложена альтернатива — отдельный вызов модели, возвращающий решение о слиянии по строгой JSON-схеме `MergeDecision`.
Схема пока не используется и сохранена как кандидат на доделку (см. таблицу доделок в [12-appendix.md](12-appendix.md)):

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

## Конфигурация

Конфигурация (`src/config.js`) читается из `.env`. Модели можно переопределить переменными окружения, флаги собеседника и
проактивности по умолчанию выключены. Полный список флагов — в [03-quickstart.md](03-quickstart.md).

```js
export const config = {
  databaseUrl: ..., memDbName: ...,
  llm: {
    apiKey: env.OPENAI_API_KEY,
    baseURL: env.OPENAI_BASE_URL || 'https://litellm.finam.ru/v1',
    mainModel: env.MAIN_MODEL || 'gpt-5.4-mini',
    auxModel: env.AUX_MODEL || 'gpt-5.4-nano',
    extractModel: env.EXTRACT_MODEL || 'gpt-5.4-mini',
    embedModel: env.EMBED_MODEL || 'text-embedding-3-small',
    embedDim: 1536,
  },
  authSecret: env.AUTH_SECRET || 'dev-insecure-secret-change-me',
  timezone: env.TZ_DEFAULT || 'Europe/Moscow',
  debug: (env.DEBUG || '').split(',').map((s) => s.trim()).filter(Boolean),
  companion: { enabled: flag(env.COMPANION_MODE, false) },
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
};
```

---

## Выбор моделей по этапам

Принцип: основной ответ даёт модель среднего уровня, все вспомогательные JSON-задачи — самая дешёвая быстрая модель,
память пишется асинхронно, чтобы не тормозить ответ.

| Этап | Что используется | Переменная |
|------|------------------|------------|
| Основной ответ агента | `gpt-5.4-mini` | `MAIN_MODEL` |
| Классификация запроса | `gpt-5.4-nano` | `AUX_MODEL` |
| Извлечение фактов в память | `gpt-5.4-mini` | `EXTRACT_MODEL` |
| Извлечение тем диалога | `gpt-5.4-nano` (auxModel) | `AUX_MODEL` |
| Слияние фактов | детерминированные правила, без вызова модели | — |
| Эмбеддинги | `text-embedding-3-small` (1536) | `EMBED_MODEL` |

Все модели проверены через прокси скриптом `tests/check-llm.js` (`npm run check:llm`): подтверждены чат, строгий JSON,
вызов инструментов и эмбеддинги. Замечание о скорости: на этом прокси модели `gpt-5.4-*` отвечают примерно за 5–10 секунд,
а `gpt-4o-mini` — примерно за 1,2 секунды; для максимально быстрого отклика можно задать `MAIN_MODEL=gpt-4o-mini`.

---

## Связанные документы

- Контур ответа — [04-architecture.md](04-architecture.md)
- Память и извлечение — [06-memory.md](06-memory.md)
- Флаги и команды — [03-quickstart.md](03-quickstart.md)
- Слой per-domain-схем (где строгий режим снова применим) — [11-per-domain-schema.md](11-per-domain-schema.md)
