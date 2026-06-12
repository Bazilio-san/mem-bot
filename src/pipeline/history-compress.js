// Decides whether to compress the cold zone of history and invokes the summarizer.
// The cold zone is everything older than the hot window (the last N messages). If its size in tokens
// exceeds the threshold, it's rebuilt into a compact digest with a gradient: the part closer to the
// current moment is more detailed, the further part shorter. Facts already saved in long-term memory
// don't make it into the digest (dedup protection). Durable facts are pushed into long-term memory
// through the normal flow.
import { chatJSON } from '../llm.js';
import { config } from '../config.js';
import { debugSummarizer } from '../debug.js';
import {
  getRecentMessages,
  getActiveConversationSummary,
  getColdPendingMessages,
  saveConversationSummary,
} from '../repo.js';
import { saveFacts, FACT_ITEM_SCHEMA } from './facts.js';
import { estimateTokens, sumMessageTokens, estimateSummaryTokens } from './token-counter.js';

// Zone headers in the final digest. The order is fixed: near, middle, far.
const ZONE_HEADERS = {
  near: 'Ближняя часть разговора:',
  middle: 'Средняя часть разговора:',
  far: 'Дальняя часть разговора:',
};

// Summarizer response schema. Token sizes are deliberately left out of the schema — our code counts them.
// The schema is fully strict (no free-form objects anywhere), so prepareJsonSchema keeps strict: true and
// the provider guarantees the response structure at the decoder level. "No value" is expressed with null
// and empty arrays; notes is the strict replacement for arbitrary extra keys (important things that do not
// fit the seven state fields). Old conversation_summaries rows with arbitrary jsonb keys stay readable —
// the consumer just prints the object.
const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'summary_text',
    'state_json',
    'facts_to_memory',
    'dropped_because_in_memory',
    'sensitive_mentions_redacted',
  ],
  properties: {
    summary_text: { type: 'string' },
    state_json: {
      type: 'object',
      additionalProperties: false,
      required: [
        'current_goal',
        'current_task',
        'decisions',
        'rejected_options',
        'open_questions',
        'constraints',
        'next_steps',
        'notes',
      ],
      properties: {
        current_goal: { type: ['string', 'null'] },
        current_task: { type: ['string', 'null'] },
        decisions: { type: 'array', items: { type: 'string' } },
        rejected_options: { type: 'array', items: { type: 'string' } },
        open_questions: { type: 'array', items: { type: 'string' } },
        constraints: { type: 'array', items: { type: 'string' } },
        next_steps: { type: 'array', items: { type: 'string' } },
        notes: { type: 'array', items: { type: 'string' } },
      },
    },
    facts_to_memory: { type: 'array', items: FACT_ITEM_SCHEMA },
    dropped_because_in_memory: { type: 'array', items: { type: 'string' } },
    sensitive_mentions_redacted: { type: 'array', items: { type: 'string' } },
  },
};

const SUMMARY_SYSTEM = `Ты сжимаешь старую часть истории диалога для чат-бота с долговременной памятью.

Твоя задача:
1. Сохранить только то, что нужно для продолжения текущего диалога.
2. Не трогать последние сообщения — они не переданы тебе и будут добавлены отдельно.
3. Не дублировать факты, которые уже есть в active_memory.
4. Ближний к текущему моменту контекст описывать подробнее.
5. Дальний контекст сжимать сильнее.
6. Устойчивые факты О ПОЛЬЗОВАТЕЛЕ (из его реплик), которые стоит сохранить в долговременную память,
   вынести в facts_to_memory: объекты вида {"type": "profile|preference|habit|goal|emotional_pattern|
   activity_rhythm|communication_style|open_loop|topic_energy|discovery_seed", "fact_text": "короткая
   фраза от третьего лица", "confidence": 0..1, "ttl_days": целое число дней или null}. ttl_days — срок
   жизни факта: null, если факт бессрочный; для open_loop по умолчанию 30. Факты из реплик ассистента
   не выносить.
7. Не сохранять секретные данные в открытом виде (паспорта, телефоны, адреса, платёжные и медицинские данные).
8. Не сохранять мусор: приветствия, повторы, эмоции без последствий, одноразовые фразы.
9. Не выдумывать факты, которых не было в сообщениях.
10. В state_json.notes выноси только существенное, что не помещается в остальные поля состояния;
    используй это поле редко, обычно оставляй пустым массивом.
11. Вернуть только JSON по схеме.

Формат поля summary_text — строго три раздела с этими заголовками, каждый пункт с новой строки через «- »:
${ZONE_HEADERS.near}
- ...
${ZONE_HEADERS.middle}
- ...
${ZONE_HEADERS.far}
- ...

Приоритеты:
- Текущий запрос пользователя и последние сырые сообщения важнее твоей сводки.
- MEMORY_CONTEXT важнее повторяющихся старых фактов из истории.
- Если факт уже есть в active_memory, не повторяй его в summary_text, а перечисли в dropped_because_in_memory.`;

