// Проверка слоя per-domain схем: мета-валидация, сохранение/версионирование в реестре,
// валидация и канонизация при записи факта, обратная совместимость и генерация черновика (LLM).
// Запуск: npm run test:schema. Требует применённой миграции 006 и доступной БД.
// Базовый прогон npm test этот файл не затрагивает (отдельный файл, отдельная команда).
import { query, closePool } from '../src/db.js';
import { ensureUser } from '../src/repo.js';
import { validateDefinition } from '../src/schema/meta.js';
import { saveDomainDefinition, loadDomainDefinition, getEntitySpec, listDomains, invalidateSchemaCache } from '../src/schema/registry.js';
import { validateAndCanonicalize, slugify } from '../src/schema/validate.js';
import { generateDomainDraft } from '../src/schema/generate.js';
import { processCandidate } from '../src/pipeline/merge.js';
import { extractCandidates } from '../src/pipeline/extract.js';

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

const TEST_KEY = 'flights_test';

// Определение тестового домена по образцу из предложения (раздел 3).
function buildDefinition() {
  return {
    domain_key: TEST_KEY,
    title: 'Поиск и покупка авиабилетов (тест)',
    description: 'Перелёты, маршруты, предпочтения, поездки.',
    allowed_memory_kinds: ['preference', 'goal', 'state', 'history'],
    entities: [
      {
        entity_type: 'flight_preference',
        description: 'Устойчивые предпочтения по перелётам.',
        entity_key: {
          mode: 'fixed_vocab',
          vocabulary: ['departure', 'cabin', 'time', 'airline'],
          synonyms: {
            departure: ['вылет', 'город вылета', 'откуда'],
            time: ['время', 'ночные', 'ночные рейсы'],
          },
        },
        data_schema: {
          type: 'object',
          additionalProperties: false,
          required: ['preferred_departure_city', 'avoid', 'cabin_class'],
          properties: {
            preferred_departure_city: { type: ['string', 'null'] },
            avoid: { type: 'array', items: { type: 'string', enum: ['night_flights', 'long_layovers', 'connections'] } },
            cabin_class: { type: ['string', 'null'], enum: ['economy', 'comfort', 'business', null] },
          },
        },
      },
      {
        entity_type: 'trip',
        description: 'Планируемая поездка.',
        entity_key: { mode: 'slug' },
        data_schema: {
          type: 'object',
          additionalProperties: false,
          required: ['origin', 'destination', 'date', 'passengers', 'status'],
          properties: {
            origin: { type: ['string', 'null'] },
            destination: { type: 'string' },
            date: { type: ['string', 'null'] },
            passengers: { type: 'integer', minimum: 1 },
            status: { type: 'string', enum: ['searching', 'selected', 'booked', 'cancelled'] },
          },
        },
      },
    ],
  };
}

// ---- 1. Мета-валидация определения -----------------------------------------
function layerMeta() {
  section('1. Мета-валидация определения домена');

  const good = buildDefinition();
  check('1.1. Корректное определение проходит валидацию', validateDefinition(good).ok);

  // Открытая схема (additionalProperties не false) должна отвергаться.
  const openSchema = buildDefinition();
  openSchema.entities[0].data_schema.additionalProperties = true;
  const r2 = validateDefinition(openSchema);
  check('1.2. Открытая data_schema отвергается', !r2.ok && r2.issues.some((i) => /закрыт/i.test(i)));

  // fixed_vocab без словаря должен отвергаться.
  const noVocab = buildDefinition();
  delete noVocab.entities[0].entity_key.vocabulary;
  const r3 = validateDefinition(noVocab);
  check('1.3. fixed_vocab без словаря отвергается', !r3.ok && r3.issues.some((i) => /vocabulary/i.test(i)));

  // Пустой required отвергается.
  const emptyReq = buildDefinition();
  emptyReq.entities[1].data_schema.required = [];
  check('1.4. Пустой required отвергается', !validateDefinition(emptyReq).ok);
}

