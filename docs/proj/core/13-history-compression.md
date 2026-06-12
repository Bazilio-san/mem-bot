# 13. Dialogue History Compression

History compression keeps old dialogue useful without sending every old message to the model. It is not personal memory:
it preserves conversation state, open threads, and recent narrative context, while durable facts are handled by the
memory layer.

## Model

The context window is split into:

- **Hot window:** recent messages passed verbatim.
- **Cold zone:** older messages summarized into an active conversation summary.
- **State JSON:** structured continuity data for unresolved thread state.
- **Facts to memory:** durable candidates extracted from compressed history and passed through the normal fact pipeline.

The exact thresholds, schema, prompt, and token accounting live in code and configuration:

- Context assembly: `../../../src/pipeline/history-context.js`
- Compression logic and summary schema: `../../../src/pipeline/history-compress.js`
- Token counting: `../../../src/pipeline/token-counter.js`
- Fact saving path: `../../../src/pipeline/facts.js`
- Summary persistence: `../../../src/repo.js`
- Configuration defaults: `../../../config/default.yaml`
- Schema: `../../../migrations/001_init.sql`

## Safety Boundary

Compressed summaries are model-generated working memory. They must not override explicit durable memory, secure-memory
rules, or the user's latest message. When summaries contain durable candidates, those candidates still go through the
same confidence, privacy, embedding, and deduplication checks as ordinary facts.

## Verification

History behavior is covered by `../../../tests/history-compress-schema.test.mjs` and the history layer in
`../../../tests/run.js`.
