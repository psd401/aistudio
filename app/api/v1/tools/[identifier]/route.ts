/**
 * Tool Catalog — single tool endpoint (Issue #927, Epic #922 workstream #5).
 *
 * GET /api/v1/tools/{identifier}
 *   - Default: returns the LATEST non-deprecated version of the tool.
 *   - ?include=all: returns every version (incl. deprecated) under `versions`.
 *
 * Per-tool versioning is addressed via the catalog (`identifier@version`), not by
 * REST URL versioning — the API itself stays at `/api/v1`. A specific version is
 * fetched via the sibling `/versions/{n}` route.
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
import { serializeToolEntry, type SerializedToolVersion } from "@/lib/tools/catalog/rest-serializer"
import { pickLatestNonDeprecated, isDeprecated } from "@/lib/tools/catalog/version-resolver"
import { createLogger } from "@/lib/logger"

export const GET = withApiAuth(async (request, auth, requestId) => {
  const scopeError = requireScope(auth, "tools:read", requestId)
  if (scopeError) return scopeError

  const log = createLogger({ requestId, route: "api.v1.tools.get" })
  const { searchParams } = new URL(request.url)
  // Anchor extraction to the known `tools` path segment (robust against a
  // base-path prefix / reverse proxy, unlike positional slicing). Decode
  // defensively for any percent-encoding (identifiers contain dots, which are
  // URL-safe). (#1044 review.)
  const identifier = decodeURIComponent(
    extractStringParam(request.url, "tools") ?? ""
  )
  if (!identifier) {
    return createErrorResponse(requestId, 400, "VALIDATION_ERROR", "Missing tool identifier")
  }

  const includeAll = searchParams.get("include") === "all"

  try {
    // Admin-disabled versions are masked from this API entirely (same policy as
    // dispatch(): found-but-disabled reads as not-found, so a disabled tool's
    // existence cannot be probed). listVersions() includes inactive rows for the
    // admin UI, so filter here. (Epic #922 completion audit.)
    const versions = (await toolCatalogInstance.listVersions(identifier)).filter(
      (v) => v.isActive
    )
    if (versions.length === 0) {
      return createErrorResponse(
        requestId,
        404,
        "NOT_FOUND",
        `No tool found with identifier '${truncateForError(identifier)}'`
      )
    }

    if (includeAll) {
      const serialized: SerializedToolVersion[] = versions.map(serializeToolEntry)
      log.info("Listed all tool versions", { identifier, count: serialized.length })
      return createApiResponse(
        { data: { identifier, versions: serialized }, meta: { requestId } },
        requestId
      )
    }

    // Default: latest non-deprecated ACTIVE version (same per-identifier policy
    // resolve() applies, over the active set). No caller context here (a
    // metadata read is not a tool invocation), so the deprecation telemetry
    // event is intentionally not emitted.
    const latest = pickLatestNonDeprecated(versions)
    if (!latest) {
      return createErrorResponse(
        requestId,
        404,
        "NOT_FOUND",
        `No resolvable version for tool '${truncateForError(identifier)}'`
      )
    }

    log.info("Resolved latest tool version", {
      identifier,
      version: latest.version,
      deprecated: isDeprecated(latest),
    })
    return createApiResponse(
      { data: serializeToolEntry(latest), meta: { requestId } },
      requestId
    )
  } catch (error) {
    log.error("Failed to fetch tool", {
      identifier,
      error: error instanceof Error ? error.message : String(error),
    })
    return createErrorResponse(requestId, 500, "INTERNAL_ERROR", "Failed to fetch tool")
  }
})
