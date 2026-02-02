/**
 * API Middleware Barrel Exports
 * Part of Epic #674 (External API Platform) - Issue #677
 *
 * Usage in route handlers:
 * ```typescript
 * import { withApiAuth, requireScope, createApiResponse } from "@/lib/api";
 *
 * export const GET = withApiAuth(async (request, auth, requestId) => {
 *   const scopeError = requireScope(auth, "chat:read", requestId);
 *   if (scopeError) return scopeError;
 *
 *   const data = await fetchData(auth.userId);
 *   return createApiResponse(data, requestId);
 * });
 * ```
 */

export {
  authenticateRequest,
  requireScope,
  requireAssistantScope,
  createErrorResponse,
  createApiResponse,
  type ApiAuthContext,
  type ApiErrorResponse,
} from "./auth-middleware";

export {
  checkRateLimit,
  createRateLimitResponse,
  addRateLimitHeaders,
  recordUsage,
  type RateLimitResult,
} from "./rate-limiter";

export { withApiAuth } from "./with-api-auth";

export {
  extractNumericParam,
  extractStringParam,
  isAdminByUserId,
  verifyAssistantAccess,
  parseRequestBody,
  isErrorResponse,
} from "./route-helpers";
