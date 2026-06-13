// Aspect suite "topics": isolated evaluation of dialogue topic extraction (src/pipeline/topics.js,
// extractTopics, request_kind topic_extract). Runs ONLY the extractor — no memory, no full pipeline.
// extractTopics is a pure function (a single chatJSON call over a dialog string), so the suite feeds it a
// scripted dialog and checks the returned topic keys and engagement scores against the case expectations.
//
// The model invents specific snake_case keys (running_training, japan_trip_planning), so matching is by
// token, not by an exact key: a case lists acceptable tokens and passes if any returned key contains any of
// them. Engagement is checked on the strongest topic (key-agnostic), which verifies the extractor recognises
// enthusiasm without pinning the exact wording.
//
// Case file: tests/eval/topic_cases.json. Per-case fields:
//   input                    — the recent-dialog string passed to extractTopics({ recentMessages })
//   expect_topics_any        — array of token groups; for each group at least one returned key must contain
//                              one of the group's tokens (the dialog's subject area was identified)
//   expect_top_engagement_min — the highest user_engagement among returned topics must be >= this value
//   expect_empty             — true: the extractor must return no topics (greeting / too-short dialog)
//   note                     — human description of what the case checks
//
// Honours --deterministic (EVAL_TEMPERATURE=0 inside chatJSON); use --repeat for stability without it.

import { extractTopics } from '../../../src/pipeline/topics.js';
import { loadCases, majority, passRateSummary } from './_lib.js';

export const meta = { name: 'topics', type: 'deterministic' };

// At least one returned key contains at least one of the group's tokens (case-insensitive substring).
function anyTokenInKeys(keys, tokens) {
  return tokens.some((tok) => {
    const t = String(tok).toLowerCase();
    return keys.some((k) => k.includes(t));
  });
}

function checkCase(tc, topics) {
  const keys = topics.map((t) => String(t.topic_key || '').toLowerCase()).filter(Boolean);
  const problems = [];
  if (tc.expect_empty && topics.length) {
    problems.push(`expected no topics, got: ${keys.join(', ') || 'none'}`);
  }
  for (const group of tc.expect_topics_any || []) {
    if (!anyTokenInKeys(keys, group)) {
      problems.push(`none of [${group.join(', ')}] found in keys (got: ${keys.join(', ') || 'none'})`);
    }
  }
  if (tc.expect_top_engagement_min !== undefined) {
    const maxEng = topics.reduce((m, t) => Math.max(m, Number(t.user_engagement) || 0), 0);
    if (maxEng < tc.expect_top_engagement_min) {
      problems.push(`top engagement ${maxEng} < ${tc.expect_top_engagement_min}`);
    }
  }
  return problems;
}

export async function run({ rootDir, criteria, repeat, saveCase, checkBudget }) {
  const cfg = criteria.suites.topics;
  const cases = loadCases(rootDir, cfg.cases_file);
  const rows = [];
  let passed = 0;
  for (const tc of cases) {
    const attempts = [];
    for (let r = 0; r < repeat; r += 1) {
      const topics = await extractTopics({ recentMessages: tc.input });
      const problems = checkCase(tc, topics);
      attempts.push({ topics, problems, pass: problems.length === 0 });
    }
    const verdict = majority(attempts);
    if (verdict === 'pass') {
      passed += 1;
    }
    rows.push({ id: tc.id, suite: 'topics', verdict, note: tc.note });
    saveCase(tc.id, { suite: 'topics', case: tc, attempts, verdict });
    await checkBudget();
  }
  return { summary: passRateSummary({ cases: cases.length, passed, threshold: cfg.pass_threshold }), rows };
}
