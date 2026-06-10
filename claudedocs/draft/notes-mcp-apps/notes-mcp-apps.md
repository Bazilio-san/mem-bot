# План-промпт: инструментарий заметок с UI-виджетом (MCP + MCP Apps)

Этот документ — самодостаточное задание на реализацию. Его можно целиком отдать Claude Code как промпт.
Прототипы интерфейсов лежат рядом: `prototype-widget-admin.html` (виджет в чате админки) и
`prototype-miniapp-telegram.html` (Telegram Mini App).

---

## 1. Цель

Сделать в проекте `mem-bot` полноценный инструментарий заметок для LLM-агента:

1. Заметки хранятся в PostgreSQL, для заголовка и тела создаются эмбеддинги (pgvector),
   работает семантический + полнотекстовый поиск.
2. Инструментарий оформлен как **собственный MCP-сервер с поддержкой MCP Apps**
   (по образцу `@modelcontextprotocol/ext-apps`), чтобы тулы попадали в агента через уже существующий
   MCP-клиент проекта (`src/mcp/client.js`), а UI-ресурс был совместим со сторонними хостами.
3. Когда пользователь просит показать заметки, агент вызывает тул показа списка, и пользователю
   возвращается **виджет**: интерактивный список заметок с полным CRUD и ленивой подгрузкой при скролле.
   - В **чате админки** виджет рендерится нативным Vue-компонентом прямо в ленте чата — **без iframe**.
   - В **Telegram** виджет открывается как **Mini App** (кнопка `web_app` под сообщением бота).
4. Виджет работает через отдельное REST API, предоставляемое параллельно с инструментарием.
5. В историю LLM попадает только мета-информация: «пользователю показан список заметок»,
   «пользователь отредактировал заметку #12: изменён заголовок» и т. п. Сами данные заметок
   в историю из виджета не льются.

## 2. Исходный контекст

### 2.1. Что уже есть в mem-bot (переиспользуем)

| Компонент | Где | Что берём |
|---|---|---|
| Эмбеддинги | `src/llm.js` → `embed(text, {kind})` | OpenAI `text-embedding-3-small`, 1536 dims, логирование в LLM-журнал |
| pgvector + HNSW | `migrations/001_init.sql` (`mem.memory_items.embedding`) | Паттерн индексов и поиска `embedding <=> $1::vector` |
| MCP-клиент | `src/mcp/client.js`, конфиг `.mcp.json` | Тулы MCP-сервера сами попадут в агента с префиксом `notes__` |
| Регистрация тулов | `src/pipeline/tools.js` → `initTools()` | Ничего менять почти не нужно |
| История диалога | `mem.conversation_messages` (`metadata` jsonb), `src/repo.js` → `saveMessage()` | Для мета-событий CRUD |
| Админка | Vue 3 + PrimeVue 4 (Aura), `web/src/components/llm-log/ChatPane.vue`, `src/server/admin-api.js` | Рендер виджета в чате, новые API-маршруты |
| Telegram-бот | `src/telegram/bot.js`, `format.js` | Отправка сообщения с кнопкой `web_app`; нестандартные теги сейчас эскейпятся |
| HTTP-сервер | `src/server/index.js` (Express 5, порт 9019) | Хостинг REST API заметок и страницы Mini App |

### 2.2. Что берём из multi-bot как образец (`D:\DEV\FA\_cur\multi-bot\modules\notes`)

- Набор тулов: создание / список+поиск / редактирование / мягкое удаление.
- Изоляция по пользователю, мягкое удаление (`deleted`), теги.
- Гибридный поиск: вектор (cosine, `<=>`) + полнотекст (`plainto_tsquery('russian')`) + RRF-слияние
  (`score = wV/(K + rankV) + wF/(K + rankF)`, K=60, wV=0.7, wF=0.3).
- Чего НЕ тащим: общую таблицу `txt.dataset/txt.chunk` с чанкованием — для заметок это избыточно,
  делаем свою узкую таблицу `mem.notes`.

### 2.3. Что берём из MCP Apps (`D:\DEV\FA\_pub\fa-mcp-sdk\mcp-ext-apps`, дока
`D:\DEV\FA\_pub\fa-mcp-sdk\cli-template\FA-MCP-SDK-DOC\10-mcp-apps.md`)

- `registerAppTool(server, name, {_meta: {ui: {resourceUri: 'ui://notes/widget.html'}}}, cb)` —
  связка «тул → UI-ресурс».
