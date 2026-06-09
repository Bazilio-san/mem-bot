// Расчёт стоимости одного обращения к LLM по прайс-листу моделей из src/data/model-list.js.
// В структуре openAiModelMeta поля inp/out — цена за ОДИН МИЛЛИОН входящих/исходящих токенов в долларах
// США, а inpB/outB — половинная цена для кэшированного/батч-режима. Поля kT (размер контекста) и mot
// (предел вывода) к расчёту цены отношения не имеют.
import { openAiModelMeta } from '../data/model-list.js';

// Множество уже выведенных в консоль имён неизвестных моделей: каждое имя предупреждается один раз,
// чтобы при незнакомой модели не засорять вывод повторяющимися сообщениями на каждом запросе.
const warnedUnknownModels = new Set();

// Привести имя модели к ключу из прайс-листа openAiModelMeta.
// Шаги: убрать ведущий префикс провайдера (например, 'openai/gpt-4o-mini' приводится к 'gpt-4o-mini');
// если точного ключа нет, отбросить хвостовой штамп даты (например, 'gpt-4o-2024-08-06' приводится к 'gpt-4o').
// Возвращает найденный ключ прайс-листа или null, если подобрать не удалось.
export function normalizeModelName(model) {
  if (!model || typeof model !== 'string') {
    return null;
  }
  let name = model.trim();
  // Префикс провайдера до первого слэша ('openai/...', 'groq/...') отбрасываем.
  const slash = name.indexOf('/');
  if (slash >= 0) {
    name = name.slice(slash + 1);
  }
  if (openAiModelMeta[name]) {
    return name;
  }
  // Хвостовой штамп даты вида -YYYY-MM-DD убираем и пробуем ещё раз.
  const stripped = name.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  if (stripped !== name && openAiModelMeta[stripped]) {
    return stripped;
  }
  return null;
}

// Рассчитать стоимость одного обращения в долларах США.
// Возвращает { priceUsd, modelPriced }: priceUsd — рассчитанная стоимость, modelPriced — нормализованное
// имя модели, по которому взята цена. Если модель не найдена в прайс-листе, возвращает
// { priceUsd: null, modelPriced: null } и один раз предупреждает об этом в консоль.
// Кэшированные входящие токены (если провайдер прислал prompt_tokens_details.cached_tokens) тарифицируются
// по половинной цене inpB; при отсутствии данных все входящие токены считаются по обычной цене inp.
export function priceUsd({ model, promptTokens = 0, completionTokens = 0, cachedTokens = 0 }) {
  const key = normalizeModelName(model);
  if (!key) {
    if (model && !warnedUnknownModels.has(model)) {
      warnedUnknownModels.add(model);
      console.warn(`[llm-pricing] Модель «${model}» отсутствует в прайс-листе: стоимость не рассчитана (NULL).`);
    }
    return { priceUsd: null, modelPriced: null };
  }
  const meta = openAiModelMeta[key];
  const inp = Number(meta.inp) || 0;
  const out = Number(meta.out) || 0;
  const inpB = Number(meta.inpB) || 0;

  const cached = Math.max(0, Math.min(cachedTokens || 0, promptTokens || 0));
  const uncached = Math.max(0, (promptTokens || 0) - cached);
  const inputCost = (uncached / 1e6) * inp + (cached / 1e6) * inpB;
  const outputCost = ((completionTokens || 0) / 1e6) * out;
  const total = inputCost + outputCost;

  // Округляем до 6 знаков после запятой — под точность колонки numeric(12,6).
  return { priceUsd: Math.round(total * 1e6) / 1e6, modelPriced: key };
}
