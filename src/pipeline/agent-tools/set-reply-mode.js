import { setReplyMode } from '../../repo.js';

// Переключение формы ответа бота: текстом или голосом. Общедоступный инструмент (это безобидная
// пользовательская настройка), подключается только при включённом голосовом выводе (VOICE_OUTPUT_ENABLED).
// Сам синтез речи здесь не вызывается — это обязанность канала доставки; ядро лишь хранит и возвращает
// предпочтение. Исполнитель помечает выбранный режим в контексте запроса (ctx.replyMode), чтобы смена
// подействовала уже на текущий ответ (handleMessage берёт итоговый режим из ctx.replyMode).
export const setReplyModeTool = {
  name: 'set_reply_mode',
  title: 'Настраиваю формат ответа...',
  isEnabled: (ctx, config) => config.voiceOutput.enabled,
  definition: {
    type: 'function',
    function: {
      name: 'set_reply_mode',
      description: 'Change how the bot replies: by voice or by text. Call this when the user asks to reply with '
        + 'voice (for example "answer with voice", "dictate the answer") or to switch back to text ("answer with '
        + 'text", "stop the voice"). The preference is remembered and applies to following messages.',
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
