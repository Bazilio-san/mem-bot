# План-промпт: подключение MCP-серверов как источника инструментов агента

Это готовый к исполнению план. Он сверен с фактическим кодом проекта (ссылки на файлы и строки приведены
ниже) и с текущей документацией пакета `@modelcontextprotocol/sdk`. Выполняйте разделы по порядку; в конце
есть чек-лист и команды проверки.

## Цель

Подключить внешние серверы, работающие по протоколу MCP (Model Context Protocol — открытый стандарт, по
которому внешний процесс предоставляет языковой модели набор инструментов), и сделать их инструменты видимыми
агенту наравне со встроенными. Первый подключаемый сервер — `mcp-yafly`, он слушает адрес
`http://localhost:9047/mcp`. После внедрения инструмент сервера должен появляться у модели под именем
`yafly__<исходное_имя>` и вызываться обычным циклом агента без какой-либо его переделки.

## Проверенные факты о текущем коде

Эти утверждения проверены чтением исходников — на них опирается весь план.

- Каждый локальный инструмент — это объект вида `{ name, title, definition, requiresAdmin?, isEnabled?,
  handler(ctx, args) }`. Образец — `src/pipeline/agent-tools/set-reply-mode.js`. Поле `definition` имеет
  формат OpenAI: `{ type: 'function', function: { name, description, parameters } }`, где `parameters` —
  это JSON Schema параметров.
- Все объекты собраны в массив `allTools` в `src/pipeline/agent-tools/index.js`.
- Реестр и доступ к инструментам — в `src/pipeline/tools.js`. Важная деталь, отличающаяся от прежней
  редакции этого документа: там нет переменной `registry`. Вместо неё модуль на этапе загрузки вычисляет
  **константы** `tools`, `toolDefs`, `toolMeta` и `TOOLS_BY_NAME` напрямую из `allTools`
  (`src/pipeline/tools.js:7-11`). Функция `buildToolDefs(ctx)` фильтрует именно `allTools`
  (`src/pipeline/tools.js:17-21`), а `getTool(name)` читает константу `TOOLS_BY_NAME`
  (`src/pipeline/tools.js:23-25`). Значит, чтобы добавить инструменты во время выполнения, эти константы
  придётся сделать перезаписываемыми (`let`) и пересобрать в функции инициализации.
- Проверка прав, журналирование и обработка ошибок уже сделаны единообразно в `executeTool`
  (`src/pipeline/tools.js:28-73`): она проверяет `tool.requiresAdmin` против `ctx.isAdmin`, пишет вызов
  через `logToolCall` и оборачивает ошибки. Для инструментов MCP отдельный код по этим трём пунктам не нужен —
  они получат всё это автоматически, как только попадут в реестр.
- `toolTitle(name)` (`src/pipeline/tools.js:13-15`) читает `toolMeta`. Чтобы у инструментов MCP в журналах
  и в статусах «Вызываю инструмент: …» было человекочитаемое имя, `toolMeta` тоже нужно пополнить при
  инициализации, иначе `toolTitle` вернёт техническое имя `yafly__…`.
- Цикл агента находится в `src/agent.js`. Он берёт схемы вызовом `buildToolDefs(ctx)`
  (`src/agent.js:226`), строит из них справку о возможностях `buildCapabilitiesContext`
  (`src/agent.js:53-66`, вызов на строке 227) и исполняет инструмент через `executeTool`
  (`src/agent.js:277`). Сам цикл инструментов трогать не нужно — он не знает, откуда взялся инструмент.
- Точка входа агента одна — функция `handleMessage` в `src/agent.js` (объявление около `src/agent.js`,
  тело вынесено во внутреннее замыкание `runAgent`). Её вызывают **четыре** места:
  `src/telegram/bot.js`, `src/cli.js`, `src/sandbox/data.js` (страница-песочница) и косвенно фоновый
  контур. Прежняя редакция документа называла только три точки входа и предлагала добавлять вызов
  инициализации в каждую из них — это и хрупко (легко забыть новую точку входа), и неверно по числу мест.
  План ниже инициализирует MCP **один раз и лениво внутри `handleMessage`**, что автоматически покрывает
  все вызывающие места.
- Константа `toolMeta` дополнительно используется в тестах (`tests/run.js:152` и `tests/run.js:163`).
  Перевод её из `const` в `let` совместим с этим: при импорте через `import { toolMeta }` действует живая
  привязка модуля, поэтому тесты увидят обновлённое значение.

## Принятые решения (зафиксированы заказчиком)

- **Переподключение к серверу — сразу.** Соединение держим открытым на весь процесс, но при ошибке вызова,
  похожей на разрыв связи, выполняем одну попытку переподключения и повторяем вызов.
