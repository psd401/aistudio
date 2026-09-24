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

Use `parseBoundedJsonRequest` from `lib/api/bounded-json-request.ts` instead of `req.json()` in new Route Handlers — it counts the stream rather than trusting `Content-Length`, and integrates with rate-limit ordering correctly.

## Prevention

- In any Route Handler, order matters: rate-limit/auth checks should generally run before expensive or attacker-controllable validation, OR the validation itself must still count against the budget.
- Never use `req.json()` directly for parsing request bodies in new route handlers — always use `parseBoundedJsonRequest`.
- When migrating a Server Action to a Route Handler, explicitly verify the rate limiter is hit on every code path, including the reject-early paths.
