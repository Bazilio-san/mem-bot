// Обёртка над пулом подключений PostgreSQL.
import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

let pool = null;

export function getPool() {
  if (!pool) {
    pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
  }
  return pool;
}

// Выполнить запрос к рабочей БД памяти.
export async function query(text, params) {
  return getPool().query(text, params);
}

// Преобразовать массив чисел в строковый литерал вектора pgvector: [0.1,0.2,...].
export function vectorToSql(vector) {
  return `[${vector.join(',')}]`;
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
