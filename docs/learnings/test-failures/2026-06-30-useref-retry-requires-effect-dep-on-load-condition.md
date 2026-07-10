---
title: "useRef success-guard retry only works when the load condition is also an effect dep"
category: test-failures
tags:
  - useRef-retry
  - useEffect-deps
  - atrium
  - pr-review
severity: medium
date: 2026-06-30
source: auto — /review-pr
applicable_to: project
---

## What Happened

`VisibilityChip` fetches role options when the user opens the "group" visibility editor. The fetch was gated on `level === "group"` inside the effect body, and a `useRef` flag was set to `true` only on success (to keep the retry path open on failure). But a transient `listGrantOptionsAction` failure left the role dropdown permanently empty — even after the user navigated away and returned to the group editor.

## Root Cause

The `useRef` success-guard pattern is a correct retry primitive: set `loaded.current = true` only on success, so a failed attempt doesn't close the retry door. However, the effect only re-runs when its deps change. If `level === "group"` is checked inside the effect but `level` is not in the deps array, switching away from the group editor and back does not change any dep — the effect never re-fires, so the retry never happens.

## Solution

Add the load condition itself (`level === "group"` → `level`) to the effect deps array:

```typescript
useEffect(() => {
  if (level !== "group" || loaded.current) return;

  listGrantOptionsAction().then((opts) => {
    setOptions(opts);
    loaded.current = true;          // only set on success
  }).catch(() => {
    // loaded.current stays false → retry on next dep change
  });
}, [level]);   // ← level must be here, not just guarded inside
```

This way, when the user switches to a different visibility level and returns to "group", `level` transitions `"group" → "district" → "group"`, the effect re-fires, and the retry executes.

## Prevention

- Whenever a `useRef` init-guard is set success-only: verify the condition that gates the load is also a dep. If the condition is not a dep, the guard can never be retried after a failure.
- Rule: "success-guard is the lock; effect deps are the key to re-try the lock."
- File: `components/atrium/VisibilityChip.tsx`.
