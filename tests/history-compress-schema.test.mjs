// Тесты строгой схемы суммаризатора истории (src/pipeline/history-compress.js): схема history_summary
// полностью строгая (prepareJsonSchema возвращает strict: true), facts_to_memory использует общую форму
// факта FACT_ITEM_SCHEMA из facts.js, factsToCandidates пропускает строгие элементы без изменений и
// страхует неполные элементы режима json_object, а заполненный state_json.notes печатается в HISTORY_CONTEXT.
// Без БД и LLM. Запуск: npm run test:history-compress-schema
import assert from 'node:assert/strict';
import { prepareJsonSchema } from '../src/llm.js';
import { FACT_ITEM_SCHEMA, FACT_TYPES } from '../src/pipeline/facts.js';
import { SUMMARY_SCHEMA, factsToCandidates } from '../src/pipeline/history-compress.js';
import { formatHistoryContext } from '../src/pipeline/history-context.js';

// 1. Схема history_summary строгая: свободных объектов не осталось, провайдер гарантирует структуру.
{
  const { schema, strict } = prepareJsonSchema(SUMMARY_SCHEMA);
  assert.equal(strict, true, 'схема history_summary должна быть strict');
  assert.equal(schema.properties.state_json.additionalProperties, false);
  assert.deepEqual(schema.properties.state_json.required, [
    'current_goal',
    'current_task',
    'decisions',
    'rejected_options',
    'open_questions',
    'constraints',
    'next_steps',
    'notes',
  ]);
}

// 2. facts_to_memory использует общую строгую форму факта — ту же, что извлечение фактов в facts.js.
{
  assert.equal(SUMMARY_SCHEMA.properties.facts_to_memory.items, FACT_ITEM_SCHEMA, 'одна точка истины');
  assert.equal(FACT_ITEM_SCHEMA.additionalProperties, false);
  assert.deepEqual(FACT_ITEM_SCHEMA.required, ['type', 'fact_text', 'confidence', 'ttl_days']);
  assert.deepEqual(FACT_ITEM_SCHEMA.properties.type.enum, FACT_TYPES);
  assert.equal(prepareJsonSchema(FACT_ITEM_SCHEMA).strict, true);
}

// 3. factsToCandidates пропускает строгие элементы как есть: тип, уверенность и ttl_days сохраняются.
{
  const out = factsToCandidates([
    { type: 'open_loop', fact_text: 'Пользователь обещал рассказать про поездку.', confidence: 0.8, ttl_days: 30 },
    { type: 'preference', fact_text: 'Пользователь любит зелёный чай.', confidence: 0.9, ttl_days: null },
  ]);
  assert.deepEqual(out, [
    { type: 'open_loop', fact_text: 'Пользователь обещал рассказать про поездку.', confidence: 0.8, ttl_days: 30 },
    { type: 'preference', fact_text: 'Пользователь любит зелёный чай.', confidence: 0.9, ttl_days: null },
  ]);
}

// 4. Страховка режима json_object: неполные элементы получают значения по умолчанию, пустые и
// чувствительные — отбрасываются целиком.
{
  const out = factsToCandidates([
    { fact_text: 'Пользователь работает учителем.' }, // без type/confidence/ttl_days
    { type: 'profile' }, // без fact_text — отбрасывается
    { type: 'profile', fact_text: 'Паспорт пользователя 1234.', confidence: 0.9, ttl_days: null }, // секрет
  ]);
  assert.deepEqual(out, [
    { type: 'profile', fact_text: 'Пользователь работает учителем.', confidence: 0.7, ttl_days: null },
  ]);
}

// 5. Заполненный state_json.notes попадает в HISTORY_CONTEXT так же, как остальные поля состояния:
// потребитель печатает объект целиком.
{
  const ctx = formatHistoryContext('Сжатая история диалога.', {
    current_goal: 'спланировать отпуск',
    current_task: null,
    decisions: [],
    rejected_options: [],
    open_questions: [],
    constraints: [],
    next_steps: ['выбрать отель'],
    notes: ['пользователь ждёт ответа турагента'],
  });
  assert.ok(ctx.includes('Оперативное состояние:'));
  assert.ok(ctx.includes('пользователь ждёт ответа турагента'), 'notes должны печататься в промпт');
  assert.ok(ctx.includes('выбрать отель'));
}

console.log('history-compress-schema: все проверки прошли');
