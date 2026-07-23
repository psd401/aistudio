---
title: Auth check order in server actions — requester resolution must precede capability check
category: security
tags:
  - auth
  - 401-vs-403
  - capability-check
  - server-actions
  - concurrency
  - optimistic-lock
  - atrium
  - code-review
severity: high
date: 2026-06-25
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #1061 (Atrium Phase 0 content API) had server actions that called `hasCapabilityAccess()` before resolving the requester via `getServerSession()`. When an unauthenticated request arrived, `hasCapabilityAccess()` returned `false` and the action returned a 403 "access denied" response — instead of a 401 "please log in". Clients that redirect-to-login on 401 silently broke.

## Root Cause

`hasCapabilityAccess()` returns `false` for any session it cannot resolve, including no session at all. It does not throw. The requester-resolution path (`requireRequester()` / `getServerSession()`) throws `authNoSession` → 401 when there is no session. Putting the capability check first short-circuits before the throw can happen.

## Solution

Always resolve the requester first, then check capabilities:

```typescript
// WRONG — unauthenticated caller gets 403 "access denied"
if (!hasCapabilityAccess(session, "atrium:write")) return forbidden();
const requester = await requireRequester(); // never reached for anon

// CORRECT — unauthenticated caller gets 401 "please log in"
const requester = await requireRequester(); // throws authNoSession → 401
if (!hasCapabilityAccess(requester.session, "atrium:write")) return forbidden();
```

Bonus: resolving the requester first eliminates a duplicate `getServerSession()` + `getUserRoles()` pair because `hasCapabilityAccess` re-resolves both internally when given the session object.

## Prevention

- In any server action: requester/session resolution (`requireRequester`, `getServerSession`) MUST be the first auth step.
- Capability and scope checks always come after a confirmed, resolved session.
- Review `docs/architecture/capabilities-and-scopes.md` — auth ordering is a variant of the "don't gate API endpoints with `hasCapabilityAccess()`" anti-pattern documented there.
