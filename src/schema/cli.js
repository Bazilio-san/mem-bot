// Командная строка управления схемами доменов.
//
// Команды:
//   generate "<название домена>" --key <ключ> [--desc "<описание>"] [--sample "<реплика>" ...]
//       Сгенерировать черновик схемы (LLM) и записать его в schemas/<ключ>.draft.json.
//   save <путь к черновику.json>
//       Проверить черновик и сохранить новой активной версией в реестр (mem.domain_schemas).
//   list
//       Показать домены с активными схемами и их версии.
//   show <ключ домена>
//       Показать активную схему домена.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateDomainDraft } from './generate.js';
import { saveDomainDefinition, listDomains, loadDomainDefinition } from './registry.js';
import { closePool } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemasDir = path.join(__dirname, '..', '..', 'schemas');

// Разобрать флаги вида --key value и повторяемый --sample value. Возвращает { _, key, desc, sample[] }.
function parseArgs(argv) {
  const out = { _: [], sample: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--key') out.key = argv[++i];
    else if (a === '--desc') out.desc = argv[++i];
    else if (a === '--sample') out.sample.push(argv[++i]);
    else out._.push(a);
  }
  return out;
}

async function cmdGenerate(args) {
  const title = args._[0];
  if (!title) throw new Error('Укажите название домена в кавычках. Пример: generate "Поиск авиабилетов" --key flights');
  if (!args.key) throw new Error('Укажите ключ домена флагом --key (например --key flights).');

  console.log(`Генерирую черновик схемы для домена «${title}» (ключ ${args.key})…`);
  const { definition, issues } = await generateDomainDraft({
    title, key: args.key, description: args.desc, samples: args.sample,
  });

  fs.mkdirSync(schemasDir, { recursive: true });
  const file = path.join(schemasDir, `${args.key}.draft.json`);
  fs.writeFileSync(file, JSON.stringify(definition, null, 2) + '\n', 'utf8');

  console.log(`\nЧерновик записан: ${file}`);
  console.log('Сущности и поля data:');
  for (const e of definition.entities || []) {
    const fields = Object.keys(e.data_schema?.properties || {}).join(', ');
    console.log(`  • ${e.entity_type} [ключ: ${e.entity_key?.mode}] → ${fields}`);
  }
  if (issues.length) {
    console.log('\nВнимание: черновик не идеален, поправьте перед сохранением:');
    for (const i of issues) console.log(`  - ${i}`);
  }
  console.log('\nОткройте файл, проверьте и при необходимости поправьте, затем сохраните командой save.');
}

async function cmdSave(args) {
  const file = args._[0];
  if (!file) throw new Error('Укажите путь к файлу черновика. Пример: save schemas/flights.draft.json');
  const definition = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { version } = await saveDomainDefinition(definition, { createdBy: 'cli' });
  console.log(`Схема домена «${definition.domain_key}» сохранена. Активная версия: ${version}.`);
}

async function cmdList() {
  const domains = await listDomains();
  if (!domains.length) {
    console.log('Доменов с активными схемами пока нет.');
    return;
  }
  console.log('Домены с активными схемами:');
  for (const d of domains) {
    console.log(`  • ${d.domain_key} (v${d.version}) — ${d.title}; сущности: ${d.entity_types.join(', ')}`);
  }
}

async function cmdShow(args) {
  const key = args._[0];
  if (!key) throw new Error('Укажите ключ домена. Пример: show flights');
  const definition = await loadDomainDefinition(key);
  if (!definition) {
    console.log(`Активной схемы для домена «${key}» не найдено.`);
    return;
  }
  console.log(JSON.stringify(definition, null, 2));
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  try {
    switch (command) {
      case 'generate': await cmdGenerate(args); break;
      case 'save': await cmdSave(args); break;
      case 'list': await cmdList(); break;
      case 'show': await cmdShow(args); break;
      default:
        console.log('Команды: generate "<название>" --key <ключ> [--desc ..] [--sample ..] | save <файл> | list | show <ключ>');
        process.exitCode = 1;
    }
  } catch (err) {
    console.error('Ошибка:', err.message);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

main();
