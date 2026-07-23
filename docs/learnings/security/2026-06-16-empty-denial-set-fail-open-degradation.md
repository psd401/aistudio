---
title: Empty denial-set fallback silently flips fail-safe to fail-open
category: security
tags:
  - graceful-degradation
  - fail-safe-vs-fail-open
  - jest-mock-hoisting
  - jsonb-key-ordering
  - logging-cap
  - tool-catalog
  - pr-review
severity: high
date: 2026-06-16
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #1032 (unified tool catalog, issue #924) had a cold-start DB-failure path that returned an empty `inactiveCodeKeys` Set as its fallback value. On cold start with no warm cache, that empty Set caused every code tool to project as active — silently overriding admin-disabled tools. The generic degraded-read log message gave no operator signal that enforcement was temporarily relaxed.

## Root Cause

The graceful-degradation fallback treated the denial set (inactive/disabled tools) the same as any data set: return empty on failure. But an empty denial set means "nothing is denied" — the opposite of safe. Warm-cache and cold-start-no-cache paths shared the same error log, so operators could not distinguish "degraded but cached" from "degraded and enforcement is off."

## Solution

Split into two distinct paths:
- **Warm cache present**: log at warn, serve stale cache — enforcement intact
- **Cold start, no cache**: log at error with explicit message that enforcement is temporarily relaxed, return empty Set (callers must handle)

Also applied in this session:
- Added per-request cap (5) on uncataloged tool-name pass-through logging with an aggregated warn for overflow
- Made `sameJson` key-order-stable via recursive sorted `JSON.stringify` to avoid spurious UPDATEs on Postgres JSONB key reordering
- Derived `MCP_TOOL_COUNT` from `TOOL_MANIFEST` in tests instead of hardcoding

## Prevention

- Any Set/list used to deny or block must default to a **restrictive** value on failure, not an empty one. If restrictive is not achievable, log at error and document the relaxed state explicitly.
- Jest `jest.mock` factory is hoisted above ALL top-level declarations including ES imports. Any singleton the SUT captures at module load must live inside the factory and be retrieved via `jest.requireMock` — referencing a top-level `const` from the factory throws `Cannot access before initialization`.
- For JSONB columns, use key-order-stable serialization (recursive sorted `JSON.stringify`) before equality checks to avoid spurious DB writes on key reordering.
