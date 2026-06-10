export const VOICE_CATALOG = Object.freeze({
  alloy: { gender: 'mf' },
  ash: { gender: 'm' }, // yong
  ballad: { gender: 'mf' },
  cedar: { gender: 'm' }, // yong
  coral: { gender: 'f' },
  marin: { gender: 'f' },
  nova: { gender: 'f' },
  fable: { gender: 'mf' },
  onyx: { gender: 'm' },
  sage: { gender: 'f' },
  verse: { gender: 'm' }, // yong
});

export const VOICE_IDS = Object.freeze(Object.keys(VOICE_CATALOG));

export const DEFAULT_VOICE_BY_GENDER = Object.freeze({
  m: 'cedar',
  f: 'sage',
  mf: 'alloy',
});

// Categories the model may pass instead of a concrete voice id.
export const CATEGORY_TO_GENDER = Object.freeze({
  male: 'm',
  female: 'f',
  neutral: 'mf',
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
