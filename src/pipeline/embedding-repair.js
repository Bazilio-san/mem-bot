// Background repair of missing knowledge base embeddings. Started by the combined server
// (src/server/index.js): one pass right after startup and then on an interval
// (config.globalMemory.embeddingRepairIntervalMs). A record loses its vector when its text is changed
// without a new embedding in the same UPDATE (the database trigger resets it — including edits made via
// psql or scripts, bypassing the application) or when the embedding service was unavailable at save time.
// This pass finds such active records and computes the vector again. Failures are logged and never affect
// the application.
import { config } from '../config.js';
import { query } from '../db.js';
import { reembedGlobalKnowledge } from './global-memory.js';

// Records repaired per pass: enough for the small knowledge base, bounded so one pass stays short.
const REPAIR_BATCH = 50;

let timer = null;

// One repair pass: find active records without a vector and recompute each. Stops early after the first
// failed computation — the embedding service is most likely down, so the rest would fail too; the next
// pass will pick them up. Exported separately for tests and manual runs.
export async function runEmbeddingRepairOnce() {
  const { rows } = await query(
    `SELECT id FROM mem.global_knowledge
     WHERE embedding IS NULL AND status = 'active'
     ORDER BY updated_at ASC
     LIMIT $1`,
    [REPAIR_BATCH],
  );
  let repaired = 0;
  for (const r of rows) {
    if (!(await reembedGlobalKnowledge(r.id))) {
      break;
    }
    repaired += 1;
  }
  if (repaired > 0) {
    console.log(`[embedding-repair] Пересчитаны эмбеддинги базы знаний: ${repaired} из ${rows.length} записей.`);
  }
  return { pending: rows.length, repaired };
}

// Start the background repair: an immediate pass and then on an interval. Does nothing when the RAG layer
// or the repair itself is disabled in the config. The timer is unref()-ed so it does not keep the process
// alive. Repeated calls are no-ops.
export function startEmbeddingRepair() {
  if (timer || !config.globalMemory.ragEnabled || !config.globalMemory.embeddingRepairEnabled) {
    return;
  }
  const intervalMs = Math.max(60_000, Number(config.globalMemory.embeddingRepairIntervalMs) || 600_000);
  runEmbeddingRepairOnce().catch((err) => {
    console.warn(`[embedding-repair] Стартовый проход не удался: ${String(err.message || err)}`);
  });
  timer = setInterval(() => {
    runEmbeddingRepairOnce().catch((err) => {
      console.warn(`[embedding-repair] Очередной проход не удался: ${String(err.message || err)}`);
    });
  }, intervalMs);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
}

// Stop the background repair (graceful shutdown, tests).
export function stopEmbeddingRepair() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
