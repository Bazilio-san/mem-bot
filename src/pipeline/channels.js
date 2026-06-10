// Registry of channel presentation profiles. The AI bot core knows nothing about specific delivery channels
// (Telegram, web chat, command line): each channel registers its own profile at startup via the
// registerChannelProfile function, and the core merely mixes the formatting instruction from the profile into the
// system prompt by the channel key. This way adding a new channel does not require changes to the core.
//
// A channel profile is an object with the following fields (any of them can be omitted):
//   instruction — a system block for the model: which markup to format the reply with (a string or null);
//   parseMode   — the markup mode at delivery ('HTML', 'MarkdownV2', null) — used by the channel layer;
//   postProcess — a function to clean up/escape text before sending (or null) — used by the channel;
//   split       — a function to split long text along tag boundaries (or null) — used by the channel.
// The parseMode/postProcess/split fields relate to delivery and are read by the channel itself; the core uses only
// instruction. They are part of the profile so that the channel keeps all its presentation settings in one place.

const PROFILES = new Map();

// The default profile — without markup. Used by the command line, by tests, and as a fallback
// for an unregistered channel.
const PLAIN_PROFILE = {
  instruction: null,
  parseMode: null,
  postProcess: null,
  split: null,
};

// Register a channel profile. Missing fields are filled in with the default profile's values,
// so a channel only needs to specify what is essential to it.
export function registerChannelProfile(channel, profile) {
  PROFILES.set(channel, { ...PLAIN_PROFILE, ...profile });
}

// Get a channel profile by key. For an unknown channel the default profile (without markup) is returned,
// so the caller always gets a full object and can safely read its fields.
export function getChannelProfile(channel) {
  return PROFILES.get(channel) || PLAIN_PROFILE;
}
