# Multilingual AI Pre-Router Architecture

## Goal

Build a fast pre-router that works with i18n and determines whether a message:

- requires no LLM at all
- requires an LLM without history
- requires an LLM with full context

Instead of language-specific keyword rules, classify semantic intent.

---

# Architecture

```text
Layer 1: cache

Layer 2: multilingual embedding router

Layer 3: SetFit classifier

Layer 4: small LLM / NLI fallback

Layer 5: safe default
```
...

## Recommended Route Types

```ts
type Route =
  | "NO_LLM_STATIC_REPLY"
  | "LLM_MINIMAL_NO_HISTORY"
  | "LLM_WITH_CONTEXT";
```

## Preferred Production Flow

```text
cache
  ↓
multilingual embeddings
  ↓
SetFit classifier
  ↓
small LLM fallback
  ↓
LLM_WITH_CONTEXT
```

## Embedding Router

Use multilingual sentence embeddings.

Suggested model:

- paraphrase-multilingual-MiniLM-L12-v2

Classes:

- STATIC_REACTION
- SELF_CONTAINED
- CONTEXT_DEPENDENT

Route according to cosine similarity and confidence thresholds.

## SetFit Classifier

Train on real production examples.

Labels:

- NO_LLM_STATIC_REPLY
- LLM_MINIMAL_NO_HISTORY
- LLM_WITH_CONTEXT

Start with 300–500 manually labeled samples.

## NLI / Small LLM Fallback

Only used when confidence is low.

Example labels:

- Greeting or reaction
- Standalone request
- Context-dependent request

## i18n Strategy

Router returns:

```json
{
  "route": "NO_LLM_STATIC_REPLY",
  "intent": "thanks",
  "lang": "fr"
}
```

Response text comes from translation files.

## Logging

Store:

```json
{
  "message": "make it shorter",
  "route": "LLM_WITH_CONTEXT",
  "confidence": 0.84
}
```

Use logs to continuously improve training data.

## Final Recommendation

For a production-grade multilingual assistant:

```text
cache
→ embedding router
→ SetFit classifier
→ small LLM fallback
→ full-context LLM
```

This provides excellent speed, low cost, multilingual support, and continuous improvement from real traffic.
