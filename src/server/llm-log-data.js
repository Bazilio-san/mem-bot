// Data layer of the admin LLM log viewer. Reads from two databases: dialog messages come from the working
// memory DB (query), journals come from the separate logs DB (queryLog) — a cross-database JOIN is
// impossible, so merging happens here in JS. The central piece is buildCycleRows(): a pure function that
// turns the journal records and agent events of one dialog turn into a flat list of display rows for the
// viewer (groups, indents, request/response pairs, tool calls). It is covered by a unit test
// (tests/llm-log-cycle.test.mjs).
import { query, queryLog } from '../db.js';
import { REQUEST_KIND_DISPLAY } from '../pipeline/llm-log.js';
import { EVENT_DISPLAY } from '../pipeline/agent-event-log.js';

// Human titles of request kinds (request_kind) for row headers and service badges.
const KIND_TITLES = {
  main_agent_answer: 'Основной ответ',
  delivery_intent: 'Классификация доставки',
  intent_classify: 'Классификация интента',
  fact_extract: 'Выгрузка фактов в память',
  answer_summary: 'Саммари ответа',
  topic_extract: 'Темы разговора',
  event_relevance: 'Оценка релевантности события',
  proactive_message: 'Проактивное сообщение',
  history_compress: 'Сжатие истории',
  skill_authoring: 'Создание навыка',
  voice_summary: 'Резюме для голоса',
  image_prompt_translate: 'Перевод промпта картинки',
  embedding: 'Запрос эмбеддинга',
  stt: 'Распознавание речи',
  tts: 'Синтез речи',
  log_analysis: 'AI-анализ лога',
  untyped: 'Запрос без типа',
};

// Kinds that run after the user already got the answer; the viewer shows them under a separate
// "post-processing" stage header.
const POST_KINDS = new Set(['fact_extract', 'answer_summary', 'topic_extract']);

export function kindTitle(kind) {
  return KIND_TITLES[kind] || kind || 'Запрос';
}

// ---------------------------------------------------------------------------
// User search with suggestions: by display name, external (Telegram) id, or exact internal UUID.
export async function searchUsers(q) {
  const needle = String(q || '').trim();
  if (!needle) {
    return [];
  }
  const { rows } = await query(
    `SELECT u.id, u.external_id, u.display_name, u.is_test,
            (SELECT MAX(m.created_at) FROM mem.conversation_messages m WHERE m.user_id = u.id) AS last_message_at
       FROM mem.users u
      WHERE u.display_name ILIKE '%' || $1 || '%'
         OR u.external_id ILIKE '%' || $1 || '%'
         OR u.id::text = $1
      ORDER BY last_message_at DESC NULLS LAST
      LIMIT 10`,
    [needle],
  );
  return rows.map((r) => ({
    id: r.id,
    externalId: r.external_id,
    displayName: r.display_name,
    isTest: r.is_test,
    lastMessageAt: r.last_message_at,
  }));
}

