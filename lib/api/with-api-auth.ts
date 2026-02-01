/**
 * Higher-order function wrapping API route handlers with auth + rate limiting + logging.
 * Part of Epic #674 (External API Platform) - Issue #677
 *
 * Composes:
 * 1. authenticateRequest() — Bearer token or session auth
 * 2. checkRateLimit() — per-key sliding window (API key auth only)
 * 3. recordUsage() — fire-and-forget analytics logging
 * 4. X-Request-Id on all responses
 *
 * Usage:
 * ```typescript
 * export const GET = withApiAuth(async (request, auth, requestId) => {
 *   const scopeError = requireScope(auth, "chat:read", requestId);
 *   if (scopeError) return scopeError;
 *   return createApiResponse({ message: "Hello" }, requestId);
 * });
 * ```
 */

import { NextRequest, NextResponse } from "next/server";
import { generateRequestId, createLogger, startTimer } from "@/lib/logger";
import { authenticateRequest, createErrorResponse } from "./auth-middleware";
import type { ApiAuthContext } from "./auth-middleware";
import { checkRateLimit, createRateLimitResponse, addRateLimitHeaders, recordUsage } from "./rate-limiter";

type ApiRouteHandler = (
  request: NextRequest,
  auth: ApiAuthContext,
  requestId: string
) => Promise<NextResponse>;

/**
 * Wrap an API route handler with authentication, rate limiting, and usage logging.
 */
export function withApiAuth(
  handler: ApiRouteHandler
): (request: NextRequest) => Promise<NextResponse> {
  return async (request: NextRequest): Promise<NextResponse> => {
    const requestId = generateRequestId();
    const timer = startTimer("apiRequest");
    const log = createLogger({ requestId, action: "withApiAuth" });
    const startMs = Date.now();

    // Step 1: Authenticate
    const authResult = await authenticateRequest(request);
    if (authResult instanceof NextResponse) {
      timer({ status: "auth_failed" });
      recordTimingHeader(authResult, requestId);
      return authResult;
    }

    const auth = authResult;

    // Step 2: Rate limiting (API key only)
    const rateLimitResult = await checkRateLimit(auth);
    if (!rateLimitResult.allowed) {
      timer({ status: "rate_limited" });
      const response = createRateLimitResponse(requestId, rateLimitResult);
      recordUsage(auth, request, 429, Date.now() - startMs);
      return response;
    }

    // Step 3: Execute handler
    let response: NextResponse;
    let statusCode = 200;

    try {
      response = await handler(request, auth, requestId);
      statusCode = response.status;
    } catch (error) {
      log.error("Unhandled error in API handler", {
        error: error instanceof Error ? error.message : String(error),
        userId: auth.userId,
        authType: auth.authType,
        endpoint: new URL(request.url).pathname,
      });

      statusCode = 500;
      response = createErrorResponse(
        requestId,
        500,
        "INTERNAL_ERROR",
        "An unexpected error occurred"
      );
    }

    // Step 4: Add headers and record usage
    response.headers.set("X-Request-Id", requestId);
    addRateLimitHeaders(response, rateLimitResult);

    const responseTimeMs = Date.now() - startMs;
    recordUsage(auth, request, statusCode, responseTimeMs);

    timer({ status: "success", statusCode });
    log.info("API request completed", {
      userId: auth.userId,
      authType: auth.authType,
      method: request.method,
      endpoint: new URL(request.url).pathname,
      statusCode,
      responseTimeMs,
    });

    return response;
  };
}

function recordTimingHeader(response: NextResponse, requestId: string): void {
  if (!response.headers.has("X-Request-Id")) {
    response.headers.set("X-Request-Id", requestId);
  }
}
