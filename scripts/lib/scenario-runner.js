// Non-interactive scenario runner: replays a scripted sequence of user turns through the FULL pipeline
// (handleMessage — the same path Telegram uses) without any messenger. Shared by scripts/run-scenario.js
// (manual runs) and scripts/eval.js (the dialog suite). See claudedocs/2026-06-13_00-44-self-tuning-infrastructure.md §4.
//
// Scenario file format (tests/scenarios/*.json):
//   {
//     "name": "facts-and-recall",
//     "domain": "general",                 // optional, default 'general'
//     "channel": "plain",                  // optional, default 'plain'
//     "turns": [
//       { "user": "Меня зовут Олег." },    // a user message run through handleMessage
//       { "scheduler_tick": true },        // one scheduler pass (due tasks fire)
//       { "user": "Что мне подтянуть?" }
//     ],
//     "expect": {                          // optional, consumed by the eval dialog suite
//       "mentions": ["логарифм"],          // each string must appear in at least one bot answer
//       "forbidden": ["паспорт"],          // must not appear in any bot answer
//       "judge_focus": "Помнит ли бот имя и цель пользователя"  // extra instruction for the LLM judge
//     }
//   }
//
// The runner REQUIRES NODE_ENV=test: every created user and every log record gets is_test = true, so a run
// never touches real users' data (guardrail §7.2) and can be cleaned with delete-user.js --test-users.

import fs from 'node:fs';
import path from 'node:path';
import { handleMessage } from '../../src/agent.js';
import { tick } from '../../src/pipeline/scheduler.js';
import { query, queryLog } from '../../src/db.js';
import { flushLlmLog } from '../../src/pipeline/llm-log.js';
import { flushAgentEventLog } from '../../src/pipeline/agent-event-log.js';

function assertTestEnv() {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Scenario runs are allowed only with NODE_ENV=test (test users, is_test log records).');
  }
}

export function loadScenario(filePath) {
  const scenario = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!scenario.name || !Array.isArray(scenario.turns)) {
    throw new Error(`Scenario file ${filePath} must contain "name" and a "turns" array.`);
  }
  return scenario;
}

// Aggregate the LLM calls of one turn from the log DB (flushed right before the query). Only metadata is
// pulled — payloads stay in the DB and are fetched addressably via scripts/llm-log-export.js --id.
async function collectTurnLlmCalls(userId, sinceIso) {
  const { rows } = await queryLog(
    `SELECT llm_request_id, request_id, request_kind, model, total_tokens, price_usd, duration_ms, status
       FROM log.llm_request WHERE user_id = $1 AND created_at >= $2 ORDER BY created_at`,
    [String(userId), sinceIso],
  );
  return rows;
}

