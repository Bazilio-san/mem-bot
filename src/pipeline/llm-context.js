// Correlation context for logging LLM requests. Via AsyncLocalStorage from the standard node:async_hooks
// module, the metadata of the current dialog turn (user, conversation, domain, channel, request kind) is
// available inside src/llm.js without threading parameters through every function.
import { AsyncLocalStorage } from 'node:async_hooks';

// Store for the current dialog turn's metadata. The value is a mutable object:
// { requestId, userId, conversationId, domainKey, channel, kind }.
export const llmContext = new AsyncLocalStorage();

// Run fn inside the store with the meta metadata. All async LLM calls started inside fn will see this
// metadata via getLlmContext(). The meta object is mutable: its fields can be filled in as data becomes
// available (for example, userId and conversationId aren't known right away).
export function runWithLlmContext(meta, fn) {
  return llmContext.run(meta || {}, fn);
}

// Return the current dialog turn's metadata, or an empty object if the context isn't set (for example, for
// one-off embeddings during admin database seeding — then user_id/conversation_id will be NULL).
export function getLlmContext() {
  return llmContext.getStore() || {};
}
