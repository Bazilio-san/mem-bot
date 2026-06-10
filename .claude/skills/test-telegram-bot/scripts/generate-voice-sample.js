#!/usr/bin/env node

/**
 * Generates the voice sample for the Telegram-Web harness from REAL speech, using the project's
 * OpenAI-compatible text-to-speech endpoint (the same provider the bot uses for voice replies).
 *
 * Unlike make-sample-audio.js (which writes a synthetic tone), this produces an intelligible
 * spoken WAV, so the bot's speech-to-text actually transcribes meaningful text. We request
 * `response_format: wav`, which returns uncompressed 16-bit PCM — the only format Chromium's
 * fake-audio capture (`--use-file-for-fake-audio-capture`) accepts.
 *
 * Usage:
 *   node .claude/skills/test-telegram-bot/scripts/generate-voice-sample.js ["spoken text"] [outputPath]
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../../../../src/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEXT =
  process.argv[2] ||
  'Привет! Это тестовое голосовое сообщение для проверки распознавания речи. Напомни мне завтра в десять утра позвонить маме.';
const OUT = process.argv[3]
  ? path.resolve(process.cwd(), process.argv[3])
  : path.resolve(__dirname, '..', 'assets', 'voice-sample.wav');

const baseURL = (config.llm.baseURL || 'https://api.openai.com/v1').replace(/\/$/, '');
const model = config.voiceOutput?.model || 'gpt-4o-mini-tts';
const voice = config.voiceOutput?.voice || 'ash';

async function main() {
  if (!config.llm.apiKey) throw new Error('config.llm.apiKey is not set — cannot call text-to-speech');
  console.log(`Synthesizing via ${baseURL}/audio/speech (model ${model}, voice ${voice})`);
  console.log(`Text: «${TEXT}»`);
  const res = await fetch(`${baseURL}/audio/speech`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.llm.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: TEXT, voice, response_format: 'wav' }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('TTS provider returned empty audio');
  // Report the WAV format so we can confirm Chromium will accept it.
  const channels = buf.readUInt16LE(22);
  const rate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, buf);
  console.log(`Wrote ${OUT} (${buf.length} bytes; ${rate} Hz, ${channels} ch, ${bits}-bit PCM)`);
}

main().catch((e) => {
  console.error('Voice sample generation failed:', e.message);
  process.exit(1);
});
