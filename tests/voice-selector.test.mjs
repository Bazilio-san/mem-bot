import {
  DEFAULT_VOICE_BY_GENDER,
  VOICE_IDS,
  genderForVoice,
  isValidVoice,
  normalizeVoiceId,
  resolveVoicePreference,
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

{
  const r = resolveVoicePreference('Поставь голос Onyx, пожалуйста');
  check('6. Выбор по имени голоса внутри фразы', r.ok && r.voice === 'onyx' && r.gender === 'm');
}

{
  const r = resolveVoicePreference('хочу женский голос');
  check('7. Женский alias выбирает nova', r.ok && r.voice === 'nova' && r.gender === 'f');
}

{
  const r = resolveVoicePreference('use a male voice');
  check('8. English male alias выбирает ash', r.ok && r.voice === 'ash' && r.gender === 'm');
}

{
  const r = resolveVoicePreference('нейтральный тембр');
  check('9. Нейтральный alias выбирает alloy', r.ok && r.voice === 'alloy' && r.gender === 'mf');
}

{
  const r = resolveVoicePreference('голос робокоп');
  check('10. Неизвестное значение отклоняется', r.ok === false && r.reason === 'unknown_selection');
}

console.log(`\n================ ИТОГ ================`);
console.log(`Пройдено: ${passed}, провалено: ${failed}`);
if (failures.length) {
  console.log('Провалены:', failures.join('; '));
}
process.exit(failed > 0 ? 1 : 0);
