# 03. Быстрый старт и структура проекта

## Вкратце

Нужны Node.js 22+ и PostgreSQL 16 с расширениями `pgvector` и `pgcrypto`. После заполнения `.env` и запуска миграции
бот готов: интерактивный чат `npm run chat`, воркер напоминаний и проактивности `npm run scheduler`, проверки `npm test`.
Проактивность включается флагами окружения и по умолчанию выключена.

## Зачем порядок важен

Сначала фундамент и проверка структуры, потом поведение. База памяти должна существовать и проходить проверку структуры
до того, как писать логику пайплайна.

---

## [QS-1] Требования окружения

- Node.js 22 и новее, тип модулей ESM (`"type": "module"` в `package.json`).
- PostgreSQL 16 с расширениями `pgvector` (смысловой поиск по эмбеддингам) и `pgcrypto` (генерация UUID и хеши).
- Заполненный `.env`: строка подключения к базе (`DATABASE_URL`), ключ и адрес LLM-прокси (`OPENAI_API_KEY`,
  `OPENAI_BASE_URL`), секрет шифрования `AUTH_SECRET`. Опционально — переопределение моделей и базы.

---

## [QS-2] Команды

```bash
npm install            # установка зависимостей: openai, pg, dotenv
npm run migrate        # создаёт базу agent_mem, схему mem, все таблицы и индексы (идемпотентно)
npm run chat           # интерактивный чат в терминале
npm run scheduler      # воркер планировщика напоминаний и проактивности
npm test               # полный прогон проверок
npm run check:llm      # проверка моделей через LLM-прокси
npm run check:streaming # проверка потоковой отдачи прокси (текст частями и дельты вызовов инструментов)
```

Потоковый ответ модели включён по умолчанию: ядро выдаёт финальный текст по частям и испускает абстрактные события хода
обработки через callback `onEvent` (см. [ARCH-7] в [04-architecture.md](04-architecture.md)). Выключатель — переменная
окружения `LLM_STREAMING_ENABLED` (по умолчанию включено); при её выключении ядро работает тем же контуром без потоковой
обратной связи.

Управление схемами `data` под домен (см. [11-per-domain-schema.md](11-per-domain-schema.md)): `npm run schema:generate -- "<название>" --key <ключ>`
создаёт черновик в `schemas/<ключ>.draft.json`; после ручного ревью `npm run schema:save -- schemas/<файл>` сохраняет его
активной версией в реестр; `npm run schema:list` и `npm run schema:show -- <ключ>` показывают активные схемы.

В интерактивном чате доступны команды: `/domain <ключ>` — сменить специализацию. Базовым доменом служит `general`, а
такие домены, как `flight_search`, `joke_teller` и `math_tutor`, приведены лишь как иллюстративные примеры специализаций:
конкретный набор доменов задаётся самим проектом и не является обязательной частью требования. Далее доступны команды
`/tick` — прогнать планировщик вручную; `/proactive <тип>` — вручную проверить проактивный повод; `/exit` — выход.
Администратору доступны команды глобальной памяти: `/fact-add <текст>`,
`/fact-list`, `/fact-del <id>` для глобальных фактов и `/kb-add <текст>`, `/kb-find <запрос>`, `/kb-del <id>` для общей
базы знаний (поиск `/kb-find` доступен всем пользователям).

Включение проактивности у пользователя и выбор поводов выполняются через программный API (`setUserProactivity`,
`setTrigger`, `getProactivityState`), который проект-потребитель отображает в команды и меню своего канала доставки.

---

## [QS-3] Флаги проактивности (по умолчанию всё выключено)

| Переменная | Назначение | По умолчанию |
|------------|------------|--------------|
| `COMPANION_MODE` | настрой момента (период суток, пауза, тон) и тематический контекст в ответах плюс извлечение тем; дата/время/часовой пояс передаются всегда независимо от флага | должно включаться флагом, по умолчанию выключено |
| `PROACTIVE_ENABLED` | глобальный выключатель проактивного контура (триггеры, анти-спам, доставка); сверх него каждый пользователь включает проактивность сам через программный API (`setUserProactivity`) | должно включаться флагом, по умолчанию выключено |
| `PROACTIVE_EVENTS_ENABLED` | контур внешних событий (требует `PROACTIVE_ENABLED`) | должно включаться флагом, по умолчанию выключено |
| `PROACTIVE_INTERVAL_MS` | как часто воркер проверяет триггеры | 300000 (5 минут) |
| `PROACTIVE_INACTIVITY_MIN` | порог молчания для триггера `inactivity` | 1440 |
| `PROACTIVE_CHECKIN_HOUR` | час ежедневного приветствия | 10 |
| `PROACTIVE_GOAL_INTERVAL_MIN` | интервал напоминания о целях | 2880 |
| `PROACTIVE_WELCOME_GAP_MIN` | пауза, после которой пользователь считается вернувшимся | 60 |
| `NEWS_RELEVANCE_THRESHOLD` | порог релевантности внешнего события | 0.6 |

