"use server"

import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  InitiateAuthCommandInput,
  AuthFlowType
} from "@aws-sdk/client-cognito-identity-provider"
import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import { handleError, createSuccess } from "@/lib/error-utils"
import type { ActionState } from "@/types/actions-types"

interface RefreshTokenParams {
  refreshToken: string
  tokenSub: string
}

interface RefreshedTokens {
  accessToken: string
  idToken: string
  refreshToken?: string
  expiresAt: number
}

interface CognitoRefreshResponse {
  AuthenticationResult?: {
    AccessToken?: string
    IdToken?: string
    RefreshToken?: string
    ExpiresIn?: number
  }
}

// Intelligent rate limiting configuration
const MAX_REFRESH_ATTEMPTS = 8 // Increased for long polling operations
const RATE_LIMIT_WINDOW_MS = 90 * 1000 // 90 second window for polling operations
const MAX_RATE_LIMIT_ENTRIES = 1000 // Max users to track
const POLLING_CONTEXT_MULTIPLIER = 1.5 // Extra allowance for polling operations

// Use a Map with size-based cleanup for better memory management
const refreshAttempts = new Map<string, { count: number; lastAttempt: number; windowStart: number }>()
let lastCleanupTime = 0
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

// Promise deduplication to prevent concurrent refresh requests for the same user
const activeRefreshPromises = new Map<string, Promise<ActionState<RefreshedTokens>>>()

/**
 * Deterministic cleanup of expired rate limiting entries
 * Runs based on time intervals and map size to prevent memory leaks
 */
function cleanupRateLimitingEntries(): void {
  const now = Date.now()
  const expiredThreshold = now - (RATE_LIMIT_WINDOW_MS * 2)

  // Remove expired entries
  for (const [userId, attempts] of refreshAttempts.entries()) {
    if (attempts.windowStart < expiredThreshold) {
      refreshAttempts.delete(userId)
    }
  }

  // If still too many entries, remove oldest ones (LRU-style cleanup)
  if (refreshAttempts.size > MAX_RATE_LIMIT_ENTRIES) {
    const entries = Array.from(refreshAttempts.entries())
    entries.sort((a, b) => a[1].lastAttempt - b[1].lastAttempt)

    const toRemove = refreshAttempts.size - MAX_RATE_LIMIT_ENTRIES
    for (let i = 0; i < toRemove; i++) {
      refreshAttempts.delete(entries[i][0])
    }
  }

  // Also cleanup stale promise deduplication entries
  // (Note: Promises are automatically cleaned up when they resolve/reject)
  if (activeRefreshPromises.size > MAX_RATE_LIMIT_ENTRIES) {
    // Clear all if too many accumulate (they should auto-clean, but safety measure)
    activeRefreshPromises.clear()
  }

  lastCleanupTime = now
}

/**
 * Checks if cleanup should run based on time and size thresholds
 */
function shouldRunCleanup(): boolean {
  const now = Date.now()

  // Run cleanup if interval has passed OR if map is getting too large
  return (now - lastCleanupTime > CLEANUP_INTERVAL_MS) ||
         (refreshAttempts.size > MAX_RATE_LIMIT_ENTRIES * 0.8)
}

/**
 * Checks if a user has exceeded the rate limit for token refresh attempts
 * Implements intelligent rate limiting with polling operation awareness
 *
 * @param userId - User identifier (token.sub)
 * @param isPollingContext - Whether this is part of a polling operation
 * @returns boolean - true if rate limited, false if allowed
 */
function isRateLimited(userId: string, isPollingContext = false): boolean {
  const now = Date.now()

  // Run cleanup deterministically based on time and size
  if (shouldRunCleanup()) {
    cleanupRateLimitingEntries()
  }

  const attempts = refreshAttempts.get(userId)

  if (!attempts) {
    // First attempt, record it
    refreshAttempts.set(userId, {
      count: 1,
      lastAttempt: now,
      windowStart: now
    })
    return false
  }

  // Check if we're in a new time window
  if (now - attempts.windowStart >= RATE_LIMIT_WINDOW_MS) {
    // Reset the window
    refreshAttempts.set(userId, {
      count: 1,
      lastAttempt: now,
      windowStart: now
    })
    return false
  }

  // Check if we've exceeded the limit within the current window
  // Apply higher limits for polling contexts
  const effectiveLimit = isPollingContext
    ? Math.ceil(MAX_REFRESH_ATTEMPTS * POLLING_CONTEXT_MULTIPLIER)
    : MAX_REFRESH_ATTEMPTS;

  if (attempts.count >= effectiveLimit) {
    return true
  }

  // Increment attempt count
  refreshAttempts.set(userId, {
    count: attempts.count + 1,
    lastAttempt: now,
    windowStart: attempts.windowStart
  })

  return false
}

/**
 * Server action to refresh AWS Cognito tokens
 * Runs in Node.js runtime to avoid Edge Runtime compatibility issues with AWS SDK
 *
 * @param params - Refresh token parameters
 * @returns Promise<ActionState<RefreshedTokens>> - Action result with new tokens or error
 */
