// Layered export of the LLM request log (log.llm_request) for the tuning workflow
// (claudedocs/self-tuning-infrastructure.md §3.1). Designed around context economy (§2a):
// the default output is a compact metadata table; full payload/response content is printed
// only for explicitly addressed records (--id) or with an explicit --limit.
//
// Layer 1 — overview (metadata only, no payload):
//   node scripts/llm-log-export.js --last 20 --kind main_agent_answer
//   node scripts/llm-log-export.js --request-id <uuid>
//   node scripts/llm-log-export.js --kind intent_classify --errors-only --since 2026-06-12
//
// Layer 2 — details of selected records:
//   node scripts/llm-log-export.js --id 18234 --fields payload.messages,response
//   node scripts/llm-log-export.js --id 18234,18260 --max-chars 2000
//   node scripts/llm-log-export.js --id 18234 --full
//
// Content search WITHOUT pulling content into the caller's context (returns id + matched fragment):
//   node scripts/llm-log-export.js --kind fact_extract --grep "паспорт" --last 200
//
// Other flags:
//   --user <id>        filter by user_id
//   --since/--until    ISO date or datetime bounds on created_at
//   --errors-only      only records with status <> 'ok'
//   --test-only        only is_test records; --exclude-test — only production records
//   --full             full payload/response; allowed ONLY with --id or an explicit --limit N
//   --limit N          hard cap of detail records for --full without --id (keep it small)
//   --fields a,b       jsonb paths to print (payload.messages, payload.tools, response.choices, ...)
//   --max-chars N      truncate long string values with a marker (default 2000 in detail mode)
//   --json             machine-readable JSON output instead of Markdown

import { queryLog, closePool } from '../src/db.js';

const OVERVIEW_COLUMNS = `llm_request_id, created_at, request_id, request_kind, model, prompt_tokens,
  completion_tokens, total_tokens, price_usd, duration_ms, status, payload_truncated, response_truncated,
  is_test, git_commit, prompt_hash`;

function splitList(value) {
  return (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const args = {
    ids: [],
    fields: [],
    kind: null,
    requestId: null,
    user: null,
    since: null,
    until: null,
    grep: null,
    last: 20,
    limit: null,
    maxChars: null,
    errorsOnly: false,
    testOnly: false,
    excludeTest: false,
    full: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--id') {
      args.ids.push(...splitList(argv[++i]));
    } else if (token === '--fields') {
      args.fields.push(...splitList(argv[++i]));
    } else if (token === '--kind') {
      args.kind = argv[++i];
    } else if (token === '--request-id') {
      args.requestId = argv[++i];
    } else if (token === '--user') {
      args.user = argv[++i];
    } else if (token === '--since') {
      args.since = argv[++i];
    } else if (token === '--until') {
      args.until = argv[++i];
    } else if (token === '--grep') {
      args.grep = argv[++i];
    } else if (token === '--last') {
      args.last = Number(argv[++i]) || 20;
    } else if (token === '--limit') {
      args.limit = Number(argv[++i]) || null;
    } else if (token === '--max-chars') {
      args.maxChars = Number(argv[++i]) || null;
    } else if (token === '--errors-only') {
      args.errorsOnly = true;
    } else if (token === '--test-only') {
      args.testOnly = true;
    } else if (token === '--exclude-test') {
      args.excludeTest = true;
    } else if (token === '--full') {
      args.full = true;
    } else if (token === '--json') {
      args.json = true;
    } else {
      console.error(`Unknown flag: ${token}`);
      process.exit(2);
    }
  }
  return args;
}

// Build the WHERE clause from shared filters. Returns { where, params }.
function buildFilters(args) {
  const conds = [];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    conds.push(sql.replace('?', `$${params.length}`));
  };
  if (args.kind) {
    add('request_kind = ?', args.kind);
  }
  if (args.requestId) {
    add('request_id = ?', args.requestId);
  }
  if (args.user) {
    add('user_id = ?', args.user);
  }
  if (args.since) {
    add('created_at >= ?', args.since);
  }
  if (args.until) {
    add('created_at < ?', args.until);
  }
  if (args.errorsOnly) {
    conds.push(`status <> 'ok'`);
  }
  if (args.testOnly) {
    conds.push('is_test');
  }
  if (args.excludeTest) {
    conds.push('NOT is_test');
  }
  return { where: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params };
}

// Resolve a dotted path (payload.messages) inside a row whose payload/response are already objects.
function pickPath(row, dotted) {
  const parts = dotted.split('.');
  let node = row;
  for (const part of parts) {
    if (node == null || typeof node !== 'object') {
      return undefined;
    }
    node = node[part];
  }
  return node;
}

// Recursively truncate long string values with an explicit marker, so the output stays bounded.
function truncateDeep(value, maxChars) {
  if (typeof value === 'string') {
    return value.length > maxChars ? `${value.slice(0, maxChars)}…[truncated ${value.length} chars]` : value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => truncateDeep(v, maxChars));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = truncateDeep(v, maxChars);
    }
    return out;
  }
  return value;
}

function fmtTs(ts) {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
}

function fmtPrice(p) {
  return p == null ? '' : Number(p).toFixed(6);
}

