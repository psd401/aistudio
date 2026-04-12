---
title: Polling hook re-throw contract requires .catch at non-hook call sites
category: react-patterns
tags:
  - polling
  - hooks
  - refactoring
  - error-handling
severity: medium
date: 2026-03-11
source: auto — /work
applicable_to: project
---

## What Happened

`usePollingWithBackoff` was extracted from `useExecutionResults` and `NotificationProvider`. The hook tracks failure counts by observing promise rejection from the fetch function — fetch functions re-throw errors so the hook's internal `.then`/`.catch` chain can record backoff state.

## Root Cause

The re-throw contract is designed exclusively for the hook's consumption. When the same fetch function is called outside the polling loop (e.g., an immediate one-shot fetch on mount or user action), the re-throw propagates into an uncaught promise chain, causing an unhandled rejection error.

## Solution

At every non-hook call site of a shared fetch function that re-throws, append `.catch(() => {})` to suppress the propagation:

```typescript
// Direct call outside polling loop — suppress the hook-contract re-throw
fetchData().catch(() => {});
```

The hook call sites need no change — the hook's internal chain already handles rejection.

## Prevention

When extracting a polling hook that uses rejection-tracking:
1. Grep the fetch function name for all call sites before shipping.
2. Any call site NOT inside the hook's internal loop needs `.catch(() => {})`.
3. Add a comment explaining why: `// re-throw is for usePollingWithBackoff — suppress here`.
