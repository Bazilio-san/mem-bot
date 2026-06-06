// Инструменты агента. Описания в формате OpenAI function calling + реальные исполнители.
// Каждый вызов реально меняет состояние БД (а не имитируется текстом) и пишется в журнал.
import { query, vectorToSql } from '../db.js';
import { embed } from '../llm.js';
import { getDomainId, logToolCall } from '../repo.js';
import { createTask } from './scheduler.js';
import { getSecureValue } from './secure.js';

// ---- Описания инструментов для модели ---------------------------------------
export const toolDefs = [
  {
    type: 'function',
    function: {
      name: 'memory_search',
      description: 'Найти релевантные факты в памяти пользователя по текущему контексту.',
      parameters: {
        type: 'object', additionalProperties: false,
        required: ['query', 'limit'],
        properties: {
          query: { type: 'string', description: 'Поисковый запрос' },
          limit: { type: 'integer', minimum: 1, maximum: 30 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scheduler_create_task',
      description: 'Создать напоминание, регулярную задачу или фоновую проверку. Вызывай, когда пользователь просит напомнить или проверить что-то позже.',
      parameters: {
        type: 'object', additionalProperties: false,
        required: ['task_type', 'title', 'instruction', 'schedule_kind', 'run_at', 'interval_seconds'],
        properties: {
          task_type: { type: 'string', enum: ['reminder', 'condition_watch', 'follow_up', 'report'] },
          title: { type: 'string' },
          instruction: { type: 'string' },
          schedule_kind: { type: 'string', enum: ['one_time', 'interval', 'cron', 'rrule'] },
          run_at: { type: ['string', 'null'], description: 'Абсолютное время ISO 8601 для разовой задачи' },
          interval_seconds: { type: ['integer', 'null'] },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'secure_record_get',
      description: 'Получить полное защищённое значение (паспорт, телефон и т.п.) ТОЛЬКО когда оно реально нужно для действия (оформление, заполнение формы) и есть согласие. Требует указать цель.',
      parameters: {
        type: 'object', additionalProperties: false,
        required: ['secure_record_id', 'purpose'],
        properties: {
          secure_record_id: { type: 'string' },
          purpose: { type: 'string', description: 'Зачем нужны данные' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_flights',
      description: 'Поиск авиабилетов по маршруту и дате (доменный инструмент flight_search).',
      parameters: {
        type: 'object', additionalProperties: false,
        required: ['origin', 'destination', 'date'],
        properties: {
          origin: { type: 'string', description: 'Город вылета' },
          destination: { type: 'string', description: 'Город назначения' },
          date: { type: ['string', 'null'], description: 'Дата вылета' },
        },
      },
    },
  },
];

// ---- Исполнители инструментов -----------------------------------------------
async function memorySearch(ctx, args) {
  const domainId = await getDomainId(ctx.domainKey);
  const vec = await embed(args.query);
  if (vec) {
    const { rows } = await query(
      `SELECT memory_text, scope, importance, 1 - (embedding <=> $3::vector) AS relevance
       FROM mem.memory_items
       WHERE user_id=$1 AND status='active' AND embedding IS NOT NULL
         AND sensitivity IN ('public','low','normal')
         AND (scope='profile' OR (scope='domain' AND domain_id=$2) OR scope='dialog')
       ORDER BY embedding <=> $3::vector LIMIT $4`,
      [ctx.userId, domainId, vectorToSql(vec), args.limit || 10],
    );
    return { facts: rows.map((r) => r.memory_text) };
  }
  const { rows } = await query(
    `SELECT memory_text FROM mem.memory_items
     WHERE user_id=$1 AND status='active' AND search_tsv @@ plainto_tsquery('simple',$2)
       AND sensitivity IN ('public','low','normal')
     ORDER BY importance DESC LIMIT $3`,
    [ctx.userId, args.query, args.limit || 10],
  );
  return { facts: rows.map((r) => r.memory_text) };
}

async function schedulerCreateTask(ctx, args) {
  const task = await createTask({
    userId: ctx.userId, domainKey: ctx.domainKey, conversationId: ctx.conversationId,
    task: {
      task_type: args.task_type, title: args.title, instruction: args.instruction,
      schedule_kind: args.schedule_kind, timezone: ctx.timezone,
      run_at: args.run_at, interval_seconds: args.interval_seconds, payload: {},
    },
  });
  return { task_id: task.id, title: task.title, next_run_at: task.next_run_at };
}

async function secureRecordGet(ctx, args) {
  // Раскрытие секрета строго по цели и согласию; getSecureValue сам проверяет согласие.
  const res = await getSecureValue(args.secure_record_id, args.purpose);
  return { record_type: res.record_type, value: res.value, purpose: res.purpose };
}

// Заглушка доменного инструмента поиска билетов (вместо реального API сервиса fli).
async function searchFlights(ctx, args) {
  return {
    route: `${args.origin} → ${args.destination}`,
    date: args.date || 'ближайшие даты',
    offers: [
      { flight: 'SU 1234', depart: '08:40', arrive: '11:10', price_rub: 7450, night: false },
      { flight: 'U6 221', depart: '23:15', arrive: '01:55', price_rub: 5300, night: true },
    ],
  };
}

const EXECUTORS = {
  memory_search: memorySearch,
  scheduler_create_task: schedulerCreateTask,
  secure_record_get: secureRecordGet,
  search_flights: searchFlights,
};

// Выполнить инструмент по имени с журналированием результата и ошибок.
export async function executeTool(ctx, name, args) {
  const started = Date.now();
  const exec = EXECUTORS[name];
  if (!exec) {
    return { error: `Неизвестный инструмент: ${name}` };
  }
  try {
    const output = await exec(ctx, args);
    await logToolCall({
      conversationId: ctx.conversationId, userId: ctx.userId, toolName: name,
      input: args, output, status: 'success', latencyMs: Date.now() - started,
    });
    return output;
  } catch (err) {
    await logToolCall({
      conversationId: ctx.conversationId, userId: ctx.userId, toolName: name,
      input: args, status: 'failed', latencyMs: Date.now() - started, error: String(err.message || err),
    });
    return { error: String(err.message || err) };
  }
}
