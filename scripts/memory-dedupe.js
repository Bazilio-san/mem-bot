#!/usr/bin/env node
// Ручной запуск семантической чистки дубликатов в плоской таблице фактов mem.user_facts.
// Дубликаты одного пользователя и типа (косинусное сходство выше facts.confirmSimilarity) сливаются:
// остаётся строка с большим числом подтверждений, дубликат архивируется. Dry-run — по умолчанию.
import { query, closePool } from '../src/db.js';
import { dedupeFactsSweep } from '../src/pipeline/facts.js';

function parseArgs(argv) {
  const args = { dryRun: true, apply: false, json: false, limit: 500, allUsers: false, userId: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--user') {
      args.userId = argv[++i];
    } else if (arg === '--all-users') {
      args.allUsers = true;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--apply') {
      args.apply = true;
      args.dryRun = false;
    } else if (arg === '--limit') {
      args.limit = Number(argv[++i] || 500);
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function usage() {
  return `Usage:
  npm run memory:dedupe -- --user <uuid> [--dry-run] [--limit 500] [--json]
  npm run memory:dedupe -- --user <uuid> --apply
  npm run memory:dedupe -- --all-users [--dry-run|--apply]

Dry-run is the default. --apply archives duplicate rows.`;
}

async function usersFor(args) {
  if (args.userId) {
    return [args.userId];
  }
  if (args.allUsers) {
    const { rows } = await query(`SELECT DISTINCT user_id FROM mem.user_facts WHERE status = 'active'`);
    return rows.map((r) => r.user_id);
  }
  throw new Error('Set --user <uuid> or --all-users. See --help.');
}

function formatHuman(userId, result) {
  const lines = [
    `user ${userId}: checked ${result.checked}, ${result.merged ? `merged ${result.merged}` : `pairs found ${result.pairs.length}`}`,
  ];
  for (const pair of result.pairs) {
    lines.push(`  keep ${pair.keepId} <- drop ${pair.dropId} (similarity ${pair.similarity.toFixed(3)})`);
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const userIds = await usersFor(args);
  const results = [];
  for (const userId of userIds) {
    const result = await dedupeFactsSweep({ userId, dryRun: args.dryRun, limit: args.limit });
    results.push({ userId, ...result });
  }
  if (args.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(results.map((r) => formatHuman(r.userId, r)).join('\n\n'));
  }
}

main()
  .catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
