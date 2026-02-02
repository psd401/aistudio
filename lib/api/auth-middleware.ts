/**
 * API Authentication Middleware
 * Dual-mode auth: Bearer token (API key) + session fallback
 * Part of Epic #674 (External API Platform) - Issue #677
 *
 * Auth flow:
 *   Request → Has "Authorization: Bearer sk-..." header?
 *     Yes → SHA-256 prefix lookup → Argon2id verify → AuthContext { authType: "api_key" }
 *     No  → getServerSession() → AuthContext { authType: "session", scopes: ["*"] }
 *     Neither → 401
 *
 * Security:
 * - Raw API keys are NEVER logged
 * - Consistent error messages prevent key existence leakage
 * - Session users get wildcard scopes (full access for their role)
 * - API key auth does NOT bypass role-based access checks
 */

import { NextRequest, NextResponse } from "next/server";
import { validateApiKey, hasScope, updateKeyLastUsed } from "@/lib/api-keys/key-service";
import { getServerSession } from "@/lib/auth/server-session";
import { getUserIdByCognitoSubAsNumber } from "@/lib/db/drizzle/utils";
import { createLogger, generateRequestId, startTimer } from "@/lib/logger";

// ============================================
// Types
// ============================================

export interface ApiAuthContext {
  userId: number;
  cognitoSub: string;
  authType: "session" | "api_key";
  scopes: string[];
  apiKeyId?: number;
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  requestId: string;
}

// ============================================
// Constants
// ============================================

const BEARER_PREFIX = "Bearer ";

// ============================================
// Core Middleware
// ============================================

/**
 * Authenticate an API request via Bearer token or session.
 *
 * Returns ApiAuthContext on success, or a NextResponse (401) on failure.
 * The caller is responsible for sending the error response.
 *
 * Usage in route handlers:
 * ```typescript
 * export async function GET(request: NextRequest) {
 *   const authResult = await authenticateRequest(request);
 *   if (authResult instanceof NextResponse) return authResult;
 *   // authResult is ApiAuthContext
 * }
 * ```
 */
