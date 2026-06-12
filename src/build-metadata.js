import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = { value: null };

function normalize(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function runGit(args) {
  const result = spawnSync('git', args, {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  return normalize(result.stdout);
}

function readPackageVersion() {
  try {
    const packageJson = JSON.parse(readFileSync(resolve(ROOT_DIR, 'package.json'), 'utf8'));
    return normalize(packageJson?.version);
  } catch {
    return null;
  }
}

function resolveFromEnv() {
  const env = process.env;
  const version = normalize(env.BOT_VERSION) || normalize(env.BUILD_VERSION) || normalize(env.APP_VERSION);
  const commit = normalize(
    env.BOT_COMMIT ||
      env.BUILD_COMMIT ||
      env.GIT_COMMIT ||
      env.GITHUB_SHA ||
      env.TRAVIS_COMMIT ||
      normalize(env.GIT_SHA),
  );
  const shortCommit = normalize(env.BOT_COMMIT_SHORT) || normalize(env.GITHUB_SHA_SHORT);
  const commitTime = normalize(
    env.BOT_COMMIT_TIME ||
      env.BUILD_COMMIT_TIME ||
      env.GIT_COMMIT_TIME ||
      env.GITHUB_COMMITTER_DATE,
  );

  return {
    version,
    commit,
    shortCommit,
    commitTime,
  };
}

function buildMetadata() {
  const packageVersion = readPackageVersion();
  const env = resolveFromEnv();
  let versionSource = env.version ? 'env' : 'package';
  if (!versionSource && !packageVersion) {
    versionSource = 'fallback';
  }

  let version = env.version || packageVersion || 'unknown';
  let commit = env.commit;
  let shortCommit = env.shortCommit;
  let commitTime = env.commitTime;
  let commitSource = env.commit ? 'env' : null;
  let shortCommitSource = env.shortCommit ? 'env' : null;
  let commitTimeSource = env.commitTime ? 'env' : null;

  if (!commit && shortCommit) {
    commit = shortCommit;
    commitSource = 'env';
  }

  if (!commit || !commitTime) {
    const gitCommit = !commit ? runGit(['rev-parse', 'HEAD']) : null;
    const gitCommitTime = runGit(['log', '-1', '--format=%cI']);

    if (!commit) {
      commit = gitCommit;
      if (!commitSource && gitCommit) {
        commitSource = 'git';
      }
    }
    if (!commitTime) {
      commitTime = gitCommitTime;
      if (!commitTimeSource && gitCommitTime) {
        commitTimeSource = 'git';
      }
    }
  }

  if (!shortCommit && commit) {
    shortCommit = commit.slice(0, 7);
    shortCommitSource = commitSource || 'git';
  }

  return {
    version,
    commit,
    shortCommit,
    commitTime,
    source: {
      version: version !== 'unknown' ? versionSource : 'fallback',
      commit: commitSource || null,
      shortCommit: shortCommitSource || commitSource || null,
      commitTime: commitTimeSource || null,
    },
  };
}

export function getBotBuildInfo() {
  if (CACHE.value) {
    return CACHE.value;
  }
  CACHE.value = buildMetadata();
  return CACHE.value;
}
