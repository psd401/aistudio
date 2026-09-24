import { test, expect } from './fixtures'

/**
 * CI-safe (unauthenticated) guard for the `assistant-architect-create-add-field`
 * flow (Issue #1697). The functional half needs a minted session and is gated
 * behind PLAYWRIGHT_AUTH_ENABLED; this half just pins that the create page is
 * behind auth, so the flow can never be exercised anonymously.
 */
test.describe('assistant-architect-create-add-field-guard', () => {
  test('the create page requires authentication', async ({ page }) => {
    await page.goto('/utilities/assistant-architect/create')

    await expect(page).toHaveURL(/\/(api\/auth\/signin|auth\/signin|sign-in)/)
  })
})