export async function authenticateRequest(
  request: NextRequest
): Promise<ApiAuthContext | NextResponse> {
  const requestId = generateRequestId();
  const timer = startTimer("authenticateRequest");
  const log = createLogger({ requestId, action: "authenticateRequest" });

  const authHeader = request.headers.get("authorization");

  // Path 1: Bearer token authentication
  if (authHeader && authHeader.startsWith(BEARER_PREFIX)) {
    const token = authHeader.slice(BEARER_PREFIX.length).trim();

    if (!token) {
      timer({ status: "error" });
      log.warn("Empty Bearer token");
      return createErrorResponse(requestId, 401, "INVALID_TOKEN", "Invalid API key");
    }

    try {
      const keyAuth = await validateApiKey(token);

      if (!keyAuth) {
        timer({ status: "error" });
        log.warn("API key validation failed");
        return createErrorResponse(requestId, 401, "INVALID_TOKEN", "Invalid API key");
      }

      // Look up cognitoSub for the key's userId
      const cognitoSub = await getCognitoSubByUserId(keyAuth.userId);
      if (!cognitoSub) {
        timer({ status: "error" });
        log.error("User not found for API key", { userId: keyAuth.userId, keyId: keyAuth.keyId });
        return createErrorResponse(requestId, 401, "INVALID_TOKEN", "Invalid API key");
      }

      // Fire-and-forget: update lastUsedAt
      void updateKeyLastUsed(keyAuth.keyId);

      timer({ status: "success" });
      log.info("Authenticated via API key", {
        userId: keyAuth.userId,
        keyId: keyAuth.keyId,
        authType: "api_key",
      });

      return {
        userId: keyAuth.userId,
        cognitoSub,
        authType: "api_key",
        scopes: keyAuth.scopes,
        apiKeyId: keyAuth.keyId,
      };
    } catch (error) {
      timer({ status: "error" });
      log.error("API key authentication error", {
        error: error instanceof Error ? error.message : String(error),
      });
      return createErrorResponse(requestId, 500, "INTERNAL_ERROR", "Authentication failed");
    }
  }

  // Path 2: Session-based authentication (fallback)
  try {
    const session = await getServerSession();

    if (!session?.sub) {
      timer({ status: "error" });
      log.debug("No session found");
      return createErrorResponse(requestId, 401, "UNAUTHORIZED", "Authentication required");
    }

    const userId = await getUserIdByCognitoSubAsNumber(session.sub);
    if (!userId) {
      timer({ status: "error" });
      log.warn("Session user not found in database", { cognitoSub: session.sub });
      return createErrorResponse(requestId, 401, "UNAUTHORIZED", "Authentication required");
    }

    timer({ status: "success" });
    log.info("Authenticated via session", {
      userId,
      authType: "session",
    });

    return {
      userId,
      cognitoSub: session.sub,
      authType: "session",
      scopes: ["*"], // Session users get full access (role-based checks still apply)
    };
  } catch (error) {
    timer({ status: "error" });
    log.error("Session authentication error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return createErrorResponse(requestId, 500, "INTERNAL_ERROR", "Authentication failed");
  }
}

// ============================================
// Scope Enforcement
// ============================================

/**
 * Check if the auth context has the required scope.
 * Returns a 403 NextResponse if the scope is missing, or null if allowed.
 *
 * Session users always pass (scopes: ["*"]).
 *
 * Usage:
 * ```typescript
 * const scopeError = requireScope(auth, "chat:read");
 * if (scopeError) return scopeError;
 * ```
 */
export function requireScope(
  auth: ApiAuthContext,
  scope: string,
  requestId?: string
): NextResponse | null {
  if (hasScope(auth.scopes, scope)) {
    return null; // Allowed
  }

  const rid = requestId || generateRequestId();
  const log = createLogger({ requestId: rid, action: "requireScope" });
  log.warn("Scope check failed", {
    userId: auth.userId,
    authType: auth.authType,
    requiredScope: scope,
    apiKeyId: auth.apiKeyId,
  });

  return createErrorResponse(rid, 403, "INSUFFICIENT_SCOPE", `Missing required scope: ${scope}`);
}

/**
 * Check if the auth context has permission to execute a specific assistant.
 * Accepts any of: `assistants:execute`, `assistants:*`, `assistant:{id}:execute`, or `*`.
 * Returns a 403 NextResponse if denied, or null if allowed.
 */
export function requireAssistantScope(
  auth: ApiAuthContext,
  assistantId: number,
  requestId?: string
): NextResponse | null {
  // Check broad scope first: assistants:execute or assistants:*
  if (hasScope(auth.scopes, "assistants:execute")) {
    return null
  }

  // Check per-assistant scope: assistant:{id}:execute
  const perAssistantScope = `assistant:${assistantId}:execute`
  if (auth.scopes.includes(perAssistantScope)) {
    return null
  }

  const rid = requestId || generateRequestId()
  const log = createLogger({ requestId: rid, action: "requireAssistantScope" })
  log.warn("Assistant scope check failed", {
    userId: auth.userId,
    authType: auth.authType,
    assistantId,
    apiKeyId: auth.apiKeyId,
  })

  return createErrorResponse(
    rid,
    403,
    "INSUFFICIENT_SCOPE",
    `Missing required scope: assistants:execute or assistant:${assistantId}:execute`
  )
}

// ============================================
// Response Helpers
// ============================================

/**
 * Create a standardized API error response.
 * All error responses include X-Request-Id header.
 */
export function createErrorResponse(
  requestId: string,
  status: number,
  code: string,
  message: string,
  details?: unknown
): NextResponse {
  const body: ApiErrorResponse = {
    error: {
      code,
      message,
      ...(details !== undefined && { details }),
    },
    requestId,
  };

  return NextResponse.json(body, {
    status,
    headers: {
      "X-Request-Id": requestId,
    },
  });
}

/**
 * Create a standardized API success response.
 * All responses include X-Request-Id header.
 */
export function createApiResponse<T>(
  data: T,
  requestId: string,
  status: number = 200
): NextResponse {
  return NextResponse.json(data, {
    status,
    headers: {
      "X-Request-Id": requestId,
    },
  });
}

// ============================================
// Internal Helpers
// ============================================

/**
 * Look up a user's cognitoSub by their numeric userId.
 * Needed for API key auth where we only have userId from the key.
 */
async function getCognitoSubByUserId(userId: number): Promise<string | null> {
  const { executeQuery } = await import("@/lib/db/drizzle-client");
  const { eq } = await import("drizzle-orm");
  const { users } = await import("@/lib/db/schema");

  const result = await executeQuery(
    (db) =>
      db
        .select({ cognitoSub: users.cognitoSub })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1),
    "getCognitoSubByUserId"
  );

  return result[0]?.cognitoSub ?? null;
}
