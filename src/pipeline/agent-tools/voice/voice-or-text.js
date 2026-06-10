import { setReplyMode } from '../../../repo.js';

// Switches the bot's reply form between text and voice. A publicly available tool (this is a harmless
// user setting), enabled only when voice output is turned on (VOICE_OUTPUT_ENABLED). Speech synthesis
// itself is not invoked here — that is the delivery channel's responsibility; the core only stores and
// returns the preference. The executor marks the chosen mode in the request context (ctx.replyMode), so
// the change takes effect already on the current reply (handleMessage takes the final mode from ctx.replyMode).
export const setReplyModeTool = {
  name: 'voice_or_text',
  title: 'Настраиваю формат ответа...',
  isEnabled: (ctx, config) => config.voiceOutput.enabled,
  definition: {
    type: 'function',
    function: {
      name: 'voice_or_text',
      description: `Switch the reply FORMAT between text and voice. Use ONLY to turn spoken replies on or off,
for example "answer with voice", "dictate the answer", "switch back to text", "stop the voice"`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['mode'],
        properties: {
          mode: {
            type: 'string',
            enum: ['voice', 'text'],
            description: 'Desired reply form: voice or text.',
          },
        },
      },
    },
  },
  async handler(ctx, args) {
    const mode = await setReplyMode(ctx.userId, args.mode);
    ctx.replyMode = mode;
    return { reply_mode: mode };
  },
};