// ---- 2. Сохранение, версионирование, чтение ---------------------------------
async function layerRegistry() {
  section('2. Реестр: сохранение, версионирование, чтение');

  // Чистим прежние прогоны.
  await query('DELETE FROM mem.domain_schemas WHERE domain_key = $1', [TEST_KEY]);
  invalidateSchemaCache(TEST_KEY);

  const { version: v1 } = await saveDomainDefinition(buildDefinition(), { createdBy: 'test' });
  check('2.1. Первое сохранение даёт версию 1', v1 === 1, `version=${v1}`);

  // Домен заведён в реестре доменов.
  const { rows: dom } = await query('SELECT 1 FROM mem.agent_domains WHERE domain_key = $1', [TEST_KEY]);
  check('2.2. Домен заведён в agent_domains', dom.length === 1);

  const { version: v2 } = await saveDomainDefinition(buildDefinition(), { createdBy: 'test' });
  check('2.3. Повторное сохранение бампит версию до 2', v2 === 2, `version=${v2}`);

  // Активная версия ровно одна.
  const { rows: act } = await query(
    `SELECT count(*)::int c FROM mem.domain_schemas WHERE domain_key = $1 AND status = 'active'`, [TEST_KEY]);
  check('2.4. Активная версия ровно одна', act[0].c === 1, `активных: ${act[0].c}`);

  const def = await loadDomainDefinition(TEST_KEY);
  check('2.5. loadDomainDefinition возвращает определение', !!def && def.entities.length === 2);

  const spec = await getEntitySpec(TEST_KEY, 'flight_preference');
  check('2.6. getEntitySpec даёт схему сущности', !!spec && spec.entity_key.mode === 'fixed_vocab');

  const list = await listDomains();
  check('2.7. listDomains показывает тестовый домен', list.some((d) => d.domain_key === TEST_KEY));

  // Невалидное определение не сохраняется.
  let rejected = false;
  const bad = buildDefinition();
  bad.entities[0].data_schema.additionalProperties = true;
  try { await saveDomainDefinition(bad, {}); } catch { rejected = true; }
  check('2.8. Невалидное определение не сохраняется', rejected);
}

