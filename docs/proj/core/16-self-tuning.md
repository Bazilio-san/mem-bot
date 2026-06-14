# 16. Self-Tuning and Evaluation

Self-tuning is the measured loop for improving the agent's prompts, pipeline code, and model choices without
guessing. Every change is judged against reference cases and a was/became comparison, so a prompt edit is
accepted on evidence rather than impression. This is developer tooling: it observes and exercises the same
pipeline the bot runs in production, but it does not change the agent's runtime behavior.

## Closed Loop

Observe what actually went to the model, form a hypothesis, change one thing in a branch, run evaluations,
compare against a baseline, and let a human accept or reject. The full methodology, command cheat sheet, and
guardrails live in the `/tune-bot` skill (`.claude/skills/tune-bot/SKILL.md`). This page explains the concepts
that loop rests on.

## Observability

Every LLM call is logged to `log.llm_request` with its kind, model, tokens, price, latency, and the full
payload and response, tied to the code version (`git_commit`) and prompt version (`prompt_hash`) that produced
it. That is what makes a hypothesis grounded in real traffic instead of memory.

- Log writer and request kinds: `../../../src/pipeline/llm-log.js`
- Layered export for analysis: `../../../scripts/llm-log-export.js`

## Per-Stage Isolation

Each pipeline stage can be evaluated on its own, without running the rest of the pipeline. The intent
classifier, fact extraction, topic extraction, history compression, fact deduplication, and tool selection
each have an isolated suite that calls only that stage's function (or, for stages that need data, seeds a
throw-away test user). Isolation attributes a regression to the stage that caused it and keeps a focused edit
from being judged by unrelated noise from other stages.

- Isolated suites and the aspect-to-stage mapping: `../../../scripts/eval/suites/` (one module per stage),
  wired into `../../../scripts/eval.js`.
- End-to-end answer quality (the whole pipeline plus an LLM judge): the `dialog` suite.
- Criteria, thresholds, and judge rubrics (single source of truth): `../../../tests/eval/criteria.yaml`.

A stage with no isolatable LLM step is documented as such: memory cleanup is structural — a fact's
time-to-live is set at write time and filtered at read time (`../../../src/pipeline/facts.js`), so it is
covered by the deduplication suite rather than its own. Tool search does not exist, because tool selection is
the model's native choice over the full tool set.

## Economy

The loop is deliberately cheap in the two scarce resources of an automated tuning session:

- **Tokens and context.** Outputs are layered — a small summary first, full payloads only on demand and only
  for the cases that need them. Bulk log reading is delegated to a subagent and never pulled into the working
  context. This keeps a whole iteration inside one context window.
- **Money.** Isolating a single stage runs only that stage's LLM calls instead of the whole pipeline, so a
  focused iteration costs a fraction of an end-to-end run. Each evaluation run is capped by a hard cost
  stop-limit (`budget.eval_run_max_usd` in `../../../tests/eval/criteria.yaml`), and per-turn price is recorded
  so cost regressions surface in the was/became comparison alongside quality.

## Guardrails

Runs touch only test users (`NODE_ENV=test`, enforced by the scripts). The loop ends with a report and a
branch, never a deployment. Reference cases and criteria change in their own commit, so the exam is never
fitted to the student. Merging an experiment is always a human decision.

## Verification

The harness is driven by the reference suites under `../../../tests/eval/` and the scenarios in
`../../../tests/scenarios/`; the surrounding pipeline is covered by `../../../tests/run.js`.
