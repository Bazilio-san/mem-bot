// Skill writing and reload layer for the editing toolkit. Takes a skill object of the same shape the registry
// returns (getSkill), assembles SKILL.md from it, checks invariants before writing, writes atomically with a
// backup, and hot-reloads the registry. Every write and delete is confined to the config.skills.dir directory:
// absolute paths and escaping via ".." are rejected.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { query } from '../../db.js';
import { loadSkills, getAllSkills, invalidateSkillsCache } from './registry.js';

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DOMAIN_RE = /^[a-z0-9_]+$/;
// Skills that cannot be deleted: the general fallback and the skill editor itself.
const UNDELETABLE = new Set(['general', 'skill-author']);

function skillsDir() {
  return path.isAbsolute(config.skills.dir) ? config.skills.dir : path.resolve(process.cwd(), config.skills.dir);
}

function skillDir(name) {
  return path.join(skillsDir(), name);
}

// ---- SKILL.md serialization -------------------------------------------------

// Safely quote a scalar string for our frontmatter parser (parse.js).
function quote(s) {
  return `"${String(s ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/"/g, "'")}"`;
}

// Flow list ["a", "b"] for the parser (elements must not contain commas).
function flowList(arr) {
  return `[${(arr || []).map((x) => quote(x)).join(', ')}]`;
}

// Build the SKILL.md text from a skill object (getSkill shape). Fields are emitted in a stable order.
export function composeSkillFile(skill) {
  const fm = [];
  fm.push(`name: ${skill.name}`);
  fm.push(`domain_key: ${skill.domain_key}`);
  fm.push(`title: ${quote(skill.title)}`);
  fm.push(`description: ${quote(skill.description || '')}`);
  fm.push(`enabled: ${skill.enabled === false ? 'false' : 'true'}`);
  fm.push('classification:');
  fm.push(`  when_to_use: ${quote(skill.classification?.when_to_use || '')}`);
  fm.push(`  positive_signals: ${flowList(skill.classification?.positive_signals)}`);
  fm.push(`  negative_signals: ${flowList(skill.classification?.negative_signals)}`);
  fm.push('memory:');
  fm.push(`  scopes: ${flowList(skill.memory?.scopes || ['profile', 'domain', 'dialog'])}`);
  fm.push('tools:');
  fm.push(`  allowed: ${flowList(skill.tools?.allowed)}`);
  fm.push(`  base: ${skill.tools?.base === false ? 'false' : 'true'}`);
  fm.push('model:');
  fm.push(`  main: ${skill.model?.main ? quote(skill.model.main) : 'null'}`);
  fm.push(`  extract: ${skill.model?.extract ? quote(skill.model.extract) : 'null'}`);
  fm.push('references:');
  fm.push(`  allowed: ${skill.references?.allowed === true ? 'true' : 'false'}`);

  const body =
    `# Skill Prompt\n\n${(skill.skillPrompt || '').trim()}\n` +
    (skill.factExtractionPrompt ? `\n## Fact Extraction Prompt\n\n${skill.factExtractionPrompt.trim()}\n` : '');

  return `---\n${fm.join('\n')}\n---\n\n${body}`;
}

// ---- Validation before writing ----------------------------------------------

