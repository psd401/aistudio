"use server"

import {
  createLogger,
  generateRequestId,
  startTimer,
  sanitizeForLogging,
} from "@/lib/logger"
import { handleError, ErrorFactories, createSuccess } from "@/lib/error-utils"
import type { ActionState } from "@/types"
import { requireRole } from "@/lib/auth/role-helpers"
import {
  listToolCatalogIdentifiers,
  getToolVersionsWithUsage,
  getToolCatalogVersion,
  deprecateToolVersion,
  undeprecateToolVersion,
  removeToolVersion,
  type ToolVersionWithUsage,
} from "@/lib/db/drizzle"
import { toolCatalogInstance } from "@/lib/tools/catalog/catalog"
import {
  DEFAULT_GRACE_PERIOD_DAYS,
  type ToolCatalogRow,
} from "@/lib/db/schema/tables/tool-catalog"
import { computeRemovalDate, parseToolRef } from "@/lib/tools/catalog/version-resolver"
import { revalidatePath } from "next/cache"

const ADMIN_TOOLS_PATH = "/admin/tools"
const MAX_GRACE_PERIOD_DAYS = 3650 // 10 years — a sane upper bound.

export interface ToolIdentifierSummary {
  identifier: string
  versionCount: number
  deprecatedCount: number
}

/** List all tool identifiers with version + deprecation counts (admin list). */
export async function listToolIdentifiersAction(): Promise<
  ActionState<ToolIdentifierSummary[]>
> {
  const requestId = generateRequestId()
  const timer = startTimer("listToolIdentifiersAction")
  try {
    await requireRole("administrator")
    const identifiers = await listToolCatalogIdentifiers()
    timer({ status: "success" })
    return createSuccess(identifiers, "Tool identifiers loaded")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to load tools", {
      context: "listToolIdentifiersAction",
      requestId,
      operation: "listToolIdentifiersAction",
    })
  }
}

/** Get the full version history (with usage counts) for one tool identifier. */
export async function getToolVersionHistoryAction(
  identifier: string
): Promise<ActionState<ToolVersionWithUsage[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("getToolVersionHistoryAction")
  try {
    await requireRole("administrator")
    if (!identifier?.trim()) {
      throw ErrorFactories.missingRequiredField("identifier")
    }
    const versions = await getToolVersionsWithUsage(identifier.trim())
    timer({ status: "success" })
    return createSuccess(versions, "Tool version history loaded")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to load tool version history", {
      context: "getToolVersionHistoryAction",
      requestId,
      operation: "getToolVersionHistoryAction",
    })
  }
}

export interface DeprecateToolVersionInput {
  identifier: string
  version: string
  /** Successor `identifier@version`, or null/empty when there is no replacement. */
  replacedBy?: string | null
  /** Grace period in days before removal (default 90). */
  gracePeriodDays?: number
}

/** Validate + normalize the grace period; throws a field error when invalid. */
function validateGracePeriod(value: number | undefined): number {
  const gracePeriodDays = value ?? DEFAULT_GRACE_PERIOD_DAYS
  if (
    !Number.isInteger(gracePeriodDays) ||
    gracePeriodDays < 1 ||
    gracePeriodDays > MAX_GRACE_PERIOD_DAYS
  ) {
    throw ErrorFactories.validationFailed([
      {
        field: "gracePeriodDays",
        message: `Grace period must be an integer between 1 and ${MAX_GRACE_PERIOD_DAYS} days`,
      },
    ])
  }
  return gracePeriodDays
}

/**
 * Validate + normalize the `replaced_by` successor pointer; throws when it is not
 * a well-formed pinned reference or points at the version being deprecated.
 */
function validateReplacedBy(
  raw: string | null | undefined,
  selfRef: string
): string | null {
  const replacedBy = raw?.trim() || null
  if (!replacedBy) return null
  const parsed = parseToolRef(replacedBy)
  if (!parsed || parsed.version === null) {
    throw ErrorFactories.validationFailed([
      {
        field: "replacedBy",
        message: "replaced_by must be a pinned reference like 'documents.create@v2'",
      },
    ])
  }
  if (replacedBy === selfRef) {
    throw ErrorFactories.validationFailed([
      { field: "replacedBy", message: "A version cannot be replaced by itself" },
    ])
  }
  return replacedBy
}

/**
 * Mark a tool version deprecated. Admin-only, audit-logged. Sets the deprecation
 * timestamp, computed removal date, grace period, and successor pointer, then
 * invalidates the runtime catalog cache so the change takes effect immediately.
 */
