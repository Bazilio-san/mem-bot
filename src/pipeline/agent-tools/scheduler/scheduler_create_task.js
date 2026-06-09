import { createTask, formatLocalDateTime } from '../../scheduler.js';

export const schedulerCreateTaskTool = {
  name: 'scheduler_create_task',
  title: 'Создаю напоминание...',
  definition: {
    type: 'function',
    function: {
      name: 'scheduler_create_task',
      description: `Create a reminder, recurring task, follow-up, report, or background condition check.
Use one_time with run_at for one-off tasks, interval for simple every-N-seconds schedules, cron for calendar local times 
such as weekdays at 09:00 (cron_expr="0 9 * * 1-5"), and rrule for complex iCalendar RRULE schedules.`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['task_type', 'title', 'instruction', 'schedule_kind', 'timezone', 'run_at', 'interval_seconds',
          'cron_expr', 'rrule'],
        properties: {
          task_type: {
            type: 'string',
            enum: ['reminder', 'condition_watch', 'follow_up', 'report'],
            description: 'Task category.',
          },
          title: { type: 'string', description: 'Short user-facing task title.' },
          instruction: {
            type: 'string',
            description: `The exact reminder text sent to the user when the task fires. 
It is delivered verbatim, so write it in the user's language as a person speaking directly to the user in second person,
as a reminder of what they wanted to do, not as a third-person instruction. 
Prefer "Reminding you, you wanted to call mom" over "Remind the user to call mom".`,
          },
          schedule_kind: {
            type: 'string',
            enum: ['one_time', 'interval', 'cron', 'rrule'],
            description: 'Scheduling mode.',
          },
          run_at: { type: ['string', 'null'], description: 'Absolute ISO 8601 time for a one-time task.' },
          interval_seconds: { type: ['integer', 'null'], description: 'Repeat interval in seconds.' },
          timezone: { type: ['string', 'null'], description: 'User IANA timezone, for example Europe/Moscow.' },
          cron_expr: {
            type: ['string', 'null'],
            description: 'Cron expression for cron schedules. Weekdays at 09:00: "0 9 * * 1-5"; monthly on day 1 at 10:00: "0 10 1 * *".',
          },
          rrule: {
            type: ['string', 'null'],
            description: 'iCalendar RRULE for rrule schedules, for example "RRULE:FREQ=WEEKLY;BYDAY=MO;BYHOUR=10;BYMINUTE=0".',
          },
        },
      },
    },
  },
  async handler(ctx, args) {
    const task = await createTask({
      userId: ctx.userId,
      domainKey: ctx.domainKey,
      conversationId: ctx.conversationId,
      task: {
        task_type: args.task_type,
        title: args.title,
        instruction: args.instruction,
        schedule_kind: args.schedule_kind,
        timezone: args.timezone || ctx.timezone,
        run_at: args.run_at,
        interval_seconds: args.interval_seconds,
        cron_expr: args.cron_expr,
        rrule: args.rrule,
        payload: {},
      },
    });
    return {
      task_id: task.id,
      title: task.title,
      schedule_kind: task.schedule_kind,
      timezone: task.timezone,
      cron_expr: task.cron_expr,
      rrule: task.rrule,
      next_run_at: task.next_run_at,
      next_run_at_local: formatLocalDateTime(task.next_run_at, task.timezone),
    };
  },
};
