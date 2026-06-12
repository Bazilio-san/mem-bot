// Pipeline stage 1: fast classification of the incoming message with a cheap model.
// The classifier picks the single best-fitting skill (skill_name is the source of truth). The domain key
// for memory is always derived in code from the resolved skill — the model does not return it.
// It also determines the intent, important entities, which kinds of memory are needed, and whether tools are needed.
import { chatJSON } from '../llm.js';
import { config } from '../config.js';
import { listSkillRoutes } from './skills/registry.js';

// Schema of the classification result. The source of truth is skill_name, restricted to the available skills.
// The schema is self-sufficient: every field carries a description for the model, so the system prompt holds
// only what the schema cannot express (the skill list and how to read its signals).
// Exported for unit tests (strictness of the schema in json_schema mode).
export function buildSchema(routeNames) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      intent: {
        type: 'string',
        description: `A concise first-person phrase capturing the user's latest intent:
what I want to know, find, remember, change, or do.
Use the user's language and keep only the core meaning`,
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
      reason: {
        type: 'string',
        description: 'Brief justification of the skill choice, one phrase.',
      },
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
              description: `Entity value in its base form (nominative case), without extra words. Keep the language of the original message: for a Russian message return «Берлин», «мама», not "Berlin", "mom".`,
            },
          },
        },
      },
      needs_memory: {
        type: 'boolean',
        description: 'Whether long-term memory about the user is needed for the reply.',
      },
      needed_memory_scopes: {
        type: 'array',
        description: `Which memory scopes are needed for the reply: dialog — open conversation threads; profile — user profile and communication style; domain — subject-matter memory of the current domain; secure — protected data (only on the user's explicit request); reminder — reminders and scheduled tasks.`,
        items: {
          type: 'string',
          enum: ['dialog', 'profile', 'domain', 'secure', 'reminder'],
        },
      },
      needs_tools: {
        type: 'boolean',
        description: 'Whether tools (external actions: search, scheduler, etc.) are needed to fulfil the request.',
      },
      candidate_tools: {
        type: 'array',
        description: 'Probable names of the needed tools; an empty array if no tools are needed.',
        items: { type: 'string' },
      },
    },
    required: [
      'intent',
      'skill_name',
      'confidence',
      'entities',
      'needs_memory',
      'needed_memory_scopes',
      'needs_tools',
      'candidate_tools',
    ],
  };
}

// System prompt: a markdown list of skills with a usage rule for each one. Signal values come from
// SKILL.md frontmatter and stay in the language users actually type them in (mostly Russian).
function buildSystemPrompt(routes) {
  const list = routes
    .map((r) => {
      const arr = [
        ['domain', r.domain_key],
        ['Purpose', r.description],
        ['When to use', r.when_to_use],
      ];
      if (r.positive_signals?.length) {
        arr.push(['Positive signals', r.positive_signals.join('; ')]);
      }
      if (r.negative_signals?.length) {
        arr.push(['Negative signals', r.negative_signals.join('; ')]);
      }
      const s = arr.map(([k, v]) => `**${k}**: ${v}`).join('  \n');
      return `### ${r.name}\n\n${s}`;
    })
    .join('\n\n');
  return `You are the incoming-message classifier.
Fill in every response field according to its description in the JSON schema.
Positive and negative signals are hints, not a strict list: choose the skill by meaning.

## Available skills:

${list}

Do not reply to the user.`;
}

export async function classifyIntent(userMessage, currentDomainKey = 'general', shortState = '') {
  const routes = listSkillRoutes();
  const routeNames = routes.map((r) => r.name);
  return chatJSON({
    model: config.llm.auxModel,
    kind: 'intent_classify',
    schema: buildSchema(routeNames),
    schemaName: 'skill_classification',
    system: buildSystemPrompt(routes),
    user: `Current agent domain: ${currentDomainKey}
Last dialog state: ${shortState || 'none'}
User message: ${userMessage}`,
  });
}
