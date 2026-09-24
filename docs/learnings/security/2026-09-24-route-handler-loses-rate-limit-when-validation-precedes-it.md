---
title: A pre-check that short-circuits before the rate limiter makes the endpoint un-throttled
category: security
tags: [rate-limiting, route-handlers, request-validation, self-review]
severity: high
date: 2026-09-24
source: auto — /work
applicable_to: project
---

## What Happened

Self-review of #1788 (Server Action → Route Handler migration for Atrium artifact queries) found the new route read the body via `req.json()` (unbounded) BEFORE the rate limiter consumed a slot. A loop of oversized requests would get rejected for size on every call, but since rejection happened pre-rate-limit, the 60/min budget never throttled the loop at all.

## Root Cause

Moving a Server Action to a Route Handler loses the action's implicit body handling. When request validation (size checks, schema checks, etc.) runs before `checkRateLimit`-style logic, a failing request costs the attacker nothing against the budget — they can retry indefinitely at whatever rate they want, defeating the rate limiter's purpose entirely.

## Solution

Use `parseBoundedJsonRequest` from `lib/api/bounded-json-request.ts` instead of `req.json()` in new Route Handlers: it counts the STREAM rather than trusting `Content-Length`, so an understated header cannot smuggle a large body past the bound.

Be precise about what this does and does not fix. It removes the AMPLIFICATION — the per-request cost drops from "whatever the caller sends" to the cap (64 KiB here). It does NOT reorder anything: a malformed or oversized request is still refused before the action consumes a rate-limit slot, so such requests remain un-throttled by the per-artifact budget. That residual is acceptable here because the route is authenticated (middleware 401s `/api/*` for signed-out callers), the edge has its own rate rule, and the remaining cost per request is small and fixed. Reordering so the rate limiter runs before parsing would mean splitting the action's `authorizeQueryRequest`, which would weaken the "guards cannot drift between entry points" property the route was built on — worth proposing deliberately, not doing incidentally.

## Prevention

- In any Route Handler, order matters: rate-limit/auth checks should generally run before expensive or attacker-controllable validation, OR the validation itself must still count against the budget, OR the work done before the limiter must be bounded to something cheap and fixed. Decide which of the three applies and write it down — the failure mode is assuming the limiter covers a path it never reaches.
- Never use `req.json()` directly for parsing request bodies in new route handlers — always use `parseBoundedJsonRequest`.
- When migrating a Server Action to a Route Handler, explicitly verify the rate limiter is hit on every code path, including the reject-early paths.
