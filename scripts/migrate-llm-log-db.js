// Одноразовый перенос исторических журналов из рабочей БД (mem_bot, схема log.*) в отдельную БД логов
// (mem_bot_logs). Нужен установкам, где журналы успели накопиться в старом месте до разделения баз.
// Переносит log.llm_request и log.llm_usage порциями, сохраняя значения первичных ключей, и по завершении
// выравнивает последовательности bigserial в целевой базе. Триггер llm_request_to_usage на время вставки
// отключается, иначе перенесённые строки llm_request породили бы дубликаты в llm_usage.
// Скрипт идемпотентен по принципу "не трогать существующее": строки с уже занятыми id пропускаются
// (ON CONFLICT DO NOTHING), так что повторный запуск безопасен.
// Запуск: node scripts/migrate-llm-log-db.js (миграции обеих баз должны быть применены: npm run migrate).
import '../src/config.js';
import { query, queryLog, closePool } from '../src/db.js';

const BATCH = 1000;

// Перенести одну таблицу порциями по возрастанию первичного ключа. Возвращает число перенесённых строк.
async function copyTable({ table, pk, columns }) {
  const colList = columns.join(', ');
  let lastId = 0;
  let copied = 0;
  for (;;) {
    const { rows } = await query(
      `SELECT ${pk}, ${colList} FROM ${table} WHERE ${pk} > $1 ORDER BY ${pk} LIMIT ${BATCH}`,
      [lastId],
    );
    if (rows.length === 0) {
      break;
    }
    const values = [];
    const tuples = rows.map((row) => {
      const cells = [pk, ...columns].map((col) => {
        const v = row[col];
        // jsonb приходит из pg уже распарсенным объектом — сериализуем обратно для вставки.
        values.push(v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v);
        return `$${values.length}`;
      });
      return `(${cells.join(',')})`;
    });
    await queryLog(
      `INSERT INTO ${table} (${pk}, ${colList}) VALUES ${tuples.join(',')} ON CONFLICT (${pk}) DO NOTHING`,
      values,
    );
    lastId = rows[rows.length - 1][pk];
    copied += rows.length;
    console.log(`${table}: перенесено ${copied} строк (последний ${pk} = ${lastId})…`);
  }
  return copied;
}

// Выровнять последовательность bigserial по максимальному id, чтобы новые вставки не конфликтовали.
async function fixSequence(table, pk) {
  await queryLog(
    `SELECT setval(pg_get_serial_sequence('${table}', '${pk}'), COALESCE((SELECT MAX(${pk}) FROM ${table}), 0) + 1, false)`,
  );
}

async function main() {
  // Проверка, что в старой базе вообще есть что переносить.
  const { rows: existing } = await query(
    `SELECT to_regclass('log.llm_request') AS req, to_regclass('log.llm_usage') AS usage`,
  );
  if (!existing[0].req) {
    console.log('В рабочей БД нет таблицы log.llm_request — переносить нечего.');
    return;
  }

  console.log('Отключаю триггер llm_request_to_usage в БД логов на время переноса…');
  await queryLog('ALTER TABLE log.llm_request DISABLE TRIGGER llm_request_to_usage_trg');
  try {
    const reqCount = await copyTable({
      table: 'log.llm_request',
      pk: 'llm_request_id',
      columns: [
        'created_at',
        'request_id',
        'request_kind',
        'endpoint',
        'provider',
        'model',
        'model_priced',
        'user_id',
        'conversation_id',
        'domain_key',
        'channel',
        'is_binary',
        'payload',
        'binary_meta',
        'payload_truncated',
        'prompt_tokens',
        'completion_tokens',
        'total_tokens',
        'price_usd',
        'duration_ms',
        'status',
        'error',
        'is_test',
      ],
    });
    const usageCount = existing[0].usage
      ? await copyTable({
          table: 'log.llm_usage',
          pk: 'llm_usage_id',
          columns: [
            'created_at',
            'llm_request_id',
            'request_kind',
            'model',
            'user_id',
            'prompt_tokens',
            'completion_tokens',
            'total_tokens',
            'price_usd',
            'duration_ms',
            'is_test',
          ],
        })
      : 0;
    await fixSequence('log.llm_request', 'llm_request_id');
    await fixSequence('log.llm_usage', 'llm_usage_id');
    console.log(`Готово: llm_request — ${reqCount} строк, llm_usage — ${usageCount} строк.`);
    console.log('Старые таблицы log.* в рабочей БД больше не используются — их можно удалить вручную:');
    console.log('  DROP TABLE log.llm_usage, log.llm_request; DROP FUNCTION log.llm_request_to_usage();');
  } finally {
    await queryLog('ALTER TABLE log.llm_request ENABLE TRIGGER llm_request_to_usage_trg');
  }
}

main()
  .catch((err) => {
    console.error('Ошибка переноса журналов:', err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
