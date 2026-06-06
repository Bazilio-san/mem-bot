# 13. Поджатие истории диалога

## Вкратце

Поверх пяти видов памяти и горячего окна последних сообщений работает отдельный слой — **сжатая история текущего
диалога**. Последние `N = 8` сообщений всегда уходят в запрос дословно (горячее окно), а всё, что старше (холодная зона),
сворачивается в краткий дайджест и хранится в таблице `mem.conversation_summaries`. Дайджест собирается
с градиентом: ближнее к текущему моменту описывается подробнее, дальнее — короче. Факты, попавшие в `MEMORY_CONTEXT`,
в истории не повторяются. Слой расположен в модулях `src/pipeline/history-context.js`,
`history-compress.js` и `token-counter.js`, подключён в контуре ответа `src/agent.js` и покрыт слоем
проверок `layerHistory`. По умолчанию он выключен флагом `HISTORY_COMPRESSION_ENABLED`; при выключенном флаге
в запрос идут только последние восемь сообщений.

## Зачем

Горячее окно само по себе ограничено восемью сообщениями (`getRecentMessages(conversation.id, 8)`), а всё, что старше,
для модели исчезает, если не сохранено отдельно в долговременную память. Без сжатой истории длинный разговор терял бы
связность: важное решение из начала диалога модель уже не видит. Слой сжатой истории закрывает это, одновременно удерживая
четыре требования, которые легко вступают в противоречие:

1. **Не забывать длинный разговор.** Решения, незакрытые вопросы и текущая задача переживают выход за горячее окно.
2. **Не раздувать запрос.** В промпт идёт не вся история, а компактный дайджест с жёстким лимитом размера.
3. **Не портить свежий контекст.** Последние восемь сообщений остаются дословными — там местоимения, уточнения и
   последний выбор пользователя, которые нельзя пересказывать своими словами.
4. **Не дублировать долговременную память.** Факт, уже сохранённый в `memory_items` и поданный в `MEMORY_CONTEXT`, в
   `HISTORY_CONTEXT` не повторяется.

Слой наполняет таблицу `mem.conversation_summaries`, предусмотренную для этого в схеме данных (см.
[05-data-schema.md](05-data-schema.md)).

---

## Термины

| Термин | Значение |
|--------|----------|
| Горячее окно | Последние `N` сообщений, передаваемые модели дословно. По умолчанию `N = 8`. |
| Холодная зона | Всё, что старше горячего окна. Именно эта часть поджимается. |
| Дайджест | Сжатое резюме холодной зоны. Хранится в `conversation_summaries`. |
| Градиентное сжатие | Правило: ближние сообщения сохраняются подробнее, дальние — короче. |
| Гистерезис | Разница между порогом запуска сжатия и целевым размером, чтобы не пересжимать на каждом сообщении. |
| Токен | Единица, которой модель меряет размер входа и выхода; на стоимость и скорость влияет именно число токенов. |

---

## [HIST-1] Порядок блоков в запросе

Сжатая история встаёт между долговременной памятью и горячим окном, не нарушая развязку «стабильный промпт сверху,
динамика снизу» (см. [04-architecture.md](04-architecture.md)):

```text
MAIN_SYSTEM            -- стабильный системный промпт (удобен для кэширования)
MEMORY_CONTEXT         -- долговременная память: профиль, домен, задачи, защищённые ссылки
HISTORY_CONTEXT        -- сжатая история текущего диалога
последние N сообщений   -- горячее окно, дословно
новое сообщение пользователя
```

Главная идея коротко: последние восемь сообщений не трогаем вообще; всё, что старше, превращаем в краткий дайджест;
ближнее сохраняем подробнее, дальнее ужимаем сильнее; факты из долговременной памяти в истории не повторяем.

---

## [HIST-2] Рекомендуемые параметры и профили

По умолчанию выбран экономный и безопасный режим: история не должна перевешивать долговременную память.