- **Тайм-аут вызова инструмента — 90 секунд.** Передаётся вторым аргументом в `callTool` как
  `{ timeout: 90000 }`, чтобы зависший сервер не блокировал цепочку рассуждений агента.
- **Аутентификация пока не нужна.** Для локального `mcp-yafly` токен не требуется. Проброс заголовков
  транспорта (через `requestInit`) уже подключён: если в записи сервера задать поле `headers`, они уйдут в
  запрос — это готовое место для будущего токена. Самого токена сейчас нет.
- **Разграничение доступа** закрывается уже существующими механизмами `requiresAdmin` и `isEnabled` —
  отдельного кода не пишем, только пробрасываем эти признаки из конфигурации сервера в обёртку инструмента.

## Зависимость и сверенный API пакета

Установить официальный клиент:

```bash
npm install @modelcontextprotocol/sdk
```

API ниже сверен с документацией пакета (`/modelcontextprotocol/typescript-sdk`) на момент написания плана:

- Клиент создаётся как `new Client({ name, version })`.
- Транспорт потокового HTTP — `new StreamableHTTPClientTransport(new URL(url))`, подключение —
  `await client.connect(transport)`.
- Список инструментов выдаётся **постранично**: `await client.listTools({ cursor })` возвращает
  `{ tools, nextCursor }`. Нужно крутить цикл, пока `nextCursor` не станет пустым, иначе при большом числе
  инструментов часть из них потеряется.
- Вызов инструмента — `await client.callTool({ name, arguments }, { timeout })`. Результат содержит
  `content` (массив блоков, у текстовых блоков `type === 'text'` и поле `text`) и признак ошибки `isError`.

Перед началом работы всё равно сверьте имена один раз с установленной версией, выполнив, например,
`node -e "import('@modelcontextprotocol/sdk/client/index.js').then(m=>console.log(Object.keys(m)))"`.

## Изменения по файлам

### 1. Новый файл `src/mcp/config.js` — загрузка серверов из `.mcp.json` (формат Claude Code)

Список серверов читается из JSON-файла `.mcp.json` в корне проекта. Формат совпадает с тем, который понимает
Claude Code: объект `mcpServers`, где ключ — это короткое имя сервера (`alias`), а значение — его описание.
Файл намеренно вынесен из-под контроля версий (добавлен в `.gitignore`): у каждого окружения он свой и может
содержать секреты. Отсутствие файла, повреждённый JSON или неверная структура не должны ронять процесс — в
этом случае система просто работает без MCP-инструментов, а содержательная причина пишется в журнал.

Пример `.mcp.json` (рядом лежит отслеживаемый шаблон `.mcp.json.example`):

```json
{
  "mcpServers": {
    "yafly": {
      "type": "http",
      "url": "http://localhost:9047/mcp",
      "title": "Yafly",
      "requiresAdmin": false
    }
  }
}
```

Ключ объекта (`yafly`) становится префиксом `alias` в именах инструментов модели. Стандартные поля Claude Code —
`type` (поддерживаются `http` и `sse`), `url`, `headers` (место для будущего токена авторизации). Необязательные
расширения, которых нет в стандартном формате Claude Code: `title` (человекочитаемое имя для журналов и статусов),
`requiresAdmin` (инструменты сервера доступны только администратору) и `disabled` (выключить сервер, не удаляя
запись). Путь к файлу можно переопределить переменной окружения `MCP_CONFIG_PATH`.

