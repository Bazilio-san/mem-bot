# Proposal: строгая схема суммаризатора истории (state_json и facts_to_memory без additionalProperties)

Статус: предложение, не реализовано. Дата: 2026-06-12.

Связанное предложение: `2026-06-12-09-52-proposal-entities-boost-in-retrieve.md` (первое из двух свободных мест в
JSON-схемах проекта). Настоящий документ закрывает второе и последнее.

## Предыстория

Суммаризатор истории (`src/pipeline/history-compress.js`) пересжимает холодную зону диалога в дайджест. Его схема
ответа `SUMMARY_SCHEMA` (`history-compress.js:27-56`) содержит два свободных поля:

- `state_json: { type: 'object', additionalProperties: true, properties: {семь ключей} }`;
- `facts_to_memory: { type: 'array', items: { type: 'object', additionalProperties: true } }`.

Свобода — наследие первой версии проекта с сущностной моделью памяти: тогда состояние и факты имели
доменно-зависимую форму (поле `data` по per-domain-схеме), их ключи действительно нельзя было зафиксировать, и
из-за этого структурированные ответы шли в режиме `json_object` (историческая пометка в `src/llm.js:251`). После
перехода на плоское хранилище `mem.user_facts` форма фактов жёстко зафиксировалась, а у `state_json` все рабочие
ключи перечислены в `properties` — свободные ключи перестали нести функцию.

Цена свободы сегодня: `prepareJsonSchema` (`src/llm.js`) понижает ВСЮ схему `history_summary` до `strict: false`,
провайдер не гарантирует структуру ответа на уровне декодера. Для подстраховки в конфиге существует персональная
настройка `historyCompression.responseFormat` (`config/default.yaml:164`).

## Как поля работают сейчас (фактические потребители)

### state_json — оперативное состояние диалога

Назначение: `summary_text` — пересказ прошлого, `state_json` — структурированный снимок текущего положения дел:
`current_goal`, `current_task`, `decisions`, `rejected_options`, `open_questions`, `constraints`, `next_steps`.

Жизненный цикл: сохраняется в колонку `state_json` (jsonb) таблицы `mem.conversation_summaries`
(`src/repo.js:220`), при сборке контекста печатается в блок `HISTORY_CONTEXT` под заголовком «Оперативное
состояние» через `JSON.stringify(stateJson, null, 2)` (`src/pipeline/history-context.js:25`).

Ключевой факт: ни одна строка кода не читает отдельные ключи объекта — это сквозной канал «модель → промпт
следующих запросов». Дополнительные свободные ключи просто печатаются в промпт текстом, машинной функции у них нет.

### facts_to_memory — устойчивые факты из сжимаемой истории

Назначение: ценные сведения о пользователе не должны погибнуть вместе с сырыми сообщениями холодной зоны —
суммаризатор выносит их в долговременную память.

Жизненный цикл: `factsToCandidates` (`history-compress.js:252`) приводит элементы к плоской форме и отдаёт в
обычный поток `saveFacts` (порог уверенности, семантическая дедупликация, источник `history_summary` с минимальным
рангом доверия `SOURCE_RANK`).

Ключевой факт: код читает ровно четыре поля — `type`, `fact_text`, `confidence`, `ttl_days`. Системный промпт
суммаризатора (пункт 6 `SUMMARY_SYSTEM`) требует ровно эту форму и перечисляет словарь типов. При этом в
`src/pipeline/facts.js:118` для точно такой же формы факта уже существует строгая схема `EXTRACT_SCHEMA`
(`enum: FACT_TYPES`, `additionalProperties: false`). Свобода у элементов `facts_to_memory` — чистое наследие.

## Суть предложения

Перевести оба поля на строгие схемы. Потребители уже не зависят от свободных ключей, поэтому перевод почти
бесплатный, а взамен схема `history_summary` становится полностью строгой: провайдер гарантирует структуру ответа
на уровне декодера, разбор `raw.state_json && typeof raw.state_json === 'object' ? … : {}` перестаёт быть
единственной линией обороны.

### Изменение 1: facts_to_memory — общая строгая форма факта с facts.js

В `src/pipeline/facts.js` выделить и экспортировать фрагмент схемы элемента факта (одна точка истины):

```js
export const FACT_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'fact_text', 'confidence', 'ttl_days'],
  properties: {
    type: { type: 'string', enum: FACT_TYPES },
    fact_text: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    ttl_days: { type: ['integer', 'null'] },
  },
};
```

`EXTRACT_SCHEMA` в `facts.js` использует его как `items`, `SUMMARY_SCHEMA` в `history-compress.js` — тоже:
`facts_to_memory: { type: 'array', items: FACT_ITEM_SCHEMA }`. В пункт 6 системного промпта суммаризатора добавить
`ttl_days` (целое число дней или null; для open_loop по умолчанию 30 — как в промпте извлечения фактов), потому что
в строгом режиме поле обязательно и модель должна знать, что в него писать.

`factsToCandidates` остаётся как есть: значения по умолчанию (`type || 'profile'`, `confidence ?? 0.7`) превращаются
из рабочей логики в страховку на случай режима `json_object`, где схема не гарантируется провайдером.

### Изменение 2: state_json — зафиксировать семь ключей плюс страховочное поле notes