| Параметр | Значение | Смысл |
|----------|---------:|-------|
| `HISTORY_HOT_WINDOW` | `8` | последние восемь сообщений не сжимаются вообще |
| `HISTORY_MAX_TOKENS` | `2000` | если холодная зона превысила этот размер, запускаем сжатие |
| `HISTORY_SHRINK_TOKENS` | `800` | после сжатия дайджест должен быть не больше этого размера |
| `HISTORY_ZONE_WEIGHTS` | `0.55, 0.30, 0.15` | доли бюджета дайджеста на ближнюю, среднюю и дальнюю зоны |

Готовые профили на выбор: экономный (`6 / 1400 / 500`) для коротких диалогов, где важны скорость и стоимость;
сбалансированный (`8 / 2000 / 800`) — режим по умолчанию; связный (`10 / 3200 / 1300`) для репетитора, продаж,
консультаций и длинных задач. Профиль `8 / 9000 / 2500` **не рекомендуется по умолчанию**: дайджест в 2500 токенов
становится тяжелее самого блока `MEMORY_CONTEXT` (700–2000 токенов) и нарушает главный принцип — история не должна
перевешивать память и раздувать запрос. Включать его осознанно и только после замера стоимости и задержки.

---

## [HIST-3] Как работает градиентное сжатие

Холодная зона делится на три части по давности, а бюджет дайджеста распределяется неравномерно — ближнему достаётся
больше места:

| Зона | Доля холодной зоны | Доля бюджета дайджеста | Что сохранять |
|------|-------------------:|-----------------------:|---------------|
| Ближняя | последние 40% | 55% | детали, выбранные варианты, свежие ограничения, формулировки пользователя |
| Средняя | предыдущие 35% | 30% | решения, причины, важные повороты разговора |
| Дальняя | первые 25% | 15% | только общий смысл и ключевые исходные договорённости |

Этот вариант (зонирование) пересобирает весь дайджест заново при каждом срабатывании и используется по умолчанию.
Альтернатива для очень длинных диалогов — **послойное досжатие** (пересказ пересказа): свежие остывшие реплики
становятся верхним слоем `layer = 'near'`, а прежний дайджест пересжимается ещё сильнее и опускается в `'middle'`, затем
`'far'`. Это даёт тот же градиент дешевле (меньше вызовов суммаризатора), но качество дальнего слоя со временем
деградирует сильнее. Поле `layer` в схеме рассчитано на оба варианта: при зонировании активна одна строка `full`, при
послойном — несколько строк `near` / `middle` / `far`, из которых собирается итоговый `HISTORY_CONTEXT`.

---

## [HIST-4] Память против истории: разделение ролей

Роли трёх источников строго разведены, чтобы исключить дублирование. Долговременная память отвечает на вопрос «что мы
устойчиво знаем о пользователе, домене и задачах» и живёт в `memory_items`. Сжатая история отвечает на вопрос «что
происходило именно в этом разговоре и на чём остановились» и живёт в `conversation_summaries`. Тематический трекинг
(`topic_mentions`, критерий 13, см. [09-proactivity.md](09-proactivity.md)) отвечает на вопрос «какие темы и насколько
живо обсуждались» — поэтому дайджесту **не нужно заново перечислять темы**, если этот слой включён.

Главное правило против дублей: перед суммаризацией в модель передаётся текущая выбранная память (`active_memory`), а
суммаризатор получает жёсткую инструкцию не повторять в `summary_text` факты, которые уже есть в `active_memory`. В
истории остаётся только ход разговора: решения, незакрытые вопросы, выбранные варианты, причины изменений.

---

## [HIST-5] Приоритет источников при конфликте

Если источники противоречат друг другу, действует порядок (выше — важнее), и это правило явно прописывается в служебном
заголовке `HISTORY_CONTEXT`:

```text
1. Новое сообщение пользователя
2. Последние восемь сырых сообщений
3. Сжатая история диалога
4. Долговременная память
5. Старые дальние сводки
```

