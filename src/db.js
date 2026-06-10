// Wrapper around the PostgreSQL connection pool. Database access goes through the af-db-ts package: it reads the
// connection parameters itself from node-config at the path db.postgres.dbs.<connectionId> (the working memory DB
// is aliased 'main'). The thin query()/getPool() wrappers keep the previous contract, so consumers do not change.
// config.js is imported FIRST: its bootstrap loader populates process.env from .env and initializes
// node-config before the af-db-ts package reads the configuration tree during its own import.
import { config } from './config.js';
import pg from 'pg';
import { registerTypes as registerPgvector } from 'pgvector/pg';
import { queryPg, getPoolPg, getDbConfigPg, closeAllDb } from 'af-db-ts';

// Logical name of the working connection to the memory DB.
const CONNECTION_ID = 'main';
// Logical name of the connection to the separate logs DB (LLM request journal + agent events).
const LOG_CONNECTION_ID = 'logs';

// Credential inheritance for the logs DB: in a typical install both databases live on the same PostgreSQL
// server, so empty host/port/user/password of the 'logs' connection are filled from 'main'. The mutation
// targets af-db-ts's own config store (getDbConfigPg returns a live reference) and runs at module load —
// before any pool is created. Explicit values in local.yaml or the environment stay untouched.
{
  const logsCfg = getDbConfigPg(LOG_CONNECTION_ID, false, false);
  const mainCfg = getDbConfigPg(CONNECTION_ID, false, false);
  if (logsCfg && mainCfg) {
    for (const key of ['host', 'port', 'user', 'password']) {
      if (logsCfg[key] === '' || logsCfg[key] == null) {
        logsCfg[key] = mainCfg[key];
      }
    }
  }
}

// pgvector is registered manually: af-db-ts does not enable it automatically. We pass the vector-type
// registration function only if the extension is declared in the working connection's usedExtensions. Then
// vector columns are returned as number[]. The functions are called once when the pool is created (per new client).
const registerTypesFunctions = config.db.postgres.dbs[CONNECTION_ID]?.usedExtensions?.includes('pgvector')
  ? [registerPgvector]
  : [];

const REQUIRED_CONNECTIONS = [
  { id: CONNECTION_ID, title: 'main memory database (main)' },
  { id: LOG_CONNECTION_ID, title: 'LLM/events log database (logs)' },
];

function getDbHintByCode(code, dbConfig) {
  if (code === '3D000') {
    return `База "${dbConfig.database}" не существует. Создайте её в PostgreSQL или исправьте db.postgres.dbs.${dbConfig.id}.database.`;
  }
  if (code === '28P01') {
    return `Неверный пароль для пользователя "${dbConfig.user}".`;
  }
  if (code === '3D01' || code === '28000') {
    return `Неверная роль/метод аутентификации для пользователя "${dbConfig.user}".`;
  }
  if (code === 'ECONNREFUSED') {
    return `PostgreSQL недоступен по ${dbConfig.host}:${dbConfig.port}.`;
  }
  if (code === 'ENOTFOUND') {
    return `Host "${dbConfig.host}" неразрешим.`;
  }
  return 'Проверьте host/port/database/user/password и доступность PostgreSQL.';
}

function normalizePgError(connectionId, err) {
  const cfg = getDbConfigPg(connectionId, false, true);
  const dbConfig = {
    id: connectionId,
    database: cfg?.database || '<not set>',
    user: cfg?.user || '<not set>',
    host: cfg?.host || '<not set>',
    port: cfg?.port || '<not set>',
  };
  const code = err?.code || 'UNKNOWN';
  const rawMessage = String(err?.message || '').split('\\n')[0];
  const hint = getDbHintByCode(code, dbConfig);
  return `[${connectionId}] ${rawMessage} (database="${dbConfig.database}", user="${dbConfig.user}", host="${dbConfig.host}:${dbConfig.port}", hint=${hint})`;
}

