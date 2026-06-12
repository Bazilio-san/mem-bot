# Explained: Facts from History to Memory

Compressed history can produce durable fact candidates, but it does not write directly to memory. Candidates from
history use the same save path as candidates from a normal message turn.

## Data Flow

1. The history compressor summarizes older dialogue and returns durable candidates when appropriate.
2. Candidates are normalized into the fact shape expected by the memory writer.
3. The memory writer applies confidence, privacy, embeddings, deduplication, replacement, and retention rules.
4. Future turns retrieve accepted facts through the normal memory retrieval layer.

## Why This Matters

History compression should not create a second memory system. It only notices durable facts that would otherwise be lost
when old messages leave the hot window.

## Code References

- History compression and candidate conversion: `../../../../src/pipeline/history-compress.js`
- Fact saving and deduplication: `../../../../src/pipeline/facts.js`
- Retrieval into future turns: `../../../../src/pipeline/retrieve.js`
- Concept docs: `../13-history-compression.md`, `../06-memory.md`
