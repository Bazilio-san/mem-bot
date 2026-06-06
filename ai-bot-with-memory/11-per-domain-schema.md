# 11. Слой схем `data` под домен

## Вкратце

Слой per-domain-схем — это рекомендованное и опциональное расширение контракта поля `data jsonb`. Он превращает
свободный `data jsonb` из «мешка произвольных ключей» в проверяемый контракт под каждый домен, не жертвуя
универсальностью таблицы `memory_items`. Для каждого домена и типа сущности задаётся закрытая JSON-схема полей `data` и
правило канонизации `entity_key`, которые единый механизм применяет при каждой записи факта. Слой подключается по
выбору: домены без сохранённой схемы продолжают работать с базовым вариантом, где `data` хранит произвольный JSON, а
`entity_key` остаётся свободной строкой.

## Зачем

В базовом варианте контракта поле `data` хранит произвольный JSON, а `entity_key` остаётся свободной строкой. Это удобно
для расширяемости, но делает `data` ненадёжным для машинной логики (нельзя гарантировать имена полей), а `entity_key` —
непредсказуемым идентификатором (то `quadratic_equations`, то `quadro`, и дедупликация по сущности рушится). Закрытая
схема под домен снова делает строгий режим OpenAI применимым (см. [08-prompts-and-models.md](08-prompts-and-models.md)).

---

## [DOMAIN-1] Как это работает на сквозном примере

Главная мысль: схема говорит, какие поля есть в `data`. Поэтому и модель при извлечении знает, что заполнять, и SQL при
выборке знает, что искать.

```text
СХЕМА домена = список сущностей + имена и типы полей data.
↓ при записи: из схемы строим СТРОГИЙ JSON-промпт → модель заполняет ровно эти поля → data проверен.
↓ при выборке: по domain_key грузим схему → знаем имена полей → фильтруем data через @> в SQL.
↓ в промпт идёт memory_text (текст), data остаётся для инструментов и фильтров.
```

Схема домена — обычный JSON-файл, который человек читает и правит:

```jsonc
{
  "domain_key": "flight_search",
  "title": "Поиск авиабилетов",
  "entities": [
    {
      "entity_type": "flight_preference",
      "entity_key": { "mode": "fixed_vocab",
        "vocabulary": ["departure", "cabin", "time", "airline"],
        "synonyms": { "departure": ["город вылета", "откуда", "вылет"], "time": ["ночные", "ночные рейсы"] } },
      "fields": {
        "preferred_departure_city": "string|null",
        "avoid": "string[]",
        "cabin_class": "economy|comfort|business|null"
      }
    },
    {
      "entity_type": "trip",
      "entity_key": { "mode": "slug" },
      "fields": {
        "origin": "string|null", "destination": "string",
        "date": "string|null", "passengers": "integer",
        "status": "searching|selected|booked|cancelled"
      }
    }
  ]
}
```

Когда пользователь говорит «Не люблю ночные рейсы, обычно вылетаю из Казани», из `fields` собирается закрытая JSON-схема
(`additionalProperties:false`, все поля в `required`), к которой применим строгий режим OpenAI. Модель возвращает строго
проверенный объект:

```json
{ "entity_key": "departure",
  "memory_text": "Пользователь вылетает из Казани и не любит ночные рейсы",
  "data": { "preferred_departure_city": "Казань", "avoid": ["night_flights"], "cabin_class": null } }
```

При выборке знание схемы равно знанию имён полей, поэтому можно фильтровать прямо внутри `data` через оператор `@>` и
GIN-индекс `idx_memory_data_gin` — машинно, а не текстовым поиском:

```sql
SELECT entity_key, memory_text, data
FROM mem.memory_items
WHERE user_id = $1 AND entity_type = 'flight_preference'
  AND data @> '{"avoid": ["night_flights"]}';
```

---

## [DOMAIN-2] Как устроен слой

Контракт задаётся данными, а не кодом: добавление домена не требует правки исходников, только генерацию и сохранение
схемы. Составляющие:

- Миграция `migrations/004_domain_schemas.sql` с таблицей-реестром `mem.domain_schemas` (версионируемые определения; не
  более одной активной версии на домен).
- Модуль `src/schema/` из пяти файлов: `meta.js` (мета-схема), `registry.js` (загрузка, сохранение, список с кэшем),
  `generate.js` (LLM-генератор черновика по названию домена), `validate.js` (`validateAndCanonicalize`), `cli.js`
  (команды `generate | save | list | show`).
- Зависимость `ajv` (валидатор JSON-схем).
- Точка интеграции — функция `processCandidate` в `src/pipeline/merge.js`: перед поиском похожих идёт шаг
  `validateAndCanonicalize`, после которого `entity_key` уже канонический, а `data` — валидный.

```sql
CREATE TABLE IF NOT EXISTS mem.domain_schemas (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    domain_key  text NOT NULL,
    version     integer NOT NULL,
    status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','draft')),
    title       text NOT NULL,
    description text,
    definition  jsonb NOT NULL,        -- entities[].data_schema (закрытая JSON Schema) + словари entity_key
    created_by  text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (domain_key, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_schemas_active
ON mem.domain_schemas (domain_key) WHERE status = 'active';
```

Канонизация `entity_key` имеет три режима: `fixed_vocab` (ключ обязан быть из словаря; синонимы отображаются в
канонический; иначе берётся ближайший по эмбеддингу или ставится пометка проблемы), `slug` (транслитерация и нижний
регистр: «Стамбул» → `istanbul`) и `free` (свободный ключ без канонизации). Починка невалидного `data` идёт от дешёвого к
дорогому: сначала кодовая нормализация, и только если она не помогла — один дешёвый вызов модели «приведи объект к этой
схеме». При повторном провале факт сохраняется с пометкой `schema_invalid` и пониженной уверенностью.

---

## [DOMAIN-3] Что это даёт и какие риски

Выгоды: `entity_key` становится стабильным идентификатором (надёжная дедупликация), `data` — валидным по типам (его
безопасно читать инструментами и фильтровать в SQL), строгий режим OpenAI применим при извлечении. Домены без сохранённой
схемы работают со свободными `data` и `entity_key`.

Риски: качество генерации схемы моделью требует ручного ревью; рост словаря `fixed_vocab` надо мониторить; LLM-починку
включать только как второй уровень, иначе запись памяти подорожает; при смене схемы старые факты остаются в прежней форме
(отсюда версионирование); канонический ключ не отменяет эмбеддинги для случаев, где сущность не определена.

---

## Связанные документы

- Свободный `data` — [06-memory.md](06-memory.md)
- Ограничение строгого режима — [08-prompts-and-models.md](08-prompts-and-models.md)
