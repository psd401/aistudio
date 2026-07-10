---
title: Existence leak via 403-before-404 and db-init splitter is safe for CREATE TRIGGER
category: security
tags:
  - atrium
  - migrations
  - postgres-triggers
  - existence-leak
  - authorization
  - drizzle
  - db-init-splitter
  - idor
severity: high
date: 2026-06-24
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #1061 (Atrium Phase 0 content API) had two related findings in round-3 review:

1. `versionService.rollback` called `assertCanEdit` (throws 403) before checking visibility, leaking object existence to unauthorized callers — a classic IDOR pattern.
2. `updated_at` columns in new Atrium tables lacked PostgreSQL triggers, violating CLAUDE.md conventions. The stated reason was "the db-init splitter can't handle triggers" — which turned out to be false.

## Root Cause

**Existence leak**: Any service path that reaches a permission check (403) before a visibility check (404) reveals that the object exists to an unauthorized caller. The correct order is: assert viewable → assert editable.

**Splitter myth**: The db-init handler (`infra/database/lambda/db-init-handler.ts splitSqlStatements`) only chokes on dollar-quoted blocks (`DO $$ ... $$`) and inline PL/pgSQL function bodies. A single-statement `CREATE TRIGGER` that calls a pre-existing function (e.g. `update_updated_at_column` from migration 017) contains no dollar-quoting and splits cleanly.

## Solution

**Existence leak fix**: Mirror the `createVersion`/`update` pattern — call `visibilityService.canView` (or `assertViewable`) before any `assertCanEdit` call in every edit/rollback path.

**Trigger fix**: Use the migration-028 Nexus pattern — idempotent and splitter-safe:

```sql
DROP TRIGGER IF EXISTS set_updated_at ON your_table_name;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON your_table_name
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
```

This works because `update_updated_at_column()` already exists (migration 017) and no dollar-quoting is introduced.

## Prevention

- In any service method that touches a resource by ID: **404 before 403** — visibility check always precedes permission check.
- "The splitter can't handle triggers" is a false constraint. Triggers are valid as long as: (a) the backing function pre-exists, and (b) no `DO $$` / dollar-quoting is used in the migration.
- See existing learning [[updated-at-trigger-required]] for the trigger requirement itself.
