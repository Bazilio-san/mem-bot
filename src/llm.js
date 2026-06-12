// LLM client via the OpenAI SDK. If OPENAI_BASE_URL is set, the SDK works with an OpenAI-compatible proxy
// like LiteLLM; if not set, it talks directly to the OpenAI API.
// The Chat Completions API is used (not the Responses API) because it is compatible with both modes.
// Three operations are available: a regular chat with tools, a chat with strict schema-based JSON, and embeddings.
// As a side effect, each operation logs the call to the journal (src/pipeline/llm-log.js): it measures the time,
// extracts tokens from the provider's response and puts a record into the buffer. Logging is wrapped in exception
// protection, so a journal failure does not affect the returned result, and the shape of the return value stays the same.
import OpenAI from 'openai';
import { config } from './config.js';
import { debugLlm } from './debug.js';
import { logLlmRequest } from './pipeline/llm-log.js';

const client = new OpenAI({ apiKey: config.llm.apiKey, baseURL: config.llm.baseURL });

// Safely log a call: any logging error is swallowed so it does not affect the model's response.
function safeLog(input) {
  try {
    logLlmRequest(input);
  } catch {
    // the journal must not break the main flow
  }
}

// Extract tokens from the provider's usage object into a uniform shape. Fields may be missing (then null).
function extractUsage(usage) {
  if (!usage) {
    return { promptTokens: null, completionTokens: null, totalTokens: null, cachedTokens: 0 };
  }
  return {
    promptTokens: usage.prompt_tokens ?? null,
    completionTokens: usage.completion_tokens ?? null,
    totalTokens: usage.total_tokens ?? null,
    cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
  };
}

// Chat with tool support. Returns the model's response message object
// (with content and tool_calls fields), so the caller can run the tool loop.
// The optional kind parameter sets the request type for the journal (defaults to being derived from the endpoint).
export async function chat({ model = config.llm.mainModel, messages, tools, toolChoice, kind }) {
  const body = { model, messages };
  if (tools && tools.length) {
    body.tools = tools;
  }
  if (toolChoice) {
    body.tool_choice = toolChoice;
  }
  debugLlm(`chat -> ${model} msgs: ${messages.length} tools: ${tools?.length || 0}`);
  const startedAt = Date.now();
  let res;
  try {
    res = await client.chat.completions.create(body);
  } catch (err) {
    safeLog({
      endpoint: 'chat.completions',
      kind,
      model,
      payload: body,
      durationMs: Date.now() - startedAt,
      status: 'error',
      error: err.message || err,
    });
    throw err;
  }
  const usage = extractUsage(res.usage);
  const msg = res.choices[0].message;
  safeLog({
    endpoint: 'chat.completions',
    kind,
    model,
    payload: body,
    response: { message: msg, finish_reason: res.choices[0].finish_reason ?? null },
    durationMs: Date.now() - startedAt,
    ...usage,
  });
  debugLlm(`chat <- ${JSON.stringify(msg).slice(0, 400)}`);
  return msg;
}

// --- Assembling the streaming model response ---------------------------------
// In a streaming Chat Completions call the response arrives in parts (chunks). The response text is in
// delta.content, and tool calls are in delta.tool_calls, with parts of a single call arriving by index:
// first the id may arrive, then the function name, then many fragments of the arguments. These three pure
// functions assemble from the stream the same final message object that the non-streaming chat returns,
// and are therefore covered by unit tests separately from the network.

// Create an empty accumulator for the streaming response.
export function createDeltaAccumulator() {
  return { role: 'assistant', content: '', tool_calls: [] };
}

// Add a single delta (the choices[0].delta content of the next chunk) to the accumulator.
export function accumulateChatDelta(acc, delta) {
  if (!delta) {
    return acc;
  }
  if (delta.content) {
    acc.content += delta.content;
  }
  if (Array.isArray(delta.tool_calls)) {
    for (const part of delta.tool_calls) {
      const index = part.index ?? acc.tool_calls.length;
      let slot = acc.tool_calls[index];
      if (!slot) {
        slot = { id: '', type: 'function', function: { name: '', arguments: '' } };
        acc.tool_calls[index] = slot;
      }
      if (part.id) {
        slot.id = part.id;
      }
      if (part.type) {
        slot.type = part.type;
      }
      if (part.function?.name) {
        slot.function.name += part.function.name;
      }
      if (part.function?.arguments) {
        slot.function.arguments += part.function.arguments;
      }
    }
  }
  return acc;
}

