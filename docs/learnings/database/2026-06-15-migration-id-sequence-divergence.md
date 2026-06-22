---
title: Backfill migrations preserve IDs but not sequences — parallel tables diverge on first INSERT
category: database
tags:
  - migration
  - id-sequence-divergence
  - drizzle
  - schema-drift
  - boot-sync
  - access-control
  - foreign-keys
  - compat-shim
severity: critical
date: 2026-06-15
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #1031 (issue #923, tools→capabilities rename) backfilled a new `capabilities` table by copying rows from the legacy `tools` table, preserving IDs. Compat shims then queried `capabilities.id` for lookups that involved FK columns (`navigation_items.tool_id`) still pointing at `tools.id`. Because the two tables have independent SERIAL sequences, IDs only match for pre-migration rows — the first new INSERT into either table causes the spaces to diverge, breaking navigation lookups and enabling an AA-slug-collision hijack of manifest rows.

## Root Cause

A `CREATE TABLE ... AS SELECT` or explicit INSERT backfill copies data values, but each table keeps its own sequence. `capabilities_id_seq` starts from `MAX(id)+1` based on the backfill, but so does `tools_id_seq`. Any post-migration insert to either table can produce the same integer via the other table's sequence, silently making `capabilities.id = N` point to a different row than `tools.id = N`.

## Solution

- FK columns that still reference the legacy table (`navigation_items.tool_id → tools.id`) must be resolved against `tools`, not the renamed successor, until the FK itself is migrated.
- Boot-time manifest sync must never touch `is_active` on existing rows; it should only own `name`, `description`, and `source`. Deactivated orphans should be demoted to `source='manual'` so a future re-add can reclaim ownership without silently reverting admin disables.
- Drizzle schema must mirror all SQL-defined constraints (UNIQUE, NOT NULL, CHECK, indexes) or `onConflictDoNothing` idempotency breaks and the schema drifts from reality.

## Prevention

- After any backfill that preserves IDs, reset the destination sequence with `SELECT setval('capabilities_id_seq', (SELECT MAX(id) FROM capabilities))` before opening the table for writes — and document which FK columns still point at the source table.
- Treat boot-time sync as append-only for ownership fields; never write `is_active`, `is_enabled`, or similar admin-controlled flags.
- Run a schema-drift check (compare Drizzle introspection vs. live DB constraints) as a CI step or post-migration gate.
