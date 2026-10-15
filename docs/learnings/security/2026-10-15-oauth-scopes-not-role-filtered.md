---
title: OAuth access-token scopes are not role-filtered — re-check capability server-side
category: security
tags: [oauth, scopes, authorization, mcp, repositories]
severity: high
date: 2026-10-15
source: auto — /work (issue #1907)
applicable_to: project
---

## What Happened

Built two MCP write tools (`repositories_create`, `repositories_add_item`) gated by new
scopes `repositories:write` / `repositories:create` on the first-party OpenClaw OAuth
client.

## Root Cause

`lib/api/auth-middleware.ts` reads `payload.scope` verbatim off the JWT for OAuth/JWT
auth — scopes come from what the client's `allowed_scopes` permitted at grant time, not
from the holder's current roles. Session and API-key auth instead derive scopes from
roles via `getScopesForRoles`. So a student who authorizes the first-party agent client
carries `repositories:create` even though their role would never grant it in the UI.

## Solution

Treat the scope check (enforced by the tool catalog's `dispatch()` before the handler
runs) as necessary but not sufficient. Every write handler in
`lib/mcp/repository-tool-handlers.ts` additionally re-checks the live
`knowledge-repositories` capability via `hasCapabilityAccess(cognitoSub, ...)` against
the caller's actual roles, and `add_item` separately re-checks ownership of the target
repository.

## Prevention

Any new scope-gated OAuth/MCP write needs a second, role-derived gate inside the handler
— never rely on OAuth scope membership alone as proof of role-appropriate access.
