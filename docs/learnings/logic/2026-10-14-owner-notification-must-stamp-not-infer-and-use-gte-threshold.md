---
title: "One notification per incident" must record that it notified, not infer it from streak length
category: logic
tags: [agent-schedules, notifications, idempotency, threshold]
severity: high
date: 2026-10-14
source: auto — /work #1890 (PR #1925)
applicable_to: project
---

## What Happened

Issue #1890 added an owner Chat DM when a scheduled agent job keeps failing
(3 consecutive failures, or the first expired/revoked Google grant). The
first implementation fired when the failure streak reached *exactly* three
and relied on that single-point match to stay quiet afterward — stateless,
no new column.

## Root Cause

- A schedule already failing when the code shipped had a streak longer than
  3 on its very next run, so `=== 3` never matched and the owner was never
  told — skipping exactly the population the issue was opened for.
- A DM that failed to *send* still counted as "the one that spoke" under a
  stateless exact-match rule, so a transient Aurora/Chat blip on the
  threshold run silenced the schedule permanently with no further attempt.

Two independent reviewers caught this before merge.

## Solution

- Added `agent_scheduled_runs.owner_notified_at` (migration 188) and changed
  the trigger to `streak >= 3 AND owner_notified_at IS NULL`.
- Stamp `owner_notified_at` only AFTER the Chat send is accepted, never
  before send — stamping first trades the "never notified" bug for a
  quieter version of the same bug (one real failure to send = permanent
  silence); stamping after risks at most one harmless repeat DM.

## Prevention

- Any "notify once per incident" rule needs a durable "I already told them"
  fact (a timestamp/flag), not a derived condition recomputed from current
  state (streak count, elapsed time) — derived conditions can't distinguish
  "already handled" from "just now crossed the threshold while already past
  it," and can't distinguish "notification sent" from "notification
  attempted."
- Use `>=` not `===` for threshold triggers on any counter that can start
  above the threshold (pre-existing incidents, backfills, deploys mid-streak).
- Stamp the "handled" fact after the side effect is confirmed, not before.
