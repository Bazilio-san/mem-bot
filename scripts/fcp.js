#!/usr/bin/env node

/**
 * Atomically save content to a file.
 *
 * Usage:
 *   node scripts/fcp.js <filePath> <contentFilePath>
 *
 * <filePath>        — destination path (absolute or relative to project root)
 * <contentFilePath> — path to a temp file whose contents will be written to <filePath>
 *
 * The script reads the content from <contentFilePath> and writes it to <filePath>,
 * creating parent directories if needed.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const [, , rawTarget, rawSource] = process.argv;

if (!rawTarget || !rawSource) {
  console.error('Usage: node scripts/fcp.js <filePath> <contentFilePath>');
  process.exit(1);
}

const targetPath = path.isAbsolute(rawTarget) ? rawTarget : path.resolve(projectRoot, rawTarget);
const sourcePath = path.isAbsolute(rawSource) ? rawSource : path.resolve(projectRoot, rawSource);

if (!fs.existsSync(sourcePath)) {
  console.error(`Source file not found: ${sourcePath}`);
  process.exit(1);
}

const content = fs.readFileSync(sourcePath, 'utf-8');

const targetDir = path.dirname(targetPath);
if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

fs.writeFileSync(targetPath, content, 'utf-8');
console.log(`Saved: ${targetPath} (${content.length} chars)`);