// Flat list of active-memory texts (to pass to the summarizer and for code-side deduplication).
function activeMemoryTexts(memory) {
  if (!memory) {
    return [];
  }
  const out = [];
  for (const key of ['profile', 'dialog', 'domain']) {
    for (const it of memory[key] || []) {
      if (it?.memory_text) {
        out.push(it.memory_text);
      }
    }
  }
  for (const s of memory.secure || []) {
    if (s?.redacted_summary) {
      out.push(s.redacted_summary);
    }
  }
  return out;
}

// Split the cold zone into three parts by token share: far — the first 25%, middle — the next 35%,
// near — the last 40% (by age). Messages are sorted in ascending time order.
function splitZones(messages) {
  const total = sumMessageTokens(messages) || 1;
  const farLimit = total * 0.25;
  const middleLimit = total * 0.6; // 0.25 + 0.35
  const zones = { far: [], middle: [], near: [] };
  let acc = 0;
  for (const m of messages) {
    const t = Number(m.token_count) || estimateTokens(m.content || '');
    if (acc < farLimit) {
      zones.far.push(m);
    } else if (acc < middleLimit) {
      zones.middle.push(m);
    } else {
      zones.near.push(m);
    }
    acc += t;
  }
  return zones;
}

function renderZone(messages) {
  return messages.map((m) => `${m.role}: ${m.content}`).join('\n');
}

function normalizeWords(s) {
  return new Set(
    String(s)
      .toLowerCase()
      .replace(/[^a-zа-я0-9 ]/gi, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3),
  );
}

// Similarity of a line to a memory text by the share of shared words (Jaccard measure). Needed so the
// code side reliably removes from the digest facts already saved in long-term memory.
function similarToMemory(line, memTexts) {
  const lw = normalizeWords(line);
  if (lw.size === 0) {
    return false;
  }
  for (const mt of memTexts) {
    const mw = normalizeWords(mt);
    if (mw.size === 0) {
      continue;
    }
    let inter = 0;
    for (const w of lw) {
      if (mw.has(w)) {
        inter++;
      }
    }
    const union = lw.size + mw.size - inter;
    if (union > 0 && inter / union >= 0.5) {
      return true;
    }
  }
  return false;
}

// Redact obviously secret values (long digit groups: passports, numbers, cards).
function redactSecrets(text) {
  return String(text)
    .replace(/\d{4}\s?\d{6}/g, '[скрыто]')
    .replace(/\d{6,}/g, '[скрыто]');
}

// Keep as many lines as fit into the token budget (trimming from the end — the least important).
function trimLinesToTokens(lines, budget) {
  const out = [...lines];
  while (out.length && estimateTokens(out.join('\n')) > budget) {
    out.pop();
  }
  return out;
}

// Parse the model's summary_text into three zones by headers. Text before the first header goes to near.
function parseZones(summaryText) {
  const zones = { near: [], middle: [], far: [] };
  let current = 'near';
  for (const raw of String(summaryText || '').split('\n')) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    if (line.startsWith(ZONE_HEADERS.near)) {
      current = 'near';
      continue;
    }
    if (line.startsWith(ZONE_HEADERS.middle)) {
      current = 'middle';
      continue;
    }
    if (line.startsWith(ZONE_HEADERS.far)) {
      current = 'far';
      continue;
    }
    zones[current].push(line.startsWith('-') ? line : `- ${line}`);
  }
  return zones;
}

