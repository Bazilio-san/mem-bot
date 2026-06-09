// https://platform.openai.com/docs/models
// Цены указаны за 1млн токенов https://openai.com/api/pricing/

// здесь свойства имеют короткие имена, чтобы удобно было видеть в одной строке
export const openAiModelMeta = {
  'computer-use-preview': { kT: 0, inp: 0, out: 0, inpB: 0, outB: 0 },
  'curie-search-document': { kT: 0, inp: 0, out: 0, inpB: 0, outB: 0 },
  'curie-search-query': { kT: 0, inp: 0, out: 0, inpB: 0, outB: 0 },
  'dall-e-3': { kT: 1, inp: 0.04, out: 0.04, inpB: 0.04, outB: 0.04 },
  'davinci-002': { kT: 1, inp: 2, out: 2, inpB: 2, outB: 2 },
  'davinci-search-document': { kT: 0, inp: 0, out: 0, inpB: 0, outB: 0 },
  'davinci-search-query': { kT: 0, inp: 0, out: 0, inpB: 0, outB: 0 },

  'gpt-5': { kT: 400, mot: 128, inp: 1.25, out: 10, inpB: 0.625, outB: 5 },
  'gpt-5.1': { kT: 400, mot: 128, inp: 1.25, out: 10, inpB: 0.625, outB: 5 },
  'gpt-5.2': { kT: 400, mot: 128, inp: 1.75, out: 14, inpB: 0.875, outB: 7 },
  'gpt-5.2-codex': { kT: 400, mot: 128, inp: 1.75, out: 14, inpB: 0.875, outB: 7 },
  'gpt-5.3-codex': { kT: 400, mot: 128, inp: 1.75, out: 14, inpB: 0.875, outB: 7 },
  'gpt-5.4': { kT: 1025, mot: 128, inp: 2.5, out: 15, inpB: 1.25, outB: 7.5 },
  'gpt-5.4-mini': { kT: 400, mot: 128, inp: 0.75, out: 4.5, inpB: 0.375, outB: 2.25 },
  'gpt-5.4-nano': { kT: 400, mot: 128, inp: 0.2, out: 1.25, inpB: 0.1, outB: 0.625 },

  'gpt-5-mini': { kT: 400, mot: 128, inp: 0.25, out: 2, inpB: 0.125, outB: 1 },

  'gpt-5-nano': { kT: 400, mot: 128, inp: 0.05, out: 0.4, inpB: 0.025, outB: 0.2 },
  'gpt-5-search-api': { kT: 400, mot: 128, inp: 0, out: 0, inpB: 0, outB: 0 },

  'gpt-4.1': { kT: 1047, mot: 32, inp: 2.0, out: 8.0, inpB: 1.0, outB: 4.0 },
  'gpt-4.1-mini': { kT: 1047, mot: 32, inp: 0.4, out: 1.6, inpB: 0.2, outB: 0.8 },
  'gpt-4.1-nano': { kT: 1047, mot: 32.768, inp: 0.1, out: 0.4, inpB: 0.05, outB: 0.2 },

  'gpt-4o': { kT: 128, mot: 16.384, inp: 2.5, out: 10, inpB: 1.25, outB: 5.0 },

  'gpt-4o-audio-preview': { kT: 128, mot: 16.384, inp: 2.5, out: 10, inpB: 2.5, outB: 10 },

  'gpt-4o-mini': { kT: 128, mot: 16.384, inp: 0.15, out: 0.6, inpB: 0.075, outB: 0.3 },

  'gpt-4o-mini-audio-preview': { kT: 0, inp: 0, out: 0, inpB: 0, outB: 0 },
  'gpt-4o-mini-realtime-preview': { kT: 0, inp: 0, out: 0, inpB: 0, outB: 0 },
  'gpt-4o-mini-search-preview': { kT: 0, inp: 0, out: 0, inpB: 0, outB: 0 },
  'gpt-4o-mini-transcribe': { kT: 16, mot: 2, inp: 1.25, out: 5, inpB: 0, outB: 0 },
  'gpt-4o-mini-tts': { kT: 0, inp: 0.6, out: 12, inpB: 0, outB: 0 },
  'gpt-4o-transcribe-diarize': { kT: 16, mot: 2, inp: 2.5, out: 10, inpB: 2.5, outB: 10 },

  'gpt-realtime': { kT: 32, mot: 4.096, inp: 4, out: 16, inpB: 4, outB: 16 },
  'gpt-realtime-mini': { kT: 32, mot: 4.096, inp: 0.6, out: 2.4, inpB: 0.6, outB: 2.4 },
  'gpt-realtime-1.5': { kT: 32, mot: 4.096, inp: 4, out: 16, inpB: 4, outB: 16 },

  'gpt-audio': { kT: 128, mot: 16.384, inp: 0, out: 0, inpB: 0, outB: 0 },
  'gpt-audio-mini': { kT: 128, mot: 16.384, inp: 0, out: 0, inpB: 0, outB: 0 },
  'gpt-audio-1.5': { kT: 128, mot: 16.384, inp: 2.5, out: 10, inpB: 0, outB: 0 },

  'gpt-4o-realtime-preview': { kT: 128, inp: 5, out: 20, inpB: 5, outB: 20 },
  'gpt-4o-search-preview': { kT: 0, inp: 0, out: 0, inpB: 0, outB: 0 },
  'gpt-4o-transcribe': { kT: 16, mot: 2, inp: 2.5, out: 10, inpB: 0, outB: 0 },

  'gpt-image-2': {
    low: {
      '1024x1024': 0.006,
      '1024x1536': 0.005,
      '1536x1024': 0.005,
    },
    medium: {
      '1024x1024': 0.053,
      '1024x1536': 0.041,
      '1536x1024': 0.041,
    },
    high: {
      '1024x1024': 0.211,
      '1024x1536': 0.165,
      '1536x1024': 0.165,
    },
  },

  'sora-2': { kT: 999, mot: 999, inp: 0, out: 0, inpB: 0, outB: 0 },
  'sora-2-pro': { kT: 999, mot: 999, inp: 0, out: 0, inpB: 0, outB: 0 },

  'o4-mini': { kT: 200, mot: 100, inp: 1.1, out: 4.4, inpB: 0.55, outB: 2.2 },
  'o4-mini-deep-research': { kT: 200, mot: 100, inp: 2, out: 8, inpB: 2, outB: 8 },
  'codex-mini-latest': { kT: 200, mot: 100, inp: 1.5, out: 6.0, inpB: 1.5, outB: 6.0 },

  'tts-1': { kT: 1, inp: 15, out: 15, inpB: 15, outB: 15 },
  'tts-1-hd': { kT: 1, inp: 30, out: 30, inpB: 30, outB: 30 },
  'whisper-1': { kT: 1, inp: 0.006, out: 0.006, inpB: 0.006, outB: 0.006 },

  'text-embedding-3-small': {
    kT: 8.192,
    inp: 0.02,
    out: 0.02,
    inpB: 0.01,
    outB: 0.01,
    dimensions: [512, 1536],
    dimensionsAllowed: true,
  },
  'text-embedding-3-large': {
    kT: 8.192,
    inp: 0.13,
    out: 0.13,
    inpB: 0.065,
    outB: 0.065,
    dimensions: [256, 1024, 1536, 3072],
    dimensionsAllowed: true,
  },
};
