---
title: locator.count() is a Playwright anti-pattern for conditional element checks — use waitFor instead
category: testing
tags:
  - playwright
  - e2e
  - flakiness
  - locator
  - anti-pattern
severity: high
date: 2026-06-15
source: auto — /lfg issue #154 (Gemini review on PR #1014)
applicable_to: project
---

## What Happened

PR #1014 used `locator.count()` to detect whether optional UI elements (model selector, tool selector, voice button) were present before asserting on them:

```typescript
// WRONG — count() returns immediately, does not wait for async render
if ((await modelSelector.count()) > 0) {
  await expect(modelSelector).toBeVisible()
}
```

Gemini's code review flagged all three instances as HIGH severity. The PR was merged with this pattern — it should be fixed in a follow-up.

## Root Cause

`locator.count()` does not auto-wait. If the page is still rendering (React hydration, async data fetch), `count()` returns `0` immediately and the conditional branch skips assertions entirely. The test passes vacuously whether the feature is broken or not.

## Correct Pattern: `waitFor` in try/catch for optional elements

```typescript
// CORRECT — waitFor auto-waits; catch handles the "not present" case
test('model selector renders and is interactive', async ({ page }) => {
  const modelSelector = page.locator('[data-testid="model-selector"]')
  const altSelector = page.locator('button').filter({ hasText: /model|gpt|claude|gemini/i }).first()

  try {
    await modelSelector.waitFor({ state: 'visible', timeout: 5_000 })
    await modelSelector.click()
    const options = page.locator('[data-testid="model-option"]')
    await expect(options.first()).toBeVisible({ timeout: 5_000 })
    return
  } catch {
    // Primary not found, try alternate
  }

  try {
    await altSelector.waitFor({ state: 'visible', timeout: 5_000 })
    await expect(altSelector).toBeVisible()
  } catch {
    test.skip(true, 'Model selector not present in this environment')
  }
})
```

## Correct Pattern: CSS multi-selector for either-or state

When an element exists in multiple states (enabled/disabled), use a comma-joined selector:

```typescript
// WRONG — two separate count() calls
const hasVoice = (await voiceEnabled.count()) > 0 || (await voiceDisabled.count()) > 0

// CORRECT — single locator, auto-waits
const voiceButton = page.locator('[data-testid="voice-mode-button"], [data-testid="voice-mode-button-disabled"]')
await expect(voiceButton).toBeVisible({ timeout: 5_000 })
```

## Rule

Never use `locator.count()` to decide whether to run an assertion. Options:
1. **Always-present elements**: use `expect(locator).toBeVisible()` directly
2. **Optional elements (environment-dependent)**: use `waitFor` in a try/catch, skip if not found
3. **Either-or state** (enabled vs disabled variant): use CSS multi-selector with a comma

## Files to Fix (from PR #1014)

`tests/e2e/nexus/advanced.spec.ts` — model selector (~line 115), tool selector (~line 133), voice button (~line 143).
