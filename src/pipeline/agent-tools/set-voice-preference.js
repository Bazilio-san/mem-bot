import { setVoicePreference } from '../../repo.js';
import { resolveVoicePreference, VOICE_IDS } from '../../voice/voices.js';

const VOICE_REQUEST_RE = /\b(voice|male|female|neutral|alloy|ash|ballad|cedar|coral|marin|nova|fable|onyx|sage|verse)\b|голос|тембр|озвуч|мужск|женск|нейтральн|универсальн/i;

function shouldEnableVoicePreferenceTool(ctx) {
  return VOICE_REQUEST_RE.test(String(ctx.userMessage || ''));
}

export const setVoicePreferenceTool = {
  name: 'set_voice_preference',
  title: 'Настраиваю голос ответа...',
  isEnabled: (ctx, config) => config.voiceOutput.enabled && shouldEnableVoicePreferenceTool(ctx),
  definition: {
    type: 'function',
    function: {
      name: 'set_voice_preference',
      description: 'Change the voice used for spoken replies. Call this when the user asks for a specific TTS voice '
        + 'such as nova or onyx, or asks for a male, female, or neutral voice. The setting is remembered and applies '
        + 'to future voice replies.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['selection'],
        properties: {
          selection: {
            type: 'string',
            description: 'Requested voice id or voice category, for example nova, onyx, male, female, or neutral.',
          },
        },
      },
    },
  },
  async handler(ctx, args) {
    const resolved = resolveVoicePreference(args.selection);
    if (!resolved.ok) {
      return {
        error: 'Неизвестный голос. Можно выбрать: ' + VOICE_IDS.join(', '),
        allowed_voices: VOICE_IDS,
      };
    }
    const voice = await setVoicePreference(ctx.userId, resolved.voice);
    ctx.voiceOutputVoice = voice;
    return { voice_output_voice: voice, gender: resolved.gender };
  },
};