// The user row by internal id — the admin chat needs external_id to run the agent pipeline.
export async function getUserById(userId) {
  const { rows } = await query(`SELECT id, external_id, display_name FROM mem.users WHERE id = $1`, [String(userId)]);
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Chat timeline of one user: dialog messages (memory DB) merged with service LLM call groups (logs DB).
// Keyset pagination by time: `before` (ISO) returns items strictly older; the page is `limit` messages.
// A "service" group is a set of journal records sharing a request_id that is NOT referenced by any user
// message — post-processors and background calls (history compression, proactivity, detached embeddings).
export async function getTimeline({ userId, before = null, limit = 50 }) {
  const pageSize = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const beforeTs = before || new Date(Date.now() + 60 * 1000).toISOString();

  // Page of messages, newest first, then reversed to chronological order.
  const { rows: messageRows } = await query(
    `SELECT id, role, content, tool_name, created_at, metadata
       FROM mem.conversation_messages
      WHERE user_id = $1 AND role IN ('user', 'assistant') AND created_at < $2
      ORDER BY created_at DESC
      LIMIT ${pageSize + 1}`,
    [String(userId), beforeTs],
  );
  const hasMore = messageRows.length > pageSize;
  const pageMessages = messageRows.slice(0, pageSize).reverse();

  // Service-call window: from the oldest message of the page (or unbounded when the history start is
  // reached) up to `before`. Journal calls of a cycle happen within seconds of its messages, so the window
  // approximation is accurate enough for the timeline.
  const windowStart = hasMore && pageMessages.length ? pageMessages[0].created_at : null;
  const logParams = [String(userId), beforeTs];
  let windowClause = '';
  if (windowStart) {
    logParams.push(windowStart);
    windowClause = 'AND created_at >= $3';
  }
  const { rows: logRows } = await queryLog(
    `SELECT llm_request_id, request_id, request_kind, created_at, total_tokens, price_usd, status
       FROM log.llm_request
      WHERE user_id = $1 AND created_at < $2 ${windowClause}
      ORDER BY llm_request_id`,
    logParams,
  );

  // Group journal records by request_id; records without one form single-record groups.
  const groups = new Map();
  for (const r of logRows) {
    const key = r.request_id || `single:${r.llm_request_id}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        requestId: r.request_id,
        llmRequestIds: [],
        kinds: [],
        createdAt: r.created_at,
        tokens: 0,
        priceUsd: 0,
        hasError: false,
      };
      groups.set(key, g);
    }
    g.llmRequestIds.push(r.llm_request_id);
    if (!g.kinds.includes(r.request_kind)) {
      g.kinds.push(r.request_kind);
    }
    g.tokens += Number(r.total_tokens) || 0;
    g.priceUsd += Number(r.price_usd) || 0;
    g.hasError = g.hasError || r.status === 'error';
  }

  // Exclude groups whose request_id belongs to a dialog cycle (referenced by a user message) — those logs
  // open through the message's log button, not through a badge.
  const groupIds = [...groups.values()].map((g) => g.requestId).filter(Boolean);
  let cycleIds = new Set();
  if (groupIds.length) {
    const { rows } = await query(
      `SELECT DISTINCT metadata->>'request_id' AS request_id
         FROM mem.conversation_messages
        WHERE user_id = $1 AND metadata->>'request_id' = ANY($2)`,
      [String(userId), groupIds],
    );
    cycleIds = new Set(rows.map((r) => r.request_id));
  }

  const items = [];
  for (const m of pageMessages) {
    items.push({
      type: 'message',
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.created_at,
      requestId: m.metadata?.request_id || null,
      eventType: m.metadata?.event_type || null,
      hasLog: Boolean(m.metadata?.request_id),
      // Widget descriptors (MCP Apps) of this turn: the chat pane renders them inline under the bubble.
      widgets: Array.isArray(m.metadata?.widgets) && m.metadata.widgets.length ? m.metadata.widgets : null,
    });
  }
  // The most representative kind of a group for the badge label: the first non-embedding kind.
  for (const g of groups.values()) {
    if (g.requestId && cycleIds.has(g.requestId)) {
      continue;
    }
    const mainKind = g.kinds.find((k) => k !== 'embedding') || g.kinds[0] || null;
    items.push({
      type: 'service',
      requestId: g.requestId,
      llmRequestIds: g.llmRequestIds,
      kind: mainKind,
      title: kindTitle(mainKind),
      createdAt: g.createdAt,
      totalTokens: g.tokens,
      priceUsd: g.priceUsd,
      hasError: g.hasError,
    });
  }
  items.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return { items, hasMore };
}

// ---------------------------------------------------------------------------
// Journal of one dialog cycle by request_id: header with totals + display rows.
export async function getCycle(requestId) {
  const [{ rows: records }, { rows: events }] = await Promise.all([
    queryLog(`SELECT * FROM log.llm_request WHERE request_id = $1 ORDER BY llm_request_id`, [String(requestId)]),
    queryLog(`SELECT * FROM log.agent_event WHERE request_id = $1 ORDER BY agent_event_id`, [String(requestId)]),
  ]);
  if (records.length === 0 && events.length === 0) {
    return null;
  }
  // The user message of the cycle lives in the memory DB — prepended as the first row of the timeline.
  const { rows: userMsgs } = await query(
    `SELECT content, created_at FROM mem.conversation_messages
      WHERE metadata->>'request_id' = $1 AND role = 'user'
      ORDER BY created_at LIMIT 1`,
    [String(requestId)],
  );
  const rows = buildCycleRows(records, events, { userMessage: userMsgs[0] || null });
  return { requestId, header: buildHeader(records, rows), rows };
}

// Journal of a single service record (a badge without request_id) — same row shape as a cycle.
export async function getSingleRequest(llmRequestId) {
  const { rows: records } = await queryLog(`SELECT * FROM log.llm_request WHERE llm_request_id = $1`, [
    Number(llmRequestId),
  ]);
  if (records.length === 0) {
    return null;
  }
  const rows = buildCycleRows(records, [], {});
  return { requestId: records[0].request_id, header: buildHeader(records, rows), rows };
}

// Header of the viewer: totals over the cycle's records and the time span over all rows.
function buildHeader(records, rows) {
  const models = [...new Set(records.map((r) => r.model).filter(Boolean))];
  const tokens = records.reduce((s, r) => s + (Number(r.total_tokens) || 0), 0);
  const priceUsd = records.reduce((s, r) => s + (Number(r.price_usd) || 0), 0);
  const times = rows.map((r) => new Date(r.createdAt).getTime()).filter(Number.isFinite);
  const startedAt = times.length ? new Date(Math.min(...times)).toISOString() : null;
  const durationMs = times.length ? Math.max(...times) - Math.min(...times) : null;
  return { tokens, priceUsd, models, startedAt, durationMs, hasError: records.some((r) => r.status === 'error') };
}

// ---------------------------------------------------------------------------
// Pure assembly of display rows from journal records and agent events. Exported for unit tests.
//
// Row model: { n, rowType, kind, title, indent, groupId, isGroupHeader, createdAt, model, tokens, priceUsd,
// durationMs, status, error, body }. body is one of:
//   { kind: 'text', text }                — plain text (user message; rendered like 'content' but always RAW)
//   { kind: 'payload', payload }          — LLM request body (progressive disclosure on the frontend)
//   { kind: 'content', content, displayFormat } — response/tool content; displayFormat comes from the
//     server-side type dictionaries (REQUEST_KIND_DISPLAY / EVENT_DISPLAY); null = frontend auto-detection
//
// Ordering: every row gets a real timestamp. A journal record is written AFTER the call completes, so the
// request row's display time is created_at minus duration_ms (the call start) and the response row's time is
// created_at. Events are journaled at their actual moment. Stage events become collapsible group headers.
export function buildCycleRows(records, events, { userMessage = null } = {}) {
  const rows = [];

  if (userMessage) {
    rows.push({
      rowType: 'user_say',
      kind: 'user_say',
      title: 'Сообщение пользователя',
      indent: 0,
      createdAt: toIso(userMessage.created_at),
      body: { kind: 'text', text: userMessage.content },
    });
  }

  let groupSeq = 0;
  let currentGroup = null;

  for (const e of events) {
    const base = {
      createdAt: toIso(e.created_at),
      durationMs: e.duration_ms ?? null,
      status: e.status || 'ok',
      error: e.error || null,
    };
    switch (e.event_type) {
      case 'agent.started':
        rows.push({
          ...base,
          rowType: 'agent_start',
          kind: 'agent_start',
          title: e.title || 'Ход агента начат',
          indent: 0,
          body: contentBody(e.data),
        });
        break;
      case 'stage.started': {
        currentGroup = `g${++groupSeq}`;
        rows.push({
          ...base,
          rowType: 'stage',
          kind: 'stage',
          title: e.title || 'Стадия',
          indent: 0,
          groupId: currentGroup,
          isGroupHeader: true,
          body: null,
        });
        break;
      }
      case 'tool.started':
        rows.push({
          ...base,
          rowType: 'tool_call',
          kind: 'tool_call',
          title: e.title || 'Вызов инструмента',
          indent: 2,
          groupId: currentGroup,
          body: contentBody(e.data, EVENT_DISPLAY[e.event_type]),
        });
        break;
      case 'tool.completed':
        rows.push({
          ...base,
          rowType: 'tool_result',
          kind: 'tool_result',
          title: e.title || 'Результат инструмента',
          indent: 2,
          groupId: currentGroup,
          body: contentBody(e.data, EVENT_DISPLAY[e.event_type]),
        });
        break;
      case 'mcp.connected':
      case 'mcp.failed':
        rows.push({
          ...base,
          rowType: 'mcp',
          kind: 'mcp',
          title: e.title || 'MCP-сервер',
          indent: 1,
          groupId: currentGroup,
          body: contentBody(e.data, EVENT_DISPLAY[e.event_type]),
        });
        break;
      case 'memory.retrieved':
        // Итог поиска памяти (сущности классификатора, статистика сущностного буста) — внутри
        // группы текущей стадии, сразу под заголовком «Стадия: поиск релевантной памяти».
        rows.push({
          ...base,
          rowType: 'memory',
          kind: 'memory',
          title: e.title || 'Память найдена',
          indent: 1,
          groupId: currentGroup,
          body: contentBody(e.data, EVENT_DISPLAY[e.event_type]),
        });
        break;
      case 'memory.written':
      case 'memory.sweep':
        // Без groupId: итог записи памяти идёт после ответа и попадает в группу «Пост-обработка»
        // (или наследует активную группу, когда пост-обработки в цикле нет).
        rows.push({
          ...base,
          rowType: 'memory',
          kind: 'memory',
          title:
            e.title || (e.event_type === 'memory.written' ? 'Факты записаны в память' : 'Чистка дубликатов памяти'),
          indent: 1,
          body: contentBody(e.data, EVENT_DISPLAY[e.event_type]),
        });
        break;
      case 'assistant.completed':
        rows.push({
          ...base,
          rowType: 'answer_user',
          kind: 'answer_user',
          title: e.title || 'Ответ пользователю',
          indent: 0,
          body: answerBody(e.data),
        });
        break;
      case 'agent.completed':
        rows.push({
          ...base,
          rowType: 'agent_end',
          kind: 'agent_end',
          title: e.title || 'Ход агента завершён',
          indent: 0,
          body: contentBody(e.data),
        });
        break;
      case 'agent.failed':
        rows.push({
          ...base,
          rowType: 'agent_error',
          kind: 'agent_error',
          title: e.title || 'Ошибка хода агента',
          indent: 0,
          status: 'error',
          body: contentBody(e.data),
        });
        break;
      default:
        rows.push({
          ...base,
          rowType: 'event',
          kind: 'event',
          title: e.title || e.event_type,
          indent: 0,
          groupId: currentGroup,
          body: contentBody(e.data),
        });
    }
  }

  // Journal records → a request/response row pair (or a single combined row for one-purpose endpoints).
  let llmIteration = 0;
  for (const r of records) {
    const endMs = new Date(r.created_at).getTime();
    const startMs = endMs - (Number(r.duration_ms) || 0);
    const isChat = r.endpoint === 'chat.completions';
    const kind = r.request_kind || 'untyped';
    const tokens = r.total_tokens != null ? Number(r.total_tokens) : null;
    const priceUsd = r.price_usd != null ? Number(r.price_usd) : null;

    // Iterations are counted only over the main-answer calls: the tool loop of one turn can hit the model
    // several times, and the viewer labels them "итерация N".
    if (isChat && kind === 'main_agent_answer') {
      llmIteration += 1;
    }
    const baseTitle = kindTitle(kind);
    rows.push({
      rowType: 'llm_request',
      kind,
      title: isChat && kind === 'main_agent_answer' ? `Запрос → LLM (итерация ${llmIteration})` : `${baseTitle} → LLM`,
      indent: 1,
      createdAt: new Date(startMs).toISOString(),
      model: r.model,
      tokens,
      priceUsd,
      durationMs: r.duration_ms != null ? Number(r.duration_ms) : null,
      status: r.status,
      error: r.status === 'error' ? r.error : null,
      llmRequestId: r.llm_request_id,
      payloadTruncated: r.payload_truncated === true,
      body: { kind: 'payload', payload: r.payload, binaryMeta: r.binary_meta || null },
    });
    if (r.status !== 'error' || r.response != null) {
      rows.push({
        rowType: 'llm_response',
        kind: 'llm_response',
        title: 'Ответ ← LLM',
        indent: 1,
        createdAt: new Date(endMs).toISOString(),
        status: r.status,
        error: r.status === 'error' ? r.error : null,
        llmRequestId: r.llm_request_id,
        responseTruncated: r.response_truncated === true,
        body: {
          kind: 'content',
          content: serializeResponse(r.response),
          displayFormat: REQUEST_KIND_DISPLAY[kind] ?? null,
        },
      });
    }
  }

  rows.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  // Synthetic "post-processing" group: kinds that run after the answer (fact/topic extraction) get their own
  // collapsible header, mirroring how the live stages are grouped.
  const firstPostIdx = rows.findIndex((r) => POST_KINDS.has(r.kind) && r.rowType === 'llm_request');
  if (firstPostIdx >= 0) {
    const postGroup = `g${++groupSeq}`;
    rows.splice(firstPostIdx, 0, {
      rowType: 'stage',
      kind: 'stage',
      title: 'Пост-обработка (после ответа)',
      indent: 0,
      groupId: postGroup,
      isGroupHeader: true,
      createdAt: rows[firstPostIdx].createdAt,
      body: null,
    });
    for (let i = firstPostIdx + 1; i < rows.length; i++) {
      if (
        POST_KINDS.has(rows[i].kind) ||
        rows[i].rowType === 'llm_response' ||
        rows[i].kind === 'embedding' ||
        rows[i].kind === 'memory'
      ) {
        rows[i].groupId = postGroup;
      }
    }
  }

  // Rows between a stage header and the next header inherit the group for collapse/expand. Rows that already
  // carry a group keep it; numbering is assigned at the very end.
  let activeGroup = null;
  for (const row of rows) {
    if (row.isGroupHeader) {
      activeGroup = row.groupId;
    } else if (row.groupId === undefined || row.groupId === null) {
      row.groupId = row.rowType === 'user_say' || row.rowType === 'answer_user' ? null : activeGroup;
    }
  }

  // Суммарная длительность шага для заголовков групп: охват по строкам группы — от самого раннего
  // старта до самого позднего конца (createdAt + durationMs). Заголовок с собственной длительностью
  // (если журнал её записал) не перезаписывается.
  const groupSpans = new Map();
  for (const row of rows) {
    if (row.isGroupHeader || !row.groupId) {
      continue;
    }
    const start = new Date(row.createdAt).getTime();
    if (!Number.isFinite(start)) {
      continue;
    }
    const end = start + (Number(row.durationMs) || 0);
    const span = groupSpans.get(row.groupId) || { min: Infinity, max: -Infinity };
    span.min = Math.min(span.min, start);
    span.max = Math.max(span.max, end);
    groupSpans.set(row.groupId, span);
  }
  for (const row of rows) {
    if (row.isGroupHeader && row.durationMs == null) {
      const span = groupSpans.get(row.groupId);
      if (span && span.max > span.min) {
        row.durationMs = span.max - span.min;
      }
    }
  }

  rows.forEach((row, i) => {
    row.n = i + 1;
  });
  return rows;
}

// --- small helpers ----------------------------------------------------------

function toIso(v) {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

// Event data → a content body; empty data → no body. displayFormat comes from EVENT_DISPLAY
// (null = frontend auto-detection).
function contentBody(data, displayFormat = null) {
  if (data == null) {
    return null;
  }
  return {
    kind: 'content',
    content: typeof data === 'string' ? data : JSON.stringify(data),
    displayFormat: displayFormat ?? null,
  };
}

// assistant.completed carries { text } — show the answer text itself, not a JSON wrapper.
// The reply is in the channel's format (HTML / MD / plain) — auto-detection on the frontend.
function answerBody(data) {
  if (data && typeof data === 'object' && typeof data.text === 'string') {
    return { kind: 'content', content: data.text, displayFormat: null };
  }
  return contentBody(data);
}

// The stored response of a chat record → display content: the message itself when present, otherwise the
// whole response object as JSON.
function serializeResponse(response) {
  if (response == null) {
    return '';
  }
  if (typeof response === 'string') {
    return response;
  }
  const msg = response.message;
  if (msg && typeof msg.content === 'string' && msg.content && !msg.tool_calls?.length) {
    return msg.content;
  }
  return JSON.stringify(response);
}
