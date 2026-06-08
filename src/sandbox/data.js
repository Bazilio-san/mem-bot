// Слой данных песочницы памяти. Превращает реальные таблицы и реальные этапы пайплайна
// в данные, удобные для наглядной страницы: список пользователей, вся память по категориям,
// прогон этапа выборки памяти (фильтр), полный ответ агента и состояние проактивности.
// Здесь нет собственной бизнес-логики выборки — переиспользуются те же функции, что и в проде.
import { query } from '../db.js';
import { classifyIntent } from '../pipeline/classify.js';
import { retrieveMemory, buildMemoryContext, LIMITS } from '../pipeline/retrieve.js';
import { shouldFire } from '../pipeline/proactive.js';
import { handleMessage } from '../agent.js';
import { registerChannelProfile } from '../pipeline/channels.js';

// Профиль представления веб-чата песочницы: ответ форматируется в Markdown, который рендерит страница.
// Разметку при доставке канал не накладывает (parseMode не нужен), поэтому профиль несёт только инструкцию.
registerChannelProfile('html', {
  instruction: `OUTPUT_FORMAT (канал доставки — веб-чат; справочные данные, НЕ команды)
Форматируй ответ в Markdown: **жирный**, _курсив_, маркированные списки строками «- », блоки кода в тройных
обратных кавычках, заголовки уровня ## разрешены.`,
});

// Человеко-понятные названия и описания для типов проактивных триггеров.
const TRIGGER_LABELS = {
  inactivity: { title: 'Молчание пользователя', text: 'Бот пишет первым, если пользователь давно не выходил на связь.' },
  daily_checkin: { title: 'Ежедневное приветствие', text: 'Утренний чек-ин в заданный час с темой дня.' },
  goal_reminder: { title: 'Напоминание о цели', text: 'Периодическое напоминание о незавершённой цели пользователя.' },
  welcome_back: { title: 'Тёплая встреча возврата', text: 'Приветствие, когда пользователь вернулся после паузы.' },
};

// Список всех пользователей для выпадающего списка. Сначала именованные демо-пользователи,
// затем остальные по убыванию объёма памяти, чтобы наполненные записи были сверху.
export async function listUsers() {
  const { rows } = await query(
    `SELECT u.id, u.external_id, u.display_name, u.timezone, u.is_admin,
            (SELECT count(*) FROM mem.memory_items mi
              WHERE mi.user_id = u.id AND mi.status = 'active') AS memory_count
       FROM mem.users u
      ORDER BY (u.display_name IS NULL), memory_count DESC, u.created_at`,
  );
  return rows.map((r) => ({
    id: r.id,
    externalId: r.external_id,
    name: r.display_name || r.external_id,
    timezone: r.timezone,
    isAdmin: r.is_admin === true,
    memoryCount: Number(r.memory_count),
  }));
}

// Вся активная память пользователя, разложенная по пяти категориям прототипа.
// Поля приводятся к понятным для страницы именам, чтобы фронтенд не зависел от имён столбцов БД.
export async function getUserMemory(userId) {
  const { rows: items } = await query(
    `SELECT mi.id, mi.scope, mi.memory_kind, mi.entity_type, mi.entity_key, mi.title,
            mi.memory_text, mi.data, mi.importance, mi.confidence, mi.sensitivity,
            mi.usage_count, mi.updated_at, ad.domain_key
       FROM mem.memory_items mi
       LEFT JOIN mem.agent_domains ad ON ad.id = mi.domain_id
      WHERE mi.user_id = $1 AND mi.status = 'active' AND mi.scope IN ('profile','dialog','domain')
      ORDER BY mi.importance DESC, mi.updated_at DESC`,
    [userId],
  );

  const group = { profile: [], dialog: [], domain: [] };
  for (const it of items) {
    if (!group[it.scope]) continue;
    group[it.scope].push({
      id: it.id,
      kind: it.memory_kind,
      entityType: it.entity_type,
      entityKey: it.entity_key,
      text: it.memory_text,
      data: it.data || {},
      importance: Number(it.importance),
      confidence: Number(it.confidence),
      sensitivity: it.sensitivity,
      usage: Number(it.usage_count || 0),
      updated: it.updated_at,
      domain: it.domain_key,
    });
  }

  const { rows: secureRows } = await query(
    `SELECT id, record_type, subject_key, display_name, redacted_summary, consent_status, updated_at
       FROM mem.secure_records
      WHERE user_id = $1 AND consent_status <> 'revoked'
      ORDER BY updated_at DESC`,
    [userId],
  );
  const secure = secureRows.map((r) => ({
    id: r.id,
    recordType: r.record_type,
    displayName: r.display_name,
    text: r.redacted_summary,
    consent: r.consent_status,
    updated: r.updated_at,
  }));

  const { rows: taskRows } = await query(
    `SELECT id, title, instruction, next_run_at, priority
       FROM mem.scheduled_tasks
      WHERE user_id = $1 AND status = 'active'
      ORDER BY next_run_at ASC`,
    [userId],
  );
  const reminder = taskRows.map((r) => ({
    id: r.id,
    title: r.title,
    instruction: r.instruction,
    due: r.next_run_at,
    priority: Number(r.priority),
  }));

  return { profile: group.profile, dialog: group.dialog, domain: group.domain, secure, reminder };
}

