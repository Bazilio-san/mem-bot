// CLI wrapper around the scenario runner (scripts/lib/scenario-runner.js): replays a scripted dialog
// through the full pipeline without Telegram. See claudedocs/self-tuning-infrastructure.md §4.
//
// Run:
//   node scripts/run-scenario.js tests/scenarios/facts-and-recall.json
//   node scripts/run-scenario.js tests/scenarios/facts-and-recall.json --keep-user
//   node scripts/run-scenario.js tests/scenarios/facts-and-recall.json --out claudedocs/experiments/my-run
//
// Flags:
//   --keep-user   keep the test user after the run for manual follow-up (delete later with
//                 `node scripts/delete-user.js --test-users --yes`)
//   --out <dir>   artifacts directory; default claudedocs/experiments/<date>-scenario-<name>/
//
// NODE_ENV is forced to 'test' BEFORE any src module loads: the created user and all log records get
// is_test = true, so the run never touches production data.

process.env.NODE_ENV = 'test';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

async function main() {
  const argv = process.argv.slice(2);
  const file = argv.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('Usage: node scripts/run-scenario.js <scenario.json> [--keep-user] [--out <dir>]');
    process.exit(2);
  }
  const keepUser = argv.includes('--keep-user');
  const outIdx = argv.indexOf('--out');
  // Dynamic imports keep NODE_ENV=test in effect before src modules read it.
  const { runScenario, loadScenario, writeScenarioArtifacts, checkExpectations } =
    await import('./lib/scenario-runner.js');
  const scenario = loadScenario(path.resolve(rootDir, file));
  const date = new Date().toISOString().slice(0, 10);
  const outDir =
    outIdx >= 0
      ? path.resolve(rootDir, argv[outIdx + 1])
      : path.join(rootDir, 'claudedocs', 'experiments', `${date}-scenario-${scenario.name}`);

  const transcript = await runScenario(scenario, { keepUser });
  writeScenarioArtifacts(outDir, transcript);

  const checks = checkExpectations(scenario, transcript);
  console.log(
    `Scenario "${scenario.name}": ${transcript.totals.turns} turns, ${transcript.totals.llmCalls} LLM calls, ${transcript.totals.tokens} tokens, $${transcript.totals.priceUsd}.`,
  );
  if (scenario.expect) {
    console.log(`Deterministic checks: ${checks.pass ? 'PASS' : 'FAIL'}`);
    if (checks.missingMentions.length) {
      console.log(`  missing mentions: ${checks.missingMentions.join(' | ')}`);
    }
    if (checks.forbiddenHits.length) {
      console.log(`  forbidden fragments present: ${checks.forbiddenHits.join(' | ')}`);
    }
  }
  console.log(`Artifacts: ${path.relative(rootDir, outDir)} (transcript.summary.md, transcript.full.json)`);
}

main()
  .catch((err) => {
    console.error('Scenario run error:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    const { closePool } = await import('../src/db.js');
    await closePool();
  });
