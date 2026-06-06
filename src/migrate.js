// Бутстрап БД памяти: создаёт целевую базу (если её нет) и применяет миграции.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from './config.js';
import { getPool } from './db.js';

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, '..', 'migrations');

async function ensureDatabase() {
  const admin = new Client({ connectionString: config.adminDatabaseUrl });
  await admin.connect();
  const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [config.memDbName]);
  if (rows.length === 0) {
    await admin.query(`CREATE DATABASE ${config.memDbName}`);
    console.log(`Создана база данных «${config.memDbName}».`);
  } else {
    console.log(`База данных «${config.memDbName}» уже существует — повторное создание не требуется.`);
  }
  await admin.end();
}

async function applyMigrations() {
  const pool = getPool();
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await pool.query(sql);
    console.log(`Применена миграция: ${file}`);
  }
}

async function main() {
  await ensureDatabase();
  await applyMigrations();
  console.log('Миграции применены успешно. Схема памяти готова к работе.');
  await getPool().end();
}

main().catch((err) => {
  console.error('Ошибка миграции:', err);
  process.exit(1);
});
