// Comparison report between two eval runs ("was/became"), built compact-first so the reader stops at
// the depth they need. See claudedocs/self-tuning-infrastructure.md §6.
//
// Run:
//   node scripts/eval-compare.js claudedocs/experiments/<runA> claudedocs/experiments/<runB>
//
// runA is the BASELINE, runB is the candidate. The acceptance thresholds are NOT hardcoded here — they
// come from tests/eval/criteria.yaml (section "acceptance").
//
// Output:
//   stdout                    — aggregate deltas, changed cases, recommendation (the compact layer)
//   <runB>/compare.md         — the same report as a file
//   <runB>/diffs.md           — actual outputs of the changed cases only (read addressably, not by default)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function loadRun(dir) {
  const abs = path.resolve(rootDir, dir);
  const summary = JSON.parse(fs.readFileSync(path.join(abs, 'summary.json'), 'utf8'));
  return { dir: abs, summary };
}

function loadCaseDetail(runDir, id) {
  const file = path.join(runDir, 'cases', `${id}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function pctDelta(a, b) {
  if (a == null || b == null || a === 0) {
    return null;
  }
  return ((b - a) / a) * 100;
}

const fmt = (v, digits = 3) => (v == null ? '—' : Number(v).toFixed(digits));
const fmtPct = (v) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`);

function main() {
  const [dirA, dirB] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!dirA || !dirB) {
    console.error('Usage: node scripts/eval-compare.js <baseline run dir> <candidate run dir>');
    process.exit(2);
  }
  const criteria = yaml.load(fs.readFileSync(path.join(rootDir, 'tests', 'eval', 'criteria.yaml'), 'utf8'));
  const acc = criteria.acceptance || {};
  const A = loadRun(dirA);
  const B = loadRun(dirB);
  const sA = A.summary;
  const sB = B.summary;

  const lines = [];
  const out = (s = '') => lines.push(s);

  out(`# Сравнение прогонов: «${sA.label}» (база) → «${sB.label}» (кандидат)`);
  out('');
  out(`База: коммит ${sA.meta.git_commit}, ветка ${sA.meta.git_branch}, ${sA.created_at}.`);
  out(`Кандидат: коммит ${sB.meta.git_commit}, ветка ${sB.meta.git_branch}, ${sB.created_at}.`);
  out('');

  // ---- Aggregate deltas (the first, compact layer) -------------------------------------------------
  out('## Агрегатные дельты');
  out('');
  const violations = [];
  for (const name of Object.keys(sB.suites)) {
    const a = sA.suites[name];
    const b = sB.suites[name];
    if (!a) {
      out(`- ${name}: в базовом прогоне отсутствует — сравнения нет.`);
      continue;
    }
    if (b.type === 'deterministic') {
      out(`- ${name}: доля пройденных ${fmt(a.pass_rate, 2)} → ${fmt(b.pass_rate, 2)} (кейсов ${b.cases}).`);
      if (b.pass_rate < a.pass_rate) {
        violations.push(
          `${name}: доля пройденных упала ниже базовой (${fmt(b.pass_rate, 2)} < ${fmt(a.pass_rate, 2)})`,
        );
      }
    } else {
      for (const [axis, bv] of Object.entries(b.axes_avg)) {
        const av = a.axes_avg?.[axis];
        out(`- dialog/${axis}: средний балл ${fmt(av, 2)} → ${fmt(bv, 2)}.`);
        if (av != null && bv != null && bv < av - (acc.quality_drop_tolerance ?? 0)) {
          violations.push(
            `dialog/${axis}: падение балла сверх шумового допуска (${fmt(bv, 2)} < ${fmt(av, 2)} − ${acc.quality_drop_tolerance})`,
          );
        }
      }
      const costDelta = pctDelta(a.avg_turn_price_usd, b.avg_turn_price_usd);
      const latDelta = pctDelta(a.latency_p95_ms, b.latency_p95_ms);
      out(
        `- dialog: средняя цена хода $${fmt(a.avg_turn_price_usd, 6)} → $${fmt(b.avg_turn_price_usd, 6)} (${fmtPct(costDelta)}).`,
      );
      out(
        `- dialog: p95 задержки хода ${fmt(a.latency_p95_ms, 0)} мс → ${fmt(b.latency_p95_ms, 0)} мс (${fmtPct(latDelta)}).`,
      );
      if (costDelta != null && costDelta > (acc.cost_increase_max_pct ?? Infinity)) {
        violations.push(
          `dialog: рост цены хода ${fmtPct(costDelta)} сверх допустимых ${acc.cost_increase_max_pct}% (если целью изменения не была экономия — порог применим)`,
        );
      }
      if (latDelta != null && latDelta > (acc.latency_p95_increase_max_pct ?? Infinity)) {
        violations.push(
          `dialog: рост p95 задержки ${fmtPct(latDelta)} сверх допустимых ${acc.latency_p95_increase_max_pct}%`,
        );
      }
    }
  }
  out(`- Полная цена прогона: $${fmt(sA.totals.price_usd, 4)} → $${fmt(sB.totals.price_usd, 4)}.`);
  out('');

  // ---- Changed cases only (unchanged ones are deliberately omitted) --------------------------------
  const byIdA = new Map(sA.cases.map((c) => [c.id, c]));
  const changed = [];
  for (const c of sB.cases) {
    const prev = byIdA.get(c.id);
    if (prev && prev.verdict !== c.verdict) {
      changed.push({ id: c.id, suite: c.suite, from: prev.verdict, to: c.verdict });
    }
  }
  out('## Кейсы с изменившимся вердиктом');
  out('');
  if (!changed.length) {
    out('Нет: вердикты всех общих кейсов совпали с базовыми.');
  } else {
    out('| кейс | набор | было | стало | детали |');
    out('|------|-------|------|-------|--------|');
    for (const c of changed) {
      const mark = c.to === 'pass' ? 'улучшение' : 'РЕГРЕССИЯ';
      out(`| ${c.id} | ${c.suite} | ${c.from} | ${c.to} (${mark}) | cases/${c.id}.json в обоих прогонах |`);
    }
  }
  out('');

  // ---- Recommendation against the acceptance thresholds --------------------------------------------
  out('## Рекомендация по порогам приёмки (tests/eval/criteria.yaml, секция acceptance)');
  out('');
  if (!violations.length) {
    out('**Принять**: все пороги приёмки соблюдены.');
  } else {
    out('**Не принимать без разбора** — нарушения порогов:');
    for (const v of violations) {
      out(`- ${v}`);
    }
  }
  out('');
  out(`Диффы фактических выходов изменившихся кейсов: diffs.md (отдельный файл, читать адресно).`);

  const report = lines.join('\n');
  fs.writeFileSync(path.join(B.dir, 'compare.md'), report);
  console.log(report);

  // ---- diffs.md: actual outputs of changed cases, in a separate file (§2a) -------------------------
  const diffLines = [`# Диффы изменившихся кейсов: «${sA.label}» → «${sB.label}»`, ''];
  for (const c of changed) {
    const da = loadCaseDetail(A.dir, c.id);
    const db = loadCaseDetail(B.dir, c.id);
    diffLines.push(`## ${c.id} (${c.from} → ${c.to})`, '');
    diffLines.push('### Было (база)', '', '```json', JSON.stringify(da, null, 2), '```', '');
    diffLines.push('### Стало (кандидат)', '', '```json', JSON.stringify(db, null, 2), '```', '');
  }
  fs.writeFileSync(path.join(B.dir, 'diffs.md'), diffLines.join('\n'));
  console.log(
    `\nReport: ${path.relative(rootDir, path.join(B.dir, 'compare.md'))}; diffs: ${path.relative(rootDir, path.join(B.dir, 'diffs.md'))}`,
  );
}

main();
