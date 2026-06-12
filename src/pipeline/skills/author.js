// Generation layer for the skill-editing toolkit: the model creates and edits parts of a skill under the hood.
// Pure functions on top of chatJSON: none of them write to disk.
import { chatJSON } from '../../llm.js';
import { config } from '../../config.js';

// Generation model: explicitly set in config, or the agent's main model (quality matters more than speed).
function authoringModel() {
  return config.skills.authoring.model || config.llm.mainModel;
}

// Generate a draft of a whole skill from a natural-language description.
export async function generateSkillDraft({ skillDescription, hints = '' }) {
  const schema = {
    type: 'object',
    required: [
      'name',
      'domain_key',
      'title',
      'description',
      'hint',
      'when_to_use',
      'positive_signals',
      'negative_signals',
      'skill_prompt',
      'fact_extraction_prompt',
    ],
    properties: {
      name: {
        type: 'string',
      },
      domain_key: {
        type: 'string',
      },
      title: {
        type: 'string',
      },
      description: {
        type: 'string',
      },
      hint: {
        type: 'string',
      },
      when_to_use: {
        type: 'string',
      },
      positive_signals: {
        type: 'array',
        items: { type: 'string' },
      },
      negative_signals: {
        type: 'array',
        items: { type: 'string' },
      },
      skill_prompt: {
        type: 'string',
      },
      fact_extraction_prompt: {
        type: 'string',
      },
    },
  };
  const system = `Ты конструктор навыков (skills) для агентского приложения с памятью. По описанию области собери навык.
name — короткий kebab-case (латиница, дефисы), domain_key — короткий snake_case (латиница, подчёркивания).
hint — одна короткая строка для классификатора входящих сообщений: суть навыка и 3–6 слов-триггеров на языке
пользователей (например «перелёты и авиапоиск: билет, рейс, аэропорт, вылет»).
when_to_use — смысловое правило, когда роутер выбирает этот навык. positive_signals/negative_signals — короткие
подсказки. skill_prompt — инструкции основного ответа в этом домене. fact_extraction_prompt — какие устойчивые
факты сохранять.
Верни только JSON по схеме.`;
  const draft = await chatJSON({
    model: authoringModel(),
    kind: 'skill_authoring',
    schema,
    schemaName: 'skill_draft',
    system,
    user: `Описание навыка: ${skillDescription}\n${hints ? `Дополнительно: ${hints}` : ''}`,
    responseFormat: config.skills.authoring.responseFormat,
  });
  return {
    name: draft.name,
    domain_key: draft.domain_key,
    title: draft.title,
    description: draft.description,
    hint: draft.hint,
    when_to_use: draft.when_to_use,
    positive_signals: draft.positive_signals || [],
    negative_signals: draft.negative_signals || [],
    skill_prompt: draft.skill_prompt,
    fact_extraction_prompt: draft.fact_extraction_prompt,
  };
}

// Rewrite or improve a skill prompt block per the instruction. kind: 'skill_prompt' | 'fact_extraction_prompt'.
export async function refineBlock({ kind, current, instruction, skillContext = {} }) {
  const what =
    kind === 'fact_extraction_prompt'
      ? 'блок «## Fact Extraction Prompt» (какие устойчивые факты сохранять в этом домене)'
      : 'блок «# Skill Prompt» (инструкции основного ответа в этом домене)';
  const schema = { type: 'object', required: ['text'], properties: { text: { type: 'string' } } };
  const system = `Ты редактор навыков (skills). Перепиши ${what} по инструкции, сохранив суть и оставаясь в рамках
домена. Верни только новый текст блока в поле text, без заголовка раздела и без markdown-обёртки. Только JSON по схеме.`;
  const ctx = `Навык: ${skillContext.name || '—'} / домен ${skillContext.domain_key || '—'}
Название: ${skillContext.title || '—'}; описание: ${skillContext.description || '—'}`;
  const res = await chatJSON({
    model: authoringModel(),
    kind: 'skill_authoring',
    schema,
    schemaName: 'skill_block',
    system,
    user: `${ctx}\n\nТекущий текст блока:\n${current || '(пусто)'}\n\nИнструкция: ${instruction}`,
    responseFormat: config.skills.authoring.responseFormat,
  });
  return { text: res.text };
}
