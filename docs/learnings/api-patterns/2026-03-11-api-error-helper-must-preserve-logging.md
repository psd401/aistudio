---
title: API error helpers handle response shape only — logging stays in catch block
category: api-patterns
tags:
  - error-handling
  - logging
  - api-routes
  - cloudwatch
  - jit-provisioning
  - read-vs-write
severity: high
date: 2026-03-11
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #840 introduced `lib/api/execution-result-error.ts` to map `ErrorCode` to correct HTTP status codes (fixing `handleError()` misuse in API routes — it returns `ActionState` shape, not `NextResponse`, so always produced HTTP 500). When callers were refactored to use `executionResultErrorResponse()`, all `log.error()` calls in the catch blocks were silently dropped.

## Root Cause

Two separate concerns were conflated during extraction: (1) HTTP status code mapping and (2) error logging. The helper correctly owns HTTP mapping but has no access to the route's logger context (`requestId`, `action`). Moving the entire catch body into the helper stripped CloudWatch visibility.

## Solution

Keep `log.error(error, "message", { requestId })` in the route handler's catch block. Call the helper only for building the response:

```typescript
} catch (error) {
  log.error(error, "Action failed", { requestId })   // stays here
  return executionResultErrorResponse(error)          // only this goes to helper
}
```

## Prevention

- When extracting a response-shaping helper, treat `log.error()` as non-movable — it requires the caller's logger instance and request context.
- Audit every catch block after refactoring: confirm a `log.error()` or equivalent is still present.
- Separate concerns explicitly: logging = route handler, HTTP status mapping = helper.

## Bonus: GET routes must not provision users

`resolveUserId()` provisions a new user on first call — correct for write routes, wrong for read-only GET routes. A GET that calls `resolveUserId()` creates accounts on every unauthenticated or first-time read. Use a fast-path lookup (`getUserIdByCognitoSub`) with a graceful `null` fallback (e.g., `hasVoted: false`) instead.
