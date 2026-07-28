---
name: psd-aistudio
summary: Discover and act in AI Studio as the caller, including catalog-backed repository list, describe, search, source, and change operations. Uses a one-click delegated OAuth connection, with legacy per-user API keys retained only for compatibility.
description: Use this to read AI Studio's live capability catalog and repository catalog, execute assistants, and work with decisions. Prefer the caller-bound OAuth connection; current scopes and repository/item/segment ACLs are enforced server-side on every request.
allowed-tools: Bash(node:*)
---

# psd-aistudio

Two things in one skill, over AI Studio's existing `/api/mcp` endpoint:

1. **Discovery** — a live catalog of **what AI Studio can do**, read straight from
   the deployed app's own registries (`describe_capabilities`). It can never fall
   behind: a feature that shipped this morning shows up now.
2. **Action** — do things in AI Studio **as the caller**: list/execute assistants,
   search/capture decisions, read the decision graph. Each action maps 1:1 to an
   MCP tool call; **what you're allowed to do is enforced server-side by the
   signed invocation owner's OAuth grant or API key**, not by this skill.

## Authorization model — delegated OAuth first

Every subcommand accepts a legacy optional `--user <caller-email>` hint from
the harness `[caller: Name <email>]` line. It is never an identity selector and
never crosses the broker boundary. The local router signs the immutable
workspace owner into a replay-bound request proof; AI Studio derives the
credential path only from that signed context. Credential resolution:

- **Preferred: owner-bound OAuth.** `connect` produces a one-click AI Studio
  Authorization Code + S256 PKCE link. Access/refresh tokens are stored in the
  owner's encrypted per-user slot, refresh tokens rotate automatically, and
  `disconnect` revokes the current invocation owner's grant.
- **Compatibility: owner's existing `aistudio_personal_key`.** Used only when
  no usable OAuth connection exists.
- **Discovery fallback: shared `platform:read` key.** It can discover
  capabilities but cannot read repositories or perform user actions.

```bash
node /opt/psd-skills/psd-aistudio/run.js connect --user <caller-email>
node /opt/psd-skills/psd-aistudio/run.js disconnect --user <caller-email>
```

Legacy API-key compatibility remains available (the value never appears in chat, logs, or files —
though, like any CLI argument, `--value` is briefly visible in the machine's
process list while `put.js` runs; same caveat psd-credentials documents):

```bash
node /opt/psd-skills/psd-credentials/put.js \
  --name aistudio_personal_key --value <the caller's sk- key>
```

The broker returns only which credential class it used (`oauth`, `personal`, or
`shared`) — never the value. Provider tokens, API keys, Authorization headers,
and Secrets Manager access remain outside the model-facing skill. If an action
comes back insufficient-scope on the shared key, tell the user to store their
own key (above).

> This skill is a **thin passthrough**. It does not decide which scopes are
> admin-only — it hands the resolved key to `/api/mcp` and the server enforces the
> key's scopes. "Whatever they have rights to do in the system" is exactly what
> the key can do, and keys are role-filtered at creation time.

## Scope model (who can do what)

A key can only ever hold scopes the owner's roles allow (role-filtered when the
key is minted). The relevant scopes:

| Action subcommand | MCP scope required | Who holds it |
|---|---|---|
| `list-assistants` | `mcp:list_assistants` | staff + admin |
| `execute-assistant` | `mcp:execute_assistant` | **staff + admin** |
| `create-assistant` | `mcp:create_assistant` | **staff + admin** |
| `update-assistant` | `mcp:update_assistant` | **staff + admin** |
| `fork-assistant` | `mcp:fork_assistant` | **staff + admin** |
| `search-decisions` | `mcp:search_decisions` | staff + admin |
| `get-decision-graph` | `mcp:get_decision_graph` | staff + admin |
| `capture-decision` | `mcp:capture_decision` | **admin only** |

- `execute_assistant` is **staff + admin** — MCP now matches REST for execution
  (a staff member can execute assistants with their own key).
- Assistant create/update/fork are **staff + admin**. Updates are owner-or-admin;
  forks may copy any assistant the caller can currently see. Every mutation
  resets the resulting assistant to `pending_approval`.
