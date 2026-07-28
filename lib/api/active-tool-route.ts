import type { NextResponse } from "next/server"
import {
  createErrorResponse,
  requireScope,
  type ApiAuthContext,
} from "@/lib/api/auth-middleware"
import { toolCatalogInstance } from "@/lib/tools/catalog/catalog"

interface ActiveToolRouteOptions {
  identifier: string
  fallbackScopes: string[]
  unavailableMessage: string
}

/**
 * Keep direct REST tool routes aligned with catalog dispatch: a disabled entry
 * is existence-masked, while an unavailable entry retains the literal scope
 * fallback used during catalog bootstrap or recovery.
 */
export async function requireActiveRestTool(
  auth: ApiAuthContext,
  requestId: string,
  options: ActiveToolRouteOptions,
): Promise<NextResponse | null> {
  const entry = await toolCatalogInstance.get(options.identifier)
  if (entry && !entry.isActive) {
    return createErrorResponse(
      requestId,
      404,
      "NOT_FOUND",
      options.unavailableMessage,
    )
  }

  const resolvedScopes = entry
    ? (entry.surfaceScopes?.rest ?? entry.requiredScopes)
    : await toolCatalogInstance.getRequiredScopes(options.identifier, "rest")
  const scopes = resolvedScopes?.length
    ? resolvedScopes
    : options.fallbackScopes
  for (const scope of scopes) {
    const scopeError = requireScope(auth, scope, requestId)
    if (scopeError) return scopeError
  }
  return null
}
