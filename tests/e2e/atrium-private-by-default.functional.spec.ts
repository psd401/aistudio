import { test, expect } from './fixtures'
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
  SEEDED_STAFF_EMAIL,
  SEEDED_STAFF_SUB,
} from './helpers/session-auth'

/**
 * Atrium content is private by default in every collection (#2034).
 *
 * A collection's `defaultVisibilityLevel` decides who may open the collection;
 * it is never copied onto content created in it. Content created into an
 * all-staff (`internal`) district collection without an explicit visibility
 * must come back `private`, and an explicit level is still honored.
 *
 * Auth: minted session cookies (helpers/session-auth) against the host :3100
 * dev server — see docs/guides/e2e-authenticated-testing.md. Gated behind
 * PLAYWRIGHT_AUTH_ENABLED so default CI skips.
 */
test.describe('Atrium private by default (authenticated)', () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== 'true',
    'Requires authenticated session — set PLAYWRIGHT_AUTH_ENABLED=true and run against the host :3100 dev server (see docs/guides/e2e-authenticated-testing.md)'
  )

  test('content created in an all-staff collection is private unless widened explicitly', async ({
    browser,
  }) => {
    const nonce = Date.now()

    const adminCtx = await browser.newContext()
    await authenticateContext(adminCtx, SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_SUB)
    const collectionRes = await adminCtx.request.post(
      '/api/v1/content/collections',
      {
        data: {
          name: `E2E private default ${nonce}`,
          scope: 'district',
          defaultVisibilityLevel: 'internal',
        },
      }
    )
    expect(collectionRes.status()).toBe(201)
    const collection = (await collectionRes.json()).data

    const staffCtx = await browser.newContext()
    await authenticateContext(staffCtx, SEEDED_STAFF_EMAIL, SEEDED_STAFF_SUB)
    const created: string[] = []
    try {
      const implicitRes = await staffCtx.request.post('/api/v1/content', {
        data: {
          kind: 'document',
          title: `E2E implicit ${nonce}`,
          body: 'private by default',
          bodyFormat: 'markdown',
          collectionId: collection.id,
        },
      })
      expect(implicitRes.status()).toBe(201)
      const implicit = (await implicitRes.json()).data
      created.push(implicit.id)
      expect(implicit.visibilityLevel).toBe('private')

      const explicitRes = await staffCtx.request.post('/api/v1/content', {
        data: {
          kind: 'document',
          title: `E2E explicit ${nonce}`,
          body: 'widened on purpose',
          bodyFormat: 'markdown',
          collectionId: collection.id,
          visibility: { level: 'internal' },
        },
      })
      expect(explicitRes.status()).toBe(201)
      const explicit = (await explicitRes.json()).data
      created.push(explicit.id)
      expect(explicit.visibilityLevel).toBe('internal')
    } finally {
      for (const id of created) {
        await staffCtx.request.delete(`/api/v1/content/${id}`)
      }
      await adminCtx.request.patch(
        `/api/v1/content/collections/${collection.id}`,
        { data: { archived: true } }
      )
      await staffCtx.close()
      await adminCtx.close()
    }
  })
})
