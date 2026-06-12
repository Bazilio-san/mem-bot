# 14. Global Memory and Shared Knowledge

Global memory is shared context that can help every user. It has two parts:

- **Global facts:** short facts that may be injected into every relevant turn.
- **Shared knowledge:** longer text fragments searched semantically and by text, then injected when relevant.

## Boundary

Global memory is not a substitute for user memory. It should contain project-wide or generally useful information, while
personal preferences, secrets, and user-specific state stay in personal or secure memory.

Admin-only mutations protect the shared layer from ordinary users. Search can be exposed more broadly when it is useful
for the assistant response.

## Code Owners

- Global facts and knowledge operations: `../../../src/pipeline/global-memory.js`
- Agent tools: `../../../src/pipeline/agent-tools/global-fact/`,
  `../../../src/pipeline/agent-tools/global-knowledge/`
- Admin API: `../../../src/server/admin-api.js`
- Admin UI knowledge page: `../../../web/src/components/knowledge/`
- Embedding repair: `../../../src/pipeline/embedding-repair.js`
- Configuration defaults: `../../../config/default.yaml`
- Schema: `../../../migrations/001_init.sql`

## Prompt Budget

Global context competes with personal memory, history, and tool capability text. The implementation applies limits and
relevance thresholds from configuration; exact numbers belong in `../../../config/default.yaml`.

## Verification

Global-memory behavior is covered by the global-memory layer in `../../../tests/run.js` and admin API/UI tests where the
web surface is involved.
