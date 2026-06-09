# Реестр промптов и prompt-like шаблонов

Этот файл фиксирует координаты промптов текущей реализации. В отличие от переносимой спецификации
`docs/ai-bot-with-memory/`, этот документ проектный: здесь допустимы ссылки на конкретные каналы, тесты и служебные
каталоги репозитория.

## Runtime-промпты приложения

| Блок | Координата | Как используется |
|------|------------|------------------|
| Основной системный промпт `MAIN_SYSTEM` | `src/agent.js:23` | Первый `system`-блок основного ответа агента. |
| Сборка основного `messages` | `src/agent.js:237` | Порядок всех `system`, истории и текущего `user`-сообщения. |
| `CAPABILITIES_CONTEXT` | `src/agent.js:53` | Подмешивается, когда пользователь спрашивает о возможностях бота. |
| `CURRENT_DATETIME` | `src/agent.js:181` | Текущие дата, время и часовой пояс для каждого запроса. |
| `WELCOME_BACK_CONTEXT` | `src/agent.js:190` | Контекст возвращения пользователя после паузы. |
| `CONVERSATION_CONTEXT` | `src/agent.js:201` | Контекст режима собеседника: время, темы, стиль ведения разговора. |
| `chatJSON` JSON-инструкция | `src/llm.js:101` | Общая обёртка строгого JSON через `response_format: json_object`. |
| Классификатор намерения | `src/pipeline/classify.js:27` | Динамический system-промпт со списком доменов и user-шаблоном. |
| Подсказка доменной схемы | `src/pipeline/extract.js:10` | Перечень `entity_type` и полей `data` для первого прохода извлечения. |
| Уточнение entity/data | `src/pipeline/extract.js:42` | Второй строгий проход извлечения по схеме конкретной сущности. |
| Извлечение памяти `SYSTEM` | `src/pipeline/extract.js:113` | Первый проход извлечения кандидатов в долговременную память. |
| Извлечение тем `TOPICS_SYSTEM` | `src/pipeline/extract.js:182` | Выделение тем диалога и оценки вовлечённости пользователя. |
| Суммаризатор истории `SUMMARY_SYSTEM` | `src/pipeline/history-compress.js:49` | Сжатие холодной части истории и вынос устойчивых фактов. |
| `HISTORY_CONTEXT` | `src/pipeline/history-context.js:8` | Справочный блок сжатой истории для основного ответа. |
| `MEMORY_CONTEXT` | `src/pipeline/retrieve.js:117` | Справочный блок релевантной личной памяти, защищённый от injection. |
| `GLOBAL_FACTS` | `src/pipeline/global-memory.js:71` | Общие факты и политика, подмешиваемые в основной запрос. |
| Выбор реакции `SYSTEM` | `src/pipeline/reactions.js:26` | Решение, можно ли заменить короткий текст канальной реакцией. |
| Проактивное сообщение | `src/pipeline/proactiveMessage.js:40` | System + userPrompt для сообщения, которое бот пишет первым. |
| Оценка релевантности события | `src/pipeline/events.js:66` | JSON-оценка интересности внешнего события для пользователя. |
| Сообщение с событием | `src/pipeline/events.js:84` | Генерация короткого персонального текста по релевантному событию. |
| Telegram `OUTPUT_FORMAT` | `src/telegram/bot.js:62` | Канальная инструкция HTML-разметки для Telegram-доставки. |
| Резюме для TTS | `src/voice/tts.js:48` | Краткое резюме длинного ответа для озвучивания. |

## Tool definitions, которые видит модель

Описания `function.description` и `parameters.properties.*.description` входят в запрос модели как инструкции к
инструментам. Это не обычные `system`/`user`-промпты, но они влияют на поведение модели.

| Инструмент | Координата |
|------------|------------|
| `search_flights` | `src/pipeline/agent-tools/search-flights.js:2` |
| `secure_record_get` | `src/pipeline/agent-tools/secure-record-get.js:4` |
| `set_reply_mode` | `src/pipeline/agent-tools/set-reply-mode.js:9` |
| `global_fact_add` | `src/pipeline/agent-tools/global-fact/global-fact-add.js:4` |
| `global_fact_delete` | `src/pipeline/agent-tools/global-fact/global-fact-delete.js:4` |
| `global_fact_list` | `src/pipeline/agent-tools/global-fact/global-fact-list.js:4` |
| `global_knowledge_add` | `src/pipeline/agent-tools/global-knowledge/global-knowledge-add.js:4` |
| `global_knowledge_delete` | `src/pipeline/agent-tools/global-knowledge/global-knowledge-delete.js:4` |
| `global_knowledge_search` | `src/pipeline/agent-tools/global-knowledge/global-knowledge-search.js:4` |
| `memory_forget_all` | `src/pipeline/agent-tools/memory/memory-forget-all.js:4` |
| `memory_forget_entity` | `src/pipeline/agent-tools/memory/memory-forget-entity.js:4` |
| `memory_list` | `src/pipeline/agent-tools/memory/memory-list.js:4` |
| `memory_search` | `src/pipeline/agent-tools/memory/memory-search.js:6` |
| `scheduler_create_task` | `src/pipeline/agent-tools/scheduler/scheduler_create_task.js:4` |
| `scheduler_list_tasks` | `src/pipeline/agent-tools/scheduler/scheduler_list_tasks.js:75` |

## Тестовые промпты

| Файл | Координаты |
|------|------------|
| Проверка LLM-прокси | `tests/check-llm.js:68`, `tests/check-llm.js:85`, `tests/check-llm.js:112`, `tests/check-llm.js:144`, `tests/check-llm.js:173` |
| Проверка streaming | `tests/check-streaming.js:40`, `tests/check-streaming.js:53` |
