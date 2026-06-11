// Сид-скрипт для песочницы памяти. Создаёт трёх демонстрационных пользователей (Анна, Дмитрий, Лена)
// с богатой памятью по всем категориям, защищёнными записями, напоминаниями, триггерами проактивности,
// темами и журналом событий. Нужен, чтобы страница песочницы сразу была наглядной.
// Идемпотентен: повторный запуск пересоздаёт демо-пользователей заново (по внешнему идентификатору).
// Запуск: npm run seed:sandbox
import { query, closePool } from '../src/db.js';
import { flushLlmLog } from '../src/pipeline/llm-log.js';
import { embed } from '../src/llm.js';
import { getDomainId, ensureDefaultTriggers } from '../src/repo.js';
import { saveSecureRecord } from '../src/pipeline/secure.js';
import { createTask } from '../src/pipeline/scheduler.js';

const DAY = 86400000;
const HOUR = 3600000;
const iso = (ms) => new Date(Date.now() + ms).toISOString();

// Пересоздать пользователя с заданным внешним идентификатором (полное удаление прежних данных по каскаду).
async function recreateUser(externalId, displayName, timezone) {
  await query('DELETE FROM mem.users WHERE external_id = $1', [externalId]);
  // Демо-пользователям сразу включаем мастер-флаг проактивности, чтобы их триггеры были наглядны в песочнице
  // (по умолчанию у новых пользователей он выключен). Глобальный флаг проактивности всё равно гейтит реальную рассылку.
  const { rows } = await query(
    `INSERT INTO mem.users (external_id, display_name, locale, timezone, proactivity_enabled)
     VALUES ($1, $2, 'ru', $3, true) RETURNING *`,
    [externalId, displayName, timezone],
  );
  return rows[0];
}

