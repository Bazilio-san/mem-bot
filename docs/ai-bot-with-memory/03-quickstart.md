# 03. Быстрый старт и структура проекта

## [QS-1] Требования окружения

- Node.js 22 и новее, тип модулей ESM (`"type": "module"` в `package.json`).
- PostgreSQL 16 с расширениями `pgvector` (смысловой поиск по эмбеддингам) и `pgcrypto` (генерация UUID и хеши).
- Заполненный `config/local.yaml`: параметры подключения к базе (`config.db.postgres.dbs.main.*`), ключ доступа к
  модели `config.llm.apiKey` и секрет шифрования `config.authSecret`. Значение `config.llm.baseURL` задаётся только если
  нужен OpenAI-совместимый прокси; без него используется прямой OpenAI API. Опционально — переопределение моделей и
  параметров базы. Конфигурация строится пакетом `node-config` из каталога `config/`: `config/default.yaml` задаёт
  значения по умолчанию, файл окружения (выбирается по `NODE_ENV`) их переопределяет, а локальные секреты лежат в
  `config/local.yaml`; любое значение можно переопределить и одноимённой переменной окружения.

---

## [QS-2] Команды

```bash
npm install            # установка зависимостей: openai, pg, config, af-db-ts, dotenv
npm run migrate        # создаёт базу, расширения pgcrypto и vector, схемы mem и log, все таблицы и индексы (идемпотентно)
npm run chat           # интерактивный чат в терминале
npm run scheduler      # воркер планировщика напоминаний и проактивности
npm test               # полный прогон проверок
npm run check:llm      # проверка моделей через выбранный OpenAI-compatible endpoint
npm run check:streaming # проверка потоковой отдачи endpoint (текст частями и дельты вызовов инструментов)
```

Потоковый ответ модели включён по умолчанию: ядро выдаёт финальный текст по частям и испускает абстрактные события хода
обработки через callback `onEvent` (см. [ARCH-7] в [04-architecture.md](04-architecture.md)). Выключатель —
`config.streaming.enabled` (по умолчанию `true`); при значении `false` ядро работает тем же контуром без потоковой
обратной связи.

Управление skills (см. [11-per-domain-schema.md](11-per-domain-schema.md)): новый домен добавляется каталогом
`skills/<name>/` с файлом `SKILL.md` и при необходимости `domain-schema.json`. Команда `npm run skills:validate`
проверяет все skills; `npm run skills:list` показывает их домены, инструменты и наличие схемы; `npm run skills:sync`
заводит в справочнике `mem.agent_domains` строки соответствия `domain_key` → `domain_id` для новых доменов. Кроме
ручного редактирования файлов, навыки создаёт и правит администратор прямо в диалоге через инструментарий
редактирования навыков; он включается флагом `config.skills.authoring.enabled` и доступен только администраторам.

В интерактивном чате доступны команды: `/domain <ключ>` — сменить специализацию. Базовым доменом служит `general`, а
домены вроде `flight_search` и `math_tutor` приведены лишь как иллюстративные примеры специализаций: конкретный набор
skills задаётся самим проектом и не является обязательной частью требования. Далее доступны команды
`/tick` — прогнать планировщик вручную; `/exit` — выход.
Администратору доступны команды глобальной памяти: `/fact-add <текст>`,
`/fact-list`, `/fact-del <id>` для глобальных фактов и `/kb-add <текст>`, `/kb-find <запрос>`, `/kb-del <id>` для общей
базы знаний (поиск `/kb-find` доступен всем пользователям).

Включение проактивности у пользователя и выбор поводов выполняются через программный API (`setUserProactivity`,
`setTrigger`, `getProactivityState`), который проект-потребитель отображает в команды и меню своего канала доставки.

---

## [QS-3] Флаги проактивности и режима собеседника

| Путь в `config` | Назначение | По умолчанию |
|-----------------|------------|--------------|
| `companion.enabled` | стабильный prompt живого собеседника, настрой момента, тематический контекст, извлечение тем и companion-памяти; дата/время/часовой пояс передаются всегда независимо от флага | `true` |
| `proactive.enabled` | глобальный выключатель проактивного контура (триггеры, анти-спам, доставка); сверх него каждый пользователь включает проактивность сам через программный API (`setUserProactivity`) | `true` |
| `proactive.events.enabled` | контур внешних событий (требует `proactive.enabled`) | `false` |
| `proactive.intervalMs` | как часто воркер проверяет триггеры | `300000` (5 минут) |
| `proactive.inactivityMinutes` | порог молчания для триггера `inactivity` | `1440` |
| `proactive.checkinHour` | час ежедневного приветствия | `10` |
| `proactive.goalIntervalMinutes` | интервал напоминания о целях | `2880` |
| `proactive.welcomeBackGapMinutes` | пауза, после которой пользователь считается вернувшимся | `60` |
| `proactive.events.relevanceThreshold` | порог релевантности внешнего события | `0.6` |

Режим собеседника `companion.enabled` и проактивный контур `proactive.enabled` включены по умолчанию
(`config/default.yaml`). Переопределить их для конкретного окружения — например, выключить — можно в
`config/development.yaml`, `config/local.yaml` или одноимёнными переменными окружения при запуске воркера планировщика.
Контур внешних событий `proactive.events.enabled` по умолчанию выключен и включается отдельно:

