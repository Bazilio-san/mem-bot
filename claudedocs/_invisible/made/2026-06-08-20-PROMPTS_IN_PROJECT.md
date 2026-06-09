# Промпты в проекте

Пути указаны относительно корня проекта `D:\DEV\SAND\proactive_bot`

## Явные промпты

- `prompts/prompt1.md`  
  ТЗ-промпт на добавление триггера `welcome_back`.

- `prompts/prompt2.md`  
  ТЗ-промпт на новости, FCM push-уведомления и заглушку новостей.

- `src/dialog/handleMessage.ts:142`  
  Большой `buildSystemPrompt(...)` для основного диалога: роль ассистента, стиль общения, память, проактивное начало, темы, ограничения, временной контекст.

- `src/llm.ts:61`  
  `systemPrompt` для извлечения устойчивых фактов о пользователе из диалога.

- `src/llm.ts:162`  
  `systemPrompt` для анализа тем диалога и оценки вовлечённости.

- `src/proactive/msgBuilder.ts:98`  
  `systemPrompt` для проактивных сообщений.

- `src/proactive/msgBuilder.ts:118`  
  `buildPromptByTrigger(...)`: user-промпты для `daily_checkin`, `goal_reminder`, `welcome_back` и дефолтного случая.

- `src/news/newsFilter.ts:80`  
  `systemPrompt` для проверки релевантности новости интересам пользователя.

- `src/news/newsFilter.ts:163`  
  `systemPrompt` для генерации сообщения пользователю по релевантной новости.

## Фрагменты контекста для промптов

- `src/utils/temporalContext.ts:187`  
  Форматирует дату, время, паузу с прошлого сообщения и подсказку.

- `src/memory/topics.ts:128`  
  Форматирует темы: недавние, "выгоревшие", свежие и высоко вовлекающие.
