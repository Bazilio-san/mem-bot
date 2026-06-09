// Быстрый подсчёт затрат на LLM поверх узкого журнала log.llm_usage. Эти функции готовят почву для будущего
// интерфейса (он в рамках текущей задачи не реализуется): суммарная стоимость за период, разбивка по типам
// запросов и затраты на отдельный ход диалога. Все запросы идут через общую обёртку query() из src/db.js.
import { query } from '../db.js';

// Собрать условие WHERE и параметры из набора фильтров. Возвращает { clause, params } для подстановки в запрос.
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

// Суммарные токены и стоимость с фильтрами по периоду, пользователю, типу запроса и модели.
// Возвращает { tokens, priceUsd } — суммы по total_tokens и price_usd (пропущенные значения считаются нулём).
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

// Затраты с группировкой по типу запроса (request_kind) — для интерфейса, где разные виды запросов показываются
// отдельно. Возвращает массив { requestKind, tokens, priceUsd }, отсортированный по убыванию стоимости.
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

// Затраты на один ход диалога по его requestId. Узкий журнал не хранит request_id, поэтому соединяем его с
// полным журналом log.llm_request по llm_request_id. Возвращает { tokens, priceUsd }.
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
