// Command-line tool for managing the skills registry.
//
// Commands:
//   validate   Read and check every skills/<name>/SKILL.md. Fails with a clear error on a problem.
//   list       Show active skills, their domain_key, tool set, and whether a domain schema is present.
//   sync       Create rows in mem.agent_domains for the skills' domain keys (domain_key → domain_id mapping).
//
// The sync command does not store schemas in the database: the source of a schema is the file next to the skill.
// Sync only guarantees that for each domain key there is a lookup row with a numeric domain_id, which the foreign
// keys of the memory tables reference.
import { loadSkills, listSkillRoutes, getSkill } from './registry.js';
import { query, closePool } from '../../db.js';
import { flushLlmLog } from '../llm-log.js';

function cmdValidate() {
  const { byName } = loadSkills({ force: true });
  console.log(`Skills checked: ${byName.size}.`);
  for (const skill of byName.values()) {
    const schema = skill.definition ? `schema: ${skill.definition.entities.length} entities` : 'schema: none';
    console.log(`  • ${skill.name} → domain ${skill.domain_key}; ${schema}`);
  }
  console.log('All definitions are valid.');
}

function cmdList() {
  const routes = listSkillRoutes();
  if (!routes.length) {
    console.log('No active skills.');
    return;
  }
  console.log('Active skills:');
  for (const r of routes) {
    const skill = getSkill(r.name);
    const tools = skill.tools.allowed.length ? skill.tools.allowed.join(', ') : '(base only)';
    const schema = skill.definition ? `${skill.definition.entities.length} entities` : 'none';
    console.log(`  • ${r.name} / domain ${r.domain_key} — ${r.title}`);
    console.log(
      `      tools: ${tools}; domain schema: ${schema}; references: ${skill.references.allowed ? 'yes' : 'no'}`,
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
      console.log(`  + created domain ${skill.domain_key}`);
    }
  }
  console.log(`Sync complete. New domains created: ${created}.`);
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
        console.log('Commands: validate | list | sync');
        process.exitCode = 1;
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exitCode = 1;
  } finally {
    await flushLlmLog();
    await closePool();
  }
}

main();
