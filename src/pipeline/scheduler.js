// Планировщик напоминаний и фоновых задач. Содержит: извлечение задачи из сообщения,
// создание задачи, воркер с безопасным захватом задач (FOR UPDATE SKIP LOCKED),
// однократным выполнением разовых задач, перепланированием регулярных и повторами при ошибке.
import cronParser from 'cron-parser';
import rrulePkg from 'rrule';
import { config } from '../config.js';
import { query } from '../db.js';
import { chatJSON } from '../llm.js';
import { getDomainId } from '../repo.js';

const WORKER_ID = process.env.WORKER_ID || 'scheduler-1';
const { rrulestr } = rrulePkg;

class ScheduleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScheduleError';
  }
}

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
Для разовой задачи используй schedule_kind="one_time" и вычисли run_at как абсолютную дату-время в ISO 8601.
Для простого "каждые N минут/часов/дней" используй schedule_kind="interval" и interval_seconds.
Для календарных регулярностей с конкретным локальным временем используй schedule_kind="cron", например каждый будний
день в 09:00: cron_expr="0 9 * * 1-5". Для сложных календарных правил используй schedule_kind="rrule" и реальную
iCalendar RRULE-строку. Не вычисляй run_at для cron/rrule: ближайший запуск посчитает код планировщика.
Всегда возвращай timezone из часового пояса пользователя, если пользователь явно не указал другой IANA timezone.
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
  const normalizedTask = { ...task, timezone: normalizeTimezone(task.timezone) };
  const nextRun = computeFirstRun(normalizedTask);
  const { rows } = await query(
    `INSERT INTO mem.scheduled_tasks
       (user_id, domain_id, conversation_id, task_type, title, instruction, payload,
        schedule_kind, timezone, run_at, interval_seconds, cron_expr, rrule, next_run_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING *`,
    [userId, domainId, conversationId, normalizedTask.task_type, normalizedTask.title, normalizedTask.instruction,
      normalizedTask.payload || {}, normalizedTask.schedule_kind, normalizedTask.timezone,
      normalizedTask.run_at || null, normalizedTask.interval_seconds || null, normalizedTask.cron_expr || null,
      normalizedTask.rrule || null, nextRun],
  );
  return rows[0];
}

export function normalizeTimezone(timezone, fallback = config.timezone || 'Europe/Moscow') {
  for (const candidate of [timezone, fallback, 'Europe/Moscow']) {
    if (!candidate) continue;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date());
      return candidate;
    } catch {
      // Try the next configured fallback.
    }
  }
  return 'Europe/Moscow';
}

