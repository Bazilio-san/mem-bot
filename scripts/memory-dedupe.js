#!/usr/bin/env node
import { query, closePool } from '../src/db.js';
import { runMemoryDedupe } from '../src/pipeline/memory-dedupe.js';

function parseArgs(argv) {
  const args = { dryRun: true, apply: false, json: false, limit: 500, allUsers: false, userId: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--user') args.userId = argv[++i];
    else if (arg === '--all-users') args.allUsers = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--apply') { args.apply = true; args.dryRun = false; }
    else if (arg === '--limit') args.limit = Number(argv[++i] || 500);
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
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
  if (args.userId) return [args.userId];
  if (!args.allUsers) throw new Error('Pass --user <uuid> or --all-users.');
  const { rows } = await query(
    `SELECT DISTINCT user_id FROM mem.memory_items WHERE status='active' ORDER BY user_id`,
  );
  return rows.map((r) => r.user_id);
}

function formatHuman(result) {
  const lines = [];
  lines.push(`user=${result.userId} mode=${result.dryRun ? 'dry-run' : 'apply'} groups=${result.groups.length}`);
  for (const group of result.groups) {
    lines.push(`\n[${group.dedupeKey}] items=${group.items.length}`);
    lines.push(`  canonical: ${group.canonical.id} ${group.canonical.memory_text}`);
    for (const dup of group.duplicates) {
      lines.push(`  duplicate: ${dup.id} ${dup.memory_text}`);
    }
  }
  if (!result.groups.length) lines.push('No duplicate groups found.');
  return lines.join('\n');
}

function compact(result) {
  return {
    userId: result.userId,
    dryRun: result.dryRun,
    groups: result.groups.map((group) => ({
      dedupeKey: group.dedupeKey,
      canonical: {
        id: group.canonical.id,
        memory_text: group.canonical.memory_text,
        scope: group.canonical.scope,
        memory_kind: group.canonical.memory_kind,
      },
      duplicates: group.duplicates.map((dup) => ({
        id: dup.id,
        memory_text: dup.memory_text,
        scope: dup.scope,
        memory_kind: dup.memory_kind,
      })),
    })),
    applied: result.applied,
  };
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
    results.push(await runMemoryDedupe({ userId, dryRun: args.dryRun, limit: args.limit }));
  }
  if (args.json) console.log(JSON.stringify(results.map(compact), null, 2));
  else console.log(results.map(formatHuman).join('\n\n'));
}

main()
  .catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
