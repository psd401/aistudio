/**
 * Edge Runtime compatible client for token refresh operations
 *
 * This module handles token refresh by calling server actions that run in Node.js runtime
 * instead of trying to use AWS SDK directly in Edge Runtime.
 */

import type { JWT } from "next-auth/jwt"
import { createLogger } from "@/lib/auth/edge-logger"

interface RefreshedTokens {
  accessToken: string
  idToken: string
  refreshToken?: string
  expiresAt: number
}

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
 * Refreshes AWS Cognito tokens by calling the server action
 * This avoids Edge Runtime compatibility issues with AWS SDK
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
    log.info("Attempting token refresh via server action", {
      tokenSub: token.sub,
      tokenExpiresAt: token.expiresAt ? new Date(token.expiresAt as number).toISOString() : 'unknown'
    })

    // Call the server action for token refresh
    const { refreshCognitoToken } = await import("@/actions/auth/refresh-token-action")
    const result = await refreshCognitoToken({
      refreshToken,
      tokenSub: token.sub as string
    })

    if (result.isSuccess && result.data) {
      log.info("Token refresh successful", {
        tokenSub: token.sub,
        newExpiresAt: new Date(result.data.expiresAt).toISOString()
      })

      return result.data
    } else {
      log.warn("Token refresh failed", {
        tokenSub: token.sub,
        message: result.message
      })
      return null
    }

  } catch (error) {
    log.error("Token refresh threw error", {
      error: error instanceof Error ? error.message : 'Unknown error',
      errorName: error instanceof Error ? error.name : 'Unknown',
      tokenSub: token.sub
    })

    return null
  }
}