#!/usr/bin/env node

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const gitDir = path.resolve(scriptDir, '..');

const files = ['../update.js', 'fcp.js', 'claude-2-agents-symlink.js', '../deploy/srv.js'];

function runGit(args) {
  return spawnSync('git', ['-C', gitDir, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
}

function toGitPath(filePath) {
  return path.relative(gitDir, filePath).split(path.sep).join('/');
}

const gitCheck = runGit(['rev-parse', '--is-inside-work-tree']);

if (gitCheck.error) {
  console.error(`Cannot run git: ${gitCheck.error.message}`);
  process.exit(1);
}

if (gitCheck.status !== 0 || gitCheck.stdout.trim() !== 'true') {
  console.error(`Folder is not under git: ${gitDir}`);
  process.exit(1);
}

let changed = 0;
let skipped = 0;

for (const relativePath of files) {
  const absolutePath = path.resolve(scriptDir, relativePath);
  const gitPath = toGitPath(absolutePath);

  if (!existsSync(absolutePath)) {
    console.warn(`skip missing: ${gitPath}`);
    skipped += 1;
    continue;
  }

  const trackedCheck = runGit(['ls-files', '--error-unmatch', '--', gitPath]);

  if (trackedCheck.status !== 0) {
    console.warn(`skip untracked: ${gitPath}`);
    skipped += 1;
    continue;
  }

  const result = runGit(['update-index', '--chmod=+x', '--', gitPath]);

  if (result.status !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `failed to update ${gitPath}`;
    console.error(message);
    process.exit(result.status ?? 1);
  }

  console.log(`+x ${gitPath}`);
  changed += 1;
}

console.log(`Done. Updated: ${changed}. Skipped: ${skipped}.`);
