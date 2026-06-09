// Рантайм-реестр skills: единый источник домена. Каждый каталог skills/<name>/ с файлом SKILL.md
// задаёт доменный namespace памяти и всё поведение домена — признаки классификации, prompt основного
// ответа, prompt извлечения фактов, закрытую схему доменной памяти, список инструментов и справочники.
//
// Реестр читает файлы один раз при первом обращении и держит разобранные skills в памяти процесса.
// Источник истины для схемы домена — файл рядом со skill (domain-schema.json или блок ## Domain Schema),
// а не таблица в базе данных. Это и есть «один механизм»: домен — проекция skill.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { validateDefinition } from '../../schema/meta.js';
import { splitSkillFile, extractSection, extractJsonBlock } from './parse.js';

// Кэш разобранного реестра на процесс. null означает «ещё не загружали».
let cache = null;

// Абсолютный путь к каталогу skills. Относительный config.skills.dir разрешается от корня проекта (cwd).
function skillsDir() {
  return path.isAbsolute(config.skills.dir) ? config.skills.dir : path.resolve(process.cwd(), config.skills.dir);
}

// Прочитать и разобрать один каталог skill. Возвращает полный объект описания skill.
// Бросает ошибку с понятным текстом, если описание невалидно — на старте лучше упасть явно.
function loadOneSkill(dir, name) {
  const skillFile = path.join(dir, 'SKILL.md');
  const raw = fs.readFileSync(skillFile, 'utf8');
  const { frontmatter: fm, body } = splitSkillFile(raw);

  const issues = [];
  if (!fm.domain_key) issues.push(`skill «${name}»: во фронтматтере не задан domain_key.`);
  const whenToUse = fm.classification?.when_to_use;
  if (!whenToUse) issues.push(`skill «${name}»: не задан classification.when_to_use.`);
  const skillPrompt = extractSection(body, '# Skill Prompt');
  if (!skillPrompt) issues.push(`skill «${name}»: отсутствует блок «# Skill Prompt».`);

  // Схема доменной памяти: из отдельного файла (memory.schema: *.json) или из блока ## Domain Schema.
  // Схема необязательна (домен может быть без предметных сущностей), но если задана — обязана быть валидной.
  let definition = null;
  const schemaRef = fm.memory?.schema;
  try {
    if (typeof schemaRef === 'string' && schemaRef.endsWith('.json')) {
      const schemaPath = path.join(dir, schemaRef);
      definition = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    } else {
      const block = extractSection(body, '## Domain Schema');
      definition = block ? extractJsonBlock(block) : null;
    }
  } catch (err) {
    issues.push(`skill «${name}»: не удалось прочитать схему домена — ${err.message}`);
  }

  // Схема с единственным полем domain_key/title без сущностей — это «пустая» схема (домен без предметных
  // сущностей). Валидируем мета-схемой только определения с непустым списком сущностей.
  if (definition && Array.isArray(definition.entities) && definition.entities.length) {
    const { ok, issues: defIssues } = validateDefinition(definition);
    if (!ok) issues.push(`skill «${name}»: схема домена невалидна:\n  - ${defIssues.join('\n  - ')}`);
    if (ok && definition.domain_key !== fm.domain_key) {
      issues.push(`skill «${name}»: domain_key схемы «${definition.domain_key}» не совпадает с domain_key skill «${fm.domain_key}».`);
    }
  } else {
    definition = null; // нет предметных сущностей — домен без схемы (свободные факты профиля)
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
    enabled: fm.enabled !== false, // по умолчанию включён
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
    definition, // закрытая схема доменной памяти или null
  };
}

// Загрузить весь реестр skills из каталога. Идемпотентно: повторные вызовы возвращают кэш.
// Бросает ошибку при дубликатах name/domain_key или при невалидном описании любого skill.
export function loadSkills({ force = false } = {}) {
  if (cache && !force) return cache;

  const dir = skillsDir();
  const byName = new Map();
  const byDomain = new Map();

  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    // Каталога skills нет — пустой реестр. Это допустимо, когда флаг выключен.
    cache = { byName, byDomain };
    return cache;
  }

  for (const entry of entries) {
    const skillDir = path.join(dir, entry.name);
    if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) continue;
    const skill = loadOneSkill(skillDir, entry.name);
    if (byName.has(skill.name)) throw new Error(`Дублирующееся имя skill: «${skill.name}».`);
    if (byDomain.has(skill.domain_key)) {
      throw new Error(`Несколько skills претендуют на domain_key «${skill.domain_key}»: «${byDomain.get(skill.domain_key).name}» и «${skill.name}».`);
    }
    byName.set(skill.name, skill);
    byDomain.set(skill.domain_key, skill);
  }

  cache = { byName, byDomain };
  return cache;
}

// Сбросить кэш реестра (для тестов и admin-reload).
export function invalidateSkillsCache() {
  cache = null;
}

// Компактный список для роутера: только поля, нужные классификатору.
export function listSkillRoutes() {
  const { byName } = loadSkills();
  return [...byName.values()].filter((s) => s.enabled).map((s) => ({
    name: s.name,
    domain_key: s.domain_key,
    title: s.title,
    description: s.description,
    when_to_use: s.classification.when_to_use,
    positive_signals: s.classification.positive_signals,
    negative_signals: s.classification.negative_signals,
  }));
}

// Полное описание skill по имени.
export function getSkill(name) {
  return loadSkills().byName.get(name) || null;
}

// Активный skill для доменного ключа.
export function getSkillByDomain(domainKey) {
  return loadSkills().byDomain.get(domainKey) || null;
}

// Содержимое блока «# Skill Prompt».
export function getSkillPrompt(name) {
  return getSkill(name)?.skillPrompt || '';
}

// Содержимое блока «## Fact Extraction Prompt».
export function getFactExtractionPrompt(name) {
  return getSkill(name)?.factExtractionPrompt || '';
}

// Закрытая схема доменной памяти skill (объект definition) или null.
export function getDomainSchema(name) {
  return getSkill(name)?.definition || null;
}

// Схема домена по доменному ключу (мост для слоя записи памяти: validateAndCanonicalize/extract).
export function getDomainDefinitionByKey(domainKey) {
  return getSkillByDomain(domainKey)?.definition || null;
}

// Прочитать справочник skill из каталога references/**. Запрещает абсолютные пути и выход через «..».
// Возвращает содержимое файла, обрезанное до config.skills.referenceMaxBytes. Бросает ошибку при нарушении.
export function getReference(name, relPath) {
  const skill = getSkill(name);
  if (!skill) throw new Error(`Неизвестный skill: «${name}».`);
  if (!skill.references.allowed) throw new Error(`У skill «${name}» чтение справочников выключено.`);

  const rel = String(relPath || '').replace(/\\/g, '/');
  if (!rel || path.isAbsolute(rel) || rel.split('/').includes('..')) {
    throw new Error('Недопустимый путь к справочнику.');
  }
  const refRoot = path.resolve(skill.dir, 'references');
  const target = path.resolve(refRoot, rel);
  // Двойная защита: итоговый путь обязан оставаться внутри references данного skill.
  if (target !== refRoot && !target.startsWith(refRoot + path.sep)) {
    throw new Error('Путь к справочнику выходит за пределы каталога skill.');
  }
  const buf = fs.readFileSync(target);
  const limit = config.skills.referenceMaxBytes;
  return buf.length > limit ? buf.slice(0, limit).toString('utf8') : buf.toString('utf8');
}
