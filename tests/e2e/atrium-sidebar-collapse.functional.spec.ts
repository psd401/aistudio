import { test, expect } from './fixtures'
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
} from './helpers/session-auth'
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

function runToken(): string {
  return `${Date.now()}${Math.floor(Math.random() * 1000)}`
}

/** Create a collection via REST and return its id. */
async function seedCollection(
  page: import('@playwright/test').Page,
  name: string,
  parentId: string | null
): Promise<string> {
  const res = await page.request.post('/api/v1/content/collections', {
    data: { name, scope: 'private', ...(parentId ? { parentId } : {}) },
  })
  expect(res.status()).toBe(201)
  const data = (await res.json())?.data
  expect(data?.id).toBeTruthy()
  return data.id as string
}

/**
 * Best-effort teardown (child first — a parent with live children is not
 * archivable). Failures are ignored so teardown never masks the real
 * assertion failure.
 */
async function cleanup(
  page: import('@playwright/test').Page,
  ids: string[]
): Promise<void> {
  for (const id of ids) {
    try {
      await page.request.patch(`/api/v1/content/collections/${id}`, {
        data: { archived: true },
      })
    } catch {
      // Ignored on purpose — see the docblock.
    }
  }
}

/** The section tree inside the workspace column. */
function sectionsNav(page: import('@playwright/test').Page) {
  return page
    .getByRole('complementary', { name: 'Workspace' })
    .getByRole('navigation', { name: 'Content sections' })
}

/** Wait for the tree to finish its mount-time fetch. */
async function waitForTree(page: import('@playwright/test').Page) {
  await expect(sectionsNav(page)).toBeVisible()
  await expect(sectionsNav(page).getByText('Loading sections…')).toHaveCount(0, {
    timeout: 60000,
  })
}

/**
 * Click a chevron and wait for React to confirm the flip. A bare `click()`
 * right after a navigation can land on the server-rendered button before
 * hydration attaches its handler — the click is then silently swallowed.
 * Toggling is idempotent per target state, so retry until `aria-expanded`
 * reads the expected value.
 */
async function setExpanded(
  page: import('@playwright/test').Page,
  sectionName: string,
  expanded: boolean
) {
  const nav = sectionsNav(page)
  const fromLabel = expanded ? `Expand ${sectionName}` : `Collapse ${sectionName}`
  const toLabel = expanded ? `Collapse ${sectionName}` : `Expand ${sectionName}`
  await expect(async () => {
    await nav.getByRole('button', { name: fromLabel, exact: true }).click()
    await expect(nav.getByRole('button', { name: toLabel, exact: true })).toHaveAttribute(
      'aria-expanded',
      String(expanded),
      { timeout: 1500 }
    )
  }).toPass({ timeout: 30_000 })
}

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
    const created: string[] = []
    try {
      const parentId = await seedCollection(page, parentName, null)
      const childId = await seedCollection(page, childName, parentId)
      // Child first for teardown ordering.
      created.push(childId, parentId)

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
      await cleanup(page, created)
      await context.close()
    }
  })
})
