# Предложение: слой схем `data` под домен — генерация, валидация, канонизация

**Статус:** проект (не реализовано). **Дата:** 2026-06-06.
**Контекст:** universal-таблица `mem.memory_items` хранит произвольный `data jsonb` и свободный
`entity_key`. Это удобно для расширяемости, но делает `data` ненадёжным для машинной логики, а
`entity_key` — непредсказуемым идентификатором. Предложение добавляет per-domain контракт: для
каждого домена и типа сущности задаётся закрытая схема `data` и правила канонизации `entity_key`,
которые универсальный механизм применяет при каждой записи факта.

---

## 1. Цель и пользовательский сценарий

Пользователь хочет подключить новый домен, например «Поиск и покупка авиабилетов», и получить
для него надёжную структуру памяти без ручного написания SQL и схем.

Целевой поток:

```text
1. Запускаю генератор:   node src/schema/cli.js generate "Поиск и покупка авиабилетов" --key flights
2. LLM придумывает черновик схемы → файл schemas/flights.draft.json
3. Я открываю файл, проверяю, правлю поля/типы/словари entity_key, сохраняю
4. Запускаю сохранение:  node src/schema/cli.js save schemas/flights.draft.json
5. Утилита валидирует черновик, пишет активную версию в БД (mem.domain_schemas)
6. Дальше при каждой записи факта универсальный механизм validateAndCanonicalize
   проверяет data по схеме и приводит entity_key к словарю — автоматически, для любого домена
```

Принцип: **таблица остаётся универсальной, контракт задаётся данными (схемой домена), а не кодом.**
Добавление домена не требует правки исходников — только генерация и сохранение схемы.

---

## 2. Где и как хранить схемы

Используется гибрид «файлы как черновик/исходник + БД как источник истины во время выполнения».

### 2.1. Файлы черновиков

Каталог `schemas/` в репозитории. Генератор пишет туда `*.draft.json`, пользователь редактирует
руками (удобно ревьюить и держать в git). Файл — только промежуточная форма; рантайм его не читает.

### 2.2. Таблица реестра схем (источник истины)

Новая миграция `migrations/002_domain_schemas.sql`:

```sql
CREATE TABLE IF NOT EXISTS mem.domain_schemas (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    domain_key    text NOT NULL,                 -- 'flights' (может отсутствовать в agent_domains до сохранения)
    version       integer NOT NULL,              -- растёт при каждом save
    status        text NOT NULL DEFAULT 'active' -- 'active' | 'archived' | 'draft'
                  CHECK (status IN ('active','archived','draft')),
    title         text NOT NULL,
    description   text,
    definition    jsonb NOT NULL,                -- полное определение домена (см. раздел 3)
    created_by    text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (domain_key, version)
);

-- Не более одной активной версии на домен.
CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_schemas_active
ON mem.domain_schemas (domain_key) WHERE status = 'active';

COMMENT ON TABLE mem.domain_schemas IS 'Версионированные схемы data и правила канонизации entity_key по доменам.';
COMMENT ON COLUMN mem.domain_schemas.definition IS 'JSON: entities[].data_schema (закрытая JSON Schema), entity_key словари, примеры.';
```

Связь с существующим `mem.agent_domains`: `domain_key` совпадает. При сохранении схемы домена,
которого ещё нет в `agent_domains`, утилита заодно вставляет туда строку (как сейчас делает
`migrations/001_init.sql` для базовых доменов).

### 2.3. Версионирование

`save` всегда создаёт новую `version = max+1` и переводит её в `active`, а прежнюю активную — в
`archived`. Так факты, записанные по старой схеме, остаются прослеживаемыми (в `memory_items.metadata`
можно сохранять `schema_version`, по которой факт валидировался).

---

## 3. Формат определения домена (`definition`)

Один объект на домен. Это и есть то, что генерирует LLM и что правит пользователь.

