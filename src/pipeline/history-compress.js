// Решение о сжатии холодной зоны истории и вызов суммаризатора.
// Холодная зона — всё, что старше горячего окна (последних N сообщений). Если её размер в токенах
// превысил порог, она пересобирается в компактный дайджест с градиентом: ближняя к текущему моменту
// часть подробнее, дальняя — короче. Факты, уже сохранённые в долговременной памяти, в дайджест не
// попадают (защита от дублей). Устойчивые факты выносятся в долговременную память обычным контуром.
import { chatJSON } from '../llm.js';
import { config, debugEnabled } from '../config.js';
import { getRecentMessages, getActiveConversationSummary, getColdPendingMessages, saveConversationSummary } from '../repo.js';
import { persistCandidates } from './merge.js';
import { estimateTokens, sumMessageTokens, estimateSummaryTokens } from './token-counter.js';

function dbg(...args) {
  if (debugEnabled('llm:summarizer')) console.error('[summarizer]', ...args);
}

// Заголовки зон в итоговом дайджесте. Порядок фиксирован: ближняя → средняя → дальняя.
const ZONE_HEADERS = {
  near: 'Ближняя часть разговора:',
  middle: 'Средняя часть разговора:',
  far: 'Дальняя часть разговора:',
};

// Схема ответа суммаризатора. Размеры в токенах в схему намеренно не входят — их считает наш код.
const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary_text', 'state_json', 'facts_to_memory', 'dropped_because_in_memory', 'sensitive_mentions_redacted'],
  properties: {
    summary_text: { type: 'string' },
    state_json: {
      type: 'object',
      additionalProperties: true,
      properties: {
        current_goal: { type: ['string', 'null'] },
        current_task: { type: ['string', 'null'] },
        decisions: { type: 'array', items: { type: 'string' } },
        rejected_options: { type: 'array', items: { type: 'string' } },
        open_questions: { type: 'array', items: { type: 'string' } },
        constraints: { type: 'array', items: { type: 'string' } },
        next_steps: { type: 'array', items: { type: 'string' } },
      },
    },
    facts_to_memory: { type: 'array', items: { type: 'object', additionalProperties: true } },
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
6. Устойчивые факты, которые стоит сохранить в долговременную память, вынести в facts_to_memory.
7. Не сохранять секретные данные в открытом виде (паспорта, телефоны, адреса, платёжные и медицинские данные).
8. Не сохранять мусор: приветствия, повторы, эмоции без последствий, одноразовые фразы.
9. Не выдумывать факты, которых не было в сообщениях.
10. Вернуть только JSON по схеме.

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

// Плоский список текстов активной памяти (для передачи суммаризатору и код-стороны дедупликации).
function activeMemoryTexts(memory) {
  if (!memory) return [];
  const out = [];
  for (const key of ['profile', 'dialog', 'domain']) {
    for (const it of memory[key] || []) if (it?.memory_text) out.push(it.memory_text);
  }
  for (const s of memory.secure || []) if (s?.redacted_summary) out.push(s.redacted_summary);
  return out;
}

// Разбить холодную зону на три части по доле токенов: дальняя — первые 25%, средняя — следующие 35%,
// ближняя — последние 40% (по давности). Сообщения отсортированы по возрастанию времени.
function splitZones(messages) {
  const total = sumMessageTokens(messages) || 1;
  const farLimit = total * 0.25;
  const middleLimit = total * 0.60; // 0.25 + 0.35
  const zones = { far: [], middle: [], near: [] };
  let acc = 0;
  for (const m of messages) {
    const t = Number(m.token_count) || estimateTokens(m.content || '');
    if (acc < farLimit) zones.far.push(m);
    else if (acc < middleLimit) zones.middle.push(m);
    else zones.near.push(m);
    acc += t;
  }
  return zones;
}

function renderZone(messages) {
  return messages.map((m) => `${m.role}: ${m.content}`).join('\n');
}

function normalizeWords(s) {
  return new Set(
    String(s).toLowerCase().replace(/[^a-zа-я0-9 ]/gi, ' ').split(/\s+/).filter((w) => w.length >= 3),
  );
}

// Похожесть строки на текст памяти по доле общих слов (мера Жаккара). Нужна, чтобы код-сторона
// гарантированно убирала из дайджеста факты, уже сохранённые в долговременной памяти.
function similarToMemory(line, memTexts) {
  const lw = normalizeWords(line);
  if (lw.size === 0) return false;
  for (const mt of memTexts) {
    const mw = normalizeWords(mt);
    if (mw.size === 0) continue;
    let inter = 0;
    for (const w of lw) if (mw.has(w)) inter++;
    const union = lw.size + mw.size - inter;
    if (union > 0 && inter / union >= 0.5) return true;
  }
  return false;
}

// Затереть очевидно секретные значения (длинные группы цифр: паспорта, номера, карты).
function redactSecrets(text) {
  return String(text)
    .replace(/\d{4}\s?\d{6}/g, '[скрыто]')
    .replace(/\d{6,}/g, '[скрыто]');
}

// Оставить из набора строк столько, чтобы уложиться в бюджет токенов (обрезаем с конца — наименее важное).
function trimLinesToTokens(lines, budget) {
  const out = [...lines];
  while (out.length && estimateTokens(out.join('\n')) > budget) out.pop();
  return out;
}

// Разобрать summary_text модели на три зоны по заголовкам. Текст до первого заголовка относим к ближней.
function parseZones(summaryText) {
  const zones = { near: [], middle: [], far: [] };
  let current = 'near';
  for (const raw of String(summaryText || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith(ZONE_HEADERS.near)) { current = 'near'; continue; }
    if (line.startsWith(ZONE_HEADERS.middle)) { current = 'middle'; continue; }
    if (line.startsWith(ZONE_HEADERS.far)) { current = 'far'; continue; }
    zones[current].push(line.startsWith('-') ? line : `- ${line}`);
  }
  return zones;
}

// Собрать итоговый дайджест: дедупликация с памятью, затирание секретов, бюджет по зонам, фиксированные
// заголовки и градиент (ближняя получает больший бюджет, чем дальняя). Гарантирует размер ≤ targetTokens.
function assembleSummary(summaryText, { memTexts, targetTokens, zoneWeights }) {
  const cleaned = redactSecrets(summaryText);
  const zones = parseZones(cleaned);
  const dropped = [];
  for (const key of ['near', 'middle', 'far']) {
    zones[key] = zones[key].filter((line) => {
      if (similarToMemory(line, memTexts)) { dropped.push(line.replace(/^-\s*/, '')); return false; }
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
    if (lines.length) parts.push(`${ZONE_HEADERS[key]}\n${lines.join('\n')}`);
  }
  let text = parts.join('\n\n');
  // Финальная страховка по общему размеру (если суммарно всё же больше цели — режем с конца).
  const allLines = text.split('\n');
  if (estimateTokens(text) > targetTokens) text = trimLinesToTokens(allLines, targetTokens).join('\n');
  return { text, dropped };
}

// Привести факты суммаризатора к форме кандидатов памяти и провести их обычным контуром persistCandidates
// (порог важности → проверка чувствительности → дедупликация → обновление вместо дублей).
function factsToCandidates(facts = []) {
  return facts.map((f) => ({
    scope: f.scope || 'profile',
    memory_kind: f.memory_kind || 'fact',
    entity_type: f.entity_type ?? null,
    entity_key: f.entity_key ?? null,
    memory_text: f.memory_text || '',
    data: f.data || {},
    importance: Number(f.importance ?? 0.6),
    confidence: Number(f.confidence ?? 0.7),
    sensitivity: f.sensitivity || 'normal',
    ttl_days: f.ttl_days ?? null,
    requires_confirmation: !!f.requires_confirmation,
    reason: f.reason || 'вынесено из истории диалога',
  })).filter((c) => c.memory_text);
}

// Сжать холодную зону: разбить на зоны, вызвать суммаризатор, собрать итоговый дайджест с гарантиями
// размера, градиента, дедупликации и затирания секретов. Возвращает поля для сохранения сводки.
export async function summarizeColdHistory({ activeSummary, coldPending, memory, targetTokens, zoneWeights, domainKey }) {
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

  dbg('сжатие холодной зоны, сообщений:', coldPending.length, 'цель токенов:', targetTokens);
  let raw;
  try {
    raw = await chatJSON({
      model: config.historyCompression.model,
      schema: SUMMARY_SCHEMA,
      schemaName: 'history_summary',
      system: SUMMARY_SYSTEM,
      user,
    });
  } catch (err) {
    dbg('суммаризатор вернул ошибку, активная сводка не меняется:', err.message);
    return null; // плохой JSON — не трогаем старую активную сводку
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

// Проверить размер холодной зоны и при превышении порога пересобрать дайджест и сохранить его.
// Вызывается перед сборкой контекста ответа: к моменту ответа HISTORY_CONTEXT уже готов.
export async function maybeCompressHistory({ userId, conversationId, domainKey, memory }) {
  const hotWindow = config.historyCompression.hotWindow;
  const activeSummary = await getActiveConversationSummary(conversationId);
  const hotMessages = await getRecentMessages(conversationId, hotWindow);

  // Граница горячего окна: всё, что старше самого раннего из последних N сообщений, — холодная зона.
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
    // Нечего досжимать (вся холодная зона уже покрыта) — оставляем активную сводку как есть.
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
  if (!result) return { compressed: false, reason: 'summarizer_failed', coldSize };

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

  // Устойчивые факты из истории — в долговременную память обычным контуром (пороги, чувствительность, дедуп).
  if (result.factsToMemory.length) {
    try { await persistCandidates(userId, domainKey, result.factsToMemory, conversationId); }
    catch (err) { dbg('запись facts_to_memory не удалась:', err.message); }
  }

  dbg('история сжата:', JSON.stringify({
    source_token_count: coldSize,
    summary_token_count: result.summaryTokenCount,
    compression_ratio: Number((result.summaryTokenCount / coldSize).toFixed(2)),
    facts_dropped_because_in_memory: result.droppedBecauseInMemory.length,
    facts_to_memory: result.factsToMemory.length,
  }));

  return { compressed: true, coldSize, summaryTokens: result.summaryTokenCount };
}

export { factsToCandidates, splitZones, assembleSummary };
