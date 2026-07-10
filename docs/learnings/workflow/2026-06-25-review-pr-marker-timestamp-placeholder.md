---
title: review-pr round marker must use real timestamp, never a placeholder
category: workflow
tags:
  - review-pr
  - incremental-review
  - timestamp-bug
  - marker-drift
  - nan-clamping
  - migration-idempotency
  - create-type
  - sqlstate-42710
  - atrium
severity: high
date: 2026-06-25
source: auto — /review-pr
applicable_to: project
---

## What Happened

Round 9 of PR #1061 (Atrium Phase 0) wrote its round-marker comment with a
placeholder timestamp of `2026-06-25T00:00:00Z` (midnight) instead of the
actual `date -u` output. The most recent Claude code review containing 4 real
findings had been posted at `2026-06-24T23:11Z` — before that midnight value.
Round 10's SINCE filter therefore treated all 4 findings as already-seen and
committed nothing, leaving HEAD stuck on the Round 8 commit.

## Root Cause

The `/review-pr` skill substituted a literal `00:00:00Z` placeholder into the
marker comment rather than running `date -u +%Y-%m-%dT%H:%M:%SZ` at write
time. Because same-day review comments land before midnight UTC, any
placeholder at or after midnight silently filters them out on the next run.

## Solution

Round 10 detected the drift by comparing the marker `created_at` to the
timestamp written inside the marker body. It then used the comment's actual
`created_at` as the SINCE lower-bound, re-verified all 4 findings against
current code (all still present), and fixed them:

- `Number.isFinite` guards before clamp operations (NaN → `LIMIT NaN` Postgres 500)
- `assertHumanAuthorId` ForbiddenError guard for missing author boundary
- Tightened slug LIKE: `= base OR LIKE base-%` (was over-fetching)
- Migration runner no-ops `CREATE TYPE` on SQLSTATE 42710 (already-exists) to
  prevent wedged re-runs

## Prevention

1. **Always substitute the real timestamp** — call `date -u +%Y-%m-%dT%H:%M:%SZ`
   at the moment the marker is written; never use a placeholder.
2. **Defensive SINCE calculation** — when reading the last round marker, compare
   its embedded timestamp to the comment's `created_at` and use the
   earlier/smaller of the two as the SINCE filter.
3. **Re-verify concrete findings** — never trust that a prior round addressed
   specific findings; grep/read the current code to confirm they are gone before
   treating them as resolved.
