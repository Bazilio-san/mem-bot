// src/mcp/client.js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadMcpServers } from './config.js';
import { debugEnabled } from '../config.js';

const CALL_TIMEOUT_MS = 90_000; // wait limit for an MCP tool response; a hung server doesn't block the agent

// Tracing of MCP tool calls: requests and responses. Enabled by the DEBUG=mcp:tool category (or DEBUG=*).
// Goes to stderr so it doesn't mix with user output, and is off by default.
function dbgTool(...args) {
  if (debugEnabled('mcp:tool')) {
    console.error('[mcp:tool]', ...args);
  }
}

// A single live connection to a server. We keep the client to reuse the connection across calls and to be
// able to reconnect on a drop without rebuilding the tool registry.
class McpConnection {
  constructor(server) {
    this.server = server;
    this.client = null;
  }

  // Establish the connection if there isn't one yet. A repeat call with a live client is a no-op.
  async ensureConnected() {
    if (this.client) {
      return this.client;
    }
    const client = new Client({ name: 'mem-bot', version: '1.0.0' });
    // Forward transport headers only if they are set in the configuration — this is the place for a future token.
    const options = this.server.headers ? { requestInit: { headers: this.server.headers } } : undefined;
    const transport = new StreamableHTTPClientTransport(new URL(this.server.url), options);
    await client.connect(transport);
    this.client = client;
    return client;
  }

  // Forcibly reset the client — the next ensureConnected() will create a new connection.
  async reset() {
    const old = this.client;
    this.client = null;
    if (old) {
      try {
        await old.close();
      } catch {
        /* the server may have already dropped the connection — this is not an error */
      }
    }
  }

  // Get the full list of server tools, accounting for paginated output (cursor).
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

  // Call a tool. On an error that looks like a dropped connection, reconnect once and retry.
  // Every request and response is traced under the DEBUG=mcp:tool category.
  async call(name, args) {
    const label = `${this.server.alias}__${name}`;
    dbgTool(`-> ${label} request:`, JSON.stringify(args || {}));
    try {
      const res = await this.invokeOnce(name, args);
      dbgTool(`<- ${label} response`, res?.isError ? '(isError)' : '(ok)', ':', JSON.stringify(res?.content ?? res));
      return res;
    } catch (err) {
      if (!isConnectionError(err)) {
        dbgTool(`xx ${label} error:`, String(err?.message || err));
        throw err;
      }
      dbgTool(`-- ${label} connection dropped, reconnecting and retrying:`, String(err?.message || err));
      await this.reset();
      const res = await this.invokeOnce(name, args);
      dbgTool(
        `<- ${label} response after reconnect`,
        res?.isError ? '(isError)' : '(ok)',
        ':',
        JSON.stringify(res?.content ?? res),
      );
      return res;
    }
  }

  // A single network tool call without retry logic — the shared part for the first attempt and the retry.
  // The timeout is the THIRD argument of callTool(params, resultSchema, options): the second argument is the
  // response-parsing schema, and call options must not go there, otherwise the SDK treats them as a schema
  // and validation fails.
  async invokeOnce(name, args) {
    const client = await this.ensureConnected();
    return client.callTool({ name, arguments: args || {} }, undefined, { timeout: CALL_TIMEOUT_MS });
  }
}

// A rough but sufficient heuristic for "this is a dropped connection, worth reconnecting".
// A call timeout intentionally does not fall here: retrying a known-slow call makes no sense.
function isConnectionError(err) {
  const msg = String(err?.message || err).toLowerCase();
  return (
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('socket') ||
    msg.includes('network') ||
    msg.includes('closed') ||
    msg.includes('disconnect')
  );
}

// We join the text blocks of an MCP response into one string — the model needs text, not transport structure.
function describeContent(content) {
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

// Turn a single MCP tool description into an object in the local tool registry format.
function wrapMcpTool(connection, server, mcpTool) {
  const prefixedName = `${server.alias}__${mcpTool.name}`;
  const requiresAdmin = server.requiresAdmin === true;
  return {
    name: prefixedName,
    // The "bare" tool name on the server (without the alias prefix) and the alias itself. Needed by the
    // visibility filter for the active skill: a skill lists tools under a logical name without a prefix, so
    // the matching must be able to reduce "yafly__search_flights" to "search_flights".
    mcpName: mcpTool.name,
    mcpAlias: server.alias,
    title: `Вызываю инструмент ${server.title}: ${mcpTool.name}...`,
    requiresAdmin,
    // If the tool is admin-only, we also hide it from the capability help for everyone else, mirroring the
    // behavior of local admin tools (see global-fact-*). Otherwise the tool is always visible.
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
      // The name on the server has no prefix; the prefix exists only on the model side.
      const res = await connection.call(mcpTool.name, args);
      if (res.isError) {
        return { error: `Ошибка инструмента ${prefixedName}: ${describeContent(res.content)}` };
      }
      return { content: res.content };
    },
  };
}

// Log the list of MCP servers declared in the configuration (.mcp.json), including disabled ones.
// At startup this gives a full picture of "what is declared for connection at all" before any connection attempts.
function logDeclaredServers(servers) {
  if (servers.length === 0) {
    console.log(
      'MCP: no servers are declared in the configuration (.mcp.json) — no external tools are connected.',
    );
    return;
  }
  console.log(`MCP: servers declared in the configuration — ${servers.length}. Full list:`);
  for (const s of servers) {
    const state = s.enabled ? 'enabled' : 'disabled';
    const admin = s.requiresAdmin ? ', admin-only' : '';
    console.log(`  • "${s.title}" [alias ${s.alias}] — ${state}, HTTP transport, address ${s.url}${admin}.`);
  }
}

// Connect to all enabled servers and return tool wrappers ready for registration.
// Before connecting, the full declared server list is logged, and then for each enabled server the
// connection result is logged: success (with time and tool count) or the failure reason.
// An unreachable server is logged and skipped: the agent keeps working on the remaining tools.
export async function loadMcpTools() {
  const servers = loadMcpServers();
  logDeclaredServers(servers);

  const collected = [];
  let connectedCount = 0;
  let failedCount = 0;
  for (const server of servers) {
    if (!server.enabled) {
      console.log(`MCP "${server.title}": skipped because it is disabled in the configuration.`);
      continue;
    }
    const connection = new McpConnection(server);
    const startedAt = Date.now();
    try {
      const tools = await connection.listAllTools();
      for (const mcpTool of tools) {
        collected.push(wrapMcpTool(connection, server, mcpTool));
      }
      connectedCount += 1;
      console.log(
        `MCP "${server.title}" (${server.url}): connected successfully in ${Date.now() - startedAt} ms, ` +
          `tools received — ${tools.length}.`,
      );
    } catch (err) {
      failedCount += 1;
      console.error(
        `MCP "${server.title}" (${server.url}): connection failed in ${Date.now() - startedAt} ms — ` +
          `${err.message}. Server skipped, the remaining tools stay available.`,
      );
    }
  }

  const enabledCount = servers.filter((s) => s.enabled).length;
  console.log(
    `MCP: connection summary — ${connectedCount} of ${enabledCount} enabled succeeded ` +
      `(${failedCount} failures), total tools received — ${collected.length}.`,
  );
  return collected;
}
