import { mkdir } from 'node:fs/promises'
import { test, expect } from './fixtures'
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
} from './helpers/session-auth'

/**
 * E2E (gated): admin-agents-triage-settings (#1172).
 *
 * Drives the per-user email-triage admin page as the seeded administrator
 * and verifies it renders the Phase-2 surfaces — escalation mode/threshold,
 * sweep status, learned patterns, and pending suggestions — without error.
 *
 * The triage state is backed by DynamoDB (agent-platform stack), which a
 * local dev server does not have. So the page resolves to one of two valid
 * renders: the populated sections (when the action reaches a real table) or
 * the graceful "No triage row for this user" fallback (when it cannot). Both
 * prove the route renders under admin auth without crashing; the component
 * test (triage-detail-client.test.tsx) covers the populated sections
 * deterministically.
 *
 * Gated: needs the host :3100 dev server + seeded users
 * (see docs/guides/e2e-authenticated-testing.md).
 */

const TARGET_USER = 'hagelk@psd401.net'

test.describe('Admin email-triage settings page (#1172)', () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== 'true',
    'Requires authenticated session against the host :3100 dev server — see docs/guides/e2e-authenticated-testing.md',
  )

  test('renders escalation / sweep / learned-patterns / suggestions sections without error', async ({
    page,
  }, testInfo) => {
    await authenticateContext(page.context(), SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)
    await page.goto(`/admin/agents/${encodeURIComponent(TARGET_USER)}/triage`)

    // The page heading always renders for an authenticated admin.
    const heading = page.locator('h1').filter({ hasText: /Email Triage/i })
    await expect(heading).toBeVisible({ timeout: 15000 })

    // Not redirected to auth (proves admin authorization succeeded).
    expect(page.url()).toContain('/triage')

    // Either the populated Phase-2 sections render, or the graceful
    // "no triage row" fallback does — both are non-error renders.
    const escalationSection = page.getByText('Escalation', { exact: true })
    const sweepSection = page.getByText('Sweep', { exact: true })
    const noRowFallback = page.getByText(/No triage row for this user/i)

    await expect(escalationSection.or(noRowFallback).first()).toBeVisible({
      timeout: 15000,
    })

    // When the state loaded, assert all four Phase-2 sections are present.
    if (await escalationSection.isVisible().catch(() => false)) {
      await expect(sweepSection).toBeVisible()
      await expect(
        page.getByText('Learned patterns', { exact: true }).first(),
      ).toBeVisible()
      await expect(
        page.getByText('Pending suggestions', { exact: true }).first(),
      ).toBeVisible()
    }

    // Visual evidence for the PR (screenshot_dir default = .verification).
    await mkdir('.verification', { recursive: true })
    await page.screenshot({
      path: `.verification/admin-agents-triage-settings-${testInfo.project.name}.png`,
      fullPage: true,
    })
  })
})
