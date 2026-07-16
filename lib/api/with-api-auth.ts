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
 *
 * Dynamic routes get their real Next.js route params as a 4th handler argument —
 * `params` is a plain, already-resolved `Record<string, string>` (the wrapper
 * awaits Next's `params` Promise). Prefer this over parsing the URL with
 * `extractStringParam`, which finds a path segment by NAME and can misparse when a
 * slug value equals a path literal (e.g. a content slug of `"publish"`):
 * ```typescript
 * export const DELETE = withApiAuth(async (req, auth, requestId, params) => {
 *   const id = params.id;               // the real [id] segment, collision-free
 *   const destination = params.destination;
 * });
 * ```
 */

import { NextRequest, NextResponse } from "next/server";
import { generateRequestId, createLogger, startTimer } from "@/lib/logger";
import { authenticateRequest, createErrorResponse } from "./auth-middleware";
import type { ApiAuthContext } from "./auth-middleware";
import { checkRateLimit, createRateLimitResponse, addRateLimitHeaders, recordUsage } from "./rate-limiter";

/**
 * Resolved dynamic route params, e.g. `{ id: "abc", destination: "intranet" }`.
 * Values are typed `string | undefined` (not `string`) so a handler reading a key
 * that does not correspond to a real `[param]` segment — or any key on a
 * non-dynamic route, which receives `{}` — is forced to null-check rather than
 * getting a false `string`. The Atrium content routes all guard with `if (!id)`.
 */
export type RouteParams = Record<string, string | undefined>;

type ApiRouteHandler = (
  request: NextRequest,
  auth: ApiAuthContext,
  requestId: string,
  params: RouteParams
) => Promise<NextResponse>;

/**
 * The route context Next.js passes as the SECOND argument to a route handler.
 * `params` is a Promise in the App Router (Next 15+); the wrapper awaits it before
 * handing a plain object to the handler. Both the context and its `params`
 * promise are required by Next's route contract; non-dynamic routes receive a
 * promise that resolves to `{}`.
 */
interface RouteContext {
  params: Promise<RouteParams>;
}

/**
 * Wrap an API route handler with authentication, rate limiting, and usage logging.
 */
export function withApiAuth(
  handler: ApiRouteHandler
): (request: NextRequest, context: RouteContext) => Promise<NextResponse> {
  return async (
    request: NextRequest,
    context: RouteContext
  ): Promise<NextResponse> => {
    const requestId = generateRequestId();
    const timer = startTimer("apiRequest");
    const log = createLogger({ requestId, action: "withApiAuth" });
    const startMs = Date.now();

    // Step 1: Authenticate
    const authResult = await authenticateRequest(request);
    // Duck-type check: ApiAuthContext has userId, NextResponse does not
    if (!("userId" in authResult)) {
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

    // Step 3: Execute handler. Both the try (success) and catch (500) branches
    // assign `response` + `statusCode`, so no initializer is needed — and a `= 200`
    // default would be dead (never read before reassignment: no-useless-assignment).
    let response: NextResponse;
    let statusCode: number;

    try {
      // Resolve Next's dynamic route params (a Promise in the App Router) once and
      // hand the handler a plain object. For a non-dynamic route, Next resolves
      // the promise to `{}` and the handler simply ignores the argument. Keep a
      // runtime fallback for direct test/legacy calls made outside Next.
      const params = context?.params ? await context.params : {};
      response = await handler(request, auth, requestId, params);
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