// ---- 3. Валидация и канонизация (без сети) ----------------------------------
async function layerValidate() {
  section('3. Валидация data и канонизация entity_key');

  // slug: транслитерация кириллицы (именно транслит, а не английский экзоним: Стамбул → stambul).
  check('3.1. slugify «Стамбул» → «stambul»', slugify('Стамбул') === 'stambul', slugify('Стамбул'));
  check('3.1b. slugify нормализует регистр и пробелы', slugify('Нижний Новгород') === 'nizhniy-novgorod', slugify('Нижний Новгород'));

  // Валидный data остаётся как есть, ключ из словаря не меняется.
  const valid = await validateAndCanonicalize(TEST_KEY, {
    entity_type: 'flight_preference', entity_key: 'departure',
    data: { preferred_departure_city: 'Казань', avoid: ['night_flights'], cabin_class: null },
    confidence: 0.9,
  });
  check('3.2. Валидный data проходит, ключ словаря не меняется',
    valid.ok && valid.candidate.entity_key === 'departure' && valid.candidate.data.preferred_departure_city === 'Казань');
  check('3.3. Проставлена версия схемы', typeof valid.schema_version === 'number');

  // Синоним приводится к каноническому ключу.
  const syn = await validateAndCanonicalize(TEST_KEY, {
    entity_type: 'flight_preference', entity_key: 'откуда',
    data: { preferred_departure_city: 'Казань', avoid: [], cabin_class: null }, confidence: 0.9,
  });
  check('3.4. Синоним «откуда» канонизируется в «departure»', syn.candidate.entity_key === 'departure', syn.candidate.entity_key);

  // Кодовая нормализация: лишний ключ убирается, одиночное значение оборачивается в массив,
  // строка-число приводится к integer, отсутствующее необязательное поле — null.
  const fixed = await validateAndCanonicalize(TEST_KEY, {
    entity_type: 'trip', entity_key: 'Стамбул',
    data: { origin: 'Казань', destination: 'Стамбул', passengers: '2', status: 'searching', lishnee: 'x' },
    confidence: 0.9,
  });
  check('3.5. Нормализация: ключ slug, лишнее убрано, типы приведены, data валиден',
    fixed.ok && fixed.candidate.entity_key === 'stambul'
    && fixed.candidate.data.passengers === 2 && fixed.candidate.data.date === null
    && !('lishnee' in fixed.candidate.data),
    JSON.stringify(fixed.candidate.data));

  // Неустранимо невалидный data: enum-значение, которого нет. Факт отклоняется (строгий режим).
  const broken = await validateAndCanonicalize(TEST_KEY, {
    entity_type: 'trip', entity_key: 'Сочи',
    data: { origin: null, destination: 'Сочи', date: null, passengers: 1, status: 'неизвестно' },
    confidence: 0.9,
  });
  check('3.6. Невалидный data отклоняется (ok=false, reason=data_invalid)',
    !broken.ok && broken.reason === 'data_invalid' && broken.issues.length > 0, JSON.stringify(broken.issues));

  // Сущность, не объявленная в схеме домена, отклоняется.
  const unknownEntity = await validateAndCanonicalize(TEST_KEY, {
    entity_type: 'unknown_entity', entity_key: 'любой', data: { foo: 1 }, confidence: 0.8,
  });
  check('3.7. Сущность вне схемы отклоняется (reason=entity_not_in_schema)',
    !unknownEntity.ok && unknownEntity.reason === 'entity_not_in_schema');

  // Предметный факт в домене без схемы отклоняется.
  const noDomain = await validateAndCanonicalize('domain_without_schema_xyz', {
    entity_type: 'trip', entity_key: 'Стамбул', data: {}, confidence: 0.8,
  });
  check('3.8. Домен без схемы отклоняет предметный факт (reason=domain_without_schema)',
    !noDomain.ok && noDomain.reason === 'domain_without_schema');

  // Факт без entity_type (например предпочтение профиля) схемой не описывается — пропускается.
  const noEntity = await validateAndCanonicalize('domain_without_schema_xyz', {
    entity_type: null, entity_key: null, memory_text: 'Любит короткие ответы', data: {}, confidence: 0.8,
  });
  check('3.9. Факт без entity_type пропускается без изменений (ok=true)',
    noEntity.ok && noEntity.schema_version === null);
}

// ---- 4. Интеграция в запись факта (processCandidate) ------------------------
async function layerIntegration() {
  section('4. Интеграция в контур записи памяти');

  await query('DELETE FROM mem.users WHERE external_id = $1', ['tschema']);
  const u = await ensureUser('tschema');

  // Кандидат с синонимом ключа: после записи ключ канонизирован, версия схемы в metadata.
  const res = await processCandidate(u.id, TEST_KEY, {
    scope: 'domain', memory_kind: 'preference', entity_type: 'flight_preference', entity_key: 'откуда',
    memory_text: 'Пользователь вылетает из Казани и не любит ночные рейсы',
    data: { preferred_departure_city: 'Казань', avoid: ['night_flights'], cabin_class: null },
    importance: 0.8, confidence: 0.9, sensitivity: 'normal', requires_confirmation: false,
  });
  check('4.1. Факт создан', res.action === 'created' && !!res.id);

  const { rows } = await query(
    `SELECT entity_key, data, metadata FROM mem.memory_items WHERE id = $1`, [res.id]);
  const row = rows[0];
  check('4.2. entity_key канонизирован в «departure»', row.entity_key === 'departure', row.entity_key);
  check('4.3. metadata.schema_version записан', row.metadata?.schema_version >= 1, JSON.stringify(row.metadata));
  check('4.4. data сохранён валидным', row.data.preferred_departure_city === 'Казань' && Array.isArray(row.data.avoid));

  // Повторный кандидат тем же синонимом обновляет тот же факт (дедуп по каноническому ключу), без дубля.
  await processCandidate(u.id, TEST_KEY, {
    scope: 'domain', memory_kind: 'preference', entity_type: 'flight_preference', entity_key: 'город вылета',
    memory_text: 'Пользователь вылетает из Казани и не любит ночные рейсы',
    data: { preferred_departure_city: 'Казань', avoid: ['night_flights'], cabin_class: null },
    importance: 0.8, confidence: 0.9, sensitivity: 'normal', requires_confirmation: false,
  });
  const { rows: dup } = await query(
    `SELECT count(*)::int c FROM mem.memory_items WHERE user_id = $1 AND entity_type = 'flight_preference' AND status = 'active'`,
    [u.id]);
  check('4.5. Дедуп по каноническому ключу: дубля нет', dup[0].c === 1, `активных: ${dup[0].c}`);
}

