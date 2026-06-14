// Модульные тесты AI-анализа логов (src/server/log-analysis.js): настройки и их публичная проекция,
// доступность CLI-движка только на localhost, выбор модели из разрешённого списка, состав промпта и
// CLI-движок на фейковой команде (node -e): стрим stdout в SSE-кадры, ненулевой код выхода, таймаут.
// Сеть и реальная LLM не используются.
import assert from 'node:assert/strict';
import { analysisConfig, analysisConfigPublic, buildPrompt, pickModel, runCli } from '../src/server/log-analysis.js';
import { config } from '../src/config.js';

const savedHost = config.admin.host;
const savedAnalysis = config.admin.logAnalysis;

// Фейковый express-res: собирает SSE-кадры в массив.
function fakeRes() {
  const frames = [];
  return {
    frames,
    write(s) {
      frames.push(s);
    },
  };
}

function framesText(frames) {
  return frames
    .map((f) => JSON.parse(f.replace(/^data: /, '')))
    .filter((o) => o.text)
    .map((o) => o.text)
    .join('');
}

// 1. Настройки: дефолты при пустой секции, выбор defaultModel только из списка.
{
  config.admin.logAnalysis = undefined;
  const cfg = analysisConfig();
  assert.deepEqual(cfg.models, [config.llm.mainModel], 'без секции список из одной основной модели');
  assert.equal(cfg.defaultModel, config.llm.mainModel);

  config.admin.logAnalysis = { llm: { models: ['m1', 'm2'], defaultModel: 'не-из-списка' } };
  assert.equal(analysisConfig().defaultModel, 'm1', 'defaultModel вне списка заменяется первой моделью');
}

// 2. Доступность CLI: только при admin.host === 'localhost'; публичная проекция не раскрывает команды.
{
  config.admin.logAnalysis = {
    llm: { models: ['m1'], defaultModel: 'm1' },
    cli: { presets: [{ name: 'p1', command: 'secret-tool', args: ['--x'] }] },
  };
  config.admin.host = 'localhost';
  assert.equal(analysisConfig().cliAvailable, true);
  const pub = analysisConfigPublic();
  assert.deepEqual(pub.cliPresets, [{ name: 'p1', title: 'secret-tool' }], 'подпись пресета — команда без аргументов');
  assert.ok(!JSON.stringify(pub).includes('"command"'), 'команды не уходят на фронтенд отдельным полем');
  assert.ok(!JSON.stringify(pub).includes('--x'), 'аргументы команды не уходят на фронтенд');

  config.admin.host = '0.0.0.0';
  assert.equal(analysisConfig().cliAvailable, false, 'на нелокальном хосте CLI недоступен');
  config.admin.host = 'localhost';
}

// 3. Выбор модели: запрошенная из списка — берётся, чужая — заменяется дефолтной.
{
  const cfg = { models: ['a', 'b'], defaultModel: 'a' };
  assert.equal(pickModel(cfg, 'b'), 'b');
  assert.equal(pickModel(cfg, 'evil-model'), 'a');
  assert.equal(pickModel(cfg, undefined), 'a');
}

// 4. Промпт анализа содержит метаданные, payload, ответ и вопрос; отсутствие ответа помечается явно.
{
  const record = {
    request_kind: 'main_agent_answer',
    endpoint: 'chat.completions',
    model: 'gpt-test',
    created_at: '2026-06-10T00:00:00Z',
    duration_ms: 1500,
    prompt_tokens: 100,
    completion_tokens: 20,
    price_usd: 0.001,
    status: 'ok',
    error: null,
    payload: { messages: [{ role: 'user', content: 'привет-маркер-payload' }] },
    response: { message: { content: 'ответ-маркер' } },
  };
  const prompt = buildPrompt(record, 'почему так?');
  assert.ok(prompt.includes('привет-маркер-payload'), 'payload в промпте');
  assert.ok(prompt.includes('ответ-маркер'), 'ответ модели в промпте');
  assert.ok(prompt.includes('почему так?'), 'вопрос администратора в промпте');
  assert.ok(prompt.includes('main_agent_answer'), 'метаданные в промпте');

  const noResp = buildPrompt({ ...record, response: null }, 'q');
  assert.ok(noResp.includes('(ответ не сохранён)'), 'отсутствие ответа помечено явно');
}

// CLI-фикстуры: команда — node (путь может содержать пробелы, что тоже проверяется), аргумент — скрипт.
const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

// 5. CLI-движок: фейковая команда читает промпт со stdin и печатает его маркер — кадры доходят как SSE.
{
  const cfg = {
    cliPresets: [{ name: 'echo', command: process.execPath, args: [fixture('cli-echo.cjs')], timeoutSec: 30 }],
    maxOutputChars: 10_000,
  };
  const res = fakeRes();
  await runCli(cfg, 'echo', 'промпт-для-CLI', res);
  assert.ok(framesText(res.frames).includes('ANALYSIS-OK:'), 'stdout CLI дошёл SSE-кадрами');
}

// 6. Ненулевой код выхода без вывода — ошибка с хвостом stderr.
{
  const cfg = {
    cliPresets: [{ name: 'boom', command: process.execPath, args: [fixture('cli-fail.cjs')], timeoutSec: 30 }],
    maxOutputChars: 10_000,
  };
  await assert.rejects(runCli(cfg, 'boom', 'x', fakeRes()), /code 3.*причина-сбоя/s);
}

// 7. Таймаут: зависшая команда останавливается с понятной ошибкой.
{
  const cfg = {
    cliPresets: [{ name: 'hang', command: process.execPath, args: [fixture('cli-hang.cjs')], timeoutSec: 1 }],
    maxOutputChars: 10_000,
  };
  await assert.rejects(runCli(cfg, 'hang', 'x', fakeRes()), /exceeded the 1s timeout/);
}

// 8. Лимит вывода: болтливая команда обрезается с пометкой в потоке.
{
  const cfg = {
    cliPresets: [{ name: 'chatty', command: process.execPath, args: [fixture('cli-chatty.cjs')], timeoutSec: 30 }],
    maxOutputChars: 500,
  };
  const res = fakeRes();
  await runCli(cfg, 'chatty', 'x', res);
  assert.ok(
    framesText(res.frames).includes('output truncated at maxOutputChars'),
    'превышение лимита помечено в потоке',
  );
}

config.admin.host = savedHost;
config.admin.logAnalysis = savedAnalysis;
console.log('log-analysis.test.mjs: ok');
