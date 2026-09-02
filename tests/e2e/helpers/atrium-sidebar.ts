import { expect, type Locator, type Page } from '@playwright/test'

/**
 * Shared helpers for the Atrium sidebar (section tree) functional specs:
 * REST seeding of private collections and documents, the tree's landmarks
 * and load sentinel, and hydration-safe expand/collapse. One home for the
 * `aria-label`s, `data-testid`s and REST shapes so a rename in
 * `CollectionTree` breaks every spec in one place.
 */

export function runToken(): string {
  return `${Date.now()}${Math.floor(Math.random() * 1000)}`
}

/** Create a private collection via REST and return its id. */
export async function seedCollection(
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

/** Create a draft document via REST and return `{ id, slug }`. */
export async function seedDoc(
  page: Page,
  title: string,
  level: 'private' | 'internal' = 'private'
): Promise<{ id: string; slug: string }> {
  const res = await page.request.post('/api/v1/content', {
    data: {
      kind: 'document',
      title,
      body: `# ${title}\n\nSeeded by an E2E spec.`,
      bodyFormat: 'markdown',
      visibility: { level },
    },
  })
  expect(res.status()).toBe(201)
  const data = (await res.json())?.data
  expect(data?.id).toBeTruthy()
  expect(data?.slug).toBeTruthy()
  return { id: data.id as string, slug: data.slug as string }
}

/**
 * Best-effort teardown. Pass children BEFORE parents (a parent with live
 * children is not archivable). Failures are ignored so teardown never masks
 * the real assertion failure.
 */
export async function archiveCollections(page: Page, ids: string[]): Promise<void> {
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

/** Best-effort teardown for seeded drafts. */
export async function deleteDocs(page: Page, ids: string[]): Promise<void> {
  for (const id of ids) {
    try {
      await page.request.delete(`/api/v1/content/${id}`)
    } catch {
      // Ignored on purpose — see the docblock.
    }
  }
}

/** The section tree inside the workspace column. */
export function sectionsNav(page: Page): Locator {
  return page
    .getByRole('complementary', { name: 'Workspace' })
    .getByRole('navigation', { name: 'Content sections' })
}

/** The drop-target row div of a section (the element that lights up). */
export function sectionRow(page: Page, collectionId: string): Locator {
  return page.getByTestId(`section-row-${collectionId}`)
}

/** Wait for the tree to finish its mount-time fetch. */
export async function waitForTree(page: Page): Promise<void> {
  await expect(sectionsNav(page)).toBeVisible()
  await expect(sectionsNav(page).getByText('Loading sections…')).toHaveCount(0, {
    timeout: 60000,
  })
}

/**
 * Expand or collapse a section by name and wait for React to confirm it. A
 * bare `click()` right after a navigation can land on the server-rendered
 * button before hydration attaches its handler — the click is then silently
 * swallowed. Idempotent per target state, so retry until `aria-expanded`
 * reads the expected value.
 */
export async function setExpanded(
  page: Page,
  sectionName: string,
  expanded: boolean
): Promise<void> {
  const nav = sectionsNav(page)
  const fromLabel = expanded ? `Expand ${sectionName}` : `Collapse ${sectionName}`
  const toLabel = expanded ? `Collapse ${sectionName}` : `Expand ${sectionName}`
  await expect(async () => {
    const done = nav.getByRole('button', { name: toLabel, exact: true })
    if ((await done.count()) > 0) {
      await expect(done).toHaveAttribute('aria-expanded', String(expanded))
      return
    }
    await nav.getByRole('button', { name: fromLabel, exact: true }).click()
    await expect(done).toHaveAttribute('aria-expanded', String(expanded), {
      timeout: 1500,
    })
  }).toPass({ timeout: 30_000 })
}
