---
title: A publish-approval gate enforced in one service method was bypassable via two sibling write paths
category: security
tags:
  - atrium
  - authorization
  - approval-gate
  - visibility
  - scope-check
  - idor
severity: high
date: 2026-06-30
source: auto — /lfg
applicable_to: project
---

## What Happened

PR #1088 (Atrium Phase 5, issue #1055) found that the public-publish approval gate (§26.4, `canPublishPublic`/`ApprovalRequiredError`) was enforced only in `publishService.publish`. Two other write paths could set `visibility.level = "public"` directly, bypassing the gate entirely: `contentService.create` (via the `content:create` scope) and `visibilityService.setLevel` (via `content:update` scope — reachable from the MCP `set_visibility` tool, the REST `PATCH .../visibility` route, and the UI set-visibility action).

## Root Cause

The capability check was added at the single call site that seemed like "the" publish action, without auditing every write path that can reach the same protected end state (`visibility.level === "public"`). `hasPublishPublicCapability` was also initially derivable from the session's wildcard scope (`["*"]`) rather than the explicit granted scope, which would have made the check trivially true for any session-authenticated user.

## Solution

Centralized the `canPublishPublic` / `ApprovalRequiredError` check into both `contentService.create` and `visibilityService.setLevel` so every caller (service, MCP tool, REST route, UI action) inherits it. `hasPublishPublicCapability` is derived from the explicit granted scope, never from a `["*"]` wildcard match.

## Prevention

- When a capability/approval gate is added to protect a state transition (e.g., "become public"), enumerate every code path that can produce that state, not just the one the issue mentions. Grep for the field/enum value being protected (`visibility.level`, `"public"`) across services, MCP tools, REST routes, and UI actions.
- Never derive a capability boolean from a wildcard scope (`["*"]`) — always check the explicit scope string, or a session bypass silently grants the gated capability to everyone.
- See [[capability-gate-split-visibility-vs-options]] for a related but distinct pattern (gating an action vs. gating a read).
