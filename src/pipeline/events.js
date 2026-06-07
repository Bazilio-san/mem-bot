// Внешние события как поводы написать первым (критерий 17). Источник событий (на старте — заглушка-новости),
// фильтр релевантности через модель и доставка релевантного события с защитой от повторной отправки.
// Универсальный механизм: вместо новостей можно подключить погоду, праздники, дедлайны — контракт тот же.
import { config } from '../config.js';
import { query } from '../db.js';
import { chat, chatJSON } from '../llm.js';
import { ensureConversation, saveMessage, getDomainId, listUsersWithTriggers } from '../repo.js';
import {
  classifyEventCandidate, evaluateContactPolicy, getContactState, recordProactiveSent,
} from './proactiveContactPolicy.js';

// Заглушка источника новостей. В продакшене заменить на внешний API. Каждое событие имеет стабильный id.
const NEWS_STUB = [
  { id: 'news-001', type: 'news', title: 'Новый рекорд в марафонском беге', category: 'sport',
    summary: 'Профессиональный бегун установил рекорд на дистанции, тренируясь по новой методике интервалов.' },
  { id: 'news-002', type: 'news', title: 'Прорыв в локальных языковых моделях', category: 'tech',
    summary: 'Вышла компактная модель, работающая офлайн на ноутбуке с приемлемым качеством.' },
  { id: 'news-003', type: 'news', title: 'Дешёвые авиабилеты на осень', category: 'travel',
    summary: 'Авиакомпании открыли распродажу на осенние направления по югу и Закавказью.' },
  { id: 'news-004', type: 'news', title: 'Простой рецепт домашнего хлеба', category: 'cooking',
    summary: 'Пекарь показал быстрый способ испечь хлеб на закваске без специального оборудования.' },
  { id: 'news-005', type: 'news', title: 'Исследование о пользе короткого сна', category: 'health',
    summary: 'Учёные нашли связь между двадцатиминутным дневным сном и улучшением концентрации.' },
  { id: 'news-006', type: 'news', title: 'Новые правила для частных инвесторов', category: 'finance',
    summary: 'Регулятор смягчил требования к доступу розничных инвесторов на отдельные рынки.' },
  { id: 'news-007', type: 'news', title: 'Гид по горным маршрутам для новичков', category: 'travel',
    summary: 'Опубликован список безопасных однодневных маршрутов для начинающих туристов.' },
  { id: 'news-008', type: 'news', title: 'Подборка упражнений для спины', category: 'health',
    summary: 'Физиотерапевт собрал короткий комплекс против боли в спине при сидячей работе.' },
  { id: 'news-009', type: 'news', title: 'Тренды в веб-разработке этого года', category: 'tech',
    summary: 'Обзор подходов, которые набирают популярность среди фронтенд-разработчиков.' },
  { id: 'news-010', type: 'news', title: 'Фестиваль уличной еды в выходные', category: 'food',
    summary: 'В городе пройдёт фестиваль с кухнями разных стран и мастер-классами для гостей.' },
];

let cursor = 0; // курсор по заглушке: по одному событию за проход.

function nextEvent() {
  if (!NEWS_STUB.length) return null;
  const ev = NEWS_STUB[cursor % NEWS_STUB.length];
  cursor++;
  return ev;
}

async function loadFactsText(userId, domainId) {
  const { rows } = await query(
    `SELECT memory_kind, memory_text FROM mem.memory_items
      WHERE user_id = $1 AND status = 'active' AND sensitivity IN ('public','low','normal')
        AND (scope = 'profile' OR (scope = 'domain' AND domain_id = $2))
      ORDER BY importance DESC LIMIT 20`, [userId, domainId]);
  return rows.map((r) => `- (${r.memory_kind}) ${r.memory_text}`).join('\n');
}

// Оценка релевантности события пользователю. Строгий JSON.
async function checkRelevance(userId, domainId, event) {
  const facts = await loadFactsText(userId, domainId);
  if (!facts) return { isRelevant: false, relevanceScore: 0, reason: 'Недостаточно данных о пользователе.' };
  const schema = {
    type: 'object', additionalProperties: false, required: ['isRelevant', 'relevanceScore', 'reason'],
    properties: {
      isRelevant: { type: 'boolean' },
      relevanceScore: { type: 'number' },
      reason: { type: 'string' },
    },
  };
  const system = `Ты оцениваешь, насколько новость интересна пользователю по его фактам, целям и интересам.
Будь строгим: помечай релевантным только то, что ЯВНО связано с интересами пользователя.

Профиль пользователя:
${facts}`;
  const user = `Заголовок: ${event.title}\nКатегория: ${event.category}\nСодержание: ${event.summary}`;
  try { return await chatJSON({ system, user, schema, schemaName: 'news_relevance' }); }
  catch { return { isRelevant: false, relevanceScore: 0, reason: 'Ошибка анализа.' }; }
}

async function alreadyDelivered(userId, eventId) {
  const { rows } = await query(
    `SELECT 1 FROM mem.event_deliveries WHERE user_id = $1 AND event_id = $2`, [userId, eventId]);
  return rows.length > 0;
}

async function deliverEvent(user, domainId, event, relevance, candidate) {
  const facts = await loadFactsText(user.id, domainId);
  const system = `Ты дружелюбно делишься новостью. Коротко (2-3 предложения): объясни, почему она может быть интересна
именно этому пользователю, изложи суть и предложи обсудить, если захочет. Тон тёплый, без навязчивости.
Причина релевантности: ${relevance.reason}

Профиль пользователя:
${facts}`;
  const msg = await chat({
    model: config.llm.mainModel,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `${event.title}\n\n${event.summary}` },
    ],
  });
  const text = msg.content || `📰 ${event.title}\n\n${event.summary}`;

  const conversation = await ensureConversation(user.id, 'general');
  const message = await saveMessage(conversation.id, user.id, 'assistant', text);
  await query(
    `INSERT INTO mem.notification_outbox (user_id, channel, message_text, payload)
     VALUES ($1, 'default', $2, $3::jsonb)`,
    [user.id, text, JSON.stringify({
      kind: 'event',
      event_id: event.id,
      conversation_message_id: message.id,
    })]);
  await query(
    `INSERT INTO mem.event_deliveries (user_id, event_id, event_type, relevance_score, reason)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (user_id, event_id) DO NOTHING`,
    [user.id, event.id, event.type, relevance.relevanceScore, relevance.reason]);
  await recordProactiveSent({ userId: user.id, candidate });
}

// Один проход контура событий: взять событие, проверить релевантность каждому пользователю, доставить подходящим.
export async function processEvents() {
  if (!config.proactive.enabled || !config.proactive.events.enabled) return { delivered: 0 };
  const event = nextEvent();
  if (!event) return { delivered: 0 };
  const users = await listUsersWithTriggers();
  let delivered = 0;
  for (const user of users) {
    try {
      if (await alreadyDelivered(user.id, event.id)) continue;
      const domainId = await getDomainId('general');
      const candidate = classifyEventCandidate(event);
      const state = await getContactState(user.id);
      const decision = evaluateContactPolicy({ state, candidate });
      if (!decision.allowed) continue;
      const rel = await checkRelevance(user.id, domainId, event);
      if (rel.isRelevant && Number(rel.relevanceScore) >= config.proactive.events.relevanceThreshold) {
        await deliverEvent(user, domainId, event, rel, candidate);
        delivered++;
      }
    } catch (err) { console.error('Обработка события не удалась:', event.id, err.message); }
  }
  return { delivered, eventId: event.id };
}