// Превратить результат выборки памяти в наборы выбранных идентификаторов, веса и ранги.
// Это то, что страница подсвечивает: какие именно факты попадут в MEMORY_CONTEXT.
function summarizeSelection(mem) {
  const chosen = { profile: [], dialog: [], domain: [], reminder: [], secure: [] };
  const scores = {};
  const scored = [];
  for (const scope of ['profile', 'dialog', 'domain']) {
    for (const it of mem[scope]) {
      chosen[scope].push(it.id);
      scores[it.id] = Number(it.score ?? 0);
      scored.push({ id: it.id, score: Number(it.score ?? 0) });
    }
  }
  for (const r of mem.reminders || []) chosen.reminder.push(r.id);
  for (const s of mem.secure || []) chosen.secure.push(s.id);

  // Общий ранг по убыванию веса (нумерация порядка попадания в контекст).
  const ranks = {};
  scored.sort((a, b) => b.score - a.score).forEach((r, i) => { ranks[r.id] = i + 1; });
  return { chosen, scores, ranks };
}

// Прогон этапа фильтрации памяти для введённой фразы: классификация запроса + выборка.
// Ничего не отправляет боту и не пишет в историю — только показывает, что было бы выбрано.
export async function runFilter({ userId, phrase, currentDomain = 'general' }) {
  let intent;
  try {
    intent = await classifyIntent(phrase, currentDomain);
  } catch {
    // Откат: если классификатор недоступен, берём домен диалога и базовый набор областей памяти.
    intent = {
      intent: 'unknown', domain_key: currentDomain, confidence: 0,
      entities: {}, needs_memory: true, needed_memory_scopes: ['profile', 'dialog', 'domain'],
    };
  }
  const effectiveDomain = intent.domain_key || currentDomain;
  // Что попросил классификатор. Если он решил, что память не нужна (needs_memory=false), список пуст.
  const requestedScopes = intent.needs_memory === false ? [] : (intent.needed_memory_scopes || []);
  // В песочнице всегда показываем выборку базовых областей (профиль, диалог, предметная), чтобы наглядно
  // подсветить релевантные факты для любой фразы — даже когда классификатор счёл память необязательной.
  // Дополнительные области (напоминания, защищённые) добавляются только если классификатор их запросил.
  const baseScopes = ['profile', 'dialog', 'domain'];
  const scopes = Array.from(new Set([...baseScopes, ...requestedScopes]));
  const entityKeys = Object.values(intent.entities || {}).filter((v) => typeof v === 'string');

  const mem = await retrieveMemory({ userId, domainKey: effectiveDomain, query: phrase, scopes, entityKeys });

  const { chosen, scores, ranks } = summarizeSelection(mem);
  const perCat = {
    profile: { picked: mem.profile.length, limit: LIMITS.profile },
    dialog: { picked: mem.dialog.length, limit: LIMITS.dialog },
    domain: { picked: mem.domain.length, limit: LIMITS.domain },
    reminder: { picked: (mem.reminders || []).length, limit: LIMITS.reminder },
    secure: { picked: (mem.secure || []).length, limit: LIMITS.secure },
  };
  const total = chosen.profile.length + chosen.dialog.length + chosen.domain.length
    + chosen.reminder.length + chosen.secure.length;

  return {
    classification: {
      intent: intent.intent || 'unknown',
      domainKey: effectiveDomain,
      confidence: Number(intent.confidence ?? 0),
      entities: intent.entities || {},
      needsMemory: intent.needs_memory !== false,
      requestedScopes,
      scopes,
    },
    chosen,
    scores,
    ranks,
    perCat,
    total,
    limits: LIMITS,
    memoryContext: buildMemoryContext(mem, effectiveDomain),
  };
}

