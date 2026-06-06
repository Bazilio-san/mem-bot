// Самостоятельный воркер планировщика. Циклически забирает и выполняет просроченные задачи.
// Запуск: npm run scheduler
import { tick } from './pipeline/scheduler.js';

const INTERVAL_MS = Number(process.env.SCHEDULER_INTERVAL_MS || 5000);

async function loop() {
  console.log('Планировщик запущен. Интервал опроса:', INTERVAL_MS, 'мс.');
  while (true) {
    try {
      const r = await tick();
      if (r.processed > 0) console.log(`Выполнено задач: ${r.processed}`);
    } catch (err) {
      console.error('Ошибка прохода планировщика:', err.message);
    }
    await new Promise((res) => setTimeout(res, INTERVAL_MS));
  }
}

loop();
