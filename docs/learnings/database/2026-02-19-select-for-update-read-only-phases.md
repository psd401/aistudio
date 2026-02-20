---
title: SELECT FOR UPDATE provides zero value for read-only transaction phases
category: database
tags:
  - concurrency
  - transactions
  - row-locks
  - mcp
  - oauth
  - access-control
  - drizzle
severity: high
date: 2026-02-19
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #790 (MCP connector service) went through 8 review rounds, each round adding/removing a `SELECT FOR UPDATE` row lock for a database read operation. The lock was intended to solve a race condition between reading access state and writing it, but each fix created new issues: the read phase would commit the transaction before the critical write section, rendering the lock worthless. This pattern repeated until the lock was removed entirely.

## Root Cause

Misunderstanding of transaction phases in a three-part operation: read-network-write. The developer added `SELECT FOR UPDATE` to the read phase to prevent "someone else changing the row between read and write." However:

1. **The read phase is read-only** — it only queries current state. It cannot race against itself.
2. **The transaction is split into three sequential phases**: (1) read current `updated_at` from DB, (2) make HTTP call to external service (MCP), (3) write back with WHERE clause `updated_at = <value from phase 1>`.
3. **SELECT FOR UPDATE locks are released when the transaction commits** — if phase 1 commits before phase 3, the lock is gone, providing zero protection for phase 3.

The actual concurrency guard is the **optimistic write** in phase 3: the WHERE clause `updated_at = previous_value` fails if another process changed the row, preventing silent data loss.

## Solution

**For read-only transaction phases**: Do NOT add SELECT FOR UPDATE.

**For optimistic concurrency in the write phase**: Use WHERE clause on `updated_at` or a similar "version" column:

```typescript
// Read phase (no lock needed — it's read-only)
const currentState = await executeQuery(
  (db) => db.select().from(mcp_connectors)
    .where(eq(mcp_connectors.id, id)),
  "readConnectorState"
)
const previousUpdatedAt = currentState[0].updated_at

// Network phase (not in a transaction)
const result = await httpCall()

// Write phase (optimistic concurrency guard via WHERE updated_at)
const updated = await executeQuery(
  (db) => db.update(mcp_connectors)
    .set({ /* new values */ })
    .where(
      and(
        eq(mcp_connectors.id, id),
        eq(mcp_connectors.updated_at, previousUpdatedAt)  // <-- concurrency guard
      )
    )
    .returning(),
  "updateConnectorState"
)

if (updated.length === 0) {
  throw new Error("Concurrent modification — row was changed by another process")
}
```

This pattern is safe because:
- Phase 2 (HTTP call) is outside the transaction, so no connection is held open
- Phase 3's WHERE clause atomically checks both the ID and the version before updating
- If another process wins the race, the update affects 0 rows, triggering the error handler

## Prevention

- **Never add SELECT FOR UPDATE to phases that commit before the critical section** — the lock is automatically released, defeating its purpose
- **Use optimistic concurrency** (WHERE on version/timestamp columns) for multi-phase operations
- **Keep transactions short** — read state, release the transaction, then do network work, then acquire a new transaction for the write
- **Review PR: understand the full transaction lifecycle** — does the lock persist through all phases that need it? If not, it's noise
