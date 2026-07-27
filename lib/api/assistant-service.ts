/**
 * Assistant Query & Access Service
 * Queries assistants the authenticated user can access via API.
 * Part of Issue #685 - Assistant Execution API (Phase 2)
 *
 * Access rules (same as web UI execute route):
 * 1. User is the owner → can access any of their own assistants
 * 2. User is an admin → can access any assistant
 * 3. Assistant is "approved" → any authenticated user can access
 */

import { eq, and, or, ilike, sql, gt } from "drizzle-orm"
import { executeQuery } from "@/lib/db/drizzle-client"
import {
  assistantArchitects,
  chainPrompts,
  toolInputFields,
} from "@/lib/db/schema"
import { filterAccessibleResourceIds } from "@/lib/db/drizzle/resource-access"
import { createLogger } from "@/lib/logger"

// ============================================
// Types
// ============================================

export interface ListAssistantsOptions {
  limit?: number
  cursor?: string // cursor is the assistant ID to start after
  status?: string
  search?: string
}

export interface AssistantListItem {
  id: number
  name: string
  description: string | null
  status: string
  inputFieldCount: number
  promptCount: number
  createdAt: Date
  updatedAt: Date
}

export interface AssistantDetail {
  id: number
  name: string
  description: string | null
  status: string
  timeoutSeconds: number | null
  inputFields: AssistantInputField[]
  promptCount: number
  createdAt: Date
  updatedAt: Date
}

export interface AssistantInputField {
  id: number
  name: string
  label: string
  fieldType: string
  position: number
  options: unknown
}

export interface AssistantListResult {
  items: AssistantListItem[]
  nextCursor: string | null
}

// ============================================
// Access Validation
// ============================================

/**
 * Check whether a user can access a given assistant.
 * Returns { allowed: true } or { allowed: false, reason: string }.
 */
export function validateAssistantAccess(
  assistant: { userId: number | null; status: string },
  userId: number,
  isAdmin: boolean
): { allowed: boolean; reason?: string } {
  // A null owner never matches a numeric userId, so an orphan assistant is granted
  // access only via the admin or approved-status branches below (REV-COR-524).
  const isOwner = assistant.userId === userId
  if (isOwner) return { allowed: true }
  if (isAdmin) return { allowed: true }
  if (assistant.status === "approved") return { allowed: true }
  return {
    allowed: false,
    reason: "User is not the owner, not an admin, and assistant is not approved",
  }
}

// ============================================
// List Assistants
// ============================================

/**
 * List assistants accessible to the authenticated user.
 * Applies the same access rules as the execute route.
 */
export async function listAccessibleAssistants(
  userId: number,
  isAdmin: boolean,
  options: ListAssistantsOptions = {}
): Promise<AssistantListResult> {
  const log = createLogger({ action: "listAccessibleAssistants" })
  const limit = Math.min(options.limit ?? 50, 100)

  // Build WHERE conditions
  // Admin: can see all. Non-admin: own assistants OR approved ones.
  const accessCondition = isAdmin
    ? undefined
    : or(
        eq(assistantArchitects.userId, userId),
        eq(assistantArchitects.status, "approved")
      )

  const statusCondition = options.status
    ? eq(assistantArchitects.status, options.status as "draft" | "pending_approval" | "approved" | "rejected" | "disabled")
    : undefined

  const searchCondition = options.search
    ? or(
        ilike(assistantArchitects.name, `%${options.search.replace(/[%\\_]/g, "\\$&")}%`),
        ilike(assistantArchitects.description, `%${options.search.replace(/[%\\_]/g, "\\$&")}%`)
      )
    : undefined

  let scanCursor = options.cursor
    ? Number.parseInt(options.cursor, 10)
    : undefined
  const accessibleRows: Array<{
    id: number
    name: string
    description: string | null
    status: string
    userId: number | null
    createdAt: Date
    updatedAt: Date
    promptCount: number
    inputFieldCount: number
  }> = []
  const scanSize = Math.max(limit + 1, 100)

  // Room-restricted students can have long runs of hidden assistants between
  // assigned ones. Scan candidate pages until we have a full accessible page
  // (plus one lookahead row) so keyset pagination never returns a false empty
  // page merely because its first database chunk was filtered out.
  while (accessibleRows.length <= limit) {
    const cursorCondition =
      scanCursor !== undefined
        ? gt(assistantArchitects.id, scanCursor)
        : undefined
    const conditions = [
      accessCondition,
      statusCondition,
      searchCondition,
      cursorCondition,
    ].filter((condition): condition is NonNullable<typeof condition> =>
      condition !== undefined
    )
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined

    const rows = await executeQuery(
      (db) =>
        db
          .select({
            id: assistantArchitects.id,
            name: assistantArchitects.name,
            description: assistantArchitects.description,
            status: assistantArchitects.status,
            userId: assistantArchitects.userId,
            createdAt: assistantArchitects.createdAt,
            updatedAt: assistantArchitects.updatedAt,
            promptCount: sql<number>`(
              SELECT COUNT(*)::int FROM chain_prompts
              WHERE chain_prompts.assistant_architect_id = ${assistantArchitects.id}
            )`,
            inputFieldCount: sql<number>`(
              SELECT COUNT(*)::int FROM tool_input_fields
              WHERE tool_input_fields.assistant_architect_id = ${assistantArchitects.id}
            )`,
          })
          .from(assistantArchitects)
          .where(whereClause)
          .orderBy(assistantArchitects.id)
          .limit(scanSize),
      "listAccessibleAssistants"
    )
    if (rows.length === 0) break

    const accessibleIds = isAdmin
      ? new Set(rows.map((row) => String(row.id)))
      : await filterAccessibleResourceIds(
          userId,
          "assistant",
          rows.map((row) => row.id),
          {
            ownedResourceIds: rows
              .filter((row) => row.userId === userId)
              .map((row) => row.id),
          }
        )
    accessibleRows.push(
      ...rows.filter((row) => accessibleIds.has(String(row.id)))
    )
    scanCursor = rows[rows.length - 1]?.id
    if (rows.length < scanSize) break
  }

  const hasMore = accessibleRows.length > limit
  const items = accessibleRows.slice(0, limit).map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    inputFieldCount: row.inputFieldCount,
    promptCount: row.promptCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }))

  const nextCursor = hasMore && items.length > 0
    ? String(items[items.length - 1].id)
    : null

  log.info("Listed accessible assistants", {
    userId,
    isAdmin,
    resultCount: items.length,
    hasMore,
  })

  return { items, nextCursor }
}

