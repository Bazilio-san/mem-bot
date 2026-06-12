// Script that deletes one or more users and all their related entities from the memory DB.
//
// Users are looked up by any combination of criteria: internal identifier (UUID),
// external identifier (external_id), display name (display_name) or a prefix of the
// external identifier. All matches are merged and deduplicated by id.
// Before deletion a report with related row counts is printed.
//
// Most user tables are declared with the ON DELETE CASCADE rule,
// so deleting a row from mem.users cascades to conversations, messages,
// summaries, memory items, secure records, scheduler tasks and their runs,
// notifications, the memory job queue, topics, proactivity triggers and the event log.
//
// Exceptions with the ON DELETE SET NULL rule (rows are kept, only the reference is nulled):
//   - mem.tool_calls.user_id          — the tool call log is kept for analytics;
//   - mem.global_facts.created_by     — global facts are kept, only authorship is lost;
//   - mem.global_knowledge.created_by — the global knowledge base is kept, authorship is lost.
//
// Run (single deletion):
//   node scripts/delete-user.js --external-id tg-123456789
//   node scripts/delete-user.js --id 7f3c...-uuid
//   node scripts/delete-user.js --name "Anna"
//
// Run (batch deletion):
//   node scripts/delete-user.js --external-id tg-111,tg-222,tg-333
//   node scripts/delete-user.js --external-id a --external-id b --id <uuid>
//   node scripts/delete-user.js --prefix tg-               (everyone whose external_id starts with "tg-")
//   node scripts/delete-user.js --prefix t --yes           (no interactive confirmation)
//
// Run (delete all test users):
//   node scripts/delete-user.js --test-users               (everyone with mem.users.is_test = true)
//   node scripts/delete-user.js --test-users --yes         (no interactive confirmation)
//
// Values can be comma-separated and flags can be repeated — everything is merged.
// Without the --yes flag the script asks for confirmation and deletes only when "yes" is typed.
// The whole deletion runs in a single transaction: on error the changes are rolled back.

import readline from 'node:readline';
import { query, getPool, closePool } from '../src/db.js';

