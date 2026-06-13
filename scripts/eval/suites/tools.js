// Aspect suite "tools": isolated evaluation of tool selection. The bot has no separate "choose a tool"
// step — the main model picks tools natively during the answer turn (src/agent.js runModelTurn). This suite
// isolates just that decision: it offers the model the REAL base tool definitions (buildToolDefs) and one
// user message, runs a single model turn WITHOUT executing any tool, and checks which tool the model called.
// That makes it a direct measure of how discriminable the tool DESCRIPTIONS are — the main tuning lever for
// "how well tools get selected".
//
// Scope and caveats:
//   - Only base (system) tools are offered: buildToolDefs({}) with no active skill. MCP / domain-skill tools
//     are out of scope here (they require a configured skill and a running MCP server) — tune those via the
//     dialog suite or a dedicated future suite.
//   - It uses chat() (not chatJSON), which does NOT honour EVAL_TEMPERATURE, so the probe runs at the model's
//     default temperature. Use --repeat N for run-to-run stability (majority verdict).
//   - It tests the selection given a thin, faithful framing, NOT the full production system prompt (persona,
//     memory, channel formatting are deliberately excluded to keep the stage isolated).
//
// Case file: tests/eval/tool_select_cases.json. Per-case fields:
//   input            — the user message
//   expect_tool      — the tool name the model must call; null means "answer without any tool"
//   expect_tool_any  — optional array of acceptable tool names (use instead of expect_tool when several fit)
//   note             — human description of what the case checks

import { config } from '../../../src/config.js';
import { chat } from '../../../src/llm.js';
import { buildToolDefs } from '../../../src/pipeline/tools.js';
import { loadCases, majority, passRateSummary } from './_lib.js';

export const meta = { name: 'tools', type: 'deterministic' };

const PROBE_SYSTEM = `Ты — ядро бота-собеседника с долговременной памятью и набором инструментов.
Тебе дано одно сообщение пользователя. Реши, нужен ли для корректного ответа вызов инструмента.
Если да — вызови ровно один наиболее подходящий инструмент и не выдумывай несуществующих.
Если это обычная беседа, мнение или самодостаточный вопрос, на который можно ответить словами,
не вызывай инструменты, а ответь текстом. Не проси уточнений — действуй по сообщению как есть.`;

function selectedTool(msg) {
  const call = msg?.tool_calls?.[0];
  return call?.function?.name ?? call?.name ?? null;
}

function checkCase(tc, selected) {
  if (tc.expect_tool === null) {
    return selected === null ? [] : [`expected no tool, model called "${selected}"`];
  }
  const allowed = tc.expect_tool_any || (tc.expect_tool ? [tc.expect_tool] : []);
  return allowed.includes(selected) ? [] : [`expected ${allowed.join(' | ')}, got "${selected || 'none'}"`];
}

export async function run({ rootDir, criteria, repeat, saveCase, checkBudget }) {
  const cfg = criteria.suites.tools;
  const cases = loadCases(rootDir, cfg.cases_file);
  const tools = buildToolDefs({});
  const rows = [];
  let passed = 0;
  for (const tc of cases) {
    const attempts = [];
    for (let r = 0; r < repeat; r += 1) {
      const msg = await chat({
        model: config.llm.mainModel,
        kind: 'eval_tool_select',
        tools,
        messages: [
          { role: 'system', content: PROBE_SYSTEM },
          { role: 'user', content: tc.input },
        ],
      });
      const selected = selectedTool(msg);
      const problems = checkCase(tc, selected);
      attempts.push({ selected, problems, pass: problems.length === 0 });
    }
    const verdict = majority(attempts);
    if (verdict === 'pass') {
      passed += 1;
    }
    rows.push({ id: tc.id, suite: 'tools', verdict, note: tc.note });
    saveCase(tc.id, { suite: 'tools', case: tc, attempts, verdict });
    await checkBudget();
  }
  return {
    summary: {
      ...passRateSummary({ cases: cases.length, passed, threshold: cfg.pass_threshold }),
      tools_offered: tools.length,
    },
    rows,
  };
}
