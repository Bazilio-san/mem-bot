// Check of the proxy's real streaming behavior via chatStream. Confirms two facts without which
// streaming cannot be considered ready: the proxy returns the answer text in chunks (delta.content) and
// returns tool calls as streamed deltas (delta.tool_calls), which our accumulator assembles into valid JSON.
// Run: npm run check:streaming
import { chatStream } from '../src/llm.js';
import { config } from '../src/config.js';

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const reminderTool = {
  type: 'function',
  function: {
    name: 'create_reminder',
    description: 'Create a reminder for the user at a specific time.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short reminder title.' },
        when: { type: 'string', description: 'ISO-8601 date-time of the reminder.' },
      },
      required: ['title', 'when'],
      additionalProperties: false,
    },
  },
};

async function main() {
  console.log(`Checking the streamed model call via the proxy (model ${config.llm.mainModel}).\n`);

  // 1. Streamed text: live chunks arrive, the final text is non-empty, no tools.
  console.log('[1] Streamed answer text');
  let deltas = 0;
  let chars = 0;
  const textMsg = await chatStream({
    messages: [
      { role: 'system', content: 'Отвечай одним коротким предложением на русском языке.' },
      { role: 'user', content: 'Поздоровайся и пожелай хорошего дня.' },
    ],
    onDelta: (chunk) => {
      deltas++;
      chars += chunk.length;
    },
  });
  console.log(
    `     chunks: ${deltas}, total characters: ${chars}, answer: ${(textMsg.content || '').slice(0, 80)}`,
  );
  check('Proxy returns the answer text as streamed chunks', deltas >= 1 && (textMsg.content || '').length > 0);
  check('Final text answer contains no tool_calls', !textMsg.tool_calls);

  // 2. Streamed tool call: the final object is assembled from deltas, the name is correct, arguments are valid JSON.
  console.log('\n[2] Streamed tool call');
  const toolMsg = await chatStream({
    messages: [
      {
        role: 'system',
        content: 'Если пользователь просит напоминание, обязательно вызови инструмент create_reminder.',
      },
      { role: 'user', content: 'Напомни мне завтра в 10 утра проверить цены на билеты.' },
    ],
    tools: [reminderTool],
  });
  const call = toolMsg.tool_calls?.[0];
  console.log(
    `     calls: ${toolMsg.tool_calls?.length || 0}, name: ${call?.function?.name}, arguments: ${call?.function?.arguments}`,
  );
  check('Proxy returns the tool call as streamed deltas', !!call && call.function.name === 'create_reminder');
  let argsOk = false;
  try {
    argsOk = !!JSON.parse(call?.function?.arguments || 'null');
  } catch {
    argsOk = false;
  }
  check('Tool arguments are assembled into valid JSON', argsOk, call?.function?.arguments);
  check('Tool call has an id and type=function', !!call?.id && call?.type === 'function');

  console.log(`\n================ TOTAL ================`);
  console.log(`Passed: ${passed}, failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error in the streaming check:', err.message || err);
  process.exit(1);
});
