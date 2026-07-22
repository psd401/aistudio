import { test, expect } from './fixtures'
import { authenticateContext } from './helpers/session-auth'

test.describe('Unified repository upload contract (authenticated)', () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== 'true',
    'Requires authenticated local E2E server and unified-content fixture'
  )

  test.beforeEach(async ({ page }) => {
    await authenticateContext(page.context())
  })

  test('sends the repository id when requesting direct upload storage', async ({ page }) => {
    let uploadRequest: Record<string, unknown> | null = null
    await page.route(/\/api\/repositories\/\d+\/uploads$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ mode: 'legacy', requestId: 'e2e-legacy' }),
      })
    })
    await page.route('**/api/documents/presigned-url', async (route) => {
      uploadRequest = route.request().postDataJSON() as Record<string, unknown>
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'E2E contract captured' }),
      })
    })

    await page.goto('/repositories')
    const repositoryRow = page
      .getByRole('row')
      .filter({ hasText: 'E2E Unified Content Repository' })
    await repositoryRow.getByRole('button').first().click()
    await expect(page).toHaveURL(/\/repositories\/\d+$/)
    const repositoryId = Number(new URL(page.url()).pathname.split('/').pop())
    expect(repositoryId).toBeGreaterThan(0)

    await page.getByRole('button', { name: /Add (Item|your first item)/i }).first().click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.getByLabel('Name').fill('E2E policy PDF')
    await page.locator('input[type="file"]').setInputFiles({
      name: 'e2e-policy.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\n%%EOF'),
    })
    await page.getByRole('dialog').getByRole('button', { name: /Add|Upload/i }).click()

    await expect.poll(() => uploadRequest).not.toBeNull()
    expect(uploadRequest).toMatchObject({
      repositoryId,
      fileName: 'e2e-policy.pdf',
      fileType: 'application/pdf',
    })
  })

  test('uploads and completes a canonical PDF without invoking the legacy action', async ({ page }) => {
    let initiation: Record<string, unknown> | null = null
    let completion: Record<string, unknown> | null = null
    const sessionId = '11111111-2222-4333-8444-555555555555'

    await page.route(/\/api\/repositories\/\d+\/uploads$/, async (route) => {
      initiation = route.request().postDataJSON() as Record<string, unknown>
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          mode: 'canonical',
          upload: {
            sessionId,
            objectKey: `repositories/7/${sessionId}/e2e-policy.pdf`,
            uploadMethod: 'single',
            uploadUrl: '/__e2e-storage/unified-content',
            expiresAt: '2026-07-21T12:00:00.000Z',
          },
          requestId: 'e2e-initiate',
        }),
      })
    })
    await page.route('**/__e2e-storage/unified-content', async (route) => {
      expect(route.request().method()).toBe('PUT')
      await route.fulfill({ status: 200, headers: { ETag: '"single-etag"' } })
    })
    await page.route(
      new RegExp(`/api/repositories/\\d+/uploads/${sessionId}/complete$`),
      async (route) => {
        completion = route.request().postDataJSON() as Record<string, unknown>
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            completed: {
              itemId: 9,
              itemVersionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
              processingJobId: 'ffffffff-1111-4222-8333-444444444444',
              replayed: false,
            },
            requestId: 'e2e-complete',
          }),
        })
      }
    )
    await page.route('**/api/documents/presigned-url', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Legacy upload must not run' }),
      })
    })

    await page.goto('/repositories')
    const repositoryRow = page
      .getByRole('row')
      .filter({ hasText: 'E2E Unified Content Repository' })
    await repositoryRow.getByRole('button').first().click()
    await expect(page).toHaveURL(/\/repositories\/\d+$/)
    const repositoryId = Number(new URL(page.url()).pathname.split('/').pop())

    await page.getByRole('button', { name: /Add (Item|your first item)/i }).first().click()
    await page.getByLabel('Name').fill('Canonical E2E PDF')
    await page.locator('input[type="file"]').setInputFiles({
      name: 'e2e-policy.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\n%%EOF'),
    })
    await page.getByRole('dialog').getByRole('button', { name: /Add|Upload/i }).click()

    await expect.poll(() => completion).not.toBeNull()
    await expect(page.getByRole('dialog')).toBeHidden()
    expect(initiation).toMatchObject({
      itemName: 'Canonical E2E PDF',
      fileName: 'e2e-policy.pdf',
      contentType: 'application/pdf',
    })
    expect(completion).toEqual({})
    expect(repositoryId).toBeGreaterThan(0)
  })

  test('uses the canonical upload contract for an Office document', async ({ page }) => {
    let initiation: Record<string, unknown> | null = null
    let completed = false
    const sessionId = '22222222-3333-4444-8555-666666666666'
    const contentType =
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

    await page.route(/\/api\/repositories\/\d+\/uploads$/, async (route) => {
      initiation = route.request().postDataJSON() as Record<string, unknown>
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          mode: 'canonical',
          upload: {
            sessionId,
            objectKey: `repositories/7/${sessionId}/e2e-handbook.docx`,
            uploadMethod: 'single',
            uploadUrl: '/__e2e-storage/unified-office',
            expiresAt: '2026-07-21T12:00:00.000Z',
          },
          requestId: 'e2e-office-initiate',
        }),
      })
    })
    await page.route('**/__e2e-storage/unified-office', async (route) => {
      await route.fulfill({ status: 200, headers: { ETag: '"office-etag"' } })
    })
    await page.route(
      new RegExp(`/api/repositories/\\d+/uploads/${sessionId}/complete$`),
      async (route) => {
        completed = true
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            completed: {
              itemId: 10,
              itemVersionId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
              processingJobId: 'aaaaaaaa-2222-4333-8444-555555555555',
              replayed: false,
            },
            requestId: 'e2e-office-complete',
          }),
        })
      }
    )
    await page.route('**/api/documents/presigned-url', async (route) => {
      await route.fulfill({ status: 500, body: 'Legacy upload must not run' })
    })

    await page.goto('/repositories')
    const repositoryRow = page
      .getByRole('row')
      .filter({ hasText: 'E2E Unified Content Repository' })
    await repositoryRow.getByRole('button').first().click()
    await page.getByRole('button', { name: /Add (Item|your first item)/i }).first().click()
    await page.getByLabel('Name').fill('Canonical E2E DOCX')
    await page.locator('input[type="file"]').setInputFiles({
      name: 'e2e-handbook.docx',
      mimeType: contentType,
      buffer: Buffer.from('e2e-docx-contract'),
    })
    await page.getByRole('dialog').getByRole('button', { name: /Add|Upload/i }).click()

    await expect.poll(() => completed).toBe(true)
    expect(initiation).toMatchObject({
      itemName: 'Canonical E2E DOCX',
      fileName: 'e2e-handbook.docx',
      contentType,
    })
  })
})
