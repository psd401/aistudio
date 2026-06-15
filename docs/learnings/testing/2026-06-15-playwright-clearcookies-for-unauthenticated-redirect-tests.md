---
title: Use page.context().clearCookies() to test unauthenticated redirects when Playwright auth state is shared
category: testing
tags:
  - playwright
  - e2e
  - auth
  - redirect
  - cookies
severity: medium
date: 2026-06-15
source: auto — /lfg issue #581 (PR #1029)
applicable_to: project
---

## What Happened

PR #1029 needed to verify that `/admin/users` redirects unauthenticated users to the sign-in page. This test must always run in CI (no `PLAYWRIGHT_AUTH_ENABLED` guard), yet Playwright's global auth state file (`playwright/.auth/user.json`) may already have a valid session cookie loaded into the browser context.

Navigating directly to the protected route without clearing cookies would use the stored session and skip the redirect entirely — the test would vacuously pass even if auth gating was broken.

## Solution: clearCookies Before Navigation

```typescript
test('unauthenticated access to /admin/users is redirected', async ({ page }) => {
  await page.context().clearCookies()  // ← strip any stored session
  await page.goto('/admin/users')

  await page.waitForURL(
    (url) => isAuthPage(url.href) || url.pathname === '/',
    { timeout: 15_000 }
  )

  const finalUrl = page.url()
  expect(
    isAuthPage(finalUrl) || new URL(finalUrl).pathname === '/'
  ).toBe(true)
})
```

`page.context().clearCookies()` removes all cookies for the current browser context synchronously before navigation, ensuring the request arrives unauthenticated regardless of global auth state.

## When to Use This

- Any always-run test that validates the redirect behavior of a protected route
- Redirect tests placed in the same spec file as auth-gated tests (shared context)

## Important Distinction from { request } Fixture

`{ request }` fixture tests (API 401 checks) send requests without any browser context at all — they are always unauthenticated. `clearCookies` is needed only for browser navigation tests (`{ page }` fixture) where the context might carry a session.

## Helper Pattern

Define a URL classifier function and reuse it in both the `waitForURL` predicate and the final assertion:

```typescript
function isAuthPage(url: string): boolean {
  return (
    url.includes('/auth') ||
    url.includes('/sign-in') ||
    url.includes('/login')
  )
}
```

This avoids duplicating the auth-URL patterns across multiple assertions.

## Where Applied

- `tests/e2e/admin-users.spec.ts` — "User Management — Auth Gating" suite, line 52–67
