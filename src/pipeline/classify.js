// Pipeline stage 1: fast classification of the incoming message with a cheap model.
// The classifier picks the single best-fitting skill (skill_name is the source of truth). The domain key
// for memory is always derived in code from the resolved skill — the model does not return it.
// It also determines the intent, important entities, which kinds of memory are needed, and whether tools are needed.
import { chatJSON } from '../llm.js';
import { config } from '../config.js';
import { listSkillRoutes } from './skills/registry.js';

// Schema of the classification result. The source of truth is skill_name, restricted to the available skills.
// The schema is self-sufficient: every field carries a description for the model, so the system prompt holds
// only what the schema cannot express (the compact skill list and the last-message guardrail).
// Exported for unit tests (strictness of the schema in json_schema mode).
export function buildSchema(routeNames, withReason = false) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      intent: {
        type: 'string',
        description: `A concise semantic phrase capturing the core meaning of the user's latest message, from the user's perspective. 
It may be a request, preference, complaint, question, or statement. 
Do not rewrite statements as desires; use the user's language and keep only searchable key meaning.`,
      },
      skill_name: {
        type: 'string',
        enum: routeNames,
        description: `Name of the SINGLE best-fitting skill by meaning. If no specialized skill fits, pick 'general'.`,
      },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'Confidence in the skill choice: from 0 (a guess) to 1 (unambiguous).',
      },
      ...(withReason && {
        reason: {
          type: 'string',
          description: 'Brief justification of the skill choice, one phrase.',
        },
      }),
      // Strict array of type/value pairs (instead of a free-form object): keeps the whole schema
      // expressible in strict json_schema mode and feeds the entity boost in retrieveMemory.
      entities: {
        type: 'array',
        maxItems: 8,
        description: `Important entities explicitly mentioned in the message (at most 8). Do not include pronouns or generic words.`,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'value'],
          properties: {
            type: {
              type: 'string',
              description: 'Entity type: person, place, vehicle, topic, product, etc.',
            },
            value: {
              type: 'string',
              description: `Entity value in its base form (nominative/citation form when applicable), without extra words. 
Keep the language and script of the original message; do not translate or transliterate.`,
            },
          },
        },
      },
      needs_memory: {
        type: 'boolean',
        description: `Whether the reply may depend on stored knowledge about the user. Default true.
Set false ONLY when the answer is fully self-contained and cannot change depending on who is asking:
a greeting, a translation, arithmetic, a general-knowledge question with all needed data in the message itself.
When unsure, set true.`,
      },
      needed_memory_scopes: {
        type: 'array',
        description: `Memory scopes to load. Include all that may help; if unsure, include it.

- profile: user identity/preferences/style. Personal/chatty messages; not pure utility.
- dialog: unfinished earlier threads or follow-ups to previous talk.
- domain: facts for the current skill/domain topic.
- secure: protected private data; ONLY if explicitly requested.
- reminder: reminders, plans, deadlines, scheduled tasks.`,
        items: {
          type: 'string',
          enum: ['dialog', 'profile', 'domain', 'secure', 'reminder'],
        },
      },
      // needs_tools: {
      //   type: 'boolean',
      //   description: 'Whether tools (external actions: search, scheduler, etc.) are needed to fulfil the request.',
      // },
      // candidate_tools: {
      //   type: 'array',
      //   description: 'Probable names of the needed tools; an empty array if no tools are needed.',
      //   items: { type: 'string' },
      // },
    },
    required: ['intent', 'skill_name', 'confidence', 'entities', 'needs_memory', 'needed_memory_scopes'],
  };
}

// System prompt: one compact line per skill (classification.hint from SKILL.md frontmatter, trigger words stay
// in the language users actually type them in) plus only the guardrails the JSON schema cannot express:
// classify the last message only, use context just to resolve references, fall back to 'general'.
// Per-field rules live in the schema descriptions and are deliberately not repeated here.
function buildSystemPrompt(routes) {
  const list = routes.map((r) => `- ${r.name} — ${r.hint}`).join('\n');
  return `You are an incoming-message classifier.
Classify ONLY the text inside <last-user-message>. Use <recent-dialog> and the dialog state line only to
resolve pronouns, ellipsis and short follow-ups and to stay in the thread the conversation is already in;
never classify an earlier message instead of the last one.

Skills (pick one; 'general' is the default fallback):
${list}
`;
}

// Caps for the classifier context: enough to resolve a reference to an earlier turn, cheap on tokens.
const RECENT_MESSAGES_MAX = 6;
const RECENT_MESSAGE_CHARS = 300;

function truncateLine(text, limit) {
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}

// Compact one-line digest of the summarizer's state_json (see SUMMARY_SCHEMA in history-compress.js)
// for the classifier prompt. Only the fields that help interpret a short follow-up phrase; the lists
// are capped so the line stays cheap. Exported for unit tests.
export function formatDialogState(stateJson) {
  if (!stateJson || typeof stateJson !== 'object') {
    return '';
  }
  const take = (arr, n = 3) => (Array.isArray(arr) ? arr.filter(Boolean).slice(0, n) : []);
  const parts = [];
  if (stateJson.current_goal) {
    parts.push(`goal: ${stateJson.current_goal}`);
  }
  if (stateJson.current_task) {
    parts.push(`task: ${stateJson.current_task}`);
  }
  const open = take(stateJson.open_questions);
  if (open.length) {
    parts.push(`open questions: ${open.join('; ')}`);
  }
  const next = take(stateJson.next_steps);
  if (next.length) {
    parts.push(`next steps: ${next.join('; ')}`);
  }
  return parts.join(' | ');
}

// recentMessages — previous dialog turns ({role, content}, oldest first) WITHOUT the current message
// (it is saved to the DB only after the answer, so getRecentMessages rows are clean). Assistant entries
// carry the stored answer summary instead of the full reply when one exists (see the caller in agent.js).
// dialogState — state_json of the active conversation summary; '' / null when there is no summary yet.
export async function classifyIntent({
  userMessage,
  currentDomainKey = 'general',
  recentMessages = [],
  dialogState = null,
}) {
  const routes = listSkillRoutes();
  const routeNames = routes.map((r) => r.name);
  const recent = (Array.isArray(recentMessages) ? recentMessages : [])
    .filter((m) => (m?.role === 'user' || m?.role === 'assistant') && m.content)
    .slice(-RECENT_MESSAGES_MAX)
    .map((m) => `${m.role}: ${truncateLine(m.content, RECENT_MESSAGE_CHARS)}`);
  const recentBlock = recent.length ? `<recent-dialog>\n${recent.join('\n')}\n</recent-dialog>\n\n` : '';
  const state = formatDialogState(dialogState);
  // A literal closing tag inside the message text would break the boundary the system prompt relies on.
  const safeMessage = String(userMessage).replaceAll('</last-user-message>', '');
  return chatJSON({
    model: config.llm.auxModel,
    kind: 'intent_classify',
    schema: buildSchema(routeNames),
    schemaName: 'skill_classification',
    system: buildSystemPrompt(routes),
    user: `${recentBlock}Current agent domain: ${currentDomainKey}
Last dialog state: ${state || 'none'}
<last-user-message>
${safeMessage}
</last-user-message>`,
  });
}
