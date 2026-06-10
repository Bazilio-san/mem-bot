// Модульные тесты общего буферного механизма журналов (src/pipeline/log-writer.js): пакетная вставка,
// ранний слив, возврат неудавшегося пакета, переполнение буфера и усечение JSON (truncateJson).
// Реальная БД не используется — функция записи подменяется через setDbQueryForTests.
import assert from 'node:assert/strict';
import { createBatchWriter, truncateJson } from '../src/pipeline/log-writer.js';

const SETTINGS = { batchSize: 200, flushIntervalMs: 60_000 };

function makeWriter(capture) {
  const writer = createBatchWriter({
    table: 'log.test_table',
    columns: ['a', 'b', 'data'],
    jsonbColumns: ['data'],
    getSettings: () => SETTINGS,
  });
  writer.setDbQueryForTests(capture);
  return writer;
}

// 1. Записи буферизуются и уходят одним multi-row INSERT с плейсхолдерами ::jsonb для jsonb-колонок.
{
  const captured = [];
  const writer = makeWriter(async (sql, values) => {
    captured.push({ sql, values });
  });
  writer.push({ a: 1, b: 'x', data: '{"k":1}' });
  writer.push({ a: 2, b: 'y', data: null });
  await writer.flush();

  assert.equal(captured.length, 1, 'обе записи должны уйти одним пакетом');
  assert.ok(captured[0].sql.includes('INSERT INTO log.test_table (a,b,data)'));
  assert.ok(captured[0].sql.includes('$3::jsonb'), 'jsonb-колонка получает приведение типа');
  assert.equal(captured[0].values.length, 6, 'три колонки на две строки');
}

// 2. Ошибка вставки не бросается наружу; пакет возвращается в буфер и уходит при следующем сливе.
{
  let failNext = true;
  const captured = [];
  const writer = makeWriter(async (sql, values) => {
    if (failNext) {
      failNext = false;
      throw new Error('БД временно недоступна');
    }
    captured.push(values);
  });
  writer.push({ a: 1, b: 'x', data: null });
  await assert.doesNotReject(writer.flush());
  assert.equal(captured.length, 0, 'после ошибки запись не записана');
  await writer.flush();
  assert.equal(captured.length, 1, 'после восстановления БД запись выгружается');
}

// 3. Ранний слив: при накоплении 50 записей выгрузка стартует сама, без явного flush и без таймера.
{
  const captured = [];
  const writer = makeWriter(async (sql, values) => {
    captured.push(values);
  });
  for (let i = 0; i < 50; i++) {
    writer.push({ a: i, b: 'x', data: null });
  }
  // Слив асинхронный — даём микрозадачам выполниться.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(captured.length >= 1, 'ранний слив должен сработать на пороге 50 записей');
  const total = captured.reduce((s, v) => s + v.length / 3, 0);
  assert.equal(total, 50, 'все 50 записей выгружены');
}

// 4. Переполнение буфера: при недоступной БД свыше 5000 записей не накапливается — лишние отбрасываются
// с предупреждением, а после восстановления БД выгружается ровно 5000 уникальных записей.
{
  let blocked = true;
  const captured = [];
  const writer = makeWriter(async (sql, values) => {
    if (blocked) {
      throw new Error('недоступна');
    }
    captured.push(values);
  });
  for (let i = 0; i < 5100; i++) {
    writer.push({ a: i, b: 'x', data: null });
  }
  // Даём завершиться раннему сливу, начатому посреди цикла (он вернёт свой пакет в буфер с ошибкой).
  await new Promise((resolve) => setTimeout(resolve, 30));
  blocked = false;
  await writer.flush();
  const rows = captured.flatMap((v) => {
    const out = [];
    for (let i = 0; i < v.length; i += 3) {
      out.push(v[i]);
    }
    return out;
  });
  assert.equal(rows.length, 5000, 'после переполнения в буфере остаётся ровно 5000 записей');
  assert.equal(new Set(rows).size, rows.length, 'записи не дублируются');
}

// 5. truncateJson: короткое значение проходит без изменений, длинные строки внутри обрезаются.
{
  const small = truncateJson({ a: 'короткий текст' }, 1000);
  assert.equal(small.truncated, false);
  assert.deepEqual(JSON.parse(small.json), { a: 'короткий текст' });

  const long = truncateJson({ msg: 'я'.repeat(50_000), nested: { deep: 'ё'.repeat(50_000) } }, 10_000);
  assert.equal(long.truncated, true, 'превышение лимита поднимает флаг');
  const parsed = JSON.parse(long.json);
  assert.ok(parsed.msg.length < 50_000, 'длинная строка верхнего уровня обрезана');
  assert.ok(parsed.nested.deep.length < 50_000, 'длинная строка во вложенном объекте обрезана');
  assert.ok(parsed.msg.includes('chars]'), 'обрезка помечена явным маркером');
}

// 6. truncateJson: несериализуемое значение не роняет запись — сохраняется маркер ошибки.
{
  const cyclic = {};
  cyclic.self = cyclic;
  const res = truncateJson(cyclic, 1000);
  assert.equal(res.truncated, true);
  assert.deepEqual(JSON.parse(res.json), { error: 'payload is not serializable' });

  const empty = truncateJson(null, 1000);
  assert.equal(empty.json, null);
  assert.equal(empty.truncated, false);
}

// 7. Крайний случай: даже после обрезки строк объект больше лимита — сохраняется усечённый снимок строкой.
{
  const wide = {};
  for (let i = 0; i < 2000; i++) {
    wide[`key_${i}`] = 'значение';
  }
  const res = truncateJson(wide, 500);
  assert.equal(res.truncated, true);
  const parsed = JSON.parse(res.json);
  assert.ok(typeof parsed._truncated === 'string', 'сохранён усечённый снимок');
  assert.ok(res.json.length <= 700, 'итоговый размер около лимита');
}

console.log('log-writer.test.mjs: ok');
