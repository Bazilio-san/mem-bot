# Prompt and Prompt-Like Template Registry

This file records the coordinates of all prompts in the current implementation. Unlike the portable specification in
`docs/ai-bot-with-memory/`, this document is project-specific: references to particular channels, tests, and
repository service directories are intentional here.

## Runtime Application Prompts

| Block | Coordinate | How it is used |
|-------|------------|----------------|
| Main system prompt `MAIN_SYSTEM` | `src/agent.js:30` | The first `system` block of the agent's primary response. |
| Main `messages` assembly | `src/agent.js:553` | The ordering of all `system` blocks, history, and the current `user` message. |
| `CAPABILITIES_CONTEXT` | `src/agent.js:298` | Injected when the user asks about the bot's capabilities. |
| `CURRENT_DATETIME` | `src/agent.js:453` | Current date, time, and timezone for every request. |
| `WELCOME_BACK_CONTEXT` | `src/agent.js:462` | Context for when a user returns after a pause. |
| `CONVERSATION_CONTEXT` | `src/agent.js:481` | Conversation-mode context: timing, topics, and conversational style. |
| `chatJSON` JSON instruction | `src/llm.js:203` | General wrapper for strict JSON output via `response_format: json_object`. |
| Intent classifier | `src/pipeline/classify.js:101` | Dynamic system prompt with the markdown skill list and a user-message template; field-level rules live in the schema descriptions (`buildSchema`). |
| Fact extraction `EXTRACT_SYSTEM` | `src/pipeline/facts.js:163` | The single extraction pass for long-term user facts (with fact-lifetime judgement). |
| Answer summary `SUMMARY_SYSTEM` | `src/pipeline/facts.js:104` | Compressing the assistant reply into a short summary for the extraction context. |
| Topic extraction `TOPICS_SYSTEM` | `src/pipeline/topics.js:113` | Identifying conversation topics and scoring user engagement. |
| History summarizer `SUMMARY_SYSTEM` | `src/pipeline/history-compress.js:63` | Compressing the cold portion of history and surfacing stable facts. |
| `HISTORY_CONTEXT` | `src/pipeline/history-context.js:12` | Reference block of compressed history for the main response. |
| `MEMORY_CONTEXT` | `src/pipeline/retrieve.js:121` | Reference block of relevant personal memory, protected against injection. |
| `GLOBAL_FACTS` | `src/pipeline/global-memory.js:71` | Shared facts and policies injected into the main request. |
| Reaction selector `SYSTEM` | `src/pipeline/reactions.js:26` | Decision on whether a short text can be replaced by a channel reaction. |
| Proactive message | `src/pipeline/proactiveMessage.js:50` | System + userPrompt for a message the bot sends unprompted. |
| Event relevance scoring | `src/pipeline/events.js:127` | JSON scoring of how interesting an external event is for the user. |
| Event message generation | `src/pipeline/events.js:150` | Generating a short personalised message for a relevant event. |
| Telegram `OUTPUT_FORMAT` | `src/telegram/bot.js:69` | Channel instruction for HTML markup used in Telegram delivery. |
| TTS summary | `src/voice/tts.js:61` | Brief summary of a long response prepared for text-to-speech. |

## Tool Definitions Visible to the Model

The `function.description` and `parameters.properties.*.description` fields are included in the model request as
instructions for each tool. These are not conventional `system`/`user` prompts, but they do influence model
behaviour. The coordinate points to the line containing `description` inside the `function` block.

