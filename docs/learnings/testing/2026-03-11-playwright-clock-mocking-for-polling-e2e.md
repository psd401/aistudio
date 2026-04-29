---
title: E2E tests for long-interval polling require Playwright clock mocking
category: testing
tags:
  - playwright
  - clock-mocking
  - polling
  - e2e
  - session-guards
severity: high
date: 2026-03-11
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #854 added E2E tests for polling session guards. All timing-based assertions were vacuously true: the default polling interval is 60s, but tests only waited 2–5s. The tests passed regardless of the implementation because no poll ever fired during the test window.

## Root Cause

Long polling intervals (30s+) cannot be meaningfully tested with real wall-clock waits. A test that calls `waitForTimeout(2000)` against a 60s interval never observes a poll cycle — assertions always pass (or always fail) regardless of implementation correctness.

## Solution

Use Playwright's built-in fake clock before navigation:

```typescript
await page.clock.install();
await page.goto('/protected-route');
// trigger fast-forward to fire the polling hook
await page.clock.fastForward(60_000);
await expect(page.locator('[data-testid="session-status"]')).toHaveText('active');
```

Additional fixes required in the same PR:
- SSE stream route and polling route used overlapping wildcard patterns in `waitForResponse` — disambiguate with exact URL or more specific glob
- Replace `waitForTimeout` with `waitForResponse` to avoid flakiness
- Guard `textContent()` results for null before asserting

## Prevention

Any E2E test covering behavior gated on a timer interval longer than ~2s must use `page.clock.install()` + `page.clock.fastForward()`. Add a comment on the install call noting the real interval being simulated so reviewers can verify the fast-forward value is correct.
