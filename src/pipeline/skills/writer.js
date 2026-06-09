// Слой записи и перезагрузки навыков для инструментария редактирования. Принимает объект навыка той же формы,
// что отдаёт реестр (getSkill), собирает из него SKILL.md и domain-schema.json, проверяет инварианты до записи,
// пишет атомарно с резервной копией и горячо перезагружает реестр. Любая запись и удаление ограничены каталогом
// config.skills.dir: абсолютные пути и выход через «..» отклоняются.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { query } from '../../db.js';
import { validateDefinition } from '../../schema/meta.js';
import { loadSkills, getAllSkills, invalidateSkillsCache } from './registry.js';

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DOMAIN_RE = /^[a-z0-9_]+$/;
// Навыки, которые нельзя удалять: общий fallback и сам редактор навыков.
const UNDELETABLE = new Set(['general', 'skill-author']);

function skillsDir() {
  return path.isAbsolute(config.skills.dir) ? config.skills.dir : path.resolve(process.cwd(), config.skills.dir);
}

function skillDir(name) {
  return path.join(skillsDir(), name);
}

// ---- Сериализация SKILL.md --------------------------------------------------

// Безопасно закавычить скалярную строку для нашего разборщика фронтматтера (parse.js).
function quote(s) {
  return `"${String(s ?? '').replace(/\r?\n/g, ' ').replace(/"/g, "'")}"`;
}

// Поточный список ["a", "b"] для разборщика (элементы без запятых внутри).
function flowList(arr) {
  return `[${(arr || []).map((x) => quote(x)).join(', ')}]`;
}

// Собрать текст SKILL.md из объекта навыка (форма как у getSkill). Поля идут в стабильном порядке.
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
  if (skill.definition) fm.push('  schema: domain-schema.json');
  fm.push('tools:');
  fm.push(`  allowed: ${flowList(skill.tools?.allowed)}`);
  fm.push(`  base: ${skill.tools?.base === false ? 'false' : 'true'}`);
  fm.push('model:');
  fm.push(`  main: ${skill.model?.main ? quote(skill.model.main) : 'null'}`);
  fm.push(`  extract: ${skill.model?.extract ? quote(skill.model.extract) : 'null'}`);
  fm.push('references:');
  fm.push(`  allowed: ${skill.references?.allowed === true ? 'true' : 'false'}`);

  const body = `# Skill Prompt\n\n${(skill.skillPrompt || '').trim()}\n`
    + (skill.factExtractionPrompt
      ? `\n## Fact Extraction Prompt\n\n${skill.factExtractionPrompt.trim()}\n` : '');

  return `---\n${fm.join('\n')}\n---\n\n${body}`;
}

// ---- Валидация перед записью ------------------------------------------------

// Проверить навык целиком. Возвращает { ok, issues }. tool-allowlist сверяется с реестром инструментов через
// динамический импорт, чтобы не создавать циклической зависимости загрузки (инструменты импортируют writer).
export async function validateSkill(skill) {
  const issues = [];
  const name = skill.name;

  if (!name || !NAME_RE.test(name)) issues.push(`name «${name}» не в формате kebab-case (латиница и дефисы).`);
  if (!skill.domain_key || !DOMAIN_RE.test(skill.domain_key)) {
    issues.push(`domain_key «${skill.domain_key}» должен быть в нижнем регистре (латиница и подчёркивания).`);
  }
  if (!skill.classification?.when_to_use) issues.push('Не задан classification.when_to_use.');
  if (!skill.skillPrompt || !skill.skillPrompt.trim()) issues.push('Пустой блок «# Skill Prompt».');

  if (skill.definition && Array.isArray(skill.definition.entities) && skill.definition.entities.length) {
    const { ok, issues: defIssues } = validateDefinition(skill.definition);
    if (!ok) issues.push(...defIssues);
    if (ok && skill.definition.domain_key !== skill.domain_key) {
      issues.push(`domain_key схемы «${skill.definition.domain_key}» не совпадает с domain_key навыка «${skill.domain_key}».`);
    }
  }

  // Существование инструментов из tools.allowed.
  if (skill.tools?.allowed?.length) {
    const { getTool } = await import('../tools.js');
    for (const t of skill.tools.allowed) {
      if (!getTool(t)) issues.push(`Инструмент «${t}» из tools.allowed не найден в реестре инструментов.`);
    }
  }

  // Уникальность domain_key среди прочих навыков (текущий навык, совпадающий по имени, исключается —
  // имя совпадает с каталогом и потому уникально по построению).
  for (const other of getAllSkills()) {
    if (other.name === name) continue;
    if (other.domain_key === skill.domain_key) {
      issues.push(`domain_key «${skill.domain_key}» уже занят навыком «${other.name}».`);
    }
  }

  return { ok: issues.length === 0, issues };
}

