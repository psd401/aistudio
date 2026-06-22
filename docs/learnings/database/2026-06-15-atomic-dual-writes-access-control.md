---
title: Security-relevant dual-writes must be atomic — non-atomic writes diverge under ECS rolling deploys
category: database
tags:
  - lfg
  - autonomous
  - capabilities
  - drizzle
  - transactions
  - idempotency
  - access-control
  - assistant-architect
  - issue-923
  - epic-922
severity: critical
date: 2026-06-15
source: auto — /lfg
applicable_to: project
---

## What Happened

Issue #923 renamed `tools` → `capabilities` (+ `role_capabilities`) and introduced a dual-write path in the Assistant Architect approve/update/delete flows that hit both tables. Two sequential `executeQuery` calls were used instead of a single `executeTransaction`. Under ECS rolling deploys a container can be SIGTERMed between any two awaits — a near-certain divergence over enough deploys. Result: `capabilities` remained active while the `tools` row was deactivated/deleted, leaving a lingering access grant. `hasToolAccess` reads `capabilities`, so the orphaned row granted access indefinitely.

## Root Cause

- `executeQuery` calls are independent DB round-trips with no atomicity guarantee.
- ECS SIGTERM can interrupt between any two awaits at the OS level — no application-level guard prevents this.
- `onConflictDoNothing` on the capabilities insert silently no-ops a re-approve after an edit, because the row already exists but is `is_active=false`. The capability is never re-activated.

## Solution

- Wrapped all AA approve/update/delete dual-writes in `executeTransaction` so both tables update atomically or not at all.
- Switched `onConflictDoNothing` → `onConflictDoUpdate` (updating `is_active`, `updatedAt`) on the capabilities insert so re-approve after deactivation works correctly.
- Added change-detection in the manifest boot sync to skip UPDATE when no fields changed, preventing `updatedAt` churn on every restart.

## Prevention

- Any write that feeds a security-relevant read path (access checks, role grants, capability flags) must use `executeTransaction` if it touches more than one table.
- Never use `onConflictDoNothing` for rows that participate in an entity's activate/deactivate lifecycle — use `onConflictDoUpdate` with the fields that must be refreshed.
- In `CLAUDE.md` silent failure patterns: "Don't dual-write access-control tables in separate `executeQuery` calls — use `executeTransaction`."
