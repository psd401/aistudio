import { test, expect } from './fixtures'

/**
 * E2E: capability-gated protected-layout access enforcement (Issue #928).
 *
 * The hasToolAccess() -> hasCapabilityAccess() migration left every protected
 * layout guarding its route with a capability check that redirects denied users
 * to /sign-in (no session) or /dashboard (session, missing capability).
 *
 * These always-run tests verify an UNAUTHENTICATED visitor is redirected away
 * from every migrated layout. They are CI-safe (no auth state required) and use
 * page.context().clearCookies() so a shared/global session cannot make them
 * vacuously pass.
 *
 * Patterns:
 *  - docs/learnings/testing/2026-06-15-playwright-clearcookies-for-unauthenticated-redirect-tests.md
 *  - docs/learnings/testing/2026-06-15-playwright-e2e-auth-gating-pattern.md
 */

function isAuthOrHome(href: string): boolean {
  const { pathname } = new URL(href)
  return (
    pathname.includes('/sign-in') ||
    pathname.includes('/auth') ||
    pathname.includes('/login') ||
    pathname.includes('/dashboard') ||
    pathname === '/'
  )
}

// Each migrated protected layout and the capability identifier it gates on.
// (Identifiers are unchanged by #928 — only the gate function was renamed.)
const GUARDED_LAYOUTS: ReadonlyArray<{ path: string; capability: string }> = [
  { path: '/repositories', capability: 'knowledge-repositories' },
  { path: '/prompt-library', capability: 'knowledge-repositories' },
  { path: '/compare', capability: 'model-compare' },
  { path: '/nexus/decision-capture', capability: 'decision-capture' },
]

test.describe('Capability layout guards — unauthenticated redirect (always-run)', () => {
  for (const { path, capability } of GUARDED_LAYOUTS) {
    test(`unauthenticated visitor is redirected away from ${path} (cap: ${capability})`, async ({
      page,
    }) => {
      // Strip any stored session so the request arrives unauthenticated even when
      // a global auth state is loaded into the context.
      await page.context().clearCookies()
      await page.goto(path)

      // The guard redirects away from the protected path. Wait until we are no
      // longer on it (or land on a known auth/home destination).
      await page.waitForURL(
        (url) => !url.pathname.startsWith(path) || isAuthOrHome(url.href),
        { timeout: 15_000 }
      )

      const finalUrl = page.url()
      expect(
        !new URL(finalUrl).pathname.startsWith(path) && isAuthOrHome(finalUrl),
        `expected redirect away from ${path}, got ${finalUrl}`
      ).toBe(true)
    })
  }
})

test.describe('Capability layout guards — authorized access (auth-gated)', () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== 'true',
    'Requires an authenticated session with the capability — set PLAYWRIGHT_AUTH_ENABLED=true and seed a user'
  )

  test.beforeEach(async ({ page }) => {
    const { authenticateContext } = await import('./helpers/session-auth')
    await authenticateContext(page.context())
  })

  // With a seeded session that HOLDS the capability, the guard must NOT redirect:
  // the visitor should remain on the protected route. Asserts the migration did
  // not over-block authorized users. Uses /compare as a representative layout
  // (the seeded admin holds model-compare via the manifest).
  test('authorized user reaches /compare', async ({ page }) => {
    await page.goto('/compare')
    // No networkidle — the page may hold a connection open and never go idle under
    // concurrent test load. Wait for the app shell to mount, then assert the guard
    // did not redirect the authorized user off the route.
    await expect(page.getByRole('main').first()).toBeVisible({ timeout: 15_000 })
    expect(new URL(page.url()).pathname).toBe('/compare')
  })
})
