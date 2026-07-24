import { test, expect } from './fixtures'
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
} from './helpers/session-auth'

/**
 * E2E (gated): /admin hub landing page.
 *
 * Drives /admin as the seeded administrator: the card grid renders from the
 * ADMIN_SECTIONS registry, a card navigates to its admin page, and the triage
 * quick-jump block renders (locally DynamoDB is absent, so the empty state is
 * the deterministic branch).
 *
 * Gated: needs the host :3100 dev server + seeded users (see
 * docs/guides/e2e-authenticated-testing.md).
 */

test.describe('Admin hub page', () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== 'true',
    'Requires authenticated session against the host :3100 dev server — see docs/guides/e2e-authenticated-testing.md',
  )

  test('renders registry cards and navigates to an admin page', async ({
    page,
  }) => {
    await authenticateContext(page.context(), SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)
    await page.goto('/admin')

    // Admin authorization succeeded and the hub renders.
    const heading = page.locator('h1').filter({ hasText: /^Admin$/ })
    await expect(heading).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId('admin-hub')).toBeVisible()

    // A card from each section of the registry is present.
    await expect(page.getByTestId('admin-card-users')).toBeVisible()
    await expect(page.getByTestId('admin-card-models')).toBeVisible()
    await expect(page.getByTestId('admin-card-agents')).toBeVisible()
    await expect(page.getByTestId('admin-card-settings')).toBeVisible()

    // Triage quick-jump renders one of its two states (dropdown when DynamoDB
    // has opted-in users, the empty message otherwise — locally the latter).
    await expect(
      page
        .getByTestId('triage-quick-jump')
        .or(page.getByTestId('triage-quick-jump-empty')),
    ).toBeVisible()

    // A card navigates to its admin page.
    await page.getByTestId('admin-card-users').click()
    await page.waitForURL('**/admin/users')
    await expect(
      page.locator('h1').filter({ hasText: 'User Management' }),
    ).toBeVisible({ timeout: 15000 })
  })
})
