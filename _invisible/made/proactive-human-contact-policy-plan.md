# План-промпт: человекоподобная политика проактивных сообщений

## Роль и цель

Ты работаешь в проекте `D:\DEV\SAND\inter-2-prep`. Нужно переделать проактивность так, чтобы бот не задалбывал
пользователя серией инициативных сообщений, когда пользователь молчит. Молчание пользователя должно считаться
поведенческим сигналом, а не пустотой, в которую можно каждые несколько минут отправлять новый повод.

Итог реализации: проактивный контур принимает решение об отправке алгоритмически, дёшево и независимо от канала
доставки. LLM используется только после положительного решения `canSendProactive`, чтобы сгенерировать текст конкретного
сообщения. Нельзя проверять каждого пользователя каждые 5 минут через LLM: это дорого, медленно и плохо масштабируется.

## Что уже известно по текущему коду

- Основная логика проактивности находится в `src/pipeline/proactive.js`.
- Генерация текста проактивного сообщения находится в `src/pipeline/proactiveMessage.js`.
- Глобальные настройки живут в `src/config.js`, раздел `config.proactive`.
- Пользователей для прохода возвращает `listUsersWithTriggers()` из `src/repo.js`.
- Триггеры хранятся в `mem.proactive_triggers` и имеют только потриггерный `last_fired_at`.
- Воркер вызывает `checkProactiveTriggers()` из `src/scheduler-run.js` и из фонового цикла `src/telegram.js`.
- Доставка уже каналонезависимая на уровне ядра: `fire()` пишет в `mem.notification_outbox` и историю диалога.
- Telegram-адаптер только сливает `notification_outbox` в Telegram; бизнес-решение об уместности отправки не должно
  жить в `src/telegram.js`.

Сейчас анти-спам локален для каждого триггера. Если один триггер недавно сработал, другой может всё равно отправить
сообщение тому же пользователю. Также `welcome_back` сейчас проверяется фоновым воркером по длительной паузе
пользователя, хотя «возвращение» должно определяться входящим сообщением после паузы, а не молчанием.

## Принцип поведения

Человек не пишет бесконечную серию новых тем, если ему не отвечают. Нормальная динамика такая:

- после одного инициативного сообщения человек ждёт реакции;
- если ответа нет, он увеличивает паузу;
- если это важно, он может сделать одно мягкое продолжение позже;
- если снова тишина, он перестаёт писать сам до возвращения собеседника;
- после возвращения он не вываливает накопленное, а аккуратно подхватывает одну-две темы.

В терминах бота это означает: последнее инициативное сообщение без ответа блокирует новые мягкие инициативы. Молчание
пользователя повышает осторожность, а не создаёт новые поводы писать.

## Термины

- `proactive` — сообщение, которое бот отправляет первым по собственной инициативе или по разрешённому фоновому поводу.
- `requested_reminder` — сообщение из планировщика, созданное явной просьбой пользователя. Оно не считается мягкой
  инициативой и имеет отдельные лимиты.
- `soft_proactive` — идея, check-in, goal reminder, inactivity-подхват или внешний повод, который бот сам выбрал.
- `social_proactive` — приветствие, утреннее сообщение, welcome back и похожий социальный контакт.
- `unanswered proactive` — последнее проактивное сообщение ассистента, после которого не было сообщения пользователя.
- `contact policy` — алгоритмический слой, который решает, можно ли сейчас отправлять сообщение.

## Требования к поведению

1. За один проход проактивности пользователь получает не больше одного сообщения.
2. Пока предыдущее мягкое проактивное сообщение не закрыто ответом пользователя, новое мягкое проактивное сообщение не
   отправляется.
3. После первого проигнорированного мягкого сообщения бот уходит в осторожный режим и не начинает новые темы.
4. После второго проигнорированного мягкого сообщения бот уходит в тихий режим до входящего сообщения пользователя или
   до явно заданного `quiet_until`.
5. Социальные сообщения не отправляются фоновым воркером, если пользователь ничего не написал. Они допустимы только как
   часть ответа на входящее сообщение после паузы или как каналонезависимый post-processing входящего turn.
6. Явные пользовательские напоминания из планировщика продолжают доставляться, но должны иметь собственный дневной лимит
   и не должны разблокировать мягкую проактивность.
7. Внешние события и goal reminders проходят через ту же contact policy, если они не являются явно критичными. По
   умолчанию они считаются мягкой проактивностью.
8. Проверка уместности отправки полностью алгоритмическая: SQL, счётчики, timestamps, тип сообщения, режим пользователя.
   LLM не вызывается до положительного решения отправлять.
9. Канал доставки не участвует в принятии решения. Telegram, CLI, web push или другой адаптер получают уже созданную
   запись `notification_outbox`.

## Режимы поведения

