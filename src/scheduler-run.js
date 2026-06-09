// Самостоятельный воркер. Циклически забирает и выполняет просроченные задачи планировщика,
// а при включённом проактивном контуре — ещё и проверяет триггеры проактивности и внешние события.
// Запуск: npm run scheduler
//
// Вместо опроса базы через фиксированный интервал воркер спит ровно до момента ближайшей задачи
// (адаптивный сон) и просыпается мгновенно, когда создаётся новая задача: создание задачи шлёт
// уведомление PostgreSQL по каналу scheduler_wake, на который воркер подписан через LISTEN. Так
// задержка срабатывания приближается к нулю, а в простое база и процессор почти не нагружаются.
import { tick, msUntilDueTask } from './pipeline/scheduler.js';
import { createListener } from './db.js';
import { checkProactiveTriggers } from './pipeline/proactive.js';
import { processEvents } from './pipeline/events.js';
import { initTools } from './pipeline/tools.js';
import { config } from './config.js';

// Нижняя граница сна не даёт воркеру крутиться слишком часто, когда задачи идут вплотную.
const MIN_SLEEP_MS = Number(process.env.SCHEDULER_MIN_SLEEP_MS || 250);
// Верхняя граница ограничивает максимальный сон, чтобы воркер периодически перепроверял базу
// и соблюдал интервал проактивности даже при полном отсутствии задач планировщика.
const MAX_SLEEP_MS = Number(process.env.SCHEDULER_MAX_SLEEP_MS || 30000);

let lastProactiveAt = 0;
// Функция досрочного пробуждения текущего сна. Устанавливается на время сна, иначе null.
let wakeUp = null;

// Прерываемый сон: завершается либо по тайм-ауту, либо когда пришло уведомление о новой задаче.
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wakeUp = null;
      resolve();
    }, ms);
    wakeUp = () => {
      clearTimeout(timer);
      wakeUp = null;
      resolve();
    };
  });
}

// Сколько спать до следующего прохода. Если задач нет — спим до верхней границы; если задача есть —
// ровно до её запуска, но в пределах нижней и верхней границ. При включённой проактивности сон
// дополнительно укорачивается так, чтобы не пропустить очередную проверку триггеров.
function computeSleepMs(nextTaskMs) {
  const base = nextTaskMs === null ? MAX_SLEEP_MS : nextTaskMs;
  let ms = Math.max(MIN_SLEEP_MS, Math.min(base, MAX_SLEEP_MS));
  if (config.proactive.enabled) {
    const untilProactive = config.proactive.intervalMs - (Date.now() - lastProactiveAt);
    ms = Math.min(ms, Math.max(MIN_SLEEP_MS, untilProactive));
  }
  return ms;
}

async function loop() {
  // Стартовая диагностика внешних MCP-серверов: проактивный контур обращается к агенту, а тот пользуется
  // инструментами MCP, поэтому выводим объявленный список серверов и проверяем подключение к каждому сразу
  // при запуске воркера. initTools кэширует промис, повторного подключения при первом обращении не будет.
  console.log('Проверяю подключение к объявленным MCP-серверам…');
  await initTools();

  // Подписка на уведомления о появлении новых задач: вставка задачи будит воркер немедленно.
  const listener = createListener('scheduler_wake', () => {
    if (wakeUp) {
      wakeUp();
    }
  });
  await listener.ready;

  console.log(
    'Воркер запущен. Адаптивный сон планировщика:',
    MIN_SLEEP_MS,
    '…',
    MAX_SLEEP_MS,
    'мс',
    'с мгновенным пробуждением по уведомлению о новой задаче.',
    config.proactive.enabled
      ? `Проактивность включена, интервал ${config.proactive.intervalMs} мс.`
      : 'Проактивность выключена.',
  );

  while (true) {
    let nextTaskMs = null;
    try {
      const r = await tick();
      if (r.processed > 0) {
        console.log(`Выполнено задач планировщика: ${r.processed}.`);
      }

      if (config.proactive.enabled && Date.now() - lastProactiveAt >= config.proactive.intervalMs) {
        lastProactiveAt = Date.now();
        const p = await checkProactiveTriggers();
        if (p.fired > 0) {
          console.log(`Отправлено проактивных сообщений: ${p.fired}.`);
        }
        if (config.proactive.events.enabled) {
          const e = await processEvents();
          if (e.delivered > 0) {
            console.log(`Доставлено сообщений о событиях: ${e.delivered}.`);
          }
        }
      }

      // Узнаём момент ближайшей задачи уже после возможного перепланирования в tick().
      nextTaskMs = await msUntilDueTask();
    } catch (err) {
      console.error('Ошибка прохода воркера:', err.message);
    }

    await sleep(computeSleepMs(nextTaskMs));
  }
}

loop();
