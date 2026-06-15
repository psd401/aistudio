---
title: Playwright E2E auth-gating pattern — PLAYWRIGHT_AUTH_ENABLED env var splits always-run vs skip tests
category: testing
tags:
  - playwright
  - e2e
  - auth
  - nexus
  - ci
severity: medium
date: 2026-06-15
source: auto — /lfg issue #154
applicable_to: project
---

## What Happened

PR #1014 established the Nexus E2E test suite across 37 tests. A key design choice was needed: some tests (API 401 guards, redirect checks) can run in CI with no auth setup, while others (browser chat interactions, conversation CRUD) require an authenticated session. Mixing them without a gate would cause CI failures in the majority of environments.

## Pattern

Use `PLAYWRIGHT_AUTH_ENABLED=true` as the guard env var. Tests that require auth skip gracefully when it's not set:

```typescript
test.skip(
  !process.env.PLAYWRIGHT_AUTH_ENABLED,
  'Requires authenticated Playwright context — set PLAYWRIGHT_AUTH_ENABLED=true to run'
)
```

Auth-independent tests (API 401 checks, redirect assertions) do NOT carry this guard and always run in CI. These use the `{ request }` fixture directly without `{ page }`:

```typescript
test('GET /api/nexus/conversations returns 401 without auth', async ({ request }) => {
  const res = await request.get('/api/nexus/conversations')
  expect(res.status()).toBe(401)
})
```

## Auth Redirect Targets

The app redirects unauthenticated users to `/sign-in` (not `/auth/signin`). The redirect check must also allow `/auth/` and `/login` for resilience:

```typescript
await page.waitForURL(
  (url) =>
    url.pathname.includes('/sign-in') ||
    url.pathname.includes('/auth/') ||
    url.pathname.includes('/login'),
  { timeout: 10_000 }
)
```

## Key Selectors Verified (PR #1014)

| UI Element | Selector |
|---|---|
| Nexus shell container | `[data-testid="nexus-shell"]` |
| Message composer | `[aria-label="Message input"]` |
| Send button | `[aria-label="Send message"]` |
| Stop/cancel button | `[aria-label="Stop generating"]` |
| New chat button | `button[title="Start new chat"]` |
| User message bubble | `[data-role="user"]` |
| Assistant message bubble | `[data-role="assistant"]` |

## Shared Utils Pattern

Extract navigation + interaction helpers to `tests/e2e/<feature>/utils.ts`:

```typescript
export async function gotoNexus(page: Page): Promise<void> {
  await page.goto('/nexus')
  await page.waitForURL(
    (url) => !url.pathname.includes('/auth/signin') && !url.pathname.includes('/sign-in'),
    { timeout: 10_000 }
  )
  await page.waitForSelector('[data-testid="nexus-shell"]', { timeout: 10_000 })
}

export async function waitForStreamingComplete(page: Page, timeout = 60_000): Promise<void> {
  await page.locator('[aria-label="Stop generating"]').waitFor({ state: 'hidden', timeout })
}
```

## Open Issue: Test Data Cleanup

Authenticated tests that create conversations via API do NOT delete them. On a shared dev/staging DB with `PLAYWRIGHT_AUTH_ENABLED=true`, orphaned conversations accumulate. Add `afterEach` teardown via `DELETE /api/nexus/conversations/<id>` when this becomes a problem.

## Prevention

- Auth-independent tests (HTTP status, redirect) → always run, use `{ request }` fixture
- Auth-required browser tests → guard with `test.skip(!process.env.PLAYWRIGHT_AUTH_ENABLED, ...)`
- Extract shared navigation/streaming helpers to a `utils.ts` per feature directory
- Do NOT use `page.evaluate(() => fetch(...))` as a substitute for `{ request }` in unauthenticated API tests — it sends the browser's cookies, which may inadvertently be authenticated
