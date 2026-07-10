---
name: psd-aistudio
summary: Live, always-current view of what AI Studio can do — invocable MCP actions and the web-app features to steer users toward — projected from the app's own source-of-truth registries via the describe_capabilities MCP meta-tool.
description: Use this to know what AI Studio can currently do before you answer "can AI Studio…?" or steer a user to a feature. It calls AI Studio's describe_capabilities meta-tool over the existing /api/mcp endpoint, which projects the deployed app's own registries live, so new features appear the moment they deploy — never rely on a static list. Read-only: it discovers capabilities; it does not run app actions.
allowed-tools: Bash(node:*)
---

# psd-aistudio

A live catalog of **what AI Studio can do**, read straight from the deployed
app's own source-of-truth registries. Because it is a projection of the running
code (not a hand-maintained list), it can never fall behind: a feature that
shipped this morning shows up here now.

Use it to answer questions like "can AI Studio do X?", "what can I do in AI
Studio?", or "where do I go to compare models?" — and to decide whether *you*
(the agent) can perform an action over MCP or should instead point the user at a
web-app feature.

## What it returns

`capabilities` returns three clearly separated sections:

- **`actions[]`** — invocable tools. Each carries the `surfaces` it is exposed
  on, `requiredScopes` (the scope for the requested `--surface`, else the base
  MCP scope), `scopesBySurface` (the exact scope needed on *each* surface — e.g.
  `assistants:execute` on REST vs `mcp:execute_assistant` on MCP), `destructive`
  (writes/deletes), and **`agentInvocable`** — `true` when *you* can invoke it
  over MCP (surface includes `mcp`), `false` when it exists but isn't reachable
  from here.
- **`features[]`** — role-gated **web-app** features (Assistant Architect, Model
  Compare, Knowledge Repositories, Voice Mode, Atrium, …). These are
  human-driven UI you **steer the user to**; you cannot invoke them. Each lists
  the `defaultRoles` that get access.
- **`scopes[]`** — the API-scope reference (scope → description → which roles
  hold it) so you can explain access requirements.

Capabilities (UI, human) and scopes (API-key, programmatic) are **separate
namespaces** — the tool never collapses them, and neither should you.

## Authentication

The skill authenticates with a single scoped API key (`sk-…`) holding the
low-sensitivity **`platform:read`** scope — the catalog is non-sensitive product
metadata, so there is no per-user identity to assume for v1. The key is read
from `AISTUDIO_MCP_API_KEY`, or from Secrets Manager via
`AISTUDIO_MCP_API_KEY_SECRET_ID`. You do not handle auth yourself.

> **Deferred:** invoking real AI Studio actions (an action-executing passthrough)
> is **not** part of this skill. That path — and the production per-user
> credential it needs — is owned by the in-progress MCP action-tool work. This
> skill is discovery-only; do not attempt to run app operations through it.

## Subcommands

### `capabilities` — the live capability catalog (use this first)

```bash
# Everything (actions + features + scopes)
node /opt/psd-skills/psd-aistudio/run.js capabilities

# Just the actions you can invoke over MCP
node /opt/psd-skills/psd-aistudio/run.js capabilities --section actions --surface mcp

# Find capabilities related to a topic
node /opt/psd-skills/psd-aistudio/run.js capabilities --query "assistant"

# Just the human-driven web-app features
node /opt/psd-skills/psd-aistudio/run.js capabilities --section features
```

Flags:
- `--section actions|features|scopes|all` — narrow the response (default `all`).
- `--surface mcp|ai_sdk|rest|internal` — only actions on that surface (does not
  affect features/scopes). Use `--surface mcp` to see exactly what you can call.
- `--query <text>` — case-insensitive substring filter across
  identifier/name/description/scope.

### `list` — raw MCP tool list

```bash
node /opt/psd-skills/psd-aistudio/run.js list
```

The MCP server's current `tools/list` (scope-filtered to what this key can see):
every tool name, description, and JSON-Schema `inputSchema`. Use this when you
need a specific tool's **exact wire schema**; use `capabilities` for the broader
"what can the platform do" picture.

## Exit codes

| Code | Meaning | Agent response |
|------|---------|----------------|
| 0 | Success — JSON result on stdout | Use the result |
| 1 | Config / usage error | Surface the error, do not retry |
| 11 | Unauthorized — key missing/invalid or lacks `platform:read` | Tell the user AI Studio access isn't configured; do not retry |
| 12 | Upstream MCP error (JSON-RPC error, e.g. insufficient scope) or network | Surface the error verbatim |
| 14 | Rate-limited | Wait a moment, retry once |

## Rules

1. **Prefer `capabilities` over memory.** Never state what AI Studio can/can't do
   from a baked-in list — read it live. The catalog reflects the deployed code.
2. **Respect `agentInvocable`.** If an action is `agentInvocable: false`, do not
   claim you can run it; steer the user to the corresponding UI feature instead.
3. **Don't collapse capabilities and scopes.** They are different namespaces.
4. **Read-only.** This skill does not run app actions; do not try to make it.