```js
// src/mcp/config.js
// Список подключаемых MCP-серверов читается из JSON-файла в формате Claude Code (.mcp.json).
// Файл не под контролем версий (см. .gitignore): у каждого окружения он свой и может содержать секреты.
// Отсутствие файла или ошибка разбора не должны ронять процесс — в этом случае серверов просто нет.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CONFIG_PATH = resolve(process.cwd(), process.env.MCP_CONFIG_PATH || '.mcp.json');

// Привести одну запись секции mcpServers к внутреннему описанию сервера. Поддерживается только транспорт
// по HTTP/SSE (нужен url). Поля title, requiresAdmin и disabled — необязательные расширения формата.
function normalizeServer(alias, raw) {
  const type = raw.type || 'http';
  if (type !== 'http' && type !== 'sse') {
    console.error(`MCP «${alias}»: транспорт «${type}» не поддерживается (нужен http/sse). Пропускаю.`);
    return null;
  }
  if (!raw.url) {
    console.error(`MCP «${alias}»: не задан url. Пропускаю.`);
    return null;
  }
  return {
    alias,
    title: raw.title || alias,
    url: raw.url,
    headers: raw.headers || null,            // заголовки транспорта — место для будущего токена авторизации
    enabled: raw.disabled !== true,          // совместимо с полем «disabled» из формата Claude Code
    requiresAdmin: raw.requiresAdmin === true,
  };
}

// Прочитать и разобрать .mcp.json. Любой сбой (нет файла, битый JSON, не тот формат) приводит к пустому
// списку серверов, а не к падению процесса.
export function loadMcpServers() {
  let text;
  try {
    text = readFileSync(CONFIG_PATH, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];    // файла нет — это штатная ситуация, не ошибка
    console.error(`MCP: не удалось прочитать ${CONFIG_PATH}: ${err.message}. MCP-серверы отключены.`);
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    console.error(`MCP: ${CONFIG_PATH} содержит некорректный JSON: ${err.message}. MCP-серверы отключены.`);
    return [];
  }
  const servers = parsed && parsed.mcpServers;
  if (!servers || typeof servers !== 'object') {
    console.error(`MCP: в ${CONFIG_PATH} нет объекта «mcpServers». MCP-серверы отключены.`);
    return [];
  }
  return Object.entries(servers).map(([alias, raw]) => normalizeServer(alias, raw)).filter(Boolean);
}
```

### 2. Новый файл `src/mcp/client.js` — клиент, обёртка, переподключение

Адаптер подключается к каждому включённому серверу, забирает список инструментов (с учётом постраничной
выдачи) и оборачивает каждый в объект формата локального реестра. Метод `handler` вызывает инструмент на
сервере с тайм-аутом 90 секунд и одной попыткой переподключения при разрыве связи. Сбой одного сервера при
старте не мешает остальным и не роняет процесс.

```js
// src/mcp/client.js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadMcpServers } from './config.js';

const CALL_TIMEOUT_MS = 90_000; // предел ожидания ответа инструмента MCP; зависший сервер не блокирует агента

// Одно живое подключение к серверу. Храним клиента, чтобы переиспользовать соединение между вызовами
// и уметь переподключаться при разрыве, не пересобирая реестр инструментов.
class McpConnection {
  constructor(server) {
    this.server = server;
    this.client = null;
  }

  // Установить соединение, если его ещё нет. Повторный вызов при живом клиенте — это пустая операция.
  async ensureConnected() {
    if (this.client) return this.client;
    const client = new Client({ name: 'inter-2', version: '1.0.0' });
    // Заголовки транспорта пробрасываем только если они заданы в конфигурации — это место для будущего токена.
    const options = this.server.headers ? { requestInit: { headers: this.server.headers } } : undefined;
    const transport = new StreamableHTTPClientTransport(new URL(this.server.url), options);
    await client.connect(transport);
    this.client = client;
    return client;
  }

  // Принудительно сбросить клиента — следующий ensureConnected() создаст новое соединение.
  async reset() {
    const old = this.client;
    this.client = null;
    if (old) {
      try { await old.close(); } catch { /* сервер уже мог разорвать связь — это не ошибка */ }
    }
  }

  // Получить полный список инструментов сервера с учётом постраничной выдачи (курсора).
  async listAllTools() {
    const client = await this.ensureConnected();
    const all = [];
    let cursor;
    do {
      const { tools, nextCursor } = await client.listTools({ cursor });
      all.push(...tools);
      cursor = nextCursor;
    } while (cursor);
    return all;
  }

  // Вызвать инструмент. При ошибке, похожей на разрыв связи, переподключаемся один раз и повторяем.
  async call(name, args) {
    try {
      const client = await this.ensureConnected();
      return await client.callTool({ name, arguments: args || {} }, { timeout: CALL_TIMEOUT_MS });
    } catch (err) {
      if (!isConnectionError(err)) throw err;
      await this.reset();
      const client = await this.ensureConnected();
      return await client.callTool({ name, arguments: args || {} }, { timeout: CALL_TIMEOUT_MS });
    }
  }
}

// Грубая, но достаточная эвристика «это разрыв связи, имеет смысл переподключиться».
// Тайм-аут вызова сюда намеренно не попадает: повторять заведомо долгий вызов смысла нет.
function isConnectionError(err) {
  const msg = String(err?.message || err).toLowerCase();
  return msg.includes('econnrefused') || msg.includes('econnreset') || msg.includes('socket')
    || msg.includes('network') || msg.includes('closed') || msg.includes('disconnect');
}

// Текстовые блоки ответа MCP склеиваем в одну строку — модели нужен текст, а не структура транспорта.
function describeContent(content) {
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

// Превратить одно описание инструмента MCP в объект формата локального реестра инструментов.
function wrapMcpTool(connection, server, mcpTool) {
  const prefixedName = `${server.alias}__${mcpTool.name}`;
  const requiresAdmin = server.requiresAdmin === true;
  return {
    name: prefixedName,
    title: `${server.title}: ${mcpTool.name}`,
    requiresAdmin,
    // Если инструмент только для администратора, прячем его и из справки о возможностях для остальных,
    // повторяя поведение локальных admin-инструментов (см. global-fact-*). Иначе инструмент виден всегда.
    isEnabled: requiresAdmin ? (ctx) => ctx.isAdmin === true : undefined,
    definition: {
      type: 'function',
      function: {
        name: prefixedName,
        description: mcpTool.description || `Инструмент сервера ${server.title}`,
        parameters: mcpTool.inputSchema || { type: 'object', properties: {} },
      },
    },
    async handler(ctx, args) {
      // Имя на сервере — без префикса; префикс существует только на стороне модели.
      const res = await connection.call(mcpTool.name, args);
      if (res.isError) {
        return { error: `Ошибка инструмента ${prefixedName}: ${describeContent(res.content)}` };
      }
      return { content: res.content };
    },
  };
}

// Подключиться ко всем включённым серверам и вернуть готовые к регистрации обёртки инструментов.
// Недоступный сервер логируется и пропускается: агент продолжает работать на остальных инструментах.
export async function loadMcpTools() {
  const collected = [];
  for (const server of loadMcpServers()) {
    if (!server.enabled) continue;
    const connection = new McpConnection(server);
    try {
      const tools = await connection.listAllTools();
      for (const mcpTool of tools) collected.push(wrapMcpTool(connection, server, mcpTool));
      console.log(`MCP «${server.title}»: подключено инструментов — ${tools.length}.`);
    } catch (err) {
      console.error(`MCP «${server.title}» не подключился (${server.url}): ${err.message}. Пропускаю.`);
    }
  }
  return collected;
}
```