// Split a flag value by commas and drop empty/whitespace-only parts.
function splitList(value) {
  return (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Command-line argument parsing. Values are accumulated into arrays
// to support both comma-separated lists and repeated flags.
function parseArgs(argv) {
  const args = { ids: [], externalIds: [], names: [], prefixes: [], testUsers: false, yes: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--yes' || token === '-y') {
      args.yes = true;
    } else if (token === '--test-users') {
      args.testUsers = true;
    } else if (token === '--id') {
      args.ids.push(...splitList(argv[++i]));
    } else if (token === '--external-id' || token === '--ext') {
      args.externalIds.push(...splitList(argv[++i]));
    } else if (token === '--name') {
      args.names.push(...splitList(argv[++i]));
    } else if (token === '--prefix') {
      args.prefixes.push(...splitList(argv[++i]));
    }
  }
  return args;
}

// Find all users by the combined set of criteria. Returns an array of
// unique rows (deduplicated by id). Throws if no criteria are given.
async function findUsers({ ids, externalIds, names, prefixes, testUsers }) {
  if (!ids.length && !externalIds.length && !names.length && !prefixes.length && !testUsers) {
    throw new Error('No search criteria specified. Use --id, --external-id, --name, --prefix or --test-users.');
  }

  const byId = new Map();
  const addRows = (rows) => rows.forEach((r) => byId.set(r.id, r));

  if (testUsers) {
    const { rows } = await query('SELECT * FROM mem.users WHERE is_test = true');
    addRows(rows);
  }
  if (ids.length) {
    const { rows } = await query('SELECT * FROM mem.users WHERE id = ANY($1::uuid[])', [ids]);
    addRows(rows);
  }
  if (externalIds.length) {
    const { rows } = await query('SELECT * FROM mem.users WHERE external_id = ANY($1::text[])', [externalIds]);
    addRows(rows);
  }
  if (names.length) {
    const { rows } = await query('SELECT * FROM mem.users WHERE display_name = ANY($1::text[])', [names]);
    addRows(rows);
  }
  for (const prefix of prefixes) {
    // Escape LIKE special characters (% and _) so the prefix is treated literally.
    const escaped = prefix.replace(/([%_\\])/g, '\\$1');
    const { rows } = await query("SELECT * FROM mem.users WHERE external_id LIKE $1 ESCAPE '\\'", [`${escaped}%`]);
    addRows(rows);
  }

  return [...byId.values()];
}

// Tables deleted via cascade together with the user. Used for the report;
// the actual deletion is done by the DB foreign-key cascade.
const CASCADE_TABLES = [
  ['mem.conversations', 'conversations'],
  ['mem.conversation_messages', 'conversation messages'],
  ['mem.conversation_summaries', 'conversation summaries'],
  ['mem.user_facts', 'user facts'],
  ['mem.secure_records', 'secure records'],
  ['mem.scheduled_tasks', 'scheduler tasks'],
  ['mem.notification_outbox', 'queued notifications'],
  ['mem.topic_mentions', 'topic mentions'],
  ['mem.proactive_triggers', 'proactivity triggers'],
  ['mem.event_deliveries', 'delivered events'],
];

// Tables where the user reference will be nulled (rows are kept).
const SET_NULL_TABLES = [
  ['mem.tool_calls', 'user_id', 'tool calls'],
  ['mem.global_facts', 'created_by', 'global facts (authorship)'],
  ['mem.global_knowledge', 'created_by', 'global knowledge base (authorship)'],
];

// Count related rows for all users to be deleted at once and print the report.
async function reportRelated(userIds) {
  console.log('\nThe following related entities will be deleted (via cascade, totals across all users):');
  let totalDeleted = 0;
  for (const [table, label] of CASCADE_TABLES) {
    const { rows } = await query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = ANY($1::uuid[])`, [userIds]);
    const { n } = rows[0];
    totalDeleted += n;
    if (n > 0) {
      console.log(`  - ${label}: ${n}`);
    }
  }
  if (totalDeleted === 0) {
    console.log('  (no related rows)');
  }

  console.log('\nFor the following entities the user reference will be nulled (rows are kept):');
  let totalNulled = 0;
  for (const [table, column, label] of SET_NULL_TABLES) {
    const { rows } = await query(`SELECT count(*)::int AS n FROM ${table} WHERE ${column} = ANY($1::uuid[])`, [
      userIds,
    ]);
    const { n } = rows[0];
    totalNulled += n;
    if (n > 0) {
      console.log(`  - ${label}: ${n}`);
    }
  }
  if (totalNulled === 0) {
    console.log('  (no such rows)');
  }
}

// Ask for confirmation in the console. Returns true only when "yes" is typed.
function confirm(promptText) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'yes');
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const users = await findUsers(args);

  if (users.length === 0) {
    console.log('No users found for the given criteria. Nothing deleted.');
    return;
  }

  console.log(`Users found for deletion: ${users.length}`);
  for (const u of users) {
    const ext = u.external_id || '—';
    const name = u.display_name || '—';
    console.log(`  - ${u.id}  external_id=${ext}  name=${name}`);
  }

  const userIds = users.map((u) => u.id);
  await reportRelated(userIds);

  if (!args.yes) {
    const word = users.length === 1 ? 'this user' : `these users (${users.length})`;
    const ok = await confirm(`\nDelete ${word} and all related data? Type "yes" to confirm: `);
    if (!ok) {
      console.log('Cancelled. Nothing deleted.');
      return;
    }
  }

  // The whole deletion runs in one transaction. Cascading foreign keys remove related rows,
  // SET NULL rules null the references in the tables that are kept.
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query('DELETE FROM mem.users WHERE id = ANY($1::uuid[])', [userIds]);
    await client.query('COMMIT');
    console.log(`\nDone. Users deleted: ${rowCount}. Related data removed via cascade.`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

main()
  .catch((err) => {
    console.error('Deletion error:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