// Validate the whole skill. Returns { ok, issues }. The tool allowlist is checked against the tool registry via a
// dynamic import to avoid creating a circular load dependency (the tools import the writer).
export async function validateSkill(skill) {
  const issues = [];
  const { name } = skill;

  if (!name || !NAME_RE.test(name)) {
    issues.push(`name «${name}» is not in kebab-case (lowercase latin and hyphens).`);
  }
  if (!skill.domain_key || !DOMAIN_RE.test(skill.domain_key)) {
    issues.push(`domain_key «${skill.domain_key}» must be lowercase (latin and underscores).`);
  }
  if (!skill.classification?.when_to_use) {
    issues.push('classification.when_to_use is not set.');
  }
  if (!skill.skillPrompt || !skill.skillPrompt.trim()) {
    issues.push('The "# Skill Prompt" block is empty.');
  }

  // Existence of tools from tools.allowed.
  if (skill.tools?.allowed?.length) {
    const { getTool } = await import('../tools.js');
    for (const t of skill.tools.allowed) {
      if (!getTool(t)) {
        issues.push(`Tool «${t}» from tools.allowed was not found in the tool registry.`);
      }
    }
  }

  // Uniqueness of domain_key among the other skills (the current skill that matches by name is excluded —
  // the name matches the directory and is therefore unique by construction).
  for (const other of getAllSkills()) {
    if (other.name === name) {
      continue;
    }
    if (other.domain_key === skill.domain_key) {
      issues.push(`domain_key «${skill.domain_key}» is already taken by skill «${other.name}».`);
    }
  }

  return { ok: issues.length === 0, issues };
}

// ---- Reference path safety --------------------------------------------------

function resolveReference(name, relPath) {
  const rel = String(relPath || '').replace(/\\/g, '/');
  if (!rel || path.isAbsolute(rel) || rel.split('/').includes('..')) {
    throw new Error('Invalid reference path.');
  }
  const refRoot = path.resolve(skillDir(name), 'references');
  const target = path.resolve(refRoot, rel);
  if (target !== refRoot && !target.startsWith(refRoot + path.sep)) {
    throw new Error('Reference path escapes the skill directory.');
  }
  return { refRoot, target };
}

// ---- Writing ----------------------------------------------------------------

function atomicWrite(target, content) {
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, target);
}

function backupIfExists(target) {
  if (fs.existsSync(target)) {
    fs.copyFileSync(target, `${target}.bak`);
  }
}

// Create a domain row in the mem.agent_domains lookup (domain_key → domain_id mapping) if it does not exist yet.
export async function ensureDomainRow(domainKey, title, description) {
  await query(
    `INSERT INTO mem.agent_domains (domain_key, title, description)
     VALUES ($1, $2, $3) ON CONFLICT (domain_key) DO NOTHING`,
    [domainKey, title || domainKey, description || null],
  );
}

// Write the skill to disk and hot-reload the registry. Throws with clear text on an invalid skill.
export async function writeSkill(skill, { backup = true } = {}) {
  const { ok, issues } = await validateSkill(skill);
  if (!ok) {
    throw new Error('The skill failed validation:\n- ' + issues.join('\n- '));
  }

  const dir = skillDir(skill.name);
  fs.mkdirSync(dir, { recursive: true });
  const skillMd = path.join(dir, 'SKILL.md');

  if (backup) {
    backupIfExists(skillMd);
  }

  atomicWrite(skillMd, composeSkillFile(skill));

  invalidateSkillsCache();
  loadSkills({ force: true });
  await ensureDomainRow(skill.domain_key, skill.title, skill.description);
  return { path: dir, reloaded: true };
}

// Create or update a reference file.
export async function writeReference(name, relPath, content) {
  const { target } = resolveReference(name, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  atomicWrite(target, String(content ?? ''));
  return { path: target };
}

// Delete a reference file (only with confirm).
export function removeReference(name, relPath, { confirm } = {}) {
  if (confirm !== true) {
    throw new Error('Deletion requires confirm=true.');
  }
  const { target } = resolveReference(name, relPath);
  if (fs.existsSync(target)) {
    fs.rmSync(target);
  }
  return { removed: true };
}

// Delete a skill entirely (only with confirm; general and skill-author are protected).
export function deleteSkill(name, { confirm } = {}) {
  if (confirm !== true) {
    throw new Error('Deletion requires confirm=true.');
  }
  if (UNDELETABLE.has(name)) {
    throw new Error(`Skill «${name}» cannot be deleted.`);
  }
  const dir = skillDir(name);
  if (!fs.existsSync(dir)) {
    throw new Error(`Skill «${name}» not found.`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  invalidateSkillsCache();
  loadSkills({ force: true });
  return { removed: true };
}
