// Модульные тесты расчёта стоимости обращения к LLM. Проверяют нормализацию имени модели и формулу цены
// по прайс-листу из src/data/model-list.js. Сеть и база данных здесь не задействованы.
import assert from 'node:assert/strict';
import { normalizeModelName, priceUsd } from '../src/pipeline/llm-pricing.js';

// 1. Нормализация имени модели: префикс провайдера и хвостовой штамп даты отбрасываются.
{
  assert.equal(normalizeModelName('gpt-4o'), 'gpt-4o');
  assert.equal(normalizeModelName('openai/gpt-4o-mini'), 'gpt-4o-mini', 'префикс провайдера должен отбрасываться');
  assert.equal(normalizeModelName('gpt-4o-2024-08-06'), 'gpt-4o', 'хвостовой штамп даты должен отбрасываться');
  assert.equal(normalizeModelName('нет-такой-модели'), null, 'неизвестная модель приводится к null');
  assert.equal(normalizeModelName(''), null);
  assert.equal(normalizeModelName(undefined), null);
}

// 2. Расчёт стоимости для известной чат-модели: входящие по inp, исходящие по out (цена за 1 млн токенов).
{
  // gpt-4o: inp = 2.5, out = 10 (за 1 млн токенов).
  const { priceUsd: price, modelPriced } = priceUsd({ model: 'gpt-4o', promptTokens: 1000, completionTokens: 1000 });
  // 1000/1e6*2.5 + 1000/1e6*10 = 0.0025 + 0.01 = 0.0125.
  assert.equal(modelPriced, 'gpt-4o');
  assert.ok(Math.abs(price - 0.0125) < 1e-9, `ожидалось 0.0125, получено ${price}`);
}

// 3. Эмбеддинги: цена считается по входящим токенам, исходящих нет.
{
  // text-embedding-3-small: inp = 0.02 (за 1 млн токенов). 5000 токенов → 5000/1e6*0.02 = 0.0001.
  const { priceUsd: price, modelPriced } = priceUsd({ model: 'text-embedding-3-small', promptTokens: 5000 });
  assert.equal(modelPriced, 'text-embedding-3-small');
  assert.ok(Math.abs(price - 0.0001) < 1e-9, `ожидалось 0.0001, получено ${price}`);
}

// 4. Кэшированные входящие токены тарифицируются по половинной цене inpB.
{
  // gpt-4o: inp = 2.5, inpB = 1.25. 1000 входящих, из них 1000 кэшированных → 1000/1e6*1.25 = 0.00125.
  const { priceUsd: price } = priceUsd({
    model: 'gpt-4o',
    promptTokens: 1000,
    completionTokens: 0,
    cachedTokens: 1000,
  });
  assert.ok(Math.abs(price - 0.00125) < 1e-9, `ожидалось 0.00125, получено ${price}`);
}

// 5. Неизвестная модель: цена и нормализованное имя — null (токены логируются, но цена не считается).
{
  const { priceUsd: price, modelPriced } = priceUsd({
    model: 'unknown-model-xyz',
    promptTokens: 100,
    completionTokens: 100,
  });
  assert.equal(price, null);
  assert.equal(modelPriced, null);
}

console.log('llm-pricing.test.mjs: ok');
