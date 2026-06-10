// Shared buffered batch writer for journal tables in the logs DB. Extracted from llm-log.js so that both
// journals (log.llm_request and log.agent_event) reuse the same machinery: an in-memory buffer with a hard
// cap, a background flush timer that does not keep the process alive, multi-row INSERTs in batches, and
// returning a failed batch to the buffer so records survive a temporary DB outage. Writers never throw:
// journaling must not affect the main flow.
import { queryLog } from '../db.js';

// Hard cap on the buffer size: with the database unavailable it must not grow without bound. Above the cap
// we drop the oldest records with a warning (explicit truncation, no silent loss).
const MAX_BUFFER = 5000;
// Early flush threshold: as soon as this many records have accumulated, we flush without waiting for the timer.
const EARLY_FLUSH_AT = 50;

// Truncate a JSON-serializable value to the size limit: long string values inside are clipped and the
// truncated flag is raised. Returns a JSON string ready for insertion into a jsonb column, and the flag.
export function truncateJson(payload, maxChars) {
  if (payload === null || payload === undefined) {
    return { json: null, truncated: false };
  }
  let serialized;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    return { json: JSON.stringify({ error: 'payload is not serializable' }), truncated: true };
  }
  if (serialized.length <= maxChars) {
    return { json: serialized, truncated: false };
  }
  // Recursively clip long strings (message texts, embedding input) to a reasonable length.
  const perString = 2000;
  const trunc = (v) => {
    if (typeof v === 'string') {
      return v.length > perString ? `${v.slice(0, perString)}…[+${v.length - perString} chars]` : v;
    }
    if (Array.isArray(v)) {
      return v.map(trunc);
    }
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v)) {
        out[k] = trunc(v[k]);
      }
      return out;
    }
    return v;
  };
  let reduced = JSON.stringify(trunc(payload));
  if (reduced.length > maxChars) {
    // Edge case: even after clipping strings the object is large — store a truncated snapshot as a string.
    reduced = JSON.stringify({ _truncated: reduced.slice(0, maxChars) });
  }
  return { json: reduced, truncated: true };
}

// Create a buffered batch writer for one journal table.
// table — full table name ('log.llm_request'); columns — column names in insertion order;
// jsonbColumns — subset of columns cast to ::jsonb; getSettings() → { batchSize, flushIntervalMs }.
// Returns { push, flush, setDbQueryForTests }.
export function createBatchWriter({ table, columns, jsonbColumns = [], getSettings }) {
  const jsonbIndexes = new Set(jsonbColumns.map((c) => columns.indexOf(c)));
  // The database write function. By default the shared queryLog() wrapper (the logs DB); in unit tests it is
  // swapped via setDbQueryForTests to verify buffering and flushing without a real database.
  let dbQuery = queryLog;
  const buffer = [];
  let flushTimer = null;
  let flushing = false;

  // Swap the database write function (tests only). Returns the previous implementation so it can be restored.
  function setDbQueryForTests(fn) {
    const prev = dbQuery;
    dbQuery = fn || queryLog;
    return prev;
  }

  // Start the background flush timer if it isn't running yet. unref() so the timer doesn't keep the process alive.
  function ensureTimer() {
    if (flushTimer) {
      return;
    }
    const { flushIntervalMs } = getSettings();
    flushTimer = setInterval(() => {
      flush().catch(() => {});
    }, flushIntervalMs);
    if (typeof flushTimer.unref === 'function') {
      flushTimer.unref();
    }
  }

  // Perform a single multi-row INSERT for a batch of records.
  async function insertBatch(records) {
    const values = [];
    const tuples = records.map((r) => {
      const placeholders = columns.map((col, i) => {
        values.push(r[col] ?? null);
        const pos = values.length;
        return jsonbIndexes.has(i) ? `$${pos}::jsonb` : `$${pos}`;
      });
      return `(${placeholders.join(',')})`;
    });
    const sql = `INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')}`;
    await dbQuery(sql, values);
  }

  // Put a record into the buffer. Returns control immediately (waits for nothing) and never throws.
  function push(record) {
    try {
      if (!record) {
        return;
      }
      buffer.push(record);
      if (buffer.length > MAX_BUFFER) {
        const dropped = buffer.length - MAX_BUFFER;
        buffer.splice(0, dropped);
        console.warn(`[log-writer:${table}] Buffer overflow: dropped ${dropped} oldest log records.`);
      }
      ensureTimer();
      if (buffer.length >= EARLY_FLUSH_AT) {
        flush().catch(() => {});
      }
    } catch {
      // Journaling must not affect the main flow — we swallow any failures.
    }
  }

  // Force-flush the accumulated records. Takes batches of up to batchSize from the buffer and writes them one
  // by one. On an insertion error it returns the batch's records back to the front of the buffer (respecting
  // the cap) and stops the current pass — the next attempt happens on the timer or on the next call.
  async function flush() {
    if (flushing || buffer.length === 0) {
      return;
    }
    flushing = true;
    const { batchSize } = getSettings();
    try {
      while (buffer.length > 0) {
        const batch = buffer.splice(0, batchSize);
        try {
          await insertBatch(batch);
        } catch (err) {
          // Return the failed batch to the front of the buffer so records aren't lost during a temporary outage.
          buffer.unshift(...batch);
          if (buffer.length > MAX_BUFFER) {
            buffer.splice(MAX_BUFFER);
          }
          console.warn(
            `[log-writer:${table}] Failed to write log (${batch.length} records): ${String(err.message || err)}`,
          );
          break;
        }
      }
    } finally {
      flushing = false;
    }
  }

  return { push, flush, setDbQueryForTests };
}