```jsonc
{
  "domain_key": "flights",
  "title": "Поиск и покупка авиабилетов",
  "description": "Перелёты, маршруты, предпочтения по рейсам, пассажиры, документы.",
  "allowed_memory_kinds": ["preference", "constraint", "goal", "state", "history", "secure_reference"],
  "entities": [
    {
      "entity_type": "flight_preference",
      "description": "Устойчивые предпочтения пользователя по перелётам.",
      "entity_key": {
        "mode": "fixed_vocab",                 // fixed_vocab | slug | free
        "vocabulary": ["general", "departure", "cabin", "airline"],
        "synonyms": {
          "departure": ["вылет", "город вылета", "откуда"],
          "cabin": ["класс", "класс обслуживания"]
        }
      },
      "data_schema": {                          // ЗАКРЫТАЯ JSON Schema (additionalProperties:false)
        "type": "object",
        "additionalProperties": false,
        "required": ["preferred_departure_city", "avoid", "cabin_class"],
        "properties": {
          "preferred_departure_city": { "type": ["string", "null"] },
          "avoid": { "type": "array", "items": { "type": "string", "enum": ["night_flights", "long_layovers", "connections"] } },
          "cabin_class": { "type": ["string", "null"], "enum": ["economy", "comfort", "business", null] }
        }
      }
    },
    {
      "entity_type": "trip",
      "description": "Текущая или планируемая поездка.",
      "entity_key": { "mode": "slug" },         // ключ = slug от пункта назначения, напр. 'istanbul'
      "data_schema": {
        "type": "object",
        "additionalProperties": false,
        "required": ["origin", "destination", "date", "passengers", "status"],
        "properties": {
          "origin": { "type": ["string", "null"] },
          "destination": { "type": "string" },
          "date": { "type": ["string", "null"], "description": "ISO дата или null" },
          "passengers": { "type": "integer", "minimum": 1 },
          "status": { "type": "string", "enum": ["searching", "selected", "booked", "cancelled"] }
        }
      }
    },
    {
      "entity_type": "passenger",
      "description": "Пассажир (ссылка на защищённые данные, без полных значений).",
      "entity_key": { "mode": "slug" },         // 'passenger_anna'
      "data_schema": {
        "type": "object",
        "additionalProperties": false,
        "required": ["display_name", "has_document", "document_kind"],
        "properties": {
          "display_name": { "type": "string" },
          "has_document": { "type": "boolean" },
          "document_kind": { "type": ["string", "null"], "enum": ["passport", "international_passport", null] }
        }
      }
    }
  ]
}
```

Ключевые свойства формата:

- `data_schema` каждой сущности — **закрытая** (`additionalProperties:false`, все поля в `required`,
  типы и enum заданы). Именно это делает `data` машиночитаемым и снова совместимым со strict-режимом
  OpenAI при извлечении (раздел 6).
- `entity_key.mode` определяет, как приводить ключ к стабильному виду:
  - `fixed_vocab` — ключ обязан быть из `vocabulary`; синонимы маппятся в канонический;
  - `slug` — ключ нормализуется в slug (транслитерация + нижний регистр + дефисы);
  - `free` — старое свободное поведение (обратная совместимость).

---

## 4. Универсальный модуль: структура файлов

```text
schemas/                         черновики и утверждённые определения доменов (для ревью/git)
  flights.draft.json
migrations/002_domain_schemas.sql
src/schema/
  meta.js        мета-схема определения домена (валидация самой схемы) + ajv-настройка
  registry.js    загрузка/сохранение/список активных схем + кэш
  generate.js    LLM-генератор черновика по названию домена
  validate.js    validateAndCanonicalize: проверка data + канонизация entity_key
  cli.js         команды: generate | save | list | show
```

Новая зависимость: `ajv` (валидатор JSON Schema) — единственная внешняя.

### 4.1. `registry.js` — доступ к схемам

```text
loadDomainDefinition(domainKey) -> definition | null      (из mem.domain_schemas, status='active', с кэшем)
getEntitySpec(domainKey, entityType) -> {data_schema, entity_key} | null
saveDomainDefinition(definition, {createdBy}) -> {version} (валидирует meta, бампит версию, активирует)
listDomains() -> [{domain_key, title, version, entity_types}]
```

Кэш в памяти процесса (как `domainCache` в `src/repo.js`), сбрасывается при `save`.

### 4.2. `meta.js` — мета-схема

Закрытая JSON Schema, описывающая сам объект `definition` из раздела 3. Используется на двух этапах:
при `save` (проверить, что человек не сломал файл руками) и в генераторе (заставить LLM вернуть
корректную форму). Проверяет: наличие `domain_key`/`title`/`entities`, у каждой сущности —
валидный `entity_type`, корректный `entity_key.mode`, и что `data_schema` сама является валидной
закрытой схемой (`additionalProperties:false`, непустой `required`).

---

## 5. Генератор схемы (LLM)

`src/schema/generate.js`, функция `generateDomainDraft({ title, key, description, samples })`.

