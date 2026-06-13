// LLM judge of the eval harness: scores a dialog transcript against the rubric axes defined in
// tests/eval/criteria.yaml (suite "dialog"). The axes, scales and weights are NOT hardcoded here —
// they come from the criteria file; the wording of every axis comes from tests/eval/rubrics/<axis>.md.
// Judge calls are logged with request_kind 'eval_judge', so they never mix with production requests
// and their cost is visible separately. See claudedocs/2026-06-13_00-44-self-tuning-infrastructure.md §5.2 and §8.

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { chatJSON } from '../../src/llm.js';
import { config } from '../../src/config.js';

// Load and parse tests/eval/criteria.yaml. The single source of thresholds for the whole harness.
export function loadCriteria(rootDir) {
  const file = path.join(rootDir, 'tests', 'eval', 'criteria.yaml');
  return yaml.load(fs.readFileSync(file, 'utf8'));
}

// Read the rubric texts of the given axes. A missing rubric file is a configuration error: the judge
// must never invent the meaning of an axis on its own.
function loadRubrics(rootDir, axes) {
  const rubrics = {};
  for (const axis of Object.keys(axes)) {
    const file = path.join(rootDir, 'tests', 'eval', 'rubrics', `${axis}.md`);
    if (!fs.existsSync(file)) {
      throw new Error(`Rubric file is missing for axis "${axis}": ${file}`);
    }
    rubrics[axis] = fs.readFileSync(file, 'utf8').trim();
  }
  return rubrics;
}

// Strict response schema built from the axes of the criteria file.
function buildJudgeSchema(axes) {
  const axisProps = {};
  for (const [axis, cfg] of Object.entries(axes)) {
    axisProps[axis] = {
      type: 'object',
      additionalProperties: false,
      required: ['score', 'reason'],
      properties: {
        score: {
          type: 'integer',
          minimum: cfg.scale?.[0] ?? 1,
          maximum: cfg.scale?.[1] ?? 5,
          description: `Оценка по оси ${axis} по шкале ${cfg.scale?.[0] ?? 1}–${cfg.scale?.[1] ?? 5}.`,
        },
        reason: {
          type: 'string',
          description: 'Краткое обоснование оценки (1-3 предложения) с опорой на конкретные ходы диалога.',
        },
      },
    };
  }
  return {
    type: 'object',
    additionalProperties: false,
    required: ['axes', 'overall_comment'],
    properties: {
      axes: { type: 'object', additionalProperties: false, required: Object.keys(axisProps), properties: axisProps },
      overall_comment: {
        type: 'string',
        description: 'Главный вывод по диалогу в целом: сильнейшая и слабейшая стороны, 1-3 предложения.',
      },
    },
  };
}

// Render the transcript for the judge: numbered user/bot turns, full answer texts.
function renderTranscript(transcript) {
  const lines = [];
  for (const t of transcript.turns) {
    if (t.type === 'scheduler_tick') {
      lines.push(`[ход ${t.n}] (служебный тик планировщика, задач обработано: ${t.processed})`);
      continue;
    }
    lines.push(`[ход ${t.n}] Пользователь: ${t.user}`);
    lines.push(`[ход ${t.n}] Бот: ${t.answer}`);
  }
  return lines.join('\n');
}

// Score one dialog transcript. Returns { axes: { <axis>: { score, reason } }, overall_comment,
// weighted_score } where weighted_score uses the weights from the criteria file.
export async function judgeDialog({ rootDir, criteria, scenario, transcript, model = null }) {
  const { axes } = criteria.suites.dialog;
  const rubrics = loadRubrics(rootDir, axes);
  const rubricBlocks = Object.entries(rubrics)
    .map(([axis, text]) => `### Ось «${axis}»\n${text}`)
    .join('\n\n');
  const system = `Ты — строгий и беспристрастный эксперт по качеству диалоговых ассистентов.
Тебе дан транскрипт диалога пользователя с ботом-собеседником, обладающим долговременной памятью.
Оцени диалог по каждой оси рубрики НЕЗАВИСИМО, по указанной шкале, опираясь только на транскрипт.
Не награждай за то, чего в диалоге нет; при сомнении выбирай более низкий балл.

Рубрики осей:

${rubricBlocks}`;
  const focus = scenario?.expect?.judge_focus ? `\nОсобое внимание проверяющего: ${scenario.expect.judge_focus}` : '';
  const user = `Сценарий: «${scenario?.name || transcript.scenario}».${focus}

Транскрипт диалога:
${renderTranscript(transcript)}`;
  const result = await chatJSON({
    model: model || config.llm.mainModel,
    kind: 'eval_judge',
    schema: buildJudgeSchema(axes),
    schemaName: 'dialog_judgement',
    system,
    user,
  });
  let weighted = 0;
  for (const [axis, cfg] of Object.entries(axes)) {
    weighted += (result.axes?.[axis]?.score ?? 0) * (cfg.weight ?? 0);
  }
  return { ...result, weighted_score: Number(weighted.toFixed(3)) };
}