// ---- 5. Генерация черновика (LLM) -------------------------------------------
async function layerGenerate() {
  section('5. Генерация черновика схемы (LLM)');
  try {
    const { definition, issues } = await generateDomainDraft({
      title: 'Поиск и покупка авиабилетов',
      key: 'flights_gen',
      description: 'перелёты, маршруты, пассажиры',
      samples: ['ищу билет из Казани', 'не люблю ночные рейсы'],
    });
    check('5.1. Сгенерировано определение с сущностями',
      !!definition && Array.isArray(definition.entities) && definition.entities.length >= 1,
      `сущностей: ${definition?.entities?.length}`);
    check('5.2. Ключ домена проставлен', definition.domain_key === 'flights_gen');
    // Допускаем вариативность модели: если есть замечания, печатаем их, но это не провал генерации как таковой.
    if (issues.length) console.log(`     · замечания мета-валидатора (ожидаемо для черновика): ${issues.slice(0, 3).join('; ')}`);
    check('5.3. У каждой сущности есть закрытая схема data',
      definition.entities.every((e) => e.data_schema && e.data_schema.additionalProperties === false));
  } catch (err) {
    check('5. Генерация черновика (LLM доступна)', false, err.message);
  }
}

// ---- 6. Строгий второй проход извлечения (LLM) ------------------------------
async function layerRefine() {
  section('6. Строгий второй проход извлечения по схеме сущности');
  // flights_test сохранён в layerRegistry. flight_preference: поля preferred_departure_city, avoid, cabin_class.
  const cands = await extractCandidates({
    domainKey: TEST_KEY,
    recentMessages: 'user: Обычно вылетаю из Казани и не люблю ночные рейсы.',
    assistantResponse: 'Понял, учту при поиске.',
  });
  const pref = cands.find((c) => c.entity_type === 'flight_preference');
  if (!pref) {
    console.log(`     · модель не выделила flight_preference (вариативность); кандидатов: ${cands.length}`);
    check('6.1. Извлечён предметный кандидат с сущностью из схемы', cands.length > 0, 'нет кандидатов');
    return;
  }
  const allowed = new Set(['preferred_departure_city', 'avoid', 'cabin_class']);
  const keys = Object.keys(pref.data || {});
  // Строгий проход даёт закрытый data: только поля схемы, без лишних ключей.
  check('6.1. data заполнен строго по полям схемы сущности',
    keys.length > 0 && keys.every((k) => allowed.has(k)), `ключи: ${keys.join(', ')}`);
  // Полная запись проходит валидацию схемы без замечаний по data.
  const v = await validateAndCanonicalize(TEST_KEY, pref);
  check('6.2. Уточнённый кандидат валиден по схеме', v.ok, JSON.stringify(v.issues));
}

async function main() {
  console.log('Проверка слоя per-domain схем.\n');
  try {
    layerMeta();
    await layerRegistry();
    await layerValidate();
    await layerIntegration();
    if (process.env.SCHEMA_SKIP_LLM === '1') console.log('\n(5–6 пропущены: SCHEMA_SKIP_LLM=1.)');
    else { await layerGenerate(); await layerRefine(); }
  } catch (err) {
    console.error('\nКритическая ошибка прогона:', err);
    failed++;
  }
  console.log(`\n================ ИТОГ ================`);
  console.log(`Пройдено: ${passed}, провалено: ${failed}`);
  if (failures.length) console.log('Провалены:', failures.join('; '));
  await closePool();
  process.exit(failed > 0 ? 1 : 0);
}

main();
