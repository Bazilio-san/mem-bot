// Тесты сущностного буста в retrieveMemory (src/pipeline/retrieve.js): добор фактов по сущностям
// в пул кандидатов мимо топ-100, гарантированный пол релевантности 0.7, подстрочная пометка для
// русских словоформ, фильтр коротких сущностей и неизменность поведения при пустом списке сущностей.
// Используют реальную БД; запросы идут с пустым query, чтобы не зависеть от эмбеддингов и LLM.
// Запуск: npm run test:retrieve-entities
import assert from 'node:assert/strict';
import { query, closePool } from '../src/db.js';
import { ensureUser } from '../src/repo.js';
import { retrieveMemory } from '../src/pipeline/retrieve.js';

// Чистый пользователь для теста: прежние данные внешнего id удаляются каскадом.
async function freshUser(extId) {
  await query('DELETE FROM mem.users WHERE external_id = $1', [extId]);
  return ensureUser(extId);
}

// Прямой посев факта без LLM. confidence управляет попаданием в топ-100 шага 1.
// Тип по умолчанию — preference: тип profile входит в CORE_TYPES и получает собственную надбавку
// релевантности до 0.6, которая смазала бы картину сравнения сущностного буста с базой.
async function seedFact(userId, { domainKey = 'general', type = 'preference', text, confidence = 0.8 }) {
  await query(
    `INSERT INTO mem.user_facts (user_id, domain_key, fact_type, fact_text, confidence)
     VALUES ($1,$2,$3,$4,$5)`,
    [userId, domainKey, type, text, confidence],
  );
}

const TEANA = 'Пользователь ездит на Nissan Teana.';

// 1. Добор кандидатов: факт с низкой уверенностью не проходит в топ-100 шага 1, но сущность
// добирает его отдельным запросом, и пол релевантности выносит его в выдачу.
{
  const u = await freshUser('t-ent-recall');
  for (let i = 0; i < 100; i++) {
    await seedFact(u.id, { text: `Факт-наполнитель номер ${i} про повседневные мелочи.`, confidence: 0.9 });
  }
  await seedFact(u.id, { text: TEANA, confidence: 0.2 });

  const baseline = await retrieveMemory({ userId: u.id, domainKey: 'general', query: '', scopes: ['profile'] });
  assert.equal(
    baseline.profile.some((f) => f.fact_text === TEANA),
    false,
    'без сущностей факт вне топ-100 не должен попадать в выдачу',
  );
  assert.equal(baseline.entityStats.recallAdded, 0);

  const boosted = await retrieveMemory({
    userId: u.id,
    domainKey: 'general',
    query: '',
    scopes: ['profile'],
    entityKeys: ['Nissan Teana'],
  });
  assert.equal(
    boosted.profile.some((f) => f.fact_text === TEANA),
    true,
    'сущность должна добрать факт мимо топ-100 и поднять его в выдачу',
  );
  assert.equal(boosted.entityStats.recallAdded, 1, 'ровно один факт добран мимо топ-100');
  assert.ok(boosted.entityStats.matched >= 1);
}

// 2. Пол релевантности: факт уже в пуле кандидатов, но с меньшей уверенностью, чем наполнители;
// без сущностей он проигрывает ранжирование, с сущностью — получает пол 0.7 и выходит в топ группы.
{
  const u = await freshUser('t-ent-floor');
  for (let i = 0; i < 10; i++) {
    await seedFact(u.id, { text: `Факт-наполнитель номер ${i} про повседневные мелочи.`, confidence: 0.9 });
  }
  await seedFact(u.id, { text: TEANA, confidence: 0.5 });

  const baseline = await retrieveMemory({ userId: u.id, domainKey: 'general', query: '', scopes: ['profile'] });
  assert.equal(
    baseline.profile.some((f) => f.fact_text === TEANA),
    false,
    'без сущностей факт с низкой уверенностью проигрывает наполнителям',
  );

  const boosted = await retrieveMemory({
    userId: u.id,
    domainKey: 'general',
    query: '',
    scopes: ['profile'],
    entityKeys: ['Nissan Teana'],
  });
  assert.equal(
    boosted.profile.some((f) => f.fact_text === TEANA),
    true,
    'пол релевантности 0.7 должен поднять сущностный факт в выдачу',
  );
  assert.equal(boosted.entityStats.recallAdded, 0, 'факт уже был в пуле кандидатов — добора нет');
  assert.ok(boosted.entityStats.matched >= 1);
}

// 3. Морфология подстрокой: конфигурация 'simple' полнотекстового индекса не знает русских
// словоформ («Берлин» не совпадает с «Берлине» через tsquery), но начальная форма является
// префиксом словоформы и ловится подстрочной пометкой по загруженным кандидатам.
{
  const u = await freshUser('t-ent-morph');
  const berlin = 'Пользователь живёт в Берлине и любит кофе.';
  for (let i = 0; i < 10; i++) {
    await seedFact(u.id, { text: `Факт-наполнитель номер ${i} про повседневные мелочи.`, confidence: 0.9 });
  }
  await seedFact(u.id, { text: berlin, confidence: 0.5 });

  const boosted = await retrieveMemory({
    userId: u.id,
    domainKey: 'general',
    query: '',
    scopes: ['profile'],
    entityKeys: ['Берлин'],
  });
  assert.equal(
    boosted.profile.some((f) => f.fact_text === berlin),
    true,
    'словоформа «Берлине» должна совпасть с сущностью «Берлин» через подстрочную пометку',
  );
  assert.ok(boosted.entityStats.matched >= 1);
}

// 4. Фильтр коротких сущностей: значения короче трёх символов отбрасываются и буста не дают —
// иначе местоимения вроде «я» и «он» совпали бы с половиной памяти.
{
  const u = await freshUser('t-ent-short');
  await seedFact(u.id, { text: 'Пользователь любит чай, а не кофе — он так сказал.', confidence: 0.5 });

  const res = await retrieveMemory({
    userId: u.id,
    domainKey: 'general',
    query: '',
    scopes: ['profile'],
    entityKeys: ['я', 'он', '  к  '],
  });
  assert.deepEqual(res.entityStats.keys, [], 'короткие сущности должны быть отброшены');
  assert.equal(res.entityStats.matched, 0);
  assert.equal(res.entityStats.recallAdded, 0);
}

// 5. Пустой массив сущностей и вызов без параметра: поведение retrieveMemory не меняется,
// форма результата одна и та же, статистика буста нулевая.
{
  const u = await freshUser('t-ent-empty');
  await seedFact(u.id, { text: TEANA, confidence: 0.8 });

  const withEmpty = await retrieveMemory({
    userId: u.id,
    domainKey: 'general',
    query: '',
    scopes: ['profile'],
    entityKeys: [],
  });
  const withoutParam = await retrieveMemory({ userId: u.id, domainKey: 'general', query: '', scopes: ['profile'] });
  assert.deepEqual(withEmpty.entityStats, { keys: [], recallAdded: 0, matched: 0 });
  assert.deepEqual(
    withEmpty.profile.map((f) => f.fact_text),
    withoutParam.profile.map((f) => f.fact_text),
    'пустой список сущностей не должен менять выдачу',
  );
}

console.log('retrieve-entities: все проверки прошли');
await closePool();
