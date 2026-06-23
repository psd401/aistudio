import { encode } from 'next-auth/jwt'
import type { BrowserContext } from '@playwright/test'

/**
 * Authenticated-E2E helper (Issue #928 functional coverage).
 *
 * Mints a NextAuth (Auth.js v5) session cookie directly so authenticated UI
 * flows can run locally WITHOUT the Cognito login round-trip. The app resolves
 * the user by cognito_sub then falls back to EMAIL, so email 'test@example.com'
 * maps to the seeded admin (run `bun run db:seed`), which holds every capability.
 *
 * Requires AUTH_SECRET in the environment (source .env.local before running):
 *   set -a && source .env.local && set +a
 *   PLAYWRIGHT_AUTH_ENABLED=true bunx playwright test --config <cfg> tests/e2e/<spec>
 *
 * The dev cookie is non-secure (NODE_ENV !== production) → cookie name
 * 'authjs.session-token'. See the project memory "Playwright Nexus harness".
 */

const DEV_SESSION_COOKIE = 'authjs.session-token'
// Long enough that shouldRefreshToken() (auth.ts) does NOT proactively refresh —
// it refreshes when remaining < 25% of tokenLifetimeMs. We mint a full-lifetime
// token (remaining == lifetime) so the fake refresh token is never exercised.
const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000

export const SEEDED_ADMIN_EMAIL = 'test@example.com'

export async function mintSessionToken(
  email: string = SEEDED_ADMIN_EMAIL
): Promise<string> {
  const secret = process.env.AUTH_SECRET
  if (!secret) {
    throw new Error(
      'AUTH_SECRET is not set — `set -a && source .env.local && set +a` before running authenticated e2e specs'
    )
  }

  return encode({
    salt: DEV_SESSION_COOKIE,
    secret,
    maxAge: SESSION_LIFETIME_MS / 1000,
    token: {
      sub: 'e2e-test-user',
      email,
      name: 'E2E Test',
      expiresAt: Date.now() + SESSION_LIFETIME_MS,
      tokenLifetimeMs: SESSION_LIFETIME_MS,
      // Explicitly-labeled placeholders (not 'x'): if any code path ever forwards
      // these to Cognito or a downstream AWS service, it fails loudly with a
      // recognizable value instead of silently passing a single-char token.
      accessToken: 'e2e-placeholder-not-a-real-token',
      idToken: 'e2e-placeholder-not-a-real-token',
      refreshToken: 'e2e-placeholder-not-a-real-token',
    },
  })
}

/** Inject a minted session cookie into a Playwright browser context. */
export async function authenticateContext(
  context: BrowserContext,
  email: string = SEEDED_ADMIN_EMAIL
): Promise<void> {
  // This harness mints a NON-secure dev cookie ('authjs.session-token'). A
  // production build uses the secure '__Secure-' prefixed cookie, so injecting
  // this cookie against a non-localhost target is silently ignored and every
  // request 401s — a failure mode indistinguishable from a missing AUTH_SECRET.
  // Fail loudly instead.
  const baseUrl = process.env.PLAYWRIGHT_BASE_URL
  if (baseUrl && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(baseUrl)) {
    throw new Error(
      `Authenticated E2E tests must run against localhost — the dev session cookie ` +
        `is non-secure and is ignored by production builds. PLAYWRIGHT_BASE_URL=${baseUrl}`
    )
  }
  const value = await mintSessionToken(email)
  await context.addCookies([
    {
      name: DEV_SESSION_COOKIE,
      value,
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ])
}
