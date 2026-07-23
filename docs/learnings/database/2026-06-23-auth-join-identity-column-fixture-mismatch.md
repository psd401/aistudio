---
title: Auth guards join on exact identity column — fixtures must match; migration completed-marker must follow DDL
category: database
tags:
  - migration-safety
  - e2e-fixtures
  - cognito-sub
  - idempotent-ddl
  - seed-data
  - capability-access
  - silent-failure
  - postgres-constraints
severity: critical
date: 2026-06-23
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #1050 (tools→capabilities migration) had a P1 E2E failure: the Playwright auth harness minted session tokens with `sub='e2e-test-user'` but the seed inserted test users with `cognito_sub=NULL`. `hasCapabilityAccess()` joins directly on `users.cognito_sub` with no email fallback, so the join returned zero rows and every capability-gated route silently redirected. Tests showed 5/5 passing on the author's persistent local DB (which had a real prior login that populated `cognito_sub`) but would fail on any clean DB.

Three companion P2s compounded the risk: a SQL migration wrote its own `migration_log` row as `'completed'` before any DDL ran (permanently skipping the migration after a second partial failure); a `ADD CONSTRAINT` lacked a `DROP ... IF EXISTS` idempotency guard (PostgreSQL has no `ADD CONSTRAINT IF NOT EXISTS`); seeded nav items had `capability_id=NULL` which reads as ungated rather than flagging an error.

## Root Cause

- `hasCapabilityAccess()` and `resolveUserId()` are sibling helpers but are NOT symmetric — `resolveUserId` has an email fallback; `hasCapabilityAccess` does not. Fixtures that only set email and not `cognito_sub` pass `resolveUserId` but fail `hasCapabilityAccess`.
- Writing `INSERT INTO migration_log ... 'completed'` at the top of a migration script means a partial failure leaves the runner believing the migration succeeded; the skip-gate (`checkMigrationRun`) never reruns it.
- PostgreSQL `ALTER TABLE ADD CONSTRAINT` is not idempotent — re-running on an existing constraint throws, so migrations must use `DROP CONSTRAINT IF EXISTS` first.
- "Tests pass on my machine" masked by persistent local DB state from a real prior login.

## Solution

- E2E seed and Playwright fixture must explicitly set `cognito_sub` to match the `sub` claim in the minted JWT — not just email.
- Migration scripts must write the `migration_log` row AFTER all DDL succeeds (or inside the same transaction at the very end).
- FK/unique constraint additions must follow the pattern: `ALTER TABLE DROP CONSTRAINT IF EXISTS ...; ALTER TABLE ADD CONSTRAINT ...;`
- Seed data for gated nav items must set a non-NULL `capability_id`; a NULL reads as "ungated" and defeats the whole migration.

## Prevention

- Audit all auth/permission helpers for identity-column join paths and document which columns each one requires in the fixture setup guide.
- Add a linter rule or migration template that flags `INSERT INTO migration_log` appearing before the first DDL statement.
- Run E2E suite against a fresh `bun run db:reset && bun run db:seed` before merging migrations that touch auth or permission tables.
- For any `ADD CONSTRAINT`, require the `DROP ... IF EXISTS` guard as a code-review checklist item.