// Assemble the final digest: dedup against memory, secret redaction, per-zone budget, fixed headers
// and a gradient (near gets a larger budget than far). Guarantees size ≤ targetTokens.
function assembleSummary(summaryText, { memTexts, targetTokens, zoneWeights }) {
  const cleaned = redactSecrets(summaryText);
  const zones = parseZones(cleaned);
  const dropped = [];
  for (const key of ['near', 'middle', 'far']) {
    zones[key] = zones[key].filter((line) => {
      if (similarToMemory(line, memTexts)) {
        dropped.push(line.replace(/^-\s*/, ''));
        return false;
      }
      return true;
    });
  }
  const [wNear, wMid, wFar] = zoneWeights;
  const budgets = {
    near: Math.max(1, Math.round(targetTokens * wNear)),
    middle: Math.max(1, Math.round(targetTokens * wMid)),
    far: Math.max(1, Math.round(targetTokens * wFar)),
  };
  const parts = [];
  for (const key of ['near', 'middle', 'far']) {
    const lines = trimLinesToTokens(zones[key], budgets[key]);
    if (lines.length) {
      parts.push(`${ZONE_HEADERS[key]}\n${lines.join('\n')}`);
    }
  }
  let text = parts.join('\n\n');
  // Final safeguard on total size (if it's still over the target overall — trim from the end).
  const allLines = text.split('\n');
  if (estimateTokens(text) > targetTokens) {
    text = trimLinesToTokens(allLines, targetTokens).join('\n');
  }
  return { text, dropped };
}

// Convert summarizer facts into the flat fact shape and run them through the normal saveFacts flow
// (confidence threshold, semantic deduplication, update instead of duplicates). In json_schema mode the
// strict FACT_ITEM_SCHEMA already guarantees the shape; the defaults here are a safeguard for the
// json_object mode (config.historyCompression.responseFormat), where the provider does not enforce it.
function factsToCandidates(facts = []) {
  return facts
    .map((f) => ({
      type: f.type || 'profile',
      fact_text: f.fact_text || '',
      confidence: Number(f.confidence ?? 0.7),
      ttl_days: f.ttl_days ?? null,
    }))
    .filter((c) => c.fact_text && !f_isSensitive(c.fact_text));
}

// Safety net against secrets in the summarizer's facts: the system prompt forbids them, but when the
// heuristic fires the fact is simply not written to long-term memory (nor does it get into the digest).
function f_isSensitive(text) {
  return /паспорт|карт[аы]\s*№|cvv|пин-?код/i.test(text);
}

// Compress the cold zone: split into zones, call the summarizer, assemble the final digest with
// guarantees on size, gradient, deduplication and secret redaction. Returns fields for saving the summary.
export async function summarizeColdHistory({
  activeSummary,
  coldPending,
  memory,
  targetTokens,
  zoneWeights,
  domainKey,
}) {
  const memTexts = activeMemoryTexts(memory);
  const zones = splitZones(coldPending);
  const previousDigest = activeSummary?.summary_text
    ? `Предыдущий дайджест (уже сжатая дальняя история, пересжать сильнее):\n${activeSummary.summary_text}`
    : '';

  const user = `Домен: ${domainKey || 'general'}

active_memory (уже сохранено в долговременной памяти — НЕ повторять в summary_text):
${memTexts.length ? memTexts.map((t) => `- ${t}`).join('\n') : '- (память пуста)'}

${previousDigest}

Холодная зона по частям (ближняя описывай подробнее, дальнюю — короче).

${ZONE_HEADERS.near}
${renderZone(zones.near) || '(нет сообщений)'}

${ZONE_HEADERS.middle}
${renderZone(zones.middle) || '(нет сообщений)'}

${ZONE_HEADERS.far}
${renderZone(zones.far) || '(нет сообщений)'}`;

  debugSummarizer(`compressing cold zone, messages: ${coldPending.length}, token target: ${targetTokens}`);
  let raw;
  try {
    raw = await chatJSON({
      model: config.historyCompression.model,
      kind: 'history_compress',
      schema: SUMMARY_SCHEMA,
      schemaName: 'history_summary',
      system: SUMMARY_SYSTEM,
      user,
      responseFormat: config.historyCompression.responseFormat,
    });
  } catch (err) {
    debugSummarizer(`summarizer returned an error, active summary unchanged: ${err.message}`);
    return null; // bad JSON — leave the old active summary untouched
  }

  const { text, dropped } = assembleSummary(raw.summary_text || '', { memTexts, targetTokens, zoneWeights });
  const modelDropped = Array.isArray(raw.dropped_because_in_memory) ? raw.dropped_because_in_memory : [];
  return {
    summaryText: text,
    stateJson: raw.state_json && typeof raw.state_json === 'object' ? raw.state_json : {},
    factsToMemory: factsToCandidates(raw.facts_to_memory),
    droppedBecauseInMemory: [...new Set([...modelDropped, ...dropped])],
    sensitiveRedacted: Array.isArray(raw.sensitive_mentions_redacted) ? raw.sensitive_mentions_redacted : [],
    summaryTokenCount: estimateTokens(text),
  };
}

