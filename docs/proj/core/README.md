# Core Agent Documentation

This directory describes the channel-independent part of the memory chatbot: the agent loop, memory layers, history
compression, proactivity, skills, notes, and shared knowledge.

The documentation is intentionally not a copy of the implementation. For exact signatures, defaults, SQL, prompts, tool
schemas, and tests, follow the code references in each document.

## Reading Order

1. [01-overview.md](01-overview.md) explains the major loops and responsibilities.
2. [04-architecture.md](04-architecture.md) maps the message pipeline.
3. [06-memory.md](06-memory.md), [13-history-compression.md](13-history-compression.md), and
   [14-global-memory.md](14-global-memory.md) explain the context layers.
4. [10-operations.md](10-operations.md) maps scheduler, tools, logging, and tests.
5. [15-notes.md](15-notes.md) covers the user notes subsystem.

Project-wide documentation rules are in [../documentation-principles.md](../documentation-principles.md).
