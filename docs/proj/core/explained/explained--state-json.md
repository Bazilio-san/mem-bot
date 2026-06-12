# Explained: State JSON

`state_json` is structured continuity state inside a conversation summary. It keeps unresolved dialogue state available
after old messages leave the hot window.

## Why It Exists

A summary is good for narrative context, but some state needs a stable shape: open loops, nearby plans, unresolved user
requests, assumptions, and short notes about what must be preserved for the next turn.

## Boundary with Memory

State JSON is not durable personal memory. If a piece of information should survive beyond the current conversational
thread, it must become a fact through the normal memory pipeline. If it is only needed to continue the current thread,
it belongs in the summary state.

## Code References

- Summary schema and creation: `../../../../src/pipeline/history-compress.js`
- Context assembly: `../../../../src/pipeline/history-context.js`
- Summary persistence: `../../../../src/repo.js`
- Concept docs: `../13-history-compression.md`
