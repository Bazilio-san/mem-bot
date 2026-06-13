// Aspect suite "dedupe": isolated evaluation of fact deduplication (src/pipeline/facts.js). Two mechanisms
// share one similarity contract and are both covered here:
//   1. write-time dedup in saveFact (findNearestFact + confirm/replace) — the production path: a new fact
//      that means the same as an existing one is merged, a changed value replaces (archives) the old one,
//      genuinely distinct facts stay separate;
//   2. the background sweep dedupeFactsSweep (dry-run) — bulk collapse of accumulated semantic duplicates.
// Dedup is embedding-based (pgvector cosine), so it needs a DB and real embeddings but makes NO judge call.
//
// Each case gets its own throw-away test user (NODE_ENV=test → is_test = true), seeds the facts, asserts,
// and deletes the user (cascade). Case file: tests/eval/dedupe_cases.json. Per-case fields:
//   type               — fact_type for every fact in the case (profile | preference | goal | ...)
//   facts              — fact texts saved in order through saveFact (the write-time dedup path)
//   expect_active      — how many active facts of that type must remain after all saves
//   sweep_expect_pairs — optional: run dedupeFactsSweep(dryRun) afterwards and assert the pair count
//   note               — human description of what the case checks
//
// Deterministic enough to run without --repeat (embeddings are stable for a given text).

import { query } from '../../../src/db.js';
import { ensureUser } from '../../../src/repo.js';
import { saveFact, dedupeFactsSweep } from '../../../src/pipeline/facts.js';
import { loadCases, passRateSummary } from './_lib.js';

export const meta = { name: 'dedupe', type: 'deterministic' };

async function countActive(userId, factType) {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM mem.user_facts WHERE user_id = $1 AND fact_type = $2 AND status = 'active'`,
    [userId, factType],
  );
  return rows[0].n;
}

export async function run({ rootDir, criteria, saveCase, checkBudget }) {
  const cfg = criteria.suites.dedupe;
  const cases = loadCases(rootDir, cfg.cases_file);
  const rows = [];
  let passed = 0;
  for (const tc of cases) {
    const extId = `eval-dedupe-${tc.id}-${Date.now()}`;
    const user = await ensureUser(extId, { displayName: 'Eval Dedupe' });
    const actions = [];
    let active = null;
    let sweep = null;
    try {
      for (const text of tc.facts) {
        const res = await saveFact(user.id, 'general', { type: tc.type, fact_text: text, confidence: 0.9 }, null, {
          source: 'user_statement',
        });
        actions.push({ text, action: res.action, similarity: res.similarity ?? null });
      }
      active = await countActive(user.id, tc.type);
      if (tc.sweep_expect_pairs !== undefined) {
        sweep = await dedupeFactsSweep({ userId: user.id, dryRun: true });
      }
    } finally {
      await query('DELETE FROM mem.users WHERE id = $1', [user.id]);
    }
    const problems = [];
    if (tc.expect_active !== undefined && active !== tc.expect_active) {
      problems.push(`active facts ${active} != expected ${tc.expect_active}`);
    }
    if (tc.sweep_expect_pairs !== undefined && (sweep?.pairs.length ?? -1) !== tc.sweep_expect_pairs) {
      problems.push(`sweep pairs ${sweep?.pairs.length} != expected ${tc.sweep_expect_pairs}`);
    }
    const verdict = problems.length === 0 ? 'pass' : 'fail';
    if (verdict === 'pass') {
      passed += 1;
    }
    rows.push({ id: tc.id, suite: 'dedupe', verdict, note: tc.note });
    saveCase(tc.id, { suite: 'dedupe', case: tc, actions, active, sweep, problems, verdict });
    await checkBudget();
  }
  return { summary: passRateSummary({ cases: cases.length, passed, threshold: cfg.pass_threshold }), rows };
}
