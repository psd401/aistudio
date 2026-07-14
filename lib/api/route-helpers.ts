/**
 * Shared API Route Helpers
 * Eliminates duplication across v1 API route handlers.
 * Part of Issue #685 - Assistant Execution API (Phase 2)
 */

import { NextRequest, NextResponse } from "next/server"
import type { z } from "zod"
import { createErrorResponse } from "./auth-middleware"
import type { ApiAuthContext } from "./auth-middleware"
import {
  getAssistantForAccessCheck,
  validateAssistantAccess,
} from "./assistant-service"
import { checkUserRole } from "@/lib/db/drizzle"
import { userCanAccessResource } from "@/lib/db/drizzle/resource-access"
import type { createLogger } from "@/lib/logger"

// ============================================
// URL Parameter Extraction
// ============================================

/**
 * Extract a numeric ID from a URL path segment.
 * Returns null if not found, not a number, or <= 0.
 */
export function extractNumericParam(url: string, segmentName: string): number | null {
  const segments = new URL(url).pathname.split("/")
  const idx = segments.indexOf(segmentName)
  const idStr = segments[idx + 1]
  if (!idStr) return null
  const id = Number.parseInt(idStr, 10)
  return Number.isNaN(id) || id <= 0 ? null : id
}

/**
 * Extract a string ID from a URL path segment.
 * Returns null if not found.
 */
export function extractStringParam(url: string, segmentName: string): string | null {
  const segments = new URL(url).pathname.split("/")
  const idx = segments.indexOf(segmentName)
  return segments[idx + 1] || null
}

/** Default cap for user-controlled values reflected into error messages. */
const ERROR_REFLECTION_MAX_LENGTH = 80

/**
 * Bound a user-controlled value (path segment, query param) before reflecting it
 * into an error message. Reflecting an unbounded, caller-supplied string risks
 * log/response bloat and awkward downstream handling; truncating keeps the error
 * actionable without echoing an arbitrarily long input. Appends an ellipsis when
 * truncated.
 */
export function truncateForError(
  value: string,
  maxLength: number = ERROR_REFLECTION_MAX_LENGTH
): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength)}…`
}

// ============================================
// Admin Detection (API key + session compatible)
// ============================================

/**
 * Check if a user has administrator role by userId.
 * Works for both API key and session authentication.
 * Unlike hasRole() from utils/roles.ts, this does NOT depend on getServerSession().
 */
export async function isAdminByUserId(userId: number): Promise<boolean> {
  return checkUserRole(userId, "administrator")
}

// ============================================
// Assistant Access Verification
// ============================================

/**
 * Verify a user has access to an assistant.
 * Returns null if access is granted, or a 403/404 error response if denied.
 */
export async function verifyAssistantAccess(
  assistantId: number,
  auth: ApiAuthContext,
  requestId: string
): Promise<NextResponse | null> {
  const accessRow = await getAssistantForAccessCheck(assistantId)
  if (!accessRow) {
    return createErrorResponse(requestId, 404, "NOT_FOUND", `Assistant not found: ${assistantId}`)
  }

  const isAdmin = await isAdminByUserId(auth.userId)
  const access = validateAssistantAccess(accessRow, auth.userId, isAdmin)
  if (!access.allowed) {
    return createErrorResponse(
      requestId,
      403,
      "FORBIDDEN",
      `You do not have permission to access this assistant`,
      { requiredConditions: ["owner", "admin", "approved status"] }
    )
  }

  return null
}

/**
 * Per-resource access enforcement (#1206), BENEATH the scope + verifyAssistantAccess
 * gates. Rejects a caller who lacks a role/group grant on the assistant OR the
 * model it uses. The owner always passes the assistant check; admins pass inside
 * userCanAccessResource; zero grants = unrestricted. Returns a 403 Response on
 * denial, else null.
 *
 * Shared by every v1 assistant entry point (execute, start-conversation,
 * send-message) so a caller can't bypass a resource grant by picking a
 * different entry point into the same assistant/model.
 */
export async function verifyAssistantResourceGrants(args: {
  auth: { userId: number }
  architectUserId: number | null | undefined
  architectId: number
  modelDbId: number
  assistantId: number
  requestId: string
  log: ReturnType<typeof createLogger>
}): Promise<NextResponse | null> {
  const { auth, architectUserId, architectId, modelDbId, assistantId, requestId, log } = args

  if (architectUserId !== auth.userId) {
    const canAccessAssistant = await userCanAccessResource(auth.userId, "assistant", architectId)
    if (!canAccessAssistant) {
      log.warn("Caller lacks per-resource grant for assistant", { assistantId, userId: auth.userId })
      return createErrorResponse(requestId, 403, "FORBIDDEN", "You do not have access to this assistant")
    }
  }

  const canAccessModel = await userCanAccessResource(auth.userId, "model", modelDbId)
  if (!canAccessModel) {
    log.warn("Caller lacks access to the assistant's model", { assistantId, modelDbId, userId: auth.userId })
    return createErrorResponse(requestId, 403, "FORBIDDEN", "You do not have access to a model this assistant uses")
  }
  return null
}

// ============================================
// Request Body Parsing
// ============================================

/**
 * Parse and validate a JSON request body with a Zod schema.
 * Returns { data } on success, or a NextResponse error on failure.
 */
export async function parseRequestBody<T extends z.ZodType>(
  request: NextRequest,
  schema: T,
  requestId: string
): Promise<{ data: z.infer<T> } | NextResponse> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return createErrorResponse(requestId, 400, "INVALID_JSON", "Request body must be valid JSON")
  }

  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return createErrorResponse(requestId, 400, "VALIDATION_ERROR", "Invalid request body", parsed.error.issues)
  }

  return { data: parsed.data }
}

/**
 * Type guard: check if a parseRequestBody result is an error response.
 */
export function isErrorResponse(result: unknown): result is NextResponse {
  return result instanceof NextResponse
}