// ============================================
// Get Assistant By ID
// ============================================

/**
 * Get a single assistant with full details (input fields, prompt count).
 * Does NOT check access — caller must validate access first.
 */
export async function getAssistantById(
  assistantId: number
): Promise<AssistantDetail | null> {
  const log = createLogger({ action: "getAssistantById" })

  // Fetch assistant
  const rows = await executeQuery(
    (db) =>
      db
        .select({
          id: assistantArchitects.id,
          name: assistantArchitects.name,
          description: assistantArchitects.description,
          status: assistantArchitects.status,
          timeoutSeconds: assistantArchitects.timeoutSeconds,
          userId: assistantArchitects.userId,
          createdAt: assistantArchitects.createdAt,
          updatedAt: assistantArchitects.updatedAt,
        })
        .from(assistantArchitects)
        .where(eq(assistantArchitects.id, assistantId))
        .limit(1),
    "getAssistantById"
  )

  const assistant = rows[0]
  if (!assistant) return null

  // Fetch input fields and prompt count in parallel
  const [inputFieldRows, promptCountRows] = await Promise.all([
    executeQuery(
      (db) =>
        db
          .select({
            id: toolInputFields.id,
            name: toolInputFields.name,
            label: toolInputFields.label,
            fieldType: toolInputFields.fieldType,
            position: toolInputFields.position,
            options: toolInputFields.options,
          })
          .from(toolInputFields)
          .where(eq(toolInputFields.assistantArchitectId, assistantId))
          .orderBy(toolInputFields.position),
      "getAssistantInputFields"
    ),
    executeQuery(
      (db) =>
        db
          .select({ count: sql<number>`COUNT(*)::int` })
          .from(chainPrompts)
          .where(eq(chainPrompts.assistantArchitectId, assistantId)),
      "getAssistantPromptCount"
    ),
  ])

  log.info("Retrieved assistant details", {
    assistantId,
    inputFieldCount: inputFieldRows.length,
    promptCount: promptCountRows[0]?.count ?? 0,
  })

  return {
    id: assistant.id,
    name: assistant.name,
    description: assistant.description,
    status: assistant.status,
    timeoutSeconds: assistant.timeoutSeconds,
    inputFields: inputFieldRows.map((f) => ({
      id: f.id,
      name: f.name,
      label: f.label,
      fieldType: f.fieldType,
      position: f.position,
      options: f.options,
    })),
    promptCount: promptCountRows[0]?.count ?? 0,
    createdAt: assistant.createdAt,
    updatedAt: assistant.updatedAt,
  }
}

/**
 * Get the raw assistant row for access control checks.
 * Returns just the fields needed for validateAssistantAccess().
 */
export async function getAssistantForAccessCheck(
  assistantId: number
): Promise<{ userId: number | null; status: string } | null> {
  const rows = await executeQuery(
    (db) =>
      db
        .select({
          userId: assistantArchitects.userId,
          status: assistantArchitects.status,
        })
        .from(assistantArchitects)
        .where(eq(assistantArchitects.id, assistantId))
        .limit(1),
    "getAssistantForAccessCheck"
  )

  const row = rows[0]
  // Only a genuinely missing row is "not found" (404). A null owner (e.g. a
  // system/seeded assistant, or one whose owner row was deleted) is a real row —
  // return it and let validateAssistantAccess decide (an approved orphan is still
  // runnable; the owner check simply fails) rather than 404-ing it (REV-COR-524).
  if (!row) return null

  return { userId: row.userId, status: row.status }
}
