// Agent tool registry. Each tool lives in its own module under agent-tools/ and exports
// its OpenAI function definition, human title, access policy, and handler.
import { config } from '../config.js';
import { logToolCall } from '../repo.js';
import { allTools } from './agent-tools/index.js';
import { loadMcpTools } from '../mcp/client.js';

// Перезаписываемый реестр: стартует из локальных инструментов, дополняется инструментами MCP в initTools().
let registry = [...allTools];

export let tools = registry;
export let toolDefs = registry.map((tool) => tool.definition);
export let toolMeta = Object.fromEntries(registry.map((tool) => [tool.name, { title: tool.title }]));

let TOOLS_BY_NAME = new Map(registry.map((tool) => [tool.name, tool]));

export function toolTitle(name) {
  return toolMeta[name]?.title || name;
}

export function buildToolDefs(ctx = {}) {
  return registry
    .filter((tool) => (tool.isEnabled ? tool.isEnabled(ctx, config) : true))
    .map((tool) => tool.definition);
}

export function getTool(name) {
  return TOOLS_BY_NAME.get(name) || null;
}

let initPromise = null; // кэш промиса: инициализация выполняется ровно один раз на процесс

// Однократно подключает инструменты MCP и пересобирает реестр. Повторные вызовы возвращают тот же промис,
// поэтому безопасно вызывать из любой точки входа и при каждом сообщении.
export function initTools() {
  if (!initPromise) {
    initPromise = (async () => {
      const mcp = await loadMcpTools();
      if (mcp.length === 0) return;            // нечего добавлять — реестр остаётся прежним
      registry = [...registry, ...mcp];
      tools = registry;
      toolDefs = registry.map((t) => t.definition);
      toolMeta = Object.fromEntries(registry.map((t) => [t.name, { title: t.title }]));
      TOOLS_BY_NAME = new Map(registry.map((t) => [t.name, t]));
    })();
  }
  return initPromise;
}

// Execute a tool by name with uniform access checks, audit logging, and error handling.
export async function executeTool(ctx, name, args) {
  const started = Date.now();
  const tool = getTool(name);

  if (!tool) {
    return { error: `Неизвестный инструмент: ${name}` };
  }

  if (tool.requiresAdmin && !ctx.isAdmin) {
    await logToolCall({
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      toolName: name,
      input: args,
      status: 'blocked',
      latencyMs: Date.now() - started,
      error: 'Требуются права администратора',
    });
    return { error: 'Это действие доступно только администратору.' };
  }

  try {
    const output = await tool.handler(ctx, args);
    await logToolCall({
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      toolName: name,
      input: args,
      output,
      status: 'success',
      latencyMs: Date.now() - started,
    });
    return output;
  } catch (err) {
    await logToolCall({
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      toolName: name,
      input: args,
      status: 'failed',
      latencyMs: Date.now() - started,
      error: String(err.message || err),
    });
    return { error: String(err.message || err) };
  }
}