Вход: название домена (обязательно), ключ, опционально описание и 2–3 примера реплик пользователя
для этого домена (помогают модели угадать сущности и поля).

Промпт (системное сообщение) задаёт модели роль проектировщика схемы и требует на выходе объект
`definition` по мета-схеме. Поскольку форма выхода известна и закрыта, здесь strict-режим применим —
но для совместимости с прокси используем тот же приём `chatJSON` (json_object + схема в промпте,
см. `src/llm.js`).

Существенные инструкции в промпте:

```text
Ты проектируешь схему долговременной памяти для домена агента.
По названию и описанию домена предложи:
- 2–5 типов сущностей (entity_type), которые реально стоит запоминать;
- для каждой сущности ЗАКРЫТУЮ JSON Schema поля data: additionalProperties:false,
  все поля в required, конкретные типы, где уместно — enum;
- правило формирования entity_key: fixed_vocab со словарём и синонимами, либо slug;
- список допустимых memory_kind для домена.
Не добавляй чувствительные значения в data — для них entity_type со ссылкой
(has_document/document_kind), а полные данные идут в secure_records.
Верни только объект definition по мета-схеме.
```

CLI пишет результат в `schemas/<key>.draft.json` и печатает краткую сводку (сущности и их поля),
чтобы пользователь сразу видел, что ревьюить.

---

## 6. Применение схемы при записи факта (универсальный механизм)

Главное место интеграции — контур записи памяти `src/pipeline/merge.js`, функция `processCandidate`.
Добавляется шаг `validateAndCanonicalize` перед поиском похожих и сохранением.

### 6.1. `validate.js` — что делает

```text
validateAndCanonicalize(domainKey, candidate) -> {
  ok: boolean,
  candidate: <возможно исправленный кандидат>,
  issues: [...],
  schema_version
}
```

Алгоритм:

```text
1. spec = getEntitySpec(domainKey, candidate.entity_type)
2. Если spec нет (домен/сущность без схемы):
   → вернуть candidate как есть, ok=true, режим обратной совместимости (как сейчас).
3. Валидация candidate.data по spec.data_schema (ajv).
   - Валидно            → перейти к канонизации.
   - Невалидно          → попытка починки (см. 6.2). Не удалось → ok=false, понизить confidence,
                          пометить metadata.schema_invalid и issues; решение о сохранении — по правилам merge.
4. Канонизация entity_key по spec.entity_key.mode:
   - fixed_vocab: точное совпадение со словарём → ок; иначе поиск по synonyms; иначе
     ближайший по эмбеддингу к словарю (порог) → канонический; иначе issues + fallback на slug.
   - slug: транслитерация + нижний регистр + дефисы (kvadratnye → 'kvadratnye', 'Стамбул' → 'istanbul').
   - free: оставить как есть.
5. Вернуть исправленный candidate (нормализованные data и entity_key) + schema_version.
```

### 6.2. Починка невалидного `data`

Два уровня, от дешёвого к дорогому:

- **Кодовая нормализация**: отбросить лишние ключи, привести очевидные типы (строка-число → число,
  одиночное значение → массив, если схема ждёт массив), подставить `null` для отсутствующих
  необязательных. Покрывает большинство расхождений без модели.
- **LLM-починка** (опционально, только если кодовая не помогла): один дешёвый вызов «приведи этот
  объект к данной JSON Schema» с `gpt-5.4-nano`. Результат снова валидируется; при повторном провале
  факт сохраняется в режиме совместимости с пометкой `schema_invalid` и пониженной уверенностью —
  данные не теряются, но и не выдаются за валидные.

### 6.3. Точка интеграции (псевдо-дифф `merge.js`)

```text
export async function processCandidate(userId, domainKey, candidate, sourceConversationId) {
  // приватность как сейчас ...
+ const v = await validateAndCanonicalize(domainKey, candidate);
+ candidate = v.candidate;                       // нормализованные data + entity_key
+ // schema_version и issues положить в metadata при вставке
  const similar = await findSimilar(userId, candidate);
  const { decision, targetId } = decideMerge(candidate, similar);
  ...
}
```

После этого шага `entity_key` уже канонический, поэтому дедупликация по `(entity_type, entity_key)`
в `findSimilar`/`decideMerge` становится надёжной — исчезает проблема «`quadro` вместо
`quadratic_equations`». Текстовое и векторное сходство остаются как дополнительный сигнал.