function printOverview(rows, asJson) {
  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (!rows.length) {
    console.log('No records matched the filter.');
    return;
  }
  console.log('| id | created_at | kind | model | tokens p/c/t | price_usd | ms | status | request_id | flags |');
  console.log('|----|------------|------|-------|--------------|-----------|----|--------|------------|-------|');
  for (const r of rows) {
    const flags = [r.is_test ? 'test' : '', r.payload_truncated || r.response_truncated ? 'trunc' : '']
      .filter(Boolean)
      .join(',');
    const tokens = `${r.prompt_tokens ?? ''}/${r.completion_tokens ?? ''}/${r.total_tokens ?? ''}`;
    console.log(
      `| ${r.llm_request_id} | ${fmtTs(r.created_at)} | ${r.request_kind} | ${r.model ?? ''} | ${tokens} | ${fmtPrice(r.price_usd)} | ${r.duration_ms ?? ''} | ${r.status} | ${r.request_id ?? ''} | ${flags} |`,
    );
  }
  const price = rows.reduce((s, r) => s + Number(r.price_usd || 0), 0);
  const tokens = rows.reduce((s, r) => s + Number(r.total_tokens || 0), 0);
  console.log(`\nTotal: ${rows.length} records, ${tokens} tokens, $${price.toFixed(6)}.`);
}

async function runOverview(args) {
  const { where, params } = buildFilters(args);
  const { rows } = await queryLog(
    `SELECT ${OVERVIEW_COLUMNS} FROM log.llm_request ${where} ORDER BY created_at DESC LIMIT ${args.last}`,
    params,
  );
  printOverview(rows.reverse(), args.json);
}

// Content search executed inside PostgreSQL: only ids, metadata and a short fragment around the first
// match reach stdout — the payloads themselves are never pulled out.
async function runGrep(args) {
  const { where, params } = buildFilters(args);
  params.push(args.grep);
  const needle = `$${params.length}`;
  const { rows } = await queryLog(
    `WITH scope AS (
       SELECT llm_request_id, created_at, request_kind, model, status, payload::text AS p, response::text AS r
         FROM log.llm_request ${where} ORDER BY created_at DESC LIMIT ${args.last}
     )
     SELECT llm_request_id, created_at, request_kind, model, status,
            substring(p FROM greatest(position(lower(${needle}) IN lower(p)) - 60, 1) FOR 160) AS payload_fragment,
            substring(r FROM greatest(position(lower(${needle}) IN lower(r)) - 60, 1) FOR 160) AS response_fragment,
            position(lower(${needle}) IN lower(p)) > 0 AS in_payload,
            position(lower(${needle}) IN lower(coalesce(r, ''))) > 0 AS in_response
       FROM scope
      WHERE position(lower(${needle}) IN lower(p)) > 0 OR position(lower(${needle}) IN lower(coalesce(r, ''))) > 0
      ORDER BY created_at`,
    params,
  );
  if (args.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (!rows.length) {
    console.log(`No matches for "${args.grep}" in the last ${args.last} records of the scope.`);
    return;
  }
  for (const r of rows) {
    const where2 = [r.in_payload ? 'payload' : '', r.in_response ? 'response' : ''].filter(Boolean).join('+');
    console.log(`\n## id ${r.llm_request_id} — ${fmtTs(r.created_at)} ${r.request_kind} ${r.model ?? ''} (${where2})`);
    const fragment = r.in_payload ? r.payload_fragment : r.response_fragment;
    console.log('```');
    console.log(`…${String(fragment).replace(/\s+/g, ' ')}…`);
    console.log('```');
  }
  console.log(`\nMatches: ${rows.length}. Details: node scripts/llm-log-export.js --id <id> --max-chars 2000`);
}

async function runDetails(args) {
  let rows;
  if (args.ids.length) {
    ({ rows } = await queryLog(
      `SELECT * FROM log.llm_request WHERE llm_request_id = ANY($1::bigint[]) ORDER BY created_at`,
      [args.ids],
    ));
  } else {
    // --full over a broad filter requires an explicit small --limit (§2a guard).
    const { where, params } = buildFilters(args);
    ({ rows } = await queryLog(
      `SELECT * FROM log.llm_request ${where} ORDER BY created_at DESC LIMIT ${args.limit}`,
      params,
    ));
    rows.reverse();
  }
  // Default truncation in detail mode keeps single records bounded; --full disables it.
  const maxChars = args.full ? null : (args.maxChars ?? 2000);
  const shaped = rows.map((row) => {
    let out = row;
    if (args.fields.length) {
      out = { llm_request_id: row.llm_request_id, request_kind: row.request_kind };
      for (const field of args.fields) {
        out[field] = pickPath(row, field);
      }
    }
    return maxChars ? truncateDeep(out, maxChars) : out;
  });
  if (args.json) {
    console.log(JSON.stringify(shaped, null, 2));
    return;
  }
  for (const r of shaped) {
    console.log(`\n## Record ${r.llm_request_id} (${r.request_kind})`);
    console.log('```json');
    console.log(JSON.stringify(r, null, 2));
    console.log('```');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.full && !args.ids.length && !args.limit) {
    console.error('--full without --id requires an explicit --limit N (context-economy guard, §2a).');
    process.exit(2);
  }
  if (args.grep) {
    await runGrep(args);
  } else if (args.ids.length || args.full || args.fields.length || args.maxChars) {
    if (!args.ids.length && !args.limit) {
      console.error('Detail mode over a broad filter requires --limit N (or address records with --id).');
      process.exit(2);
    }
    await runDetails(args);
  } else {
    await runOverview(args);
  }
}

main()
  .catch((err) => {
    console.error('Export error:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
