---
title: Hook catch block reads stale ref when promise is re-thrown
category: react-patterns
tags:
  - hooks
  - polling
  - error-handling
  - ref-api
  - stale-closure
severity: medium
date: 2026-03-12
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #855 extracted a `usePollingWithBackoff` hook. The hook tracked `consecutiveFailures` in a ref and incremented it inside a `.catch()` handler before re-throwing. The caller's catch block logged `consecutiveFailures.current` expecting the post-increment value — but it always read the pre-increment value.

## Root Cause

When a promise is re-thrown, `.then()`/`.catch()` handlers chain in microtask order. The caller's `catch` block runs in the same microtask queue tick as the re-throw, **before** the hook's internal `.catch()` has a chance to execute and mutate the ref. The ref is stale by exactly 1 at the point the caller reads it.

## Solution

Log the expected post-failure value explicitly: `consecutiveFailures.current + 1`. Alternatively, expose a getter function in the hook's public API rather than the raw ref — this signals that the value is a snapshot and makes staleness easier to reason about.

## Prevention

- Any ref mutated inside a `.catch()` that also re-throws: assume callers see the pre-mutation value.
- Expose hook internals as getter functions (`getConsecutiveFailures: () => ref.current`) not raw refs when the value is written asynchronously.
- Validate numeric config params (`maxMultiplier`, `baseDelay`) on hook init — zero or negative multipliers collapse exponential backoff into a tight loop.
