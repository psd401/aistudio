---
title: "In-flight promise .finally cleanup must capture its own reference to avoid clobbering newer fetches"
category: security
tags:
  - dek-cache
  - thundering-herd
  - promise-reference
  - concurrency
  - aes-gcm
  - hkdf
severity: high
date: 2026-02-18
source: auto — /work
applicable_to: project
---

## What Happened

An AES-256-GCM token encryption module used a shared `inFlight` variable to coalesce concurrent DEK fetches (thundering-herd prevention). The `.finally()` cleanup unconditionally set `inFlight = null`. After cache invalidation triggered a new fetch, a completing stale promise would clear the newer in-flight, causing post-invalidation callers to spin up duplicate fetches and ultimately repopulate the cache with a stale result.

## Root Cause

The `.finally` callback closed over the shared `inFlight` variable, not the specific promise it was cleaning up. When invalidation set `inFlight = null` and a new fetch set it to a fresh promise, the old promise's `.finally` fired and reset `inFlight` again — clobbering the new in-flight.

## Solution

Capture the promise in a local constant before assigning to the shared variable, then gate the cleanup on reference identity:

```typescript
const fetch = fetchDEK();
inFlight = fetch;
fetch.finally(() => {
  if (inFlight === fetch) inFlight = null;   // only clear if still ours
});
```

Also introduced a generation counter incremented on each invalidation. When the in-flight resolves, it checks its captured generation against the current one before writing to cache — prevents a stale result from repopulating after invalidation.

## Prevention

- Any shared in-flight promise pattern: always capture the promise reference locally before `.finally`
- Add a generation/epoch counter when cache invalidation must take immediate effect
- Unit test: simulate invalidation mid-flight and assert the new fetch is not cleared
