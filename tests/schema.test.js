// Проверка слоя схем доменной памяти: мета-валидация определения, валидация data и канонизация
// entity_key. Схемы используются инструментами skill authoring (schema-edit/schema-generate);
// в конвейер записи фактов (mem.user_facts) они больше не входят.
// Источник схемы — реестр skills (skills/<name>/domain-schema.json). Запуск: npm run test:schema.
import { closePool } from '../src/db.js';
import { validateDefinition } from '../src/schema/meta.js';
import { getEntitySpec, loadDomainDefinition } from '../src/schema/registry.js';
import { validateAndCanonicalize, slugify } from '../src/schema/validate.js';

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}
function section(t) {
  console.log(`\n=== ${t} ===`);
}

// Домен, на котором проверяем валидацию: его схема описана в skills/flight-search/domain-schema.json.
const DOMAIN = 'flight_search';

// Образец определения домена для мета-валидации (форма, которую читает мета-валидатор).
function buildDefinition() {
  return {
    domain_key: 'flights_meta',
    title: 'Поиск авиабилетов (мета-проверка)',
    description: 'Перелёты, маршруты, предпочтения.',
    allowed_memory_kinds: ['preference', 'goal', 'state', 'history'],
    entities: [
      {
        entity_type: 'flight_preference',
        description: 'Устойчивые предпочтения по перелётам.',
        entity_key: {
          mode: 'fixed_vocab',
          vocabulary: ['departure', 'cabin'],
          synonyms: { departure: ['вылет', 'откуда'] },
        },
        data_schema: {
          type: 'object',
          additionalProperties: false,
          required: ['avoid', 'cabin_class'],
          properties: {
            avoid: { type: 'array', items: { type: 'string' } },
            cabin_class: { type: ['string', 'null'] },
          },
        },
      },
    ],
  };
}

// ---- 1. Мета-валидация определения -----------------------------------------
function layerMeta() {
  section('1. Мета-валидация определения домена');

  check('1.1. Корректное определение проходит валидацию', validateDefinition(buildDefinition()).ok);

  const openSchema = buildDefinition();
  openSchema.entities[0].data_schema.additionalProperties = true;
  const r2 = validateDefinition(openSchema);
  check('1.2. Открытая data_schema отвергается', !r2.ok && r2.issues.some((i) => /закрыт/i.test(i)));

  const noVocab = buildDefinition();
  delete noVocab.entities[0].entity_key.vocabulary;
  const r3 = validateDefinition(noVocab);
  check('1.3. fixed_vocab без словаря отвергается', !r3.ok && r3.issues.some((i) => /vocabulary/i.test(i)));

  const emptyReq = buildDefinition();
  emptyReq.entities[0].data_schema.required = [];
  check('1.4. Пустой required отвергается', !validateDefinition(emptyReq).ok);
}

// ---- 2. Схема домена доступна из реестра skills -----------------------------
async function layerSource() {
  section('2. Схема домена из реестра skills');

  const def = await loadDomainDefinition(DOMAIN);
  check(
    '2.1. loadDomainDefinition отдаёт схему из skill',
    !!def && def.entities.length >= 1,
    `сущностей: ${def?.entities?.length}`,
  );

  const spec = await getEntitySpec(DOMAIN, 'city');
  check('2.2. getEntitySpec даёт схему сущности city', !!spec && spec.entity_key.mode === 'fixed_vocab');

  const none = await loadDomainDefinition('no_such_domain_xyz');
  check('2.3. Для домена без skill схемы нет (null)', none === null);
}