Введи четыре режима, вычисляемые алгоритмически из состояния пользователя. Можно хранить режим явно, но он должен быть
производным от счётчиков и времени, чтобы его было легко восстановить.

### `active`

Пользователь недавно писал или ответил на прошлую инициативу. Разрешены мягкие инициативы в пределах дневного и
недельного бюджета.

### `cautious`

Есть одно незакрытое мягкое проактивное сообщение. Бот не начинает новые темы. Разрешён максимум один поздний мягкий
follow-up только для важного повода, если прошла большая пауза.

### `quiet`

Есть два незакрытых мягких проактивных сообщения или активен `quiet_until`. Бот не пишет сам, кроме явных
пользовательских напоминаний и критичных системных сообщений.

### `welcome_back`

Пользователь сам написал после длинной паузы. Это не фоновый push. Этот режим используется в обработке входящего
сообщения, чтобы ответ был мягким: коротко поприветствовать возвращение, предложить одну-две темы, не перечислять всё
накопленное.

## Схема данных

Добавь отдельную таблицу состояния контакта, например `mem.proactive_contact_state`. Не перегружай
`mem.proactive_triggers`: триггеры описывают поводы, а contact state описывает отношения с пользователем.

Минимальные поля:

```sql
CREATE TABLE IF NOT EXISTS mem.proactive_contact_state (
    user_id                         uuid PRIMARY KEY REFERENCES mem.users(id) ON DELETE CASCADE,
    mode                            text NOT NULL DEFAULT 'active',
    last_proactive_sent_at           timestamptz,
    last_soft_proactive_sent_at      timestamptz,
    last_user_reply_after_proactive_at timestamptz,
    unanswered_proactive_count       integer NOT NULL DEFAULT 0,
    ignored_soft_count_7d            integer NOT NULL DEFAULT 0,
    daily_soft_count                 integer NOT NULL DEFAULT 0,
    daily_requested_reminder_count   integer NOT NULL DEFAULT 0,
    weekly_soft_count                integer NOT NULL DEFAULT 0,
    quiet_until                      timestamptz,
    last_trigger_type                text,
    last_topic_key                   text,
    updated_at                       timestamptz NOT NULL DEFAULT now()
);
```

Если удобнее, счётчики дня/недели можно считать запросами по `conversation_messages` или `notification_outbox`, но для
производительности и простоты тестов предпочтительнее хранить агрегированное состояние и обновлять его при событиях.

Для истории решений добавь журнал, если он помогает отладке:

```sql
CREATE TABLE IF NOT EXISTS mem.proactive_contact_decisions (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES mem.users(id) ON DELETE CASCADE,
    trigger_type text,
    message_kind text,
    decision     text NOT NULL,
    reason       text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);
```

Журнал не должен расти бесконечно без политики очистки. Если добавляешь его, добавь простой cleanup или ограничь запись
debug-флагом. Для MVP допустимо не добавлять журнал, а возвращать `reason` из функций и покрыть тестами.

## Классы сообщений

Введи нормализованную классификацию кандидата на отправку до генерации текста:

```js
{
  triggerType: 'inactivity' | 'daily_checkin' | 'goal_reminder' | 'event' | 'follow_up',
  messageKind: 'soft_proactive' | 'social_proactive' | 'requested_reminder' | 'critical',
  importance: 'low' | 'normal' | 'high' | 'critical',
  topicKey: string | null
}
```

Для текущих триггеров задай дефолты:

- `inactivity` -> `soft_proactive`, `normal`;
- `daily_checkin` -> `social_proactive`, `low`;
- `goal_reminder` -> `soft_proactive`, `normal` или `high`, если цель явно помечена важной;
- `welcome_back` -> не фоновый trigger, переносится в обработку входящего сообщения;
- внешние события -> `soft_proactive`, `normal`, если нет явного критичного типа;
- задачи планировщика `reminder` -> `requested_reminder`, если они созданы явной просьбой пользователя.

## Алгоритм `canSendProactive`

Создай чистую функцию с минимальной зависимостью от БД, например `evaluateContactPolicy({ state, candidate, now })`.
Она должна возвращать не boolean, а структурированный результат:

```js
{ allowed: true, reason: 'active_budget_ok', nextCheckAt: null }
{ allowed: false, reason: 'unanswered_soft_proactive', nextCheckAt: state.quiet_until }
```

Пример правил:

