---
title: Audit all sibling write paths when mapping postgres errors to typed HTTP errors
category: database
tags:
  - postgres-error-mapping
  - typed-errors
  - sqlstate
  - conflict-error
  - fk-validation
  - http-status-semantics
  - dompurify
  - xss
  - migration-audit-columns
  - drizzle
  - atrium
  - pr-review
  - sibling-path-asymmetry
severity: high
date: 2026-06-24
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #1061 (Atrium Phase 0, issue #1058) introduced a service layer that mapped some raw postgres errors to typed errors — `create()` caught SQLSTATE 23505 (unique violation) on slug collisions and threw `ConflictError`. However, a parallel `snapshotInTx` INSERT did not have the same catch, and `update()` never validated `collectionId` FK existence the way `create()` did via `collectionDefault`. The asymmetry caused unhandled 500s on races and bad FK values in `update()` paths.

## Root Cause

When error-mapping is added incrementally (one method at a time), the other write paths in the same service are frequently not audited for the same classes of failure. The absence is invisible in normal usage — it only surfaces under concurrent load or with invalid foreign keys.

## Solution

For any service layer that translates raw DB errors to typed errors, audit every sibling write method (`create`, `update`, `upsert`, bulk inserts) for the same SQLSTATE classes:

- **23505 unique violation** → 409 `ConflictError` (catch in the write, wrap and rethrow)
- **23503 FK violation** → 400 `ValidationError` (precheck existence before the write, or catch and rethrow)
- **22001 string length overflow** → 400 `ValidationError` (precheck against the varchar column limit before inserting)

Also fixed in the same review round:
- **HTTP status semantics**: never use a 2xx code (e.g., 202 Accepted) when constructing a thrown error object. A surface that maps `error.status` directly to the HTTP response will emit a success status on failure.
- **DOMPurify allowlist**: `../` path traversal was permitted in the sanitizer config — inert today, unsafe once Phase 1 renders snapshots inline.
- **Migration**: missing audit columns, index, and uniqueness constraint caught before merge.

## Prevention

- After writing the first DB-error-to-typed-error mapping in a service, immediately scan all other write methods in the same file for the same pattern.
- Code review checklist: if `create()` catches 23505, verify `update()` and any transactional helpers do too.
- Keep a reference of the postgres.js SQLSTATE → HTTP status mapping above and apply it consistently across the service boundary.
- When constructing error objects with a `.status` field, verify the code is a 4xx, never a 2xx.
