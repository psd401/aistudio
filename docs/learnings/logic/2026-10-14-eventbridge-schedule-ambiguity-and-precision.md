---
title: EventBridge 6-field cron ambiguity and rate() read-back precision
category: logic
tags: [eventbridge, cron, scheduler, agent-schedules, date-math]
severity: high
date: 2026-10-14
source: auto — /work
applicable_to: project
---

## What Happened

Issue #1888 (PR #1914) hardened `lib/agent-schedules/validation.ts` and
`lib/agent-schedules/schedule-description.ts` after several silent
mis-scheduling bugs: a 6-field cron with a seconds field was accepted and
mangled, and the human-readable "next run" read-back over-claimed precision
and mis-projected `rate(...)` schedules.

## Root Cause

- A 6-field cron is ambiguous between EventBridge shape (`minute hour dom
  month dow YEAR`) and Quartz-style seconds-first (`sec min hour dom month
  dow`). The seconds value itself is NOT a reliable disambiguator — an
  earlier guard keyed on `fields[0] === "0"` let every nonzero-seconds
  expression through (`30 15 18 * * *` silently became 3:30pm on the 18th
  instead of being rejected). The actual signal: EventBridge requires `?` in
  exactly one of day-of-month/day-of-week, so a genuine EventBridge
  expression always carries one there; a seconds-first expression with an
  hour-sized 3rd field and a `*` year slot but `?` in neither day field is
  the ambiguous shape to reject. An explicit 4-digit year can never be
  seconds-first, so the check only fires when the year slot is `*`.
- EventBridge Scheduler fires every schedule type with only 60-second
  precision (fires anywhere in `:00`–`:59` of the target minute) — a
  read-back reporting second-level fire times over-claims accuracy.
- A `rate(...)` schedule with no `StartDate` is anchored at
  create/update time, not read time; `anchor + k * interval` must use the
  record's `updatedAt`, not "now," or projected next-runs drift by up to a
  full interval.
- `Intl.DateTimeFormat.formatToParts` throws `RangeError` for timestamps
  outside the representable `Date` range. `validation.ts` only bounds
  `rate(...)` from below (rejects faster than 5 minutes), not from above, so
  a stored `rate(100000000 days)` can produce an out-of-range projected
  timestamp and crash a helper that a `list()` maps over every record —
  turning one bad row into a full-list failure.

## Solution

- See `validateCronFieldDomains` / `validateEventBridgeSixthFieldIsYear` in
  `lib/agent-schedules/validation.ts` for the `?`-based disambiguation logic
  and its documented history of false positives/negatives.
- See `lib/agent-schedules/schedule-description.ts` for: `rate(...)`
  anchoring on `updatedAt`, the explicit bounds check before calling
  `formatToParts` (module contract: "never throws and never guesses"), and
  omission of seconds in formatted output.

## Prevention

- When validating or formatting EventBridge cron/rate expressions, never
  trust a single field in isolation (e.g. "seconds == 0") as a shape
  discriminator — use the full set of EventBridge's own structural
  constraints (the `?` requirement) to detect ambiguous/foreign formats.
- Any helper that formats a derived/projected timestamp must bound its input
  before calling `Intl`/`Date` APIs, even if validation elsewhere seems to
  guarantee reasonable values — upstream bounds can be one-sided.
- Read-backs of EventBridge Scheduler state should round to the documented
  60-second precision and anchor `rate(...)` projections on the stored
  `updatedAt`.
