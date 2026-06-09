// Обёртка над пулом подключений PostgreSQL. Доступ к базе идёт через пакет af-db-ts: он сам читает параметры
// подключения из node-config по пути db.postgres.dbs.<connectionId> (рабочая БД памяти — алиас 'main').
// Тонкие обёртки query()/getPool() сохраняют прежний контракт, чтобы потребители не менялись.
// config.js импортируется ПЕРВЫМ: его bootstrap-загрузчик наполняет process.env из .env и инициализирует
// node-config до того, как пакет af-db-ts на этапе своего импорта прочитает дерево конфигурации.
import { config } from './config.js';
import pg from 'pg';
import { registerTypes as registerPgvector } from 'pgvector/pg';
import { queryPg, getPoolPg, getDbConfigPg, closeAllDb } from 'af-db-ts';

// Логическое имя рабочего подключения к БД памяти.
const CONNECTION_ID = 'main';

// pgvector регистрируется вручную: af-db-ts не включает его автоматически. Функцию регистрации типа vector
// передаём только если расширение объявлено в usedExtensions рабочего подключения. Тогда vector-колонки
// возвращаются как number[]. Функции вызываются один раз при создании пула (на каждом новом клиенте).
const registerTypesFunctions = config.db.postgres.dbs[CONNECTION_ID]?.usedExtensions?.includes('pgvector')
  ? [registerPgvector]
  : [];

// Получить (закэшированный) пул pg рабочей БД памяти. Асинхронно: af-db-ts при первом обращении создаёт пул
// и сразу открывает первое соединение для раннего обнаружения ошибок подключения.
export function getPool() {
  return getPoolPg({ connectionId: CONNECTION_ID, registerTypesFunctions });
}

// Выполнить запрос к рабочей БД памяти. throwError: true сохраняет прежнее поведение — ошибка пробрасывается
// вызывающему коду, а не молча глотается.
export async function query(text, params) {
  return queryPg({
    connectionId: CONNECTION_ID,
    sqlText: text,
    sqlValues: params,
    throwError: true,
    registerTypesFunctions,
  });
}

// Послать асинхронное уведомление PostgreSQL по каналу (команда NOTIFY). Используется, чтобы мгновенно
// разбудить ожидающий воркер планировщика при появлении новой задачи. Имя канала — фиксированный
// идентификатор из кода, а не пользовательский ввод, поэтому его безопасно подставлять в текст запроса
// напрямую (NOTIFY не принимает параметры-плейсхолдеры).
export async function notify(channel) {
  await query(`NOTIFY ${channel}`);
}

// Создать выделенное подключение, подписанное на канал асинхронных уведомлений PostgreSQL (команда LISTEN).
// Это подключение живёт отдельно от пула af-db-ts: пул переиспользует соединения под обычные запросы, а здесь
// нужно одно постоянно открытое соединение, которое только слушает. Параметры подключения берутся из той же
// конфигурации через getDbConfigPg('main'). При обрыве связи подписка восстанавливается автоматически.
// Возвращается объект с промисом `ready` (готовность первой подписки) и методом `close()` для остановки.
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

// Закрыть все пулы подключений af-db-ts (рабочий и служебный) при остановке процесса.
export async function closePool() {
  await closeAllDb();
}
