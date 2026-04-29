---
title: page.clock.install() patches browser timers only — route handlers run in Node.js and see wall-clock time
category: testing
tags:
  - playwright
  - fake-clock
  - e2e
  - polling
  - session-guards
severity: high
date: 2026-03-11
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #854 (round 3 review) had timing-gap assertions relying on `Date.now()` inside Playwright route handler callbacks. These assertions always returned wall-clock milliseconds regardless of `page.clock.install()` because route handlers execute in the Node.js test process, not in the browser context.

## Root Cause

`page.clock.install()` patches `Date`, `setTimeout`, `setInterval`, and `requestAnimationFrame` inside the Chromium browser context only. The Playwright test process (Node.js) is a separate runtime and is never patched — any `Date.now()` call in a `page.route()` callback, a `waitForResponse` handler, or other test-process code returns real wall-clock time.

## Solution

Read fake-clock time from within the browser context using `page.evaluate`:

```typescript
// WRONG — runs in Node.js, always wall-clock time
page.route('**/api/session', (route) => {
  const now = Date.now(); // unpatched
  ...
});

// CORRECT — reads patched time from browser context
const fakeNow = await page.evaluate(() => Date.now());
```

For timing-gap assertions between two events, capture both timestamps via `page.evaluate()` after advancing the clock with `page.clock.fastForward()`.

## Prevention

- Never put timing assertions inside `page.route()` callbacks — they run in Node.js.
- Any assertion comparing elapsed time must use `page.evaluate(() => Date.now())` to read the fake clock.
- Document the two-runtime boundary with a comment on the `page.clock.install()` call.
- See companion learning: `testing/2026-03-11-playwright-clock-mocking-for-polling-e2e.md` for the install/fastForward pattern.
