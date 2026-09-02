import { test, expect } from './fixtures'
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
} from './helpers/session-auth'
import {
  archiveCollections,
  deleteDocs,
  runToken,
  sectionRow,
  sectionsNav,
  seedCollection,
  seedDoc,
  setExpanded,
  waitForTree,
} from './helpers/atrium-sidebar'
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
 *  2. A section row dragged onto a SIBLING's top edge takes that slot.
 *  3. A section row dragged onto a sibling's MIDDLE band is nested inside it.
 *
 * And one refusal: an INTERNAL-visibility document dropped on a PRIVATE
 * collection is rejected by the server's visibility rule, the tree shows the
 * refusal inline, and the document stays where it was.
 *
 * Seeds private collections and draft documents via REST (each id is queued
 * for teardown the moment it exists, so a later seed failure cannot leak the
 * earlier rows). Runs as the seeded admin, who owns the private collections
 * (so the grip handles render).
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

/**
 * Drag with a real pointer sequence. `y` picks where on the target to land as
 * a fraction of its height (0.5 = middle band = nest; 0.06 = top edge = take
 * this slot).
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
  // dnd-kit auto-scrolls a scrollable ancestor while the pointer sits in its
  // edge zone (bottom fifth by default), so when the tree is near the bottom
  // of the nav column the target slides up under a pointer aimed at its
  // pre-drag position — a middle-band drop becomes an edge drop. Re-aim at the
  // target's LIVE box until it holds still, as a human does by eye.
  await aimAtLivePosition(page, target, y)
  await page.mouse.up()
}

async function aimAtLivePosition(page: Page, target: Locator, y: number): Promise<void> {
  let last = await target.boundingBox()
  for (let i = 0; i < 6 && last; i++) {
    await page.mouse.move(last.x + last.width / 2, last.y + last.height * y, { steps: 3 })
    await page.waitForTimeout(80)
    const now = await target.boundingBox()
    if (!now || (Math.abs(now.y - last.y) < 1 && Math.abs(now.x - last.x) < 1)) break
    last = now
  }
}

/** Pin the grid to one seeded document via the server-side search box. */
async function pinGridTo(page: Page, title: string): Promise<void> {
  const box = page.getByRole('textbox', { name: 'Search content by title or tag' })
  await expect(async () => {
    await box.fill(title)
    await expect(page.locator('section[data-results-query]')).toHaveAttribute(
      'data-results-query',
      title,
      { timeout: 3000 }
    )
  }).toPass({ timeout: 30_000 })
}

async function collectionOf(page: Page, docId: string): Promise<string | null> {
  const res = await page.request.get(`/api/v1/content/${docId}`)
  return (await res.json())?.data?.collectionId ?? null
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
    // Children first, for teardown ordering; each id is queued as soon as it exists.
    const collections: string[] = []
    try {
      const parentId = await seedCollection(page, parentName, null)
      collections.push(parentId)
      const firstId = await seedCollection(page, firstName, parentId)
      collections.unshift(firstId)
      const secondId = await seedCollection(page, secondName, parentId)
      collections.unshift(secondId)
      const doc = await seedDoc(page, docTitle)
      docs.push(doc.id)

      await page.goto('/atrium')
      await waitForTree(page)
      await pinGridTo(page, docTitle)
      const cardGrip = page.getByTestId(`drag-${doc.id}`)
      await expect(cardGrip).toBeAttached()

      // 1. Card → section row (any point on the row files it there).
      await setExpanded(page, parentName, true)
      await dragHandleTo(page, cardGrip, sectionRow(page, firstId), 0.5)
      await expect(page.getByTestId('tree-dnd-status')).toContainText(`Moved “${docTitle}”`, {
        timeout: 30_000,
      })
      await expect.poll(() => collectionOf(page, doc.id), { timeout: 30_000 }).toBe(firstId)
      // The drop also re-fetches the tree (`atrium:collections-changed`). Wait
      // for THAT to land — "one" now shows a count badge of 1 — before the next
      // drag: a reload mid-drag re-registers every row's droppable and the drop
      // resolves to no target at all.
      await expect(sectionRow(page, firstId)).toContainText('1', { timeout: 30_000 })
      await page.screenshot({ path: `${SHOT_DIR}/01-card-filed-by-drag.png`, fullPage: false })

      // 2. Reorder: drag "two" onto the TOP edge of "one" → two takes slot 0.
      await setExpanded(page, parentName, true)
      await dragHandleTo(
        page,
        page.getByTestId(`move-collection-${secondId}`),
        sectionRow(page, firstId),
        0.06
      )
      await expect(page.getByTestId('tree-dnd-status')).toHaveText(`Reordered “${secondName}”`, {
        timeout: 30_000,
      })
      const children = sectionsNav(page).locator(`#section-children-${parentId} > li`)
      await expect(children.first()).toContainText(secondName, { timeout: 30_000 })
      await expect(children.nth(1)).toContainText(firstName)
      await page.screenshot({ path: `${SHOT_DIR}/02-siblings-reordered.png`, fullPage: false })

      // 3. Nest: drag "one" onto the MIDDLE of "two" → one becomes two's child.
      await dragHandleTo(
        page,
        page.getByTestId(`move-collection-${firstId}`),
        sectionRow(page, secondId),
        0.5
      )
      await expect(page.getByTestId('tree-dnd-status')).toHaveText(`Moved “${firstName}”`, {
        timeout: 30_000,
      })
      // Wait for the nest's re-fetch to land ("one" leaves the parent's direct
      // children) before expanding "two"; under a loaded machine the expand
      // click otherwise races the tree's re-render.
      await expect(children).toHaveCount(1, { timeout: 30_000 })
      await setExpanded(page, parentName, true)
      await setExpanded(page, secondName, true)
      await expect(
        sectionsNav(page).locator(`#section-children-${secondId} > li`).first()
      ).toContainText(firstName, { timeout: 30_000 })
      await page.screenshot({ path: `${SHOT_DIR}/03-section-nested.png`, fullPage: false })
    } finally {
      await deleteDocs(page, docs)
      await archiveCollections(page, collections)
      await context.close()
    }
  })

  test('a refused drop shows the server\'s reason and leaves the document where it was', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    })
    await authenticateContext(context, SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)
    const page = await context.newPage()
    const token = runToken()
    const parentName = `DnD refusal parent ${token}`
    const docTitle = `DnD internal draft ${token}`
    const docs: string[] = []
    const collections: string[] = []
    try {
      const parentId = await seedCollection(page, parentName, null)
      collections.push(parentId)
      // Internal visibility into a PRIVATE collection is refused by
      // `applyCollectionChangeInTx` ("Set content visibility to private…").
      const doc = await seedDoc(page, docTitle, 'internal')
      docs.push(doc.id)

      await page.goto('/atrium')
      await waitForTree(page)
      await pinGridTo(page, docTitle)
      await dragHandleTo(page, page.getByTestId(`drag-${doc.id}`), sectionRow(page, parentId), 0.5)

      // The provider clears the status line a few seconds after a drop, so
      // read it in one go: tone AND a non-empty message (the server's own
      // wording is not the contract here — that it is shown inline is).
      const status = page.getByTestId('tree-dnd-status')
      await expect(status).toHaveAttribute('data-tone', 'error', { timeout: 30_000 })
      expect((await status.textContent())?.trim()).toBeTruthy()
      expect(await collectionOf(page, doc.id)).toBeNull()
      await page.screenshot({ path: `${SHOT_DIR}/04-refused-drop.png`, fullPage: false })
    } finally {
      await deleteDocs(page, docs)
      await archiveCollections(page, collections)
      await context.close()
    }
  })
})