// Run one scenario. Returns the full transcript object (see writeScenarioArtifacts for the disk layout).
export async function runScenario(scenario, { keepUser = false, externalId = null } = {}) {
  assertTestEnv();
  const extId = externalId || `scenario-${scenario.name}-${Date.now()}`;
  const domainStart = scenario.domain || 'general';
  const channel = scenario.channel || 'plain';
  const startedAt = Date.now();
  let domainKey = domainStart;
  let userId = null;
  const turns = [];

  for (let i = 0; i < scenario.turns.length; i += 1) {
    const turn = scenario.turns[i];
    const turnStartIso = new Date().toISOString();
    const t0 = Date.now();
    if (turn.scheduler_tick) {
      const r = await tick();
      turns.push({ n: i + 1, type: 'scheduler_tick', processed: r.processed, durationMs: Date.now() - t0 });
      continue;
    }
    if (!turn.user) {
      throw new Error(`Turn ${i + 1} of scenario "${scenario.name}" has neither "user" nor "scheduler_tick".`);
    }
    const res = await handleMessage({
      externalId: extId,
      userMessage: turn.user,
      domainKey,
      channel,
      extractSync: true,
    });
    ({ domainKey } = res);
    userId = res.userId ?? userId;
    await flushLlmLog();
    const llmCalls = userId ? await collectTurnLlmCalls(userId, turnStartIso) : [];
    turns.push({
      n: i + 1,
      type: 'user',
      user: turn.user,
      answer: res.answer,
      intent: res.intent?.intent ?? null,
      skill: res.intent?.skill_name ?? null,
      toolsUsed: (res.toolsUsed || []).map((t) => t.name),
      degraded: res.degraded === true,
      durationMs: Date.now() - t0,
      requestIds: [...new Set(llmCalls.map((c) => c.request_id).filter(Boolean))],
      llmCalls,
      tokens: llmCalls.reduce((s, c) => s + Number(c.total_tokens || 0), 0),
      priceUsd: llmCalls.reduce((s, c) => s + Number(c.price_usd || 0), 0),
    });
  }

  await flushLlmLog();
  await flushAgentEventLog();
  if (!keepUser && userId) {
    // Test users cascade-delete their conversations, facts and tasks; log records stay marked is_test.
    await query('DELETE FROM mem.users WHERE id = $1', [userId]);
  }

  const userTurns = turns.filter((t) => t.type === 'user');
  return {
    scenario: scenario.name,
    externalId: extId,
    userId,
    userKept: keepUser,
    domainStart,
    channel,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    totals: {
      turns: userTurns.length,
      tokens: userTurns.reduce((s, t) => s + t.tokens, 0),
      priceUsd: Number(userTurns.reduce((s, t) => s + t.priceUsd, 0).toFixed(6)),
      llmCalls: userTurns.reduce((s, t) => s + t.llmCalls.length, 0),
    },
    turns,
  };
}

// Deterministic transcript checks from scenario.expect: required mentions and forbidden fragments over
// the concatenated bot answers (case-insensitive substring match).
export function checkExpectations(scenario, transcript) {
  const expect = scenario.expect || {};
  const answers = transcript.turns
    .filter((t) => t.type === 'user')
    .map((t) => String(t.answer || ''))
    .join('\n')
    .toLowerCase();
  const missingMentions = (expect.mentions || []).filter((m) => !answers.includes(String(m).toLowerCase()));
  const forbiddenHits = (expect.forbidden || []).filter((m) => answers.includes(String(m).toLowerCase()));
  return { missingMentions, forbiddenHits, pass: missingMentions.length === 0 && forbiddenHits.length === 0 };
}

const clip = (s, n) => {
  const one = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
};

// Two-layer artifacts (§2a): transcript.summary.md — the only file meant to be read into the caller's
// context; transcript.full.json — full answers and per-call details, opened addressably per turn.
export function writeScenarioArtifacts(outDir, transcript) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'transcript.full.json'), JSON.stringify(transcript, null, 2));
  const lines = [
    `# Сценарий «${transcript.scenario}» — сводка прогона`,
    '',
    `Пользователь: ${transcript.externalId} (${transcript.userKept ? 'оставлен' : 'удалён'}), домен: ${transcript.domainStart}, канал: ${transcript.channel}.`,
    `Итого: ходов ${transcript.totals.turns}, LLM-вызовов ${transcript.totals.llmCalls}, токенов ${transcript.totals.tokens}, цена $${transcript.totals.priceUsd}, длительность ${Math.round(transcript.durationMs / 1000)} с.`,
    '',
    '| № | реплика пользователя | начало ответа | токены | цена | request_id |',
    '|---|----------------------|---------------|--------|------|------------|',
  ];
  for (const t of transcript.turns) {
    if (t.type === 'scheduler_tick') {
      lines.push(`| ${t.n} | _scheduler tick_ | задач обработано: ${t.processed} | | | |`);
      continue;
    }
    lines.push(
      `| ${t.n} | ${clip(t.user, 60)} | ${clip(t.answer, 80)} | ${t.tokens} | $${t.priceUsd.toFixed(4)} | ${t.requestIds.join(', ')} |`,
    );
  }
  lines.push(
    '',
    `Полный транскрипт: transcript.full.json (ответы целиком и список LLM-вызовов каждого хода).`,
    `Детали конкретного вызова: node scripts/llm-log-export.js --request-id <uuid> либо --id <llm_request_id>.`,
    '',
  );
  fs.writeFileSync(path.join(outDir, 'transcript.summary.md'), lines.join('\n'));
}
