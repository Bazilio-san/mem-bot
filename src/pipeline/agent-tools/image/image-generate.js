import { config } from '../../../config.js';

// Generates an image from a text prompt via the external image-generation API and returns a descriptor of the
// created picture. The tool itself does NOT send anything to Telegram: it stays channel-agnostic (it works the
// same from the CLI and the server). The delivery channel inspects the result — specifically
// structuredContent.image — and decides how to present it. The Telegram adapter sends it as a photo (sendPhoto),
// channels without image support (CLI, web) simply ignore the descriptor and show the model's text answer.
//
// The API is synchronous: a POST with a JSON body returns a ready public https URL of a PNG file, which Telegram
// can fetch by itself. There is no need to download the file on our side.
export const imageGenerateTool = {
  name: 'generate_image',
  title: 'Генерирую картинку...',
  isEnabled: (ctx, cfg) => cfg.imageGen?.enabled === true,
  definition: {
    type: 'function',
    function: {
      name: 'generate_image',
      description: `Generate an image from a text description and send it to the user. Use when the user asks to
draw, generate, or create a picture, illustration, photo, or image. Write a vivid, detailed prompt: describe the
subject, style, lighting, composition, and quality. The model behind the API works best with English prompts, so
translate the user's request to English while preserving its meaning. Put what should be EXCLUDED from the image
into negative_prompt (for example "blurry, low quality, distorted, extra fingers").`,
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
    // Clamp the requested size to the allowed list; fall back to the configured default when the model omitted
    // the value or asked for an unsupported size.
    const pick = (value, fallback) => (allowed.includes(value) ? value : fallback);
    const width = pick(args.width, cfg.width);
    const height = pick(args.height, cfg.height);

    const body = {
      prompt: args.prompt,
      negative_prompt: args.negative_prompt || '',
      width,
      height,
      model: cfg.model,
      seed: -1,
    };

    // Generation can take a while, so we bound the wait with an AbortController timeout: on overrun the request
    // is aborted and the tool returns a clear error instead of hanging the whole agent turn.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    let data;
    try {
      const res = await fetch(cfg.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        return { error: `Image API responded with HTTP ${res.status}.` };
      }
      data = await res.json();
    } catch (err) {
      const reason = err.name === 'AbortError' ? `timed out after ${cfg.timeoutMs} ms` : String(err.message || err);
      return { error: `Image generation request failed: ${reason}.` };
    } finally {
      clearTimeout(timer);
    }

    if (!data?.imageUrl) {
      return { error: 'Image API returned no imageUrl.' };
    }

    return {
      ok: true,
      model: data.model,
      seed: data.seed,
      // Artifact for the delivery channel: the Telegram adapter reads structuredContent.image and sends the
      // picture as a photo (see sendGeneratedImages in src/telegram/bot.js).
      structuredContent: {
        image: {
          url: data.imageUrl,
          prompt: args.prompt,
          model: data.model,
          seed: data.seed,
        },
      },
    };
  },
};
