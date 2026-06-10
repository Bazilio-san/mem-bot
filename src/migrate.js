// Memory DB bootstrap: creates the target databases (if they do not exist) and applies migrations.
// Database creation runs through a service connection to the 'postgres' database (alias 'bootstrap');
// migrations run through the working connections: the memory DB (alias 'main', migrations/) and the
// separate logs DB (alias 'logs', migrations-log/). All connections are described in node-config.
// config.js is imported FIRST among the application modules: its bootstrap loader populates process.env
// from .env and initializes node-config before the af-db-ts package reads the configuration at import time.
import { config } from './config.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { getDbConfigPg } from 'af-db-ts';
import { getPool, getLogPool } from './db.js';

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, '..', 'migrations');
const logMigrationsDir = path.join(__dirname, '..', 'migrations-log');

// Names of the working databases that need to be created.
const memDbName = config.db.postgres.dbs.main.database;
const logDbName = config.db.postgres.dbs.logs.database;

// Create a database if it does not exist yet, through an already-open service connection.
async function createDbIfMissing(admin, dbName) {
  const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (rows.length === 0) {
    await admin.query(`CREATE DATABASE ${dbName}`);
    console.log(`Created database "${dbName}".`);
  } else {
    console.log(`Database "${dbName}" already exists — no need to create it again.`);
  }
}

async function ensureDatabases() {
  // Service connection to the 'postgres' database: same host and credentials as the working connection, but a
  // different database. Both working databases are created through it.
  const admin = new Client(getDbConfigPg('bootstrap', false, true));
  await admin.connect();
  await createDbIfMissing(admin, memDbName);
  await createDbIfMissing(admin, logDbName);
  await admin.end();

  // Create the extensions here, before the first access to the working connection pool. The pool, via pgvector,
  // registers the vector type as soon as a connection is opened, so on a completely clean database getPool()
  // would fail with the "vector type not found" error if the extension did not yet exist. CREATE EXTENSION
  // cannot be run through the service connection to the 'postgres' database — the extension is installed into the
  // memory database itself, so we open a separate direct connection to it. Idempotent (IF NOT EXISTS).
  // The logs DB needs no extensions: its tables are plain bigserial/jsonb.
  const memClient = new Client(getDbConfigPg('main', false, true));
  await memClient.connect();
  await memClient.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await memClient.query('CREATE EXTENSION IF NOT EXISTS vector');
  await memClient.end();
  console.log('Extensions pgcrypto and vector are ready.');
}

// Apply every *.sql file of a directory in name order through the given pool. Shared by both databases.
async function applyMigrationsFrom(dir, pool, label) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    await pool.query(sql);
    console.log(`Applied migration (${label}): ${file}`);
  }
}

async function main() {
  await ensureDatabases();
  await applyMigrationsFrom(migrationsDir, await getPool(), 'main');
  await applyMigrationsFrom(logMigrationsDir, await getLogPool(), 'logs');
  console.log('Migrations applied successfully. The memory and logs schemas are ready to use.');
  await (await getPool()).end();
  await (await getLogPool()).end();
}

main().catch((err) => {
  console.error('Migration error:', err);
  process.exit(1);
});
