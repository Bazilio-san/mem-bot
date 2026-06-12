// AI analysis of a logged LLM request from the admin log viewer. Two engines:
// • 'llm' — the project's own LLM (chatStream from src/llm.js) with a model from the allowed config list;
//   the analysis call itself is journaled under its own request_id with kind 'log_analysis', so it never
//   mixes into the cycle being analyzed.
// • 'cli' — a CLI tool preset from the config (e.g. `claude -p`), spawned in the project root with the
//   prompt passed via stdin. Available ONLY when the admin server listens on localhost: the endpoint
//   effectively executes a command on the server, so it must not be reachable over the network. The command
//   comes exclusively from the config; the client only picks a preset by name.
// The result is streamed to the browser as Server-Sent Events: frames `data: {"text":"…"}`, terminated by
// `data: {"done":true}`; an error is sent as `data: {"error":"…"}` so the client can show the reason.
import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { chatStream } from '../llm.js';
import { queryLog } from '../db.js';
import { runWithLlmContext } from '../pipeline/llm-context.js';
import { REQUEST_KINDS } from '../pipeline/llm-log.js';

// Analysis settings with safe defaults when the config section is missing.
export function analysisConfig() {
  const a = config.admin?.logAnalysis || {};
  const llm = a.llm || {};
  const cli = a.cli || {};
  const adminHost = String(config.admin?.host || '')
    .trim()
    .toLowerCase();
  const isLocalHost = ['localhost', '127.0.0.1', '::1'].includes(adminHost);
  const models = Array.isArray(llm.models) && llm.models.length ? llm.models : [config.llm.mainModel];
  return {
    models,
    defaultModel: llm.defaultModel && models.includes(llm.defaultModel) ? llm.defaultModel : models[0],
    cliPresets: (Array.isArray(cli.presets) ? cli.presets : []).map((p) => ({
      name: p.name,
      command: p.command,
      args: Array.isArray(p.args) ? p.args : [],
      timeoutSec: Number(p.timeoutSec) > 0 ? Number(p.timeoutSec) : 300,
    })),
    maxOutputChars: Number(cli.maxOutputChars) > 0 ? Number(cli.maxOutputChars) : 200000,
    // The CLI engine executes a command on the server — allowed only for a local-only admin panel.
    cliAvailable: isLocalHost,
  };
}

// The public part of the settings for the frontend dialog: preset names and display titles. The title is
// just the executable name; command arguments never leave the server.
export function analysisConfigPublic() {
  const cfg = analysisConfig();
  return {
    models: cfg.models,
    defaultModel: cfg.defaultModel,
    cliPresets: cfg.cliPresets.map((p) => ({ name: p.name, title: p.command })),
    cliAvailable: cfg.cliAvailable,
  };
}

// Build the analysis prompt from a journal record and the administrator's question. The payload and the
// stored response go in verbatim (they are already size-capped by the journal's maxPayloadChars).
// Exported for unit tests.
export function buildPrompt(record, question) {
  const meta = {
    request_kind: record.request_kind,
    endpoint: record.endpoint,
    model: record.model,
    created_at: record.created_at,
    duration_ms: record.duration_ms,
    prompt_tokens: record.prompt_tokens,
    completion_tokens: record.completion_tokens,
    price_usd: record.price_usd,
    status: record.status,
    error: record.error,
  };
  return `Ты — опытный инженер по промптам и отладке LLM-приложений. Ниже — один запрос к LLM из журнала
бота с памятью (mem-bot) и ответ модели на него. Проанализируй их и ответь на вопрос администратора.
Отвечай по-русски, по существу, с конкретными рекомендациями. Формат — Markdown.

## Метаданные запроса
${JSON.stringify(meta, null, 2)}

## Тело запроса (payload)
${JSON.stringify(record.payload, null, 2)}

## Ответ модели (response)
${record.response != null ? JSON.stringify(record.response, null, 2) : '(ответ не сохранён)'}

## Вопрос администратора
${question}`;
}

// SSE helpers: a uniform frame writer over the express response.
function sseStart(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
}

