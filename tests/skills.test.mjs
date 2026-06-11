// Тесты реестра skills и разборщика SKILL.md. Не требуют базы данных и моделей: проверяют только
// чтение, разбор и валидацию файлов skills, а также защиту чтения справочников от выхода за каталог.
// Запуск: npm run test:skills
import assert from 'node:assert';
import { config } from '../src/config.js';
import { parseFrontmatter, splitSkillFile, extractSection, extractJsonBlock } from '../src/pipeline/skills/parse.js';
import {
  loadSkills,
  listSkillRoutes,
  getSkill,
  getSkillByDomain,
  getSkillPrompt,
  getFactExtractionPrompt,
  getReference,
} from '../src/pipeline/skills/registry.js';
import { buildToolDefs } from '../src/pipeline/tools.js';
import { skillReadReferenceTool } from '../src/pipeline/agent-tools/skill-read-reference.js';

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ❌ ${name} — ${err.message}`);
  }
}

console.log('\n=== Разборщик фронтматтера SKILL.md ===');

check('Вложенные отображения, списки и скаляры разбираются', () => {
  const fm = parseFrontmatter(`name: demo
domain_key: demo_key
enabled: true
classification:
  when_to_use: >
    Первая строка
    вторая строка.
  positive_signals:
    - один
    - два
memory:
  scopes: [profile, domain, dialog]
model:
  main: null
  extract: null`);
  assert.equal(fm.name, 'demo');
  assert.equal(fm.domain_key, 'demo_key');
  assert.equal(fm.enabled, true);
  assert.equal(fm.classification.when_to_use, 'Первая строка вторая строка.');
  assert.deepEqual(fm.classification.positive_signals, ['один', 'два']);
  assert.deepEqual(fm.memory.scopes, ['profile', 'domain', 'dialog']);
  assert.equal(fm.model.main, null);
});

check('splitSkillFile отделяет фронтматтер от тела', () => {
  const { frontmatter, body } = splitSkillFile('---\nname: x\n---\n# Skill Prompt\n\nтекст');
  assert.equal(frontmatter.name, 'x');
  assert.match(body, /# Skill Prompt/);
});

check('extractSection берёт нужный блок и останавливается на следующем заголовке', () => {
  const body = '# Skill Prompt\n\nААА\n\n## Fact Extraction Prompt\n\nБББ';
  assert.equal(extractSection(body, '# Skill Prompt'), 'ААА');
  assert.equal(extractSection(body, '## Fact Extraction Prompt'), 'БББ');
});

check('extractJsonBlock разбирает JSON из блока ```json', () => {
  const obj = extractJsonBlock('```json\n{ "a": 1 }\n```');
  assert.deepEqual(obj, { a: 1 });
});

console.log('\n=== Реестр skills ===');

let routes;
check('loadSkills читает все три skill', () => {
  const { byName, byDomain } = loadSkills({ force: true });
  assert.ok(byName.has('general'), 'нет general');
  assert.ok(byName.has('flight-search'), 'нет flight-search');
  assert.ok(byName.has('math-tutor'), 'нет math-tutor');
  assert.equal(byDomain.get('flight_search').name, 'flight-search');
});

check('listSkillRoutes отдаёт when_to_use для роутера', () => {
  routes = listSkillRoutes();
  assert.ok(routes.length >= 3, `ожидалось не меньше 3 навыков, получено ${routes.length}`);
  for (const r of routes) {
    assert.ok(r.when_to_use && r.when_to_use.length > 0, `пустой when_to_use у ${r.name}`);
    assert.ok(r.domain_key, `нет domain_key у ${r.name}`);
  }
});

check('getSkillByDomain находит skill по доменному ключу', () => {
  assert.equal(getSkillByDomain('math_tutor').name, 'math-tutor');
  assert.equal(getSkill('flight-search').domain_key, 'flight_search');
});

check('# Skill Prompt и ## Fact Extraction Prompt непустые', () => {
  for (const name of ['general', 'flight-search', 'math-tutor']) {
    assert.ok(getSkillPrompt(name).length > 0, `пустой Skill Prompt у ${name}`);
    assert.ok(getFactExtractionPrompt(name).length > 0, `пустой Fact Extraction Prompt у ${name}`);
  }
});

check('tools.allowed у flight-search содержит предметные инструменты', () => {
  const skill = getSkill('flight-search');
  assert.deepEqual(skill.tools.allowed, ['search_flights', 'resolve_place']);
  assert.equal(skill.tools.base, true);
});

console.log('\n=== Чтение справочников ===');

check('getReference читает разрешённый справочник', () => {
  const text = getReference('flight-search', 'airlines.md');
  assert.match(text, /baggage/i);
});

check('getReference запрещает выход через ..', () => {
  assert.throws(() => getReference('flight-search', '../SKILL.md'), /Invalid reference path|escapes the skill/);
});

check('getReference запрещает абсолютный путь', () => {
  assert.throws(() => getReference('flight-search', 'C:/Windows/system32/drivers/etc/hosts'), /Invalid reference path/);
});

check('getReference отказывает skill без references.allowed', () => {
  assert.throws(() => getReference('math-tutor', 'whatever.md'), /disabled/);
});

console.log('\n=== Инструмент skill_read_reference и фильтрация инструментов ===');

check('skill_read_reference включён при активном skill с references.allowed', () => {
  assert.equal(skillReadReferenceTool.isEnabled({ activeSkill: getSkill('flight-search') }, config), true);
});

check('skill_read_reference выключен у skill без references.allowed', () => {
  assert.equal(skillReadReferenceTool.isEnabled({ activeSkill: getSkill('math-tutor') }, config), false);
});

check('skill_read_reference выключен без активного skill', () => {
  assert.equal(skillReadReferenceTool.isEnabled({}, config), false);
});

check('buildToolDefs включает skill_read_reference для flight-search и прячет для math-tutor', () => {
  const flightDefs = buildToolDefs({ isAdmin: false, activeSkill: getSkill('flight-search') }).map(
    (d) => d.function.name,
  );
  const mathDefs = buildToolDefs({ isAdmin: false, activeSkill: getSkill('math-tutor') }).map((d) => d.function.name);
  assert.ok(flightDefs.includes('skill_read_reference'), 'нет skill_read_reference у flight-search');
  assert.ok(!mathDefs.includes('skill_read_reference'), 'лишний skill_read_reference у math-tutor');
});

check('tools.allowed разделяет предметные инструменты между skills', () => {
  // flight-search разрешает search_flights, math-tutor — нет: фильтр buildToolDefs опирается на этот список.
  assert.ok(getSkill('flight-search').tools.allowed.includes('search_flights'));
  assert.ok(!getSkill('math-tutor').tools.allowed.includes('search_flights'));
});

console.log(`\nИтого: ${passed} прошло, ${failed} провалено.`);
process.exit(failed ? 1 : 0);
