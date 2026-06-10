#!/usr/bin/env node

/**
 * Generates a WAV voice sample for the Telegram-Web Playwright harness.
 *
 * Chromium can pretend that this file is the microphone input via the launch flag
 * `--use-file-for-fake-audio-capture=<path>`. That lets the harness "record" a voice
 * message in Telegram Web from a deterministic audio source instead of a live mic.
 *
 * Chromium's fake-audio capture only accepts an uncompressed PCM WAV. We therefore
 * write a 48 kHz, mono, 16-bit little-endian PCM file. The waveform itself is a short
 * spoken-like pattern of amplitude-modulated tones — enough to prove the send path and
 * to give the speech-to-text pipeline a non-silent signal to chew on. Replace this file
 * with a real spoken WAV (same format) when you need a meaningful transcription.
 *
 * Usage: node .claude/skills/test-telegram-bot/scripts/make-sample-audio.js [outputPath]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const outPath = process.argv[2]
  ? path.resolve(process.cwd(), process.argv[2])
  : path.resolve(__dirname, '..', 'assets', 'voice-sample.wav');

const sampleRate = 48000;
const seconds = 3;
const numSamples = sampleRate * seconds;

// Build the PCM payload: three "syllables" of a 220 Hz carrier with a raised-cosine
// amplitude envelope, separated by short gaps, so the result sounds like speech rhythm.
const pcm = Buffer.alloc(numSamples * 2);
const syllableCentres = [0.5, 1.4, 2.3];
for (let i = 0; i < numSamples; i += 1) {
  const t = i / sampleRate;
  let amp = 0;
  for (const centre of syllableCentres) {
    const d = Math.abs(t - centre);
    if (d < 0.32) {
      amp += 0.5 * (1 + Math.cos((Math.PI * d) / 0.32)); // raised cosine window
    }
  }
  amp = Math.min(1, amp);
  const carrier = Math.sin(2 * Math.PI * 220 * t) + 0.4 * Math.sin(2 * Math.PI * 440 * t);
  const value = Math.round(amp * 0.6 * 32767 * (carrier / 1.4));
  pcm.writeInt16LE(Math.max(-32768, Math.min(32767, value)), i * 2);
}

// Standard 44-byte WAV header for 16-bit mono PCM.
const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + pcm.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16); // PCM chunk size
header.writeUInt16LE(1, 20); // audio format = PCM
header.writeUInt16LE(1, 22); // channels = mono
header.writeUInt32LE(sampleRate, 24);
header.writeUInt32LE(sampleRate * 2, 28); // byte rate
header.writeUInt16LE(2, 32); // block align
header.writeUInt16LE(16, 34); // bits per sample
header.write('data', 36);
header.writeUInt32LE(pcm.length, 40);

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, Buffer.concat([header, pcm]));
console.log(`Wrote ${outPath} (${header.length + pcm.length} bytes, ${seconds}s, ${sampleRate} Hz mono 16-bit PCM)`);
