---
title: updated_at trigger required in every PostgreSQL table migration
category: database
tags:
  - drizzle
  - migration
  - postgresql
  - schema
  - updated_at
  - trigger
severity: high
date: 2026-02-18
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #787 introduced new PostgreSQL tables with `updated_at` columns. Three independent reviewers (Gemini, Copilot, Claude) all flagged the same missing `update_updated_at_column()` trigger. Without the trigger, `updated_at` is permanently stale after the first write — a silent data integrity bug.

## Root Cause

Drizzle `defaultNow()` only executes at INSERT time. PostgreSQL has no automatic mechanism to update timestamp columns on UPDATE. The trigger must be attached explicitly in the migration SQL file.

## Solution

Every migration that creates a table with `updated_at` must include the trigger attachment after the `CREATE TABLE`:

```sql
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON your_table_name
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
```

The `update_updated_at_column()` function is already defined in early migrations (001–005) — it only needs to be attached per table.

## Prevention

- Treat missing `updated_at` trigger as a hard blocking review comment, not advisory
- Any Drizzle schema FK indexes added in schema files must have a matching `CREATE INDEX` in the corresponding SQL migration — omitting these causes schema drift between Drizzle's expected state and the live database
