// Бутстрап БД памяти: создаёт целевую базу (если её нет) и применяет миграции.
// Создание базы выполняется через служебное подключение к базе 'postgres' (алиас 'bootstrap'),
// миграции — через рабочее подключение к БД памяти (алиас 'main'). Оба подключения описаны в node-config.
// config.js импортируется ПЕРВЫМ среди прикладных модулей: его bootstrap-загрузчик наполняет process.env
// из .env и инициализирует node-config до того, как пакет af-db-ts на этапе импорта прочитает конфигурацию.
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

// Имя рабочей БД памяти, которую нужно создать.
const memDbName = config.db.postgres.dbs.main.database;

async function ensureDatabase() {
  // Служебное подключение к базе 'postgres': те же хост и креды, что у рабочего подключения, но другая база.
  const admin = new Client(getDbConfigPg('bootstrap', false, true));
  await admin.connect();
  const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [memDbName]);
  if (rows.length === 0) {
    await admin.query(`CREATE DATABASE ${memDbName}`);
    console.log(`Создана база данных «${memDbName}».`);
  } else {
    console.log(`База данных «${memDbName}» уже существует — повторное создание не требуется.`);
  }
  await admin.end();

  // Расширения создаём здесь, до первого обращения к пулу рабочего подключения. Пул через pgvector
  // регистрирует тип vector сразу при открытии соединения, поэтому на абсолютно чистой базе getPool()
  // упал бы с ошибкой «vector type not found», если бы расширение ещё не существовало. CREATE EXTENSION
  // нельзя выполнить служебным подключением к базе 'postgres' — расширение ставится в саму базу памяти,
  // поэтому открываем отдельное прямое подключение к ней. Идемпотентно (IF NOT EXISTS).
  const memClient = new Client(getDbConfigPg('main', false, true));
  await memClient.connect();
  await memClient.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await memClient.query('CREATE EXTENSION IF NOT EXISTS vector');
  await memClient.end();
  console.log('Расширения pgcrypto и vector готовы.');
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
    console.log(`Применена миграция: ${file}`);
  }
}

async function main() {
  await ensureDatabase();
  await applyMigrations();
  console.log('Миграции применены успешно. Схема памяти готова к работе.');
  const pool = await getPool();
  await pool.end();
}

main().catch((err) => {
  console.error('Ошибка миграции:', err);
  process.exit(1);
});