- `registerAppResource(server, name, 'ui://notes/widget.html', {}, cb)` — отдача собранного HTML
  виджета с mime `text/html;profile=mcp-app`.
- Паттерн app-only тулов (`_meta.ui.visibility: ['app']`) — CRUD-тулы, которые видит только виджет,
  но не LLM (пригодится для сторонних хостов).

### 2.4. Важная развязка по iframe

Спецификация MCP Apps требует iframe **на стороне хоста** — это требование к чужим хостам
(Claude Desktop и т. п.), а не к нашему коду. Мы хосты контролируем сами, поэтому:

- **Чат админки**: виджет — обычный Vue-компонент `NotesWidget.vue` в ленте чата. Никакого iframe,
  никакого postMessage: компонент ходит напрямую в REST API заметок.
- **Telegram Mini App**: отдельная страница в WebView Телеграма — iframe там отсутствует по природе.
- **Совместимость**: `ui://notes/widget.html` (standalone-сборка того же Vue-компонента) всё равно
  регистрируем на MCP-сервере. Если когда-нибудь сервер подключат к Claude Desktop — виджет
  отрисуется там штатно (iframe в этом случае создаёт чужой хост, нас это не касается).

Итого требование «без iframe» выполняется во всех **наших** поверхностях.

---

## 3. Архитектура

```
                         ┌────────────────────────────────────────────┐
                         │ Notes MCP server (src/notes-mcp/server.js) │
 LLM-агент ──MCP(http)──▶│  tools: note_create, note_update,          │
 (src/agent.js,          │         note_delete, notes_search,         │
  src/mcp/client.js,     │         notes_show_widget                  │
  alias "notes")         │  resource: ui://notes/widget.html          │
                         └────────────────────────────────────────────┘
                                          │ общий слой
                                          ▼
                         ┌────────────────────────────────────────────┐
                         │ Notes core (src/notes/store.js)            │
                         │  CRUD + embeddings + hybrid search         │
                         │  mem.notes (pgvector, tsvector)            │
                         └────────────────────────────────────────────┘
                                          ▲
                                          │ REST (/api/notes/*)
        ┌─────────────────────────────────┴──────────────────────────┐
        │                                                            │
┌───────────────────┐                                   ┌─────────────────────────┐
│ Админ-чат (Vue)   │                                   │ Telegram Mini App       │
│ NotesWidget.vue   │                                   │ web/miniapp → WebView   │
│ инлайн, без iframe│                                   │ auth: initData          │
└───────────────────┘                                   └─────────────────────────┘
        │                CRUD-события → мета-сообщения              │
        └────────────▶ mem.conversation_messages ◀──────────────────┘
                       («пользователь отредактировал заметку #12…»)
```

---

## 4. Схема БД (новая миграция `migrations/00X_notes.sql`)

```sql
CREATE TABLE mem.notes (
  id              bigserial PRIMARY KEY,
  user_id         bigint NOT NULL REFERENCES mem.users(id) ON DELETE CASCADE,
  title           text NOT NULL DEFAULT '',
  body            text NOT NULL,
  tags            text[] NOT NULL DEFAULT '{}',
  pinned          boolean NOT NULL DEFAULT false,
  title_embedding vector(1536),
  body_embedding  vector(1536),
  search_tsv      tsvector GENERATED ALWAYS AS (
                    setweight(to_tsvector('russian', coalesce(title, '')), 'A') ||
                    setweight(to_tsvector('russian', coalesce(body, '')), 'B')
                  ) STORED,
  deleted_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_notes_user            ON mem.notes (user_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_notes_tsv             ON mem.notes USING gin (search_tsv);
CREATE INDEX idx_notes_tags            ON mem.notes USING gin (tags);
CREATE INDEX idx_notes_title_emb_hnsw  ON mem.notes USING hnsw (title_embedding vector_cosine_ops);
CREATE INDEX idx_notes_body_emb_hnsw   ON mem.notes USING hnsw (body_embedding vector_cosine_ops);
```

Решения: отдельные эмбеддинги на заголовок и тело (поиск берёт лучшее из двух расстояний);
мягкое удаление через `deleted_at`; чанкование не нужно — заметки короткие, при превышении лимита
модели эмбеддинга текст тела обрезается (отметить в коде константой).

