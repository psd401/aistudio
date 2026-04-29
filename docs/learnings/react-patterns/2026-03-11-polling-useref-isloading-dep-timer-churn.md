---
title: isLoading state in polling useEffect deps causes timer churn — use useRef
category: react-patterns
tags:
  - polling
  - useEffect
  - useRef
  - session
  - exponential-backoff
severity: high
date: 2026-03-11
source: auto — /work
applicable_to: project
---

## What Happened

A polling hook used `isLoading` state in its `useEffect` dependency array alongside a `setTimeout` chain. Every fetch cycle toggled `isLoading` (false → true → false), which triggered the effect to re-run, which cancelled and recreated the timer — producing a new fetch immediately rather than waiting for the backoff interval.

## Root Cause

`useEffect` tears down and re-runs whenever a dependency changes. `isLoading` state changes inside the fetch callback (set to true before fetch, false after), so the effect fires on every state transition. Stale closure cleanup + recreation of `setTimeout` on each run collapses the intended interval to near-zero.

## Solution

Track `isLoading` via `useRef` instead of `useState` when it's only needed inside the effect (not for rendering):

```typescript
const isLoadingRef = useRef(false);

useEffect(() => {
  let timer: ReturnType<typeof setTimeout>;

  const poll = async () => {
    if (isLoadingRef.current) return;
    isLoadingRef.current = true;
    try {
      await fetchData();
    } finally {
      isLoadingRef.current = false;
      timer = setTimeout(poll, currentInterval);
    }
  };

  poll();
  return () => clearTimeout(timer);
}, [status, currentInterval]); // status is a primitive (useSession().status)
```

Use `setTimeout` chains (not `setInterval`) when interval is dynamic (e.g., exponential backoff), so the next delay is calculated after each response.

## Prevention

- In polling hooks, audit every `useEffect` dep: if it changes inside the effect's async callback, convert to `useRef`
- Prefer `useSession().status` (primitive string) over `session` (object) as a dep for session-gated effects
- Use `setTimeout` chains for dynamic intervals; `setInterval` only when interval is fixed
