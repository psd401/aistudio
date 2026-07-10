import { test, expect } from './fixtures'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * E2E tests for the Agent Connect (Canva) consent flow (Issue #1176).
 *
 * Flow: `canva-consent-page`.
 *
 * Covers the PUBLIC routes that don't require a live Canva OAuth client:
 * - /agent-connect-canva renders the "Connect your Canva account" page and
 *   handles a missing/garbage token gracefully (error UI, not a crash).
 * - /agent-connect-canva/callback renders and reports an error on a missing
 *   code/state.
 * - POST /api/agent/consent-link is auth-gated (401 without the shared secret).
 *
 * The full happy path — mint a valid kind:canva JWT → click "Connect Canva" →
 * assert a well-formed https://www.canva.com/api/oauth/authorize URL with
 * code_challenge_method=S256 + scope + state — additionally requires the
 * populated psd-agent/{env}/canva-oauth-client secret and a seeded consent
 * nonce, i.e. Canva Developer Portal setup. That is exercised agent-executed
 * after deploy (issue #1176 "Full OAuth round-trip") and is out of scope for
 * the gated suite, exactly like the Google Workspace connect spec.
 */

const SHOT_DIR = process.env.PSD_SCREENSHOT_DIR ?? '.verification'
mkdirSync(SHOT_DIR, { recursive: true })

test.describe('Agent Connect (Canva) — public consent page', () => {
  test('missing token renders the consent page with an error, not a crash', async ({ page }) => {
    const resp = await page.goto('/agent-connect-canva')
    expect(resp).not.toBeNull()
    // The heading always renders; the body shows a "missing token" error.
    await expect(page.getByRole('heading', { name: /Connect your Canva account/i })).toBeVisible()
    await expect(page.locator('body')).toContainText(/missing|invalid|expired|link/i)
    await page.screenshot({ path: join(SHOT_DIR, 'canva-consent-page-missing-token.png'), fullPage: true })
  })

  test('garbage token shows an error, not a crash', async ({ page }) => {
    const resp = await page.goto('/agent-connect-canva?token=not-a-real-jwt')
    expect(resp).not.toBeNull()
    await expect(page.getByRole('heading', { name: /Connect your Canva account/i })).toBeVisible()
    await expect(page.locator('body')).toContainText(/invalid|expired|error|link|configured/i)
    await page.screenshot({ path: join(SHOT_DIR, 'canva-consent-page-invalid-token.png'), fullPage: true })
  })

  test('callback with no state shows an error, not a crash', async ({ page }) => {
    const resp = await page.goto('/agent-connect-canva/callback')
    expect(resp).not.toBeNull()
    await expect(page.locator('body')).toContainText(/missing|invalid|expired|error|connect/i)
    await page.screenshot({ path: join(SHOT_DIR, 'canva-consent-callback-no-state.png'), fullPage: true })
  })
})

test.describe('Agent Consent Link API — canva kind auth gate', () => {
  test('POST /api/agent/consent-link without Authorization returns 401', async ({ request }) => {
    const resp = await request.post('/api/agent/consent-link', {
      data: { ownerEmail: 'hagelk@psd401.net', kind: 'canva' },
    })
    expect(resp.status()).toBe(401)
  })

  test('POST /api/agent/consent-link with wrong bearer returns 401', async ({ request }) => {
    const resp = await request.post('/api/agent/consent-link', {
      headers: { Authorization: 'Bearer not-the-real-key' },
      data: { ownerEmail: 'hagelk@psd401.net', kind: 'canva' },
    })
    expect(resp.status()).toBe(401)
  })
})
