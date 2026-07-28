/**
 * Edge Runtime compatible client for token refresh operations
 *
 * This module is loaded by `auth.ts`, which `middleware.ts` compiles into the
 * Edge Runtime sandbox. Everything reachable from here must therefore be
 * Edge-safe.
 *
 * It used to `await import("@/actions/auth/refresh-token-action")` on the
 * assumption that a `"use server"` action would execute in the Node runtime.
 * It does not: importing a server action from server/Edge code inlines the
 * implementation into the *calling* runtime's bundle, which dragged
 * `@/lib/logger` → `winston` into middleware and made every refresh throw
 * `TypeError: Native module not found: winston` (#1297). The exchange now runs
 * natively on Edge primitives — see `@/lib/auth/cognito-refresh`.
 */

import type { JWT } from "next-auth/jwt"
import { createLogger } from "@/lib/auth/edge-logger"
import { refreshCognitoTokens, type RefreshedTokens } from "@/lib/auth/cognito-refresh"

const log = createLogger({ context: "token-refresh-client" })

/**
 * Intelligent token refresh timing for long-running operations
 * Adapts refresh threshold based on operation context
 *
 * @param token - JWT token to check
 * @param options - Refresh configuration options
 * @returns boolean - true if token should be refreshed
 */
export function shouldRefreshToken(
  token: JWT,
  options: {
    isLongRunningOperation?: boolean;
    operationType?: 'polling' | 'streaming' | 'normal';
    estimatedDurationMs?: number;
  } = {}
): boolean {
  if (!token.expiresAt) {
    return false
  }

  const expiresAt = token.expiresAt as number
  const now = Date.now()
  const timeUntilExpiry = expiresAt - now

  // If already expired, definitely refresh
  if (timeUntilExpiry <= 0) {
    return true
  }

  // Use stored token lifetime from JWT creation, with fallback
  const tokenWithLifetime = token as JWT & { tokenLifetimeMs?: number }
  const tokenLifetime = tokenWithLifetime.tokenLifetimeMs ||
    (Number.parseInt(process.env.COGNITO_ACCESS_TOKEN_LIFETIME_SECONDS || "3600") * 1000)

  // Adaptive refresh threshold based on operation type
  let refreshThresholdPercent = 0.25; // Default 25%

  if (options.isLongRunningOperation || options.operationType === 'polling') {
    // For long operations, refresh much earlier to prevent mid-operation expiry
    refreshThresholdPercent = 0.50; // 50% - refresh at 30 min for 1-hour tokens

    // If we know the operation duration, ensure token lasts the entire operation
    if (options.estimatedDurationMs) {
      const safetyMargin = options.estimatedDurationMs * 1.5; // 50% safety margin
      const requiredThreshold = safetyMargin / tokenLifetime;
      refreshThresholdPercent = Math.max(refreshThresholdPercent, Math.min(requiredThreshold, 0.8));
    }
  } else if (options.operationType === 'streaming') {
    // Streaming operations need consistent tokens
    refreshThresholdPercent = 0.40; // 40%
  }

  const refreshThreshold = tokenLifetime * refreshThresholdPercent
  const shouldRefresh = timeUntilExpiry <= refreshThreshold

  if (shouldRefresh) {
    log.debug("Token should be refreshed proactively", {
      tokenSub: token.sub,
      timeUntilExpiryMinutes: Math.round(timeUntilExpiry / (1000 * 60)),
      refreshThresholdMinutes: Math.round(refreshThreshold / (1000 * 60)),
      tokenLifetimeHours: Math.round(tokenLifetime / (1000 * 60 * 60)),
      thresholdPercent: Math.round(refreshThresholdPercent * 100),
      operationType: options.operationType || 'normal',
      isLongRunning: !!options.isLongRunningOperation
    })
  }

  return shouldRefresh
}

/**
 * Refreshes AWS Cognito tokens by calling `refreshCognitoTokens` directly.
 *
 * This runs in the caller's runtime — including Edge, since `middleware.ts`
 * pulls `auth.ts` and its callbacks into the Edge bundle. It is NOT an RPC hop:
 * the retired `"use server"` action was only ever a boundary when imported by a
 * *client* component, which is why it was inlined into `middleware.js` along
 * with winston and the AWS SDK (#1297). `refreshCognitoTokens` uses `fetch` and
 * `@/lib/auth/edge-logger` so it is safe in either runtime.
 *
 * See `docs/guides/edge-runtime-boundaries.md`.
 *
 * @param token - Current JWT token containing refresh token
 * @returns Promise<RefreshedTokens | null> - New tokens or null if refresh failed
 */
export async function refreshAccessToken(token: JWT): Promise<RefreshedTokens | null> {
  // Input validation
  if (!token || typeof token !== 'object') {
    log.warn("Invalid token object provided to refreshAccessToken")
    return null
  }

  if (!token.sub || typeof token.sub !== 'string') {
    log.warn("Token missing required sub field")
    return null
  }

  const refreshToken = token.refreshToken as string

  if (!refreshToken || typeof refreshToken !== 'string' || refreshToken.length < 10) {
    log.warn("Invalid or missing refresh token", { tokenSub: token.sub })
    return null
  }

  try {
    log.info("Attempting token refresh", {
      tokenSub: token.sub,
      tokenExpiresAt: token.expiresAt ? new Date(token.expiresAt as number).toISOString() : 'unknown'
    })

    // Long-running/polling requests get a larger rate-limit budget. The retired
    // action read this same flag internally, so this preserves its behaviour
    // rather than adding one — but be aware of two pre-existing limitations:
    // it is a PROCESS-wide global (one user's polling widens everyone's budget
    // in that task), and it is set on the Node global by the polling adapter,
    // which the Edge sandbox cannot see — so on the middleware path it is always
    // false. `auth.ts` reads it the same way for `isLongRunningOperation`.
    // TODO: Replace with AsyncLocalStorage for request-scoped context isolation
    const isPollingContext = !!(globalThis as { __POLLING_CONTEXT__?: boolean }).__POLLING_CONTEXT__

    const result = await refreshCognitoTokens({
      refreshToken,
      tokenSub: token.sub as string,
      isPollingContext
    })

    if (result.ok) {
      log.info("Token refresh successful", {
        tokenSub: token.sub,
        newExpiresAt: new Date(result.tokens.expiresAt).toISOString()
      })

      return result.tokens
    }

    // Every failure reason fails closed — the caller forces re-authentication.
    // The reason is logged so a revoked token is distinguishable from an outage.
    log.warn("Token refresh failed", {
      tokenSub: token.sub,
      reason: result.reason,
      message: result.message
    })
    return null

  } catch (error) {
    log.error("Token refresh threw error", {
      error: error instanceof Error ? error.message : 'Unknown error',
      errorName: error instanceof Error ? error.name : 'Unknown',
      tokenSub: token.sub
    })

    return null
  }
}