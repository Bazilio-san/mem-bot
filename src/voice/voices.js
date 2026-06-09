export const VOICE_CATALOG = Object.freeze({
  alloy: { gender: 'mf' },
  ash: { gender: 'm' },
  ballad: { gender: 'mf' },
  cedar: { gender: 'm' },
  coral: { gender: 'f' },
  marin: { gender: 'f' },
  nova: { gender: 'f' },
  fable: { gender: 'mf' },
  onyx: { gender: 'm' },
  sage: { gender: 'f' },
  verse: { gender: 'm' },
});

export const VOICE_IDS = Object.freeze(Object.keys(VOICE_CATALOG));

export const DEFAULT_VOICE_BY_GENDER = Object.freeze({
  m: 'ash',
  f: 'nova',
  mf: 'alloy',
});

const GENDER_ALIASES = Object.freeze({
  m: 'm',
  male: 'm',
  man: 'm',
  masculine: 'm',
  мужской: 'm',
  мужским: 'm',
  мужского: 'm',
  мужчина: 'm',
  f: 'f',
  female: 'f',
  woman: 'f',
  feminine: 'f',
  женский: 'f',
  женским: 'f',
  женского: 'f',
  женщина: 'f',
  mf: 'mf',
  neutral: 'mf',
  universal: 'mf',
  универсальный: 'mf',
  универсальным: 'mf',
  нейтральный: 'mf',
  нейтральным: 'mf',
});

export function normalizeVoiceId(value) {
  const id = String(value || '')
    .trim()
    .toLowerCase();
  return VOICE_CATALOG[id] ? id : null;
}

export function isValidVoice(value) {
  return Boolean(normalizeVoiceId(value));
}

export function genderForVoice(value) {
  const voice = normalizeVoiceId(value);
  return voice ? VOICE_CATALOG[voice].gender : null;
}

export function resolveVoicePreference(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase();
  if (!raw) {
    return { ok: false, voice: null, gender: null, reason: 'empty_selection' };
  }

  const exact = normalizeVoiceId(raw);
  if (exact) {
    return { ok: true, voice: exact, gender: VOICE_CATALOG[exact].gender, reason: 'voice' };
  }

  const normalizedWords = raw
    .replace(/[^\p{L}\p{N}_-]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  for (const word of normalizedWords) {
    const voice = normalizeVoiceId(word);
    if (voice) {
      return { ok: true, voice, gender: VOICE_CATALOG[voice].gender, reason: 'voice' };
    }
    const gender = GENDER_ALIASES[word];
    if (gender) {
      return { ok: true, voice: DEFAULT_VOICE_BY_GENDER[gender], gender, reason: 'gender' };
    }
  }

  const gender = GENDER_ALIASES[raw];
  if (gender) {
    return { ok: true, voice: DEFAULT_VOICE_BY_GENDER[gender], gender, reason: 'gender' };
  }

  return { ok: false, voice: null, gender: null, reason: 'unknown_selection' };
}