// Check the cold-zone size and, if the threshold is exceeded, rebuild the digest and save it.
// Called before assembling the response context: by response time HISTORY_CONTEXT is already ready.
export async function maybeCompressHistory({ userId, conversationId, domainKey, memory }) {
  const { hotWindow } = config.historyCompression;
  const activeSummary = await getActiveConversationSummary(conversationId);
  const hotMessages = await getRecentMessages(conversationId, hotWindow);

  // Hot-window boundary: everything older than the earliest of the last N messages is the cold zone.
  const boundaryCreatedAt = hotMessages.length ? hotMessages[0].created_at : new Date();

  const coldPending = await getColdPendingMessages({
    conversationId,
    beforeCreatedAt: boundaryCreatedAt,
    afterMessageId: activeSummary?.covered_to_message_id || null,
  });

  const coldSize = estimateSummaryTokens(activeSummary) + sumMessageTokens(coldPending);

  if (coldSize <= config.historyCompression.maxTokens) {
    return { compressed: false, reason: 'below_threshold', coldSize };
  }
  if (!coldPending.length) {
    // Nothing left to compress (the whole cold zone is already covered) — keep the active summary as is.
    return { compressed: false, reason: 'nothing_pending', coldSize };
  }

  const result = await summarizeColdHistory({
    activeSummary,
    coldPending,
    memory,
    targetTokens: config.historyCompression.shrinkTokens,
    zoneWeights: config.historyCompression.zoneWeights,
    domainKey,
  });
  if (!result) {
    return { compressed: false, reason: 'summarizer_failed', coldSize };
  }

  const first = coldPending[0];
  const last = coldPending[coldPending.length - 1];
  await saveConversationSummary({
    conversationId,
    userId,
    summaryText: result.summaryText,
    stateJson: result.stateJson,
    layer: 'full',
    coveredFromMessageId: activeSummary?.covered_from_message_id || first.id,
    coveredToMessageId: last.id,
    coveredUntil: last.created_at,
    sourceMessageCount: (activeSummary?.source_message_count || 0) + coldPending.length,
    sourceTokenCount: coldSize,
    summaryTokenCount: result.summaryTokenCount,
    memoryDedupe: { dropped_because_in_memory: result.droppedBecauseInMemory },
  });

  // Durable facts from history go into long-term memory via the normal flow (thresholds, dedup).
  if (result.factsToMemory.length) {
    try {
      await saveFacts(userId, domainKey, result.factsToMemory, conversationId, { source: 'history_summary' });
    } catch (err) {
      debugSummarizer(`writing facts_to_memory failed: ${err.message}`);
    }
  }

  debugSummarizer(
    `history compressed: ${JSON.stringify({
      source_token_count: coldSize,
      summary_token_count: result.summaryTokenCount,
      compression_ratio: Number((result.summaryTokenCount / coldSize).toFixed(2)),
      facts_dropped_because_in_memory: result.droppedBecauseInMemory.length,
      facts_to_memory: result.factsToMemory.length,
    })}`,
  );

  return { compressed: true, coldSize, summaryTokens: result.summaryTokenCount };
}

export { factsToCandidates, splitZones, assembleSummary, SUMMARY_SCHEMA };