### 6.4. Связь с извлечением

`src/pipeline/extract.js` можно усилить: если у домена есть схема, в промпт извлечения подставляются
доступные `entity_type` и их поля. Тогда модель сразу заполняет `data` по контракту, и доля
валидных кандидатов растёт, а починка нужна реже. Это необязательный, но желательный шаг.

---

## 7. Команды CLI

```bash
# Сгенерировать черновик схемы домена (LLM)
node src/schema/cli.js generate "Поиск и покупка авиабилетов" --key flights \
  --desc "перелёты, маршруты, пассажиры" --sample "ищу билет из Казани" --sample "не люблю ночные рейсы"
# → schemas/flights.draft.json (пользователь правит руками)

# Сохранить утверждённый черновик в реестр (валидация + новая активная версия)
node src/schema/cli.js save schemas/flights.draft.json

# Список доменов и их активных версий
node src/schema/cli.js list

# Показать активную схему домена
node src/schema/cli.js show flights
```

В `package.json` добавляются скрипты `schema:generate` / `schema:save` / `schema:list` для удобства.

---

## 8. Обратная совместимость и миграция

- Домены **без** сохранённой схемы работают как сейчас (свободный `data`, режим `free` для
  `entity_key`). Слой включается только там, где схема есть. Ничего не ломается.
- Существующие факты не переписываются. При желании отдельная фоновая задача (по аналогии с
  `memory_cleanup` в `scheduled_tasks`) может пройтись по старым фактам домена и привести их к новой
  схеме через `validateAndCanonicalize`, записав `schema_version`.
- В `memory_items.metadata` у каждого нового факта хранится `{ schema_version, schema_invalid? }` —
  видно, по какой версии контракта он записан.

---

## 9. Что нужно сделать (чек-лист реализации)

```text
1. migrations/002_domain_schemas.sql      — таблица реестра + индексы.
2. npm i ajv                              — валидатор JSON Schema.
3. src/schema/meta.js                     — мета-схема определения домена.
4. src/schema/registry.js                 — load/save/list/getEntitySpec + кэш.
5. src/schema/generate.js                 — LLM-генератор черновика.
6. src/schema/validate.js                 — validateAndCanonicalize (валидация + канонизация + починка).
7. src/schema/cli.js                      — команды generate/save/list/show.
8. Интеграция в src/pipeline/merge.js     — шаг validateAndCanonicalize в processCandidate.
9. (опц.) src/pipeline/extract.js         — подстановка entity_type/полей домена в промпт извлечения.
10. tests/schema.test.js                  — генерация на «Поиск и покупка авиабилетов»,
    валидация валидных/битых data, канонизация entity_key (vocab/slug), обратная совместимость.
```

---

## 10. Риски и ограничения

- **Качество генерации.** LLM может предложить неполный или избыточный набор полей. Поэтому шаг
  ручного ревью обязателен; генератор — помощник, а не финальный авторитет.
- **Рост словаря `fixed_vocab`.** Если реальные данные шире словаря, канонизация будет часто
  попадать в «ближайший по эмбеддингу» или fallback. Нужен мониторинг `issues` и периодическое
  расширение словаря (можно отдельной утилитой, агрегирующей незаканонизированные ключи).
- **Стоимость починки.** LLM-починку включать только как второй уровень; основная масса расхождений
  должна закрываться кодовой нормализацией, иначе запись памяти подорожает.
- **Дрейф схемы.** При смене `data_schema` старые факты остаются в прежней форме. Версионирование и
  поле `schema_version` дают прослеживаемость; полное переописание — отдельная осознанная операция.
- **Не отменяет эмбеддинги.** Канонический `entity_key` делает дедуп по сущности надёжным, но
  смысловое сходство (эмбеддинги/текст) остаётся для случаев, где сущность не определена или ключи
  всё же разошлись.

---

## 11. Итог

Предложение превращает `data` из «мешка произвольных ключей» в проверяемый per-domain контракт, не
жертвуя универсальностью таблицы. Схема домена генерируется LLM, ревьюится человеком, версионируется
в `mem.domain_schemas` и применяется единым механизмом `validateAndCanonicalize` при каждой записи.
В результате `entity_key` становится стабильным идентификатором (надёжная дедупликация и обновление
вместо дублей), `data` — валидным по типам (его можно безопасно читать инструментами и фильтровать
в SQL), а добавление нового домена сводится к двум командам CLI плюс ручное ревью, без правки кода.
```
