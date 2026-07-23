# Tool & Skill Versioning

> Issue #927 · Epic #922 (Unify Agent Platform), workstream #5

The versioning contract for tools in the unified catalog (#924) and skills (#925).
It defines how a tool evolves without breaking consumers, the deprecation
lifecycle, and how skills pin the tool versions they depend on.

## Why versioning

Once a tool is exposed via MCP, the AI SDK, the REST API, and consumed by skills,
**stable contracts matter**. An assistant or skill built today must not break when
a tool's input schema changes tomorrow. Versioning gives tool authors a way to
evolve a tool without freezing it forever, and gives consumers a way to stay
pinned to a known-good version.

We use simple `v1` / `v2` / `v3` versions — **not** semver. Audience-friendly and
unambiguous: a new version is always a breaking change.

## The contract for tool authors

### Identifier + version

Every catalog tool has a stable `identifier` (`domain.action`, e.g.
`documents.create`) and a `version` (`v1`, `v2`, ...). Multiple versions of the
same tool coexist as separate catalog rows; the unique key is
`(identifier, version)`.

Callers address a tool as `identifier@version`:

- `documents.create` — **unpinned**: resolves to the latest non-deprecated version.
- `documents.create@v2` — **pinned**: resolves to exactly `v2`.

### Immutability

A version is **immutable once published**. Its `input_schema`, `output_schema`,
and observable behavior do not change. Bug fixes that do **not** change observable
behavior are allowed within a version; anything that changes the contract requires
a **new version** (a bump).

This is **enforced at sync time** (epic #922 completion audit): if a manifest
entry changes the input/output schema of an `(identifier, version)` that already
exists in `tool_catalog`, the boot-time sync REFUSES the update for that entry,
logs a structured error (`Tool version immutability violation`), and reports the
key in the sync result's `schemaViolations`. The runtime keeps serving the
published schema; the only way forward is a version bump.

> Rule of thumb: if a consumer that worked against `v1` could break, it is a new
> version, not an edit.

### Version grammar

Versions are `v1`, `v2`, ... — starting at `v1`, no leading zeros. `v0`, `v01`,
and `v1.2` are rejected as malformed everywhere (`versionRank`, `parseToolRef`,
the REST `versions/{n}` param), so a malformed pin can never half-match one
validation layer and pass another.

### Version-pinned dispatch

`ToolCatalog.dispatch()` accepts `name@vN` addressing: a pinned call dispatches
exactly that version (needed because `tools/list include:"all"` returns multiple
versions sharing one wire name), and a pin to a removed/never-existed version
fails with `unknown` rather than silently falling back to latest. Admin-disabled
versions are masked from the REST metadata routes the same way `dispatch()`
masks them: found-but-disabled reads as not-found.

### Adding a new version

Code tools live in the manifest (`lib/tools/catalog/manifest.ts`). To ship `v2`:

1. Add a new manifest entry with the same `identifier` and `version: "v2"` (the
   `v1` entry stays).
2. The boot-time sync reconciles both rows into `tool_catalog`.
3. Unpinned callers automatically move to `v2` (latest non-deprecated); pinned
   `@v1` callers keep getting `v1`.
4. When ready, **deprecate** `v1` (see below) so consumers are nudged to migrate.

## Deprecation lifecycle

A version moves through: **live → deprecated → (grace period) → removable → removed**.

| Field | Meaning |
|-------|---------|
| `deprecated_at` | Timestamp the version was marked deprecated. Still callable. |
| `replaced_by` | Successor `identifier@version` (e.g. `documents.create@v2`). |
| `grace_period_days` | Minimum days callable before removal. Default **90**. |
| `removal_date` | `deprecated_at + grace_period_days`. After this, an admin may remove it. |

- **Deprecated** versions stay callable but emit a structured
  `deprecated_tool_invocation` telemetry event on every authorized invocation, so
  we can track which callers still use them.
- The grace period is **snapshotted at deprecation time** — changing the global
  default never retroactively shortens an in-flight grace window.
- **Removal** is a hard delete (admin-only, audit-logged). A skill or assistant
  pinned to a removed version fails with a clear, actionable error pointing at the
  latest version.

Deprecation, restore, and removal are performed from **Admin → Tool Versions**
(`/admin/tools`), which shows each tool's version history with usage counts
(skills + assistant prompts referencing each version).

## Visibility

### MCP

`tools/list` returns the **latest non-deprecated version of each tool by
default** (one entry per logical tool). Pass `include: "all"` (JSON-RPC param) or
`?include=all` (query string) to return every version, including deprecated ones,
each tagged with `deprecated: true` and `replacedBy`.

### REST API

The API stays at `/api/v1`; per-tool versioning is in the path/query, not the API
version. Requires the `tools:read` scope.

- `GET /api/v1/tools/{identifier}` — latest non-deprecated version.
  - `?include=all` — every version under a `versions[]` array.
- `GET /api/v1/tools/{identifier}/versions/{n}` — a specific version (`v2` or `2`).
  Returns `404` with an actionable message if the version was removed.

See [`docs/API/v1/openapi.yaml`](../API/v1/openapi.yaml) (the `Tools` tag) and
[`docs/API/v1/context-graph.md`](../API/v1/context-graph.md).

## Skill version pinning

Skills declare the tools they may use in SKILL.md frontmatter `allowed-tools`.
Each entry may pin a version:

```yaml
---
name: my-skill
summary: Does a thing
allowed-tools:
  - documents.create@v1
  - nexus.chat@v2
  - web.fetch          # unpinned — tracks latest
---
```

- A pinned entry (`@v1`) keeps the skill on that version until the skill is
  **republished** — even after a newer version ships.
- An unpinned entry tracks the latest non-deprecated version.
- The pin gates which tools the session may use; matching is on the
  **version-stripped base name** (the runtime catalog resolves which version to
  actually dispatch). A malformed pin (`tool@2`, `tool@latest`) **fails closed** —
  it matches no real tool rather than silently widening access — and is flagged by
  the skill scanner at promotion time.

## Implementation map

| Concern | Location |
|---------|----------|
| Version resolution + deprecation policy (pure) | `lib/tools/catalog/version-resolver.ts` |
| Runtime resolution + deprecation telemetry | `lib/tools/catalog/catalog.ts` (`resolve`, `listVersions`, `dispatch`) |
| Schema (lifecycle columns) | `lib/db/schema/tables/tool-catalog.ts` · migration `083-tool-version-deprecation.sql` |
| MCP `tools/list` filtering | `lib/mcp/jsonrpc-handler.ts` (`selectListedTools`) |
| REST endpoints | `app/api/v1/tools/[identifier]/...` |
| Skill pin parsing/enforcement | `lib/skills/skill-tool-enforcement.ts` · `infra/lambdas/agent-skill-builder/frontmatter-tools.ts` |
| Admin version history + actions | `app/(protected)/admin/tools/` · `actions/admin/tool-versions.actions.ts` · `lib/db/drizzle/tool-catalog.ts` |

## Security notes

- Version pinning is a **supply-chain safety property**: a tool's behavior cannot
  silently change under a pinned consumer (immutability + explicit bump).
- Removal of a version is **admin-only and audit-logged** (structured
  `tool_version_removed` event), with a grace period preventing surprise breakage.
- The deprecation grace period gives pinned consumers time to migrate before a
  version disappears.
