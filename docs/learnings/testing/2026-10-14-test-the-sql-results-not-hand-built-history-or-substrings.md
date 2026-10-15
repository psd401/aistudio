---
title: A test that hands the rule a hand-built history asserts the rule, not the system — assert SQL results, mutation-check the test
category: testing
tags: [agent-schedules, sql, test-quality, mutation-testing, postgres]
severity: medium
date: 2026-10-14
source: auto — /work #1890 (PR #1925)
applicable_to: project
---

## What Happened

A unit test for the failure-streak notification (#1890) claimed to cover
"exactly one message across a 30-run streak" and passed — because its helper
handed the function the *full* in-memory history directly, never modelling
the `LIMIT 12` the Lambda actually reads through in production. After the
query was rewritten as a single aggregating SQL statement (see
[[streak-suppression-must-aggregate-sql-not-page-rows]]), the replacement
test asserted the new SQL's *text* with `toContain`/`not.toContain` —
which would still pass even if the streak logic inside that SQL were wrong.

## Root Cause

Both test shapes verified "did I write the code I meant to write," not "does
the system actually behave correctly." A hand-built in-memory history
bypasses the real data-access boundary (the `LIMIT`); a substring match on
SQL text bypasses the database executing it.

## Solution

Added `tests/smoke/agent-schedule-failure-streak.smoke.ts`: runs the real
streak SQL against real PostgreSQL inside a transaction, using a temp table
that shadows `agent_scheduled_runs`, following the repo's existing
`tests/smoke/*.smoke.ts` pattern, wired into the existing Postgres CI job.
Then mutation-checked the test by hand: capping the count at 12 (`LIMIT 12`)
correctly fails the first assertion; flipping the success-boundary
comparison between `>` and `>=` correctly does NOT change the test result
(the boundary row is itself a success, already excluded by the outer status
filter) — confirming the test has teeth exactly where it should and is
inert exactly where the boundary is genuinely insensitive.

## Prevention

- When behaviour lives in SQL, assert the SQL's *results* against a real
  database, not its text, and don't hand the function a shortcut input that
  skips the boundary (pagination limit, index usage, filter) you're trying
  to cover.
- Don't trust a passing test — mutation-check it: deliberately break the
  logic one way the test should catch, and one way it legitimately
  shouldn't, and confirm both outcomes.

## Addendum — a smoke test that could not fail

Mutation-checking the replacement smokes (restore the bug, confirm the test
goes red) caught a defect in one of the new tests itself.

`agent-schedule-failing-marker.smoke.ts` drives the real Drizzle reader, whose
connection pool holds the event loop open, so the script has to end itself.
Its `finally` block called `process.exit(process.exitCode ?? 0)` — and
`process.exitCode` is not set by a thrown assertion, so a failed assertion
exited **0**. The test reported success on failure and would have done so
forever.

The fix is to catch the failure, record it, and exit non-zero:

```ts
let failed = false;
try { /* assertions */ } catch (error) {
  log.error(`... FAILED: ${...}`);
  failed = true;
} finally {
  await cleanup();
  process.exit(failed ? 1 : 0);
}
```

Two rules from this:

- **Any script that calls `process.exit()` in `finally` must derive the code
  from whether the body threw.** `process.exitCode` does not reflect an
  uncaught throw, and `finally` runs on the way out of one.
- **Mutation-check a test before relying on it.** Both smokes here were
  verified by reintroducing the exact bug they exist to catch; one of them only
  revealed its own blindness that way. A green test proves nothing about a bug
  it cannot see, and "the test passes" and "the test can fail" are different
  claims.
