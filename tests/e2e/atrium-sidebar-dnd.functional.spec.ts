import { test, expect } from './fixtures'
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
} from './helpers/session-auth'
import { mkdirSync } from 'node:fs'

/**
 * E2E functional coverage for Atrium drag-and-drop
 * (components/atrium/dnd/atrium-dnd.tsx).
 *
 * Three gestures, each verified against the server afterwards (the tree's
 * re-render and the REST read must agree — a drop that only LOOKED right is
 * the failure mode this exists to catch):
 *
 *  1. A library CARD dragged onto a section row is filed into that section.
 *  2. A section row dragged onto a SIBLING's top edge reorders the group.
 *  3. A section row dragged onto a sibling's MIDDLE band is nested inside it.
 *
 * Seeds a private parent with two children plus one unfiled draft document
 * via REST, and tears them down afterwards. Runs as the seeded admin, who
 * owns the private collections (so the grip handles render).
 *
 * dnd-kit's mouse sensor needs a real pointer sequence — press, move past the
 * activation distance, glide, release — so the drags are driven through
 * `page.mouse` rather than `locator.dragTo`. Touch drags are not exercised
 * here (Playwright's touchscreen API is tap-only); the touch sensor is the
 * same code path with a hold-to-start constraint.
 */

const SHOT_DIR = 'docs/verification/atrium-sidebar-dnd'

type Page = import('@playwright/test').Page
type Locator = import('@playwright/test').Locator

function runToken(): string {
  return `${Date.now()}${Math.floor(Math.random() * 1000)}`
}

