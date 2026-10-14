import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { validatedFs } from '@/lib/filesystem/validated-fs'
import { test, expect } from './fixtures'
import {
  authenticateContext,
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_SUB,
  SEEDED_STAFF_EMAIL,
  SEEDED_STAFF_SUB,
} from './helpers/session-auth'

/**
 * E2E for the one-time credential entry flow (issue #1887).
 *
 * Flow: `agent-credential-entry`.
 *
 * Agents used to ask staff to paste API keys into chat. This page replaces
 * that: the agent mints a one-time link, the user types the secret into a
 * password field, and the value goes straight to the credential broker.
 *
 * Two tiers:
 *
 *  - GUARD (always runs, unauthenticated): a link cannot be used without a
 *    session, a garbage token is refused, and the mint API is closed to
 *    unsigned callers.
 *
 *  - FUNCTIONAL (PLAYWRIGHT_AUTH_ENABLED=true, host :3100 dev server + seeded
 *    users + local Postgres — see docs/guides/e2e-authenticated-testing.md):
 *    mints a real consent token against a seeded nonce and drives the page as
 *    the owner, as a different user, and against a spent link.
 *
 * NOT covered here, deliberately: submitting a VALID value. The broker writes
 * to AWS Secrets Manager, which a local dev server does not have — and the one
 * environment where it would succeed is dev AWS, so a green run would litter
 * real secrets. The success render is pinned by the component test
 * (tests/unit/credential-entry-form.test.tsx) and the claim/write ordering by
 * tests/unit/agent-credential-entry.test.ts. The valid-value path is verified
 * agent-executed after deploy, the same way the Canva consent round-trip is.
 */

const SHOT_DIR = process.env.PSD_SCREENSHOT_DIR ?? '.verification'
const CREDENTIAL_NAME = 'freshservice_api_key'
const DB_URL =
  process.env.E2E_DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/aistudio'

validatedFs.mkdirSync(SHOT_DIR, { recursive: true })

async function shot(
  page: import('@playwright/test').Page,
  name: string
): Promise<void> {
  await page.screenshot({ path: join(SHOT_DIR, `${name}.png`), fullPage: true })
}

// ---------------------------------------------------------------------------
// Guard tier — no session, no seeded data, CI-safe.
// ---------------------------------------------------------------------------

