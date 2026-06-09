import { setReplyMode } from '../../../repo.js';

// Переключение формы ответа бота: текстом или голосом. Общедоступный инструмент (это безобидная
// пользовательская настройка), подключается только при включённом голосовом выводе (VOICE_OUTPUT_ENABLED).
// Сам синтез речи здесь не вызывается — это обязанность канала доставки; ядро лишь хранит и возвращает
// предпочтение. Исполнитель помечает выбранный режим в контексте запроса (ctx.replyMode), чтобы смена
// подействовала уже на текущий ответ (handleMessage берёт итоговый режим из ctx.replyMode).
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