export async function refreshCognitoToken(params: RefreshTokenParams): Promise<ActionState<RefreshedTokens>> {
  const requestId = generateRequestId()
  const timer = startTimer("refreshCognitoToken")
  const log = createLogger({ requestId, action: "refreshCognitoToken" })

  // Check if there's already a refresh in progress for this user
  const existingRefresh = activeRefreshPromises.get(params.tokenSub)
  if (existingRefresh) {
    log.info("Token refresh already in progress, returning existing promise", {
      tokenSub: params.tokenSub
    })
    return existingRefresh
  }

  // Create the refresh promise
  const refreshPromise = performTokenRefresh(params, requestId, timer, log)

  // Store the promise for deduplication
  activeRefreshPromises.set(params.tokenSub, refreshPromise)

  // Clean up the promise when it completes (success or failure)
  refreshPromise.finally(() => {
    activeRefreshPromises.delete(params.tokenSub)
  })

  return refreshPromise
}

/**
 * Internal function that performs the actual token refresh logic
 */
async function performTokenRefresh(
  params: RefreshTokenParams,
  requestId: string,
  timer: ReturnType<typeof startTimer>,
  log: ReturnType<typeof createLogger>
): Promise<ActionState<RefreshedTokens>> {
  try {
    log.info("Token refresh action started", {
      tokenSub: params.tokenSub
    })

    // Input validation
    if (!params.refreshToken || typeof params.refreshToken !== 'string' || params.refreshToken.length < 10) {
      log.warn("Invalid refresh token provided", { tokenSub: params.tokenSub })
      throw new Error("Invalid refresh token")
    }

    if (!params.tokenSub || typeof params.tokenSub !== 'string') {
      log.warn("Invalid token sub provided")
      throw new Error("Invalid token sub")
    }

    // Check rate limiting with polling context awareness
    // TODO: Replace with AsyncLocalStorage for request-scoped context isolation
    const isPollingContext = typeof global !== 'undefined' && (global as { __POLLING_CONTEXT__?: boolean }).__POLLING_CONTEXT__;
    if (isRateLimited(params.tokenSub, isPollingContext)) {
      log.warn("Token refresh blocked due to rate limiting", {
        tokenSub: params.tokenSub,
        isPollingContext
      });
      throw new Error("Rate limit exceeded. Please try again later.")
    }

    // Cleanup is now handled deterministically in isRateLimited()

    const clientId = process.env.AUTH_COGNITO_CLIENT_ID
    if (!clientId) {
      log.error("AUTH_COGNITO_CLIENT_ID environment variable not set")
      throw new Error("Authentication configuration error")
    }

    const awsRegion = process.env.AWS_REGION
    if (!awsRegion) {
      log.error("AWS_REGION environment variable not set")
      throw new Error("AWS region configuration required")
    }

    log.info("Attempting Cognito token refresh", { tokenSub: params.tokenSub })

    const client = new CognitoIdentityProviderClient({
      region: awsRegion
    })

    const authParams: InitiateAuthCommandInput = {
      AuthFlow: AuthFlowType.REFRESH_TOKEN_AUTH,
      ClientId: clientId,
      AuthParameters: {
        REFRESH_TOKEN: params.refreshToken
      }
    }

    const command = new InitiateAuthCommand(authParams)
    const response: CognitoRefreshResponse = await client.send(command)

    if (!response.AuthenticationResult) {
      log.warn("Token refresh failed - no authentication result returned", {
        tokenSub: params.tokenSub
      })
      throw new Error("Token refresh failed")
    }

    const authResult = response.AuthenticationResult
    const defaultTokenLifetimeSeconds = parseInt(process.env.COGNITO_ACCESS_TOKEN_LIFETIME_SECONDS || "3600")
    const newExpiresAt = Date.now() + ((authResult.ExpiresIn || defaultTokenLifetimeSeconds) * 1000)

    if (!authResult.AccessToken || !authResult.IdToken) {
      log.warn("Token refresh failed - missing required tokens", {
        tokenSub: params.tokenSub,
        hasAccessToken: !!authResult.AccessToken,
        hasIdToken: !!authResult.IdToken
      })
      throw new Error("Incomplete token refresh response")
    }

    log.info("Token refresh successful", {
      tokenSub: params.tokenSub,
      newExpiresAt: new Date(newExpiresAt).toISOString(),
      hasNewRefreshToken: !!authResult.RefreshToken,
      expiresInSeconds: authResult.ExpiresIn || 3600
    })

    const refreshedTokens: RefreshedTokens = {
      accessToken: authResult.AccessToken,
      idToken: authResult.IdToken,
      // Use new refresh token if provided, otherwise keep existing one
      refreshToken: authResult.RefreshToken || params.refreshToken,
      expiresAt: newExpiresAt
    }

    timer({ status: "success" })
    log.info("Token refresh action completed successfully")
    return createSuccess(refreshedTokens, "Token refreshed successfully")

  } catch (error) {
    timer({ status: "error" })

    // Check for specific Cognito errors that indicate permanent failure
    if (error instanceof Error) {
      const errorMessage = error.message.toLowerCase()
      if (errorMessage.includes('refresh token is expired') ||
          errorMessage.includes('invalid refresh token') ||
          errorMessage.includes('refresh token has been revoked')) {
        log.warn("Refresh token is permanently invalid - user needs to re-authenticate", {
          tokenSub: params.tokenSub,
          errorType: 'permanent_failure'
        })
      }
    }

    return handleError(error, "Failed to refresh authentication token. Please sign in again.", {
      context: "refreshCognitoToken",
      requestId,
      operation: "refreshCognitoToken",
      metadata: {
        tokenSub: params.tokenSub,
        errorType: "token_refresh_failed"
      }
    })
  }
}