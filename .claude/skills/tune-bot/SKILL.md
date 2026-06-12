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

The whole methodology in one place. Design rationale: `claudedocs/self-tuning-infrastructure.md` (do NOT load
it whole into context — this skill is the operational extract). Every run below is forced to `NODE_ENV=test`
by the scripts themselves: test users and `is_test` log records only, production data is never touched.

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

## 3. Context economy — mandatory rules

- Summary first, details addressably: read `summary.json` / `transcript.summary.md` / `compare.md`; open
  `cases/<id>.json` and `diffs.md` only for failed or changed cases, 1–3 at a time.
- Never dump full payloads by a broad filter; `--full` only with `--id` (the script enforces a guard).
- Need more than ~5 full log records or transcripts? Delegate to a subagent (Explore/Task) that returns a
  short conclusion; raw data must not enter the main context.
- "Where does X occur" questions → `--grep` of the export script or SQL, never bulk reading.

## 4. Guardrails

- No autodeploy: the cycle ends with a report and a branch, never a rollout.
- Runs only as test users (`NODE_ENV=test`, enforced by scripts); never message real users.
- Cost stop-limit per eval run: `budget.eval_run_max_usd` in `tests/eval/criteria.yaml`.
- Reference sets and criteria change ONLY in a separate commit with justification, never in the same branch
  as a prompt/code change ("don't fit the exam to the student"). `criteria.yaml` edits are accepted by the
  human; you may propose them in the report.

## 5. Typical iterations

- **Improve one request_kind prompt.** Observe via export (step 2) → edit the prompt at the coordinate from
  `docs/prompt-inventory.md` → relevant suite (`--suite classify` for `intent_classify`, `--suite facts` for
  `fact_extract`, `--suite dialog` otherwise) → full `--suite all` before the report.
- **Reduce cycle cost.** Baseline → check per-kind cost: overview export per kind, `price_usd` totals →
  change model/prompt size → compare watches `dialog.avg_turn_price_usd` and quality axes.
- **Investigate a regression from a user complaint.** Find the cycle:
  `node scripts/llm-log-export.js --request-id <uuid>` (or `--user <id> --last 50`) → reproduce as a scenario
  in `tests/scenarios/` (new scenario = separate commit, see guardrails) → fix → evals → compare.

## 6. Map

- Criteria and thresholds: `tests/eval/criteria.yaml`; judge rubrics: `tests/eval/rubrics/<axis>.md`.
- Reference sets: `tests/eval/classify_cases.json`, `tests/memory_cases.json` (facts), `tests/scenarios/*.json`.
- Run artifacts: `claudedocs/experiments/<date>-<label>/` (`summary.json`, `cases/<id>.json`, `state.md`,
  `compare.md`, `diffs.md`).
- Harness code: `scripts/eval.js`, `scripts/eval/judge.js`, `scripts/eval-compare.js`,
  `scripts/run-scenario.js`, `scripts/lib/scenario-runner.js`, `scripts/llm-log-export.js`.
