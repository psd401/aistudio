---
title: useEffect stale-cancel flag must be a ref object when passed into async callbacks, not a primitive
category: react-patterns
tags:
  - useEffect
  - stale-closure
  - async
  - cancelled-flag
  - useRef
  - React
severity: high
date: 2026-06-29
source: auto — /work
applicable_to: project
---

## What Happened

Atrium Phase 2 artifact loader used a `let cancelled = false` primitive inside a `useEffect` with an `idOrSlug` dependency. The async fetch passed a callback to an inner async function. Rapid slug changes caused stale state writes because the callback captured the initial `false` at the time it was created — by the time the callback read `cancelled`, the effect had re-run and flipped the variable, but the closure still held the old binding.

## Root Cause

`let cancelled = false` creates a new binding on each effect invocation. A callback created during that invocation closes over that specific binding. If the async callback is passed as a parameter into another function (rather than defined inline in the effect), that function holds a reference to the original closure — it cannot see the mutation from a later cleanup run.

A primitive variable cannot be mutated through a closure boundary when it's been passed by value into a nested function.

## Solution

Use a ref object so all closures share the same reference:

```typescript
useEffect(() => {
  const cancelledRef = { current: false };

  async function loadArtifact(slug: string, cancelled: { current: boolean }) {
    const data = await fetchArtifact(slug);
    if (cancelled.current) return; // reads the live value
    setState(data);
  }

  loadArtifact(idOrSlug, cancelledRef);

  return () => {
    cancelledRef.current = true;
  };
}, [idOrSlug]);
```

The callback receives the object reference, and `.current` is read after the `await` — at which point the cleanup may have set it to `true`.

## Prevention

Any async callback passed as a parameter (rather than defined inline) that needs to check a cancellation flag must receive a ref object, not a boolean. A primitive passed by value into a function is frozen at call time. See also `2026-03-11-polling-then-survives-cleartimeout.md` for the complementary inline-closure case.
