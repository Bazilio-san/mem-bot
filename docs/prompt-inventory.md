# Реестр промптов и prompt-like шаблонов

Этот файл фиксирует координаты промптов текущей реализации. В отличие от переносимой спецификации
`docs/ai-bot-with-memory/`, этот документ проектный: здесь допустимы ссылки на конкретные каналы, тесты и служебные
каталоги репозитория.

## Runtime-промпты приложения

| Блок | Координата | Как используется |
|------|------------|------------------|
| Основной системный промпт `MAIN_SYSTEM` | `src/agent.js:30` | Первый `system`-блок основного ответа агента. |
| Сборка основного `messages` | `src/agent.js:553` | Порядок всех `system`, истории и текущего `user`-сообщения. |
| `CAPABILITIES_CONTEXT` | `src/agent.js:298` | Подмешивается, когда пользователь спрашивает о возможностях бота. |
| `CURRENT_DATETIME` | `src/agent.js:453` | Текущие дата, время и часовой пояс для каждого запроса. |
| `WELCOME_BACK_CONTEXT` | `src/agent.js:462` | Контекст возвращения пользователя после паузы. |
| `CONVERSATION_CONTEXT` | `src/agent.js:481` | Контекст режима собеседника: время, темы, стиль ведения разговора. |
| `chatJSON` JSON-инструкция | `src/llm.js:203` | Общая обёртка строгого JSON через `response_format: json_object`. |
| Классификатор намерения | `src/pipeline/classify.js:52` | Динамический system-промпт со списком доменов и user-шаблоном. |
| Подсказка доменной схемы | `src/pipeline/extract.js:11` | Перечень `entity_type` и полей `data` для первого прохода извлечения. |
| Уточнение entity/data | `src/pipeline/extract.js:56` | Второй строгий проход извлечения по схеме конкретной сущности. |
| Извлечение памяти `SYSTEM` | `src/pipeline/extract.js:157` | Первый проход извлечения кандидатов в долговременную память. |
| Извлечение тем `TOPICS_SYSTEM` | `src/pipeline/extract.js:256` | Выделение тем диалога и оценки вовлечённости пользователя. |
| Суммаризатор истории `SUMMARY_SYSTEM` | `src/pipeline/history-compress.js:62` | Сжатие холодной части истории и вынос устойчивых фактов. |
| `HISTORY_CONTEXT` | `src/pipeline/history-context.js:12` | Справочный блок сжатой истории для основного ответа. |
| `MEMORY_CONTEXT` | `src/pipeline/retrieve.js:121` | Справочный блок релевантной личной памяти, защищённый от injection. |
| `GLOBAL_FACTS` | `src/pipeline/global-memory.js:71` | Общие факты и политика, подмешиваемые в основной запрос. |
| Выбор реакции `SYSTEM` | `src/pipeline/reactions.js:26` | Решение, можно ли заменить короткий текст канальной реакцией. |
| Проактивное сообщение | `src/pipeline/proactiveMessage.js:50` | System + userPrompt для сообщения, которое бот пишет первым. |
| Оценка релевантности события | `src/pipeline/events.js:127` | JSON-оценка интересности внешнего события для пользователя. |
| Сообщение с событием | `src/pipeline/events.js:150` | Генерация короткого персонального текста по релевантному событию. |
| Telegram `OUTPUT_FORMAT` | `src/telegram/bot.js:69` | Канальная инструкция HTML-разметки для Telegram-доставки. |
| Резюме для TTS | `src/voice/tts.js:61` | Краткое резюме длинного ответа для озвучивания. |

## Tool definitions, которые видит модель

Описания `function.description` и `parameters.properties.*.description` входят в запрос модели как инструкции к
инструментам. Это не обычные `system`/`user`-промпты, но они влияют на поведение модели. Координата указывает на строку
с `description` внутри блока `function`.