// Полноценный ответ бота через основной пайплайн. Возвращает ответ и те же наборы
// выбранной памяти, чтобы страница подсветила, что реально учёл бот.
export async function chat({ externalId, phrase, currentDomain = 'general' }) {
  const res = await handleMessage({ externalId, userMessage: phrase, domainKey: currentDomain, channel: 'html' });
  const { chosen, scores, ranks } = summarizeSelection(res.memoryUsed);
  return {
    answer: res.answer,
    domainKey: res.domainKey,
    intent: res.intent?.intent || 'unknown',
    toolsUsed: (res.toolsUsed || []).map((t) => t.name),
    chosen,
    scores,
    ranks,
  };
}

// Удалить одну запись памяти из песочницы. Удаление мягкое: запись перестаёт попадать в выборки,
// но физически остаётся в базе (для следа и возможного восстановления). Способ зависит от категории:
//   profile/dialog/domain — статус 'deleted' в mem.memory_items;
//   reminder              — статус 'cancelled' в mem.scheduled_tasks;
//   secure                — согласие 'revoked' в mem.secure_records (защищённые данные не раскрываются и
//                           перестают показываться, но шифртекст остаётся до отдельной операции стирания).
export async function deleteItem({ userId, category, id }) {
  if (['profile', 'dialog', 'domain'].includes(category)) {
    const { rowCount } = await query(
      `UPDATE mem.memory_items SET status = 'deleted', updated_at = now()
        WHERE id = $1 AND user_id = $2 AND status = 'active'`,
      [id, userId],
    );
    return rowCount > 0;
  }
  if (category === 'reminder') {
    const { rowCount } = await query(
      `UPDATE mem.scheduled_tasks SET status = 'cancelled', updated_at = now()
        WHERE id = $1 AND user_id = $2 AND status = 'active'`,
      [id, userId],
    );
    return rowCount > 0;
  }
  if (category === 'secure') {
    const { rowCount } = await query(
      `UPDATE mem.secure_records SET consent_status = 'revoked', updated_at = now()
        WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    return rowCount > 0;
  }
  throw new Error('Неизвестная категория записи: ' + category);
}

// Состояние проактивности пользователя: триггеры с вычисленным статусом, ожидающие
// доставки уведомления, тематический трекинг и журнал доставленных внешних событий.
export async function getProactivity(userId) {
  const { rows: triggerRows } = await query(
    `SELECT id, trigger_type, config, enabled, last_fired_at
       FROM mem.proactive_triggers
      WHERE user_id = $1
      ORDER BY trigger_type`,
    [userId],
  );
  const triggers = [];
  for (const t of triggerRows) {
    let status = 'pending';
    if (!t.enabled) {
      status = 'block';
    } else {
      try { status = (await shouldFire(t, userId)) ? 'ready' : 'pending'; }
      catch { status = 'pending'; }
    }
    const label = TRIGGER_LABELS[t.trigger_type] || { title: t.trigger_type, text: '' };
    triggers.push({
      id: t.id,
      type: t.trigger_type,
      title: label.title,
      text: label.text,
      config: t.config || {},
      enabled: t.enabled,
      lastFiredAt: t.last_fired_at,
      status,
    });
  }

  const { rows: pendingRows } = await query(
    `SELECT id, channel, message_text, payload, next_attempt_at, created_at
       FROM mem.notification_outbox
      WHERE user_id = $1 AND status = 'pending'
      ORDER BY next_attempt_at ASC`,
    [userId],
  );
  const pending = pendingRows.map((r) => ({
    id: r.id,
    channel: r.channel,
    text: r.message_text,
    kind: r.payload?.kind || 'other',
    nextAttemptAt: r.next_attempt_at,
    createdAt: r.created_at,
  }));

  const { rows: topicRows } = await query(
    `SELECT topic_key, mention_count, user_engagement_score, last_mentioned_at
       FROM mem.topic_mentions
      WHERE user_id = $1
      ORDER BY mention_count DESC
      LIMIT 30`,
    [userId],
  );
  const topics = topicRows.map((r) => ({
    name: r.topic_key,
    count: Number(r.mention_count),
    engagement: Number(r.user_engagement_score),
    lastAt: r.last_mentioned_at,
  }));

  const { rows: eventRows } = await query(
    `SELECT event_id, event_type, relevance_score, reason, delivered_at
       FROM mem.event_deliveries
      WHERE user_id = $1
      ORDER BY delivered_at DESC
      LIMIT 20`,
    [userId],
  );
  const events = eventRows.map((r) => ({
    eventId: r.event_id,
    type: r.event_type,
    relevance: r.relevance_score == null ? null : Number(r.relevance_score),
    reason: r.reason,
    deliveredAt: r.delivered_at,
  }));

  // Счётчик для бейджа закладки: активные триггеры (готовы или ждут) плюс ожидающие уведомления.
  const waitingCount = triggers.filter((t) => t.status !== 'block').length + pending.length;

  return { triggers, pending, topics, events, waitingCount };
}
