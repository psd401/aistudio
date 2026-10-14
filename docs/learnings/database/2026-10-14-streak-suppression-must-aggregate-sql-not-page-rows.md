---
title: Reading "already handled?" from a fixed page of rows gives suppression that expires once the streak outgrows the page
category: database
tags: [agent-schedules, sql, aggregation, pagination, idempotency]
severity: high
date: 2026-10-14
source: auto — /work #1890 (PR #1925)
applicable_to: project
---

## What Happened

Issue #1890's failure-streak check read the `owner_notified_at` suppression
stamp from the newest 12 `agent_scheduled_runs` rows for a schedule. Once a
streak outgrew the page size, the stamped row scrolled off the end: a
schedule notified on failure 3 looked unnotified again by failure 15, and
re-messaged the owner — roughly hourly on a five-minute schedule. Caught by
Codex before merge.

## Root Cause

"Has this incident already been handled?" was answered by paging rows into
the application and scanning the page, instead of aggregating the full
streak in the database. Suppression correctness was accidentally coupled to
an unrelated constant (page size) that had been chosen for a UI listing, not
for streak math. A second, related issue: the row budget was being spent
across ALL statuses, so rows that decide nothing for the streak (`skipped`,
`promoted`) diluted the page and shortened the effective lookback even
further.

## Solution

- Replaced the paged read with one SQL statement that aggregates the whole
  streak server-side: `BOOL_OR(owner_notified_at IS NOT NULL)` bounded by the
  newest `success` row (i.e. only over rows newer than the last success),
  with no `LIMIT`.
- Filter out non-deciding statuses (`skipped`, `promoted`) in the query
  itself, not after fetching.

## Prevention

- Any "has this already happened within the current streak/incident" check
  must be answered by an aggregate query bounded by the actual incident
  boundary (e.g. "since last success"), never by a fixed-size page of recent
  rows — the incident can outlive the page.
- When a row-count limit exists for a different reason (pagination, UI
  display), don't reuse it as an implicit bound for a correctness check;
  filter deciding vs non-deciding rows at the query level before any count
  or limit is applied.
