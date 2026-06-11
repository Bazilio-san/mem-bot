import { config } from '../../../config.js';
import { debugImgGen } from '../../../debug.js';
import { chatJSON } from '../../../llm.js';

// The image model understands only English prompts. The tool definition already asks the agent to translate,
// but that is advisory — the agent sometimes passes the user's wording verbatim. This is the guaranteed step:
// any prompt containing non-ASCII letters is translated by the auxiliary model right before the API call.
const TRANSLATE_SYSTEM = `You translate image-generation prompts into English. Return JSON with "prompt" and
"negative_prompt": faithful English translations preserving every detail of the subject, style, lighting,
composition, and quality hints. Text already in English must be returned unchanged. Do not add new details,
do not censor, do not comment.`;

const TRANSLATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt', 'negative_prompt'],
  properties: {
    prompt: { type: 'string' },
    negative_prompt: { type: 'string' },
  },
};

const hasNonEnglish = (text) => /[^\x00-\x7F]/.test(text || '');

// Returns { prompt, negativePrompt } in English. On any translation failure falls back to the original text:
// a missing translation degrades the picture quality but must not block generation entirely.
async function ensureEnglishPrompt(prompt, negativePrompt) {
  if (!hasNonEnglish(prompt) && !hasNonEnglish(negativePrompt)) {
    debugImgGen('prompt is already English, translation skipped');
    return { prompt, negativePrompt };
  }
  debugImgGen(
    `translating prompt to English via ${config.llm.auxModel}: ${JSON.stringify({ prompt, negativePrompt })}`,
  );
  try {
    const res = await chatJSON({
      model: config.llm.auxModel,
      kind: 'image_prompt_translate',
      schema: TRANSLATE_SCHEMA,
      schemaName: 'image_prompt_translate',
      system: TRANSLATE_SYSTEM,
      user: JSON.stringify({ prompt, negative_prompt: negativePrompt }),
    });
    const translated = {
      prompt: res?.prompt?.trim() || prompt,
      negativePrompt: res?.negative_prompt?.trim() || negativePrompt,
    };
    debugImgGen(`translation done: ${JSON.stringify(translated)}`);
    return translated;
  } catch (err) {
    debugImgGen(`translation failed (${String(err?.message || err)}), using the original prompt as is`);
    return { prompt, negativePrompt };
  }
}

// Generates an image from a text prompt via the external image-generation API and returns a descriptor of the
// created picture. The tool itself does NOT send anything to Telegram: it stays channel-agnostic (it works the
// same from the CLI and the server). The delivery channel inspects the result — specifically
// structuredContent.image — and decides how to present it. The Telegram adapter sends it as a photo (sendPhoto),
// channels without image support (CLI, web) simply ignore the descriptor and show the model's text answer.
//
// The API is synchronous: a POST with a JSON body returns a ready public https URL of a PNG file. The Telegram
// adapter downloads the file by that URL and uploads the bytes to Telegram via multipart (see sendPhoto in
// src/telegram/bot.js) — Telegram's own servers cannot always fetch the URL themselves.
export const imageGenerateTool = {
  name: 'generate_image',
  title: 'Генерирую картинку. Это может занять несколько десятков секунд...',
  isEnabled: (ctx, cfg) => cfg.imageGen?.enabled === true,
  definition: {
    type: 'function',
    function: {
      name: 'generate_image',
      description: `Generate an image from a text description and send it to the user. 
Use when the user asks to draw, generate, or create a picture, illustration, photo, mem, or image. 
Write a vivid, detailed prompt: describe the subject, style, lighting, composition, and quality. 
The model behind the API works only with English prompts, so translate the user's request to English while preserving its meaning. 
Put what should be EXCLUDED from the image into negative_prompt (for example "blurry, low quality, distorted, extra fingers").`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['prompt', 'negative_prompt', 'width', 'height'],
        properties: {
          prompt: {
            type: 'string',
            description: 'Detailed image description in English: subject, style, lighting, composition, quality.',
          },
          negative_prompt: {
            type: ['string', 'null'],
            description: 'What to exclude from the image. Pass null or an empty string if nothing specific.',
          },
          width: {
            type: ['integer', 'null'],
            description: 'Image width in pixels. Allowed values only; pass null to use the default.',
          },
          height: {
            type: ['integer', 'null'],
            description: 'Image height in pixels. Allowed values only; pass null to use the default.',
          },
        },
      },
    },
  },
  async handler(ctx, args) {
    const cfg = config.imageGen;
    const allowed = cfg.allowedSizes || [];
    debugImgGen(`tool call: ${JSON.stringify(args)}`);
    // Clamp the requested size to the allowed list; fall back to the configured default when the model omitted
    // the value or asked for an unsupported size.
    const pick = (value, fallback) => (allowed.includes(value) ? value : fallback);
    const width = pick(args.width, cfg.width);
    const height = pick(args.height, cfg.height);
    if (width !== args.width || height !== args.height) {
      debugImgGen(`size clamped to allowed list: requested ${args.width}x${args.height}, using ${width}x${height}`);
    }

    // Guaranteed English: translate the prompt (and negative prompt) when the agent passed non-English text.
    const translated = await ensureEnglishPrompt(args.prompt, args.negative_prompt || '');

    const body = {
      prompt: translated.prompt,
      negative_prompt: translated.negativePrompt || '',
      width,
      height,
      model: cfg.model,
      seed: -1,
    };

    // Generation can take a while, so we bound the wait with an AbortController timeout: on overrun the request
    // is aborted and the tool returns a clear error instead of hanging the whole agent turn.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    const startedAt = Date.now();
    debugImgGen(`API request -> POST ${cfg.apiUrl} body: ${JSON.stringify(body)}`);
    let data;
    try {
      const res = await fetch(cfg.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        debugImgGen(`API error <- HTTP ${res.status} after ${Date.now() - startedAt} ms`);
        return { error: `Image API responded with HTTP ${res.status}.` };
      }
      data = await res.json();
    } catch (err) {
      const reason = err.name === 'AbortError' ? `timed out after ${cfg.timeoutMs} ms` : String(err.message || err);
      debugImgGen(`API request failed after ${Date.now() - startedAt} ms: ${reason}`);
      return { error: `Image generation request failed: ${reason}.` };
    } finally {
      clearTimeout(timer);
    }

    if (!data?.imageUrl) {
      debugImgGen(`API returned no imageUrl after ${Date.now() - startedAt} ms: ${JSON.stringify(data).slice(0, 300)}`);
      return { error: 'Image API returned no imageUrl.' };
    }

    debugImgGen(
      `API response <- in ${Date.now() - startedAt} ms: url=${data.imageUrl} model=${data.model} seed=${data.seed}`,
    );
    return {
      ok: true,
      model: data.model,
      seed: data.seed,
      // Artifact for the delivery channel: the Telegram adapter reads structuredContent.image and sends the
      // picture as a photo (see sendGeneratedImages in src/telegram/bot.js).
      structuredContent: {
        image: {
          url: data.imageUrl,
          prompt: translated.prompt,
          model: data.model,
          seed: data.seed,
        },
      },
    };
  },
};
