---
title: Stale driver workaround comment masked sql.raw() SQL injection vector
category: security
tags:
  - sql-injection
  - drizzle
  - postgres-js
  - stale-comments
  - ai-streaming
  - abort-signal
  - pr-review
  - agentic
severity: critical
date: 2026-06-18
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #1041 (agentic assistant runtime, issue #926) contained `sql.raw()` calls with string-interpolated user-controlled values. A code comment cited "AWS Data API driver corrupts ENUM/JSONB parameter binding" as justification. Automated PR reviewers flagged this as a P1 SQL injection vector during round 1 review.

## Root Cause

The comment was written when the project used the AWS Data API driver, which had a known bug with `::jsonb` and `::enum` parameterized casts. The project had since migrated to the `postgres.js` driver (see `lib/db/drizzle-client.ts`), where parameterized binding with `::jsonb` and `::enum` casts works correctly. The stale comment was trusted at face value, leaving `sql.raw()` in place long after the limitation it described no longer applied.

## Solution

Replaced `sql.raw()` string interpolation with standard Drizzle parameterized queries using `::jsonb` and `::enum` casts. Verified the active driver in `lib/db/drizzle-client.ts` before making the change to confirm parameterized binding would work.

## Prevention

When a comment justifies a security-fragile pattern by citing a driver-specific limitation, verify the cited driver is still the active one before trusting the workaround. Check `lib/db/drizzle-client.ts` to confirm the current driver. Treat any `sql.raw()` with interpolated variables as a mandatory review stop — the burden of proof is on the caller to show parameterized alternatives were exhausted.
