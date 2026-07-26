import { test, expect } from './fixtures'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * E2E tests for the Agent Connect (Canva) consent flow (Issue #1176).
 *
 * Flow: `canva-consent-page`.
 *
 * Covers the authorization boundary without requiring a live Canva client:
 * - /agent-connect-canva and its callback require an AI Studio session before
 *   processing any signed link, nonce, provider code, or credential.
 * - POST /api/agent/consent-link is gated by a router-signed invocation context.
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

test.describe('Agent Connect (Canva) — authenticated owner gate', () => {
  test('missing token cannot bypass sign-in', async ({ page }) => {
    const resp = await page.goto('/agent-connect-canva')
    expect(resp).not.toBeNull()
    await expect(page).toHaveURL(/api\/auth\/signin|auth|login/i)
    await page.screenshot({ path: join(SHOT_DIR, 'canva-consent-page-missing-token.png'), fullPage: true })
  })

  test('garbage token cannot bypass sign-in', async ({ page }) => {
    const resp = await page.goto('/agent-connect-canva?token=not-a-real-jwt')
    expect(resp).not.toBeNull()
    await expect(page).toHaveURL(/api\/auth\/signin|auth|login/i)
    await page.screenshot({ path: join(SHOT_DIR, 'canva-consent-page-invalid-token.png'), fullPage: true })
  })

  test('callback cannot exchange a provider code without sign-in', async ({ page }) => {
    const resp = await page.goto('/agent-connect-canva/callback')
    expect(resp).not.toBeNull()
    await expect(page).toHaveURL(/api\/auth\/signin|auth|login/i)
    await page.screenshot({ path: join(SHOT_DIR, 'canva-consent-callback-no-state.png'), fullPage: true })
  })
})

test.describe('Agent Consent Link API — canva kind auth gate', () => {
  test('POST /api/agent/consent-link without signed context returns 403', async ({ request }) => {
    const resp = await request.post('/api/agent/consent-link', {
      data: { ownerEmail: 'hagelk@psd401.net', kind: 'canva' },
    })
    expect(resp.status()).toBe(403)
  })

  test('POST /api/agent/consent-link with a legacy bearer still returns 403', async ({ request }) => {
    const resp = await request.post('/api/agent/consent-link', {
      headers: { Authorization: 'Bearer not-the-real-key' },
      data: { ownerEmail: 'hagelk@psd401.net', kind: 'canva' },
    })
    expect(resp.status()).toBe(403)
  })
})
