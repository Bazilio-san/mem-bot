// Age-based cleanup of the journals in the logs DB. Started by the combined server (src/server/index.js):
// one pass right after startup and then once a day on a timer. Retention periods come from
// config.llmLog.retention; a value of 0 (or absence) means "keep forever" for that table. Deletion runs in
// batches by primary key so the pass does not hold long locks on a large table. Cleanup failures are logged
// and never affect the application.
import { config } from '../config.js';
import { queryLog } from '../db.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// Batch size for a single DELETE: large enough to finish in a few passes, small enough for short locks.
const DELETE_BATCH = 5000;
export const DELETE_BATCH_SIZE = DELETE_BATCH;

// The database function. Default — the shared queryLog() wrapper; unit tests swap it via
// __setDbQueryForTests to verify batching without a real database.
let dbQuery = queryLog;

// Swap the database function (tests only). Returns the previous implementation so it can be restored.
export function __setDbQueryForTests(fn) {
  const prev = dbQuery;
  dbQuery = fn || queryLog;
  return prev;
}

let timer = null;

// Retention settings with safe defaults: full journals — 90 days, the narrow usage table — forever.
function retentionConfig() {
  const r = config.llmLog?.retention || {};
  const days = (v, dflt) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : dflt);
  return {
    llmRequestDays: days(r.llmRequestDays, 90),
    agentEventDays: days(r.agentEventDays, 90),
    llmUsageDays: days(r.llmUsageDays, 0),
  };
}

// Delete rows of one table older than the cutoff, in batches. Returns the number of deleted rows.
async function purgeTable(table, pk, days) {
  if (!days) {
    return 0; // 0 = keep forever
  }
  let total = 0;
  for (;;) {
    const { rows } = await dbQuery(
      `DELETE FROM ${table}
        WHERE ${pk} IN (
          SELECT ${pk} FROM ${table}
           WHERE created_at < now() - make_interval(days => $1)
           ORDER BY ${pk}
           LIMIT ${DELETE_BATCH}
        )
        RETURNING ${pk}`,
      [days],
    );
    total += rows.length;
    if (rows.length < DELETE_BATCH) {
      break;
    }
  }
  return total;
}

// One full cleanup pass over all journal tables. Exported separately for tests and manual runs.
export async function runLogRetentionOnce() {
  const cfg = retentionConfig();
  const deleted = {
    llmRequest: await purgeTable('log.llm_request', 'llm_request_id', cfg.llmRequestDays),
    agentEvent: await purgeTable('log.agent_event', 'agent_event_id', cfg.agentEventDays),
    llmUsage: await purgeTable('log.llm_usage', 'llm_usage_id', cfg.llmUsageDays),
  };
  const total = deleted.llmRequest + deleted.agentEvent + deleted.llmUsage;
  if (total > 0) {
    console.log(
      `[log-retention] Deleted stale journal rows: llm_request — ${deleted.llmRequest}, agent_event — ${deleted.agentEvent}, llm_usage — ${deleted.llmUsage}.`,
    );
  }
  return deleted;
}

// Start the background cleanup: an immediate pass and then once a day. The timer is unref()-ed so it does
// not keep the process alive. Repeated calls are no-ops.
export function startLogRetention() {
  if (timer) {
    return;
  }
  runLogRetentionOnce().catch((err) => {
    console.warn(`[log-retention] Startup journal cleanup failed: ${String(err.message || err)}`);
  });
  timer = setInterval(() => {
    runLogRetentionOnce().catch((err) => {
      console.warn(`[log-retention] Daily journal cleanup failed: ${String(err.message || err)}`);
    });
  }, DAY_MS);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
}

// Stop the background cleanup (graceful shutdown, tests).
export function stopLogRetention() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
