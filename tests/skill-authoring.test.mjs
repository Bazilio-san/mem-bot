// Тесты инструментария редактирования навыков: сериализация SKILL.md ↔ разбор, правила validateSkill и
// защита путей/удаления. Не требуют сети и базы данных (writeSkill/ensureDomainRow с БД проверяются вручную).
// Запуск: npm run test:skill-authoring
import assert from 'node:assert';
import { splitSkillFile, extractSection } from '../src/pipeline/skills/parse.js';
import { composeSkillFile, validateSkill, removeReference, deleteSkill } from '../src/pipeline/skills/writer.js';

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
async function checkA(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ❌ ${name} — ${err.message}`);
  }
}

const demo = {
  name: 'demo-skill',
  domain_key: 'demo_skill',
  title: 'Демо',
  description: 'Описание демо-навыка',
  enabled: true,
  classification: {
    hint: 'Демо-навык: демо, пример',
    when_to_use: 'Когда пользователь просит демо',
    positive_signals: ['один', 'два'],
    negative_signals: ['нет'],
  },
  memory: { scopes: ['profile', 'dialog'] },
  tools: { allowed: [], base: true },
  model: { main: null, extract: null },
  references: { allowed: false },
  skillPrompt: 'Промпт навыка.',
  factExtractionPrompt: 'Что сохранять.',
};

console.log('\n=== Сериализация SKILL.md ↔ разбор ===');

check('composeSkillFile + splitSkillFile сохраняют поля фронтматтера', () => {
  const md = composeSkillFile(demo);
  const { frontmatter: fm } = splitSkillFile(md);
  assert.equal(fm.name, 'demo-skill');
  assert.equal(fm.domain_key, 'demo_skill');
  assert.equal(fm.title, 'Демо');
  assert.equal(fm.enabled, true);
  assert.equal(fm.classification.hint, 'Демо-навык: демо, пример');
  assert.equal(fm.classification.when_to_use, 'Когда пользователь просит демо');
  assert.deepEqual(fm.classification.positive_signals, ['один', 'два']);
  assert.deepEqual(fm.memory.scopes, ['profile', 'dialog']);
  assert.equal(fm.tools.base, true);
  assert.equal(fm.model.main, null);
  assert.equal(fm.references.allowed, false);
});

check('Блоки prompt восстанавливаются из тела', () => {
  const md = composeSkillFile(demo);
  const { body } = splitSkillFile(md);
  assert.equal(extractSection(body, '# Skill Prompt'), 'Промпт навыка.');
  assert.equal(extractSection(body, '## Fact Extraction Prompt'), 'Что сохранять.');
});

console.log('\n=== Правила validateSkill ===');

await checkA('Корректный навык проходит валидацию', async () => {
  const { ok } = await validateSkill(demo);
  assert.ok(ok);
});

await checkA('Невалидное имя отклоняется', async () => {
  const { ok, issues } = await validateSkill({ ...demo, name: 'Demo_Skill' });
  assert.ok(!ok && issues.some((i) => /kebab-case/.test(i)));
});

await checkA('Невалидный domain_key отклоняется', async () => {
  const { ok, issues } = await validateSkill({ ...demo, domain_key: 'Demo Skill' });
  assert.ok(!ok && issues.some((i) => /domain_key/.test(i)));
});

await checkA('Пустой when_to_use отклоняется', async () => {
  const { ok } = await validateSkill({ ...demo, classification: { ...demo.classification, when_to_use: '' } });
  assert.ok(!ok);
});

await checkA('Пустой Skill Prompt отклоняется', async () => {
  const { ok } = await validateSkill({ ...demo, skillPrompt: '' });
  assert.ok(!ok);
});

await checkA('Неизвестный инструмент в tools.allowed отклоняется', async () => {
  const { ok, issues } = await validateSkill({ ...demo, tools: { allowed: ['no_such_tool_xyz'], base: true } });
  assert.ok(!ok && issues.some((i) => /was not found in the tool registry/.test(i)));
});

await checkA('Занятый domain_key отклоняется', async () => {
  const { ok, issues } = await validateSkill({ ...demo, name: 'other-skill', domain_key: 'flight_search' });
  assert.ok(!ok && issues.some((i) => /is already taken/.test(i)));
});

console.log('\n=== Защита путей и удаления ===');

check('removeReference запрещает выход через ..', () => {
  assert.throws(
    () => removeReference('flight-search', '../SKILL.md', { confirm: true }),
    /Invalid reference path|escapes the skill/,
  );
});

check('removeReference требует confirm=true', () => {
  assert.throws(() => removeReference('flight-search', 'airlines.md', {}), /confirm=true/);
});

check('deleteSkill требует confirm=true', () => {
  assert.throws(() => deleteSkill('demo-skill', {}), /confirm=true/);
});

check('deleteSkill запрещает удаление general и skill-author', () => {
  assert.throws(() => deleteSkill('general', { confirm: true }), /cannot be deleted/);
  assert.throws(() => deleteSkill('skill-author', { confirm: true }), /cannot be deleted/);
});

console.log(`\nИтого: ${passed} прошло, ${failed} провалено.`);
process.exit(failed ? 1 : 0);
