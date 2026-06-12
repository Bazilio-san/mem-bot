# 07. Secure Memory and Privacy

Secure memory separates sensitive raw values from ordinary facts. The model may see a redacted summary, while the raw
value is encrypted and only read for a concrete purpose with consent.

## Design

- Redacted summaries can be retrieved like context.
- Raw values are encrypted with the project secret.
- A secure-record tool requires an explicit purpose and checks consent state before returning the raw value.
- Ordinary fact extraction should avoid turning secrets into plain memory.

Implementation owners:

- Encryption, redaction, consent, and reads: `../../../src/pipeline/secure.js`
- Secure record access tool: `../../../src/pipeline/agent-tools/secure-record-get.js`
- Schema: `../../../migrations/001_init.sql`
- Configuration: `../../../config/default.yaml`

## Verification

Privacy behavior is covered by the broad suite in `../../../tests/run.js` and focused tests where secure-memory behavior
touches tools or retrieval. Keep examples in tests, not in documentation.