Пример включения всего набора собеседника:

```bash
COMPANION_MODE=on PROACTIVE_ENABLED=on PROACTIVE_EVENTS_ENABLED=on npm run scheduler
```

---

## [QS-4] Флаги поджатия истории (по умолчанию выключено)

| Переменная | Назначение | По умолчанию |
|------------|------------|--------------|
| `HISTORY_COMPRESSION_ENABLED` | слой сжатой истории диалога (`HISTORY_CONTEXT` поверх горячего окна) | должно включаться флагом, по умолчанию выключено |
| `HISTORY_HOT_WINDOW` | сколько последних сообщений уходит в запрос дословно | 8 |
| `HISTORY_MAX_TOKENS` | порог размера холодной зоны, при превышении запускается сжатие | 2000 |
| `HISTORY_SHRINK_TOKENS` | целевой размер дайджеста после сжатия (должен быть меньше `HISTORY_MAX_TOKENS`) | 800 |
| `HISTORY_ZONE_WEIGHTS` | доли бюджета дайджеста на ближнюю, среднюю и дальнюю зоны | 0.55,0.30,0.15 |
| `HISTORY_SUMMARY_MODEL` | модель суммаризатора истории (по умолчанию `<AUX_MODEL>`) | `<AUX_MODEL>` |
| `HISTORY_MIN_COMPRESS_GAIN` | минимальный выигрыш сжатия, ниже которого пересжатие не выполняется | 0.35 |

Подробный разбор слоя — в [13-history-compression.md](13-history-compression.md).

---

## [QS-4a] Флаги глобальной памяти (по умолчанию выключено)

| Переменная | Назначение | По умолчанию |
|------------|------------|--------------|
| `GLOBAL_MEMORY_ENABLED` | всегда-включённые глобальные факты (блок `GLOBAL_FACTS`) и их инструменты | должно включаться флагом, по умолчанию выключено |
| `GLOBAL_FACTS_LIMIT` | сколько глобальных фактов подмешивать в каждый запрос | 5 |
| `GLOBAL_RAG_ENABLED` | общая база знаний (блок `GLOBAL_KNOWLEDGE`) и её инструменты | должно включаться флагом, по умолчанию выключено |
| `GLOBAL_RAG_LIMIT` | сколько фрагментов базы знаний подмешивать по релевантности | 5 |
| `GLOBAL_RAG_MIN_RELEVANCE` | порог релевантности: фрагменты слабее порога в контекст не идут | 0.3 |

Флаги независимы: можно включить только постоянные факты, только базу знаний, оба сразу или ничего. Запись в глобальную
память доступна только администратору (пометка `is_admin` в `mem.users`). Подробный разбор слоя — в
[14-global-memory.md](14-global-memory.md).

---

## [QS-5] Структура каталогов

