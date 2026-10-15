---
title: A time-based window makes a per-entity rule depend on that entity's cadence — bound by events, not elapsed days
category: database
tags: [agent-schedules, sql, scheduling, windowing, cadence]
severity: high
date: 2026-10-14
source: auto — /lfg #1890 (PR #1925)
applicable_to: project
---

## What Happened

Both readers of a schedule's consecutive-failure streak (#1890) bounded their
history at `created_at > NOW() - 90 days`, to keep the scan cheap for a
five-minute schedule that had been failing for a long time.

Schedule validation sets no maximum interval: `rate(100 days)` and an annual
cron are both legal. For any schedule slower than the window, every earlier
failure was already outside it by the time the next run happened. Its streak
was permanently 1, so it could never reach the `failing` threshold and its
owner could never be told — in a feature whose entire purpose is to stop
standing jobs failing silently. The slower the schedule, the more completely
the feature failed it.

## Root Cause

The bound was expressed in a unit the rule does not operate in. The rule
counts *consecutive runs*; the window counted *days*. Those two agree only
for schedules that fire often relative to the window, and nothing in the
system constrains frequency to that range.

The cost concern that motivated the window was real, but it is a concern
about rows scanned — which is also not days.

## Solution

Bound by a number of **that entity's own events** instead:

- `FAILURE_STREAK_SQL` orders by recency and takes the newest N
  streak-deciding rows;
- `consecutiveFailuresBySchedule` ranks per schedule with `ROW_NUMBER()
  OVER (PARTITION BY schedule_id ORDER BY created_at DESC, id DESC)` and keeps
  each schedule's newest N, so one owner's chatty schedule cannot consume
  another's budget.

An event bound behaves identically at five minutes and at a year, and still
bounds the scan: with a `(user_id, schedule_id, created_at DESC)` index it is
an ordered range that stops at the limit.

## Prevention

- When bounding a query that backs a per-entity rule, ask what unit the RULE
  counts in and bound in that unit. If the rule counts occurrences, bound by
  occurrences.
- Before choosing a time window, ask what the slowest legal entity looks like.
  If validation permits an interval longer than the window, the window is a
  correctness bug for that entity, not a performance tuning knob.
- Any bound still truncates something. State the consequence in the comment
  and check it is acceptable at BOTH extremes of the legal range — here, a
  streak past the bound loses sight of its own suppression stamp, which costs
  a five-minute schedule a repeat message after ~2 days of total failure and a
  yearly schedule nothing for centuries.
- Report a bounded count as a floor ("at least N") rather than a total, so a
  saturated value is not a number the reader can check and find wrong.

## Related

- [[streak-suppression-must-aggregate-sql-not-page-rows]] — the same rule's
  earlier bug, where the bound was a fixed page of rows read into the app.
- [[test-the-sql-results-not-hand-built-history-or-substrings]] — why this was
  caught by review rather than by a test, and what now covers it.
