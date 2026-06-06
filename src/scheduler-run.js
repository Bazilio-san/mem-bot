// Самостоятельный воркер. Циклически забирает и выполняет просроченные задачи планировщика,
// а при включённом проактивном контуре — ещё и проверяет триггеры проактивности и внешние события.
// Запуск: npm run scheduler
import { tick } from './pipeline/scheduler.js';
import { checkProactiveTriggers } from './pipeline/proactive.js';
import { processEvents } from './pipeline/events.js';
import { config } from './config.js';

const INTERVAL_MS = Number(process.env.SCHEDULER_INTERVAL_MS || 5000);
let lastProactiveAt = 0;

async function loop() {
  console.log('Воркер запущен. Интервал планировщика:', INTERVAL_MS, 'мс.',
    config.proactive.enabled
      ? `Проактивность включена, интервал ${config.proactive.intervalMs} мс.`
      : 'Проактивность выключена.');
  while (true) {
    try {
      const r = await tick();
      if (r.processed > 0) console.log(`Выполнено задач планировщика: ${r.processed}.`);

      if (config.proactive.enabled && Date.now() - lastProactiveAt >= config.proactive.intervalMs) {
        lastProactiveAt = Date.now();
        const p = await checkProactiveTriggers();
        if (p.fired > 0) console.log(`Отправлено проактивных сообщений: ${p.fired}.`);
        if (config.proactive.events.enabled) {
          const e = await processEvents();
          if (e.delivered > 0) console.log(`Доставлено сообщений о событиях: ${e.delivered}.`);
        }
      }
    } catch (err) {
      console.error('Ошибка прохода воркера:', err.message);
    }
    await new Promise((res) => setTimeout(res, INTERVAL_MS));
  }
}

loop();
