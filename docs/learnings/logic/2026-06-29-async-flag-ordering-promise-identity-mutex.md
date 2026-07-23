---
title: "Set done-flags AFTER side effects succeed; store chained promises for identity checks"
category: logic
tags:
  - websocket
  - yjs
  - crdt
  - toctou
  - silent-failure
  - dompurify
  - sanitization
  - async-mutex
  - promise-identity
  - redis-pubsub
  - pr-review
severity: high
date: 2026-06-29
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #1062 (Atrium Phase 1 Yjs collab) had two distinct async logic bugs caught in round 8 review:

1. **Flag-ordering TOCTOU**: `applied = true` was set before `applyEdit()` ran. When `applyEdit()` threw due to an `InvalidStateError` (WebSocket transitioning OPEN→CLOSING), the exception was caught and logged — but the close handler later checked `applied` and saw `true`, resolved the promise, and returned HTTP 200. The edit was dropped silently.

2. **Promise-identity mutex bug**: A mutex map used `map.get(k) === prior.then(() => next)` to check if the chain was still current before cleaning up. But `x.then(f)` creates a new Promise object on every call, so the identity check always fails, leaving every key in the map permanently and causing unbounded growth.

## Root Cause

1. Treating a flag assignment as a "reservation" when it should be a "confirmation" — setting `applied = true` before the operation that actually applies the edit means any later cleanup path reads a false positive.

2. Assuming `promise.then(fn)` is referentially stable. It is not — each call returns a fresh object, so capturing `.then(f)` in a variable and comparing it later against another `.then(f)` call on the same base will never match.

## Solution

1. Set the flag only after the side effect fully succeeds:
```typescript
// WRONG
applied = true;
await applyEdit(edit);   // if this throws, close handler still sees applied=true

// CORRECT
await applyEdit(edit);
applied = true;          // only set on confirmed success
```

2. Store the chained promise in a single variable for identity comparison:
```typescript
// WRONG — two separate .then() calls, two different objects
map.set(k, prior.then(() => next));
if (map.get(k) === prior.then(() => next)) map.delete(k);  // never true

// CORRECT — one variable, same object
const chained = prior.then(() => next);
map.set(k, chained);
chained.then(() => {
  if (map.get(k) === chained) map.delete(k);
});
```

## Prevention

- In any try/catch pattern around async side effects, keep flag assignment inside the success path, not before the `await`.
- For mutex/dedup maps, always capture the chained promise before storing it, and use that same reference for the cleanup identity check. See also: [[dek-cache-promise-reference-clobber]] for a related in-flight cleanup pattern.
- Code review checklist for async event handlers: confirm flag writes are on the success side of the operation, not before it.