| Инструмент | Координата |
|------------|------------|
| `secure_record_get` | `src/pipeline/agent-tools/secure-record-get.js:10` |
| `skill_read_reference` | `src/pipeline/agent-tools/skill-read-reference.js:15` |
| `voice_or_text` | `src/pipeline/agent-tools/voice/voice-or-text.js:16` |
| `voice_set_preference` | `src/pipeline/agent-tools/voice/voice-set-preference.js:12` |
| `global_fact_add` | `src/pipeline/agent-tools/global-fact/global-fact-add.js:12` |
| `global_fact_delete` | `src/pipeline/agent-tools/global-fact/global-fact-delete.js:12` |
| `global_fact_list` | `src/pipeline/agent-tools/global-fact/global-fact-list.js:12` |
| `global_knowledge_add` | `src/pipeline/agent-tools/global-knowledge/global-knowledge-add.js:12` |
| `global_knowledge_delete` | `src/pipeline/agent-tools/global-knowledge/global-knowledge-delete.js:12` |
| `global_knowledge_search` | `src/pipeline/agent-tools/global-knowledge/global-knowledge-search.js:11` |
| `memory_forget_all` | `src/pipeline/agent-tools/memory/memory-forget-all.js:10` |
| `memory_forget_entity` | `src/pipeline/agent-tools/memory/memory-forget-entity.js:10` |
| `memory_list` | `src/pipeline/agent-tools/memory/memory-list.js:10` |
| `memory_search` | `src/pipeline/agent-tools/memory/memory-search.js:12` |
| `scheduler_create_task` | `src/pipeline/agent-tools/scheduler/scheduler_create_task.js:10` |
| `scheduler_list_tasks` | `src/pipeline/agent-tools/scheduler/scheduler_list_tasks.js:113` |

### Инструменты авторинга скиллов (`skill-authoring/`)

Эти инструменты позволяют модели создавать и редактировать скиллы. Их `description` тоже читается моделью как инструкция.

| Инструмент | Координата |
|------------|------------|
| `skill_author_create` | `src/pipeline/agent-tools/skill-authoring/skill-author-create.js:23` |
| `skill_author_read` | `src/pipeline/agent-tools/skill-authoring/skill-author-read.js:14` |
| `skill_author_list` | `src/pipeline/agent-tools/skill-authoring/skill-author-list.js:14` |
| `skill_author_set_field` | `src/pipeline/agent-tools/skill-authoring/skill-author-set-field.js:77` |
| `skill_author_write_prompt` | `src/pipeline/agent-tools/skill-authoring/skill-author-write-prompt.js:14` |
| `skill_author_write_extraction` | `src/pipeline/agent-tools/skill-authoring/skill-author-write-extraction.js:14` |
| `skill_author_add_reference` | `src/pipeline/agent-tools/skill-authoring/skill-author-add-reference.js:14` |
| `skill_author_remove_reference` | `src/pipeline/agent-tools/skill-authoring/skill-author-remove-reference.js:14` |
| `skill_author_schema_generate` | `src/pipeline/agent-tools/skill-authoring/skill-author-schema-generate.js:14` |
| `skill_author_schema_edit` | `src/pipeline/agent-tools/skill-authoring/skill-author-schema-edit.js:14` |
| `skill_author_validate` | `src/pipeline/agent-tools/skill-authoring/skill-author-validate.js:14` |
| `skill_author_apply` | `src/pipeline/agent-tools/skill-authoring/skill-author-apply.js:15` |
| `skill_author_reload` | `src/pipeline/agent-tools/skill-authoring/skill-author-reload.js:14` |
| `skill_author_enable` | `src/pipeline/agent-tools/skill-authoring/skill-author-enable.js:14` |
| `skill_author_disable` | `src/pipeline/agent-tools/skill-authoring/skill-author-disable.js:14` |
| `skill_author_delete` | `src/pipeline/agent-tools/skill-authoring/skill-author-delete.js:14` |

### MCP-инструменты

Инструмент `search_flights` больше не определяется локальным файлом. Теперь он приходит динамически от MCP-сервера
`yafly` (см. `src/mcp/client.js:134` и `src/pipeline/tools.js:19`), поэтому его `description` задаётся на стороне
сервера, а в реестре локальных tool-определений координаты нет. Модель видит его под именем с префиксом сервера
(например, `yafly__search_flights`), а скилл ссылается на логическое имя `search_flights` без префикса.

## Тестовые промпты

| Файл | Координаты |
|------|------------|
| Проверка LLM-прокси | `tests/check-llm.js:77`, `tests/check-llm.js:96`, `tests/check-llm.js:128`, `tests/check-llm.js:164`, `tests/check-llm.js:198` |
| Проверка streaming | `tests/check-streaming.js:46`, `tests/check-streaming.js:66` |