export async function deprecateToolVersionAction(
  input: DeprecateToolVersionInput
): Promise<ActionState<ToolCatalogRow>> {
  const requestId = generateRequestId()
  const timer = startTimer("deprecateToolVersionAction")
  const log = createLogger({ requestId, action: "deprecateToolVersionAction" })
  try {
    const user = await requireRole("administrator")
    log.info("Deprecating tool version", { params: sanitizeForLogging(input) })

    const identifier = input.identifier?.trim()
    const version = input.version?.trim()
    if (!identifier) throw ErrorFactories.missingRequiredField("identifier")
    if (!version) throw ErrorFactories.missingRequiredField("version")

    const gracePeriodDays = validateGracePeriod(input.gracePeriodDays)
    const replacedBy = validateReplacedBy(
      input.replacedBy,
      `${identifier}@${version}`
    )

    // Confirm the version exists before mutating.
    const existing = await getToolCatalogVersion(identifier, version)
    if (!existing) {
      throw ErrorFactories.dbRecordNotFound("tool_catalog", `${identifier}@${version}`)
    }

    const deprecatedAt = new Date()
    const removalDate = computeRemovalDate(deprecatedAt, gracePeriodDays)
    const updated = await deprecateToolVersion({
      identifier,
      version,
      replacedBy,
      gracePeriodDays,
      deprecatedAt,
      removalDate,
    })

    // AUDIT: structured event in the logging/telemetry pipeline (#927 security:
    // deprecation is an admin lifecycle action and must be auditable).
    log.warn("tool_version_deprecated", {
      tool: `${identifier}@${version}`,
      identifier,
      version,
      replacedBy,
      gracePeriodDays,
      removalDate: updated.removalDate?.toISOString() ?? null,
      actorUserId: user?.user?.id ?? null,
    })

    toolCatalogInstance.invalidate()
    revalidatePath(ADMIN_TOOLS_PATH)
    timer({ status: "success" })
    return createSuccess(updated, "Tool version deprecated")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to deprecate tool version", {
      context: "deprecateToolVersionAction",
      requestId,
      operation: "deprecateToolVersionAction",
    })
  }
}

/** Clear a tool version's deprecation. Admin-only, audit-logged. */
export async function undeprecateToolVersionAction(
  identifier: string,
  version: string
): Promise<ActionState<ToolCatalogRow>> {
  const requestId = generateRequestId()
  const timer = startTimer("undeprecateToolVersionAction")
  const log = createLogger({ requestId, action: "undeprecateToolVersionAction" })
  try {
    const user = await requireRole("administrator")
    const id = identifier?.trim()
    const ver = version?.trim()
    if (!id) throw ErrorFactories.missingRequiredField("identifier")
    if (!ver) throw ErrorFactories.missingRequiredField("version")

    const updated = await undeprecateToolVersion(id, ver, DEFAULT_GRACE_PERIOD_DAYS)
    log.warn("tool_version_undeprecated", {
      tool: `${id}@${ver}`,
      identifier: id,
      version: ver,
      actorUserId: user?.user?.id ?? null,
    })

    toolCatalogInstance.invalidate()
    revalidatePath(ADMIN_TOOLS_PATH)
    timer({ status: "success" })
    return createSuccess(updated, "Tool version restored")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to restore tool version", {
      context: "undeprecateToolVersionAction",
      requestId,
      operation: "undeprecateToolVersionAction",
    })
  }
}

/**
 * Enforce the removal policy (#927) for a candidate version row. Throws a
 * validation error when removal is not permitted; returns whether the row was
 * already past its removal date (for the audit record).
 *
 *   - A `code`-sourced version cannot be removed via the admin UI.
 *   - A non-code version must be DEPRECATED and PAST its removal date, unless
 *     `force` is set (an explicit admin override, audit-logged distinctly).
 */
function assertRemovable(existing: ToolCatalogRow, force: boolean): boolean {
  if (existing.source === "code") {
    throw ErrorFactories.validationFailed([
      {
        field: "version",
        message:
          "Code-managed tool versions cannot be removed from the admin UI; remove the manifest entry instead",
      },
    ])
  }
  const pastRemoval =
    existing.deprecatedAt != null &&
    existing.removalDate != null &&
    existing.removalDate.getTime() <= Date.now()

  if (!force && !pastRemoval) {
    throw ErrorFactories.validationFailed([
      {
        field: "version",
        message: existing.deprecatedAt
          ? "Version is still within its deprecation grace period; wait until the removal date or use force"
          : "Version must be deprecated before removal; deprecate it first or use force",
      },
    ])
  }
  return pastRemoval
}

/**
 * Hard-remove a tool version. Admin-only, audit-logged. Removal policy is
 * enforced by {@link assertRemovable}.
 */
export async function removeToolVersionAction(params: {
  identifier: string
  version: string
  force?: boolean
}): Promise<ActionState<{ removed: string }>> {
  const requestId = generateRequestId()
  const timer = startTimer("removeToolVersionAction")
  const log = createLogger({ requestId, action: "removeToolVersionAction" })
  try {
    const user = await requireRole("administrator")
    const identifier = params.identifier?.trim()
    const version = params.version?.trim()
    if (!identifier) throw ErrorFactories.missingRequiredField("identifier")
    if (!version) throw ErrorFactories.missingRequiredField("version")

    const existing = await getToolCatalogVersion(identifier, version)
    if (!existing) {
      throw ErrorFactories.dbRecordNotFound("tool_catalog", `${identifier}@${version}`)
    }

    const pastRemoval = assertRemovable(existing, params.force === true)

    await removeToolVersion(identifier, version)

    log.warn("tool_version_removed", {
      tool: `${identifier}@${version}`,
      identifier,
      version,
      forced: params.force === true,
      wasPastRemovalDate: pastRemoval,
      actorUserId: user?.user?.id ?? null,
    })

    toolCatalogInstance.invalidate()
    revalidatePath(ADMIN_TOOLS_PATH)
    timer({ status: "success" })
    return createSuccess(
      { removed: `${identifier}@${version}` },
      "Tool version removed"
    )
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to remove tool version", {
      context: "removeToolVersionAction",
      requestId,
      operation: "removeToolVersionAction",
    })
  }
}