test.describe('Agent credential entry — guard', () => {
  // `/agent-connect-credential` is deliberately NOT in middleware's
  // PUBLIC_PATHS (same class as canva/plaud/aistudio): the secret lands in a
  // local owner's credential slot, so a signed link alone is not enough — a
  // live session is the second factor that stops a leaked link from opening a
  // secret-entry form for whoever found it.
  test('an anonymous visitor is sent to sign-in, not to a form', async ({
    page,
  }) => {
    const resp = await page.goto('/agent-connect-credential')
    expect(resp).not.toBeNull()
    await expect(page).toHaveURL(/api\/auth\/signin|auth|login/i)
    // The decisive assertion: no field that would accept a secret.
    await expect(page.locator('input[type="password"]')).toHaveCount(0)
    await shot(page, 'agent-credential-entry-anonymous-redirect')
  })

  test('a signed link cannot bypass sign-in', async ({ page }) => {
    const resp = await page.goto('/agent-connect-credential?token=not-a-real-jwt')
    expect(resp).not.toBeNull()
    await expect(page).toHaveURL(/api\/auth\/signin|auth|login/i)
    await expect(page.locator('input[type="password"]')).toHaveCount(0)
    await shot(page, 'agent-credential-entry-token-no-session')
  })

  test('POST /api/agent/consent-link credential_entry needs a signed context', async ({
    request,
  }) => {
    const resp = await request.post('/api/agent/consent-link', {
      data: {
        ownerEmail: 'hagelk@psd401.net',
        kind: 'credential_entry',
        name: CREDENTIAL_NAME,
      },
    })
    expect(resp.status()).toBe(403)
  })

  test('a legacy bearer cannot mint a credential_entry link either', async ({
    request,
  }) => {
    const resp = await request.post('/api/agent/consent-link', {
      headers: { Authorization: 'Bearer not-the-real-key' },
      data: { kind: 'credential_entry', name: CREDENTIAL_NAME },
    })
    expect(resp.status()).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// Functional tier — real token, seeded nonce, authenticated sessions.
// ---------------------------------------------------------------------------

type Postgres = Awaited<ReturnType<typeof openDb>>

async function openDb() {
  const postgres = (await import('postgres')).default
  return postgres(DB_URL, { max: 1, ssl: false })
}

/** Insert a consent nonce and return a signed credential-entry link for it. */
async function mintEntryLink(
  sql: Postgres,
  ownerEmail: string,
  options: { consumed?: boolean } = {}
): Promise<{ token: string; nonce: string }> {
  const secret = process.env.AUTH_SECRET
  if (!secret) {
    throw new Error(
      'AUTH_SECRET is not set — `set -a && source .env.local && set +a` before running this spec'
    )
  }
  const nonce = randomBytes(32).toString('hex')
  const [localPart, domain] = ownerEmail.split('@')
  const agentEmail = `agnt_${localPart}@${domain}`
  await sql`
    INSERT INTO psd_agent_workspace_consent_nonces
      (nonce, owner_email, agent_email, token_kind, consumed_at)
    VALUES (
      ${nonce}, ${ownerEmail}, ${agentEmail}, 'credential_entry',
      ${options.consumed ? new Date() : null}
    )
  `
  const { SignJWT } = await import('jose')
  const token = await new SignJWT({
    sub: ownerEmail,
    agent: agentEmail,
    purpose: 'workspace-consent',
    nonce,
    kind: 'credential_entry',
    cred: CREDENTIAL_NAME,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(new TextEncoder().encode(secret))
  return { token, nonce }
}

test.describe('Agent credential entry — functional', () => {
  test.skip(
    process.env.PLAYWRIGHT_AUTH_ENABLED !== 'true',
    'Requires an authenticated session + local Postgres against the host :3100 dev server — see docs/guides/e2e-authenticated-testing.md'
  )

  test('a signed-in user with a garbage token gets a refusal, not a form', async ({
    page,
  }) => {
    await authenticateContext(
      page.context(),
      SEEDED_ADMIN_EMAIL,
      SEEDED_ADMIN_SUB
    )
    await page.goto('/agent-connect-credential?token=not-a-real-jwt')
    await expect(page.getByTestId('credential-entry-invalid')).toBeVisible({
      timeout: 20000,
    })
    await expect(page.locator('input[type="password"]')).toHaveCount(0)
    await shot(page, 'agent-credential-entry-invalid-token')
  })

  test('the owner gets a password field, and a bad value does not spend the link', async ({
    page,
  }) => {
    const sql = await openDb()
    let nonce: string | undefined
    try {
      const link = await mintEntryLink(sql, SEEDED_ADMIN_EMAIL)
      nonce = link.nonce
      await authenticateContext(
        page.context(),
        SEEDED_ADMIN_EMAIL,
        SEEDED_ADMIN_SUB
      )
      await page.goto(
        `/agent-connect-credential?token=${encodeURIComponent(link.token)}`
      )

      const input = page.getByTestId('credential-entry-input')
      await expect(input).toBeVisible({ timeout: 20000 })
      // The field must mask what is typed into it.
      await expect(input).toHaveAttribute('type', 'password')
      // ...and be reachable by its label. Asserted here rather than in the
      // component test because jest mocks Radix's Label into a <div>, which
      // drops the htmlFor/id association.
      await expect(page.getByLabel('Credential value')).toBeVisible()
      // The slot the agent asked for is named so the user knows what to paste.
      await expect(page.getByText(CREDENTIAL_NAME).first()).toBeVisible()
      // No GET form: a GET submit would push the typed secret into the URL,
      // the browser history, and the access log.
      expect(await page.locator('form[method="get" i]').count()).toBe(0)
      await shot(page, 'agent-credential-entry-form')

      // A value the broker would reject must come back as an inline error —
      // and must NOT burn the one-time link.
      await input.fill('short')
      await page.getByTestId('credential-entry-submit').click()
      await expect(page.getByTestId('credential-entry-error')).toBeVisible({
        timeout: 20000,
      })
      await shot(page, 'agent-credential-entry-invalid-value')

      const [row] = await sql<{ consumed_at: Date | null }[]>`
        SELECT consumed_at FROM psd_agent_workspace_consent_nonces
        WHERE nonce = ${link.nonce}
      `
      expect(row?.consumed_at).toBeNull()

      // ...so reloading still offers the form.
      await page.reload()
      await expect(page.getByTestId('credential-entry-input')).toBeVisible({
        timeout: 20000,
      })
    } finally {
      if (nonce) {
        await sql`DELETE FROM psd_agent_workspace_consent_nonces WHERE nonce = ${nonce}`
      }
      await sql.end({ timeout: 5 })
    }
  })

  test('a spent link is refused and shows no input', async ({ page }) => {
    const sql = await openDb()
    let nonce: string | undefined
    try {
      const link = await mintEntryLink(sql, SEEDED_ADMIN_EMAIL, {
        consumed: true,
      })
      nonce = link.nonce
      await authenticateContext(
        page.context(),
        SEEDED_ADMIN_EMAIL,
        SEEDED_ADMIN_SUB
      )
      await page.goto(
        `/agent-connect-credential?token=${encodeURIComponent(link.token)}`
      )

      await expect(page.getByTestId('credential-entry-used')).toBeVisible({
        timeout: 20000,
      })
      await expect(page.locator('input[type="password"]')).toHaveCount(0)
      await shot(page, 'agent-credential-entry-already-used')
    } finally {
      if (nonce) {
        await sql`DELETE FROM psd_agent_workspace_consent_nonces WHERE nonce = ${nonce}`
      }
      await sql.end({ timeout: 5 })
    }
  })

  test("another user's link is refused and shows no input", async ({ page }) => {
    const sql = await openDb()
    let nonce: string | undefined
    try {
      // Link minted for the admin...
      const link = await mintEntryLink(sql, SEEDED_ADMIN_EMAIL)
      nonce = link.nonce
      // ...opened by the staff user.
      await authenticateContext(
        page.context(),
        SEEDED_STAFF_EMAIL,
        SEEDED_STAFF_SUB
      )
      await page.goto(
        `/agent-connect-credential?token=${encodeURIComponent(link.token)}`
      )

      await expect(page.getByTestId('credential-entry-wrong-user')).toBeVisible({
        timeout: 20000,
      })
      await expect(page.locator('input[type="password"]')).toHaveCount(0)
      await shot(page, 'agent-credential-entry-wrong-user')

      // The refusal must not have spent the owner's link.
      const [row] = await sql<{ consumed_at: Date | null }[]>`
        SELECT consumed_at FROM psd_agent_workspace_consent_nonces
        WHERE nonce = ${link.nonce}
      `
      expect(row?.consumed_at).toBeNull()
    } finally {
      if (nonce) {
        await sql`DELETE FROM psd_agent_workspace_consent_nonces WHERE nonce = ${nonce}`
      }
      await sql.end({ timeout: 5 })
    }
  })
})
