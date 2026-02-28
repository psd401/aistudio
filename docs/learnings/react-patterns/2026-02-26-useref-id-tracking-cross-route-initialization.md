---
title: Use ID-tracking useRef instead of boolean flag for cross-route initialization guards
category: react-patterns
tags:
  - use-ref
  - next-js-app-router
  - race-condition
  - initialization-guard
  - component-reuse
severity: high
date: 2026-02-26
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #815 fixed a race condition in `useModelsWithPersistence`. The hook used a boolean `useRef` to guard initialization, but in Next.js App Router, component instances can be reused across route changes (e.g. `/prompt-library/1` → `/prompt-library/2`). The boolean ref persisted across navigations, blocking re-initialization for new routes. A separate reset effect was added to clear it, creating a fragile two-effect pattern.

## Root Cause

`useRef(false)` only tracks whether initialization has run — not *which* resource was initialized. When the same component instance serves a new route param, the ref stays `true` from the previous route, and the init effect skips. A reset effect (`ref.current = false`) is required but runs asynchronously, creating a race window.

## Solution

Store the last-initialized ID in the ref instead of a boolean:

```typescript
// Fragile — requires a separate reset effect
const initializedRef = useRef(false)

useEffect(() => {
  initializedRef.current = false
}, [resourceId])

useEffect(() => {
  if (initializedRef.current) return
  initializedRef.current = true
  // ... init
}, [resourceId])

// Robust — single effect, no reset needed
const initializedForRef = useRef<string | null>(null)

useEffect(() => {
  if (initializedForRef.current === resourceId) return
  initializedForRef.current = resourceId
  // ... init
}, [resourceId])
```

## Prevention

- When writing initialization guards in hooks that may be used on parameterized routes, always use ID-tracking refs (`useRef<string|null>(null)`) rather than boolean flags.
- If you see a reset effect paired with a boolean init ref, treat it as a smell — collapse into a single ID-tracking ref.
