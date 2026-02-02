/**
 * Per-Key API Rate Limiter
 * Sliding window rate limiting using api_key_usage table.
 * Part of Epic #674 (External API Platform) - Issue #677
 *
 * Strategy:
 * - COUNT requests in api_key_usage where request_at > NOW() - 1 minute
 * - Default: 60 req/min (configurable per key via rate_limit_rpm)
 * - Returns 429 with Retry-After + X-RateLimit-* headers when exceeded
 * - Usage records double as analytics (endpoint, method, status_code, response_time_ms)
 *
 * Design decisions:
 * - Database-backed for accuracy across multiple server instances
 * - Fire-and-forget usage logging (non-blocking)
 * - Session-based auth bypasses per-key rate limiting (uses existing rate-limit.ts)
 */

import { NextRequest, NextResponse } from "next/server";
import { executeQuery } from "@/lib/db/drizzle-client";
import { apiKeyUsage, apiKeys } from "@/lib/db/schema";
import { eq, and, gte, count } from "drizzle-orm";
import { createLogger } from "@/lib/logger";
import type { ApiAuthContext } from "./auth-middleware";
import { createErrorResponse } from "./auth-middleware";

// ============================================
// Types
// ============================================

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number; // Unix timestamp in seconds
  retryAfterSeconds?: number;
}

// ============================================
// Constants
// ============================================

const DEFAULT_RPM = 60;
const WINDOW_MS = 60 * 1000; // 1 minute sliding window

// ============================================
// Core Rate Limiting
// ============================================

/**
 * Check rate limit for an API key.
 *
 * Returns a RateLimitResult indicating whether the request is allowed.
 * Only applies to api_key auth — session auth is not rate-limited here.
 *
 * Uses a simple count-based sliding window:
 * COUNT(*) FROM api_key_usage WHERE api_key_id = ? AND request_at > NOW() - 1 min
 */
export async function checkRateLimit(
  auth: ApiAuthContext
): Promise<RateLimitResult> {
  // Session users are not rate-limited by per-key limiter
  if (auth.authType === "session" || !auth.apiKeyId) {
    return {
      allowed: true,
      limit: 0,
      remaining: 0,
      resetAt: 0,
    };
  }

  const log = createLogger({ action: "checkRateLimit" });

  try {
    // Get the key's rate limit setting
    const keyConfig = await executeQuery(
      (db) =>
        db
          .select({ rateLimitRpm: apiKeys.rateLimitRpm })
          .from(apiKeys)
          .where(eq(apiKeys.id, auth.apiKeyId!))
          .limit(1),
      "getRateLimitConfig"
    );

    const rpm = keyConfig[0]?.rateLimitRpm ?? DEFAULT_RPM;
    const windowStart = new Date(Date.now() - WINDOW_MS);

    // Count requests in the current window
    const [usageCount] = await executeQuery(
      (db) =>
        db
          .select({ value: count() })
          .from(apiKeyUsage)
          .where(
            and(
              eq(apiKeyUsage.apiKeyId, auth.apiKeyId!),
              gte(apiKeyUsage.requestAt, windowStart)
            )
          ),
      "countApiKeyUsage"
    );

    const currentCount = usageCount?.value ?? 0;
    const resetAt = Math.ceil((Date.now() + WINDOW_MS) / 1000);

    if (currentCount >= rpm) {
      const retryAfterSeconds = Math.ceil(WINDOW_MS / 1000);

      log.warn("Rate limit exceeded", {
        apiKeyId: auth.apiKeyId,
        userId: auth.userId,
        currentCount,
        limit: rpm,
      });

      return {
        allowed: false,
        limit: rpm,
        remaining: 0,
        resetAt,
        retryAfterSeconds,
      };
    }

    return {
      allowed: true,
      limit: rpm,
      remaining: Math.max(0, rpm - currentCount - 1), // -1 for current request
      resetAt,
    };
  } catch (error) {
    // Fail closed: deny requests when rate limit check fails.
    // This prevents attackers from bypassing rate limits by causing DB errors.
    log.error("Rate limit check failed, denying request", {
      apiKeyId: auth.apiKeyId,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      allowed: false,
      limit: DEFAULT_RPM,
      remaining: 0,
      resetAt: Math.ceil((Date.now() + WINDOW_MS) / 1000),
      retryAfterSeconds: 60,
    };
  }
}

/**
 * Create a 429 response with rate limit headers.
 */
export function createRateLimitResponse(
  requestId: string,
  result: RateLimitResult
): NextResponse {
  const response = createErrorResponse(
    requestId,
    429,
    "RATE_LIMIT_EXCEEDED",
    "Too many requests. Please try again later."
  );

  response.headers.set("Retry-After", String(result.retryAfterSeconds ?? 60));
  response.headers.set("X-RateLimit-Limit", String(result.limit));
  response.headers.set("X-RateLimit-Remaining", "0");
  response.headers.set("X-RateLimit-Reset", String(result.resetAt));

  return response;
}

/**
 * Add rate limit headers to a successful response.
 */
export function addRateLimitHeaders(
  response: NextResponse,
  result: RateLimitResult
): void {
  if (result.limit > 0) {
    response.headers.set("X-RateLimit-Limit", String(result.limit));
    response.headers.set("X-RateLimit-Remaining", String(result.remaining));
    response.headers.set("X-RateLimit-Reset", String(result.resetAt));
  }
}

// ============================================
// Usage Logging
// ============================================

/**
 * Record API key usage for analytics and rate limiting.
 *
 * Fire-and-forget: errors are logged but don't affect the response.
 * Call this AFTER sending the response for minimal latency impact.
 */
export function recordUsage(
  auth: ApiAuthContext,
  request: NextRequest,
  statusCode: number,
  responseTimeMs: number
): void {
  // Only record for API key auth
  if (auth.authType !== "api_key" || !auth.apiKeyId) {
    return;
  }

  const log = createLogger({ action: "recordUsage" });

  // Extract IP address
  const forwarded = request.headers.get("x-forwarded-for");
  const ip = forwarded ? forwarded.split(",")[0].trim() : null;

  // Fire-and-forget insert
  void executeQuery(
    (db) =>
      db.insert(apiKeyUsage).values({
        apiKeyId: auth.apiKeyId!,
        endpoint: new URL(request.url).pathname,
        method: request.method,
        statusCode,
        responseTimeMs,
        ipAddress: ip?.slice(0, 45) ?? null, // Truncate to column max
      }),
    "recordApiKeyUsage"
  ).catch((error) => {
    log.error("Failed to record API key usage", {
      apiKeyId: auth.apiKeyId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
