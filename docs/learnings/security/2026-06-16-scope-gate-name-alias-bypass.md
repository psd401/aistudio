---
title: Scope/auth gates that index by one name form silently fail open on valid aliases
category: security
tags:
  - tool-catalog
  - scope-gate
  - auth-bypass
  - name-mapping
  - discriminated-union
  - error-handling
  - cache-stampede
  - mcp
  - drizzle
  - code-review
severity: critical
date: 2026-06-16
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #1032 (unified tool catalog, issue #924) review surfaced three compounding correctness and security issues across catalog.ts, manifest.ts, sync.ts, jsonrpc-handler.ts, route.ts, and migration 080. Two always-on correctness agents and two adversarial agents independently flagged the same top findings.

## Root Cause

1. **Name-alias scope bypass**: The scope/auth gate indexed by wire name (`web_search_preview`) but callers could supply a friendly alias (`webSearch`). The lookup missed, the gate evaluated against nothing, and access was granted silently. The pass-through branch had no log line, making the bypass unobservable.

2. **String-encoded failure reason**: A failure reason was embedded in a human-readable error message string, then re-decoded downstream via `string.startsWith()`. Any wording tweak or i18n change silently mis-classifies the failure, and coincidental message matches produce false positives.

3. **Hardcoded `isActive: true` in runtime projection**: A hybrid code-manifest + DB table hardcoded `isActive: true` when projecting code-managed rows, making admin DB toggles on `is_active` a no-op at runtime.

## Solution

1. **Normalize all tool name lookups through `TOOL_NAME_MAPPING` before any security check.** Never index a gate directly by the raw caller-supplied name. Add a structured log line in every pass-through branch so gaps are observable.

2. **Return typed discriminated results** (`{ ok: false, reason: 'scope_denied' }`) instead of encoding the reason in a message string. Callers pattern-match on `reason`, not on text.

3. **Read `is_active` from the DB row** when projecting code-managed catalog entries. The runtime must not override DB state with a compile-time constant.

## Prevention

- Any lookup used in an auth/scope decision: normalize the key first, assert the normalized form resolves, log if it does not.
- Never re-parse human-readable strings for control flow — use typed discriminated unions.
- When a DB column exists to control runtime behavior, the runtime projection must read that column, not hardcode a safe-seeming default.