```js
function evaluateContactPolicy({ state, candidate, now }) {
  if (candidate.messageKind === 'critical') return allow('critical');

  if (state.quiet_until && now < state.quiet_until) {
    return deny('quiet_until_active', state.quiet_until);
  }

  if (candidate.messageKind === 'social_proactive') {
    return deny('social_requires_incoming_user_message');
  }

  if (candidate.messageKind === 'requested_reminder') {
    if (state.daily_requested_reminder_count >= 2) return deny('requested_reminder_daily_limit');
    return allow('requested_reminder_budget_ok');
  }

  if (state.unanswered_proactive_count >= 2) {
    return deny('silent_until_user_reply');
  }

  if (state.unanswered_proactive_count >= 1 && candidate.importance !== 'high') {
    return deny('unanswered_soft_proactive');
  }

  if (state.daily_soft_count >= 1) return deny('soft_daily_limit');
  if (state.weekly_soft_count >= 3) return deny('soft_weekly_limit');

  if (state.last_soft_proactive_sent_at && minutesSince(state.last_soft_proactive_sent_at, now) < 360) {
    return deny('soft_min_pause');
  }

  if (state.last_topic_key && state.last_topic_key === candidate.topicKey && state.unanswered_proactive_count > 0) {
    return deny('ignored_topic');
  }

  return allow('active_budget_ok');
}
```

Пороговые значения вынеси в `config.proactive.contactPolicy`, с env override:

- `PROACTIVE_SOFT_DAILY_LIMIT`, default `1`;
- `PROACTIVE_SOFT_WEEKLY_LIMIT`, default `3`;
- `PROACTIVE_REQUESTED_REMINDER_DAILY_LIMIT`, default `2`;
- `PROACTIVE_MIN_SOFT_PAUSE_MIN`, default `360`;
- `PROACTIVE_QUIET_AFTER_UNANSWERED`, default `2`;
- `PROACTIVE_QUIET_HOURS_AFTER_IGNORES`, default `24`.

## Обновление состояния

Добавь функции ядра, например в `src/pipeline/proactiveContactPolicy.js`:

- `getContactState(userId)`;
- `ensureContactState(userId)`;
- `evaluateContactPolicy({ state, candidate, now })`;
- `recordProactiveSent({ userId, candidate, sentAt })`;
- `recordUserInboundForContactPolicy({ userId, messageAt })`;
- `classifyTriggerCandidate(trigger, user)`;
- `selectBestAllowedCandidate({ user, triggers, now })`.

`recordProactiveSent`:

- обновляет `last_proactive_sent_at`;
- для `soft_proactive` обновляет `last_soft_proactive_sent_at`;
- увеличивает дневной/недельный счётчик соответствующего класса;
- увеличивает `unanswered_proactive_count`, если это мягкая инициатива;
- при достижении порога выставляет `quiet_until`.

`recordUserInboundForContactPolicy`:

- вызывается в общем входящем пайплайне ядра, а не в Telegram-адаптере;
- сбрасывает `unanswered_proactive_count`;
- проставляет `last_user_reply_after_proactive_at`, если ответ пришёл после proactive;
- снимает `quiet_until`, если пользователь сам вернулся;
- переводит режим в `active` или помечает текущий turn как `welcome_back`, если пауза была длинной.

Найди правильную точку в `src/agent.js`, где входящее сообщение пользователя уже нормализовано и пользователь найден.
Не добавляй эту логику в `src/telegram.js`.

## Изменения в `checkProactiveTriggers`

Перепиши проход так, чтобы он не вызывал `fire()` внутри цикла по всем триггерам. Новый порядок:

1. Получить пользователя.
2. Получить contact state.
3. Получить включённые триггеры.
4. Для каждого триггера алгоритмически проверить `shouldFire`.
5. Преобразовать сработавшие триггеры в кандидатов.
6. Отфильтровать кандидатов через `evaluateContactPolicy`.
7. Выбрать один лучший разрешённый кандидат по приоритету.
8. Только после этого вызвать LLM через `buildProactiveMessage()`.
9. После успешной доставки вызвать `recordProactiveSent()`.
10. Обновить `last_fired_at` только у реально отправленного триггера.

Приоритет кандидатов:

```text
critical > requested_reminder > high goal_reminder > external event > inactivity > daily_checkin
```

Для текущего MVP `requested_reminder` в основном обрабатывается планировщиком, а не `checkProactiveTriggers()`. Но
политика должна быть общей, чтобы её можно было переиспользовать в планировщике и событиях.

## Исправление `welcome_back`

`welcome_back` не должен быть фоновым push по таймеру молчания. Сделай одно из двух:

1. Убери `welcome_back` из `defaultProactiveTriggers()` и из фонового `shouldFire`.
2. Или оставь триггер в настройках для будущего UI, но `shouldFire` всегда возвращает `false` для фонового прохода.

Поведение welcome back реализуй в обработке входящего сообщения:

- если пользователь написал после паузы больше `config.proactive.welcomeBackGapMinutes`;
- и если до этого были незакрытые proactive-сообщения или значимая пауза;
- добавить в context/prompt ответного turn справочный сигнал, что пользователь вернулся после паузы;
- попросить модель не давить, не перечислять накопленное, предложить максимум одну-две темы.