async function probeConnection(connectionId) {
  const cfg = getDbConfigPg(connectionId, false, true);
  if (!cfg?.host || !cfg?.database || !cfg?.user) {
    throw new Error(`Неполная конфигурация PostgreSQL для ${connectionId}: host/database/user должны быть заданы.`);
  }
  const client = new pg.Client(cfg);
  try {
    await client.connect();
    await client.query('SELECT 1');
  } finally {
    await client.end().catch(() => {});
  }
}

export async function assertDatabasesAvailable() {
  const failures = [];
  for (const target of REQUIRED_CONNECTIONS) {
    try {
      await probeConnection(target.id);
    } catch (err) {
      failures.push(normalizePgError(target.id, err));
    }
  }

  if (failures.length === 0) {
    return;
  }

  const lines = [
    'Не удалось пройти стартовую проверку доступа к базам: PostgreSQL недоступна.',
    'Исправьте указанные проблемы и перезапустите сервис:',
    ...failures.map((f) => `- ${f}`),
  ];
  throw new Error(lines.join('\\n'));
}

// Get the (cached) pg pool of the working memory DB. Asynchronous: on first access af-db-ts creates the pool
// and immediately opens the first connection for early detection of connection errors.
export function getPool() {
  return getPoolPg({ connectionId: CONNECTION_ID, registerTypesFunctions });
}

// Run a query against the working memory DB. throwError: true keeps the previous behavior — the error is
// propagated to the caller rather than silently swallowed.
export async function query(text, params) {
  return queryPg({
    connectionId: CONNECTION_ID,
    sqlText: text,
    sqlValues: params,
    throwError: true,
    registerTypesFunctions,
  });
}

// Get the (cached) pg pool of the logs DB. Lives separately from the memory DB so that fast-growing journals
// (log.llm_request, log.agent_event) do not bloat user data and can have their own backup/retention policy.
export function getLogPool() {
  return getPoolPg({ connectionId: LOG_CONNECTION_ID });
}

// Run a query against the logs DB. The journals have no pgvector columns, so no type registration is needed.
export async function queryLog(text, params) {
  return queryPg({
    connectionId: LOG_CONNECTION_ID,
    sqlText: text,
    sqlValues: params,
    throwError: true,
  });
}

// Send an asynchronous PostgreSQL notification over a channel (the NOTIFY command). Used to instantly
// wake the waiting scheduler worker when a new task appears. The channel name is a fixed
// identifier from the code, not user input, so it is safe to substitute directly into the query text
// (NOTIFY does not accept placeholder parameters).
export async function notify(channel) {
  await query(`NOTIFY ${channel}`);
}

// Create a dedicated connection subscribed to a PostgreSQL async notification channel (the LISTEN command).
// This connection lives separately from the af-db-ts pool: the pool reuses connections for ordinary queries,
// while here we need one permanently open connection that only listens. The connection parameters are taken
// from the same configuration via getDbConfigPg('main'). On a connection drop the subscription is restored
// automatically. Returns an object with a `ready` promise (readiness of the first subscription) and a `close()`
// method to stop it.
export function createListener(channel, onNotification) {
  let client = null;
  let stopped = false;
  let reconnecting = false;

  async function connect() {
    reconnecting = false;
    const params = getDbConfigPg(CONNECTION_ID, false, true);
    client = new pg.Client(params);
    client.on('notification', () => onNotification());
    client.on('error', scheduleReconnect);
    client.on('end', scheduleReconnect);
    await client.connect();
    await client.query(`LISTEN ${channel}`);
  }

  // Reconnect after a small delay to avoid looping on instantly repeating failures.
  function scheduleReconnect() {
    if (stopped || reconnecting) {
      return;
    }
    reconnecting = true;
    setTimeout(() => {
      if (!stopped) {
        connect().catch(scheduleReconnect);
      }
    }, 1000);
  }

  const ready = connect().catch(scheduleReconnect);

  return {
    ready,
    async close() {
      stopped = true;
      if (client) {
        await client.end().catch(() => {});
      }
    },
  };
}

// Convert an array of numbers into a pgvector string literal: [0.1,0.2,...].
export function vectorToSql(vector) {
  return `[${vector.join(',')}]`;
}

// Close all af-db-ts connection pools (working and service) when the process stops.
export async function closePool() {
  await closeAllDb();
}
