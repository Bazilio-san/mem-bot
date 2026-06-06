// Планировщик напоминаний и фоновых задач. Содержит: извлечение задачи из сообщения,
// создание задачи, воркер с безопасным захватом задач (FOR UPDATE SKIP LOCKED),
// однократным выполнением разовых задач, перепланированием регулярных и повторами при ошибке.
import { query } from '../db.js';
import { chatJSON } from '../llm.js';
import { getDomainId } from '../repo.js';

const WORKER_ID = process.env.WORKER_ID || 'scheduler-1';

const EXTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['has_task', 'task'],
  properties: {
    has_task: { type: 'boolean' },
    task: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['task_type', 'title', 'instruction', 'schedule_kind', 'timezone', 'run_at', 'interval_seconds', 'cron_expr', 'rrule', 'payload', 'requires_confirmation'],
      properties: {
        task_type: { type: 'string', enum: ['reminder', 'condition_watch', 'follow_up', 'report', 'memory_cleanup'] },
        title: { type: 'string' },
        instruction: { type: 'string' },
        schedule_kind: { type: 'string', enum: ['one_time', 'interval', 'cron', 'rrule'] },
        timezone: { type: 'string' },
        run_at: { type: ['string', 'null'] },
        interval_seconds: { type: ['integer', 'null'] },
        cron_expr: { type: ['string', 'null'] },
        rrule: { type: ['string', 'null'] },
        payload: { type: 'object', additionalProperties: true },
        requires_confirmation: { type: 'boolean' },
      },
    },
  },
};

// Извлечь задачу/напоминание из сообщения пользователя. Создаёт задачу только при явной
// просьбе напомнить/проверить позже/следить/присылать регулярно.
export async function extractTask({ userMessage, nowIso, timezone, dialogContext = '' }) {
  return chatJSON({
    schema: EXTRACT_SCHEMA,
    schemaName: 'scheduler_task',
    system: `Ты извлекаешь задачи, напоминания и фоновые проверки из сообщения пользователя.
Создавай задачу ТОЛЬКО если пользователь явно попросил: напомнить, проверить позже, следить за условием,
присылать регулярно или вернуться к теме в будущем. Не создавай задачу из обычного желания без намерения напомнить.
Вычисли run_at как абсолютную дату-время в ISO 8601 относительно текущего времени.
Верни только JSON по схеме.`,
    user: `Текущая дата и время: ${nowIso}
Часовой пояс пользователя: ${timezone}
Сообщение пользователя: ${userMessage}
Контекст диалога: ${dialogContext || 'нет'}`,
  });
}

// Создать задачу в БД.
export async function createTask({ userId, domainKey = 'general', conversationId = null, task }) {
  const domainId = await getDomainId(domainKey);
  const nextRun = computeFirstRun(task);
  const { rows } = await query(
    `INSERT INTO mem.scheduled_tasks
       (user_id, domain_id, conversation_id, task_type, title, instruction, payload,
        schedule_kind, timezone, run_at, interval_seconds, cron_expr, rrule, next_run_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING *`,
    [userId, domainId, conversationId, task.task_type, task.title, task.instruction, task.payload || {},
      task.schedule_kind, task.timezone || 'Europe/Moscow', task.run_at || null,
      task.interval_seconds || null, task.cron_expr || null, task.rrule || null, nextRun],
  );
  return rows[0];
}

function computeFirstRun(task) {
  if (task.run_at) return new Date(task.run_at);
  if (task.schedule_kind === 'interval' && task.interval_seconds) {
    return new Date(Date.now() + task.interval_seconds * 1000);
  }
  return new Date(); // немедленно, если время не задано
}

// Вычислить следующий запуск после выполнения. Для разовых задач — null (завершить).
function calculateNextRun(task) {
  if (task.schedule_kind === 'one_time') return null;
  if (task.schedule_kind === 'interval') {
    const seconds = task.interval_seconds || 86400;
    return new Date(Date.now() + seconds * 1000);
  }
  // cron/rrule в этом MVP упрощены до суточного шага (в проде — croniter/rrule).
  return new Date(Date.now() + 86400000);
}