```js
state_json: {
  type: 'object',
  additionalProperties: false,
  required: [
    'current_goal', 'current_task', 'decisions', 'rejected_options',
    'open_questions', 'constraints', 'next_steps', 'notes',
  ],
  properties: {
    current_goal: { type: ['string', 'null'] },
    current_task: { type: ['string', 'null'] },
    decisions: { type: 'array', items: { type: 'string' } },
    rejected_options: { type: 'array', items: { type: 'string' } },
    open_questions: { type: 'array', items: { type: 'string' } },
    constraints: { type: 'array', items: { type: 'string' } },
    next_steps: { type: 'array', items: { type: 'string' } },
    notes: { type: 'array', items: { type: 'string' } },
  },
},
```

Пояснения к решению:

- Строгий режим требует перечисления всех ключей в `required`; «отсутствие» значения выражается через `null` и
  пустые массивы — объявленные типы это уже позволяют, модель ничего не вынуждена выдумывать.
- `notes` — строгое поле-страховка вместо свободных ключей: «важное, не влезающее в семь полей». Потребитель
  печатает объект целиком, так что заметки попадают в промпт ровно так же, как раньше попадали свободные ключи.
  В системный промпт добавить одну фразу про назначение `notes` (использовать редко, только для существенного).
- Миграция данных НЕ нужна: старые строки `conversation_summaries` с произвольными ключами в jsonb остаются
  читаемыми — потребитель их просто печатает. Новая строгость действует только на свежие ответы модели.

### Изменение 3: проверить строгость и судьбу персонального responseFormat

После изменений 1–2 в схеме `history_summary` не остаётся свободных объектов — `prepareJsonSchema` должна вернуть
`strict: true`. Проверить это тестом. Настройку `historyCompression.responseFormat` оставить (легитимный
переключатель для провайдеров без поддержки `json_schema`), но уточнить её комментарий в `config/default.yaml`:
причина «схема содержит свободные поля» исчезает, остаётся только совместимость с провайдером.

## Риски и смягчения

- **Модель перестанет сообщать что-то, что раньше клала в свободные ключи.** Закрывается полем `notes` и фразой в
  промпте. На практике рабочие ключи уже перечислены в `properties` — потеря маловероятна.
- **Обязательный `ttl_days` в строгом режиме.** Модель может ставить ненужные TTL. Смягчение: инструкция в промпте
  («null, если факт бессрочный»), плюс существующая страховка `f.ttl_days ?? null` в `factsToCandidates`.
- **Режим `json_object` (фолбэк по конфигу) не гарантирует схему.** Существующие страховки в
  `summarizeColdHistory` (проверка типа `state_json`, `factsToCandidates` с значениями по умолчанию) сохраняются
  без изменений — поведение в этом режиме не ухудшается.

## Объём работ

Два файла кода без миграций: `src/pipeline/facts.js` (экспорт `FACT_ITEM_SCHEMA`, переиспользование в
`EXTRACT_SCHEMA`), `src/pipeline/history-compress.js` (строгая схема, две правки системного промпта). Плюс
комментарий в `config/default.yaml`, тесты и документация.

## План реализации

1. `src/pipeline/facts.js` — выделить и экспортировать `FACT_ITEM_SCHEMA`, перевести `EXTRACT_SCHEMA` на него.
   Поведение извлечения фактов не меняется (схема идентична).
2. `src/pipeline/history-compress.js` — `facts_to_memory: { type: 'array', items: FACT_ITEM_SCHEMA }`; строгий
   `state_json` с семью ключами и `notes`; правки `SUMMARY_SYSTEM`: `ttl_days` в пункте 6 и фраза про `notes`.
3. `config/default.yaml` — уточнить комментарий к `historyCompression.responseFormat` (только совместимость с
   провайдером, схема больше не требует послаблений).
4. Тесты — в `tests/llm-json-schema.test.mjs` (или рядом): `prepareJsonSchema(SUMMARY_SCHEMA)` возвращает
   `strict: true`; `factsToCandidates` корректно обрабатывает строгие элементы и (страховка) элементы без полей в
   режиме `json_object`; сборка дайджеста с заполненным `notes`.
5. **Обновление документации `docs/ai-bot-with-memory/` строго по правилам
   `docs/ai-bot-with-memory/00-documentation-principles.md`**: новая схема вписывается как единственное текущее
   состояние системы (настоящее время, без «было/стало»), согласованно во всех местах, где упоминаются `state_json`
   и `facts_to_memory` — `05-data-schema.md`, `08-prompts-and-models.md`, `10-operations.md`,
   `13-history-compression.md`.

## Что остаётся сделать на будущее (вне рамок этого предложения)

- **Машинное использование `state_json`**: сейчас объект только печатается в промпт. Фиксированные ключи открывают
  возможность кодовой логики поверх них — например, показывать `next_steps` в веб-интерфейсе или передавать
  `open_questions` проактивному контуру. Отдельное продуктовое решение.
- **Единая форма факта по всему проекту**: после появления `FACT_ITEM_SCHEMA` проверить остальные места, где
  упоминается форма факта-кандидата (песочница, инструменты администрирования), и перевести их на тот же экспорт.
- **Судьба `historyCompression.responseFormat`**: если фолбэк `json_object` за разумное время ни разу не
  понадобится, настройку можно удалить вместе с ветками-страховками — отдельным решением с проверкой провайдеров.