export function formatLocalDateTime(dateLike, timezone) {
  const date = new Date(dateLike);
  if (Number.isNaN(date.getTime())) return null;
  const normalizedTimezone = normalizeTimezone(timezone);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: normalizedTimezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${normalizedTimezone}`;
}

function assertValidDate(date, label) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new ScheduleError(`Некорректное время расписания: ${label}`);
  }
  return date;
}

function offsetMsForTimezone(timezone, date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
  );
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUTC - date.getTime();
}

function zonedLocalPartsToUtc(localDate, timezone) {
  const localAsUTC = Date.UTC(
    localDate.getUTCFullYear(),
    localDate.getUTCMonth(),
    localDate.getUTCDate(),
    localDate.getUTCHours(),
    localDate.getUTCMinutes(),
    localDate.getUTCSeconds(),
    localDate.getUTCMilliseconds(),
  );
  const first = new Date(localAsUTC - offsetMsForTimezone(timezone, new Date(localAsUTC)));
  const corrected = new Date(localAsUTC - offsetMsForTimezone(timezone, first));
  return corrected;
}

function utcToZonedFloatingDate(date, timezone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
  );
  return new Date(Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
    date.getUTCMilliseconds(),
  ));
}

function parseFloatingDtstart(rruleText) {
  const match = rruleText.match(/^DTSTART(?:;TZID=[^:\n]+)?:([0-9]{8}T[0-9]{6})$/im);
  if (!match) return null;
  const value = match[1];
  return new Date(Date.UTC(
    Number(value.slice(0, 4)),
    Number(value.slice(4, 6)) - 1,
    Number(value.slice(6, 8)),
    Number(value.slice(9, 11)),
    Number(value.slice(11, 13)),
    Number(value.slice(13, 15)),
  ));
}

export function nextCronRun(task, afterDate = new Date()) {
  if (!task.cron_expr) throw new ScheduleError('Для cron-задачи не задан cron_expr');
  const timezone = normalizeTimezone(task.timezone);
  try {
    const interval = cronParser.CronExpressionParser.parse(task.cron_expr, {
      currentDate: assertValidDate(new Date(afterDate), 'afterDate'),
      tz: timezone,
    });
    return assertValidDate(interval.next().toDate(), `cron_expr=${task.cron_expr}`);
  } catch (err) {
    throw new ScheduleError(`Некорректное cron-расписание "${task.cron_expr}": ${err.message || err}`);
  }
}

export function nextRRuleRun(task, afterDate = new Date()) {
  if (!task.rrule) throw new ScheduleError('Для rrule-задачи не задан rrule');
  const dtstartTzid = task.rrule.match(/^DTSTART;TZID=([^:\n]+):/im)?.[1];
  const timezone = normalizeTimezone(dtstartTzid || task.timezone);
  const after = assertValidDate(new Date(afterDate), 'afterDate');
  try {
    if (/^DTSTART(?:;[^:\n]*)?:\d{8}T\d{6}Z/im.test(task.rrule)) {
      const utcRule = rrulestr(task.rrule, { forceset: false });
      return utcRule.after(after, false);
    }
    const floatingAfter = utcToZonedFloatingDate(after, timezone);
    const floatingDtstart = parseFloatingDtstart(task.rrule) || floatingAfter;
    const localRuleText = task.rrule.replace(/^DTSTART[^\n]*(?:\n|$)/im, '');
    const rule = rrulestr(localRuleText, { dtstart: floatingDtstart, forceset: false });
    let floatingNext = rule.after(floatingAfter, false);
    for (let i = 0; floatingNext && i < 5; i++) {
      const next = assertValidDate(zonedLocalPartsToUtc(floatingNext, timezone), `rrule=${task.rrule}`);
      if (next > after) return next;
      floatingNext = rule.after(floatingNext, false);
    }
    if (!floatingNext) return null;
    throw new ScheduleError(`RRULE-расписание "${task.rrule}" не дало будущий запуск`);
  } catch (err) {
    throw new ScheduleError(`Некорректное RRULE-расписание "${task.rrule}": ${err.message || err}`);
  }
}

export function computeNextRun(task, afterDate = new Date()) {
  const after = assertValidDate(new Date(afterDate), 'afterDate');
  if (task.schedule_kind === 'one_time') {
    if (!task.run_at) throw new ScheduleError('Для разовой задачи не задан run_at');
    return assertValidDate(new Date(task.run_at), `run_at=${task.run_at}`);
  }
  if (task.schedule_kind === 'interval' && task.interval_seconds) {
    return new Date(after.getTime() + task.interval_seconds * 1000);
  }
  if (task.schedule_kind === 'cron') return nextCronRun(task, after);
  if (task.schedule_kind === 'rrule') return nextRRuleRun(task, after);
  throw new ScheduleError(`Неподдерживаемый тип расписания: ${task.schedule_kind}`);
}

export function computeFirstRun(task, afterDate = new Date()) {
  if (task.schedule_kind === 'one_time') return computeNextRun(task, afterDate);
  if (task.schedule_kind === 'interval') {
    if (!task.interval_seconds || task.interval_seconds <= 0) {
      throw new ScheduleError('Для interval-задачи нужен положительный interval_seconds');
    }
    return computeNextRun(task, afterDate);
  }
  return computeNextRun(task, afterDate);
}

// Вычислить следующий запуск после выполнения. Для разовых задач — null (завершить).
export function calculateNextRun(task, afterDate = new Date()) {
  if (task.schedule_kind === 'one_time') return null;
  return computeNextRun(task, afterDate);
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
    if (err instanceof ScheduleError) {
      await query(
        `UPDATE mem.scheduled_tasks
         SET status='failed', locked_by=NULL, locked_until=NULL, updated_at=now()
         WHERE id=$1`,
        [task.id],
      );
      await query(
        `UPDATE mem.scheduled_task_runs SET status='failed', finished_at=now(), error_text=$2 WHERE id=$1`,
        [runId, String(err.message || err)],
      );
      return { ok: false, error: String(err.message || err) };
    }
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
