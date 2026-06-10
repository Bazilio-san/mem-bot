// Standalone worker. In a loop it picks up and runs due scheduler tasks,
// and when the proactive loop is enabled it also checks proactivity triggers and external events.
// Run with: npm run scheduler
//
// Instead of polling the database on a fixed interval, the worker sleeps exactly until the nearest task
// (adaptive sleep) and wakes up instantly when a new task is created: task creation sends a
// PostgreSQL notification on the scheduler_wake channel, which the worker subscribes to via LISTEN. This
// brings the firing latency close to zero, while when idle the database and CPU are barely loaded.
import { tick, msUntilDueTask } from './pipeline/scheduler.js';
import { assertDatabasesAvailable, createListener } from './db.js';
import { checkProactiveTriggers } from './pipeline/proactive.js';
import { processEvents } from './pipeline/events.js';
import { initTools } from './pipeline/tools.js';
import { config } from './config.js';

// The lower sleep bound keeps the worker from spinning too often when tasks come back-to-back.
const MIN_SLEEP_MS = config.scheduler.minSleepMs;
// The upper bound caps the maximum sleep so the worker periodically rechecks the database
// and honors the proactivity interval even when there are no scheduler tasks at all.
const MAX_SLEEP_MS = config.scheduler.maxSleepMs;

let lastProactiveAt = 0;
// Function that wakes the current sleep early. Set while sleeping, otherwise null.
let wakeUp = null;

// Interruptible sleep: finishes either on timeout or when a notification about a new task arrives.
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

// How long to sleep until the next pass. If there are no tasks, sleep up to the upper bound; if there is a task,
// sleep exactly until it is due, but within the lower and upper bounds. When proactivity is enabled, the sleep is
// additionally shortened so as not to miss the next triggers check.
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
  await assertDatabasesAvailable();

  // Startup diagnostics for external MCP servers: the proactive loop calls the agent, and the agent uses
  // MCP tools, so we print the declared list of servers and check the connection to each one right away
  // when the worker starts. initTools caches the promise, so there will be no repeated connection on first use.
  console.log('Checking connection to the declared MCP servers…');
  await initTools();

  // Subscribe to notifications about new tasks: inserting a task wakes the worker immediately.
  const listener = createListener('scheduler_wake', () => {
    if (wakeUp) {
      wakeUp();
    }
  });
  await listener.ready;

  console.log(
    'Worker started. Adaptive scheduler sleep:',
    MIN_SLEEP_MS,
    '…',
    MAX_SLEEP_MS,
    'ms',
    'with instant wake-up on a new-task notification.',
    config.proactive.enabled
      ? `Proactivity enabled, interval ${config.proactive.intervalMs} ms.`
      : 'Proactivity disabled.',
  );

  while (true) {
    let nextTaskMs = null;
    try {
      const r = await tick();
      if (r.processed > 0) {
        console.log(`Scheduler tasks completed: ${r.processed}.`);
      }

      if (config.proactive.enabled && Date.now() - lastProactiveAt >= config.proactive.intervalMs) {
        lastProactiveAt = Date.now();
        const p = await checkProactiveTriggers();
        if (p.fired > 0) {
          console.log(`Proactive messages sent: ${p.fired}.`);
        }
        if (config.proactive.events.enabled) {
          const e = await processEvents();
          if (e.delivered > 0) {
            console.log(`Event messages delivered: ${e.delivered}.`);
          }
        }
      }

      // Determine the time of the nearest task only after the possible rescheduling in tick().
      nextTaskMs = await msUntilDueTask();
    } catch (err) {
      console.error('Worker pass error:', err.message);
    }

    await sleep(computeSleepMs(nextTaskMs));
  }
}

loop().catch((err) => {
  console.error('Scheduler startup failed:', err.message);
  process.exit(1);
});
