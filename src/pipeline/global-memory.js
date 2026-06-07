// Слой глобальной памяти: всегда-включённые глобальные факты и общая база знаний (RAG).
// В отличие от личной памяти (привязанной к пользователю), эти записи видны всем. Наполнять и чистить
// их может только администратор — проверка прав делается в вызывающем слое (инструменты агента, команды CLI).
// Глобальные факты подмешиваются в каждый запрос; фрагменты базы знаний — только релевантные текущему запросу.
// Подробности — в docs/ai-bot-with-memory/14-global-memory.md.
import { query, vectorToSql } from '../db.js';
import { embed } from '../llm.js';
import { getDomainId } from '../repo.js';
import { config } from '../config.js';

// ===================== Глобальные факты (always-on) ==========================

// Действующие сейчас факты: включённые и относящиеся либо к текущему домену, либо общие (domain_id IS NULL).
// Сортируются по приоритету (меньше число — важнее), обрезаются под жёсткий лимит минимизации.
export async function getActiveGlobalFacts({ domainKey, limit = config.globalMemory.factsLimit }) {
  const domainId = domainKey ? await getDomainId(domainKey) : null;
  const { rows } = await query(
    `SELECT id, fact_text, priority, domain_id
     FROM mem.global_facts
     WHERE enabled = true AND (domain_id = $1 OR domain_id IS NULL)
     ORDER BY priority ASC, created_at ASC
     LIMIT $2`,
    [domainId, limit],
  );
  return rows;
}

// Перечислить все факты (для админ-команд: показать идентификаторы, чтобы было что удалять).
export async function listGlobalFacts({ includeDisabled = true } = {}) {
  const { rows } = await query(
    `SELECT id, fact_text, priority, enabled, domain_id
     FROM mem.global_facts
     WHERE ($1 OR enabled = true)
     ORDER BY enabled DESC, priority ASC, created_at ASC`,
    [includeDisabled],
  );
  return rows;
}

// Добавить глобальный факт. По умолчанию факт общий для всех доменов (domain_id = NULL);
// если передан domainKey — факт привязывается к этому домену.
export async function addGlobalFact({ factText, domainKey = null, priority = 100, createdBy = null }) {
  const domainId = domainKey ? await getDomainId(domainKey) : null;
  const { rows } = await query(
    `INSERT INTO mem.global_facts (domain_id, fact_text, priority, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id, fact_text, priority`,
    [domainId, factText, priority, createdBy],
  );
  return rows[0];
}

// Удалить глобальный факт по идентификатору (физически). Возвращает true, если запись была.
export async function deleteGlobalFact(id) {
  const { rowCount } = await query('DELETE FROM mem.global_facts WHERE id = $1', [id]);
  return rowCount > 0;
}

// Включить или выключить факт без удаления.
export async function setGlobalFactEnabled(id, enabled) {
  const { rowCount } = await query(
    'UPDATE mem.global_facts SET enabled = $2, updated_at = now() WHERE id = $1',
    [id, enabled],
  );
  return rowCount > 0;
}

// Справочный блок GLOBAL_FACTS для промпта. Возвращает пустую строку, если слой выключен флагом
// или подходящих фактов нет. Источник доверенный (только администратор), поэтому факты подаются как
// авторитетные общие сведения и политика — без обёртки «это недоверенная справка».
export async function buildGlobalFactsBlock(domainKey) {
  if (!config.globalMemory.factsEnabled) return '';
  const facts = await getActiveGlobalFacts({ domainKey });
  if (!facts.length) return '';
  const lines = facts.map((f) => `- ${f.fact_text}`).join('\n');
  return `GLOBAL_FACTS (общие сведения и политика для всех пользователей)\n\n${lines}`;
}

// ===================== Общая база знаний (RAG) ===============================

// Поиск по базе знаний: смысловая близость через эмбеддинги (если доступны) либо полнотекст как запасной
// сигнал. Учитывает домен (текущий или общий) и отсекает слабые совпадения порогом релевантности, чтобы в
// контекст не попадали посторонние фрагменты.
export async function searchGlobalKnowledge({
  domainKey, query: userQuery, limit = config.globalMemory.ragLimit,
  minRelevance = config.globalMemory.ragMinRelevance,
}) {
  const domainId = domainKey ? await getDomainId(domainKey) : null;
  const vec = await embed(userQuery);

  if (vec) {
    const { rows } = await query(
      `SELECT id, title, content, 1 - (embedding <=> $2::vector) AS relevance
       FROM mem.global_knowledge
       WHERE status = 'active' AND embedding IS NOT NULL
         AND (domain_id = $1 OR domain_id IS NULL)
       ORDER BY embedding <=> $2::vector
       LIMIT $3`,
      [domainId, vectorToSql(vec), limit],
    );
    const strong = rows.filter((r) => Number(r.relevance) >= minRelevance);
    if (strong.length) return strong;
    // Если по смыслу ничего сильного не нашлось — пробуем полнотекст ниже.
  }

  const { rows } = await query(
    `SELECT id, title, content, LEAST(ts_rank(search_tsv, plainto_tsquery('simple', $2)) * 4, 1) AS relevance
     FROM mem.global_knowledge
     WHERE status = 'active' AND (domain_id = $1 OR domain_id IS NULL)
       AND search_tsv @@ plainto_tsquery('simple', $2)
     ORDER BY relevance DESC
     LIMIT $3`,
    [domainId, userQuery, limit],
  );
  return rows.filter((r) => Number(r.relevance) >= minRelevance);
}

// Добавить текст в общую базу знаний. Считает эмбеддинг (если сервис доступен); при недоступности запись
// всё равно создаётся и остаётся найденной полнотекстовым поиском.
export async function addGlobalKnowledge({
  title = null, content, domainKey = null, tags = [], importance = 0.5, source = null, createdBy = null,
}) {
  const domainId = domainKey ? await getDomainId(domainKey) : null;
  const vec = await embed([title, content].filter(Boolean).join('. '));
  const { rows } = await query(
    `INSERT INTO mem.global_knowledge (domain_id, title, content, tags, importance, source, created_by, embedding)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, title, content`,
    [domainId, title, content, tags, importance, source, createdBy, vec ? vectorToSql(vec) : null],
  );
  return rows[0];
}

// Удалить текст базы знаний по идентификатору (мягко: status = 'deleted', чтобы остался след).
export async function deleteGlobalKnowledge(id) {
  const { rowCount } = await query(
    `UPDATE mem.global_knowledge SET status = 'deleted', updated_at = now()
     WHERE id = $1 AND status = 'active'`,
    [id],
  );
  return rowCount > 0;
}

// Справочный блок GLOBAL_KNOWLEDGE для промпта. Возвращает пустую строку, если RAG выключен флагом или
// релевантных фрагментов нет (чтобы не добавлять пустой блок и не делать лишних запросов к эмбеддингам).
export async function buildGlobalKnowledgeBlock(domainKey, userQuery) {
  if (!config.globalMemory.ragEnabled) return '';
  const hits = await searchGlobalKnowledge({ domainKey, query: userQuery });
  if (!hits.length) return '';
  const lines = hits.map((h) => `- ${h.title ? h.title + ': ' : ''}${h.content}`).join('\n');
  return `GLOBAL_KNOWLEDGE (релевантные фрагменты общей базы знаний)\n\n${lines}`;
}
