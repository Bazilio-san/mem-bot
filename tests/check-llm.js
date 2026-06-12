// Check of model availability and behavior across LLM providers, plus a speed comparison.
// The provider list is set by the PROVIDERS constant below. Run: node tests/check-llm.js
// For each provider we check: plain chat, structured JSON output, tool calling, embeddings.
// At the end a response-time comparison table is printed — the main metric we care about.
import OpenAI from 'openai';
import { config } from '../src/config.js';

// ====== Providers and models under test ======
// Each provider is its own client (its own key and base URL) and its own model.
// Cerebras speaks the same protocol as OpenAI, so the same OpenAI client is used
// with apiKey and baseURL swapped out.
const PROVIDERS = [
  {
    // When OPENAI_BASE_URL is not set, the proxy is not used and the client goes directly to OpenAI.
    label: config.llm.baseURL ? 'LiteLLM proxy' : 'OpenAI direct',
    model: process.env.MAIN_MODEL || 'gpt-5.4-mini',
    apiKey: config.llm.apiKey,
    baseURL: config.llm.baseURL,
    // Embedding model (for the last test). null — skip the embeddings check.
    embedModel: 'text-embedding-3-small',
  },
  {
    label: 'Cerebras',
    model: 'gpt-oss-120b',
    apiKey: process.env.CEREBRAS_API_KEY,
    baseURL: process.env.CEREBRAS_BASE_URL || 'https://api.cerebras.ai/v1',
    // Cerebras has no embeddings API — skip the check.
    embedModel: null,
  },
];
// ============================================

// One run of the check suite for one provider. Returns counters and time measurements.
async function runSuite(provider) {
  const client = new OpenAI({ apiKey: provider.apiKey, baseURL: provider.baseURL });
  const MODEL = provider.model;
  const EMBED_MODEL = provider.embedModel;

  let passed = 0,
    failed = 0;
  const timings = [];

  function ok(name, cond, detail = '') {
    if (cond) {
      passed++;
      console.log(`  ✅ ${name}`);
    } else {
      failed++;
      console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
    }
  }

  // Time one request. Returns the result, prints and accumulates the duration.
  async function timed(label, fn) {
    const t0 = performance.now();
    try {
      const res = await fn();
      const ms = Math.round(performance.now() - t0);
      timings.push({ label, ms });
      console.log(`     response time: ${ms} ms`);
      return res;
    } catch (err) {
      // A failed request does not take part in the speed comparison: time-to-error is not representative.
      // So we do not add it to timings — the comparison table shows a dash for such a request.
      const ms = Math.round(performance.now() - t0);
      console.log(`     time to error: ${ms} ms`);
      throw err;
    }
  }

  async function checkChat() {
    console.log('\n[1] Plain chat');
    try {
      const res = await timed('chat', () =>
        client.chat.completions.create({
          model: MODEL,
          messages: [{ role: 'user', content: 'Ответь одним словом: привет' }],
        }),
      );
      const text = res.choices?.[0]?.message?.content || '';
      console.log('     answer:', JSON.stringify(text).slice(0, 120));
      ok('Chat responds', text.length > 0);
    } catch (err) {
      ok('Chat responds', false, err.message);
    }
  }

  async function checkJsonObject() {
    console.log('\n[2] Structured output (json_object)');
    try {
      const res = await timed('json_object', () =>
        client.chat.completions.create({
          model: MODEL,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: 'Верни строго JSON-объект вида {"city":"...","ok":true}.' },
            { role: 'user', content: 'Город — Казань.' },
          ],
        }),
      );
      const obj = JSON.parse(res.choices[0].message.content);
      console.log('     object:', JSON.stringify(obj).slice(0, 160));
      ok('Returns a valid JSON object', typeof obj === 'object' && obj !== null);
    } catch (err) {
      ok('Returns a valid JSON object', false, err.message);
    }
  }

  async function checkJsonSchema() {
    console.log('\n[3] Strict json_schema (often broken on proxies)');
    try {
      const res = await timed('json_schema', () =>
        client.chat.completions.create({
          model: MODEL,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'probe',
              strict: true,
              schema: {
                type: 'object',
                additionalProperties: false,
                required: ['answer'],
                properties: { answer: { type: 'string' } },
              },
            },
          },
          messages: [{ role: 'user', content: 'Скажи слово «тест».' }],
        }),
      );
      const obj = JSON.parse(res.choices[0].message.content);
      ok('json_schema strict supported', typeof obj.answer === 'string');
    } catch (err) {
      // Not a failure of the model as such — we just record that strict mode is unavailable.
      console.log('     strict mode unavailable:', err.message.slice(0, 140));
      ok('json_schema strict supported (optional)', false, 'use json_object');
    }
  }

  async function checkJsonSchemaFreeform() {
    console.log('\n[3b] Strict json_schema with a FREE-FORM field (additionalProperties:true)');
    // We verify a specific claim: strict mode rejects schemas where a nested object has
    // additionalProperties=true (like our data/entities fields). An error is expected.
    try {
      const res = await timed('json_schema_freeform', () =>
        client.chat.completions.create({
          model: MODEL,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'freeform',
              strict: true,
              schema: {
                type: 'object',
                additionalProperties: false,
                required: ['data'],
                properties: {
                  // Free-form field: arbitrary keys. Incompatible with OpenAI strict mode.
                  data: { type: 'object', additionalProperties: true },
                },
              },
            },
          },
          messages: [{ role: 'user', content: 'Верни любой объект в поле data.' }],
        }),
      );
      JSON.parse(res.choices[0].message.content);
      // If it passed — free-form fields ARE allowed in strict (the claim is wrong).
      console.log('     free-form field accepted — strict with free-form fields works');
      ok('Free-form field in strict is REJECTED (expected)', false, 'actually accepted');
    } catch (err) {
      console.log('     rejected:', err.message.slice(0, 160));
      // The error is expected and confirms: the cause is the strict rule, not the model.
      ok('Free-form field in strict is REJECTED (expected)', true);
    }
  }

  async function checkTool() {
    console.log('\n[4] Tool call (function calling)');
    try {
      const res = await timed('tool', () =>
        client.chat.completions.create({
          model: MODEL,
          tools: [
            {
              type: 'function',
              function: {
                name: 'create_reminder',
                description: 'Создать напоминание',
                parameters: {
                  type: 'object',
                  required: ['title', 'when'],
                  properties: { title: { type: 'string' }, when: { type: 'string' } },
                },
              },
            },
          ],
          messages: [{ role: 'user', content: 'Напомни мне завтра в 10 проверить цены.' }],
        }),
      );
      const calls = res.choices[0].message.tool_calls || [];
      if (calls.length) {
        console.log('     call:', calls[0].function.name, calls[0].function.arguments.slice(0, 120));
      }
      ok('Model calls the tool', calls.length >= 1);
    } catch (err) {
      ok('Model calls the tool', false, err.message);
    }
  }

  async function checkEmbeddings() {
    if (!EMBED_MODEL) {
      console.log('\n[5] Embeddings — skipped (provider offers no embeddings)');
      return;
    }
    console.log('\n[5] Embeddings');
    try {
      const res = await timed('embeddings', () =>
        client.embeddings.create({ model: EMBED_MODEL, input: 'тест эмбеддинга' }),
      );
      const dim = res.data?.[0]?.embedding?.length || 0;
      console.log('     vector dimension:', dim);
      ok(`Embeddings work (model ${EMBED_MODEL})`, dim > 0);
    } catch (err) {
      ok(`Embeddings work (model ${EMBED_MODEL})`, false, err.message);
    }
  }

  console.log(`\n############### Provider: ${provider.label} ###############`);
  console.log(`Base URL: ${provider.baseURL || 'default (api.openai.com)'}`);
  console.log(`Model under test: ${MODEL}`);
  if (!provider.apiKey) {
    console.log('  ⚠️  No API key configured — provider skipped.');
    return { provider, passed: 0, failed: 0, timings, skipped: true };
  }

  await checkChat();
  await checkJsonObject();
  await checkJsonSchema();
  await checkJsonSchemaFreeform();
  await checkTool();
  await checkEmbeddings();

  console.log(`\n  Totals for "${provider.label}": passed ${passed}, failed ${failed}`);
  return { provider, passed, failed, timings, skipped: false };
}

