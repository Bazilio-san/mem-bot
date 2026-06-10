// Agent tool registry. Each tool lives in its own module under agent-tools/ and exports
// its OpenAI function definition, human title, access policy, and handler.
import { config } from '../config.js';
import { logToolCall } from '../repo.js';
import { allTools } from './agent-tools/index.js';
import { loadMcpTools } from '../mcp/client.js';

// Rewritable registry: starts from local tools, augmented with MCP tools in initTools().
let registry = [...allTools];

export let tools = registry;
export let toolDefs = registry.map((tool) => tool.definition);
export let toolMeta = Object.fromEntries(registry.map((tool) => [tool.name, { title: tool.title }]));

let TOOLS_BY_NAME = new Map(registry.map((tool) => [tool.name, tool]));

// Names of the base (system) tools: memory, scheduler, global memory, response shaping, reading
// reference data. They are always available if allowed by flags and permissions. Domain tools (for example,
// MCP tools like search_flights) are added to the registry dynamically and are not considered base tools.
const BASE_TOOL_NAMES = new Set(allTools.map((tool) => tool.name));

export function toolTitle(name) {
  return toolMeta[name]?.title || name;
}

// Whether a tool is allowed under the active skill. Base (system) tools are always available. A domain
// tool is available only if it is listed in tools.allowed of the active skill. If there is no active skill in
// the context (service calls outside of replying to the agent), the restriction does not apply.
//
// Tools of external MCP servers are registered under a prefixed name "<alias>__<name>" (for example,
// "yafly__search_flights"), whereas a skill lists them under a logical name without the prefix
// ("search_flights") — the prefix exists only on the model's side. Therefore, besides the full tool name,
// for MCP tools we also check the "bare" name (tool.mcpName): otherwise the permission in the skill would never match
// the prefixed name and the tool would be invisible to the model.
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

let initPromise = null; // promise cache: initialization runs exactly once per process

// Connects MCP tools once and rebuilds the registry. Repeated calls return the same promise,
// so it is safe to call from any entry point and on every message.
export function initTools() {
  if (!initPromise) {
    initPromise = (async () => {
      const mcp = await loadMcpTools();
      if (mcp.length === 0) {
        return;
      } // nothing to add — the registry stays the same
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
      error: 'Administrator rights required',
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