### 3. Правка `src/pipeline/tools.js` — перезаписываемый реестр и одноразовая инициализация

Сделать выводимые из `allTools` значения перезаписываемыми и добавить идемпотентную функцию `initTools`,
которая один раз дополняет реестр инструментами MCP и пересобирает производные структуры. Функции
`buildToolDefs`, `getTool`, `toolTitle` после этого должны опираться на перезаписываемый реестр, а не на
исходный `allTools`.

Конкретные изменения:

- Заменить `const` на `let` для `toolDefs`, `toolMeta` и `TOOLS_BY_NAME` (строки `src/pipeline/tools.js:8-11`).
  Экспорт `tools` оставить как есть — он не участвует в горячем пути; при желании его можно тоже перевести в
  `let` и пересобирать, но это не обязательно.
- Ввести перезаписываемый массив реестра, например `let registry = [...allTools];`, и переписать
  `buildToolDefs` и `getTool` на работу с ним вместо прямого обращения к `allTools`.
- Добавить функцию инициализации:

```js
// дополнение к src/pipeline/tools.js
import { loadMcpTools } from '../mcp/client.js';

let initPromise = null; // кэш промиса: инициализация выполняется ровно один раз на процесс

// Однократно подключает инструменты MCP и пересобирает реестр. Повторные вызовы возвращают тот же промис,
// поэтому безопасно вызывать из любой точки входа и при каждом сообщении.
export function initTools() {
  if (!initPromise) {
    initPromise = (async () => {
      const mcp = await loadMcpTools();
      if (mcp.length === 0) return;            // нечего добавлять — реестр остаётся прежним
      registry = [...registry, ...mcp];
      toolDefs = registry.map((t) => t.definition);
      toolMeta = Object.fromEntries(registry.map((t) => [t.name, { title: t.title }]));
      TOOLS_BY_NAME = new Map(registry.map((t) => [t.name, t]));
    })();
  }
  return initPromise;
}
```

После этой правки проверка прав, журналирование и обработка ошибок в `executeTool` применяются к
инструментам MCP автоматически — отдельного кода для них писать не нужно.

### 4. Правка `src/agent.js` — единая ленивая инициализация

Дождаться `initTools()` один раз в самом начале `handleMessage`, до построения схем инструментов
(`buildToolDefs` на `src/agent.js:226`). Поскольку `initTools` кэширует промис, реальная загрузка
произойдёт только при первом сообщении, а все последующие вызовы мгновенно вернут тот же промис. Один этот
вызов покрывает все четыре места, вызывающие `handleMessage` (Telegram-бот, командная строка, песочница,
фоновый контур), — править точки входа по отдельности не нужно.

