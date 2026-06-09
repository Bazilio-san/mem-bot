import {
  CATEGORY_TO_GENDER,
  DEFAULT_VOICE_BY_GENDER,
  VOICE_IDS,
  genderForVoice,
  isValidVoice,
  normalizeVoiceId,
} from '../src/voice/voices.js';

let passed = 0,
  failed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

console.log('Проверка каталога и выбора TTS-голосов.\n');

check(
  '1. Каталог содержит ожидаемые голоса',
  ['alloy', 'ash', 'nova', 'onyx', 'verse'].every((voice) => VOICE_IDS.includes(voice)),
);
check('2. normalizeVoiceId приводит регистр', normalizeVoiceId(' NoVa ') === 'nova');
check('3. isValidVoice отклоняет неизвестное значение', isValidVoice('unknown') === false);
check('4. genderForVoice возвращает пол голоса', genderForVoice('onyx') === 'm' && genderForVoice('coral') === 'f');
check(
  '5. Defaults по полу зафиксированы',
  DEFAULT_VOICE_BY_GENDER.m === 'ash' && DEFAULT_VOICE_BY_GENDER.f === 'nova' && DEFAULT_VOICE_BY_GENDER.mf === 'alloy',
);

check(
  '6. Категории сопоставлены с полом',
  CATEGORY_TO_GENDER.male === 'm' && CATEGORY_TO_GENDER.female === 'f' && CATEGORY_TO_GENDER.neutral === 'mf',
);

console.log(`\n================ ИТОГ ================`);
console.log(`Пройдено: ${passed}, провалено: ${failed}`);
if (failures.length) {
  console.log('Провалены:', failures.join('; '));
}
process.exit(failed > 0 ? 1 : 0);
