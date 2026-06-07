// Agent tool registry. Each tool lives in its own module under agent-tools/ and exports
// its OpenAI function definition, human title, access policy, and handler.
import { config } from '../config.js';
import { logToolCall } from '../repo.js';
import { allTools } from './agent-tools/index.js';

export const tools = allTools;
export const toolDefs = allTools.map((tool) => tool.definition);
export const toolMeta = Object.fromEntries(allTools.map((tool) => [tool.name, { title: tool.title }]));

const TOOLS_BY_NAME = new Map(allTools.map((tool) => [tool.name, tool]));

export function toolTitle(name) {
  return toolMeta[name]?.title || name;
}

export function buildToolDefs(ctx = {}) {
  return allTools
    .filter((tool) => (tool.isEnabled ? tool.isEnabled(ctx, config) : true))
    .map((tool) => tool.definition);
}

export function getTool(name) {
  return TOOLS_BY_NAME.get(name) || null;
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
