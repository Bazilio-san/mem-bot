---
name: tune-bot
description: >-
  Run one measured iteration of the bot tuning loop: baseline evals → hypothesis from LLM-log observations →
  change in a tuning/ branch → lint+tests → evals → was/became comparison → experiment report for a human
  decision. Use when asked to improve a prompt or pipeline code, reduce LLM cost or latency, investigate a
  quality regression, take a baseline, or run evals — e.g. "улучши промпт классификатора", "сними baseline",
  "прогони оценки", "разберись с регрессией", "снизь цену цикла".
---

# Bot tuning loop

This skill is the complete, self-contained methodology for one tuning iteration: everything needed lives here
and in the files it points to (`tests/eval/criteria.yaml`, the suites, the LLM log) — no external design note is
required. Every run below is forced to `NODE_ENV=test` by the scripts themselves: test users and `is_test` log
records only, production data is never touched.

## 0. Resume protocol — ALWAYS first

Before anything else check whether the task continues an existing experiment:

```bash
ls claudedocs/experiments/
```

If a directory for this experiment exists, read its `state.md` and continue from the step it names. All
knowledge needed to continue lives on disk (`state.md`, `summary.json`, `compare.md`) — never rely on chat
memory of a previous session. If the context grows heavy mid-iteration, update `state.md` and compact: the
iteration survives any session break.

## 1. Iteration cycle

One experiment = ONE change (a single prompt, a single parameter, a single code spot). Never mix.

1. **Baseline.** Find a baseline run for the current commit (`meta.git_commit` inside
   `claudedocs/experiments/*/summary.json`). If none:
   `node scripts/eval.js --suite all --label baseline-<topic>`
2. **Hypothesis from observations.** Ground it in concrete `log.llm_request` records (ids in `state.md`):
   - overview: `node scripts/llm-log-export.js --last 30 --kind <request_kind>`
   - details strictly by id: `node scripts/llm-log-export.js --id <id> --fields payload.messages,response`
   - content search: `node scripts/llm-log-export.js --kind <kind> --grep "<строка>" --last 200`
3. **Branch and change.** `git checkout -b tuning/<topic>`. If a prompt text changes — update
   `docs/prompt-inventory.md` (it is canonical). Commit the change.
4. **Gates before any evals.** `npm run lint` and `npm test` must pass.
5. **Evals.** `node scripts/eval.js --suite all --label <topic>-v1` (add `--repeat 3` when the dialog judge
   looks noisy; `--suite dialog --scenario <name>` to iterate cheaply on one scenario). Thresholds, axes and
   the cost stop-limit come only from `tests/eval/criteria.yaml`.
6. **Compare.** `node scripts/eval-compare.js claudedocs/experiments/<baseline> claudedocs/experiments/<candidate>`
   — prints the report and writes `compare.md`/`diffs.md` into the candidate dir.
7. **Close the iteration.** Final `state.md` update; clean test users:
   `node scripts/delete-user.js --test-users --yes`. Show the human the compare report. Merging into master
   is ALWAYS a human decision — never merge or deploy yourself.

## 2. Checkpoint protocol (`state.md`)

Keep `claudedocs/experiments/<label>/state.md` current at every step boundary (baseline taken; change
committed; evals run; comparison built). After updating it, the raw material of the finished step is no
longer needed in context. Template:

```markdown
# Эксперимент: <label>
- Гипотеза: <что меняем и почему; ссылки на llm_request_id наблюдений>
- Ветка: tuning/<topic>; базовый коммит: <hash>
- Baseline: claudedocs/experiments/<dir> (summary.json)
- Сделано: <краткие результаты пройденных шагов, по строке>
- Следующий шаг: <ровно один следующий шаг цикла>
```

## 3. Context and cost economy — mandatory rules

Two scarce resources: the context window (tokens) and money (LLM spend). Both are protected the same way —
work on the smallest slice that answers the question.

- **Isolate the stage (saves money AND sharpens the signal).** To tune one stage, run only its suite
  (`--suite classify|facts|topics|compress|dedupe|tools`), never `--suite all`. It runs only that stage's LLM
  calls — a fraction of the cost — and its regression is not muddied by other stages. Use
  `--suite dialog --scenario <name>` to iterate on one end-to-end scenario cheaply. Run the full `--suite all`
  only to take a baseline or before the final report.
