// Runtime skills registry: the single source of a domain. Each skills/<name>/ directory with a SKILL.md file
// defines a domain memory namespace and all of the domain's behavior — classification signals, the main-answer
// prompt, the fact-extraction prompt, the tool list, and references.
//
// The registry reads files once on first access and keeps the parsed skills in process memory.
// Domain specificity of memory is expressed by two mechanisms: the "## Fact Extraction Prompt" block
// (mixed into fact extraction) and the domain_key coordinate of mem.user_facts. A domain is a projection
// of a skill.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { splitSkillFile, extractSection } from './parse.js';

// Per-process cache of the parsed registry. null means "not loaded yet".
let cache = null;

// Absolute path to the skills directory. A relative config.skills.dir is resolved from the project root (cwd).
function skillsDir() {
  return path.isAbsolute(config.skills.dir) ? config.skills.dir : path.resolve(process.cwd(), config.skills.dir);
}

// Read and parse one skill directory. Returns the full skill definition object.
// Throws a clear error if the definition is invalid — better to fail loudly at startup.
function loadOneSkill(dir, name) {
  const skillFile = path.join(dir, 'SKILL.md');
  const raw = fs.readFileSync(skillFile, 'utf8');
  const { frontmatter: fm, body } = splitSkillFile(raw);

  const issues = [];
  if (!fm.domain_key) {
    issues.push(`skill «${name}»: domain_key is not set in the frontmatter.`);
  }
  const whenToUse = fm.classification?.when_to_use;
  if (!whenToUse) {
    issues.push(`skill «${name}»: classification.when_to_use is not set.`);
  }
  const skillPrompt = extractSection(body, '# Skill Prompt');
  if (!skillPrompt) {
    issues.push(`skill «${name}»: the "# Skill Prompt" block is missing.`);
  }

  if (issues.length) {
    throw new Error(issues.join('\n'));
  }

  return {
    name,
    dir,
    domain_key: fm.domain_key,
    title: fm.title || name,
    description: fm.description || '',
    enabled: fm.enabled !== false, // enabled by default
    classification: {
      when_to_use: whenToUse,
      positive_signals: Array.isArray(fm.classification?.positive_signals) ? fm.classification.positive_signals : [],
      negative_signals: Array.isArray(fm.classification?.negative_signals) ? fm.classification.negative_signals : [],
    },
    memory: {
      scopes: Array.isArray(fm.memory?.scopes) ? fm.memory.scopes : ['profile', 'domain', 'dialog'],
    },
    tools: {
      allowed: Array.isArray(fm.tools?.allowed) ? fm.tools.allowed : [],
      base: fm.tools?.base !== false,
    },
    model: {
      main: fm.model?.main || null,
      extract: fm.model?.extract || null,
    },
    references: {
      allowed: fm.references?.allowed === true,
    },
    skillPrompt,
    factExtractionPrompt: extractSection(body, '## Fact Extraction Prompt'),
  };
}

// Load the whole skills registry from the directory. Idempotent: repeated calls return the cache.
// Throws on duplicate name/domain_key or on an invalid definition of any skill.
export function loadSkills({ force = false } = {}) {
  if (cache && !force) {
    return cache;
  }

  const dir = skillsDir();
  const byName = new Map();
  const byDomain = new Map();

  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    // No skills directory — empty registry. This is allowed when the flag is off.
    cache = { byName, byDomain };
    return cache;
  }

  for (const entry of entries) {
    const skillDir = path.join(dir, entry.name);
    if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) {
      continue;
    }
    const skill = loadOneSkill(skillDir, entry.name);
    if (byName.has(skill.name)) {
      throw new Error(`Duplicate skill name: «${skill.name}».`);
    }
    if (byDomain.has(skill.domain_key)) {
      throw new Error(
        `Multiple skills claim domain_key «${skill.domain_key}»: «${byDomain.get(skill.domain_key).name}» and «${skill.name}».`,
      );
    }
    byName.set(skill.name, skill);
    byDomain.set(skill.domain_key, skill);
  }

  cache = { byName, byDomain };
  return cache;
}

// Reset the registry cache (for tests and admin-reload).
export function invalidateSkillsCache() {
  cache = null;
}

// Parse one skill directory into a full object (for the editing toolkit: re-parsing a single skill).
export function parseSkillDir(dir, name) {
  return loadOneSkill(dir, name);
}

// All registry skills as full objects (for uniqueness checks during creation and editing).
export function getAllSkills() {
  return [...loadSkills().byName.values()];
}

// Compact list for the router: only the fields the classifier needs.
export function listSkillRoutes() {
  const { byName } = loadSkills();
  return [...byName.values()]
    .filter((s) => s.enabled)
    .map((s) => ({
      name: s.name,
      domain_key: s.domain_key,
      title: s.title,
      description: s.description,
      when_to_use: s.classification.when_to_use,
      positive_signals: s.classification.positive_signals,
      negative_signals: s.classification.negative_signals,
    }));
}

// Full skill definition by name.
export function getSkill(name) {
  return loadSkills().byName.get(name) || null;
}

// Active skill for a domain key.
export function getSkillByDomain(domainKey) {
  return loadSkills().byDomain.get(domainKey) || null;
}

// Contents of the "# Skill Prompt" block.
export function getSkillPrompt(name) {
  return getSkill(name)?.skillPrompt || '';
}

// Contents of the "## Fact Extraction Prompt" block.
export function getFactExtractionPrompt(name) {
  return getSkill(name)?.factExtractionPrompt || '';
}

// Read a skill reference from the references/** directory. Forbids absolute paths and escaping via "..".
// Returns the file contents truncated to config.skills.referenceMaxBytes. Throws on a violation.
export function getReference(name, relPath) {
  const skill = getSkill(name);
  if (!skill) {
    throw new Error(`Unknown skill: «${name}».`);
  }
  if (!skill.references.allowed) {
    throw new Error(`Reference reading is disabled for skill «${name}».`);
  }

  const rel = String(relPath || '').replace(/\\/g, '/');
  if (!rel || path.isAbsolute(rel) || rel.split('/').includes('..')) {
    throw new Error('Invalid reference path.');
  }
  const refRoot = path.resolve(skill.dir, 'references');
  const target = path.resolve(refRoot, rel);
  // Double protection: the resulting path must stay inside this skill's references.
  if (target !== refRoot && !target.startsWith(refRoot + path.sep)) {
    throw new Error('Reference path escapes the skill directory.');
  }
  const buf = fs.readFileSync(target);
  const limit = config.skills.referenceMaxBytes;
  return buf.length > limit ? buf.slice(0, limit).toString('utf8') : buf.toString('utf8');
}