// ---- Безопасность путей справочников ----------------------------------------

function resolveReference(name, relPath) {
  const rel = String(relPath || '').replace(/\\/g, '/');
  if (!rel || path.isAbsolute(rel) || rel.split('/').includes('..')) {
    throw new Error('Недопустимый путь справочника.');
  }
  const refRoot = path.resolve(skillDir(name), 'references');
  const target = path.resolve(refRoot, rel);
  if (target !== refRoot && !target.startsWith(refRoot + path.sep)) {
    throw new Error('Путь справочника выходит за пределы каталога навыка.');
  }
  return { refRoot, target };
}

// ---- Запись -----------------------------------------------------------------

function atomicWrite(target, content) {
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, target);
}

function backupIfExists(target) {
  if (fs.existsSync(target)) fs.copyFileSync(target, `${target}.bak`);
}

// Завести строку домена в справочнике mem.agent_domains (мэппинг domain_key → domain_id), если её ещё нет.
export async function ensureDomainRow(domainKey, title, description) {
  await query(
    `INSERT INTO mem.agent_domains (domain_key, title, description)
     VALUES ($1, $2, $3) ON CONFLICT (domain_key) DO NOTHING`,
    [domainKey, title || domainKey, description || null],
  );
}

// Записать навык на диск и горячо перезагрузить реестр. Бросает с понятным текстом при невалидном навыке.
export async function writeSkill(skill, { backup = true } = {}) {
  const { ok, issues } = await validateSkill(skill);
  if (!ok) throw new Error('Навык не прошёл валидацию:\n- ' + issues.join('\n- '));

  const dir = skillDir(skill.name);
  fs.mkdirSync(dir, { recursive: true });
  const skillMd = path.join(dir, 'SKILL.md');
  const schemaJson = path.join(dir, 'domain-schema.json');

  if (backup) { backupIfExists(skillMd); if (skill.definition) backupIfExists(schemaJson); }

  atomicWrite(skillMd, composeSkillFile(skill));
  if (skill.definition) atomicWrite(schemaJson, JSON.stringify(skill.definition, null, 2) + '\n');

  invalidateSkillsCache();
  loadSkills({ force: true });
  await ensureDomainRow(skill.domain_key, skill.title, skill.description);
  return { path: dir, reloaded: true };
}

// Создать или обновить файл справочника.
export async function writeReference(name, relPath, content) {
  const { target } = resolveReference(name, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  atomicWrite(target, String(content ?? ''));
  return { path: target };
}

// Удалить файл справочника (только при confirm).
export function removeReference(name, relPath, { confirm } = {}) {
  if (confirm !== true) throw new Error('Удаление требует confirm=true.');
  const { target } = resolveReference(name, relPath);
  if (fs.existsSync(target)) fs.rmSync(target);
  return { removed: true };
}

// Удалить навык целиком (только при confirm; general и skill-author защищены).
export function deleteSkill(name, { confirm } = {}) {
  if (confirm !== true) throw new Error('Удаление требует confirm=true.');
  if (UNDELETABLE.has(name)) throw new Error(`Навык «${name}» удалять нельзя.`);
  const dir = skillDir(name);
  if (!fs.existsSync(dir)) throw new Error(`Навык «${name}» не найден.`);
  fs.rmSync(dir, { recursive: true, force: true });
  invalidateSkillsCache();
  loadSkills({ force: true });
  return { removed: true };
}
