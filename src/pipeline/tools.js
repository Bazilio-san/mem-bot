// Инструменты агента. Описания в формате OpenAI function calling + реальные исполнители.
// Каждый вызов реально меняет состояние БД (а не имитируется текстом) и пишется в журнал.
import { query, vectorToSql } from '../db.js';
import { embed } from '../llm.js';
import { getDomainId, logToolCall } from '../repo.js';
import { createTask } from './scheduler.js';
import { getSecureValue } from './secure.js';
import { config } from '../config.js';
import {
  addGlobalFact, deleteGlobalFact, listGlobalFacts,
  searchGlobalKnowledge, addGlobalKnowledge, deleteGlobalKnowledge,
} from './global-memory.js';
import { listMemory, forgetAll, deleteByEntity } from './admin.js';

// ---- Базовые описания инструментов для модели -------------------------------
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
  {
    type: 'function',
    function: {
      name: 'memory_list',
      description: 'Показать пользователю, что бот о нём помнит. Вызывай, когда пользователь спрашивает, какие факты о нём сохранены.',
      parameters: {
        type: 'object', additionalProperties: false,
        required: ['scope', 'include_archived'],
        properties: {
          scope: {
            type: ['string', 'null'], enum: ['profile', 'domain', 'dialog', null],
            description: 'Необязательный фильтр области памяти; null — показать все области',
          },
          include_archived: { type: 'boolean', description: 'Показывать ли удалённые записи (по умолчанию false)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_forget_entity',
      description: 'Мягко удалить из памяти конкретную сущность по её названию. Вызывай, когда пользователь просит забыть что-то конкретное («забудь мой адрес», «удали данные о машине»).',
      parameters: {
        type: 'object', additionalProperties: false,
        required: ['entity_name', 'entity_type'],
        properties: {
          entity_name: { type: 'string', description: 'Название сущности или ключ, например «адрес», «паспорт»' },
          entity_type: { type: ['string', 'null'], description: 'Уточнение типа, если под название подходит несколько сущностей; иначе null' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_forget_all',
      description: 'Полностью забыть всё об активной памяти пользователя. Вызывай ТОЛЬКО по явной и недвусмысленной просьбе и после подтверждения.',
      parameters: {
        type: 'object', additionalProperties: false,
        required: ['confirm'],
        properties: {
          confirm: { type: 'boolean', description: 'Должно быть true — защита от случайного срабатывания' },
        },
      },
    },
  },
];

// ---- Инструменты глобальной памяти (подключаются флагами, запись — только администратору) ----
// Инструменты глобальных фактов (флаг GLOBAL_MEMORY_ENABLED). Все доступны только администратору.
const globalFactsToolDefs = [
  {
    type: 'function',
    function: {
      name: 'global_fact_add',
      description: 'Добавить глобальный факт, видимый всем пользователям и подмешиваемый в каждый запрос. Только для администратора.',
      parameters: {
        type: 'object', additionalProperties: false,
        required: ['fact_text'],
        properties: {
          fact_text: { type: 'string', description: 'Текст факта' },
          priority: { type: ['integer', 'null'], description: 'Приоритет: меньше число — важнее (по умолчанию 100)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'global_fact_delete',
      description: 'Удалить глобальный факт по идентификатору. Только для администратора.',
      parameters: {
        type: 'object', additionalProperties: false,
        required: ['id'],
        properties: { id: { type: 'string', description: 'Идентификатор факта' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'global_fact_list',
      description: 'Показать глобальные факты с идентификаторами. Только для администратора.',
      parameters: { type: 'object', additionalProperties: false, required: [], properties: {} },
    },
  },
];

// Инструменты общей базы знаний (флаг GLOBAL_RAG_ENABLED). Поиск доступен всем, запись — только администратору.
const globalKnowledgeToolDefs = [
  {
    type: 'function',
    function: {
      name: 'global_knowledge_search',
      description: 'Найти релевантные тексты в общей базе знаний (видна всем пользователям).',
      parameters: {
        type: 'object', additionalProperties: false,
        required: ['query', 'limit'],
        properties: {
          query: { type: 'string', description: 'Поисковый запрос' },
          limit: { type: 'integer', minimum: 1, maximum: 20 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'global_knowledge_add',
      description: 'Добавить текст в общую базу знаний. Только для администратора.',
      parameters: {
        type: 'object', additionalProperties: false,
        required: ['content'],
        properties: {
          title: { type: ['string', 'null'], description: 'Краткий заголовок' },
          content: { type: 'string', description: 'Текст знания' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'global_knowledge_delete',
      description: 'Удалить текст из общей базы знаний по идентификатору. Только для администратора.',
      parameters: {
        type: 'object', additionalProperties: false,
        required: ['id'],
        properties: { id: { type: 'string', description: 'Идентификатор записи базы знаний' } },
      },
    },
  },
];

// Записывающие глобальные инструменты доступны только администратору (проверка в executeTool).
const ADMIN_TOOLS = new Set([
  'global_fact_add', 'global_fact_delete', 'global_fact_list',
  'global_knowledge_add', 'global_knowledge_delete',
]);

// Собрать набор инструментов для конкретного запроса с учётом флагов и прав пользователя.
// Инструменты глобальной памяти добавляются только при включённых флагах; записывающие — только администратору
// (их незачем показывать обычному пользователю — это и снижает соблазн модели их вызвать, и экономит токены).
export function buildToolDefs(ctx = {}) {
  const defs = [...toolDefs];
  if (config.globalMemory.factsEnabled && ctx.isAdmin) defs.push(...globalFactsToolDefs);
  if (config.globalMemory.ragEnabled) {
    defs.push(globalKnowledgeToolDefs[0]); // поиск — всем
    if (ctx.isAdmin) defs.push(globalKnowledgeToolDefs[1], globalKnowledgeToolDefs[2]); // запись — администратору
  }
  return defs;
}

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

// ---- Исполнители управления личной памятью ----------------------------------
// Все операции строго в рамках ctx.userId: пользователь видит и удаляет только свою память.

async function memoryListTool(ctx, args) {
  const rows = await listMemory(ctx.userId, { includeArchived: args.include_archived === true });
  const scope = args.scope || null;
  const filtered = scope ? rows.filter((r) => r.scope === scope) : rows;
  // Приватность: защищённые значения высокого уровня (паспорт, телефон и т. п.) не отдаём целиком —
  // показываем только обобщённое название (entity_type/entity_key), как это делает memory_search.
  const items = filtered.map((r) => {
    const isProtected = r.sensitivity === 'high' || r.sensitivity === 'secret';
    return {
      id: r.id, scope: r.scope, entity_type: r.entity_type, entity_key: r.entity_key,
      importance: r.importance, status: r.status,
      memory_text: isProtected ? '[защищённые данные — скрыто]' : r.memory_text,
    };
  });
  return { items };
}

async function memoryForgetEntityTool(ctx, args) {
  return deleteByEntity(ctx.userId, args.entity_name, args.entity_type || null);
}

async function memoryForgetAllTool(ctx, args) {
  // Необратимость с точки зрения пользователя: исполняем только при явном подтверждении.
  if (args.confirm !== true) {
    return { deleted: 0, error: 'Нужно явное подтверждение пользователя (confirm=true).' };
  }
  const deleted = await forgetAll(ctx.userId);
  return { deleted };
}

// ---- Исполнители глобальной памяти ------------------------------------------
async function globalFactAdd(ctx, args) {
  const f = await addGlobalFact({ factText: args.fact_text, priority: args.priority ?? 100, createdBy: ctx.userId });
  return { id: f.id, fact_text: f.fact_text, priority: f.priority };
}

async function globalFactDelete(ctx, args) {
  const ok = await deleteGlobalFact(args.id);
  return { deleted: ok };
}

async function globalFactList() {
  const facts = await listGlobalFacts({ includeDisabled: true });
  return { facts: facts.map((f) => ({ id: f.id, fact_text: f.fact_text, enabled: f.enabled, priority: f.priority })) };
}

async function globalKnowledgeSearchTool(ctx, args) {
  const hits = await searchGlobalKnowledge({ domainKey: ctx.domainKey, query: args.query, limit: args.limit || 5 });
  return { fragments: hits.map((h) => (h.title ? `${h.title}: ${h.content}` : h.content)) };
}

async function globalKnowledgeAdd(ctx, args) {
  const k = await addGlobalKnowledge({ title: args.title ?? null, content: args.content, createdBy: ctx.userId });
  return { id: k.id, title: k.title, content: k.content };
}

async function globalKnowledgeDelete(ctx, args) {
  const ok = await deleteGlobalKnowledge(args.id);
  return { deleted: ok };
}

const EXECUTORS = {
  memory_search: memorySearch,
  scheduler_create_task: schedulerCreateTask,
  secure_record_get: secureRecordGet,
  search_flights: searchFlights,
  memory_list: memoryListTool,
  memory_forget_entity: memoryForgetEntityTool,
  memory_forget_all: memoryForgetAllTool,
  global_fact_add: globalFactAdd,
  global_fact_delete: globalFactDelete,
  global_fact_list: globalFactList,
  global_knowledge_search: globalKnowledgeSearchTool,
  global_knowledge_add: globalKnowledgeAdd,
  global_knowledge_delete: globalKnowledgeDelete,
};

// Выполнить инструмент по имени с журналированием результата и ошибок.
export async function executeTool(ctx, name, args) {
  const started = Date.now();

  // Записывающие глобальные инструменты доступны только администратору. Отказ фиксируется в журнале
  // со статусом blocked, чтобы попытка осталась видимой при аудите.
  if (ADMIN_TOOLS.has(name) && !ctx.isAdmin) {
    await logToolCall({
      conversationId: ctx.conversationId, userId: ctx.userId, toolName: name,
      input: args, status: 'blocked', latencyMs: Date.now() - started, error: 'Требуются права администратора',
    });
    return { error: 'Это действие доступно только администратору.' };
  }

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
