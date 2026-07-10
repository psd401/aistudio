---
title: Combined authorization guard collapses 404-masks-existence into an information leak
category: security
tags:
  - authorization
  - information-disclosure
  - 404-masks-existence
  - atrium
  - server-actions
  - access-control
  - idor
severity: high
date: 2026-06-29
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #1081 (Atrium Phase 3) `snapshot-document.ts` line 86 combined two distinct authorization checks into one boolean guard:

```typescript
if (!viewable || !canEdit(session, doc)) throw new ForbiddenError(...)
```

When the object is non-viewable (i.e., does not exist from the caller's perspective), the code threw `ForbiddenError` (403) instead of `NotFoundError` (404). This leaked that the UUID exists — violating the 404-masks-existence convention enforced in `setVisibilityAction`, `getVisibilityAction`, and `publishService.publish`.

## Root Cause

Two semantically different failures — "object not visible to caller" vs. "object visible but caller lacks edit rights" — were collapsed into a single `||` guard with one error type. The `||` short-circuits on the first falsy value, but the same error is thrown regardless of which branch failed, and `ForbiddenError` (403) is the less-safe choice.

## Solution

Split into sequential guards, using the least-revealing error for each:

```typescript
if (!viewable) throw new NotFoundError(...)         // 404 — mask existence
if (!canEdit(session, doc)) throw new ForbiddenError(...)  // 403 — object exists, no edit rights
```

Added 4 unit tests (`tests/unit/atrium-snapshot-document-action.test.ts`) asserting that a non-viewable object short-circuits at `canView`, the edit gate never runs, the snapshot is never called, and the action returns `isSuccess: false`.

## Prevention

- **Order matters**: visibility check (404) MUST come before permission check (403). Never combine them in a single `||` guard.
- **The smell**: `if (!a || !b) throw SingleError` where `a` and `b` represent different authorization levels — this is the pattern to catch in review.
- **Audit sibling actions**: when one action is fixed, check all sibling actions in the same feature area implement the same order (existence/visibility → permission).
- **Convention reference**: `setVisibilityAction`, `getVisibilityAction`, `publishService.publish` (§12.4) all implement 404-masks-existence — use them as canonical examples.
