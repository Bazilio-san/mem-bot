// Доступ к схеме доменной памяти. Источник истины — реестр skills: закрытая схема data и правила
// канонизации entity_key живут в файле domain-schema.json рядом со SKILL.md и загружаются в память при
// старте. Этот модуль — тонкая обёртка над реестром skills для слоя записи памяти (extract.js, validate.js):
// он отдаёт определение домена по доменному ключу и спецификацию отдельной сущности.
import { getDomainDefinitionByKey } from '../pipeline/skills/registry.js';

// Загрузить определение домена по его ключу. Возвращает объект definition (закрытая схема и словари
// entity_key) или null, если у домена нет схемы (домен без предметных сущностей).
export async function loadDomainDefinition(domainKey) {
  return getDomainDefinitionByKey(domainKey);
}

// Идентификатор источника схемы для записи в metadata факта. Возвращает строковый маркер 'skill', если у
// домена есть схема, иначе null. Схема версионируется вместе со skill в системе контроля версий, поэтому
// числовой версии во время выполнения нет.
export async function getActiveVersion(domainKey) {
  return getDomainDefinitionByKey(domainKey) ? 'skill' : null;
}

// Спецификация конкретной сущности домена: правило ключа и закрытая схема data.
// Возвращает { entity_type, entity_key, data_schema } или null, если сущности нет в схеме.
export async function getEntitySpec(domainKey, entityType) {
  const definition = await loadDomainDefinition(domainKey);
  if (!definition || !entityType) {
    return null;
  }
  const entity = definition.entities.find((e) => e.entity_type === entityType);
  if (!entity) {
    return null;
  }
  return { entity_type: entity.entity_type, entity_key: entity.entity_key, data_schema: entity.data_schema };
}
