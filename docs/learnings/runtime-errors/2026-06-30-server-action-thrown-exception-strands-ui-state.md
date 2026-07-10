---
title: Server action THROWN exceptions strand React UI state when only ActionState failure is handled
category: runtime-errors
tags:
  - react
  - server-actions
  - error-handling
  - try-catch
  - async
  - loading-state
  - regression-tests
  - eslint-max-lines
  - atrium
  - pr-review
severity: high
date: 2026-06-30
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #1081 (Atrium Phase 3) had three call sites in `components/atrium/VisibilityChip.tsx`
that awaited server actions inside a React effect or callback. Each site handled
`result.isSuccess === false` correctly, but had no `try/catch` around the `await`.
A network error or server crash throws instead of returning an `ActionState`, so the
`setSaving(false)` / `setLoaded(true)` / `setRoleOptions` / `onError` paths never ran
and the UI was permanently stranded — "Saving…" stuck, trigger button disabled, dropdown
silently empty — with no visible error and no escape except a full page refresh.

## Root Cause

`ActionState`-based server actions have two distinct failure modes:
1. **Returned failure** — `result.isSuccess === false` — caught by existing `if` checks.
2. **Thrown exception** — network error, server crash, unhandled rejection — bypasses
   the `if` check entirely; any flag-clearing setter in the success/failure branch is
   never reached.

Code reviews and existing tests only covered mode 1, leaving mode 2 silently unguarded.

## Solution

Wrap every `await someAction()` that toggles a loading/disabled flag in `try/catch/finally`:

```typescript
// inside a useEffect IIFE — use a cancelled guard
let cancelled = false;
try {
  const result = await fetchRoleOptions();
  if (!cancelled) {
    if (result.isSuccess) setRoleOptions(result.data);
    else onError(result.error);
  }
} catch (err) {
  if (!cancelled) {
    logger.error("fetchRoleOptions threw", { err });
    onError("Failed to load options");
  }
} finally {
  if (!cancelled) setLoaded(true);  // always re-enables UI
}
return () => { cancelled = true; };

// inside a plain callback (no cleanup needed)
try {
  const result = await saveVisibility(payload);
  if (result.isSuccess) onSaved();
  else toast.error(result.error);
} catch (err) {
  logger.error("saveVisibility threw", { err });
  toast.error("Save failed — please try again");
} finally {
  setSaving(false);  // always unlocks the button
}
```

Add a regression test with `mockRejectedValue` — `mockResolvedValue({ isSuccess: false })`
does NOT cover the thrown path:

```typescript
it("unlocks button when action throws", async () => {
  vi.mocked(saveVisibility).mockRejectedValue(new Error("network"));
  // ... assert button re-enabled after interaction
});
```

When adding try/catch pushes a function past `max-lines-per-function`, extract to a
module-level helper that accepts setters as parameters (matches the existing
`useRoleOptions` extraction pattern) rather than disabling the lint rule.

## Prevention

- Every `await serverAction()` in a React effect/callback that sets a loading or
  disabled flag must use `try/catch/finally`; put the flag-clearing setter in `finally`.
- Inside effects, guard state setters with a `cancelled` ref/flag to prevent
  post-unmount state updates.
- Always add a `mockRejectedValue` test alongside any `mockResolvedValue({ isSuccess: false })`
  test — they cover orthogonal failure modes.
- When extraction is needed to stay under `max-lines-per-function`, prefer a module-level
  helper over an inline disable comment.