```text
migrations/001_init.sql      схема памяти: базовые таблицы, типы, индексы, базовые домены
migrations/002_proactive.sql три таблицы проактивности (темы, триггеры, доставленные события)
migrations/003_history_summaries.sql  служебные колонки conversation_summaries для сжатой истории
migrations/005_global_memory.sql  две таблицы глобальной памяти, колонка is_admin, засев базовых фактов
migrations/006_domain_schemas.sql  таблица-реестр схем data под домен (версионируемые определения)
schemas/                     схемы data под домен как исходный текст (*.json) для ревью и git
src/config.js                конфигурация, выбор моделей и флаги проактивности (из .env)
src/db.js                    пул подключений PostgreSQL плюс помощник vectorToSql
src/llm.js                   клиент LLM: чат, строгий JSON (chatJSON), эмбеддинги
src/migrate.js               бутстрап базы и применение миграций
src/repo.js                  пользователи, домены, диалоги, сообщения, журнал инструментов, помощники проактивности
src/agent.js                 главный пайплайн ответа (handleMessage) с ветками собеседника под флагами
src/cli.js                   интерактивный чат в терминале
src/scheduler-run.js         воркер планировщика и проактивности
src/utils/temporal.js        темпоральный контекст (критерий 14)
src/pipeline/classify.js     этап 1: классификация запроса
src/pipeline/retrieve.js     выборка памяти, ранжирование, минимизация, сборка MEMORY_CONTEXT
src/pipeline/extract.js      извлечение кандидатов в память и тем после ответа
src/pipeline/merge.js        фильтр приватности, поиск похожих, дедупликация, запись
src/pipeline/secure.js       защищённая память: шифрование, согласие, маскирование
src/pipeline/scheduler.js    создание задач, воркер, повторы, перепланирование
src/pipeline/tools.js        реестр инструментов: сборка definitions, права, журналирование, вызов handler
src/pipeline/agent-tools/    по одному модулю на инструмент: title, definition и handler
src/pipeline/admin.js        просмотр и удаление памяти пользователем, проверка прав администратора (isAdmin)
src/pipeline/global-memory.js  глобальная память: факты (always-on) и общая база знаний (RAG) (критерии 19–21)
src/pipeline/topics.js       тематический трекинг (критерий 13)
src/pipeline/proactive.js    триггеры проактивности и анти-спам (критерии 15, 16)
src/pipeline/proactiveMessage.js  генератор проактивного сообщения
src/pipeline/events.js       внешние события и фильтр релевантности (критерий 17)
src/pipeline/history-context.js   сборка справочного блока HISTORY_CONTEXT (критерий 18)
src/pipeline/history-compress.js  решение о сжатии и вызов суммаризатора холодной зоны
src/pipeline/token-counter.js     консервативная оценка числа токенов (estimateTokens)
src/schema/meta.js           мета-схема определения домена и общий валидатор ajv
src/schema/registry.js       загрузка, сохранение, список схем доменов с кэшем (getEntitySpec)
src/schema/validate.js       validateAndCanonicalize: валидация data и канонизация entity_key
src/schema/generate.js       LLM-генератор черновика схемы по названию домена
src/schema/cli.js            команды управления схемами: generate, save, list, show
tests/run.js                 комплексная проверка по слоям (базовый слой плюс слои проактивности, поджатия истории и глобальной памяти)
tests/memory_cases.json      набор кейсов извлечения фактов
tests/schema.test.js         проверка слоя схем data под домен (npm run test:schema)
tests/check-llm.js           проверка доступности и возможностей моделей через прокси
```

---

## [QS-6] Сборка с нуля (порядок)

1. **Фундамент.** Поднять Node.js 22 и PostgreSQL 16 с расширениями. Завести `package.json` (ESM, зависимости `openai`,
   `pg`, `dotenv`) и `.env`.
2. **Схема памяти.** Написать `migrations/001_init.sql` (см. [05-data-schema.md](05-data-schema.md)), сделать миграцию
   идемпотентной, реализовать `src/migrate.js`. Проверить структуру до написания логики.
3. **Инфраструктура.** `src/db.js`, `src/config.js`, `src/llm.js`, `src/repo.js`.
4. **Выборка памяти.** `src/pipeline/retrieve.js` — см. [06-memory.md](06-memory.md).
5. **Контур записи.** `src/pipeline/extract.js` и `src/pipeline/merge.js` — см. [06-memory.md](06-memory.md).
6. **Приватность.** `src/pipeline/secure.js` — см. [07-secure-privacy.md](07-secure-privacy.md).
7. **Планировщик.** `src/pipeline/scheduler.js` и воркер — см. [10-operations.md](10-operations.md).
8. **Инструменты и агент.** Модули `src/pipeline/agent-tools/*`, реестр `src/pipeline/tools.js` и `src/agent.js` —
   см. [04-architecture.md](04-architecture.md). Управление своей памятью пользователю доступно прямо в диалоге:
   инструменты `memory_list`, `memory_forget_entity` и `memory_forget_all` (поверх `src/pipeline/admin.js`) — см.
   [06-memory.md](06-memory.md).
9. **Проверки.** `tests/run.js` по слоям — см. [10-operations.md](10-operations.md).
10. **Проактивность.** Миграция `002`, модули `topics`, `temporal`, `proactive`, `events`, ветки в `agent.js` под
    флагами — см. [09-proactivity.md](09-proactivity.md). Код — каталог `src/`.
11. **Поджатие истории.** Миграция `003`, модули `token-counter`, `history-compress`, `history-context`, заполнение
    `token_count` в `saveMessage` и сборка `HISTORY_CONTEXT` в `agent.js` под флагом — см.
    [13-history-compression.md](13-history-compression.md).
12. **Глобальная память.** Миграция `005`, модуль `global-memory`, функция `isAdmin` в `admin.js`, модули
    инструментов и проверка прав в `tools.js`, сборка блоков `GLOBAL_FACTS` и `GLOBAL_KNOWLEDGE` в `agent.js` под
    флагами — см.
    [14-global-memory.md](14-global-memory.md).

---

## Связанные документы

- Полный DDL — [05-data-schema.md](05-data-schema.md)
- Конфигурация и выбор моделей — [08-prompts-and-models.md](08-prompts-and-models.md)
- Проактивность — [09-proactivity.md](09-proactivity.md)
- Поджатие истории диалога — [13-history-compression.md](13-history-compression.md)
- Глобальная память — [14-global-memory.md](14-global-memory.md)
