// Eval runner of the tuning loop: runs the reference suites against the CURRENT code and prompts and
// stores layered results under claudedocs/experiments/. The /tune-bot skill holds the methodology.
//
// Run:
//   node scripts/eval.js --suite classify                 # one suite
//   node scripts/eval.js --suite all --repeat 3           # everything, with repeats (median/majority)
//   node scripts/eval.js --suite dialog --scenario facts-and-recall
//   node scripts/eval.js --suite all --label baseline-2026-06-13
//
// Flags:
//   --suite <name>     classify | facts | dialog | all (default all)
//   --repeat N         repeats per case; deterministic cases pass by majority, judge scores take the median
//   --scenario <name>  limit the dialog suite to one scenario
//   --label <str>      experiment label; output dir becomes claudedocs/experiments/<date>-<label>/
//   --deterministic    set EVAL_TEMPERATURE=0 for structured service calls (classifier, extraction).
//                      Opt-in: some providers/models reject a non-default temperature.
//   --judge-model <m>  override the judge model (default config.llm.mainModel)
//
// Output layers:
//   stdout            — aggregates + the list of FAILED cases only (this is what lands in the caller's context)
//   summary.json      — aggregates and one row per case, WITHOUT content
//   cases/<id>.json   — full details of one case (input, actual outputs, judge reasoning, request ids)
//
// Thresholds, axes, weights and the cost stop-limit come ONLY from tests/eval/criteria.yaml.
// The run stops once its LLM cost exceeds budget.eval_run_max_usd.