// ---- 3. Валидация data и канонизация entity_key (без сети) -------------------
async function layerValidate() {
  section('3. Валидация data и канонизация entity_key');

  check('3.1. slugify «Стамбул» → «stambul»', slugify('Стамбул') === 'stambul', slugify('Стамбул'));
  check(
    '3.1b. slugify нормализует регистр и пробелы',
    slugify('Нижний Новгород') === 'nizhniy-novgorod',
    slugify('Нижний Новгород'),
  );

  // Валидный data, ключ из словаря не меняется. Источник схемы — skill, версия помечается маркером 'skill'.
  const valid = await validateAndCanonicalize(DOMAIN, {
    entity_type: 'city',
    entity_key: 'departure',
    data: { city_name: 'Казань' },
    confidence: 0.9,
  });
  check(
    '3.2. Валидный data проходит, ключ словаря не меняется',
    valid.ok && valid.candidate.entity_key === 'departure' && valid.candidate.data.city_name === 'Казань',
  );
  check('3.3. Проставлен маркер источника схемы', valid.schema_version === 'skill', String(valid.schema_version));

  // Синоним приводится к каноническому ключу.
  const syn = await validateAndCanonicalize(DOMAIN, {
    entity_type: 'city',
    entity_key: 'откуда',
    data: { city_name: 'Казань' },
    confidence: 0.9,
  });
  check(
    '3.4. Синоним «откуда» канонизируется в «departure»',
    syn.candidate.entity_key === 'departure',
    syn.candidate.entity_key,
  );

  // Кодовая нормализация: лишний ключ убирается, строка-число приводится к integer, отсутствующее поле — null.
  const fixed = await validateAndCanonicalize(DOMAIN, {
    entity_type: 'trip',
    entity_key: 'Стамбул',
    data: { origin: 'Казань', destination: 'Стамбул', passengers: '2', status: 'searching', lishnee: 'x' },
    confidence: 0.9,
  });
  check(
    '3.5. Нормализация: ключ slug, лишнее убрано, типы приведены, data валиден',
    fixed.ok &&
      fixed.candidate.entity_key === 'stambul' &&
      fixed.candidate.data.passengers === 2 &&
      fixed.candidate.data.date === null &&
      !('lishnee' in fixed.candidate.data),
    JSON.stringify(fixed.candidate.data),
  );

  // Неустранимо невалидный data: тип не сходится. Факт отклоняется (строгий режим).
  const broken = await validateAndCanonicalize(DOMAIN, {
    entity_type: 'trip',
    entity_key: 'Сочи',
    data: { origin: null, destination: 123, date: null, passengers: 1, status: 'searching' },
    confidence: 0.9,
  });
  check(
    '3.6. Невалидный data отклоняется (ok=false, reason=data_invalid)',
    !broken.ok && broken.reason === 'data_invalid' && broken.issues.length > 0,
    JSON.stringify(broken.issues),
  );

  // Сущность, не объявленная в схеме домена, отклоняется.
  const unknownEntity = await validateAndCanonicalize(DOMAIN, {
    entity_type: 'unknown_entity',
    entity_key: 'любой',
    data: { foo: 1 },
    confidence: 0.8,
  });
  check(
    '3.7. Сущность вне схемы отклоняется (reason=entity_not_in_schema)',
    !unknownEntity.ok && unknownEntity.reason === 'entity_not_in_schema',
  );

  // Предметный факт в домене без схемы отклоняется.
  const noDomain = await validateAndCanonicalize('domain_without_schema_xyz', {
    entity_type: 'trip',
    entity_key: 'Стамбул',
    data: {},
    confidence: 0.8,
  });
  check(
    '3.8. Домен без схемы отклоняет предметный факт (reason=domain_without_schema)',
    !noDomain.ok && noDomain.reason === 'domain_without_schema',
  );

  // Факт без entity_type (например предпочтение профиля) схемой не описывается — пропускается.
  const noEntity = await validateAndCanonicalize('domain_without_schema_xyz', {
    entity_type: null,
    entity_key: null,
    memory_text: 'Любит короткие ответы',
    data: {},
    confidence: 0.8,
  });
  check(
    '3.9. Факт без entity_type пропускается без изменений (ok=true)',
    noEntity.ok && noEntity.schema_version === null,
  );
}

async function main() {
  console.log('Проверка слоя схем доменной памяти.\n');
  try {
    layerMeta();
    await layerSource();
    await layerValidate();
  } catch (err) {
    console.error('\nКритическая ошибка прогона:', err);
    failed++;
  }
  console.log('\n================ ИТОГ ================');
  console.log(`Пройдено: ${passed}, провалено: ${failed}`);
  if (failures.length) {
    console.log('Провалены:', failures.join('; '));
  }
  await closePool();
  process.exit(failed > 0 ? 1 : 0);
}

main();