| Tool | Coordinate |
|------|------------|
| `secure_record_get` | `src/pipeline/agent-tools/secure-record-get.js:10` |
| `skill_read_reference` | `src/pipeline/agent-tools/skill-read-reference.js:15` |
| `voice_or_text` | `src/pipeline/agent-tools/voice/voice-or-text.js:16` |
| `voice_set_preference` | `src/pipeline/agent-tools/voice/voice-set-preference.js:12` |
| `global_fact_add` | `src/pipeline/agent-tools/global-fact/global-fact-add.js:12` |
| `global_fact_delete` | `src/pipeline/agent-tools/global-fact/global-fact-delete.js:12` |
| `global_fact_list` | `src/pipeline/agent-tools/global-fact/global-fact-list.js:12` |
| `global_knowledge_add` | `src/pipeline/agent-tools/global-knowledge/global-knowledge-add.js:12` |
| `global_knowledge_delete` | `src/pipeline/agent-tools/global-knowledge/global-knowledge-delete.js:12` |
| `global_knowledge_search` | `src/pipeline/agent-tools/global-knowledge/global-knowledge-search.js:11` |
| `memory_forget_all` | `src/pipeline/agent-tools/memory/memory-forget-all.js:10` |
| `memory_forget_entity` | `src/pipeline/agent-tools/memory/memory-forget-entity.js:10` |
| `memory_list` | `src/pipeline/agent-tools/memory/memory-list.js:10` |
| `memory_pin` | `src/pipeline/agent-tools/memory/memory-pin.js:13` |
| `memory_search` | `src/pipeline/agent-tools/memory/memory-search.js:12` |
| `scheduler_create_task` | `src/pipeline/agent-tools/scheduler/scheduler_create_task.js:10` |
| `scheduler_list_tasks` | `src/pipeline/agent-tools/scheduler/scheduler_list_tasks.js:113` |

### Skill-Authoring Tools (`skill-authoring/`)

These tools allow the model to create and edit skills. Their `description` fields are also read by the model as
instructions.

| Tool | Coordinate |
|------|------------|
| `skill_author_create` | `src/pipeline/agent-tools/skill-authoring/skill-author-create.js:23` |
| `skill_author_read` | `src/pipeline/agent-tools/skill-authoring/skill-author-read.js:14` |
| `skill_author_list` | `src/pipeline/agent-tools/skill-authoring/skill-author-list.js:14` |
| `skill_author_set_field` | `src/pipeline/agent-tools/skill-authoring/skill-author-set-field.js:77` |
| `skill_author_write_prompt` | `src/pipeline/agent-tools/skill-authoring/skill-author-write-prompt.js:14` |
| `skill_author_write_extraction` | `src/pipeline/agent-tools/skill-authoring/skill-author-write-extraction.js:14` |
| `skill_author_add_reference` | `src/pipeline/agent-tools/skill-authoring/skill-author-add-reference.js:14` |
| `skill_author_remove_reference` | `src/pipeline/agent-tools/skill-authoring/skill-author-remove-reference.js:14` |
| `skill_author_validate` | `src/pipeline/agent-tools/skill-authoring/skill-author-validate.js:14` |
| `skill_author_apply` | `src/pipeline/agent-tools/skill-authoring/skill-author-apply.js:15` |
| `skill_author_reload` | `src/pipeline/agent-tools/skill-authoring/skill-author-reload.js:14` |
| `skill_author_enable` | `src/pipeline/agent-tools/skill-authoring/skill-author-enable.js:14` |
| `skill_author_disable` | `src/pipeline/agent-tools/skill-authoring/skill-author-disable.js:14` |
| `skill_author_delete` | `src/pipeline/agent-tools/skill-authoring/skill-author-delete.js:14` |

### MCP Tools

The `search_flights` tool is no longer defined in a local file. It is now delivered dynamically by the `yafly` MCP
server (see `src/mcp/client.js:134` and `src/pipeline/tools.js:19`), so its `description` is set on the server
side and has no coordinate in the local tool-definition registry. The model sees it under a server-prefixed name
(e.g. `yafly__search_flights`), while skills reference it by the logical name `search_flights` without a prefix.

## Eval Harness Prompts

| Block | Coordinate | How it is used |
|-------|------------|----------------|
| Dialog judge system prompt | `scripts/eval/judge.js:judgeDialog` | LLM judge of the eval harness (`request_kind: eval_judge`). Axis wordings are NOT inline: they are assembled from `tests/eval/rubrics/<axis>.md`; axes, scales and weights come from `tests/eval/criteria.yaml`. |

## Test Prompts

| File | Coordinates |
|------|-------------|
| LLM proxy check | `tests/check-llm.js:77`, `tests/check-llm.js:96`, `tests/check-llm.js:128`, `tests/check-llm.js:164`, `tests/check-llm.js:198` |
| Streaming check | `tests/check-streaming.js:46`, `tests/check-streaming.js:66` |
