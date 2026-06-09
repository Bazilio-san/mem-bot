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

// Послать асинхронное уведомление PostgreSQL по каналу (команда NOTIFY). Используется,
// чтобы мгновенно разбудить ожидающий воркер планировщика при появлении новой задачи.
// Имя канала — фиксированный идентификатор из кода, а не пользовательский ввод, поэтому
// его безопасно подставлять в текст запроса напрямую (NOTIFY не принимает параметры-плейсхолдеры).
export async function notify(channel) {
  await getPool().query(`NOTIFY ${channel}`);
}

// Создать выделенное подключение, подписанное на канал асинхронных уведомлений PostgreSQL
// (команда LISTEN). Это подключение живёт отдельно от пула: пул переиспользует соединения под
// обычные запросы, а здесь нужно одно постоянно открытое соединение, которое только слушает.
// При обрыве связи подписка восстанавливается автоматически. Возвращается объект с промисом
// `ready` (готовность первой подписки) и методом `close()` для корректной остановки.
export function createListener(channel, onNotification) {
  let client = null;
  let stopped = false;
  let reconnecting = false;

  async function connect() {
    reconnecting = false;
    client = new pg.Client({ connectionString: config.databaseUrl });
    client.on('notification', () => onNotification());
    client.on('error', scheduleReconnect);
    client.on('end', scheduleReconnect);
    await client.connect();
    await client.query(`LISTEN ${channel}`);
  }

  // Переподключиться с небольшой задержкой, чтобы не зациклиться на мгновенно повторяющихся сбоях.
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
