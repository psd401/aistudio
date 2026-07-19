import { mkdir } from 'node:fs/promises'
import { test, expect } from './fixtures'
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
} from './helpers/session-auth'

/**
 * E2E (gated): admin graph view of a captured decision (Issue #1251, flow
 * `decision-graph-admin-view`).
 *
 * Captures a decision via the REST endpoint, then opens `/admin/graph` as the
 * seeded admin and confirms the decision + person + evidence nodes render in the
 * node list (searched by a shared unique tag). Captures visual evidence.
 *
 * Gated: needs the host :3100 dev server + seeded admin + local data
 * (see docs/guides/e2e-authenticated-testing.md).
 */

test.describe('Decision graph admin view (#1251)', () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== 'true',
    'Requires authenticated session against the host :3100 dev server — see docs/guides/e2e-authenticated-testing.md',
  )

  test.beforeEach(async ({ page }) => {
    await authenticateContext(page.context(), SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)
    await mkdir('.verification', { recursive: true })
  })

  test('captured decision + person + evidence nodes render in /admin/graph', async ({ page }, testInfo) => {
    // Shared tag so all three node names match one search term.
    const tag = `E2EGRAPH${Date.now()}`
    const res = await page.request.post('/api/v1/graph/decisions', {
      data: {
        decision: `${tag} adopt Chromebooks`,
        decidedBy: `${tag} Technology Committee`,
        evidence: [`${tag} TCO analysis shows savings`],
        conditions: [`${tag} revisit if unit cost exceeds 400`],
      },
    })
    expect(res.status()).toBe(201)

    await page.goto('/admin/graph')
    await expect(page.getByRole('heading', { name: 'Context Graph' })).toBeVisible({ timeout: 20000 })

    // Search the node list for the shared tag.
    const search = page.getByLabel('Search nodes')
    await expect(search).toBeVisible({ timeout: 15000 })
    await search.fill(tag)

    // The decision, person, and evidence node rows all match the tag.
    await expect(page.getByText(`${tag} adopt Chromebooks`).first()).toBeVisible({ timeout: 15000 })
    await expect(page.getByText(`${tag} Technology Committee`).first()).toBeVisible({ timeout: 15000 })
    await expect(page.getByText(`${tag} TCO analysis shows savings`).first()).toBeVisible({ timeout: 15000 })

    await page.screenshot({
      path: `.verification/decision-graph-admin-view-${testInfo.project.name}.png`,
      fullPage: true,
    })
  })
})
