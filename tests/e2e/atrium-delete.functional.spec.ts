import { test, expect } from './fixtures'
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
} from './helpers/session-auth'

/**
 * E2E functional coverage for Atrium HARD DELETE (Atrium hard delete).
 *
 * Proves the delete contract end-to-end against the real service + DB:
 *  - create → DELETE → 200, and the object is then GONE (GET 404).
 *  - a PUBLISHED object is refused (409) until it is unpublished — delete never
 *    auto-unpublishes.
 *  - the in-app UI flow: open the editor's content-settings dialog, click
 *    "Delete permanently", confirm, land back on the library, and the object 404s.
 *
 * Auth: mints a NextAuth session cookie for the seeded admin (helpers/session-auth).
 * Requires AUTH_SECRET in env and the host :3100 dev server (NOT the prod-built
 * :3000 container, which rejects the non-secure dev cookie). See
 * docs/guides/e2e-authenticated-testing.md. Gated behind PLAYWRIGHT_AUTH_ENABLED so
 * default CI (no seeded session) skips.
 */

test.describe('Atrium hard delete (authenticated)', () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== 'true',
    'Requires authenticated session — set PLAYWRIGHT_AUTH_ENABLED=true and run against the host :3100 dev server (see docs/guides/e2e-authenticated-testing.md)'
  )

  test('create → DELETE → 200, then the object is gone (GET 404)', async ({ page }) => {
    await authenticateContext(page.context(), SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)

    const created = await page.request.post('/api/v1/content', {
      data: { kind: 'document', title: 'e2e delete probe', body: '# hi', bodyFormat: 'markdown' },
    })
    expect(created.status()).toBe(201)
    const id = (await created.json())?.data?.id
    expect(id).toBeTruthy()

    const del = await page.request.delete(`/api/v1/content/${id}`)
    expect(del.ok()).toBeTruthy()
    const summary = (await del.json())?.data
    expect(summary?.id).toBe(id)
    expect(summary?.kind).toBe('document')

    // It is gone: a GET now 404s (existence-masked), and a second DELETE 404s too.
    const readAfter = await page.request.get(`/api/v1/content/${id}`)
    expect(readAfter.status()).toBe(404)
    const delAgain = await page.request.delete(`/api/v1/content/${id}`)
    expect(delAgain.status()).toBe(404)
  })

  test('a PUBLISHED object is refused (409) until unpublished, then deletes', async ({ page }) => {
    await authenticateContext(page.context(), SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)

    const created = await page.request.post('/api/v1/content', {
      data: { kind: 'document', title: 'e2e delete-published probe', body: '# x', bodyFormat: 'markdown' },
    })
    expect(created.status()).toBe(201)
    const id = (await created.json())?.data?.id
    expect(id).toBeTruthy()

    // Publish to the internal reader.
    const pub = await page.request.post(`/api/v1/content/${id}/publish`, {
      data: { destination: 'intranet' },
    })
    expect(pub.ok()).toBeTruthy()

    // Delete is refused while live — never auto-unpublishes.
    const blocked = await page.request.delete(`/api/v1/content/${id}`)
    expect(blocked.status()).toBe(409)

    // Unpublish, then delete succeeds.
    const unpub = await page.request.delete(`/api/v1/content/${id}/publish/intranet`)
    expect(unpub.ok()).toBeTruthy()

    const del = await page.request.delete(`/api/v1/content/${id}`)
    expect(del.ok()).toBeTruthy()

    const readAfter = await page.request.get(`/api/v1/content/${id}`)
    expect(readAfter.status()).toBe(404)
  })

  test('UI flow: Delete permanently in the editor settings → back to library, object 404s', async ({
    page,
  }) => {
    await authenticateContext(page.context(), SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)

    const created = await page.request.post('/api/v1/content', {
      data: { kind: 'document', title: 'e2e ui delete probe', body: '# ui', bodyFormat: 'markdown' },
    })
    expect(created.status()).toBe(201)
    const id = (await created.json())?.data?.id
    expect(id).toBeTruthy()

    // The window.confirm permanence prompt: auto-accept it.
    page.on('dialog', (dialog) => void dialog.accept())

    await page.goto(`/atrium/${id}/edit`)
    // Open the content-settings dialog (the gear in the editor topbar).
    const gear = page.getByRole('button', { name: 'Content settings' })
    await expect(gear).toBeVisible({ timeout: 15000 })
    await gear.click()

    const deleteBtn = page.getByRole('button', { name: 'Delete permanently' })
    await expect(deleteBtn).toBeVisible()
    await deleteBtn.click()

    // The action navigates back to the library on success.
    await page.waitForURL('**/atrium', { timeout: 15000 })

    // The object is gone: the API 404s.
    const readAfter = await page.request.get(`/api/v1/content/${id}`)
    expect(readAfter.status()).toBe(404)
  })
})
