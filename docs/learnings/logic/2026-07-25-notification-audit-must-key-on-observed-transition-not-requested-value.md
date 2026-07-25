---
title: Notifications/audit keyed on the requested value flood the feed with events that never happened
category: logic
tags:
  - audit-log
  - notifications
  - concurrency
  - atrium
severity: medium
date: 2026-07-25
source: auto — /work #1336 (PR #1339)
applicable_to: project
---

## What Happened

Related to the `widenOnly` locked-transaction pattern (see
`database/2026-07-25-widen-only-offer-decided-inside-locked-transaction.md`): a
notification/audit-log write fired based on the value the client requested, even
when the server's locked write determined no actual transition occurred (e.g. the
row was already at or beyond the requested visibility).

## Root Cause

The event source was "what was requested," not "what the database actually did."
Once the write logic can no-op (as in a widen-only offer), any consumer keyed on
the request rather than the outcome logs phantom events.

## Solution

Have the locked write return whether it actually transitioned the row (e.g.
`{ changed: boolean, from, to }`), and gate notification/audit writes on that
return value, not on the incoming request payload.

## Prevention

- Whenever a write can be a conditional no-op, downstream side effects (audit,
  notifications, cache invalidation) must consume the write's actual result, not
  re-derive "what should have happened" from the request.
