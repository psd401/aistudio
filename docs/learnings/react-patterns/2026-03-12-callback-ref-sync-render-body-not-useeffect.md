---
title: Callback ref must be assigned in render body, not useEffect
category: react-patterns
tags:
  - useRef
  - callback-ref
  - useEffect
  - timing
  - polling
  - react-hooks
severity: high
date: 2026-03-12
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #855 extracted a `usePollingWithBackoff` hook. The hook accepted an `onFailure` callback prop and wrapped it in a ref to avoid adding it to `useEffect` dependency arrays. The ref was updated inside a `useEffect` — a common but subtly wrong pattern that introduces a timing gap.

## Root Cause

`useEffect` runs after the browser has painted, not synchronously after render. Between render and effect flush, any timer or microtask continuation already queued can fire and call the stale function captured before the latest render. For a polling hook this is a real risk: a backoff timer fires, reads `onFailureRef.current`, and gets the function from the previous render.

## Solution

Assign the ref synchronously in the render body:

```typescript
// Wrong — timing gap between render and effect
useEffect(() => {
  onFailureRef.current = onFailure;
}, [onFailure]);

// Correct — ref is current before any timer can fire
onFailureRef.current = onFailure;
```

React docs now explicitly recommend the synchronous assignment pattern for "event handler refs" (stable-ref wrappers around callbacks). The ref object itself is stable; only its `.current` changes.

## Prevention

When wrapping a callback prop in a ref to stabilize `useEffect` deps, default to synchronous render-body assignment. Reserve `useEffect` for ref updates that have side effects (e.g., DOM subscriptions). Lint rule to watch for: a `useEffect` whose only body is `someRef.current = someValue`.
