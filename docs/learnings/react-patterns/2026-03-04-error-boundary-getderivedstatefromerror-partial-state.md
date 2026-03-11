---
title: getDerivedStateFromError must return Partial<State> to preserve accumulating counters
category: react-patterns
tags:
  - error-boundary
  - getDerivedStateFromError
  - react
  - streaming
  - assistant-ui
severity: high
date: 2026-03-04
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #822 added a `ToolArgsRecoveryBoundary` for assistant-ui streaming errors. `getDerivedStateFromError` returned the full state object with `recoveryAttempt: 0`, silently resetting the counter on every error. The `MAX_RECOVERY_ATTEMPTS` cap never triggered because the counter always restarted from 0.

## Root Cause

`getDerivedStateFromError` is a static method with no access to `this.state`. Returning the full state shape with reset values (e.g., `{ hasArgsTextError: true, recoveryAttempt: 0 }`) overwrites the accumulated counter instead of merging only the changed field.

## Solution

Return only the fields you want to change — React merges the partial return into the existing state:

```typescript
static getDerivedStateFromError(): Partial<State> {
  return { hasArgsTextError: true };
  // recoveryAttempt is incremented separately in componentDidCatch or a handler
}
```

## Prevention

- Treat `getDerivedStateFromError` return type as `Partial<State>` whenever your error boundary state has accumulating counters or fields that must survive across errors.
- Always verify cap/limit logic in error boundaries with a test that triggers the error more times than the cap allows.
