/**
 * Durable API Rate Limiter
 * Sliding-window reservations shared by every authentication mode.
 * Part of Epic #674 (External API Platform) - Issue #677
 *
 * Strategy:
 * - Serialize per principal with a PostgreSQL advisory transaction lock
 * - COUNT and INSERT a durable reservation before request dispatch
 * - Default: 60 req/min (configurable per key via rate_limit_rpm)
 * - Returns 429 with Retry-After + X-RateLimit-* headers when exceeded
 * - Usage records double as analytics (endpoint, method, status_code, response_time_ms)
 *
 * Design decisions:
 * - Database-backed for accuracy across multiple server instances
 * - Analytics usage logging remains separate and non-blocking
 */

import { NextRequest, NextResponse } from "next/server";
import { executeQuery, executeTransaction } from "@/lib/db/drizzle-client";
import { apiKeyUsage, apiKeys, apiRateLimitReservations } from "@/lib/db/schema";
import { and, count, eq, gte, lt, sql } from "drizzle-orm";
import { createLogger } from "@/lib/logger";
import type { ApiAuthContext } from "./auth-middleware";
import { createErrorResponse } from "./auth-middleware";
import { createHash } from "node:crypto";

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

// Default requests-per-minute for principals without a per-key configuration
// (session auth, OAuth clients, api keys with no rateLimitRpm row). Overridable
// via API_RATE_LIMIT_DEFAULT_RPM for environments whose traffic shape is not
// production-like: the local E2E harness (scripts/test/e2e-local.sh) drives one
// shared test user far harder than any human, and a warm dev server runs the
// suite fast enough to trip the production budget. Unset/invalid → 60.
const DEFAULT_RPM = (() => {
  const parsed = Number.parseInt(
    process.env.API_RATE_LIMIT_DEFAULT_RPM ?? "",
    10
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
})();
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
 * Uses a count-based sliding window over durable pre-dispatch reservations.
 */
export async function checkRateLimit(
  auth: ApiAuthContext
): Promise<RateLimitResult> {
  const log = createLogger({ action: "checkRateLimit" });

  try {
    const keyConfig = auth.apiKeyId
      ? await executeQuery(
          (db) =>
            db
              .select({ rateLimitRpm: apiKeys.rateLimitRpm })
              .from(apiKeys)
              .where(eq(apiKeys.id, auth.apiKeyId!))
              .limit(1),
          "getRateLimitConfig"
        )
      : [];
    const rpm = keyConfig[0]?.rateLimitRpm ?? DEFAULT_RPM;
    const principal = [
      auth.authType,
      auth.apiKeyId ?? auth.oauthClientId ?? auth.userId,
    ].join(":");
    const principalHash = createHash("sha256").update(principal).digest("hex");
    const now = Date.now();
    const windowStart = new Date(now - WINDOW_MS);
    const retentionStart = new Date(now - 24 * 60 * 60 * 1000);

    const currentCount = await executeTransaction(
      async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${principalHash}, 0))`
        );
        await tx
          .delete(apiRateLimitReservations)
          .where(lt(apiRateLimitReservations.requestAt, retentionStart));
        const [usage] = await tx
          .select({ value: count() })
          .from(apiRateLimitReservations)
          .where(
            and(
              eq(apiRateLimitReservations.principalHash, principalHash),
              gte(apiRateLimitReservations.requestAt, windowStart)
            )
          );
        const used = usage?.value ?? 0;
        if (used < rpm) {
          await tx.insert(apiRateLimitReservations).values({
            principalHash,
            endpoint: "/api/mcp",
          });
        }
        return used;
      },
      "reserveApiRateLimit"
    );

    const resetAt = Math.ceil((Date.now() + WINDOW_MS) / 1000);

    if (currentCount >= rpm) {
      const retryAfterSeconds = Math.ceil(WINDOW_MS / 1000);

      log.warn("Rate limit exceeded", {
        authType: auth.authType,
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
      authType: auth.authType,
      userId: auth.userId,
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
