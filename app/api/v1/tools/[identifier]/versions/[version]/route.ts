/**
 * Tool Catalog — specific version endpoint (Issue #927).
 *
 * GET /api/v1/tools/{identifier}/versions/{n}
 *   - Returns the exact `{identifier}@v{n}` catalog entry.
 *   - `{n}` may be supplied as `v2` or bare `2` (both resolve to version `v2`).
 *   - 404 with a clear, actionable message when that version has been removed or
 *     never existed — this is the error a pinned consumer (skill/assistant) sees
 *     when its pinned version is gone (#927 AC: "removal produces clear errors").
 *
 * Auth: Bearer token with the `tools:read` scope.
 */

import {
  withApiAuth,
  requireScope,
  createApiResponse,
  createErrorResponse,
  extractStringParam,
  truncateForError,
} from "@/lib/api"
import { toolCatalogInstance } from "@/lib/tools/catalog/catalog"
import { serializeToolEntry, normalizeVersionParam } from "@/lib/tools/catalog/rest-serializer"
import { createLogger } from "@/lib/logger"

export const GET = withApiAuth(async (request, auth, requestId) => {
  const scopeError = requireScope(auth, "tools:read", requestId)
  if (scopeError) return scopeError

  const log = createLogger({ requestId, route: "api.v1.tools.version.get" })

  // Path: /api/v1/tools/{identifier}/versions/{version}. Anchor extraction to the
  // known `tools` and `versions` path segments rather than positional slicing, so
  // a base-path prefix / reverse proxy can't shift the indices. (#1044 review.)
  const identifier = decodeURIComponent(
    extractStringParam(request.url, "tools") ?? ""
  )
  const versionRaw = decodeURIComponent(
    extractStringParam(request.url, "versions") ?? ""
  )

  if (!identifier || !versionRaw) {
    return createErrorResponse(
      requestId,
      400,
      "VALIDATION_ERROR",
      "Missing tool identifier or version"
    )
  }

  const version = normalizeVersionParam(versionRaw)
  if (!version) {
    return createErrorResponse(
      requestId,
      400,
      "VALIDATION_ERROR",
      `Invalid version '${truncateForError(versionRaw)}'. Expected a version like 'v2' or '2'.`
    )
  }

  try {
    const ref = `${identifier}@${version}`
    const resolution = await toolCatalogInstance.resolve(ref)
    if (!resolution.ok) {
      if (resolution.reason === "unknown_version") {
        return createErrorResponse(
          requestId,
          404,
          "NOT_FOUND",
          `Tool '${identifier}' has no version '${version}'. It may have been removed; check the latest version at /api/v1/tools/${encodeURIComponent(identifier)}.`
        )
      }
      // unknown_identifier or malformed_ref.
      return createErrorResponse(
        requestId,
        404,
        "NOT_FOUND",
        `No tool found with identifier '${truncateForError(identifier)}'`
      )
    }

    log.info("Fetched specific tool version", {
      identifier,
      version,
      deprecated: resolution.deprecated,
    })
    return createApiResponse(
      { data: serializeToolEntry(resolution.entry), meta: { requestId } },
      requestId
    )
  } catch (error) {
    log.error("Failed to fetch tool version", {
      identifier,
      version,
      error: error instanceof Error ? error.message : String(error),
    })
    return createErrorResponse(requestId, 500, "INTERNAL_ERROR", "Failed to fetch tool version")
  }
})