function sseSend(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function sseEnd(res) {
  sseSend(res, { done: true });
  res.end();
}

// Run the analysis and stream the result into the response. Throws only before the stream starts (bad
// arguments → JSON error); after the SSE header any failure is reported inside the stream.
// Two ways to provide the prompt: a ready-made `prompt` text built (and possibly edited) on the client,
// or the legacy pair llmRequestId + question — then the prompt is assembled here from the journal record.
export async function runAnalysis({ llmRequestId, question, engine, model, preset, prompt: rawPrompt }, res) {
  const cfg = analysisConfig();
  const direct = String(rawPrompt || '').trim();
  const q = String(question || '').trim();
  if (!direct && (!llmRequestId || !q)) {
    res.status(400).json({ error: 'Provide either a ready-made prompt or both llmRequestId and question.' });
    return;
  }
  if (engine === 'cli' && !cfg.cliAvailable) {
    res.status(403).json({
      error: 'The CLI engine is only available when the admin server listens on localhost (config.admin.host).',
    });
    return;
  }
  let prompt = direct;
  if (!prompt) {
    const { rows } = await queryLog(`SELECT * FROM log.llm_request WHERE llm_request_id = $1`, [Number(llmRequestId)]);
    if (!rows.length) {
      res.status(404).json({ error: 'Log entry not found.' });
      return;
    }
    prompt = buildPrompt(rows[0], q);
  }

  sseStart(res);
  try {
    if (engine === 'cli') {
      await runCli(cfg, preset, prompt, res);
    } else {
      await runLlm(cfg, model, prompt, res);
    }
    sseEnd(res);
  } catch (err) {
    sseSend(res, { error: String(err.message || err) });
    res.end();
  }
}

// Pick the analysis model: the requested one if it is in the allowed list, otherwise the default.
// Exported for unit tests.
export function pickModel(cfg, model) {
  return cfg.models.includes(model) ? model : cfg.defaultModel;
}

// Engine 'llm': a streaming call of the project's model. Runs under its own correlation context so the
// journal gets a fresh request_id with kind 'log_analysis'.
async function runLlm(cfg, model, prompt, res) {
  const chosen = pickModel(cfg, model);
  const meta = {
    requestId: `llm_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    channel: 'admin',
    kind: REQUEST_KINDS.LOG_ANALYSIS,
  };
  await runWithLlmContext(meta, () =>
    chatStream({
      model: chosen,
      messages: [{ role: 'user', content: prompt }],
      kind: REQUEST_KINDS.LOG_ANALYSIS,
      onDelta: (chunk) => {
        if (chunk) {
          sseSend(res, { text: chunk });
        }
      },
    }),
  );
}

// Engine 'cli': spawn the preset's command in the project root, pass the prompt via stdin and stream stdout.
// The command itself comes only from the config; on Windows the shell resolves .cmd shims (claude.cmd).
// Exported for unit tests (called with a fake res that captures SSE frames).
export function runCli(cfg, presetName, prompt, res) {
  const preset = cfg.cliPresets.find((p) => p.name === presetName) || cfg.cliPresets[0];
  if (!preset) {
    throw new Error('No CLI presets configured in admin.logAnalysis.cli.presets.');
  }
  return new Promise((resolve, reject) => {
    // On Windows the shell is needed to resolve .cmd shims (claude.cmd), but cmd.exe breaks on unquoted
    // paths with spaces — so the command and arguments containing spaces are wrapped in quotes.
    const useShell = process.platform === 'win32';
    const quote = (s) => (useShell && /\s/.test(s) && !s.startsWith('"') ? `"${s}"` : s);
    const child = spawn(quote(preset.command), preset.args.map(quote), {
      cwd: process.cwd(),
      shell: useShell,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let sent = 0;
    let stderrTail = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI tool exceeded the ${preset.timeoutSec}s timeout and was terminated.`));
    }, preset.timeoutSec * 1000);

    child.stdout.on('data', (buf) => {
      const text = buf.toString('utf8');
      sent += text.length;
      if (sent > cfg.maxOutputChars) {
        clearTimeout(timeout);
        child.kill();
        sseSend(res, { text: '\n\n…output truncated at maxOutputChars limit.' });
        resolve();
        return;
      }
      sseSend(res, { text });
    });
    child.stderr.on('data', (buf) => {
      stderrTail = (stderrTail + buf.toString('utf8')).slice(-2000);
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to start CLI "${preset.command}": ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0 || sent > 0) {
        resolve();
      } else {
        reject(new Error(`CLI exited with code ${code}${stderrTail ? `: ${stderrTail}` : ''}`));
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}