```bash
# выключить собеседника и проактивность для этого запуска
COMPANION_MODE=false PROACTIVE_ENABLED=false npm run scheduler
# включить контур внешних событий
PROACTIVE_EVENTS_ENABLED=true npm run scheduler
```

---

## [QS-4] Флаги поджатия истории (по умолчанию включено)

| Путь в `config` | Назначение | По умолчанию |
|-----------------|------------|--------------|
| `historyCompression.enabled` | слой сжатой истории диалога (`HISTORY_CONTEXT` поверх горячего окна) | `true` |
| `historyCompression.hotWindow` | сколько последних сообщений уходит в запрос дословно | `8` |
| `historyCompression.maxTokens` | порог размера холодной зоны, при превышении запускается сжатие | `2000` |
| `historyCompression.shrinkTokens` | целевой размер дайджеста после сжатия (должен быть меньше `historyCompression.maxTokens`) | `800` |
| `historyCompression.zoneWeights` | доли бюджета дайджеста на ближнюю, среднюю и дальнюю зоны | `[0.55, 0.30, 0.15]` |
| `historyCompression.model` | модель суммаризатора истории (по умолчанию совпадает с `config.llm.auxModel`) | `gpt-5.4-nano` |
| `historyCompression.minCompressGain` | минимальный выигрыш сжатия, ниже которого пересжатие не выполняется | `0.35` |


---

## [QS-4a] Флаги глобальной памяти (по умолчанию включено)

| Путь в `config` | Назначение | По умолчанию |
|-----------------|------------|--------------|
| `globalMemory.factsEnabled` | всегда-включённые глобальные факты (блок `GLOBAL_FACTS`) и их инструменты | `true` |
| `globalMemory.factsLimit` | сколько глобальных фактов подмешивать в каждый запрос | `5` |
| `globalMemory.ragEnabled` | общая база знаний (блок `GLOBAL_KNOWLEDGE`) и её инструменты | `true` |
| `globalMemory.ragLimit` | сколько фрагментов базы знаний подмешивать по релевантности | `5` |
| `globalMemory.ragMinRelevance` | порог релевантности: фрагменты слабее порога в контекст не идут | `0.3` |

Флаги независимы: можно включить только постоянные факты, только базу знаний, оба сразу или ничего. Запись в глобальную
[14-global-memory.md](14-global-memory.md).

---

## [QS-4b] Флаги журнала обращений к модели (по умолчанию включено)

| Путь в `config` | Назначение | По умолчанию |
|-----------------|------------|--------------|
| `llmLog.enabled` | запись обращений к модели в схему `log`; при `false` эмиттер становится пустышкой и ничего не пишет | `true` |
| `llmLog.batchSize` | размер пакета фоновой выгрузки буфера в базу (число записей за один `INSERT`) | `200` |
| `llmLog.flushIntervalMs` | период фоновой выгрузки буфера в базу (миллисекунды) | `1000` |
| `llmLog.maxPayloadChars` | предельная длина сериализованного `payload`; сверх неё — усечение и `payload_truncated = true` | `100000` |

Журнал устроен и работает так, как описано в [10-operations.md](10-operations.md), раздел [OPS-5]; схема таблиц — в
[05-data-schema.md](05-data-schema.md), раздел [DATA-12].

---

## [QS-5] Структура каталогов