async function main() {
  const results = [];
  for (const provider of PROVIDERS) {
    results.push(await runSuite(provider));
  }

  // Overall totals of passed and failed checks.
  const totalPassed = results.reduce((s, r) => s + r.passed, 0);
  const totalFailed = results.reduce((s, r) => s + r.failed, 0);
  console.log(`\n================ TOTAL ================`);
  console.log(`Passed: ${totalPassed}, failed: ${totalFailed}`);

  // Speed comparison. Collect every request kind we encountered and for each one
  // show each provider's response time side by side — that makes it clear who is faster.
  const active = results.filter((r) => !r.skipped && r.timings.length);
  if (active.length) {
    const labels = [];
    for (const r of active) {
      for (const t of r.timings) {
        if (!labels.includes(t.label)) {
          labels.push(t.label);
        }
      }
    }

    console.log(`\n============ SPEED COMPARISON (ms) ============`);
    const header = ['request'.padEnd(22), ...active.map((r) => r.provider.label.padStart(16))].join(' | ');
    console.log(header);
    console.log('-'.repeat(header.length));
    for (const label of labels) {
      const row = [label.padEnd(22)];
      for (const r of active) {
        const t = r.timings.find((x) => x.label === label);
        row.push((t ? String(t.ms) : '—').padStart(16));
      }
      console.log(row.join(' | '));
    }

    const avgRow = ['average'.padEnd(22)];
    for (const r of active) {
      const avg = Math.round(r.timings.reduce((s, t) => s + t.ms, 0) / r.timings.length);
      avgRow.push(String(avg).padStart(16));
    }
    console.log('-'.repeat(header.length));
    console.log(avgRow.join(' | '));
  }

  process.exit(totalFailed > 0 ? 1 : 0);
}

main();
