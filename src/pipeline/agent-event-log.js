// Agent event journal: stages of a dialog turn, tool calls with arguments and results, MCP connections.
// Together with log.llm_request it gives the admin log viewer an exhaustive timeline of one cycle
// "user phrase → answer". This is intentionally a SEPARATE write point from the emit() events of
// src/agent.js: emit() works only when a delivery adapter is attached and deliberately omits tool
// arguments (they may carry private data into the chat channel), while the journal must always be written
// and needs full arguments and results — the admin panel is local-only. Correlation identifiers
// (request_id, user_id, conversation_id) are taken from the same AsyncLocalStorage context as the LLM log.
// Writing is buffered and batched via the shared machinery in log-writer.js and never breaks the main flow.
import { config } from '../config.js';
import { getLlmContext } from './llm-context.js';
import { createBatchWriter, truncateJson } from './log-writer.js';

// Event type taxonomy (extensible; the viewer maps unknown types to a neutral row).
export const AGENT_EVENTS = Object.freeze({
  AGENT_STARTED: 'agent.started',
  STAGE_STARTED: 'stage.started',
  TOOL_STARTED: 'tool.started',
  TOOL_COMPLETED: 'tool.completed',
  MCP_CONNECTED: 'mcp.connected',
  MCP_FAILED: 'mcp.failed',
  ASSISTANT_COMPLETED: 'assistant.completed',
  AGENT_COMPLETED: 'agent.completed',
  AGENT_FAILED: 'agent.failed',
  // Summary of the memory retrieval stage: entities extracted by the classifier, entity boost stats
  // and the sizes of the retrieveMemory result groups. A separate event because the stage.started row
  // is displayed in the viewer without a body (body: null), so any data in it would not be visible.
  MEMORY_RETRIEVED: 'memory.retrieved',
  // Summary of writing facts to long-term memory (the main-turn writeJob and the reactions path).
  MEMORY_WRITTEN: 'memory.written',
  // Summary of the background memory duplicate sweep (dedupeFactsSweep): scheduler task and manual script.
  MEMORY_SWEEP: 'memory.sweep',
});

// Default display format of the event data body in the admin log viewer. The format is a property of the
// event type and lives next to the type dictionary (single source of truth on the server).
// 'JSON' | 'RAW' | 'MD' | 'HTML' | null; null = frontend auto-detection. Types absent here either have no
// body at all (agent.*, stage.started — plain text rows) or carry variable content.
export const EVENT_DISPLAY = Object.freeze({
  'tool.started': 'JSON',
  'tool.completed': 'JSON',
  'memory.retrieved': 'JSON',
  'memory.written': 'JSON',
  'memory.sweep': 'JSON',
  'mcp.connected': 'JSON',
  'mcp.failed': 'JSON',
  // Reply text in the channel format (HTML/MD/plain) — auto-detection.
  'assistant.completed': null,
});

// Columns of log.agent_event in insertion order. data is jsonb.
// created_at is set explicitly at record-build time (not by the DB default) — see the note in llm-log.js:
// batched inserts would otherwise collapse the timestamps of a whole batch into one value.
export const EVENT_COLUMNS = [
  'created_at',
  'request_id',
  'user_id',
  'conversation_id',
  'event_type',
  'title',
  'data',
  'duration_ms',
  'status',
  'error',
  'is_test',
];

// The journal shares the llmLog settings (enabled flag, batch sizes, payload limit): both journals are two
// faces of the same logging subsystem and are switched on and off together.
function settings() {
  const c = config.llmLog || {};
  return {
    enabled: c.enabled !== false,
    batchSize: Number(c.batchSize) > 0 ? Number(c.batchSize) : 200,
    flushIntervalMs: Number(c.flushIntervalMs) > 0 ? Number(c.flushIntervalMs) : 1000,
    maxPayloadChars: Number(c.maxPayloadChars) > 0 ? Number(c.maxPayloadChars) : 100000,
  };
}

const writer = createBatchWriter({
  table: 'log.agent_event',
  columns: EVENT_COLUMNS,
  jsonbColumns: ['data'],
  getSettings: settings,
});

// Swap the database write function (tests only). Returns the previous implementation so it can be restored.
export function __setDbQueryForTests(fn) {
  return writer.setDbQueryForTests(fn);
}

// Build a single journal record. Correlation fields come from the AsyncLocalStorage context; outside a dialog
// turn (e.g. MCP connection at startup) they are NULL and the event is shown by the viewer as a service one.
// Never throws: on failure returns null.
export function buildEventRecord({ eventType, title, data, durationMs, status, error }) {
  try {
    if (!eventType) {
      return null;
    }
    const ctx = getLlmContext();
    const { json: dataJson } = truncateJson(data, settings().maxPayloadChars);
    return {
      created_at: new Date().toISOString(),
      request_id: ctx.requestId ?? null,
      user_id: ctx.userId != null ? String(ctx.userId) : null,
      conversation_id: ctx.conversationId != null ? String(ctx.conversationId) : null,
      event_type: String(eventType),
      title: title != null ? String(title).slice(0, 500) : null,
      data: dataJson,
      duration_ms: durationMs ?? null,
      status: status || 'ok',
      error: error ? String(error).slice(0, 4000) : null,
      is_test: process.env.NODE_ENV === 'test',
    };
  } catch {
    return null;
  }
}

// Put an event into the buffer. Returns control immediately and never throws.
export function logAgentEvent(input) {
  try {
    if (!settings().enabled || !input) {
      return;
    }
    writer.push(buildEventRecord(input));
  } catch {
    // Journaling must not affect the main flow.
  }
}

// Force-flush the accumulated events (graceful shutdown, tests).
export async function flushAgentEventLog() {
  await writer.flush();
}
