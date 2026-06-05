---
name: edit-claude-files
description: "Protocol for editing or creating any file under .claude/ (SKILL.md, scripts, hooks, agents, settings.json, etc.). Use whenever a file path starts with .claude/ — direct Write/Edit is blocked by settings.json, so changes MUST go through the scripts/fcp.js temp-copy workflow."
allowed-tools: Read, Write, Edit, MultiEdit, Bash(node scripts/fcp.js *), Bash(rm:*)
---

# Editing files in `.claude/`

**Scope of this rule — read carefully.** It applies to **every file under `.claude/`** — not only
`SKILL.md`. This includes scripts in `.claude/skills/<skill>/scripts/`, hooks in `.claude/hooks/`,
agent configs in `.claude/agents/`, supporting reference files, `settings.json`, and anything else
inside the directory. Claude Code watches the whole tree and reloads on change; direct writes risk
partial reads and inconsistent state during multi-edit sessions.

To enforce this, `settings.json` denies the `Write` and `Edit` tools on `.claude/**` outright.
Attempting a direct edit will fail the permission check — that is intentional, not a bug.

**Protocol — every file, every time:**

1. **Copy** the target file to a temp location outside `.claude/` (works for any file type: md, js,
   json, cjs, …):
   ```bash
   node scripts/fcp.js tmp-edit.md .claude/skills/<skill-name>/SKILL.md
   node scripts/fcp.js tmp-helper.js .claude/skills/<skill-name>/scripts/helper.js
   ```
2. **Edit** the temp file — make ALL changes there (multiple Edit calls are fine).
3. **Save** atomically via the helper script (same command, reversed argument order):
   ```bash
   node scripts/fcp.js .claude/skills/<skill-name>/SKILL.md tmp-edit.md
   node scripts/fcp.js .claude/skills/<skill-name>/scripts/helper.js tmp-helper.js
   ```
4. **Remove** the temp file:
   ```bash
   rm tmp-edit.md
   ```

**Creating a new file in `.claude/`** — same protocol, just start from an empty temp file:

```bash
# Write the new file somewhere OUTSIDE .claude/, then fcp.js it in:
node scripts/fcp.js .claude/skills/<skill-name>/scripts/new-script.js tmp-new-script.js
rm tmp-new-script.js
```

CRITICAL: Never use `Edit` or `Write` directly on files inside `.claude/` — always go through the
temp-copy workflow above. This covers SKILL.md, scripts, hooks, agents, settings — everything.
