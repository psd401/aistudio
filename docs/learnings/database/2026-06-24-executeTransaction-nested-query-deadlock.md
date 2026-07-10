---
title: Calling executeQuery/executeTransaction helpers inside an executeTransaction callback causes connection-pool deadlock
category: database
tags:
  - drizzle
  - connection-pool
  - deadlock
  - executeTransaction
  - atrium
  - pr-review
severity: critical
date: 2026-06-24
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #1061 (Atrium Phase 0) called `canView()` — a visibility helper that internally issues its own `executeQuery` — from inside an `executeTransaction` callback. Under concurrency this deadlocks: the outer transaction holds a pooled connection while the inner `canView()` waits for a second pooled connection that may never become available, blocking every pool slot in a cycle.

## Root Cause

`executeQuery` and `executeTransaction` each acquire a connection from the pool. Nesting them means one connection is held open (by the outer transaction) while a second is requested from the same pool. Under load (pool exhaustion), the second request waits indefinitely, and the first connection never releases — a classic deadlock.

## Solution

Hoist all reads and permission checks that issue their own queries to **before** the `executeTransaction` call. Pass the pre-fetched values into the callback as closed-over locals. The transaction then contains only the writes it needs.

```typescript
// WRONG — canView() calls executeQuery internally
await executeTransaction(async (tx) => {
  if (!await canView(itemId, userId)) throw new Error("forbidden");
  await tx.update(items).set(data).where(eq(items.id, itemId));
}, "updateItem");

// CORRECT — hoist the read before the transaction
const allowed = await canView(itemId, userId);
if (!allowed) throw new Error("forbidden");
await executeTransaction(async (tx) => {
  await tx.update(items).set(data).where(eq(items.id, itemId));
}, "updateItem");
```

## Prevention

- Any helper whose name implies a lookup (`canView`, `getUser`, `findBy*`, `load*`) likely calls `executeQuery` internally. **Never call these from inside an `executeTransaction` callback.**
- If a helper must run inside the transaction boundary, it must accept a `tx` parameter and use that instead of acquiring its own connection.
- The CLAUDE.md silent-failure list already covers this: "Don't nest `db.transaction()` inside `executeQuery()`" — extend that rule to cover all helpers that wrap `executeQuery`.
