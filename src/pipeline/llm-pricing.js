// Computes the cost of a single LLM call from the model price list in src/data/model-list.js.
// In the openAiModelMeta structure the inp/out fields are the price per ONE MILLION input/output tokens in
// US dollars, and inpB/outB are the half price for cached/batch mode. The kT (context size) and mot
// (output limit) fields have nothing to do with price calculation.
import { openAiModelMeta } from '../data/model-list.js';

// Set of unknown model names already printed to the console: each name is warned about once,
// so that an unfamiliar model doesn't clutter the output with repeated messages on every request.
const warnedUnknownModels = new Set();

// Normalizes a model name to a key from the openAiModelMeta price list.
// Steps: strip the leading provider prefix (e.g. 'openai/gpt-4o-mini' becomes 'gpt-4o-mini');
// if there's no exact key, drop the trailing date stamp (e.g. 'gpt-4o-2024-08-06' becomes 'gpt-4o').
// Returns the matched price-list key, or null if no match could be found.
export function normalizeModelName(model) {
  if (!model || typeof model !== 'string') {
    return null;
  }
  let name = model.trim();
  // Drop the provider prefix up to the first slash ('openai/...', 'groq/...').
  const slash = name.indexOf('/');
  if (slash >= 0) {
    name = name.slice(slash + 1);
  }
  if (openAiModelMeta[name]) {
    return name;
  }
  // Remove the trailing date stamp of the form -YYYY-MM-DD and try again.
  const stripped = name.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  if (stripped !== name && openAiModelMeta[stripped]) {
    return stripped;
  }
  return null;
}

// Computes the cost of a single call in US dollars.
// Returns { priceUsd, modelPriced }: priceUsd is the computed cost, modelPriced is the normalized model
// name the price was taken for. If the model isn't found in the price list, returns
// { priceUsd: null, modelPriced: null } and warns about it in the console once.
// Cached input tokens (if the provider sent prompt_tokens_details.cached_tokens) are billed at the half
// price inpB; when there's no such data, all input tokens are counted at the regular price inp.
export function priceUsd({ model, promptTokens = 0, completionTokens = 0, cachedTokens = 0 }) {
  const key = normalizeModelName(model);
  if (!key) {
    if (model && !warnedUnknownModels.has(model)) {
      warnedUnknownModels.add(model);
      console.warn(`[llm-pricing] Model "${model}" is missing from the price list: cost not computed (NULL).`);
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

  // Round to 6 decimal places — to match the precision of the numeric(12,6) column.
  return { priceUsd: Math.round(total * 1e6) / 1e6, modelPriced: key };
}
