# Explained: Domains

A domain is the routing and memory namespace selected for a conversation turn. It helps the same bot behave differently
for different subject areas without splitting the user into separate products.

## What a Domain Does

- Selects the active skill when the classifier is confident enough.
- Scopes memory retrieval so domain-specific facts do not pollute unrelated turns.
- Controls which skill references and tools may be available.
- Gives admin and tests a stable key for inspecting behavior.

## What a Domain Is Not

A domain is not a separate database, tenant, Telegram chat, or authorization boundary. It is a behavioral namespace
inside the same user and conversation system.

## Code References

- Skill registry and domain mapping: `../../../../src/pipeline/skills/registry.js`
- Skill files: `../../../../skills/`
- Domain rows and conversation helpers: `../../../../src/repo.js`
- Memory retrieval by domain: `../../../../src/pipeline/retrieve.js`
- Skill documentation: `../11-per-domain-schema.md`
