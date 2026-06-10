// Fast LLM cost accounting on top of the narrow log.llm_usage table. These functions lay the groundwork for a
// future interface (not implemented within the current task): total cost over a period, a breakdown by request
// kind, and the cost of a single dialog turn. All queries go through the shared query() wrapper from src/db.js.
import { query } from '../db.js';

// Build the WHERE clause and parameters from a set of filters. Returns { clause, params } to splice into a query.
function buildFilters({ from, to, userId, kind, model }, startIndex = 1) {
  const conditions = [];
  const params = [];
  let i = startIndex;
  if (from) {
    conditions.push(`created_at >= $${i++}`);
    params.push(from);
  }
  if (to) {
    conditions.push(`created_at < $${i++}`);
    params.push(to);
  }
  if (userId) {
    conditions.push(`user_id = $${i++}`);
    params.push(String(userId));
  }
  if (kind) {
    conditions.push(`request_kind = $${i++}`);
    params.push(kind);
  }
  if (model) {
    conditions.push(`model = $${i++}`);
    params.push(model);
  }
  const clause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return { clause, params };
}

// Total tokens and cost with filters by period, user, request kind and model.
// Returns { tokens, priceUsd } — sums over total_tokens and price_usd (missing values are treated as zero).
export async function getCost({ from, to, userId, kind, model } = {}) {
  const { clause, params } = buildFilters({ from, to, userId, kind, model });
  const { rows } = await query(
    `SELECT COALESCE(SUM(total_tokens), 0)::bigint AS tokens,
            COALESCE(SUM(price_usd), 0)::numeric AS price_usd
       FROM log.llm_usage ${clause}`,
    params,
  );
  return { tokens: Number(rows[0].tokens), priceUsd: Number(rows[0].price_usd) };
}

// Costs grouped by request kind (request_kind) — for an interface where different request kinds are shown
// separately. Returns an array of { requestKind, tokens, priceUsd }, sorted by descending cost.
export async function getCostByKind({ from, to } = {}) {
  const { clause, params } = buildFilters({ from, to });
  const { rows } = await query(
    `SELECT request_kind,
            COALESCE(SUM(total_tokens), 0)::bigint AS tokens,
            COALESCE(SUM(price_usd), 0)::numeric AS price_usd
       FROM log.llm_usage ${clause}
      GROUP BY request_kind
      ORDER BY price_usd DESC NULLS LAST`,
    params,
  );
  return rows.map((r) => ({ requestKind: r.request_kind, tokens: Number(r.tokens), priceUsd: Number(r.price_usd) }));
}

// Cost of a single dialog turn by its requestId. The narrow table doesn't store request_id, so we join it with
// the full log.llm_request table on llm_request_id. Returns { tokens, priceUsd }.
export async function getDialogCost(requestId) {
  const { rows } = await query(
    `SELECT COALESCE(SUM(u.total_tokens), 0)::bigint AS tokens,
            COALESCE(SUM(u.price_usd), 0)::numeric AS price_usd
       FROM log.llm_usage u
       JOIN log.llm_request r ON r.llm_request_id = u.llm_request_id
      WHERE r.request_id = $1`,
    [requestId],
  );
  return { tokens: Number(rows[0].tokens), priceUsd: Number(rows[0].price_usd) };
}