## 5. Ядро заметок — `src/notes/store.js`

Функции (все принимают `userId`, чужие заметки недоступны):

- `createNote({userId, title, body, tags})` → запись + эмбеддинги через `embed()`; вернуть заметку.
- `updateNote({userId, id, title?, body?, tags?, pinned?})` → пересчитать эмбеддинги только
  изменившихся полей; `updated_at = now()`.
- `deleteNote({userId, id})` → `deleted_at = now()`.
- `getNote({userId, id})`.
- `listNotes({userId, cursor, limit=20, q?, tag?})`:
  - без `q` — курсорная пагинация по `(updated_at, id) DESC` (для ленивой подгрузки в виджете);
  - с `q` — гибридный поиск: эмбеддинг запроса один раз; вектор:
    `LEAST(title_embedding <=> $v, body_embedding <=> $v)` с порогом ~`0.6` cosine distance,
    полнотекст: `search_tsv @@ plainto_tsquery('russian', $q)`; слияние RRF (K=60, 0.7/0.3);
    у результатов поиска пагинация offset-ная (результатов мало).
- Ошибки эмбеддинга не валят CRUD: заметка сохраняется, эмбеддинг — best effort
  (поле остаётся NULL, такая заметка ищется только полнотекстом). `embed()` уже возвращает null
  на ошибку — этого достаточно.

## 6. MCP-сервер заметок — `src/notes-mcp/`

Отдельный HTTP MCP-сервер (порт из `config` → `notesMcp.port`, например 3789), процессом внутри
основного приложения (поднимать из `src/server/index.js` или `src/cli.js`, как удобнее по структуре).
Использовать `@modelcontextprotocol/sdk` + паттерны `registerAppTool`/`registerAppResource`
из `mcp-ext-apps` (пакет добавить в зависимости; если публичной версии нет — скопировать
минимальные хелперы `registerAppTool`/`registerAppResource`, они тонкие).

Регистрация в `.mcp.json` (и в `local.example.yaml` пример): alias `notes`, тулы придут в агента
как `notes__note_create` и т. д. — существующий `loadMcpTools()` подхватит их без доработок.

**Передача пользователя.** MCP-вызов идёт от агента, который знает `userId`. Прокинуть его
заголовком `X-User-Id` при вызове (см. как `connection.call()` устроен в `src/mcp/client.js`;
если прокидывание заголовков не поддержано — добавить поле `userContext` в обёртку `wrapMcpTool()`
и передавать `userId` скрытым аргументом тула, который агент подставляет сам и который вычищается
из схемы, видимой LLM).

### Тулы (видимые LLM)

| Тул | Параметры | Возвращает |
|---|---|---|
| `note_create` | `title?`, `body`, `tags?` | `{id, title}` + текст «Заметка #N создана» |
| `note_update` | `id`, `title?`, `body?`, `tags?` | подтверждение |
| `note_delete` | `id` | подтверждение |
| `notes_search` | `query?`, `tag?`, `limit?` | компактный список `{id, title, snippet, updatedAt}` — для случаев, когда LLM нужно содержимое (ответить на вопрос по заметкам) |
| `notes_show_widget` | `query?` (предфильтр) | см. ниже |

`notes_show_widget` — ключевой тул показа интерфейса:

```js
// _meta связывает тул с UI-ресурсом — это и есть MCP Apps
registerAppTool(server, 'notes_show_widget', {
  description: 'Показать пользователю интерактивный список заметок (виджет с поиском и CRUD)',
  inputSchema: { query: { type: 'string' } },
  _meta: { ui: { resourceUri: 'ui://notes/widget.html' } },
}, async ({ query }, { userId }) => {
  const token = issueWidgetToken(userId);            // см. §8
  return {
    content: [{ type: 'text', text: `Пользователю показан виджет списка заметок${query ? ` (фильтр: «${query}»)` : ''}. Всего заметок: ${count}.` }],
    structuredContent: {
      widget: { type: 'notes', dataUrl: `/api/notes`, token, query: query || '' },
    },
  };
});
```

В `content.text` — только мета-информация (она и попадёт в историю LLM). Данные виджет тянет сам.

### UI-ресурс

`registerAppResource(server, 'Notes Widget', 'ui://notes/widget.html', …)` отдаёт standalone-сборку
виджета (Vite single-file build того же Vue-компонента). Нужен только для сторонних MCP Apps-хостов;
наши поверхности этот ресурс не используют.

