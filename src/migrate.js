// Memory DB bootstrap: creates the target database (if it does not exist) and applies migrations.
// Database creation runs through a service connection to the 'postgres' database (alias 'bootstrap'),
// migrations run through the working connection to the memory DB (alias 'main'). Both connections are described in
// node-config. config.js is imported FIRST among the application modules: its bootstrap loader populates process.env
// from .env and initializes node-config before the af-db-ts package reads the configuration at import time.
import { config } from './config.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { getDbConfigPg } from 'af-db-ts';
import { getPool } from './db.js';

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, '..', 'migrations');

// Name of the working memory DB that needs to be created.
const memDbName = config.db.postgres.dbs.main.database;

async function ensureDatabase() {
  // Service connection to the 'postgres' database: same host and credentials as the working connection, but a
  // different database.
  const admin = new Client(getDbConfigPg('bootstrap', false, true));
  await admin.connect();
  const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [memDbName]);
  if (rows.length === 0) {
    await admin.query(`CREATE DATABASE ${memDbName}`);
    console.log(`Created database "${memDbName}".`);
  } else {
    console.log(`Database "${memDbName}" already exists — no need to create it again.`);
  }
  await admin.end();

  // Create the extensions here, before the first access to the working connection pool. The pool, via pgvector,
  // registers the vector type as soon as a connection is opened, so on a completely clean database getPool()
  // would fail with the "vector type not found" error if the extension did not yet exist. CREATE EXTENSION
  // cannot be run through the service connection to the 'postgres' database — the extension is installed into the
  // memory database itself, so we open a separate direct connection to it. Idempotent (IF NOT EXISTS).
  const memClient = new Client(getDbConfigPg('main', false, true));
  await memClient.connect();
  await memClient.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await memClient.query('CREATE EXTENSION IF NOT EXISTS vector');
  await memClient.end();
  console.log('Extensions pgcrypto and vector are ready.');
}

async function applyMigrations() {
  const pool = await getPool();
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await pool.query(sql);
    console.log(`Applied migration: ${file}`);
  }
}

async function main() {
  await ensureDatabase();
  await applyMigrations();
  console.log('Migrations applied successfully. The memory schema is ready to use.');
  const pool = await getPool();
  await pool.end();
}

main().catch((err) => {
  console.error('Migration error:', err);
  process.exit(1);
});
