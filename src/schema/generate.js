// Генератор черновика схемы домена через LLM.
// По названию домена (и необязательным описанию и примерам реплик) модель предлагает
// набор сущностей с закрытыми схемами data и правилами формирования entity_key.
// Результат — объект definition по мета-схеме; он сохраняется в файл черновика и правится
// человеком перед сохранением в реестр. Форма выхода известна и закрыта, поэтому ответ
// валидируется мета-схемой сразу после генерации.
import { chatJSON } from '../llm.js';
import { config } from '../config.js';
import { DEFINITION_META_SCHEMA, validateDefinition } from './meta.js';

const SYSTEM = `Ты проектируешь схему долговременной памяти для домена агента.
По названию и описанию домена предложи:
- 2–5 типов сущностей (entity_type), которые реально стоит запоминать;
- для каждой сущности ЗАКРЫТУЮ JSON Schema поля data: additionalProperties=false,
  все поля перечислены в required, конкретные типы, где уместно — enum;
- правило формирования entity_key: либо fixed_vocab со словарём (vocabulary) и синонимами (synonyms),
  либо slug (стабильный ключ из значения, например пункт назначения);
- список допустимых memory_kind для домена (allowed_memory_kinds).
Не добавляй чувствительные значения прямо в data — для них заводи отдельный entity_type со ссылкой
(например has_document/document_kind), а полные данные хранятся в защищённой памяти.
Верни только объект definition по мета-схеме, без пояснений.`;

// Сгенерировать черновик определения домена.
// Вход: title (обязательно), key (ключ домена), необязательные description и samples (примеры реплик).
// Возвращает { definition, issues } — issues непустой, если сгенерированное определение
// не прошло мета-валидацию (его всё равно полезно показать человеку для правки).
export async function generateDomainDraft({ title, key, description = '', samples = [] }) {
  if (!title) throw new Error('Для генерации схемы нужно название домена (title).');

  const samplesText = samples.length
    ? `\nПримеры реплик пользователя в этом домене:\n${samples.map((s) => `- ${s}`).join('\n')}`
    : '';

  const definition = await chatJSON({
    model: config.llm.extractModel,
    schemaName: 'domain_definition',
    schema: DEFINITION_META_SCHEMA,
    system: SYSTEM,
    user: `Домен: ${title}
Ключ домена (domain_key): ${key || '(придумай короткий латиницей)'}
Описание: ${description || '(нет)'}${samplesText}`,
  });

  // Подставим ключ домена, если модель его не проставила или проставила иначе.
  if (key) definition.domain_key = key;

  const { ok, issues } = validateDefinition(definition);
  return { definition, issues: ok ? [] : issues };
}
