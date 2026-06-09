import { query } from '../../../db.js';
import { formatLocalDateTime } from '../../scheduler.js';

const WEEKDAYS = {
  MO: 'понедельник',
  TU: 'вторник',
  WE: 'среду',
  TH: 'четверг',
  FR: 'пятницу',
  SA: 'субботу',
  SU: 'воскресенье',
};

function pad2(value) {
  return String(value).padStart(2, '0');
}

function describeCron(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return null;
  const time = `${pad2(hour)}:${pad2(minute)}`;
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*') return `каждый день в ${time}`;
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '1-5') return `по будням в ${time}`;
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '0,6') return `по выходным в ${time}`;
  if (dayOfMonth !== '*' && month === '*' && dayOfWeek === '*') {
    return `каждый месяц ${dayOfMonth} числа в ${time}`;
  }
  return null;
}

function describeRRule(rrule) {
  const text = String(rrule || '').replace(/^RRULE:/i, '');
  const fields = Object.fromEntries(text.split(';').map((part) => {
    const [key, value] = part.split('=');
    return [key, value];
  }).filter(([key, value]) => key && value));
  const hour = fields.BYHOUR && /^\d+$/.test(fields.BYHOUR) ? pad2(fields.BYHOUR) : null;
  const minute = fields.BYMINUTE && /^\d+$/.test(fields.BYMINUTE) ? pad2(fields.BYMINUTE) : '00';
  const time = hour ? ` в ${hour}:${minute}` : '';
  if (fields.FREQ === 'DAILY') return `каждый день${time}`;
  if (fields.FREQ === 'WEEKLY') {
    const days = String(fields.BYDAY || '').split(',').map((d) => WEEKDAYS[d]).filter(Boolean);
    return days.length ? `каждую неделю: ${days.join(', ')}${time}` : `каждую неделю${time}`;
  }
  if (fields.FREQ === 'MONTHLY') return `каждый месяц${time}`;
  if (fields.FREQ === 'YEARLY') return `каждый год${time}`;
  return null;
}

function describeSchedule(row) {
  if (row.schedule_kind === 'one_time') {
    return 'разовое напоминание';
  }
  if (row.schedule_kind === 'interval') {
    const seconds = Number(row.interval_seconds || 0);
    if (seconds > 0 && seconds % 86400 === 0) return `каждые ${seconds / 86400} дн.`;
    if (seconds > 0 && seconds % 3600 === 0) return `каждые ${seconds / 3600} ч.`;
    if (seconds > 0 && seconds % 60 === 0) return `каждые ${seconds / 60} мин.`;
    return seconds > 0 ? `каждые ${seconds} сек.` : 'интервальное расписание';
  }
  if (row.schedule_kind === 'cron') {
    const human = describeCron(row.cron_expr);
    return human || (row.cron_expr ? `cron: ${row.cron_expr}` : 'cron-расписание');
  }
  if (row.schedule_kind === 'rrule') {
    const human = describeRRule(row.rrule);
    return human || (row.rrule ? `RRULE: ${row.rrule}` : 'RRULE-расписание');
  }
  return row.schedule_kind || 'расписание';
}

export const schedulerListTasksTool = {
  name: 'scheduler_list_tasks',
  title: 'Собираю напоминания и задачи...',
  definition: {
    type: 'function',
    function: {
      name: 'scheduler_list_tasks',
      description: `List active scheduled reminders and tasks for the current user. 
Use this when the user asks to show active reminders, scheduled tasks, due times, or recurring schedules.`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['limit'],
        properties: {
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 50,
            description: 'Maximum number of active tasks to return.',
          },
        },
      },
    },
  },
  async handler(ctx, args) {
    const limit = Math.max(1, Math.min(Number(args.limit || 20), 50));
    const { rows } = await query(
      `SELECT id, task_type, title, instruction, schedule_kind, timezone, run_at, interval_seconds,
              cron_expr, rrule, next_run_at, status, created_at
         FROM mem.scheduled_tasks
        WHERE user_id = $1 AND status = 'active'
        ORDER BY next_run_at ASC
        LIMIT $2`,
      [ctx.userId, limit],
    );
    return {
      count: rows.length,
      items: rows.map((row) => ({
        id: row.id,
        task_type: row.task_type,
        title: row.title,
        instruction: row.instruction,
        status: row.status,
        schedule_kind: row.schedule_kind,
        schedule_description: describeSchedule(row),
        timezone: row.timezone,
        next_run_at: row.next_run_at,
        next_run_at_local: formatLocalDateTime(row.next_run_at, row.timezone),
        run_at: row.run_at,
        interval_seconds: row.interval_seconds,
        cron_expr: row.cron_expr,
        rrule: row.rrule,
        created_at: row.created_at,
      })),
    };
  },
};
