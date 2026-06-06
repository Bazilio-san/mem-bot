// Универсальный механизм применения схемы домена при записи факта.
// Делает две вещи: проверяет candidate.data по закрытой схеме сущности и приводит
// candidate.entity_key к стабильному виду по правилу домена (словарь синонимов или slug).
//
// Схема обязательна. Предметный факт (тот, у которого задан entity_type) сохраняется
// только если у домена есть активная схема, в ней объявлена эта сущность, и data проходит
// валидацию. Иначе факт отклоняется (ok=false) и НЕ сохраняется — никакого «мягкого» режима.
// Факт без entity_type (например свободное предпочтение профиля) схемой не описывается и
// пропускается без изменений: это не сущность домена, а валидировать в нём нечего.
import { ajv } from './meta.js';
import { getEntitySpec, loadDomainDefinition, getActiveVersion } from './registry.js';
import { config } from '../config.js';
import { embed } from '../llm.js';

// ---- Транслитерация и slug --------------------------------------------------

// Сопоставление кириллических букв латинским сочетаниям для построения slug.
const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y',
  ь: '', э: 'e', ю: 'yu', я: 'ya',
};

// Привести произвольную строку к slug: транслитерация кириллицы, нижний регистр,
// разделение дефисами, без лишних символов. Например «Стамбул» становится «stambul».
export function slugify(value) {
  const lower = String(value || '').trim().toLowerCase();
  let out = '';
  for (const ch of lower) {
    if (Object.prototype.hasOwnProperty.call(TRANSLIT, ch)) out += TRANSLIT[ch];
    else if (/[a-z0-9]/.test(ch)) out += ch;
    else out += '-';
  }
  // Схлопнуть повторяющиеся дефисы и обрезать их по краям.
  return out.replace(/-+/g, '-').replace(/^-|-$/g, '');
}

// ---- Косинусная близость для канонизации ключа по смыслу --------------------

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Подобрать ближайший по смыслу ключ словаря к присланному значению через эмбеддинги.
// Возвращает { key, score } или null, если эмбеддинги недоступны. Используется только
// как запасной вариант, когда точное совпадение и синонимы не сработали.
async function nearestVocabKey(value, vocabulary) {
  const valueVec = await embed(value);
  if (!valueVec) return null;
  let best = null;
  for (const key of vocabulary) {
    const keyVec = await embed(key);
    if (!keyVec) continue;
    const score = cosine(valueVec, keyVec);
    if (!best || score > best.score) best = { key, score };
  }
  return best;
}

// ---- Канонизация entity_key -------------------------------------------------

// Привести entity_key кандидата к каноническому виду по правилу сущности.
// Возвращает { entity_key, issues }.
async function canonicalizeKey(rawKey, keySpec) {
  const issues = [];
  const mode = keySpec.mode;

  if (mode === 'slug') {
    const slug = slugify(rawKey);
    if (!slug) issues.push(`entity_key «${rawKey}» после нормализации в slug оказался пустым.`);
    return { entity_key: slug || rawKey, issues };
  }

  // fixed_vocab
  const vocabulary = keySpec.vocabulary || [];
  // 1. Точное совпадение со словарём — ничего менять не нужно.
  if (vocabulary.includes(rawKey)) return { entity_key: rawKey, issues };

  // 2. Поиск по синонимам: «откуда» приводим к каноническому «departure».
  const lowered = String(rawKey).trim().toLowerCase();
  for (const [canonical, synonyms] of Object.entries(keySpec.synonyms || {})) {
    if ((synonyms || []).some((s) => String(s).trim().toLowerCase() === lowered)) {
      return { entity_key: canonical, issues };
    }
  }

  // 3. Ближайший по смыслу ключ словаря (эмбеддинги), если близость выше порога.
  const nearest = await nearestVocabKey(rawKey, vocabulary);
  if (nearest && nearest.score >= config.schema.keyEmbedThreshold) {
    issues.push(`entity_key «${rawKey}» канонизирован по смыслу в «${nearest.key}» (близость ${nearest.score.toFixed(2)}).`);
    return { entity_key: nearest.key, issues };
  }

  // 4. Запасной вариант: slug от исходного значения, плюс пометка о незаканонизированном ключе.
  const fallback = slugify(rawKey) || rawKey;
  issues.push(`entity_key «${rawKey}» не найден в словаре домена; записан как «${fallback}».`);
  return { entity_key: fallback, issues };
}