Пример: если в старой сводке пользователь выбрал вариант А, а в последних сообщениях отказался от него в пользу варианта
Б, актуальным считается вариант Б.

---

## [HIST-6] Схема хранения и миграция

Базовая таблица `mem.conversation_summaries` создаётся в `001_init.sql` (см. [05-data-schema.md](05-data-schema.md)), а
**миграция `003_history_summaries.sql`** определяет её служебные колонки через `ALTER TABLE ... ADD COLUMN IF NOT
EXISTS ...`, оставаясь идемпотентной:

```sql
ALTER TABLE mem.conversation_summaries
ADD COLUMN IF NOT EXISTS layer text NOT NULL DEFAULT 'full'
  CHECK (layer IN ('near','middle','far','full')),
ADD COLUMN IF NOT EXISTS covered_from_message_id uuid,
ADD COLUMN IF NOT EXISTS covered_to_message_id   uuid,
ADD COLUMN IF NOT EXISTS covered_until           timestamptz,
ADD COLUMN IF NOT EXISTS source_message_count    integer NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS source_token_count      integer NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS summary_token_count     integer NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS memory_dedupe           jsonb   NOT NULL DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS summary_version         integer NOT NULL DEFAULT 1,
ADD COLUMN IF NOT EXISTS is_active               boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_summaries_active_conversation
ON mem.conversation_summaries (conversation_id, created_at DESC) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_summaries_covered_until
ON mem.conversation_summaries (conversation_id, covered_until DESC);
```

При создании новой активной сводки прежние активные деактивируются (`is_active = false`), поэтому в каждом диалоге активна
ровно одна сводка. Служебные поля вынесены в явные колонки, а не в `state_json`: это упрощает SQL-запросы и проверки по
отдельным полям.

---

## [HIST-7] Конфигурация

Блок `historyCompression` — одно из полей объекта `config` в `src/config.js`, в том же стиле, что блоки `companion` и
`proactive`, и с тем же хелпером `flag` для булевых флагов:

```js
  // Поджатие старой части истории диалога. По умолчанию выключено, как и прочие необязательные контуры.
  historyCompression: {
    enabled: flag(env.HISTORY_COMPRESSION_ENABLED, false),
    hotWindow: Number(env.HISTORY_HOT_WINDOW || 8),
    maxTokens: Number(env.HISTORY_MAX_TOKENS || 2000),
    shrinkTokens: Number(env.HISTORY_SHRINK_TOKENS || 800),
    zoneWeights: String(env.HISTORY_ZONE_WEIGHTS || '0.55,0.30,0.15').split(',').map(Number),
    model: env.HISTORY_SUMMARY_MODEL || env.AUX_MODEL || '<AUX_MODEL>',
    minCompressGain: Number(env.HISTORY_MIN_COMPRESS_GAIN || 0.35),
  },
```

При старте приложения проверяется инвариант гистерезиса: `shrinkTokens` должен быть строго меньше `maxTokens`, иначе
сжатие запускалось бы практически на каждом сообщении. Полный список переменных окружения — в
[03-quickstart.md](03-quickstart.md), общий объект конфигурации — в [08-prompts-and-models.md](08-prompts-and-models.md).

---

## [HIST-8] Алгоритм сборки контекста

Сборка контекста в `src/agent.js` устроена так:
получить горячее окно и активную сводку; найти сообщения старше горячего окна, ещё не покрытые сводкой (`coldPending`);
посчитать суммарный размер сводки и непокрытого хвоста; если он превысил `HISTORY_MAX_TOKENS` — запустить суммаризатор,
передав ему активную память, и сохранить новую сводку; собрать `HISTORY_CONTEXT` и передать модели вместе с горячим окном
и новым сообщением.

