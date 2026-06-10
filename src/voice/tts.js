// Synthesis of a voice reply (text to speech, TTS) for the Telegram channel.
// The module belongs to the channel layer: the AI bot core knows nothing about it and does not call it. Here
// are three voice-delivery responsibilities, hidden from the adapter behind simple functions:
//   1) choosing the text to voice (the whole short reply, or a brief summary of a long one / one with lists or code);
//   2) the speech synthesis itself via OpenAI-compatible audio/speech, returning OGG/OPUS bytes;
//   3) helper markup checks and enforcing a hard length limit.
// The provider and model are hidden inside: if needed, they are changed via configuration without touching the adapter.
import { config } from '../config.js';
import { chat } from '../llm.js';
import { logLlmRequest } from '../pipeline/llm-log.js';

// Strip markup before speech synthesis. The reply may arrive with channel markup (HTML tags for Telegram or
// Markdown for the web chat), and these characters must not go into synthesis — otherwise the bot reads tags
// and asterisks aloud. HTML tags are removed, escaped entities (&lt; &gt; &amp;) are restored, and the main
// Markdown markers (asterisks, underscores, backticks, heading hashes, quote markers) are stripped.
export function stripMarkup(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '') // HTML tags
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&') // escaped entities back
    .replace(/`{1,3}/g, '') // code backticks
    .replace(/(\*\*|__|\*|_)/g, '') // Markdown bold/italic
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // heading hashes at line start
    .replace(/^\s*>\s?/gm, ''); // quote markers at line start
}

// Flag that the reply contains code or long lists and therefore sounds bad aloud. Triggers on code blocks in
// triple backticks and on two or more consecutive bullet or numbered list items.
export function hasCodeOrList(text) {
  const s = String(text || '');
  if (/```/.test(s)) {
    return true;
  }
  const listLines = s.split('\n').filter((line) => /^\s*([-*•]|\d+[.)])\s+/.test(line));
  return listLines.length >= 2;
}

// Trim a string down to the limit, on a sentence boundary where possible. If there is no suitable boundary
// within the limit (it would fall at the very start), cut hard at the limit. The result is trimmed of edge whitespace.
export function clampToLimit(text, limit) {
  const s = String(text || '').trim();
  if (s.length <= limit) {
    return s;
  }
  const slice = s.slice(0, limit);
  const m = slice.match(/[\s\S]*[.!?…](?:\s|$)/);
  let cut = m ? m[0].length : -1;
  if (cut < limit * 0.5) {
    cut = limit;
  } // no convenient boundary — cut at the limit
  return s.slice(0, cut).trim();
}

// Build a brief summary of a long reply with a fast helper model. The instruction requires staying within
// the given character limit and conveying the meaning without code or lists, because it is this summary that
// gets voiced.
async function summarizeForVoice(answer, summaryLimit) {
  const messages = [
    {
      role: 'system',
      content: `Ты сжимаешь ответ ассистента в короткое резюме для озвучивания вслух. Правила: передай суть на том
же языке, что и исходный ответ; не включай код, разметку, ссылки и перечни по пунктам; пиши связными
предложениями; уложись строго в ${summaryLimit} символов. Верни только текст резюме без пояснений.`,
    },
    { role: 'user', content: answer },
  ];
  const msg = await chat({ model: config.voiceOutput.summaryModel, messages, kind: 'voice_summary' });
  return (msg.content || '').trim();
}

// Pick the text to voice and a flag indicating it is a summary (not the full reply).
// A short reply without code or lists is voiced in full. Otherwise a summary is built within the limit; if
// the summary could not be obtained (empty model reply), text: null is returned — a signal for the channel
// to fall back to text. The opts.summarize parameter lets tests override summary building; by default the model is used.
export async function buildVoiceText(answer, opts = {}) {
  const hardLimit = config.voiceOutput.maxChars;
  const summaryLimit = Math.min(config.voiceOutput.summaryMaxChars, hardLimit);
  const raw = String(answer || '').trim();
  // The code-and-list flag is checked against the original marked-up text: it's exactly the markup (code
  // blocks, list items) that signals building a summary, so it must not be stripped before the check.
  const codeOrList = hasCodeOrList(raw);
  const clean = stripMarkup(raw).trim();

  if (clean.length <= hardLimit && !codeOrList) {
    return { text: clean, summarized: false };
  }

  const summarize = opts.summarize || summarizeForVoice;
  let summary = '';
  try {
    summary = await summarize(clean, summaryLimit);
  } catch {
    summary = '';
  }
  const text = clampToLimit(stripMarkup(summary), summaryLimit);
  return { text: text || null, summarized: true };
}

// Synthesize speech from text and return the voice-message bytes in OGG/OPUS format.
// The request goes directly (fetch) to the audio/speech endpoint of the chosen base URL: OPENAI_BASE_URL for
// the proxy or https://api.openai.com/v1 for the direct OpenAI API. Some proxies occasionally drop the
// connection on a timeout, so we make several retry attempts. The proxy's content-type header may be
// unreliable, so we rely on the requested format.
// The opts.fetch parameter lets tests override the network; by default the global fetch is used.
export async function synthesizeSpeech(text, opts = {}) {
  const fetchImpl = opts.fetch || globalThis.fetch;
  const baseURL = (config.llm.baseURL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const url = `${baseURL}/audio/speech`;
  const { model, format } = config.voiceOutput;
  const voice = opts.voice || config.voiceOutput.voice;
  // For the log, the input is text (it is stored in payload), while the synthesized audio output is described
  // only by metadata in binary_meta. The audio bytes themselves are not written to the log.
  const logPayload = { model, voice, format, input: text };
  let lastErr;
  const startedAt = Date.now();
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.llm.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          input: text,
          voice,
          response_format: format,
        }),
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) {
        throw new Error('TTS provider returned an empty audio response');
      }
      try {
        logLlmRequest({
          endpoint: 'audio.speech',
          kind: 'tts',
          model,
          isBinary: true,
          payload: logPayload,
          // The audio bytes are not logged; the response mirrors binary_meta so the log viewer has a
          // uniform "← LLM" row for every request kind.
          response: { format, byteLength: buf.length },
          binaryMeta: { format, byteLength: buf.length },
          durationMs: Date.now() - startedAt,
        });
      } catch {
        // logging must not affect synthesis
      }
      return buf;
    } catch (err) {
      lastErr = err;
    }
  }
  try {
    logLlmRequest({
      endpoint: 'audio.speech',
      kind: 'tts',
      model,
      isBinary: true,
      payload: logPayload,
      durationMs: Date.now() - startedAt,
      status: 'error',
      error: lastErr?.message || lastErr,
    });
  } catch {
    // logging must not affect synthesis
  }
  throw lastErr;
}
