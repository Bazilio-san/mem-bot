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

// Имена базовых (системных) инструментов: память, планировщик, глобальная память, форма ответа, чтение
// справочников. Они доступны всегда, если разрешены флагами и правами. Предметные инструменты (например,
// инструменты MCP вроде search_flights) в реестр добавляются динамически и базовыми не считаются.
const BASE_TOOL_NAMES = new Set(allTools.map((tool) => tool.name));

export function toolTitle(name) {
  return toolMeta[name]?.title || name;
}

// Разрешён ли инструмент при активном skill. Базовые (системные) инструменты доступны всегда. Предметный
// инструмент доступен только если он перечислен в tools.allowed активного skill. Если активного skill в
// контексте нет (служебные вызовы вне ответа агенту), ограничение не применяется.
//
// Инструменты внешних MCP-серверов регистрируются под префиксным именем «<псевдоним>__<имя>» (например,
// «yafly__search_flights»), тогда как skill перечисляет их под логическим именем без префикса
// («search_flights») — префикс существует только на стороне модели. Поэтому, кроме полного имени инструмента,
// для инструментов MCP сверяем и «голое» имя (tool.mcpName): иначе разрешение в skill никогда не совпадёт с
// префиксным именем и инструмент будет невидим для модели.
function allowedForActiveSkill(tool, ctx) {
  if (BASE_TOOL_NAMES.has(tool.name)) {
    return true;
  }
  const skill = ctx.activeSkill;
  if (!skill) {
    return true;
  }
  const allowed = skill.tools?.allowed || [];
  if (allowed.includes(tool.name)) {
    return true;
  }
  if (tool.mcpName && allowed.includes(tool.mcpName)) {
    return true;
  }
  return false;
}

export function buildToolDefs(ctx = {}) {
  return registry
    .filter((tool) => (tool.isEnabled ? tool.isEnabled(ctx, config) : true))
    .filter((tool) => allowedForActiveSkill(tool, ctx))
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
      if (mcp.length === 0) {
        return;
      } // нечего добавлять — реестр остаётся прежним
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