```js
const memory = await retrieveMemory({ userId: user.id, domainKey: effectiveDomain, query: userMessage,
  scopes: intent.needed_memory_scopes || ['profile', 'dialog', 'domain'] });
const memoryContext = buildMemoryContext(memory, effectiveDomain);

const historyContext = await buildHistoryContext({
  userId: user.id, conversationId: conversation.id, domainKey: effectiveDomain, memory });

const hotMessages = await getRecentMessages(conversation.id, config.historyCompression.hotWindow);

const messages = [
  { role: 'system', content: MAIN_SYSTEM },
  { role: 'system', content: memoryContext },
  ...(historyContext ? [{ role: 'system', content: historyContext }] : []),
  ...hotMessages.map(toChatMessage),
  { role: 'user', content: userMessage },
];
```

Переменные `intent`, `effectiveDomain`, `user`, `conversation`, `userMessage` — имена контекста ответа в `agent.js`.
Целевой размер дайджеста берётся из `config.historyCompression.shrinkTokens`
внутри `maybeCompressHistory`, поэтому отдельный параметр `maxTokens` у `buildHistoryContext` на порог не влияет.

---

## [HIST-9] Модули пайплайна

Слой состоит из трёх файлов в `src/pipeline/`:

- **`history-context.js`** — `buildHistoryContext(...)`. При выключенном флаге возвращает пустую строку. Иначе вызывает
  `maybeCompressHistory`, берёт активную сводку и форматирует `HISTORY_CONTEXT` функцией `formatHistoryContext` —
  system-блок со служебным заголовком (правила использования и приоритеты), текстом сводки и оперативным состоянием.
- **`history-compress.js`** — `maybeCompressHistory(...)` решает по порогу, нужно ли сжимать, и при необходимости зовёт
  `summarizeColdHistory(...)`, который делит холодную зону на `near` / `middle` / `far`, распределяет бюджет по
  `HISTORY_ZONE_WEIGHTS`, передаёт `active_memory` суммаризатору и возвращает структурированный результат.
- **`token-counter.js`** — `estimateTokens(text)`: консервативная оценка числа токенов (см. ниже).

```js
export async function maybeCompressHistory({ userId, conversationId, domainKey, memory }) {
  const hotWindow = config.historyCompression.hotWindow;
  const activeSummary = await getActiveConversationSummary(conversationId);
  const hotMessages = await getRecentMessages(conversationId, hotWindow);
  const boundaryCreatedAt = hotMessages.length ? hotMessages[0].created_at : new Date();
  const coldPending = await getColdPendingMessages({ conversationId, beforeCreatedAt: boundaryCreatedAt,
    afterMessageId: activeSummary?.covered_to_message_id || null });

  const coldSize = estimateSummaryTokens(activeSummary) + sumMessageTokens(coldPending);
  if (coldSize <= config.historyCompression.maxTokens) return { compressed: false, reason: 'below_threshold' };

  const result = await summarizeColdHistory({ activeSummary, coldPending, memory,
    targetTokens: config.historyCompression.shrinkTokens, zoneWeights: config.historyCompression.zoneWeights, domainKey });
  await saveConversationSummary({ conversationId, userId, result, coldPending });
  return { compressed: true, coldSize, summaryTokens: result.summary_token_count };
}
```

За доступ к сводкам в `src/repo.js` отвечают функции `getActiveConversationSummary`, `saveConversationSummary`,
`getColdPendingMessages` и `markOldSummariesInactive`.

---

## [HIST-10] Подсчёт токенов

Важно: размеры считаются **нашим кодом**, а не моделью. `source_token_count` и `summary_token_count` вычисляются по полю
`token_count` сообщений и сводки, а не запрашиваются у суммаризатора, потому что языковая модель ненадёжно считает
собственные токены — иначе срабатывание порога «поедет».

Привычное деление «4 символа на токен» взято из английского текста и для кириллицы **сильно занижает** размер: русские
символы кодируются плотнее. Заниженная оценка опасна тем, что сжатие запустится позже, чем нужно, и холодная зона
раздуется сверх порога. Поэтому для кириллицы берётся более консервативный делитель — около трёх символов на токен:

```js
export function estimateTokens(text) {
  if (!text) return 0;
  const chars = String(text).length;
  const hasCyrillic = /[Ѐ-ӿ]/.test(text);
  const charsPerToken = hasCyrillic ? 3 : 4;
  return Math.ceil(chars / charsPerToken);
}
```