// Turn the accumulator into a final message object identical in shape to the non-streaming chat response:
// the tool_calls field is present only if tools were actually called.
export function finalizeChatMessage(acc) {
  const message = { role: 'assistant', content: acc.content };
  const calls = acc.tool_calls.filter(Boolean);
  if (calls.length) {
    message.tool_calls = calls;
  }
  return message;
}

// Streaming counterpart of chat: returns the same final message object (with content and tool_calls fields),
// but as text arrives it calls onDelta(chunkText) so the channel can show the response incrementally.
// If tools are not called, onDelta receives the response text in parts; tool arguments are not parsed on the
// fly — the caller does that after receiving the finished message.
// stream_options.include_usage asks the provider to send a final chunk with usage filled in, so that on
// stream completion the actual tokens can be logged. The fallback to non-streaming chat on error is done by the
// caller (see runModelTurn in src/agent.js) — there chat itself does the logging, so we do not log the error
// path again here.
export async function chatStream({
  model = config.llm.mainModel,
  messages,
  tools,
  toolChoice,
  onDelta,
  kind,
  client: clientArg,
}) {
  const api = clientArg || client;
  const body = { model, messages, stream: true, stream_options: { include_usage: true } };
  if (tools && tools.length) {
    body.tools = tools;
  }
  if (toolChoice) {
    body.tool_choice = toolChoice;
  }
  debugLlm(`chatStream -> ${model} msgs: ${messages.length} tools: ${tools?.length || 0}`);

  const startedAt = Date.now();
  const stream = await api.chat.completions.create(body);
  const acc = createDeltaAccumulator();
  let chunks = 0;
  let finishReason = null;
  let usageRaw = null;
  for await (const chunk of stream) {
    chunks++;
    // The final chunk with usage usually arrives with empty choices — we take the last non-empty usage.
    if (chunk.usage) {
      usageRaw = chunk.usage;
    }
    const choice = chunk.choices?.[0];
    if (!choice) {
      continue;
    }
    const delta = choice.delta || {};
    if (delta.content && onDelta) {
      await onDelta(delta.content);
    }
    accumulateChatDelta(acc, delta);
    if (choice.finish_reason) {
      finishReason = choice.finish_reason;
    }
  }
  const message = finalizeChatMessage(acc);
  safeLog({
    endpoint: 'chat.completions',
    kind,
    model,
    payload: body,
    response: { message, finish_reason: finishReason },
    durationMs: Date.now() - startedAt,
    ...extractUsage(usageRaw),
  });
  debugLlm(`chatStream <- chunks: ${chunks} finish: ${finishReason} tool_calls: ${message.tool_calls?.length || 0}`);
  return message;
}

// Allowed response_format modes for structured output. Resolution order in chatJSON:
// explicit call argument → config.llm.responseFormat → 'json_schema'.
const RESPONSE_FORMATS = ['json_schema', 'json_object'];

// Prepare an arbitrary JSON Schema for the provider's json_schema mode. Strict structured outputs require
// `additionalProperties: false` and a complete `required` list on EVERY object node, so both are filled in
// recursively (on a deep copy — the caller's schema is not mutated). Free-form objects
// (`additionalProperties: true` or an object type without declared properties) cannot be expressed in strict
// mode at all — for such schemas strict is turned off: the schema is still passed to the provider and guides
// the model, but conformance is not enforced by the API. Exported for unit tests.
export function prepareJsonSchema(schema) {
  const root = structuredClone(schema);
  let strict = true;
  const isObjectType = (node) => node.type === 'object' || (Array.isArray(node.type) && node.type.includes('object'));
  const walk = (node) => {
    if (!node || typeof node !== 'object') {
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node.additionalProperties === true) {
      strict = false;
    }
    if (node.properties && typeof node.properties === 'object') {
      if (node.additionalProperties === undefined) {
        node.additionalProperties = false;
      }
      node.required = Object.keys(node.properties);
      Object.values(node.properties).forEach(walk);
    } else if (isObjectType(node)) {
      strict = false; // a free-form object without declared keys
    }
    walk(node.items);
    for (const key of ['anyOf', 'oneOf', 'allOf']) {
      if (Array.isArray(node[key])) {
        node[key].forEach(walk);
      }
    }
  };
  walk(root);
  return { schema: root, strict };
}

