import { test, expect } from '@playwright/test'

/**
 * E2E tests for the Agent Workspace Connect flow (Issue #912)
 *
 * Covers the public routes that don't require Google OAuth to exercise:
 * - /agent-connect renders and rejects an invalid/missing token
 * - /agent-connect/callback renders and reports an error on a missing state
 *
 * The full OAuth happy path (Google sign-in, code exchange, Secrets Manager
 * write) requires a live GCP OAuth client and a pilot agent Workspace
 * account — it is exercised manually in dev and out of scope here.
 */

test.describe('Agent Connect — public pages', () => {
  test('missing token shows an error, not a crash', async ({ page }) => {
    const resp = await page.goto('/agent-connect')
    // Page renders (2xx or a soft error UI). We do not require a specific
    // status code because Next.js may render the error inside a 200 body.
    expect(resp).not.toBeNull()
    await expect(page.locator('body')).toContainText(/invalid|expired|missing|error|link/i)
  })

  test('garbage token shows an error, not a crash', async ({ page }) => {
    const resp = await page.goto('/agent-connect?token=not-a-real-jwt')
    expect(resp).not.toBeNull()
    await expect(page.locator('body')).toContainText(/invalid|expired|error|link/i)
  })

  test('callback with no state shows an error, not a crash', async ({ page }) => {
    const resp = await page.goto('/agent-connect/callback')
    expect(resp).not.toBeNull()
    await expect(page.locator('body')).toContainText(/invalid|expired|missing|error/i)
  })
})

test.describe('Agent Consent Link API — auth gate', () => {
  test('POST /api/agent/consent-link without Authorization returns 401', async ({ request }) => {
    const resp = await request.post('/api/agent/consent-link', {
      data: { ownerEmail: 'hagelk@psd401.net' },
    })
    expect(resp.status()).toBe(401)
  })

  test('POST /api/agent/consent-link with wrong bearer returns 401', async ({ request }) => {
    const resp = await request.post('/api/agent/consent-link', {
      headers: { Authorization: 'Bearer not-the-real-key' },
      data: { ownerEmail: 'hagelk@psd401.net' },
    })
    expect(resp.status()).toBe(401)
  })
})
