---
title: Break hook circular dependency with an onFailure callback option, not a getter
category: react-patterns
tags:
  - hooks
  - circular-dependency
  - callback-pattern
  - eslint
  - observability
severity: medium
date: 2026-03-12
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #855 `usePollingWithBackoff` returned a `getConsecutiveFailures()` getter. The caller passed `fetchResults`/`fetchNotifications` as the `fn` argument while also calling `getConsecutiveFailures()` inside those functions. Because the getter was declared after the hook call, this created a forward-reference requiring `// eslint-disable-line` in production code.

## Root Cause

A hook that returns an internal-state accessor creates a circular dependency when the same caller also supplies the hook's `fn` argument: `fn` must reference the getter, but the getter doesn't exist until after the hook call that receives `fn`. There is no safe hoisting solution without either an ESLint suppression or an awkward ref-forwarding pattern.

## Solution

Replace the returned getter with an `onFailure` callback option on the hook:

```typescript
usePollingWithBackoff({
  fn: fetchResults,
  onFailure: (consecutiveFailures) => {
    if (consecutiveFailures >= THRESHOLD) reconnect();
  },
});
```

The hook increments its internal counter and calls `onFailure(count)` with the accurate post-increment value. The caller never holds a reference to internal state — the circular dependency disappears entirely, along with the `+1` arithmetic and the ESLint suppression.

## Prevention

- When a hook caller needs to react to internal hook state inside the `fn` it passes in, expose an event callback (`onFailure`, `onRetry`) rather than a state accessor.
- Callbacks receive accurate state at the moment of the event; getters require the caller to reason about staleness and ordering.
- Returned getters are appropriate only when the caller needs to read state outside of the `fn` lifecycle (e.g., in a separate event handler).