- **Cost ceiling.** Every run is capped by `budget.eval_run_max_usd` in `tests/eval/criteria.yaml`; the runner
  stops on overrun. Watch `price_usd` per stage/turn — the compare report flags cost regressions next to quality.
- **Tokens — summary first.** Read `summary.json` / `transcript.summary.md` / `compare.md`; open
  `cases/<id>.json` and `diffs.md` only for failed or changed cases, 1–3 at a time. Never dump full payloads by
  a broad filter; `--full` only with `--id` (the script enforces a guard).
- **Delegate bulk reading.** More than ~5 full log records or transcripts → a subagent (Explore/Task) that
  returns a short conclusion; raw data must not enter the main context. "Where does X occur" → `--grep`, never
  bulk reading.

## 4. Guardrails

- No autodeploy: the cycle ends with a report and a branch, never a rollout.
- Runs only as test users (`NODE_ENV=test`, enforced by scripts); never message real users.
- Cost stop-limit per eval run: `budget.eval_run_max_usd` in `tests/eval/criteria.yaml`.
- Reference sets and criteria change ONLY in a separate commit with justification, never in the same branch
  as a prompt/code change ("don't fit the exam to the student"). `criteria.yaml` edits are accepted by the
  human; you may propose them in the report.

## 5. Typical iterations

- **Improve one request_kind prompt (isolated).** Observe via export (step 2) → edit the prompt at the
  coordinate from `docs/prompt-inventory.md` → run ONLY that stage's suite so the rest of the pipeline does not
  run and does not muddy the signal: `--suite classify` (`intent_classify`), `--suite facts` (`fact_extract`),
  `--suite topics` (`topic_extract`), `--suite compress` (`history_compress`), `--suite dedupe` (fact
  deduplication), `--suite tools` (tool selection), `--suite dialog` (end-to-end answer). Add `--deterministic`
  for chatJSON stages and `--repeat N` for the `tools` probe. Run the full `--suite all` only before the report.
  Two stages have no isolated suite by design: memory cleanup is structural (a fact's time-to-live is set at
  write time in `src/pipeline/facts.js` and filtered at read time — exercised by `--suite dedupe`), and there is
  no tool-search stage (the model selects tools natively over the full set, covered by `--suite tools`).
- **Reduce cycle cost.** Baseline → check per-kind cost: overview export per kind, `price_usd` totals →
  change model/prompt size → compare watches `dialog.avg_turn_price_usd` and quality axes.
- **Investigate a regression from a user complaint.** Find the cycle:
  `node scripts/llm-log-export.js --request-id <uuid>` (or `--user <id> --last 50`) → reproduce as a scenario
  in `tests/scenarios/` (new scenario = separate commit, see guardrails) → fix → evals → compare.

## 6. Map

- Criteria and thresholds: `tests/eval/criteria.yaml`; judge rubrics: `tests/eval/rubrics/<axis>.md`.
- Reference sets: `tests/eval/classify_cases.json`, `tests/memory_cases.json` (facts),
  `tests/eval/topic_cases.json`, `tests/eval/compress_cases.json`, `tests/eval/dedupe_cases.json`,
  `tests/eval/tool_select_cases.json`, `tests/scenarios/*.json`.
- Run artifacts: `claudedocs/experiments/<date>-<label>/` (`summary.json`, `cases/<id>.json`, `state.md`,
  `compare.md`, `diffs.md`). The dir is gitignored — artifacts are ephemeral.
- Harness code: `scripts/eval.js`, `scripts/eval/judge.js`, `scripts/eval-compare.js`,
  `scripts/run-scenario.js`, `scripts/lib/scenario-runner.js`, `scripts/llm-log-export.js`. Isolated aspect
  suites: `scripts/eval/suites/{topics,compress,dedupe,tools}.js` (+ `_lib.js`); add a new aspect as one more
  module here plus a block in `tests/eval/criteria.yaml`.