```js
// в начале src/agent.js
import { buildToolDefs, executeTool, toolTitle, initTools } from './pipeline/tools.js';

// ...внутри handleMessage, до первого обращения к инструментам (перед строкой buildToolDefs):
await initTools();
```

### 5. Файл конфигурации и `.gitignore`

Переменные окружения для MCP не используются. Вместо этого:

- Добавить `.mcp.json` в `.gitignore` — рабочая конфигурация не попадает в репозиторий и может содержать секреты.
- Создать отслеживаемый шаблон `.mcp.json.example` с примером записи сервера (см. формат в разделе 1), чтобы было
  понятно, какие поля заполнять.
- Локально создать `.mcp.json` из шаблона. Отсутствие файла не ошибка: агент просто работает без MCP-инструментов.

## Что получаем на примере mcp-yafly

1. При первом сообщении пользователя бот один раз подключается к `http://localhost:9047/mcp` и запрашивает
   список инструментов Yafly (со всеми страницами выдачи).
2. Каждый инструмент Yafly появляется у модели под именем `yafly__<имя>` с исходным описанием и схемой
   параметров.
3. Когда задача пользователя относится к умениям Yafly, модель сама выбирает нужный `yafly__*`-инструмент,
   цикл агента исполняет его через `executeTool`, и результат уходит обратно модели — с тайм-аутом 90 секунд
   и автоматическим переподключением при разрыве связи.
4. В ответе на вопрос «что ты умеешь» инструменты Yafly попадут в `CAPABILITIES_CONTEXT` автоматически,
   потому что справка строится из `buildToolDefs` (`src/agent.js:53-66`).

## Проверка результата

1. **Юнит-тесты не сломаны.** Запустить `npm test` и убедиться, что набор проходит. Перевод `toolMeta` из
   `const` в `let` совместим с проверками в `tests/run.js`.
2. **Подключение при старте.** Запустить бота (`npm run telegram`) или командную строку (`npm run chat`) при
   запущенном `mcp-yafly` и убедиться, что в журнале появляется строка
   «MCP «Yafly»: подключено инструментов — N.».
3. **Изоляция сбоя.** Остановить `mcp-yafly`, перезапустить бота и убедиться, что процесс не падает, а в
   журнале появляется сообщение о пропуске недоступного сервера.
4. **Реальный вызов через бота.** Прогнать сценарий, который заставляет модель вызвать `yafly__*`-инструмент,
   через навык `/test-telegram-bot` (драйвинг живого бота в Telegram Web), и убедиться, что в статусах виден
   человекочитаемый заголовок инструмента, а результат корректно возвращается модели.
5. **Переподключение.** Во время работы перезапустить `mcp-yafly` и повторить вызов инструмента — он должен
   отработать после одной автоматической попытки переподключения.

## Чек-лист выполнения

- [ ] `npm install @modelcontextprotocol/sdk`, сверить имена экспортов с установленной версией.
- [ ] Создать `src/mcp/config.js`.
- [ ] Создать `src/mcp/client.js`.
- [ ] Перевести производные значения в `src/pipeline/tools.js` в `let`, ввести перезаписываемый `registry`,
      переписать `buildToolDefs`/`getTool` на работу с ним, добавить `initTools`.
- [ ] Добавить `import` и `await initTools()` в начало `handleMessage` в `src/agent.js`.
- [ ] Добавить `.mcp.json` в `.gitignore`, создать шаблон `.mcp.json.example` и локальный `.mcp.json`.
- [ ] Прогнать `npm test` и ручные проверки из раздела выше.

## Риски и ограничения

- **Зависимость от внешнего процесса.** Доступность инструментов Yafly теперь зависит от запущенного
  `mcp-yafly`. Изоляция сбоя при старте реализована; на случай падения в середине работы реализовано
  переподключение по ошибке вызова.
- **Ленивая инициализация при первом сообщении.** Первое сообщение пользователя оплачивает время
  подключения к серверам MCP. Для локального сервера это незаметно; при медленных удалённых серверах можно
  позже перенести `initTools()` в явный прогрев на старте процесса, не меняя остального кода.
- **Совместимость с тестами.** Тесты в `tests/run.js` обращаются к `toolMeta` напрямую; план это учитывает
  (живая привязка модуля). При добавлении новых тестов на реестр учитывать, что инструменты MCP появляются
  только после `initTools()`.
- **API SDK может меняться.** Имена `Client`, `StreamableHTTPClientTransport`, `listTools`, `callTool` и
  форма опции тайм-аута сверены с текущей документацией, но перед сборкой их нужно подтвердить на фактически
  установленной версии пакета.