Для срабатывания порога безопаснее завышать оценку, чем занижать; эвристический делитель предпочтён точному токенизатору
под модель (например, `tiktoken`), чтобы не тянуть отдельную зависимость ради порога. В поле `token_count` таблицы
`conversation_messages` оценка записывается при сохранении сообщения: функция `saveMessage` (`src/repo.js`) вычисляет
`token_count` наряду с полями `tool_name`, `tool_call_id` и обновлением `updated_at` у диалога.

---

## [HIST-11] Суммаризатор: промпт и схема ответа

Суммаризатор сжимает только холодную зону (последние сообщения ему не передаются — они добавятся отдельно), не дублирует
факты из `active_memory`, описывает ближний контекст подробнее дальнего, выносит устойчивые факты в `facts_to_memory`, не
сохраняет секреты в открытом виде и не выдумывает того, чего не было. Он возвращает строго JSON по схеме (через тот же
`json_object` + текст схемы в системном сообщении, что описан в [08-prompts-and-models.md](08-prompts-and-models.md)).

Схема ответа содержит только смысловые поля; размеры в токенах в неё **намеренно не входят** — их считает код:

```json
{
  "type": "object", "additionalProperties": false,
  "required": ["summary_text", "state_json", "facts_to_memory",
               "dropped_because_in_memory", "sensitive_mentions_redacted"],
  "properties": {
    "summary_text": { "type": "string" },
    "state_json": { "type": "object", "additionalProperties": true, "properties": {
      "current_goal": { "type": ["string","null"] }, "current_task": { "type": ["string","null"] },
      "decisions": { "type": "array", "items": { "type": "string" } },
      "rejected_options": { "type": "array", "items": { "type": "string" } },
      "open_questions": { "type": "array", "items": { "type": "string" } },
      "constraints": { "type": "array", "items": { "type": "string" } },
      "next_steps": { "type": "array", "items": { "type": "string" } } } },
    "facts_to_memory": { "type": "array", "items": { "type": "object", "additionalProperties": true } },
    "dropped_because_in_memory": { "type": "array", "items": { "type": "string" } },
    "sensitive_mentions_redacted": { "type": "array", "items": { "type": "string" } }
  }
}
```

### Кандидаты в долговременную память

Поле `facts_to_memory` — это устойчивые факты, которые лучше хранить не в истории, а в долговременной памяти. Их нельзя
писать напрямую: они проходят тот же контур `extractCandidates` / `merge` / `persistCandidates`, что и обычное извлечение
фактов (см. [06-memory.md](06-memory.md)). Так сохраняется единая логика «порог важности → проверка чувствительности →
дедупликация → обновление вместо дублей» и не обходятся пороги автосохранения.

---

## [HIST-12] Защита от утечек и вредных инструкций

`HISTORY_CONTEXT`, как и `MEMORY_CONTEXT`, считается справкой, а не командами (та же защита от вредных инструкций в
данных, что в критерии 11, см. [02-criteria.md](02-criteria.md)). Служебный заголовок, который объявляет блок справочным,
ставит текущий запрос и последние сырые сообщения выше истории и запрещает раскрывать чувствительные данные, задаётся
единственный раз — в `formatHistoryContext`. Секреты в открытую сводку не пишутся; вместо значения остаётся пометка вроде
«пользователь упоминал защищённые данные; полное значение скрыто и не выводится без отдельного согласия».

---

## [HIST-13] Когда запускать сжатие

Проверка размера выполняется после каждого ответа, но сам вызов суммаризатора — только при превышении порога: сохранить
реплики пользователя и ассистента, посчитать размер холодной зоны, и если порог не превышен — ничего не делать. Так
основной ответ не тормозится лишним вызовом модели, а к следующему сообщению `HISTORY_CONTEXT` уже готов. Для тестов
предусмотрен режим `compressSync: true`, который заставляет дождаться завершения суммаризации, чтобы проверку можно было
выполнить сразу. Стабильный порядок блоков (стабильный промпт сверху, динамика снизу) сохраняет совместимость с
кэшированием начальной части запроса.