// ---- Кодовая нормализация data ----------------------------------------------

// Дешёвая нормализация объекта data под закрытую схему: отбрасывает лишние ключи,
// приводит очевидные типы (число-строка → число, одиночное значение → массив, когда
// схема ждёт массив), подставляет null отсутствующим полям. Это не «мягкий режим»,
// а приведение заведомо однозначных расхождений; то, что после неё всё ещё не сходится,
// считается невалидным и факт отклоняется.
function normalizeData(data, dataSchema) {
  const props = dataSchema.properties || {};
  const out = {};
  for (const [field, fieldSchema] of Object.entries(props)) {
    let value = data ? data[field] : undefined;
    const types = Array.isArray(fieldSchema.type) ? fieldSchema.type : [fieldSchema.type];

    if (value === undefined) {
      // Отсутствующее поле: null, если допустим, иначе пустой массив для массива.
      value = types.includes('null') ? null : (types.includes('array') ? [] : null);
    } else if (types.includes('array') && !Array.isArray(value) && value !== null) {
      // Одиночное значение там, где ждут массив — оборачиваем в массив.
      value = [value];
    } else if ((types.includes('integer') || types.includes('number')) && typeof value === 'string') {
      // Строка-число — приводим к числу, если получается.
      const num = Number(value);
      if (!Number.isNaN(num)) value = types.includes('integer') ? Math.trunc(num) : num;
    }
    out[field] = value;
  }
  return out;
}

// ---- Главная функция --------------------------------------------------------

// Проверить и канонизировать кандидата перед сохранением в память.
// Возвращает { ok, candidate, issues, schema_version, reason? }.
//
// Правила (схема обязательна):
//  - нет entity_type → факт не является сущностью домена, пропускаем без изменений (ok=true);
//  - есть entity_type, но у домена нет схемы → ok=false (reason 'domain_without_schema');
//  - есть entity_type, но он не объявлен в схеме домена → ok=false (reason 'entity_not_in_schema');
//  - data не проходит валидацию даже после нормализации → ok=false (reason 'data_invalid').
// При ok=false вызывающий код (processCandidate) факт НЕ сохраняет.
export async function validateAndCanonicalize(domainKey, candidate) {
  // Факт без сущности схемой не описывается — валидировать нечего.
  if (!candidate.entity_type) {
    return { ok: true, candidate, issues: [], schema_version: null };
  }

  const definition = await loadDomainDefinition(domainKey);
  if (!definition) {
    return {
      ok: false, candidate, schema_version: null, reason: 'domain_without_schema',
      issues: [`У домена «${domainKey}» нет активной схемы, а факт содержит сущность «${candidate.entity_type}».`],
    };
  }

  const spec = await getEntitySpec(domainKey, candidate.entity_type);
  if (!spec) {
    return {
      ok: false, candidate, schema_version: await getActiveVersion(domainKey), reason: 'entity_not_in_schema',
      issues: [`Сущность «${candidate.entity_type}» не объявлена в схеме домена «${domainKey}».`],
    };
  }

  const schemaVersion = await getActiveVersion(domainKey);
  const issues = [];
  const validateData = ajv.compile(spec.data_schema);
  let data = candidate.data || {};

  if (!validateData(data)) {
    // Один уровень — дешёвая кодовая нормализация. Если и после неё не сходится — факт невалиден.
    data = normalizeData(data, spec.data_schema);
    if (!validateData(data)) {
      for (const e of validateData.errors || []) {
        issues.push(`data${e.instancePath || ''} ${e.message}.`);
      }
      return { ok: false, candidate, schema_version: schemaVersion, reason: 'data_invalid', issues };
    }
  }

  // Канонизация ключа по правилу сущности.
  const { entity_key: canonicalKey, issues: keyIssues } = await canonicalizeKey(candidate.entity_key, spec.entity_key);
  issues.push(...keyIssues);

  return {
    ok: true,
    candidate: { ...candidate, entity_key: canonicalKey, data },
    issues,
    schema_version: schemaVersion,
  };
}