// Вставить один факт памяти в плоскую таблицу mem.user_facts: scope 'domain' → domain_key текущего
// домена, остальное → general. Эмбеддинг считается по тексту (если прокси доступен), иначе остаётся
// пустым — тогда выборка опирается на полнотекстовый поиск.
async function insertMemory(userId, domainKey, m) {
  const vector = await embed(m.text);
  const updatedAt = iso(-(m.daysAgo || 0) * DAY);
  const factType = m.type || 'profile';
  await query(
    `INSERT INTO mem.user_facts
       (user_id, domain_key, fact_type, fact_text, confidence, evidence_count, embedding,
        expires_at, last_confirmed_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
    [
      userId,
      m.scope === 'domain' ? domainKey : 'general',
      factType,
      m.text,
      m.confidence,
      Math.max(1, m.usage || 1),
      vector ? `[${vector.join(',')}]` : null,
      factType === 'open_loop' ? iso(30 * DAY) : null,
      updatedAt,
    ],
  );
}

// Поставить уведомление в очередь доставки (демонстрирует «ожидают выполнения»).
async function queueNotification(userId, kind, text, inHours) {
  await query(
    `INSERT INTO mem.notification_outbox (user_id, channel, message_text, payload, next_attempt_at)
     VALUES ($1, 'default', $2, $3::jsonb, $4)`,
    [userId, text, JSON.stringify({ kind }), iso(inHours * HOUR)],
  );
}

// Записать доставленное внешнее событие в журнал.
async function logEvent(userId, eventId, relevance, reason, daysAgo) {
  await query(
    `INSERT INTO mem.event_deliveries (user_id, event_id, event_type, relevance_score, reason, delivered_at)
     VALUES ($1, $2, 'news', $3, $4, $5) ON CONFLICT (user_id, event_id) DO NOTHING`,
    [userId, eventId, relevance, reason, iso(-daysAgo * DAY)],
  );
}

// Записать тему в тематический трекинг.
async function insertTopic(userId, domainKey, topicKey, count, engagement, daysAgo) {
  const domainId = await getDomainId(domainKey);
  await query(
    `INSERT INTO mem.topic_mentions (user_id, domain_id, topic_key, mention_count, user_engagement_score, last_mentioned_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, domain_id, topic_key) DO UPDATE SET mention_count = EXCLUDED.mention_count`,
    [userId, domainId, topicKey, count, engagement, iso(-daysAgo * DAY)],
  );
}

async function seedAnna() {
  const u = await recreateUser('sandbox-anna', 'Анна', 'Europe/Moscow');
  const facts = [
    {
      scope: 'profile',
      type: 'preference',
      text: 'Предпочитает короткие ответы и примеры по шагам',
      confidence: 0.9,
      usage: 11,
      daysAgo: 2,
    },
    {
      scope: 'profile',
      type: 'goal',
      text: 'Готовится к ЕГЭ по математике, 11 класс',
      confidence: 0.85,
      usage: 6,
      daysAgo: 5,
    },
    {
      scope: 'profile',
      type: 'profile',
      text: 'Общается на русском, иногда просит английские термины',
      confidence: 0.7,
      usage: 2,
      daysAgo: 18,
    },
    {
      scope: 'dialog',
      type: 'open_loop',
      text: 'В прошлый раз разбирали дискриминант квадратного уравнения',
      confidence: 0.8,
      usage: 1,
      daysAgo: 0.8,
    },
    {
      scope: 'dialog',
      type: 'open_loop',
      text: 'Путается в знаках при переносе слагаемых',
      confidence: 0.65,
      usage: 1,
      daysAgo: 0.8,
    },
    {
      scope: 'domain',
      type: 'goal',
      text: 'Слабо понимает квадратные уравнения, путает дискриминант',
      confidence: 0.9,
      usage: 8,
      daysAgo: 1,
    },
    {
      scope: 'domain',
      type: 'goal',
      text: 'Линейные уравнения решает уверенно',
      confidence: 0.85,
      usage: 4,
      daysAgo: 9,
    },
    {
      scope: 'domain',
      type: 'preference',
      text: 'Любит сначала теорию, потом задачу',
      confidence: 0.7,
      usage: 3,
      daysAgo: 12,
    },
  ];
  for (const m of facts) {
    await insertMemory(u.id, 'math_tutor', m);
  }

  await saveSecureRecord({
    userId: u.id,
    domainKey: 'math_tutor',
    recordType: 'phone',
    displayName: 'телефон',
    rawValue: '+7 900 000-00-37',
    consentStatus: 'unknown',
  });

  const genId = await getDomainId('math_tutor');
  await createTask({
    userId: u.id,
    domainKey: 'math_tutor',
    task: {
      task_type: 'reminder',
      title: 'Решить 10 примеров на квадратные уравнения',
      instruction: 'Напоминаю, ты хотел порешать примеры на квадратные уравнения',
      schedule_kind: 'one_time',
      timezone: u.timezone,
      run_at: iso(1 * DAY),
      payload: {},
    },
  });
  await createTask({
    userId: u.id,
    domainKey: 'math_tutor',
    task: {
      task_type: 'reminder',
      title: 'Повторить теорему Виета перед пробником',
      instruction: 'Напоминаю, ты хотел повторить теорему Виета перед пробником',
      schedule_kind: 'one_time',
      timezone: u.timezone,
      run_at: iso(3 * DAY),
      payload: {},
    },
  });

  await ensureDefaultTriggers(
    u.id,
    genId,
    [
      { trigger_type: 'inactivity', config: { minutes_inactive: 1440 } },
      { trigger_type: 'daily_checkin', config: { hour: 10 } },
      { trigger_type: 'goal_reminder', config: { interval_minutes: 2880 } },
      { trigger_type: 'welcome_back', config: { gap_minutes: 60 } },
    ],
    { enabled: true },
  );

  await queueNotification(
    u.id,
    'proactive',
    'Привет! Два дня без практики — давай разберём слабую тему: квадратные уравнения?',
    4,
  );
  await logEvent(u.id, 'news-ege-2026', 0.78, 'Изменения в КИМ ЕГЭ по математике — релевантно цели пользователя.', 2);
  await insertTopic(u.id, 'math_tutor', 'квадратные уравнения', 7, 0.8, 1);
  await insertTopic(u.id, 'math_tutor', 'дискриминант', 5, 0.6, 1);
  await insertTopic(u.id, 'math_tutor', 'подготовка к ЕГЭ', 4, 0.75, 3);
  await insertTopic(u.id, 'math_tutor', 'теорема Виета', 2, 0.5, 5);
  console.log('  Анна готова.');
}

async function seedDmitry() {
  const u = await recreateUser('sandbox-dmitry', 'Дмитрий', 'Europe/Moscow');
  const facts = [
    {
      scope: 'profile',
      type: 'preference',
      text: 'Любит развёрнутые объяснения с вариантами',
      confidence: 0.85,
      usage: 9,
      daysAgo: 3,
    },
    {
      scope: 'profile',
      type: 'profile',
      text: 'Живёт в Казани',
      confidence: 0.9,
      usage: 7,
      daysAgo: 6,
    },
    {
      scope: 'dialog',
      type: 'open_loop',
      text: 'Искал рейсы в Стамбул на майские праздники',
      confidence: 0.8,
      usage: 1,
      daysAgo: 1.2,
    },
    {
      scope: 'domain',
      type: 'preference',
      text: 'Вылетает из Казани, не любит ночные рейсы',
      confidence: 0.92,
      usage: 12,
      daysAgo: 1,
    },
    {
      scope: 'domain',
      type: 'preference',
      text: 'Эконом с возможностью провоза багажа',
      confidence: 0.8,
      usage: 5,
      daysAgo: 7,
    },
    {
      scope: 'domain',
      type: 'goal',
      text: 'Поездка Казань → Стамбул в мае, 2 пассажира',
      confidence: 0.85,
      usage: 3,
      daysAgo: 1.2,
    },
  ];
  for (const m of facts) {
    await insertMemory(u.id, 'flight_search', m);
  }

  await saveSecureRecord({
    userId: u.id,
    domainKey: 'flight_search',
    recordType: 'passport',
    displayName: 'паспорт',
    rawValue: '1234 567812',
    consentStatus: 'granted',
  });

  const genId = await getDomainId('flight_search');
  await createTask({
    userId: u.id,
    domainKey: 'flight_search',
    task: {
      task_type: 'reminder',
      title: 'Проверить цены на рейс Казань–Стамбул',
      instruction: 'Напоминаю, ты хотел проверить цены на рейс Казань–Стамбул',
      schedule_kind: 'one_time',
      timezone: u.timezone,
      run_at: iso(2 * DAY),
      payload: {},
    },
  });

  await ensureDefaultTriggers(
    u.id,
    genId,
    [
      { trigger_type: 'inactivity', config: { minutes_inactive: 1440 } },
      { trigger_type: 'daily_checkin', config: { hour: 10 } },
      { trigger_type: 'goal_reminder', config: { interval_minutes: 2880 } },
      { trigger_type: 'welcome_back', config: { gap_minutes: 60 } },
    ],
    { enabled: true },
  );

  await queueNotification(
    u.id,
    'event',
    'Распродажа Turkish Airlines из Казани — по вашему направлению и предпочтению вылета.',
    1,
  );
  await logEvent(
    u.id,
    'news-turkish-sale',
    0.91,
    'Распродажа из Казани совпадает с предпочтением вылета и направлением.',
    1,
  );
  await logEvent(u.id, 'news-baggage-rules', 0.69, 'Новые правила багажа в Турцию — релевантно поездке.', 3);
  await insertTopic(u.id, 'flight_search', 'рейсы в Стамбул', 6, 0.8, 1);
  await insertTopic(u.id, 'flight_search', 'вылет из Казани', 4, 0.7, 2);
  await insertTopic(u.id, 'flight_search', 'багаж', 2, 0.5, 5);
  console.log('  Дмитрий готов.');
}

async function seedLena() {
  const u = await recreateUser('sandbox-lena', 'Лена', 'Asia/Yekaterinburg');
  const facts = [
    {
      scope: 'profile',
      type: 'preference',
      text: 'Лёгкий, дружелюбный тон с эмодзи',
      confidence: 0.85,
      usage: 8,
      daysAgo: 4,
    },
    {
      scope: 'dialog',
      type: 'open_loop',
      text: 'Просила шутку про программистов вчера',
      confidence: 0.7,
      usage: 1,
      daysAgo: 1.1,
    },
    {
      scope: 'domain',
      type: 'preference',
      text: 'Любит шутки про программистов и быт, не любит политику',
      confidence: 0.9,
      usage: 10,
      daysAgo: 1,
    },
    {
      scope: 'domain',
      type: 'profile',
      text: 'Слышала 2 шутки про программистов (j-101, j-204)',
      confidence: 0.85,
      usage: 4,
      daysAgo: 1,
    },
  ];
  for (const m of facts) {
    await insertMemory(u.id, 'joke_teller', m);
  }

  const genId = await getDomainId('joke_teller');
  await createTask({
    userId: u.id,
    domainKey: 'joke_teller',
    task: {
      task_type: 'reminder',
      title: 'Прислать шутку дня утром',
      instruction: 'Доставить шутку из любимой категории без повторов',
      schedule_kind: 'one_time',
      timezone: u.timezone,
      run_at: iso(16 * HOUR),
      payload: {},
    },
  });

  await ensureDefaultTriggers(
    u.id,
    genId,
    [
      { trigger_type: 'inactivity', config: { minutes_inactive: 1440 } },
      { trigger_type: 'daily_checkin', config: { hour: 10 } },
    ],
    { enabled: true },
  );

  await queueNotification(u.id, 'proactive', 'Шутка дня готова — прислать из любимой категории про программистов?', 16);
  await insertTopic(u.id, 'joke_teller', 'шутки про программистов', 5, 0.8, 1);
  await insertTopic(u.id, 'joke_teller', 'бытовой юмор', 2, 0.6, 2);
  console.log('  Лена готова.');
}

async function main() {
  console.log('Засев демо-пользователей песочницы памяти…');
  await seedAnna();
  await seedDmitry();
  await seedLena();
  console.log('Готово. Запустите: npm run sandbox');
  await flushLlmLog();
  await closePool();
}

main().catch(async (err) => {
  console.error('Ошибка засева:', err.message);
  await flushLlmLog();
  await closePool();
  process.exit(1);
});
