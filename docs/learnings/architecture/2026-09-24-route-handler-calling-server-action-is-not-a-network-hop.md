---
title: Calling a "use server" function from a Route Handler is not a network boundary
category: architecture
tags: [nextjs, server-actions, route-handlers, csrf]
severity: medium
date: 2026-09-24
source: auto — /work
applicable_to: project
---

## What Happened

While moving `queryArtifactData` from a Server Action to `POST /api/atrium/artifacts/[id]/query` (#1788), had to reason about whether the new route needed its own authz and CSRF handling.

## Root Cause

`"use server"` means "this function is callable by a client" — it is never itself a network boundary. When a Route Handler imports and calls a `"use server"` function directly, the call is inlined and runs in-process, same as any normal function call. This means:
- The action's own authz checks still run and are sufficient — the route does not need duplicate authz, as long as it delegates rather than reimplementing.
- The action's implicit protections DO NOT carry over: a Server Action has a built-in Origin/Host CSRF check; a Route Handler does not. Also, a Server Action's implicit body-size handling does not carry over — see [[security/2026-09-24-route-handler-loses-rate-limit-when-validation-precedes-it]].

## Solution

- Route holds no authz of its own; delegates entirely to `queryArtifactData` so guards cannot drift between two implementations.
- CSRF: audited that NextAuth cookies are `sameSite: 'lax'` (`auth.ts:392-400`), so a cross-site POST carries no session cookie, and `middleware.ts` 401s `/api/*` for signed-out callers. Also audited every non-`/api/v1` POST route handler in the repo — none do an explicit Origin check, so this is consistent with existing convention (not a new gap), but worth recording explicitly since it's easy to miss when moving code off a Server Action.

## Prevention

- When migrating a Server Action to a Route Handler, explicitly check: (1) does authz still get exercised by delegating to the action, (2) does the route need its own CSRF/Origin check (usually not needed here given `sameSite: 'lax'` + middleware, but must be verified per-endpoint, not assumed), (3) does the route need explicit body-size bounding (see linked learning).