async function seedCollection(
  page: Page,
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

async function seedDoc(page: Page, title: string): Promise<string> {
  const res = await page.request.post('/api/v1/content', {
    data: {
      kind: 'document',
      title,
      body: `# ${title}\n\nA draft to file by dragging.`,
      bodyFormat: 'markdown',
      visibility: { level: 'private' },
    },
  })
  expect(res.status()).toBe(201)
  const data = (await res.json())?.data
  expect(data?.id).toBeTruthy()
  return data.id as string
}

/** Best-effort teardown; never masks the real assertion failure. */
async function cleanup(
  page: Page,
  docIds: string[],
  collectionIds: string[]
): Promise<void> {
  for (const id of docIds) {
    try {
      await page.request.delete(`/api/v1/content/${id}`)
    } catch {
      // Ignored on purpose.
    }
  }
  for (const id of collectionIds) {
    try {
      await page.request.patch(`/api/v1/content/collections/${id}`, {
        data: { archived: true },
      })
    } catch {
      // Ignored on purpose.
    }
  }
}

function sectionsNav(page: Page): Locator {
  return page
    .getByRole('complementary', { name: 'Workspace' })
    .getByRole('navigation', { name: 'Content sections' })
}

async function waitForTree(page: Page): Promise<void> {
  await expect(sectionsNav(page)).toBeVisible()
  await expect(sectionsNav(page).getByText('Loading sections…')).toHaveCount(0, {
    timeout: 60000,
  })
}

/** The drop-target div of a section row (the element that lights up). */
function rowOf(page: Page, collectionId: string): Locator {
  return page.getByTestId(`section-row-${collectionId}`)
}

/**
 * Drag with a real pointer sequence. `y` picks where on the target to land as
 * a fraction of its height (0.5 = middle band = nest; 0.05 = top edge = before).
 */
async function dragHandleTo(
  page: Page,
  handle: Locator,
  target: Locator,
  y = 0.5
): Promise<void> {
  await handle.scrollIntoViewIfNeeded()
  const from = await handle.boundingBox()
  const to = await target.boundingBox()
  expect(from, 'drag handle must be laid out').not.toBeNull()
  expect(to, 'drop target must be laid out').not.toBeNull()
  const sx = from!.x + from!.width / 2
  const sy = from!.y + from!.height / 2
  const tx = to!.x + to!.width / 2
  const ty = to!.y + to!.height * y
  await page.mouse.move(sx, sy)
  await page.mouse.down()
  // Past the 6px activation distance first, then glide to the target so
  // collision detection sees intermediate positions like a human drag.
  await page.mouse.move(sx + 12, sy + 12, { steps: 4 })
  await page.mouse.move(tx, ty, { steps: 16 })
  await page.mouse.up()
}

/** Expand a section by name (idempotent; retries past hydration). */
async function expandSection(page: Page, name: string): Promise<void> {
  const nav = sectionsNav(page)
  await expect(async () => {
    const collapse = nav.getByRole('button', { name: `Collapse ${name}`, exact: true })
    if ((await collapse.count()) > 0) return
    await nav.getByRole('button', { name: `Expand ${name}`, exact: true }).click()
    await expect(collapse).toHaveAttribute('aria-expanded', 'true', { timeout: 1500 })
  }).toPass({ timeout: 30_000 })
}

test.describe('Atrium drag-and-drop (authenticated)', () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== 'true',
    'Requires an authenticated session — set PLAYWRIGHT_AUTH_ENABLED=true and run against the host :3100 dev server (see docs/guides/e2e-authenticated-testing.md)'
  )

  test.describe.configure({ timeout: 180_000 })

  test.beforeAll(() => {
    mkdirSync(SHOT_DIR, { recursive: true })
  })

  test('drag a card into a section, reorder siblings, and nest one section inside another', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    })
    await authenticateContext(context, SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)
    const page = await context.newPage()
    const token = runToken()
    const parentName = `DnD parent ${token}`
    const firstName = `DnD child one ${token}`
    const secondName = `DnD child two ${token}`
    const docTitle = `DnD draft ${token}`
    const docs: string[] = []
    const collections: string[] = []
    try {
      const parentId = await seedCollection(page, parentName, null)
      const firstId = await seedCollection(page, firstName, parentId)
      const secondId = await seedCollection(page, secondName, parentId)
      collections.push(firstId, secondId, parentId)
      const docId = await seedDoc(page, docTitle)
      docs.push(docId)

      await page.goto('/atrium')
      await waitForTree(page)
      // The grid must show the seeded draft: pin it via the server-side search.
      const box = page.getByRole('textbox', { name: 'Search content by title or tag' })
      await expect(async () => {
        await box.fill(docTitle)
        await expect(page.locator('section[data-results-query]')).toHaveAttribute(
          'data-results-query',
          docTitle,
          { timeout: 3000 }
        )
      }).toPass({ timeout: 30_000 })
      const cardGrip = page.getByTestId(`drag-${docId}`)
      await expect(cardGrip).toBeAttached()

      // 1. Card → section row (any point on the row files it there).
      await expandSection(page, parentName)
      await dragHandleTo(page, cardGrip, rowOf(page, firstId), 0.5)
      await expect(page.getByTestId('tree-dnd-status')).toHaveText(
        `Moved “${docTitle}”`,
        { timeout: 30_000 }
      )
      await expect
        .poll(
          async () => {
            const res = await page.request.get(`/api/v1/content/${docId}`)
            return (await res.json())?.data?.collectionId ?? null
          },
          { timeout: 30_000 }
        )
        .toBe(firstId)
      await page.screenshot({ path: `${SHOT_DIR}/01-card-filed-by-drag.png`, fullPage: false })

      // 2. Reorder: drag "two" onto the TOP edge of "one" → two comes first.
      await expandSection(page, parentName)
      await dragHandleTo(
        page,
        page.getByTestId(`move-collection-${secondId}`),
        rowOf(page, firstId),
        0.06
      )
      await expect(page.getByTestId('tree-dnd-status')).toHaveText(
        `Reordered “${secondName}”`,
        { timeout: 30_000 }
      )
      const children = sectionsNav(page).locator(`#section-children-${parentId} > li`)
      await expect(children.first()).toContainText(secondName, { timeout: 30_000 })
      await expect(children.nth(1)).toContainText(firstName)
      await page.screenshot({ path: `${SHOT_DIR}/02-siblings-reordered.png`, fullPage: false })

      // 3. Nest: drag "one" onto the MIDDLE of "two" → one becomes two's child.
      await dragHandleTo(
        page,
        page.getByTestId(`move-collection-${firstId}`),
        rowOf(page, secondId),
        0.5
      )
      await expect(page.getByTestId('tree-dnd-status')).toHaveText(
        `Moved “${firstName}”`,
        { timeout: 30_000 }
      )
      await expandSection(page, parentName)
      await expandSection(page, secondName)
      await expect(
        sectionsNav(page).locator(`#section-children-${secondId} > li`).first()
      ).toContainText(firstName, { timeout: 30_000 })
      await page.screenshot({ path: `${SHOT_DIR}/03-section-nested.png`, fullPage: false })
    } finally {
      await cleanup(page, docs, collections)
      await context.close()
    }
  })
})