- `capture_decision` is **admin-only** over MCP (consistent with `graph:write`).
- **A key minted before these scope changes won't automatically gain
  `mcp:execute_assistant`, `mcp:create_assistant`, `mcp:update_assistant`, or
  `mcp:fork_assistant`** — the owner must mint a **new** key (the create dialog
  offers allowed scopes automatically) and re-store it.

## Discovery subcommands

### `capabilities` — the live capability catalog (use this first)

```bash
node /opt/psd-skills/psd-aistudio/run.js capabilities                       # everything
node /opt/psd-skills/psd-aistudio/run.js capabilities --section actions --surface mcp
node /opt/psd-skills/psd-aistudio/run.js capabilities --query "assistant"
```

Output is the raw MCP envelope (`{"content":[{"type":"text","text":"<catalog JSON>"}]}`,
unchanged from #1100) — parse `content[0].text` to get the catalog's three
sections: `actions[]` (invocable tools, each with `requiredScopes`,
`scopesBySurface`, `destructive`, and **`agentInvocable`**), `features[]`
(role-gated **web-app** features you steer users to), and `scopes[]` (the scope
reference). Capabilities (UI) and scopes (API-key) are **separate namespaces** —
never collapse them.

Flags: `--section actions|features|scopes|all` · `--surface mcp|ai_sdk|rest|internal`
· `--query <text>` · `--user <email>` (optional; uses the caller's key if stored).

### `list` — raw MCP tool list

```bash
node /opt/psd-skills/psd-aistudio/run.js list [--user <email>]
```

The MCP server's current `tools/list` (scope-filtered to what the resolved key
can see) — every tool name, description, and `inputSchema`.

## Action subcommands

All take an optional `--user <email>`; without a stored personal key they run on
the shared key and come back insufficient-scope (with a hint).

### `list-assistants`

```bash
node /opt/psd-skills/psd-aistudio/run.js list-assistants --user <email> \
  [--search <text>] [--status <status>] [--limit N] [--cursor <c>]
```

Lists the assistants the caller can execute. Use `--status approved` to find
executable ones.

### `execute-assistant`

```bash
node /opt/psd-skills/psd-aistudio/run.js execute-assistant --user <email> \
  --id <assistantId> [--inputs '{"field":"value"}']
```

Executes an **approved** assistant and returns `{ executionId, text, usage }`.

- `--inputs` must be a JSON object (default `{}`).
- **Draft vs approved gotcha:** API-key execution runs only **APPROVED**
  assistants. The owner/admin exception for drafts is **session-only** (it reads
  the web-UI login), so it never applies to this skill's key-authenticated calls
  — even the draft's own author gets `not_executable` here and should use the
  Assistant Architect UI for drafts. A draft/pending or non-existent id returns
  a clean `{ "status": "not_executable", "assistantId", "message" }` and
  **exits 0** — it is **not** an error. Steer to
  `list-assistants --status approved`.

### `create-assistant`

Create one or more assistants from the portable ExportFormat v1.0 JSON used by
the admin export/import UI. `status` values in the file are ignored; every
created assistant is owned by the caller and starts in `pending_approval`.

```bash
node /opt/psd-skills/psd-aistudio/run.js create-assistant --user <email> \
  --file /tmp/assistant-export.json
```

For a small envelope, `--json '<ExportFormat JSON>'` may be used instead of
`--file`. Local files must be regular files no larger than 10 MB; the CLI checks
the bound before reading them. The response reports every assistant result plus
each `modelName` → `mappedToId` choice.

### `update-assistant`

Replace one assistant's import-controlled fields, prompts, and input fields.
The envelope must contain exactly one assistant. A staff caller may update only
their own assistant; an administrator may update any assistant. The update is
atomic and resets status to `pending_approval`.

```bash
node /opt/psd-skills/psd-aistudio/run.js update-assistant --user <email> \
  --id 17 --file /tmp/edited-assistant-export.json
```

### `fork-assistant`

Fork a visible assistant into a new caller-owned `pending_approval` copy. The
source is unchanged; `--name` optionally overrides the copied name.

```bash
node /opt/psd-skills/psd-aistudio/run.js fork-assistant --user <email> \
  --id 17 --name "My assistant copy"
```

### `search-decisions`

```bash
node /opt/psd-skills/psd-aistudio/run.js search-decisions --user <email> \
  [--query <text>] [--node-type <t>] [--node-class <c>] [--limit N] [--cursor <c>]
```

### `capture-decision` (admin-only)

```bash
node /opt/psd-skills/psd-aistudio/run.js capture-decision --user <email> \
  --decision "Adopt X for Y" --decided-by "Cabinet" \
  [--reasoning "..."] [--evidence a,b] [--constraints a,b] [--conditions a,b] \
  [--alternatives a,b] [--related-to <uuid>,<uuid>] [--agent-id <id>]
```

Creates a structured decision node. Success returns `decisionNodeId`,
`completenessScore`, and any `warnings` — **surface both** so the user can improve
a low-completeness capture. Requires `mcp:capture_decision` (admin only); a staff
key comes back insufficient-scope with a hint (staff still cannot capture).

### `get-decision-graph`

```bash
node /opt/psd-skills/psd-aistudio/run.js get-decision-graph --user <email> --node-id <uuid>
```

Returns the node plus its edges.

## Repository subcommands

All repository operations use the catalog-backed MCP tools and the caller's
current delegated identity. Scope authorization is followed by live repository
and segment ACL checks; searches and source reads use the repository's active
index generation, so updates take effect without reconnecting.

```bash
node /opt/psd-skills/psd-aistudio/run.js repositories-list --user <email> [--query <text>]
node /opt/psd-skills/psd-aistudio/run.js repositories-describe --user <email> --repository-id 42
node /opt/psd-skills/psd-aistudio/run.js repositories-search --user <email> \
  --query "graduation requirements" [--repository-ids 42,51] [--mode hybrid]
node /opt/psd-skills/psd-aistudio/run.js repositories-source --user <email> \
  --repository-id 42 --item-id 900 [--chunk-id 1234]
node /opt/psd-skills/psd-aistudio/run.js repositories-changes --user <email> \
  --repository-ids 42,51 [--cursor <opaque-cursor>]
```

Scopes are deliberately granular: `repositories:list`, `repositories:read`,
`repositories:search`, and `repositories:changes`.

## Failure modes (surfaced cleanly, never retried)

- **Insufficient scope** — the JSON-RPC error is surfaced verbatim. Action
  subcommands emit `{ "status": "mcp-error", "tool": ..., "hint": "..." }` — the
  hint says to store your own key (on the shared key) or to re-mint a key with
  the missing scope (on a personal key). The discovery subcommands
  (`capabilities`, `list`) keep their original #1100 shape —
  `{ "status": "mcp-error", "method": ... }`, **no hint** (they need only
  `platform:read`, which every key holds, so this effectively never fires). The
  skill never retries or falls back to another key.
- **Draft assistant** — `{ "status": "not_executable" }`, exit 0 (see above).
- **Restricted assistant or model (resource grants)** — executing an assistant
  the caller has no per-resource grant for (or one whose prompt chain uses a
  restricted model) returns a tool-level error ("You do not have access to this
  assistant" / "…a model this assistant uses"), exit 12. Same enforcement the
  web UI and REST API apply — a scope alone is not enough.
- **Low completeness** — `completenessScore` + `warnings` on a successful capture.

## Exit codes

| Code | Meaning | Agent response |
|------|---------|----------------|
| 0 | Success — JSON on stdout (INCLUDES `not_executable`) | Use the result |
| 1 | Config / usage error | Surface the error, do not retry |
| 2 | Internal / unexpected error | Surface the error, do not retry |
| 11 | Unauthorized — key missing/invalid or lacks even `platform:read` | Tell the user AI Studio access isn't configured / their stored key is invalid |
| 12 | Upstream MCP error (JSON-RPC error incl. insufficient scope, tool-level error) or network | Surface verbatim; relay the `hint` if present |
| 14 | Rate-limited | Wait a moment, retry once |

## Rules

1. **Prefer `capabilities` over memory.** Never state what AI Studio can/can't do
   from a baked-in list — read it live.
2. **Respect `agentInvocable`.** If an action is `agentInvocable: false`, don't
   claim you can run it; steer the user to the UI feature.
3. **Don't collapse capabilities and scopes.** Different namespaces.
4. **Never echo a key value.** Use `psd-credentials put --name
   aistudio_personal_key` to store one; retrieval stays inside the trusted
   owner-bound operation broker.
5. **Never retry or key-swap on insufficient scope.** Surface the error + hint.
6. **Credential identity comes only from the signed invocation context.**
   Never pass a caller-selected owner to the credential broker.