process.env.NODE_ENV = 'test';

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = { suite: 'all', repeat: 1, scenario: null, label: null, deterministic: false, judgeModel: null };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--suite') {
      args.suite = argv[++i];
    } else if (token === '--repeat') {
      args.repeat = Math.max(1, Number(argv[++i]) || 1);
    } else if (token === '--scenario') {
      args.scenario = argv[++i];
    } else if (token === '--label') {
      args.label = argv[++i];
    } else if (token === '--deterministic') {
      args.deterministic = true;
    } else if (token === '--judge-model') {
      args.judgeModel = argv[++i];
    } else {
      console.error(`Unknown flag: ${token}`);
      process.exit(2);
    }
  }
  return args;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values, p) {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function gitBranch() {
  const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: rootDir, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.deterministic) {
    process.env.EVAL_TEMPERATURE = '0';
  }
  // Dynamic imports keep NODE_ENV=test (and EVAL_TEMPERATURE) in effect before src modules read them.
  const { config } = await import('../src/config.js');
  const { queryLog } = await import('../src/db.js');
  const { flushLlmLog } = await import('../src/pipeline/llm-log.js');
  const { getBotBuildInfo } = await import('../src/build-metadata.js');
  const { classifyIntent } = await import('../src/pipeline/classify.js');
  const { extractFacts } = await import('../src/pipeline/facts.js');
  const { loadCriteria, judgeDialog } = await import('./eval/judge.js');
  const { runScenario, loadScenario, checkExpectations } = await import('./lib/scenario-runner.js');
  // Isolated aspect suites — each exercises ONE pipeline stage on its own. Imported dynamically (like the
  // src modules above) so NODE_ENV=test and EVAL_TEMPERATURE are already in effect. Adding a new aspect =
  // a new module here plus its block in tests/eval/criteria.yaml; see scripts/eval/suites/_lib.js.
  const aspectSuites = {
    topics: await import('./eval/suites/topics.js'),
    compress: await import('./eval/suites/compress.js'),
    dedupe: await import('./eval/suites/dedupe.js'),
    tools: await import('./eval/suites/tools.js'),
  };

  const criteria = loadCriteria(rootDir);
  const runStartIso = new Date().toISOString();
  const startedAt = Date.now();
  const date = runStartIso.slice(0, 10);
  const label = args.label || `eval-${runStartIso.slice(11, 19).replaceAll(':', '')}`;
  let outDir = path.join(rootDir, 'claudedocs', 'experiments', `${date}-${label}`);
  if (fs.existsSync(outDir)) {
    outDir = `${outDir}-${runStartIso.slice(11, 19).replaceAll(':', '')}`;
  }
  fs.mkdirSync(path.join(outDir, 'cases'), { recursive: true });

  const caseRows = [];
  const suites = {};
  let stoppedByBudget = false;

  // Cost of THIS run so far, from the log DB (every harness LLM call is logged with is_test = true).
  async function runCostUsd() {
    await flushLlmLog();
    const { rows } = await queryLog(
      `SELECT coalesce(sum(price_usd), 0) AS usd FROM log.llm_request WHERE is_test AND created_at >= $1`,
      [runStartIso],
    );
    return Number(rows[0].usd);
  }

  // Budget guard: throws once the run cost exceeds the stop-limit from the criteria file.
  async function checkBudget() {
    const spent = await runCostUsd();
    if (spent > Number(criteria.budget?.eval_run_max_usd ?? Infinity)) {
      stoppedByBudget = true;
      throw new Error(`Eval budget exceeded: $${spent.toFixed(4)} > $${criteria.budget.eval_run_max_usd}`);
    }
  }

  function saveCase(id, detail) {
    fs.writeFileSync(path.join(outDir, 'cases', `${id}.json`), JSON.stringify(detail, null, 2));
  }

  const wantSuite = (name) => args.suite === 'all' || args.suite === name;

  // The whole suite block runs under the budget guard: on overrun the partial results collected so far
  // still reach summary.json, only the remaining cases are skipped.
  try {
    // ---- Suite: classify (deterministic) -------------------------------------------------------------
    if (wantSuite('classify')) {
      const cfg = criteria.suites.classify;
      const cases = JSON.parse(fs.readFileSync(path.join(rootDir, cfg.cases_file), 'utf8'));
      let passed = 0;
      for (const tc of cases) {
        const attempts = [];
        for (let r = 0; r < args.repeat; r += 1) {
          const res = await classifyIntent({
            userMessage: tc.input,
            currentDomainKey: tc.current_domain || 'general',
            recentMessages: tc.recent || [],
            dialogState: null,
          });
          const problems = [];
          if (tc.expect_skill && res.skill_name !== tc.expect_skill) {
            problems.push(`skill ${res.skill_name} != ${tc.expect_skill}`);
          }
          if (tc.expect_needs_memory !== undefined && res.needs_memory !== tc.expect_needs_memory) {
            problems.push(`needs_memory ${res.needs_memory} != ${tc.expect_needs_memory}`);
          }
          for (const scope of tc.expect_scopes_include || []) {
            if (!(res.needed_memory_scopes || []).includes(scope)) {
              problems.push(`scope "${scope}" missing`);
            }
          }
          attempts.push({ result: res, problems, pass: problems.length === 0 });
        }
        const okCount = attempts.filter((a) => a.pass).length;
        const verdict = okCount * 2 >= attempts.length ? 'pass' : 'fail';
        if (verdict === 'pass') {
          passed += 1;
        }
        caseRows.push({ id: tc.id, suite: 'classify', verdict, note: tc.note });
        saveCase(tc.id, { suite: 'classify', case: tc, attempts, verdict });
        await checkBudget();
      }
      suites.classify = {
        type: 'deterministic',
        cases: cases.length,
        passed,
        pass_rate: Number((passed / cases.length).toFixed(3)),
        threshold: cfg.pass_threshold,
        pass: passed / cases.length >= cfg.pass_threshold,
      };
    }

    // ---- Suite: facts (deterministic, the canonical tests/memory_cases.json set) ---------------------
    if (wantSuite('facts')) {
      const cfg = criteria.suites.facts;
      const cases = JSON.parse(fs.readFileSync(path.join(rootDir, cfg.cases_file), 'utf8'));
      let passed = 0;
      for (let i = 0; i < cases.length; i += 1) {
        const tc = cases[i];
        const id = `f${String(i + 1).padStart(2, '0')}`;
        const attempts = [];
        for (let r = 0; r < args.repeat; r += 1) {
          const facts = await extractFacts({
            domainKey: 'general',
            userMessages: [tc.input],
            assistantSummary: 'Короткий ответ ассистента по теме разговора.',
          });
          const savable = facts.filter((f) => Number(f.confidence) >= config.facts.minConfidence);
          // Same verdict logic as tests/run.js layerExtraction: sensitive data must be skipped entirely.
          const pass = tc.expect_requires_confirmation || !tc.expect_save ? savable.length === 0 : savable.length >= 1;
          attempts.push({ facts, savable: savable.length, pass });
        }
        const okCount = attempts.filter((a) => a.pass).length;
        const verdict = okCount * 2 >= attempts.length ? 'pass' : 'fail';
        if (verdict === 'pass') {
          passed += 1;
        }
        caseRows.push({ id, suite: 'facts', verdict, note: tc.note });
        saveCase(id, { suite: 'facts', case: tc, attempts, verdict });
        await checkBudget();
      }
      suites.facts = {
        type: 'deterministic',
        cases: cases.length,
        passed,
        pass_rate: Number((passed / cases.length).toFixed(3)),
        threshold: cfg.pass_threshold,
        pass: passed / cases.length >= cfg.pass_threshold,
      };
    }

    // ---- Suite: dialog (scenarios + deterministic mention checks + LLM judge) ------------------------
    if (wantSuite('dialog')) {
      const cfg = criteria.suites.dialog;
      const dir = path.join(rootDir, cfg.scenarios_dir);
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort();
      const axisNames = Object.keys(cfg.axes);
      const axisScores = Object.fromEntries(axisNames.map((a) => [a, []]));
      const turnLatencies = [];
      const turnPrices = [];
      let deterministicPassed = 0;
      let scenarioCount = 0;
      for (const file of files) {
        const scenario = loadScenario(path.join(dir, file));
        if (args.scenario && scenario.name !== args.scenario) {
          continue;
        }
        scenarioCount += 1;
        const id = `d-${scenario.name}`;
        const transcript = await runScenario(scenario);
        const checks = checkExpectations(scenario, transcript);
        const judgements = [];
        for (let r = 0; r < args.repeat; r += 1) {
          judgements.push(await judgeDialog({ rootDir, criteria, scenario, transcript, model: args.judgeModel }));
        }
        const scores = {};
        for (const axis of axisNames) {
          scores[axis] = median(judgements.map((j) => j.axes[axis].score));
          axisScores[axis].push(scores[axis]);
        }
        const weighted = Number(median(judgements.map((j) => j.weighted_score)).toFixed(3));
        for (const t of transcript.turns.filter((x) => x.type === 'user')) {
          turnLatencies.push(t.durationMs);
          turnPrices.push(t.priceUsd);
        }
        if (checks.pass) {
          deterministicPassed += 1;
        }
        caseRows.push({
          id,
          suite: 'dialog',
          verdict: checks.pass ? 'pass' : 'fail',
          scores,
          weighted_score: weighted,
          price_usd: transcript.totals.priceUsd,
        });
        saveCase(id, { suite: 'dialog', scenario, transcript, deterministic: checks, judgements, scores, weighted });
        await checkBudget();
      }
      const axesAvg = Object.fromEntries(
        axisNames.map((a) => [
          a,
          axisScores[a].length
            ? Number((axisScores[a].reduce((s, v) => s + v, 0) / axisScores[a].length).toFixed(3))
            : null,
        ]),
      );
      suites.dialog = {
        type: 'judge',
        scenarios: scenarioCount,
        deterministic_passed: deterministicPassed,
        axes_avg: axesAvg,
        axes_min_avg: Object.fromEntries(axisNames.map((a) => [a, cfg.axes[a].min_avg])),
        judge_pass: axisNames.every((a) => axesAvg[a] == null || axesAvg[a] >= cfg.axes[a].min_avg),
        avg_turn_price_usd: turnPrices.length
          ? Number((turnPrices.reduce((s, v) => s + v, 0) / turnPrices.length).toFixed(6))
          : null,
        latency_p95_ms: percentile(turnLatencies, 95),
        pass:
          deterministicPassed === scenarioCount &&
          axisNames.every((a) => axesAvg[a] == null || axesAvg[a] >= cfg.axes[a].min_avg),
      };
    }

    // ---- Isolated aspect suites: topics, compress, dedupe, tools -------------------------------------
    // Each runs ONE pipeline stage on its own and returns the standard deterministic shape, so summary.json
    // and eval-compare.js treat them exactly like classify/facts. Selected by --suite <name> or --suite all.
    for (const [name, mod] of Object.entries(aspectSuites)) {
      if (!wantSuite(name)) {
        continue;
      }
      if (!criteria.suites[name]) {
        console.error(`No criteria for suite "${name}" in tests/eval/criteria.yaml — skipped.`);
        continue;
      }
      const { summary: suiteSummary, rows } = await mod.run({
        rootDir,
        criteria,
        repeat: args.repeat,
        deterministic: args.deterministic,
        saveCase,
        checkBudget,
      });
      suites[name] = suiteSummary;
      caseRows.push(...rows);
    }
  } catch (err) {
    if (!stoppedByBudget) {
      throw err;
    }
    console.error(err.message);
  }

  // ---- Summary --------------------------------------------------------------------------------------
  const totalPriceUsd = await runCostUsd();
  const build = getBotBuildInfo();
  const summary = {
    label,
    created_at: runStartIso,
    duration_ms: Date.now() - startedAt,
    stopped_by_budget: stoppedByBudget,
    criteria_version: criteria.version,
    repeat: args.repeat,
    deterministic_mode: args.deterministic,
    meta: {
      git_commit: build.shortCommit,
      git_branch: gitBranch(),
      models: {
        main: config.llm.mainModel,
        aux: config.llm.auxModel,
        extract: config.llm.extractModel,
        judge: args.judgeModel || config.llm.mainModel,
      },
    },
    totals: { price_usd: Number(totalPriceUsd.toFixed(6)) },
    suites,
    cases: caseRows,
  };
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));

  // stdout: aggregates and failed cases only — this is all that lands in the caller's context.
  console.log(
    `\nEval run "${label}" — commit ${build.shortCommit}, criteria v${criteria.version}, $${totalPriceUsd.toFixed(4)}.`,
  );
  for (const [name, s] of Object.entries(suites)) {
    if (s.type === 'deterministic') {
      console.log(
        `  ${name}: ${s.passed}/${s.cases} (${(s.pass_rate * 100).toFixed(0)}%, threshold ${(s.threshold * 100).toFixed(0)}%) — ${s.pass ? 'PASS' : 'FAIL'}`,
      );
    } else {
      const axes = Object.entries(s.axes_avg)
        .map(([a, v]) => `${a} ${v}`)
        .join(', ');
      console.log(
        `  ${name}: scenarios ${s.scenarios}, deterministic ${s.deterministic_passed}/${s.scenarios}, axes: ${axes} — ${s.pass ? 'PASS' : 'FAIL'}`,
      );
    }
  }
  const failedCases = caseRows.filter((c) => c.verdict !== 'pass');
  if (failedCases.length) {
    console.log(`  Failed cases: ${failedCases.map((c) => c.id).join(', ')}`);
  }
  console.log(`  Results: ${path.relative(rootDir, outDir)} (summary.json, cases/<id>.json)`);
  console.log(`  Cleanup of test users: node scripts/delete-user.js --test-users --yes`);
}

main()
  .catch((err) => {
    console.error('Eval run error:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    const { closePool } = await import('../src/db.js');
    await closePool();
  });
