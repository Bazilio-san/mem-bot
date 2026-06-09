// Командная строка управления реестром skills.
//
// Команды:
//   validate   Прочитать и проверить все skills/<name>/SKILL.md. Падает с понятной ошибкой при проблеме.
//   list       Показать активные skills, их domain_key, набор инструментов и наличие схемы домена.
//   sync       Завести в mem.agent_domains строки для доменных ключей skills (мэппинг domain_key → domain_id).
//
// Команда sync не хранит схемы в базе: источник схемы — файл рядом со skill. Sync лишь гарантирует, что для
// каждого доменного ключа есть строка-справочник с числовым domain_id, на который ссылаются внешние ключи
// таблиц памяти.
import { loadSkills, listSkillRoutes, getSkill } from './registry.js';
import { query, closePool } from '../../db.js';
import { flushLlmLog } from '../llm-log.js';

function cmdValidate() {
  const { byName } = loadSkills({ force: true });
  console.log(`Проверено skills: ${byName.size}.`);
  for (const skill of byName.values()) {
    const schema = skill.definition ? `схема: ${skill.definition.entities.length} сущн.` : 'схема: нет';
    console.log(`  • ${skill.name} → domain ${skill.domain_key}; ${schema}`);
  }
  console.log('Все описания валидны.');
}

function cmdList() {
  const routes = listSkillRoutes();
  if (!routes.length) {
    console.log('Активных skills нет.');
    return;
  }
  console.log('Активные skills:');
  for (const r of routes) {
    const skill = getSkill(r.name);
    const tools = skill.tools.allowed.length ? skill.tools.allowed.join(', ') : '(только базовые)';
    const schema = skill.definition ? `${skill.definition.entities.length} сущностей` : 'нет';
    console.log(`  • ${r.name} / domain ${r.domain_key} — ${r.title}`);
    console.log(
      `      инструменты: ${tools}; схема домена: ${schema}; справочники: ${skill.references.allowed ? 'да' : 'нет'}`,
    );
  }
}

async function cmdSync() {
  const { byName } = loadSkills({ force: true });
  let created = 0;
  for (const skill of byName.values()) {
    const { rowCount } = await query(
      `INSERT INTO mem.agent_domains (domain_key, title, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (domain_key) DO NOTHING`,
      [skill.domain_key, skill.title, skill.description || null],
    );
    if (rowCount) {
      created += rowCount;
      console.log(`  + создан domain ${skill.domain_key}`);
    }
  }
  console.log(`Синхронизация завершена. Заведено новых доменов: ${created}.`);
}

async function main() {
  const command = process.argv[2];
  try {
    switch (command) {
      case 'validate':
        cmdValidate();
        break;
      case 'list':
        cmdList();
        break;
      case 'sync':
        await cmdSync();
        break;
      default:
        console.log('Команды: validate | list | sync');
        process.exitCode = 1;
    }
  } catch (err) {
    console.error('Ошибка:', err.message);
    process.exitCode = 1;
  } finally {
    await flushLlmLog();
    await closePool();
  }
}

main();
