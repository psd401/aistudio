# Skill Publishing, Catalog, and Export

Issue #925 (Epic #922 workstream #3). How an Assistant Architect assistant
becomes a shareable SKILL.md skill, how skills are consumed inside AI Studio,
and what the exported zip contains for use outside the platform.

## Format

AI Studio's canonical skill format is **Anthropic's SKILL.md**: a folder with a
`SKILL.md` at its root (YAML frontmatter + markdown instructions), optionally
accompanied by scripts/resources. Web-published skills currently contain only
`SKILL.md`.

Frontmatter emitted by the serializer (`lib/skills/skill-serializer.ts`):

```yaml
---
name: my-skill-slug          # slugified assistant name
summary: One-line summary    # required by the scanner; from the description
description: Full description  # optional, present when the assistant has one
allowed-tools: documents.create@v1, search_decisions, web.fetch
---
```

- `allowed-tools` is a comma-separated inline list (the format the infra
  scanner expects), derived as the union of every prompt's `enabledTools`.
  Entries may carry an `@vN` version pin (see
  [tool-versioning](./tool-versioning.md)).
- Entries are restricted to a strict identifier charset
  (`ALLOWED_TOOL_ENTRY_RE`); anything else (whitespace, newlines, YAML meta
  characters) is rejected at publish time with a user-facing error — the line is
  emitted unquoted, so a hostile entry could otherwise inject frontmatter keys.
- `summary`/`description` values are YAML-escaped (`toYamlScalar`).

The body documents the assistant: `# name`, `## Inputs` (field table),
`## Instructions` (the prompt chain), and a portability footer.

## Publish pipeline

1. **Publish as Skill** (Assistant Architect → preview page) — owner-only,
   gated by the `assistant-architect` capability
   (`actions/db/publish-skill.actions.ts`).
2. The serialized folder uploads to S3 under
   `skills/user/{email}/drafts/{slug}/` and a `psd_agent_skills` row is written
   with `scope: 'draft'`, `scan_status: 'pending'` (republish bumps `version`
   in place while still a draft).
3. The **agent-skill-builder Lambda** is invoked async
   (`lib/skills/skill-publish-pipeline.ts`): it downloads the folder, scans it
   (secrets / PII / npm audit / SKILL.md lint, including malformed
   `allowed-tools@version` pins), promotes clean folders to the shared prefix,
   and writes the scan result back to the row. The write-back binds plain text
   (the `scope`/`scan_status` columns are VARCHAR + CHECK — **never** cast to
   the orphan enum types; that fails on any database that never had the
   pre-070 partial state).
4. **Admin review** (`/admin/agents/skills/review`, Epic #910 flow): approve →
   `scope: 'shared'`, `scan_status: 'clean'`; reject/delete → deactivation.
5. On approval the skill registers in the **unified tool catalog** with
   `source: 'skill'`, identifier `skill.{slug}`, `handlerRef: skill:{id}`,
   surfaces `['mcp', 'internal']`
   (`lib/skills/skill-catalog-registration.ts`). Reject/delete deactivates the
   catalog row.

## How skills are consumed

| Surface | Mechanism |
|---------|-----------|
| **Nexus chat** | Session binding, not a callable tool: `/skills/{id}` → "Use in chat" passes `skillId`; the chat route re-validates approval server-side, intersects the session's tools (built-in **and** MCP connector tools) with `allowed-tools`, and injects the SKILL.md instructions into the system prompt. An unknown/unapproved id neither loosens tools nor injects anything. |
| **Agentic assistants / MCP** | The `skill.{slug}` catalog tool is invocable; dispatch resolves `handlerRef: skill:{id}` via `lib/skills/skill-tool-executor.ts`, which re-checks approval (uncached) and returns the SKILL.md document as the tool result (progressive disclosure — a skill is an instruction folder, not a function). |

## Export for Claude Code / Claude Desktop

`/skills/{id}` → **Export as zip** (`app/api/skills/[id]/export/route.ts`,
approved skills only) downloads the promoted folder as
`{slug}-skill.zip` containing the skill folder (`SKILL.md` at the folder
root). Install by unzipping into your skills directory, e.g.
`~/.claude/skills/{slug}/`.

**Portability caveats** (also stamped into every generated SKILL.md):

- `allowed-tools` entries are AI-Studio catalog identifiers. Outside the
  platform, references like `nexus.chat`, `decisions.search`,
  `assistants.execute`, `images.generate`, or `documents.create` have no
  meaning — replace them with the host environment's equivalents or drop the
  key.
- `@vN` pins refer to AI Studio's tool-catalog versions; external hosts ignore
  them.
- The `summary` key is an AI-Studio/infra-scanner extension; Anthropic's
  reference format uses `name` + `description`, both of which are present.
- Web-published skills bundle no scripts, so nothing else needs replacement.

## Files

- Serializer: `lib/skills/skill-serializer.ts`
- Publish action: `actions/db/publish-skill.actions.ts`
- S3/Lambda pipeline + zip reader: `lib/skills/skill-publish-pipeline.ts`
- Scanner Lambda: `infra/lambdas/agent-skill-builder/index.ts`
- Catalog registration: `lib/skills/skill-catalog-registration.ts`
- Skill tool execution: `lib/skills/skill-tool-executor.ts`
- Chat-session enforcement: `lib/skills/skill-tool-enforcement.ts`
- Catalog UI: `app/(protected)/skills/`
- Export route: `app/api/skills/[id]/export/route.ts`
