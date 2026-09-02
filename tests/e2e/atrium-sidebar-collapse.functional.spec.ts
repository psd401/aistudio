import { test, expect } from './fixtures'
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
} from './helpers/session-auth'
import {
  archiveCollections,
  runToken,
  sectionsNav,
  seedCollection,
  setExpanded,
  waitForTree,
} from './helpers/atrium-sidebar'
import { mkdirSync } from 'node:fs'

/**
 * E2E functional coverage for the Atrium sidebar's collapsed-by-default,
 * per-viewer persisted section expansion.
 *
 * The defect this pins: the section tree started FULLY EXPANDED on every visit
 * (a `useState(true)` in every row), so the whole tree unfolded again on every
 * navigation and reload and nothing the viewer collapsed survived. Now:
 *
 *  - a section with children renders COLLAPSED on first load (child hidden,
 *    chevron reads "Expand <name>");
 *  - expanding it reveals the child, and the choice SURVIVES A RELOAD
 *    (chevron reads "Collapse <name>", child visible without any click);
 *  - collapsing it again also survives a reload.
 *
 * The unit-level behaviour (per-viewer key, memory-only before the viewer is
 * known, sibling independence) lives in
 * tests/unit/atrium-collection-tree-expand-state.test.tsx; this spec proves the
 * wiring through the real shell, UserProvider, and browser localStorage.
 *
 * Seeds a private parent + child collection via the REST API (the tree shows a
 * viewer's own private collections under "My collections"), and archives them
 * in teardown.
 *
 * Auth: mints a NextAuth session cookie for the seeded admin
 * (helpers/session-auth). Gated behind PLAYWRIGHT_AUTH_ENABLED.
 */

const SHOT_DIR = 'docs/verification/atrium-sidebar-collapse'

test.describe('Atrium sidebar — collapsed by default, expansion remembered (authenticated)', () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== 'true',
    'Requires an authenticated session — set PLAYWRIGHT_AUTH_ENABLED=true and run against the host :3100 dev server (see docs/guides/e2e-authenticated-testing.md)'
  )

  // Two reloads of the library against a Next DEV server that compiles routes
  // on first hit, so the default 60s per-test budget is too tight.
  test.describe.configure({ timeout: 180_000 })

  test.beforeAll(() => {
    mkdirSync(SHOT_DIR, { recursive: true })
  })

  test('a section starts collapsed; expanding and collapsing both survive a reload', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    })
    await authenticateContext(context, SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)
    const page = await context.newPage()
    const token = runToken()
    const parentName = `Sidebar persist parent ${token}`
    const childName = `Sidebar persist child ${token}`
    // Children first, for teardown ordering.
    const created: string[] = []
    try {
      const parentId = await seedCollection(page, parentName, null)
      created.push(parentId)
      const childId = await seedCollection(page, childName, parentId)
      created.unshift(childId)

      // 1. First load: collapsed. The parent row is present, the child is not
      //    rendered at all, and the chevron offers to Expand.
      await page.goto('/atrium')
      await waitForTree(page)
      const nav = sectionsNav(page)
      await expect(nav.getByText(parentName, { exact: true })).toBeVisible()
      await expect(nav.getByText(childName, { exact: true })).toHaveCount(0)
      await expect(
        nav.getByRole('button', { name: `Expand ${parentName}`, exact: true })
      ).toHaveAttribute('aria-expanded', 'false')
      await page.screenshot({
        path: `${SHOT_DIR}/01-collapsed-by-default.png`,
        fullPage: false,
      })

      // 2. Expand → child appears.
      await setExpanded(page, parentName, true)
      await expect(nav.getByText(childName, { exact: true })).toBeVisible()

      // 3. Reload → still expanded, with NO click: the persisted layout is
      //    applied in the first client commit.
      await page.reload()
      await waitForTree(page)
      await expect(
        sectionsNav(page).getByRole('button', { name: `Collapse ${parentName}`, exact: true })
      ).toHaveAttribute('aria-expanded', 'true')
      await expect(sectionsNav(page).getByText(childName, { exact: true })).toBeVisible()
      await page.screenshot({
        path: `${SHOT_DIR}/02-expanded-survives-reload.png`,
        fullPage: false,
      })

      // 4. Collapse → reload → still collapsed.
      await setExpanded(page, parentName, false)
      await page.reload()
      await waitForTree(page)
      await expect(
        sectionsNav(page).getByRole('button', { name: `Expand ${parentName}`, exact: true })
      ).toHaveAttribute('aria-expanded', 'false')
      await expect(sectionsNav(page).getByText(childName, { exact: true })).toHaveCount(0)
    } finally {
      await archiveCollections(page, created)
      await context.close()
    }
  })
})
