# 08. Prompts, Provider, and Models

Prompt text and JSON schemas are executable behavior. They belong in source files, skills, and tests. This document
explains where to look and how the prompt layers fit together.

## Provider Layer

`../../../src/llm.js` wraps the OpenAI-compatible provider for chat, streaming chat, strict JSON, embeddings, schema
preparation, usage extraction, and logging integration. Model names and response-format defaults are configured in
`../../../config/default.yaml`.

## Prompt Owners

- Main agent prompt, capability context, and model-turn orchestration: `../../../src/agent.js`
- Request classification: `../../../src/pipeline/classify.js`
- Fact extraction and answer summaries: `../../../src/pipeline/facts.js`
- History compression summary schema and instructions: `../../../src/pipeline/history-compress.js`
- Proactive message generation: `../../../src/pipeline/proactiveMessage.js`
- External event relevance: `../../../src/pipeline/events.js`
- Tool definitions and descriptions: `../../../src/pipeline/agent-tools/`
- Skill prompts and extraction prompts: `../../../skills/`
- Skill generation and editing prompts: `../../../src/pipeline/skills/author.js`

## Context Blocks

The model receives blocks for memory, compressed history, capabilities, global facts, shared knowledge, channel output
format, and skill-specific instructions. The exact text is assembled by the modules listed above.

When changing a prompt, update the owning module and the relevant test. Do not paste the prompt into documentation.
