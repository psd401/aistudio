---
title: A client's pre-submit re-read is not a lock — re-decide against the FOR-UPDATE-locked row
category: database
tags:
  - concurrency
  - transactions
  - visibility
  - race-condition
  - atrium
severity: high
date: 2026-07-25
source: auto — /work #1336 (PR #1339)
applicable_to: project
---

## What Happened

A client re-read the current visibility level before submitting a change, to
avoid narrowing a value another user had concurrently widened. That re-read is
still just a stale snapshot by the time the write executes — it doesn't prevent
a race, only narrows the window.

## Root Cause

Client-side re-reads happen outside any lock; the value can change again between
the re-read and the server write. Correctness that depends on "the current value"
must be evaluated where the value is actually locked.

## Solution

Send the client's intent as a `widenOnly` flag (an offer, not a command) rather
than an absolute value. The server applies it only if it genuinely widens
visibility, decided inside the transaction against the row locked with
`SELECT ... FOR UPDATE`. A stale client snapshot can then never narrow a
concurrently-widened object — the worst case is a no-op, not data loss.

## Prevention

- See also `database/2026-02-19-select-for-update-read-only-phases.md` (locks are
  useless once the transaction that holds them commits) and
  `security/2026-07-01-idempotency-check-toctou-before-for-update.md` (authz must
  be evaluated inside the tx against the locked row) — same family of bug: a
  client-side or pre-lock check is not a substitute for deciding inside the lock.
- Model client input that could race as an "offer" (`widenOnly`, `ifUnchanged`,
  etc.) that the server conditionally applies, not as an absolute value it blindly
  writes.
