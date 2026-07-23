---
title: Always surface lazy-load action failures via setError; use async IIFE pattern in effects
category: react-patterns
tags:
  - atrium
  - react
  - useEffect
  - async
  - iife
  - error-handling
  - lazy-loading
  - hooks-lint
severity: medium
date: 2026-06-29
source: auto — /work
applicable_to: project
---

## What Happened

Two related issues in the Atrium `VisibilityChip` component:

1. The `listGrantOptionsAction` effect had no `else` branch on failure. A DB error left the role `<Select>` with zero options and no error message shown. Users saw an empty dropdown, assumed role grants were impossible, saved without role grants, then hit a server-side "group requires at least one grant" error — which looked like their own mistake.

2. Using `void asyncFn()` with a `useCallback`-defined async function inside a `useEffect` triggered the `react-hooks/exhaustive-deps` lint rule. The lint-clean pattern was inlined async IIFE with a `cancelled` flag for cleanup.

## Root Cause

1. Lazy-loading effects optimistically assume DB calls succeed. Missing `else` branch on the failure case meant errors were swallowed silently.
2. `react-hooks/exhaustive-deps` evaluates whether deps inside the effect body are captured correctly. A `useCallback` reference used inside `void fn()` is treated as a dep; an inline IIFE captures what it needs directly and avoids the dep-tracking issue.

## Solution

1. Always add an `else` branch in lazy-load effects:
```ts
const result = await listGrantOptionsAction();
if (result.success) {
  setRoleOptions(result.data);
} else {
  setError(result.message ?? "Failed to load role options");
}
```

2. Use the async IIFE pattern with a cancelled flag:
```ts
useEffect(() => {
  let cancelled = false;
  void (async () => {
    const result = await listGrantOptionsAction();
    if (cancelled) return;
    if (result.success) setRoleOptions(result.data);
    else setError(result.message ?? "Failed to load options");
  })();
  return () => { cancelled = true; };
}, [dep1, dep2]);
```

## Prevention

- Any `useEffect` that fetches data must handle both success and failure branches explicitly — zero-option dropdowns with no error are worse UX than a visible error message.
- The async IIFE + `cancelled` flag is the project-standard pattern for async effects. Avoids `void fn()` lint issues and correctly handles stale closure cleanup.