// Безопасно захватить просроченные задачи (несколько воркеров не возьмут одну и ту же).
export async function claimDueTasks(limit = 20) {
  const { rows } = await query(
    `WITH due AS (
       SELECT id FROM mem.scheduled_tasks
       WHERE status = 'active' AND next_run_at <= now()
         AND (locked_until IS NULL OR locked_until < now())
       ORDER BY priority ASC, next_run_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE mem.scheduled_tasks t
     SET locked_by = $2, locked_until = now() + interval '2 minutes', updated_at = now()
     FROM due WHERE t.id = due.id
     RETURNING t.*`,
    [limit, WORKER_ID],
  );
  return rows;
}

// Выполнить одну задачу: создать запись запуска, положить уведомление в outbox,
// перепланировать или завершить. При ошибке увеличить счётчик попыток.
export async function runTask(task, { onReminder } = {}) {
  const { rows: runRows } = await query(
    `INSERT INTO mem.scheduled_task_runs (task_id, status, worker_id, started_at)
     VALUES ($1,'running',$2, now()) RETURNING id`,
    [task.id, WORKER_ID],
  );
  const runId = runRows[0].id;

  try {
    if (task.task_type === 'reminder' || task.task_type === 'follow_up' || task.task_type === 'report') {
      await query(
        `INSERT INTO mem.notification_outbox (user_id, task_id, channel, message_text, payload)
         VALUES ($1,$2,'default',$3,$4::jsonb)`,
        [task.user_id, task.id, task.instruction, JSON.stringify(task.payload || {})],
      );
      if (onReminder) await onReminder(task);
    } else if (task.task_type === 'memory_cleanup') {
      await query(
        `UPDATE mem.memory_items SET status='archived', updated_at=now()
         WHERE user_id=$1 AND status='active' AND expires_at IS NOT NULL AND expires_at < now()`,
        [task.user_id],
      );
    }

    const nextRun = calculateNextRun(task);
    if (nextRun === null) {
      await query(
        `UPDATE mem.scheduled_tasks
         SET status='completed', completed_at=now(), last_run_at=now(),
             locked_by=NULL, locked_until=NULL, updated_at=now()
         WHERE id=$1`,
        [task.id],
      );
    } else {
      await query(
        `UPDATE mem.scheduled_tasks
         SET next_run_at=$2, last_run_at=now(), attempts=0,
             locked_by=NULL, locked_until=NULL, updated_at=now()
         WHERE id=$1`,
        [task.id, nextRun],
      );
    }

    await query(
      `UPDATE mem.scheduled_task_runs SET status='success', finished_at=now(), result='{"ok":true}'::jsonb WHERE id=$1`,
      [runId],
    );
    return { ok: true, rescheduled: nextRun !== null };
  } catch (err) {
    // Ошибка не теряется: увеличиваем попытки, при исчерпании — статус failed,
    // иначе оставляем активной с отложенным повтором.
    await query(
      `UPDATE mem.scheduled_tasks
       SET attempts = attempts + 1,
           next_run_at = now() + interval '30 seconds',
           locked_by=NULL, locked_until=NULL,
           status = CASE WHEN attempts + 1 >= max_attempts THEN 'failed'::mem.task_status ELSE status END,
           updated_at=now()
       WHERE id=$1`,
      [task.id],
    );
    await query(
      `UPDATE mem.scheduled_task_runs SET status='failed', finished_at=now(), error_text=$2 WHERE id=$1`,
      [runId, String(err.message || err)],
    );
    return { ok: false, error: String(err.message || err) };
  }
}

// Один проход планировщика: захватить и выполнить все просроченные задачи.
export async function tick(opts = {}) {
  const tasks = await claimDueTasks(opts.limit || 20);
  const results = [];
  for (const t of tasks) results.push(await runTask(t, opts));
  return { processed: tasks.length, results };
}
