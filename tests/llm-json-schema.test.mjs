// Модульные тесты подготовки JSON Schema для режима json_schema (structured outputs) в chatJSON.
// Проверяется чистая функция prepareJsonSchema из src/llm.js: рекурсивная нормализация под строгий режим
// (additionalProperties:false и полный required на каждом объекте) и автоматическое отключение strict
// для схем со свободными объектами (additionalProperties:true или объект без перечисленных свойств).
import assert from 'node:assert/strict';
import { prepareJsonSchema } from '../src/llm.js';

// 1. Строгая схема: вложенные объекты получают additionalProperties:false и required со ВСЕМИ ключами.
{
  const input = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      details: {
        type: 'object',
        required: ['kind'],
        properties: {
          kind: { type: 'string' },
          note: { type: ['string', 'null'] },
        },
      },
      tags: { type: 'array', items: { type: 'string' } },
    },
  };
  const { schema, strict } = prepareJsonSchema(input);
  assert.equal(strict, true, 'схема без свободных объектов должна быть strict');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['name', 'details', 'tags']);
  assert.equal(schema.properties.details.additionalProperties, false);
  assert.deepEqual(
    schema.properties.details.required,
    ['kind', 'note'],
    'required вложенного объекта должен пополниться всеми ключами',
  );
}

// 2. Исходная схема не мутируется: подготовка работает на глубокой копии.
{
  const input = { type: 'object', properties: { a: { type: 'string' } } };
  prepareJsonSchema(input);
  assert.equal('required' in input, false);
  assert.equal('additionalProperties' in input, false);
}

// 3. Свободный объект через additionalProperties:true выключает strict, но не ломает нормализацию остального.
{
  const input = {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: { type: 'string' },
      state: { type: 'object', additionalProperties: true, properties: { goal: { type: ['string', 'null'] } } },
    },
  };
  const { schema, strict } = prepareJsonSchema(input);
  assert.equal(strict, false, 'additionalProperties:true должен выключать strict');
  assert.equal(schema.properties.state.additionalProperties, true, 'явное true не перетирается');
  assert.deepEqual(schema.required, ['summary', 'state']);
}

// 4. Объект без перечисленных свойств (в том числе в items массива) — тоже не strict.
{
  const input = {
    type: 'object',
    properties: {
      facts: { type: 'array', items: { type: 'object', additionalProperties: true } },
    },
  };
  assert.equal(prepareJsonSchema(input).strict, false);

  const bare = { type: 'object', properties: { data: { type: 'object' } } };
  assert.equal(prepareJsonSchema(bare).strict, false, 'объект без properties невыразим в strict-режиме');
}

// 5. Реальная схема классификатора строгая: после перевода entities на массив пар type/value
// в ней не осталось свободных объектов, и провайдер гарантирует соответствие ответа схеме.
{
  const { buildSchema } = await import('../src/pipeline/classify.js');
  const { schema, strict } = prepareJsonSchema(buildSchema(['general']));
  assert.equal(strict, true, 'схема классификатора должна быть strict');
  assert.equal(schema.properties.entities.type, 'array');
  assert.equal(schema.properties.entities.items.additionalProperties, false);
  assert.deepEqual(schema.properties.entities.items.required, ['type', 'value']);
}

console.log('llm-json-schema: все проверки прошли');
