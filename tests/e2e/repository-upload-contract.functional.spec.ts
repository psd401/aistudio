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

  test('adds inline text through the repository item workflow', async ({ page }) => {
    const itemName = `E2E inline retrieval ${Date.now()}`

    await page.goto('/repositories')
    const repositoryRow = page
      .getByRole('row')
      .filter({ hasText: 'E2E Unified Content Repository' })
    await repositoryRow.getByRole('button').first().click()
    await expect(page).toHaveURL(/\/repositories\/\d+$/)

    await page.getByRole('button', { name: /Add (Item|your first item)/i }).first().click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('tab', { name: 'Text' }).click()
    await dialog.getByLabel('Name').fill(itemName)
    await dialog
      .getByLabel('Content')
      .fill('ORCHID-COMPASS-E2E uses the silver lighthouse protocol.')
    await dialog.getByRole('button', { name: 'Add Text' }).click()

    await expect(dialog).toBeHidden()
    await expect(page.getByText(itemName, { exact: true })).toBeVisible()
    const itemRow = page.getByRole('row').filter({ hasText: itemName })
    await expect(itemRow).toContainText(
      // Local E2E keeps rollout flags disabled to avoid writing to a real S3
      // bucket. Enabled canonical state projection is covered below with the
      // deterministic failed-job fixture and by the PostgreSQL smoke suite.
      /Processed|Pending|Processing|Retrying|Generating Embeddings|Embedded/i
    )
  })

  test.describe('terminal processing recovery', () => {
    // This intentionally mutates the one deterministic failed job to pending.
    // Retrying the test itself would no longer start from the seeded state.
    test.describe.configure({ retries: 0 })

    test('shows the canonical failure and restarts it from the item row', async ({ page }) => {
      await page.goto('/repositories')
      const repositoryRow = page
        .getByRole('row')
        .filter({ hasText: 'E2E Unified Content Repository' })
      await repositoryRow.getByRole('button').first().click()

      const itemName = 'E2E failed processing fixture'
      const itemRow = page.getByRole('row').filter({ hasText: itemName })
      await expect(itemRow).toContainText('Failed')
      await expect(itemRow).toContainText('Simulated terminal processing failure')

      await itemRow
        .getByRole('button', { name: `Retry processing ${itemName}` })
        .click()

      await expect(itemRow).toContainText('Pending')
      await expect(itemRow).not.toContainText('Simulated terminal processing failure')
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

  test('uses the canonical upload contract for an image', async ({ page }) => {
    let initiation: Record<string, unknown> | null = null
    let completed = false
    const sessionId = '33333333-4444-4555-8666-777777777777'

    await page.route(/\/api\/repositories\/\d+\/uploads$/, async (route) => {
      initiation = route.request().postDataJSON() as Record<string, unknown>
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          mode: 'canonical',
          upload: {
            sessionId,
            objectKey: `repositories/7/${sessionId}/evacuation-map.png`,
            uploadMethod: 'single',
            uploadUrl: '/__e2e-storage/unified-image',
            expiresAt: '2026-07-21T12:00:00.000Z',
          },
          requestId: 'e2e-image-initiate',
        }),
      })
    })
    await page.route('**/__e2e-storage/unified-image', async (route) => {
      expect(route.request().headers()['content-type']).toBe('image/png')
      await route.fulfill({ status: 200, headers: { ETag: '"image-etag"' } })
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
              itemId: 11,
              itemVersionId: 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa',
              processingJobId: 'bbbbbbbb-3333-4444-8555-666666666666',
              replayed: false,
            },
            requestId: 'e2e-image-complete',
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
    await page.getByLabel('Name').fill('Canonical evacuation map')
    await page.locator('input[type="file"]').setInputFiles({
      name: 'evacuation-map.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=',
        'base64'
      ),
    })
    await page.getByRole('dialog').getByRole('button', { name: /Upload File/i }).click()

    await expect.poll(() => completed).toBe(true)
    expect(initiation).toMatchObject({
      itemName: 'Canonical evacuation map',
      fileName: 'evacuation-map.png',
      contentType: 'image/png',
    })
  })
  test('uses the canonical upload contract for audio and video', async ({ page }) => {
    const initiations: Array<Record<string, unknown>> = []
    const completions: string[] = []
    const sessions = {
      'audio/mpeg': '44444444-5555-4666-8777-888888888888',
      'video/mp4': '55555555-6666-4777-8888-999999999999',
    } as const

    await page.route(/\/api\/repositories\/\d+\/uploads$/, async (route) => {
      const initiation = route.request().postDataJSON() as Record<string, unknown>
      initiations.push(initiation)
      const contentType = initiation.contentType
      if (contentType !== 'audio/mpeg' && contentType !== 'video/mp4') {
        await route.fulfill({ status: 400, body: 'Unexpected media type' })
        return
      }
      const sessionId = sessions[contentType]
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          mode: 'canonical',
          upload: {
            sessionId,
            objectKey: `repositories/7/${sessionId}/${String(initiation.fileName)}`,
            uploadMethod: 'single',
            uploadUrl: `/__e2e-storage/unified-media-${contentType === 'audio/mpeg' ? 'audio' : 'video'}`,
            expiresAt: '2026-07-21T12:00:00.000Z',
          },
          requestId: `e2e-media-${contentType}`,
        }),
      })
    })
    await page.route('**/__e2e-storage/unified-media-*', async (route) => {
      expect(['audio/mpeg', 'video/mp4']).toContain(
        route.request().headers()['content-type']
      )
      await route.fulfill({ status: 200, headers: { ETag: '"media-etag"' } })
    })
    await page.route(
      /\/api\/repositories\/\d+\/uploads\/[0-9a-f-]+\/complete$/,
      async (route) => {
        completions.push(route.request().url())
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            completed: {
              itemId: 12 + completions.length,
              itemVersionId: 'dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb',
              processingJobId: 'cccccccc-4444-4555-8666-777777777777',
              replayed: false,
            },
            requestId: 'e2e-media-complete',
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

    const uploadMedia = async (input: {
      itemName: string
      fileName: string
      mimeType: string
    }) => {
      await page.getByRole('button', { name: /Add (Item|your first item)/i }).first().click()
      await page.getByLabel('Name').fill(input.itemName)
      await page.locator('input[type="file"]').setInputFiles({
        name: input.fileName,
        mimeType: input.mimeType,
        buffer: Buffer.from('e2e-media-contract'),
      })
      await page.getByRole('dialog').getByRole('button', { name: /Upload File/i }).click()
      await expect.poll(() => completions.length).toBe(initiations.length)
      await expect(page.getByRole('dialog')).toBeHidden()
    }

    await uploadMedia({
      itemName: 'Canonical meeting audio',
      fileName: 'meeting.mp3',
      mimeType: 'audio/mpeg',
    })
    await uploadMedia({
      itemName: 'Canonical training video',
      fileName: 'training.mp4',
      mimeType: 'application/octet-stream',
    })

    expect(initiations).toEqual([
      expect.objectContaining({
        itemName: 'Canonical meeting audio',
        fileName: 'meeting.mp3',
        contentType: 'audio/mpeg',
      }),
      expect.objectContaining({
        itemName: 'Canonical training video',
        fileName: 'training.mp4',
        contentType: 'video/mp4',
      }),
    ])
    expect(completions).toHaveLength(2)
  })
})
