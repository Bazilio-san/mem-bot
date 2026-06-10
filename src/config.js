// Application configuration. It is fully assembled by the node-config package from the YAML hierarchy under config/:
// default values come from config/default.yaml; environment-specific overrides from development/production/test.yaml
// (selected by NODE_ENV); secrets from config/local.yaml; environment-variable overrides from
// config/custom-environment-variables.yaml. The existing .env is still read (via the bootstrap loader
// below) and overrides values through the same environment-variable map.
//
// The structure is NOT rebuilt here: config is a snapshot of the ready node-config tree. The code only adds
// validation of required parameters and a few invariants that cannot be expressed in YAML,
// and on error it aborts the process with a clear message.
//
// Default models: main agent and fact extraction use gpt-5.4-mini, query classification uses gpt-5.4-nano,
// embeddings use text-embedding-3-small (1536 dimensions). Any model can be overridden via the environment
// variables MAIN_MODEL/AUX_MODEL/EXTRACT_MODEL/EMBED_MODEL or in config/local.yaml. If llm.baseURL
// (OPENAI_BASE_URL) is set, the OpenAI client sends requests to an OpenAI-compatible proxy (for example, LiteLLM);
// an empty value means a direct call to https://api.openai.com/v1.
import './bootstrap/dotenv.js'; // FIRST line: populates process.env before node-config is loaded
import nodeConfig from 'config'; // node-config reads the config/ directory on first import
import { normalizeVoiceId } from './voice/voices.js';

// The ready configuration tree as a plain mutable object. Its shape matches the structure of config/default.yaml.
export const config = nodeConfig.util.toObject();

// Abort with a clear message if required parameters are not set.
// An empty string, null, or a missing key all count as "not set" (an empty host for af-db-ts = disabled DB).
export function requireConfig(paths) {
  const missing = paths.filter((p) => {
    const v = nodeConfig.has(p) ? nodeConfig.get(p) : undefined;
    return v === undefined || v === null || v === '';
  });
  if (missing.length) {
    throw new Error(
      `Required configuration parameters are not set: ${missing.join(', ')}. ` +
        `Set them in config/local.yaml or via environment variables ` +
        `(see config/custom-environment-variables.yaml).`,
    );
  }
}

// Universal minimum for any process: a working DB and access to the LLM.
// Channel-specific and per-entry-point requirements are checked by each entry point itself (e.g. telegram.apiKey in
// the bot).
requireConfig([
  'db.postgres.dbs.main.host',
  'db.postgres.dbs.main.database',
  'db.postgres.dbs.main.user',
  'db.postgres.dbs.main.password',
  'llm.apiKey',
]);

// --- Invariants: also abort with a clear message ---
// Hysteresis: the target digest size must be strictly less than the trigger threshold, otherwise compression would
// fire immediately after itself and loop forever.
if (config.historyCompression.shrinkTokens >= config.historyCompression.maxTokens) {
  throw new Error('historyCompression.shrinkTokens must be strictly less than historyCompression.maxTokens.');
}
// Hard ceiling on the length of the text to be voiced.
if (config.voiceOutput.maxChars > 500) {
  throw new Error('voiceOutput.maxChars cannot exceed 500.');
}

// --- Minimal unavoidable normalizations (things that cannot be expressed in YAML) ---
// An empty baseURL means "direct OpenAI API" — coerce '' to undefined for the OpenAI client.
if (!config.llm.baseURL) {
  config.llm.baseURL = undefined;
}
// Canonicalize the voice timbre and check it is known (only if synthesis is enabled).
if (config.voiceOutput.enabled) {
  const v = normalizeVoiceId(config.voiceOutput.voice);
  if (!v) {
    throw new Error(`Unknown voiceOutput.voice: "${config.voiceOutput.voice}".`);
  }
  config.voiceOutput.voice = v;
}

// debug in YAML and the environment is a comma-separated list of categories; we parse it only here.
export function debugEnabled(category) {
  const list = String(config.debug || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.includes('*') || list.includes(category);
}
