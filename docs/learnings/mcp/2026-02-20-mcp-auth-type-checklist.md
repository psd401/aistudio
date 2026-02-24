---
title: Adding a new MCP auth type requires 12-file changes across 6 layers
category: mcp
tags:
  - auth
  - cognito
  - mcp-connectors
  - session-tokens
severity: high
date: 2026-02-20
source: auto — /work
applicable_to: project
---

## What Happened

Implemented `cognito_passthrough` auth type for MCP connectors, which passes the Cognito idToken from the NextAuth session as a Bearer header. No encrypted token storage is needed — the session provides the token at request time.

## Root Cause

MCP auth type definitions are scattered across multiple layers (types, service, actions, UI, DB). Missing any single location causes silent failures or runtime errors.

## Solution

When adding a new `McpAuthType` value, update all of the following:

1. **`McpAuthType` union type** — shared types file
2. **`VALID_AUTH_TYPES` in `connector-service.ts`** — service-layer validation
3. **`VALID_AUTH_TYPES` in `mcp-connector.actions.ts`** — public action validation
4. **`VALID_AUTH_TYPES` in admin `connector.actions.ts`** — admin action validation
5. **Admin form state types** — UI form shape must include the new value
6. **Admin connector form component** — render the new auth type option
7. **DB `CHECK` constraint** — migration must extend the allowed enum set
8. **MCP popover OAuth bypass logic** — conditionally skip OAuth flow for non-OAuth types
9. **`CognitoSession` interface** (if token injection needed) — expose idToken
10. **`getConnectorTools()` signature** — add optional token parameter
11. **MCP client header injection** — apply the token as Bearer header
12. **Chat UI / tool invocation path** — pass session token through to tool call

## Prevention

Before implementing a new MCP auth type, audit all `VALID_AUTH_TYPES` references:

```bash
grep -rn "VALID_AUTH_TYPES\|McpAuthType" src/ lib/ app/ actions/
```

Use this checklist as a pre-flight. Skipping the DB `CHECK` constraint or any action-layer set causes auth type to be silently rejected or treated as invalid at runtime.
