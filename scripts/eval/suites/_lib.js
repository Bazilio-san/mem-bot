// Shared helpers for the isolated aspect suites (scripts/eval/suites/*.js). Each aspect suite exercises
// ONE pipeline stage in isolation (intent is in eval.js, the rest live here) and reports the same
// deterministic shape so eval.js, summary.json and eval-compare.js treat them uniformly.
// See claudedocs/2026-06-13_00-44-self-tuning-infrastructure.md §5.

import fs from 'node:fs';
import path from 'node:path';

// Load a suite's reference cases (path is relative to repo root, taken from criteria.yaml).
export function loadCases(rootDir, relFile) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, relFile), 'utf8'));
}

// Majority verdict over repeated attempts: pass when at least half of the attempts passed. Same rule the
// classify and facts suites use in eval.js, so repeats are interpreted identically across all suites.
export function majority(attempts) {
  const ok = attempts.filter((a) => a.pass).length;
  return ok * 2 >= attempts.length ? 'pass' : 'fail';
}

// Standard deterministic-suite aggregate, identical in shape to the classify/facts blocks in eval.js.
export function passRateSummary({ type = 'deterministic', cases, passed, threshold }) {
  return {
    type,
    cases,
    passed,
    pass_rate: Number((passed / cases).toFixed(3)),
    threshold,
    pass: passed / cases >= threshold,
  };
}
