---
title: .then(scheduleNext) in polling setTimeout chains survives useEffect cleanup
category: react-patterns
tags:
  - useEffect
  - setTimeout
  - stale-closure
  - polling
  - cancelled-flag
  - cleanup
severity: high
date: 2026-03-11
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #845 review (independently flagged by Copilot, Codex, and Claude): a polling loop structured as `fetch().then(scheduleNext)` inside a `setTimeout` continued executing after `useEffect` cleanup. `clearTimeout` only cancels a *queued* timer — if the `.then()` continuation has already started executing, it runs to completion and chains the next `setTimeout`, leaking the loop.

## Root Cause

`clearTimeout` cancels a pending timer that hasn't fired yet. It does not cancel `.then()` callbacks already in the microtask queue or currently executing. A `.then(scheduleNext)` pattern therefore has a race window: if the fetch resolves in the same tick the effect is cleaned up, `scheduleNext` is called on an unmounted/torn-down effect with no way to stop it.

## Solution

Introduce a `cancelled` boolean scoped to the `useEffect`, checked inside `scheduleNext` and in the `setTimeout` callback:

```typescript
useEffect(() => {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout>;

  const scheduleNext = () => {
    if (cancelled) return;
    timer = setTimeout(poll, interval);
  };

  const poll = () => {
    fetchData().finally(() => {
      if (!cancelled) scheduleNext();
    });
  };

  poll();
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}, [interval]);
```

Use `.finally()` instead of `.then()` so `scheduleNext` is called whether the fetch succeeds or fails, and the `cancelled` guard prevents continuation after cleanup.

## Prevention

- Any `.then()` or `.finally()` inside a `useEffect` polling loop must guard on a `cancelled` ref/flag before scheduling the next tick
- `clearTimeout` alone is not sufficient cleanup for async chains — always pair it with a cancellation flag
- The existing pattern in `2026-03-11-polling-useref-isloading-dep-timer-churn.md` (using `useRef` for `isLoading`) is complementary but solves a different bug; both patterns are needed together
