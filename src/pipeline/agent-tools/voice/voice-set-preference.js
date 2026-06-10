import { setVoicePreference } from '../../../repo.js';
import { CATEGORY_TO_GENDER, DEFAULT_VOICE_BY_GENDER, VOICE_CATALOG, VOICE_IDS } from '../../../voice/voices.js';

export const setVoicePreferenceTool = {
  name: 'voice_set_preference',
  title: 'Настраиваю голос ответа...',
  isEnabled: (ctx, config) => config.voiceOutput.enabled,
  definition: {
    type: 'function',
    function: {
      name: 'voice_set_preference',
      description: `Set WHICH voice (timbre) speaks the spoken replies.
Call this whenever the user names a specific voice or asks for a male, female, or neutral voice`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['voice'],
        properties: {
          voice: {
            enum: ['male', 'female', 'neutral', ...VOICE_IDS],
            type: 'string',
            description: 'Requested voice id or voice category',
          },
        },
      },
    },
  },
  async handler(ctx, args) {
    // The model itself picks one of the enum options: either a concrete voice id
    // or a category (male/female/neutral). There is no free-text parsing here.
    const requestedVoice = String(args.voice || '');
    let voice;
    let gender;
    if (VOICE_CATALOG[requestedVoice]) {
      voice = requestedVoice;
      ({ gender } = VOICE_CATALOG[requestedVoice]);
    } else if (CATEGORY_TO_GENDER[requestedVoice]) {
      gender = CATEGORY_TO_GENDER[requestedVoice];
      voice = DEFAULT_VOICE_BY_GENDER[gender];
    } else {
      return {
        error: `Неизвестный голос. Можно выбрать: ${VOICE_IDS.join(', ')}`,
        allowed_voices: VOICE_IDS,
      };
    }
    const savedVoice = await setVoicePreference(ctx.userId, voice);
    ctx.voiceOutputVoice = savedVoice;
    return { voice_output_voice: savedVoice, gender };
  },
};