---

## [HIST-14] Тесты

Проверки оформлены слоем `layerHistory` в `tests/run.js` (не в отдельном файле) и выполняются только при
`HISTORY_COMPRESSION_ENABLED=true`; при выключенном флаге слой пропускается. Слой проверяет
двенадцать пунктов:

| № | Тест | Что проверяет |
|---:|------|---------------|
| 1 | Не достигли порога | суммаризатор не вызывается |
| 2 | Достигли порога | создаётся новая запись в `conversation_summaries` |
| 3 | Размер после сжатия | `summary_token_count <= HISTORY_SHRINK_TOKENS` |
| 4 | Горячее окно | последние восемь сообщений попадают в запрос дословно |
| 5 | Старые сообщения | не передаются сырым большим блоком |
| 6 | Градиент | ближняя часть подробнее дальней |
| 7 | Дедупликация с памятью | факт из `memory_items` не повторяется в `summary_text` |
| 8 | Конфликт | последние сообщения побеждают старую сводку |
| 9 | Секреты | защищённые данные не попадают в открытую сводку |
| 10 | Гистерезис | пара новых сообщений после сжатия не запускает повторное сжатие |
| 11 | Отключение функции | при `HISTORY_COMPRESSION_ENABLED=false` в запрос идут только последние восемь сообщений |
| 12 | Кандидаты в память | `facts_to_memory` проходят через обычный контур записи памяти |

---

## [HIST-15] Критерии приёмки

Функция готова, когда последние `N` сообщений всегда передаются дословно; старая история не теряется, а попадает в
`HISTORY_CONTEXT`; `HISTORY_CONTEXT` не превышает заданный размер; ближний старый контекст сохраняется подробнее дальнего;
история не повторяет факты из `MEMORY_CONTEXT`; секреты не попадают в открытую сводку; при конфликте свежие сообщения
важнее старой истории; при выключенном флаге в запрос идут только последние `N` сообщений; все проверки слоя проходят
автоматически.

---

## [HIST-16] План внедрения и метрики

Слой удобно собирать поэтапно, и тот же порядок подходит при переносе на другой проект: (1) конфиг, `token-counter`, заполнение
`token_count` и repo-функции при выключенном флаге; (2) простой дайджест холодной зоны без градиента и подача
`HISTORY_CONTEXT`; (3) градиентное сжатие `0.55 / 0.30 / 0.15`; (4) дедупликация с памятью через `active_memory` и
`dropped_because_in_memory`; (5) включение флага, логи и метрики, замер стоимости и задержки, подбор профиля.

Для отладки логируется событие `history_compression` с полями `source_message_count`, `source_token_count`,
`summary_token_count`, `compression_ratio`, `facts_dropped_because_in_memory`, `facts_to_memory`, `duration_ms`. Полезные
показатели: `compression_ratio` (насколько ужали историю), `summary_token_count` (не превышаем ли лимит),
`facts_dropped_because_in_memory` (работает ли защита от дублей), `duration_ms` (не тормозит ли суммаризатор) и
`summary_rebuild_count` (не пересжимаем ли слишком часто).

---

## Связанные документы

- Контур ответа `handleMessage` — [04-architecture.md](04-architecture.md)
- Схема данных и таблица `conversation_summaries` — [05-data-schema.md](05-data-schema.md)
- Пять видов памяти и контур записи фактов — [06-memory.md](06-memory.md)
- Промпты, прокси, строгий JSON и конфигурация — [08-prompts-and-models.md](08-prompts-and-models.md)
- Тематический трекинг и проактивность — [09-proactivity.md](09-proactivity.md)
- Критерии готовности — [02-criteria.md](02-criteria.md)
- Тесты и слои проверки — [10-operations.md](10-operations.md)
