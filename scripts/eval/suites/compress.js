// Aspect suite "compress": isolated evaluation of history compression / summarization
// (src/pipeline/history-compress.js, summarizeColdHistory, request_kind history_compress). Runs ONLY the
// summarizer — no DB, no full pipeline. summarizeColdHistory takes its inputs directly (a cold-zone message
// array plus an active-memory snapshot) and makes a single LLM call, so the suite feeds it a scripted cold
// conversation and checks the resulting digest, extracted facts and secret redaction.
//
// Case file: tests/eval/compress_cases.json. Per-case fields:
//   domain                 — domain key (default general)
//   memory                 — array of active-memory texts already in long-term memory (may be empty)
//   cold                   — the cold-zone messages: [{ role, content }, ...] in ascending time order
//   expect_mentions        — every string must appear in summaryText (case-insensitive): key context kept
//   expect_absent          — no string may appear in summaryText: secret-redaction / no-leak checks
//   expect_facts_include   — every string must be a substring of some factsToMemory[].fact_text
//   expect_dropped_include — every string must appear in droppedBecauseInMemory (dedup against memory)
//   note                   — human description of what the case checks
//
// Honours --deterministic (EVAL_TEMPERATURE=0 inside chatJSON); use --repeat for stability without it.

import { config } from '../../../src/config.js';
import { summarizeColdHistory } from '../../../src/pipeline/history-compress.js';
import { loadCases, majority, passRateSummary } from './_lib.js';

export const meta = { name: 'compress', type: 'deterministic' };

// Active-memory snapshot in the shape summarizeColdHistory reads (only the texts matter for the suite).
function buildMemory(memTexts) {
  return { profile: (memTexts || []).map((t) => ({ memory_text: t })), dialog: [], domain: [], secure: [] };
}

function checkCase(tc, result) {
  if (!result) {
    return ['summarizer returned null (the model produced invalid JSON)'];
  }
  const summary = String(result.summaryText || '').toLowerCase();
  const factTexts = (result.factsToMemory || []).map((f) => String(f.fact_text || '').toLowerCase());
  const dropped = (result.droppedBecauseInMemory || []).map((s) => String(s).toLowerCase());
  const problems = [];
  for (const m of tc.expect_mentions || []) {
    if (!summary.includes(String(m).toLowerCase())) {
      problems.push(`mention "${m}" missing from the digest`);
    }
  }
  for (const a of tc.expect_absent || []) {
    if (summary.includes(String(a).toLowerCase())) {
      problems.push(`forbidden "${a}" present in the digest (leak / not redacted)`);
    }
  }
  for (const f of tc.expect_facts_include || []) {
    if (!factTexts.some((t) => t.includes(String(f).toLowerCase()))) {
      problems.push(`fact "${f}" not extracted to factsToMemory`);
    }
  }
  for (const d of tc.expect_dropped_include || []) {
    if (!dropped.some((t) => t.includes(String(d).toLowerCase()))) {
      problems.push(`"${d}" not listed in droppedBecauseInMemory`);
    }
  }
  return problems;
}

export async function run({ rootDir, criteria, repeat, saveCase, checkBudget }) {
  const cfg = criteria.suites.compress;
  const cases = loadCases(rootDir, cfg.cases_file);
  const rows = [];
  let passed = 0;
  for (const tc of cases) {
    const attempts = [];
    for (let r = 0; r < repeat; r += 1) {
      const result = await summarizeColdHistory({
        activeSummary: null,
        coldPending: tc.cold,
        memory: buildMemory(tc.memory),
        targetTokens: config.historyCompression.shrinkTokens,
        zoneWeights: config.historyCompression.zoneWeights,
        domainKey: tc.domain || 'general',
      });
      const problems = checkCase(tc, result);
      attempts.push({ result, problems, pass: problems.length === 0 });
    }
    const verdict = majority(attempts);
    if (verdict === 'pass') {
      passed += 1;
    }
    rows.push({ id: tc.id, suite: 'compress', verdict, note: tc.note });
    saveCase(tc.id, { suite: 'compress', case: tc, attempts, verdict });
    await checkBudget();
  }
  return { summary: passRateSummary({ cases: cases.length, passed, threshold: cfg.pass_threshold }), rows };
}