// Chat with structured output per a JSON Schema. Returns the parsed object.
// The default mode is the provider-enforced json_schema (structured outputs). The legacy json_object mode —
// the schema described as text in the system prompt — is kept for providers/models without json_schema
// support; it is selected per call via the responseFormat argument or globally via config.llm.responseFormat.
// Historical note: json_object used to be the only mode because strict json_schema rejects free-form fields
// (data, entities); now such schemas are sent as json_schema with strict:false instead.
export async function chatJSON({
  model = config.llm.auxModel,
  system,
  user,
  schema,
  schemaName = 'result',
  kind,
  responseFormat,
}) {
  const mode = [responseFormat, config.llm.responseFormat].find((v) => RESPONSE_FORMATS.includes(v)) || 'json_schema';
  let sys = system || '';
  let format;
  if (mode === 'json_schema') {
    const { schema: prepared, strict } = prepareJsonSchema(schema);
    format = { type: 'json_schema', json_schema: { name: schemaName, strict, schema: prepared } };
  } else {
    // json_object: the provider only guarantees syntactically valid JSON, so the schema goes into the
    // prompt as text and conformance is requested verbally. The schema is ALWAYS wrapped in a
    // <json-schema> tag — the model sees an unambiguous boundary, and consumers (e.g. the admin log
    // viewer) can extract the schema from the prompt deterministically instead of guessing by braces.
    sys = `${sys}

Respond STRICTLY with one JSON object that matches JSON Schema (${schemaName}):
<json-schema>
${JSON.stringify(schema)}
</json-schema>
Без markdown, без пояснений, без текста до или после JSON. Только сам объект.`;
    format = { type: 'json_object' };
  }

  const body = {
    model,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
    response_format: format,
  };
  debugLlm(`chatJSON -> ${model} ${schemaName} (${mode})`);
  const startedAt = Date.now();
  let res;
  try {
    res = await client.chat.completions.create(body);
  } catch (err) {
    safeLog({
      endpoint: 'chat.completions',
      kind,
      model,
      payload: body,
      durationMs: Date.now() - startedAt,
      status: 'error',
      error: err.message || err,
    });
    throw err;
  }
  safeLog({
    endpoint: 'chat.completions',
    kind,
    model,
    payload: body,
    response: { message: res.choices[0].message, finish_reason: res.choices[0].finish_reason ?? null },
    durationMs: Date.now() - startedAt,
    ...extractUsage(res.usage),
  });
  const { content } = res.choices[0].message;
  try {
    return JSON.parse(content);
  } catch {
    // In case the model still wrapped the JSON in text — extract the first object.
    const m = content.match(/\{[\s\S]*}/);
    if (m) {
      return JSON.parse(m[0]);
    }
    throw new Error('Model returned non-JSON: ' + content.slice(0, 200));
  }
}

// Get a text embedding for semantic memory search. On error it returns null,
// in which case the system falls back to full-text and structural search without vectors.
// The optional kind parameter sets the request type for the journal (defaults to 'embedding').
export async function embed(text, { kind } = {}) {
  const model = config.llm.embedModel;
  const startedAt = Date.now();
  try {
    const res = await client.embeddings.create({ model, input: text });
    const usage = extractUsage(res.usage);
    safeLog({
      endpoint: 'embeddings',
      kind,
      model,
      payload: { model, input: text },
      // Vectors are heavy and useless in the journal — only their shape is recorded.
      response: { dims: res.data[0]?.embedding?.length ?? null, count: res.data.length },
      durationMs: Date.now() - startedAt,
      ...usage,
    });
    return res.data[0].embedding;
  } catch (err) {
    safeLog({
      endpoint: 'embeddings',
      kind,
      model,
      payload: { model, input: text },
      durationMs: Date.now() - startedAt,
      status: 'error',
      error: err.message || err,
    });
    debugLlm(`embedding unavailable: ${err.message}`);
    return null;
  }
}