Это изменение относится к ядру ИИ-бота. Telegram только передаёт входящее сообщение в `handleMessage()`.

## Изменения в генерации текста

`buildProactiveMessage()` получает не только `triggerType`, но и `candidate`/`contactMode`. Промпт должен различать:

- активный режим: можно мягко предложить одну тему;
- осторожный режим: не начинать новую тему, максимум один короткий follow-up для высокой важности;
- тихий режим: генератор не вызывается, потому что policy запрещает отправку;
- социальный контакт: не генерируется фоновым воркером.

Важно: промпт не принимает решение «писать или не писать». Он только формулирует сообщение, если алгоритм уже разрешил
отправку.

## Планировщик и явные напоминания

Проактивная contact policy не должна ломать явно поставленные пользователем напоминания. Но стоит добавить лёгкую
интеграцию:

- задачи `mem.scheduled_tasks.task_type = 'reminder'` считаются `requested_reminder`;
- для них применяется отдельный дневной лимит, если это не критичная задача;
- если лимит превышен, задача не теряется: она безопасно откладывается или остаётся pending с понятной причиной;
- это поведение нужно описать и покрыть тестами, если интеграция будет реализована в этой итерации.

Если интеграция с планировщиком слишком расширяет объём, зафиксируй её как следующий шаг, но не смешивай мягкую
проактивность и пользовательские напоминания в одной политике без классификации.

## Тесты

Добавь тесты в `tests/run.js` или отдельный тестовый файл, если это лучше ложится на существующий раннер.

Минимальные проверки:

1. Одно мягкое proactive-сообщение без ответа блокирует новое `low`/`normal` сообщение.
2. Высоковажный follow-up после одного unanswered разрешён только после минимальной паузы.
3. После двух unanswered мягкая проактивность запрещена до входящего сообщения пользователя.
4. Входящее сообщение пользователя сбрасывает `unanswered_proactive_count` и `quiet_until`.
5. `daily_checkin` не отправляется фоновым воркером как `social_proactive`.
6. За один проход `checkProactiveTriggers()` отправляет максимум одно сообщение одному пользователю.
7. Разные триггеры одного пользователя не обходят общий дневной и недельный бюджет.
8. `welcome_back` не срабатывает от молчания в фоне.
9. `welcome_back` доступен как сигнал в ответе на входящее сообщение после паузы.
10. Проверка policy не вызывает LLM. Замокай или инструментируй `chat()`, чтобы убедиться: при deny генератор не
    вызывается.

Если есть тесты Telegram-адаптера, не добавляй туда бизнес-проверки contact policy. Telegram-тесты должны проверять
только отображение команд/кнопок и слив `notification_outbox`, если они затронуты.

## Документация

После реализации обязательно обнови документацию `docs/ai-bot-with-memory` в соответствии с
`docs/ai-bot-with-memory/00-documentation-principles.md`.

Документация спецификации должна описывать новое поведение как единственное действующее состояние, без исторических
формулировок вроде «раньше бот спамил» или «теперь добавлена политика». Не упоминай Telegram в спецификации
`docs/ai-bot-with-memory`: канал доставки может быть любым.

Минимально проверь и при необходимости обнови:

- `docs/ai-bot-with-memory/02-criteria.md`;
- `docs/ai-bot-with-memory/05-data-schema.md`;
- `docs/ai-bot-with-memory/09-proactivity.md`;
- `docs/ai-bot-with-memory/10-operations.md`;
- `docs/ai-bot-implementation-status.md`, если в проекте он используется как статусная матрица.

Если реализация затронет Telegram-бота, отдельно обнови `docs/telegram/telegram-bot.md` по принципам
`docs/telegram/00-documentation-principles.md`. В Telegram-документации описывай только отображение канальных команд,
кнопок и доставку outbox в Telegram. Не дублируй бизнес-логику contact policy: она принадлежит спецификации ядра.

## Критерии готовности

- Решение об отправке proactive-сообщения принимается алгоритмически, без LLM.
- LLM вызывается только после положительного результата contact policy.
- Один пользователь не получает несколько proactive-сообщений за один проход воркера.
- Молчание пользователя переводит бота в осторожный или тихий режим.
- Новое входящее сообщение пользователя сбрасывает осторожность и может дать welcome-back сигнал в ответном turn.
- `welcome_back` не является фоновым push по таймеру молчания.
- Явные пользовательские напоминания отделены от мягкой инициативы.
- Логика находится в ядре ИИ-бота и не зависит от Telegram.
- Тесты покрывают deny-сценарии и подтверждают, что при deny генератор/LLM не вызывается.
- Документация обновлена по принципам соответствующих каталогов.
