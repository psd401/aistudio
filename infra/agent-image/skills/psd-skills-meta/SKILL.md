---
name: psd-skills-meta
summary: Search the skill catalog, load a skill on demand, or author a new skill draft.
description: Meta-skill for skill discovery and authoring. Search for skills by name or keyword, load a full SKILL.md into the current session, or author a new skill draft that goes through automated scanning before promotion.
allowed-tools: Bash(node:*)
---

# psd-skills-meta

Meta-skill for the Agent Skills Platform. Provides skill discovery, on-demand
loading, and agent-authored skill creation.

**Identity.** All commands require `--user <caller-email>`.

## Commands

### `search` — search the skill catalog

```bash
node /home/node/.openclaw/skills/psd-skills-meta/search.js \
  --user <email> \
  --query "<search term>"
```

Returns matching skills from the catalog (name + summary only). Use this when
the user asks "do you have a skill for X?" or you need to find a skill.

### `load` — load a skill's full SKILL.md into the session

```bash
node /home/node/.openclaw/skills/psd-skills-meta/load.js \
  --user <email> \
  --name "<skill-name>"
```

Downloads and outputs the full SKILL.md for the named skill, making it
available for the current session. Use this when a Tier 2 catalog stub
indicates a skill exists but you need the full instructions.

### `author` — create a new skill draft

```bash
node /home/node/.openclaw/skills/psd-skills-meta/author.js \
  --user <email> \
  --name "<skill-name>" \
  --summary "<one-line summary>" \
  --skill-md "<full SKILL.md content, base64 encoded>" \
  --files "<JSON array of {path, content_base64} entries>"
```

Creates a skill draft in `skills/user/{userId}/drafts/{skill-name}/` in S3.
The draft is then scanned by the Skill Builder Lambda. If the scan is clean,
the skill is auto-promoted to `skills/user/{userId}/approved/` and becomes
available in your next session. If flagged, it goes to the admin review queue.

**Requirements for SKILL.md:**
- Must start with YAML frontmatter (between `---` markers)
- Frontmatter must include `name` and `summary` fields
- Summary must be a single line (used in the catalog)

**Requirements for entry point files:**
- At least one `.js` file
- A `package.json` if the skill has npm dependencies
- No hardcoded secrets (use psd-credentials instead)