## 7. REST API виджета — `src/server/notes-api.js` (монтируется в `src/server/index.js`)

| Маршрут | Действие |
|---|---|
| `GET  /api/notes?cursor=&limit=&q=&tag=` | список / поиск, курсорная пагинация (ответ: `{items, nextCursor, total}`) |
| `GET  /api/notes/:id` | одна заметка |
| `POST /api/notes` | создать (`{title, body, tags}`) |
| `PATCH /api/notes/:id` | обновить |
| `DELETE /api/notes/:id` | мягко удалить |

Все маршруты используют `src/notes/store.js` (никакой дублирующей логики), авторизация — §8.
Каждая мутация (POST/PATCH/DELETE) после успеха пишет мета-событие в историю (§9).

## 8. Авторизация виджета

Два контекста, один механизм досмотра `userId` на каждом запросе:

1. **Widget-token (чат админки и универсальный случай).** `notes_show_widget` выпускает
   короткоживущий HMAC-токен: `base64url(payload).sig`, payload `{userId, conversationId, exp}`
   (TTL ~24 ч, секрет в конфиге `notes.widgetSecret`). Виджет шлёт его в заголовке
   `Authorization: Bearer <token>`. Никаких таблиц сессий не нужно.
2. **Telegram Mini App.** Страница `GET /miniapp/notes` (отдаётся тем же Express).
   Клиент шлёт `window.Telegram.WebApp.initData` в заголовке `X-Tg-Init-Data`; сервер валидирует
   подпись HMAC-SHA256 ключом бота (стандартный алгоритм проверки initData), достаёт
   `user.id` → маппинг на `mem.users`. Токен в этом случае не нужен.

## 9. Мета-информация в историю LLM

Требование: LLM должна знать, что пользователь делал в виджете, не получая тяжёлых данных.

- Показ виджета: текст результата тула `notes_show_widget` уже попадает в историю штатно
  (тул-результат), отдельного действия не нужно.
- CRUD из виджета: после каждой успешной мутации REST API вызывает
  `saveMessage(conversationId, userId, 'system', text, {metadata})`, где `text` — человекочитаемая
  строка, например:
  - `[notes] Пользователь создал заметку #15 «Покупки»`
  - `[notes] Пользователь отредактировал заметку #12: изменены заголовок и тело`
  - `[notes] Пользователь удалил заметку #7`
  и `metadata = { source: 'notes_widget', action: 'update', note_id: 12, changed: ['title','body'] }`.
- `conversationId` берётся из widget-токена; для Mini App — активный диалог пользователя
  (найти текущую беседу так же, как это делает `src/agent.js`). Если диалога нет — событие
  пишется без `conversation_id` (или пропускается — выбрать по месту, задокументировать).
- Проверить, что сборщик контекста агента включает такие system-сообщения в промпт следующего хода
  (если фильтрует — добавить их в выборку явно).

## 10. Виджет — Vue-компонент `web/src/components/notes/NotesWidget.vue`

Поведение (см. прототип `prototype-widget-admin.html`):

- Шапка: поле поиска (семантический поиск — debounce 400 мс, дёргает `GET /api/notes?q=`),
  кнопка «Новая заметка», счётчик.
- Список карточек: заголовок, сниппет тела (3 строки), теги, дата изменения; закреплённые сверху.
- **Ленивая подгрузка**: IntersectionObserver на нижнем «сторожевом» элементе → догрузка по
  `nextCursor` пачками по 20.
- CRUD: создание/редактирование в инлайн-форме (или Dialog PrimeVue), удаление с подтверждением,
  пин-кнопка. Все операции — через REST API, оптимистичное обновление списка.
- Стек админки: PrimeVue-компоненты (DataView/Dialog/Tag/InputText) — единый стиль с остальной
  админкой.

Интеграция в чат админки:

- В `ChatPane.vue` (и/или таймлайн `App.vue`): если у сообщения
  `metadata.toolsUsed[].result.structuredContent.widget?.type === 'notes'` — отрендерить под
  сообщением `<NotesWidget :token="..." :initial-query="...">`. Это и есть аналог тега
  `<widget …>` из постановки: маркером служит structuredContent тула, отдельный текстовый тег
  парсить не нужно (надёжнее, чем парсинг текста LLM). Проверить, что `toolsUsed` в metadata
  сохраняет structuredContent; если нет — добавить.

