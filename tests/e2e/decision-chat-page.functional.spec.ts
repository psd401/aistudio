import { mkdir } from 'node:fs/promises'
import { test, expect } from './fixtures'
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
} from './helpers/session-auth'

/**
 * E2E (gated): decision-capture chat page (Issue #1251, flow `decision-chat-page`).
 *
 * Always asserts the conversational capture page renders its chrome + composer as
 * the seeded admin (the guaranteed surface). The full conversational capture
 * (propose -> commit -> success card with completeness) is opt-in behind
 * DECISION_CAPTURE_E2E_FULL, because it requires a resolvable DECISION_CAPTURE_MODEL
 * + provider credentials in the local environment; when absent it skips with a
 * logged reason rather than flaking.
 *
 * Gated: needs the host :3100 dev server + seeded admin
 * (see docs/guides/e2e-authenticated-testing.md).
 */

test.describe('Decision capture chat page (#1251)', () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== 'true',
    'Requires authenticated session against the host :3100 dev server — see docs/guides/e2e-authenticated-testing.md',
  )

  test.beforeEach(async ({ page }) => {
    await authenticateContext(page.context(), SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)
    await mkdir('.verification', { recursive: true })
  })

  test('renders the page chrome and the chat composer', async ({ page }, testInfo) => {
    await page.goto('/nexus/decision-capture')

    // Page chrome: the NexusShell title.
    await expect(page.getByText('Decision Capture').first()).toBeVisible({ timeout: 20000 })

    // The chat composer input renders.
    await expect(
      page.getByPlaceholder('How can I help you today?'),
    ).toBeVisible({ timeout: 20000 })

    // A decision-capture suggested action renders.
    await expect(
      page.getByText('Upload a meeting transcript').first(),
    ).toBeVisible({ timeout: 15000 })

    await page.screenshot({
      path: `.verification/decision-chat-page-${testInfo.project.name}.png`,
      fullPage: true,
    })
  })

  test('full conversational capture (propose -> commit -> completeness)', async ({ page }) => {
    test.skip(
      process.env.DECISION_CAPTURE_E2E_FULL !== 'true',
      'DECISION_CAPTURE_MODEL not configured locally — set DECISION_CAPTURE_E2E_FULL=true with a resolvable model to run the full conversational flow',
    )

    await page.goto('/nexus/decision-capture')
    const composer = page.getByPlaceholder('How can I help you today?')
    await expect(composer).toBeVisible({ timeout: 20000 })

    await composer.fill(
      'Capture this decision: The engineering team decided to adopt PostgreSQL because benchmarks showed 3x throughput. Revisit if write volume exceeds 50k ops/s. Then commit it.',
    )
    await composer.press('Enter')

    // The model proposes a structured decision, then commits it; the success card
    // shows the recomputed completeness score.
    await expect(page.getByText(/Proposed Decision/i).first()).toBeVisible({ timeout: 60000 })
    await expect(page.getByText(/Decision committed/i).first()).toBeVisible({ timeout: 60000 })
    await expect(page.getByTestId('commit-completeness')).toBeVisible({ timeout: 15000 })
  })
})
