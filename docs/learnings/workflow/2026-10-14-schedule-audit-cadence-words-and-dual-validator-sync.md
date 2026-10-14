---
title: Schedule name heuristics must not infer cadence from time-of-day words; TS/JS validators are intentionally duplicated
category: workflow
tags: [agent-schedules, audit, validation, duplication, eventbridge]
severity: medium
date: 2026-10-14
source: auto — /work
applicable_to: project
---

## What Happened

Issue #1888 (PR #1914) touched both the read-only schedule audit
(`lib/agent-schedules/schedule-audit.ts`, `scripts/audit-agent-schedules.ts`)
and a second, independent cron validator shipped inside the agent container
image (`infra/agent-image/skills/psd-schedules/common.js`).

## Root Cause

- The audit's cadence-mismatch check originally risked flagging a schedule
  name like "Monthly morning report" (on `cron(0 9 1 * ? *)`, a correct
  monthly 9am job) as suspicious, because the word "morning" matches a
  daily-cadence pattern. Time-of-day words ("morning", "evening", "nightly")
  say nothing about frequency — only an explicit cadence word ("monthly",
  "quarterly", "yearly") should suppress the daily/weekday mismatch warning.
  Getting this wrong means a read-only audit hands out a corrective rewrite
  that would silently turn a monthly job into a daily one if applied.
- `lib/agent-schedules/validation.ts` (TypeScript, Next.js app) and
  `infra/agent-image/skills/psd-schedules/common.js` (plain JS, runs inside
  the agent container image) implement overlapping cron/rate validation
  logic with no shared module path between them — the agent image is a
  separate build/deploy artifact. This duplication is intentional, not
  drift: each file documents which one it mirrors, and both carry unit
  tests over the same set of expressions. Every validation fix in this PR
  series had to be ported to both files by hand.

## Solution

- `firesMonthlyOrYearly` / `nameSuggestsDaily` in
  `lib/agent-schedules/schedule-audit.ts` use separate regexes: one for
  explicit cadence words, one for daily/time-of-day words, and the explicit
  cadence match suppresses the daily-mismatch warning.
- See the file-header comments in `common.js` and `validation.ts` for the
  "mirrors X" cross-reference.

## Prevention

- Any schedule-name heuristic must distinguish "cadence word" (monthly,
  quarterly, yearly) from "time-of-day word" (morning, evening, nightly) —
  only the former is evidence of frequency.
- When editing cron/rate validation logic in `lib/agent-schedules/`, check
  whether `infra/agent-image/skills/psd-schedules/common.js` needs the same
  fix — there is no automated sync between them; search for the mirrored
  check by name/comment and port the fix and its test case manually.
