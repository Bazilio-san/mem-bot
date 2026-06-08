# Зазоры реализации proactive human contact policy

Дата проверки: 2026-06-08.

План `claudedocs/proactive-human-contact-policy-plan.md` в основном реализован для штатного фонового контура:

- `mem.proactive_contact_state` добавлен в `migrations/010_proactive_contact_policy.sql`;
- ядро политики вынесено в `src/pipeline/proactiveContactPolicy.js`;
- `checkProactiveTriggers()` фильтрует кандидатов через `evaluateContactPolicy()` до генерации текста;
- `welcome_back` не срабатывает от фонового молчания и передаётся как входящий context-сигнал в `src/agent.js`;
- внешние события и reminders переиспользуют общую contact policy;
- документация `docs/ai-bot-with-memory` и статусная матрица обновлены.

## 1. Ручной `/proactive` обходит contact policy

`fireProactiveNow()` в `src/pipeline/proactive.js` вызывает `fire()` напрямую. `fire()` сразу вызывает
`buildProactiveMessage()`, затем пишет сообщение в историю и `notification_outbox`, после чего обновляет
`recordProactiveSent()`.

Это значит, что отладочная команда `/proactive <тип>` в CLI/Telegram может отправить proactive-сообщение даже тогда,
когда `evaluateContactPolicy()` запретила бы обычный фоновой push.

Затронутые места:

- `src/pipeline/proactive.js`, `fire()`;
- `src/pipeline/proactive.js`, `fireProactiveNow()`;
- `src/cli.js`, команда `/proactive`;
- `src/telegram/bot.js`, команда `/proactive`.

Возможные решения:

- либо прогонять `fireProactiveNow()` через `evaluateContactPolicy()` и возвращать `{ ok: false, reason }` при deny;
- либо явно оставить это debug-only bypass и задокументировать, что команда ручного запуска намеренно игнорирует policy.

Если выбирать строго по критериям плана, предпочтительнее первый вариант.

## 2. Нет отдельного теста, что deny не вызывает LLM

В `tests/run.js` есть проверки чистой `evaluateContactPolicy()` и поведения `recordProactiveSent()` /
`recordUserInboundForContactPolicy()`. Также по коду `checkProactiveTriggers()` видно, что LLM вызывается только после
положительного policy-решения.

Но в тестах нет отдельной инструментированной проверки, которая мокает или считает вызовы `chat()` /
`buildProactiveMessage()` и подтверждает: при deny генератор proactive-текста не вызывается.

Затронутые места:

- `tests/run.js`, блоки `6.4`, `6.5`, `6.6`;
- `src/pipeline/proactive.js`, порядок `evaluateContactPolicy()` -> `fire()` -> `buildProactiveMessage()`.

Возможное решение:

- добавить узкий тест вокруг `checkProactiveTriggers()` с пользователем, у которого policy возвращает deny;
- замокать или инструментировать генератор proactive-сообщений;
- проверить, что после deny нет нового `notification_outbox`, нет нового assistant-сообщения и генератор не вызывался.

## 3. Полный `npm test` не был подтверждён текущей проверкой

При проверке 2026-06-08 команда `npm test` была запущена, но не уложилась в 120 секунд. Раннер использует реальную БД и
реальные модели через LiteLLM-прокси, поэтому таймаут сам по себе не доказывает поломку.

Нужно отдельно прогнать тесты с достаточным таймаутом и рабочими внешними зависимостями, если нужен статус “зелёный
прогон подтверждён”.