```text
migrations/001_init.sql      единая инициализация: схемы mem и log, все таблицы, типы, индексы, триггеры, базовые домены
skills/                      реестр skills: по каталогу на домен (SKILL.md, domain-schema.json, references/)
config/                      дерево конфигурации node-config: default.yaml, файлы окружения, local.yaml, карта переменных
src/config.js                снимок дерева config (node-config): выбор моделей, флаги и параметры подключения к БД
src/db.js                    доступ к PostgreSQL через af-db-ts плюс помощник vectorToSql
src/llm.js                   клиент LLM: чат, строгий JSON (chatJSON), эмбеддинги
src/migrate.js               бутстрап базы и применение миграций
src/repo.js                  пользователи, домены, диалоги, сообщения, журнал инструментов, помощники проактивности
src/agent.js                 главный пайплайн ответа (handleMessage) с ветками собеседника под флагами
src/cli.js                   интерактивный чат в терминале
src/scheduler-run.js         воркер планировщика и проактивности
src/utils/temporal.js        темпоральный контекст (критерий 14)
src/pipeline/classify.js     этап 1: классификация запроса (выбор skill)
src/pipeline/skills/parse.js     разбор SKILL.md на фронтматтер и markdown-блоки
src/pipeline/skills/registry.js  реестр skills: загрузка, валидация, доступ к prompt, схеме, справочникам
src/pipeline/skills/cli.js       команды управления skills: validate, list, sync
src/pipeline/skills/author.js    генераторы частей навыка моделью (черновик, prompt-блоки, схема)
src/pipeline/skills/writer.js    сборка SKILL.md, валидация, атомарная запись и горячая перезагрузка навыка
src/pipeline/skills/authoring-support.js  помощники инструментов редактирования навыков
src/pipeline/agent-tools/skill-authoring/  admin-инструменты создания и редактирования навыков (skill_author_*)
src/pipeline/retrieve.js     выборка памяти, ранжирование, минимизация, сборка MEMORY_CONTEXT
src/pipeline/extract.js      извлечение кандидатов в память, companion-памяти и тем после ответа
src/pipeline/merge.js        фильтр приватности, поиск похожих, дедупликация, запись
src/pipeline/memory-dedupe.js  смысловые dedupe_key, scoring, dry-run/apply очистки дублей
src/pipeline/secure.js       защищённая память: шифрование, согласие, маскирование
src/pipeline/scheduler.js    создание задач, воркер, повторы, перепланирование
src/pipeline/tools.js        реестр инструментов: сборка definitions, права, журналирование, вызов handler, initTools
src/pipeline/agent-tools/    по одному модулю на инструмент: title, definition и handler
src/mcp/config.js            чтение и разбор .mcp.json (список внешних MCP-серверов в формате MCP-клиента)
src/mcp/client.js            подключение к MCP-серверам, обёртка их инструментов под реестр, переподключение
.mcp.json                    конфигурация внешних MCP-серверов (вне контроля версий; может отсутствовать)
src/pipeline/admin.js        просмотр и удаление памяти пользователем, проверка прав администратора (isAdmin)
src/pipeline/global-memory.js  глобальная память: факты (always-on) и общая база знаний (RAG) (критерии 19–21)
src/pipeline/topics.js       тематический трекинг (критерий 13)
src/pipeline/proactive.js    триггеры проактивности и анти-спам (критерии 15, 16)
src/pipeline/proactiveMessage.js  генератор проактивного сообщения
src/pipeline/events.js       внешние события и фильтр релевантности (критерий 17)
src/pipeline/history-context.js   сборка справочного блока HISTORY_CONTEXT (критерий 18)
src/pipeline/history-compress.js  решение о сжатии и вызов суммаризатора холодной зоны
src/pipeline/token-counter.js     консервативная оценка числа токенов (estimateTokens)
src/pipeline/llm-log.js      журнал обращений к модели: буфер, пакетная выгрузка в схему log, типы запросов
src/pipeline/llm-pricing.js  расчёт стоимости обращения по прайс-листу моделей
src/pipeline/llm-usage-stats.js   агрегаты затрат поверх узкого журнала log.llm_usage
src/schema/meta.js           мета-схема определения домена и общий валидатор ajv
src/schema/registry.js       доступ к схеме домена и спецификации сущности через реестр skills (getEntitySpec)
src/schema/validate.js       validateAndCanonicalize: валидация data и канонизация entity_key
tests/run.js                 комплексная проверка по слоям (базовый слой плюс слои проактивности, поджатия истории и глобальной памяти)
tests/memory_cases.json      набор кейсов извлечения фактов
tests/schema.test.js         проверка слоя схем data под домен (npm run test:schema)
tests/skills.test.mjs        проверка реестра skills и фильтрации инструментов (npm run test:skills)
tests/skill-authoring.test.mjs  проверка инструментария редактирования навыков (npm run test:skill-authoring)
tests/check-llm.js           проверка доступности и возможностей моделей через выбранный endpoint
scripts/memory-dedupe.js     CLI dry-run/apply для ретроактивной дедупликации памяти
```

---

## [QS-6] Сборка с нуля (порядок)

1. **Фундамент.** Поднять Node.js 22 и PostgreSQL 16 с расширениями. Завести `package.json` (ESM, зависимости `openai`,
   `pg`, `config`, `af-db-ts`, `dotenv`) и каталог конфигурации `config/`.
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
   [06-memory.md](06-memory.md). Внешние источники инструментов по протоколу MCP (модули `src/mcp/*`, файл `.mcp.json`,
   ленивая инициализация `initTools`) — см. [10-operations.md](10-operations.md), раздел `OPS-4a`.
9. **Проверки.** `tests/run.js` по слоям — см. [10-operations.md](10-operations.md).
10. **Проактивность и режим собеседника.** Таблицы проактивности и companion-виды `memory_kind` из единой
    инициализации, модули `topics`, `temporal`, `proactive`, `events`, ветки в `agent.js` под флагами — см.
    [09-proactivity.md](09-proactivity.md). Код — каталог `src/`.
11. **Поджатие истории.** Служебные колонки `conversation_summaries`, модули `token-counter`, `history-compress`,
    `history-context`, заполнение `token_count` в `saveMessage` и сборка `HISTORY_CONTEXT` в `agent.js` под флагом —
    см. [13-history-compression.md](13-history-compression.md).
12. **Глобальная память.** Таблицы глобальной памяти и колонка `is_admin` из единой инициализации, модуль
    `global-memory`, функция `isAdmin` в `admin.js`, модули инструментов и проверка прав в `tools.js`, сборка блоков
    `GLOBAL_FACTS` и `GLOBAL_KNOWLEDGE` в `agent.js` под флагами — см. [14-global-memory.md](14-global-memory.md).

---


