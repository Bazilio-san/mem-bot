// src/mcp/client.js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadMcpServers } from './config.js';
import { debugEnabled } from '../config.js';

const CALL_TIMEOUT_MS = 90_000; // предел ожидания ответа инструмента MCP; зависший сервер не блокирует агента

// Трассировка вызовов инструментов MCP: запросы и ответы. Включается категорией DEBUG=mcp:tool (или DEBUG=*).
// Идёт в stderr, чтобы не смешиваться с пользовательским выводом, и по умолчанию выключена.
function dbgTool(...args) {
  if (debugEnabled('mcp:tool')) console.error('[mcp:tool]', ...args);
}

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
  // Каждый запрос и ответ трассируется под категорией DEBUG=mcp:tool.
  async call(name, args) {
    const label = `${this.server.alias}__${name}`;
    dbgTool(`-> ${label} запрос:`, JSON.stringify(args || {}));
    try {
      const res = await this.invokeOnce(name, args);
      dbgTool(`<- ${label} ответ`, res?.isError ? '(isError)' : '(ok)', ':', JSON.stringify(res?.content ?? res));
      return res;
    } catch (err) {
      if (!isConnectionError(err)) {
        dbgTool(`xx ${label} ошибка:`, String(err?.message || err));
        throw err;
      }
      dbgTool(`-- ${label} разрыв связи, переподключаюсь и повторяю:`, String(err?.message || err));
      await this.reset();
      const res = await this.invokeOnce(name, args);
      dbgTool(`<- ${label} ответ после переподключения`, res?.isError ? '(isError)' : '(ok)', ':',
        JSON.stringify(res?.content ?? res));
      return res;
    }
  }

  // Один сетевой вызов инструмента без логики повтора — общая часть для первой попытки и повтора.
  // Тайм-аут идёт ТРЕТЬИМ аргументом callTool(params, resultSchema, options): второй аргумент — это схема
  // разбора ответа, и опции вызова туда класть нельзя, иначе SDK примет их за схему и валидация упадёт.
  async invokeOnce(name, args) {
    const client = await this.ensureConnected();
    return client.callTool({ name, arguments: args || {} }, undefined, { timeout: CALL_TIMEOUT_MS });
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