Telegram:

- В `src/telegram/bot.js`: при появлении в результатах тулов `structuredContent.widget.type==='notes'`
  бот прикрепляет к финальному сообщению inline-кнопку
  `{ text: '📝 Открыть заметки', web_app: { url: `${config.publicUrl}/miniapp/notes?q=...` } }`.
  Нужен публичный HTTPS URL (`config.notes.publicUrl`) — Telegram требует https для web_app;
  для разработки — туннель (cloudflared/ngrok), отметить в конфиге.
- Страница Mini App: та же Vue-сборка виджета в обёртке с Telegram-темой
  (`Telegram.WebApp.themeParams` → CSS-переменные), см. прототип `prototype-miniapp-telegram.html`.
  Собирается Vite в `web/` отдельной entry-точкой (multi-page build), Express отдаёт статику.

## 11. Порядок реализации (фазы)

1. **Миграция + ядро**: `migrations/00X_notes.sql`, `src/notes/store.js`, юнит-тесты стора
   (`tests/notes-store.test.mjs`): CRUD, изоляция пользователей, гибридный поиск, курсорная пагинация.
2. **REST API + авторизация**: `src/server/notes-api.js`, widget-токен, валидация initData,
   мета-события в историю; тесты API (`tests/notes-api.test.mjs`).
3. **MCP-сервер**: `src/notes-mcp/server.js`, 5 тулов + UI-ресурс, регистрация в `.mcp.json`,
   прокидывание `userId`; интеграционный тест: тулы видны агенту, `notes_show_widget` возвращает
   токен и мета-текст.
4. **Виджет в админке**: `NotesWidget.vue`, интеграция в `ChatPane.vue`, ленивая подгрузка, CRUD.
5. **Telegram Mini App**: entry-точка сборки, страница `/miniapp/notes`, кнопка `web_app` в боте,
   Telegram-тема. Проверка через скилл `/test-telegram-bot`.
6. **UI-ресурс MCP Apps**: standalone-сборка виджета, `registerAppResource`, smoke-проверка через
   `basic-host` из `mcp-ext-apps` (опционально, низкий приоритет).
7. Документация: отразить в `docs/ai-bot-with-memory/` и `docs/telegram/telegram-bot.md`
   по принципам соответствующих `00-documentation-principles.md`.

## 12. Конфигурация (добавить в `config/default.yaml` + `custom-environment-variables.yaml`)

```yaml
notes:
  enabled: true
  widgetSecret: ''        # HMAC-секрет widget-токенов (env NOTES_WIDGET_SECRET)
  publicUrl: ''           # https-URL для Telegram Mini App (env NOTES_PUBLIC_URL)
  mcp:
    port: 3789
  search:
    vectorThreshold: 0.6  # макс. cosine distance
    rrfK: 60
    vectorWeight: 0.7
    fulltextWeight: 0.3
```

## 13. Принятые решения (зафиксированы заказчиком)

1. MCP-сервер заметок поднимается **в том же процессе**, что и основной сервер; отдельный порт —
   только для MCP-транспорта.
2. `notes_search` для LLM **нужен** наряду с виджетом: виджет — для просмотра человеком,
   `notes_search` — для ответов LLM по содержимому заметок («что я записывал про X?»).
3. Восстановление удалённых заметок (undo) — **делаем**: `restoreNote()` в сторе,
   `POST /api/notes/:id/restore` в API, тул `note_restore` для LLM, кнопка «Отменить»
   в тосте виджета после удаления.
4. Лимиты — **приняты**: тело заметки до 20 000 символов (константа `NOTE_BODY_MAX`),
   для эмбеддинга тела используются первые 8 000 символов (константа `EMBED_BODY_CHARS`).

## 14. Обязательные требования к качеству

- **Пакет тестов обязателен** на каждую фазу: стор (CRUD, изоляция пользователей, undo, гибридный
  поиск, курсорная пагинация), REST API (авторизация, мета-события), MCP-тулы (регистрация,
  widget-токен). Исполнитель сам прогоняет все тесты и добивается зелёного прогона —
  «реализовано, но не проверено» не принимается.
- **Финальная стадия — документация**: отразить новшества в обоих комплектах документации
  (`docs/ai-bot-with-memory/` и `docs/telegram/telegram-bot.md`), предварительно прочитав
  соответствующие `00-documentation-principles.md`.
