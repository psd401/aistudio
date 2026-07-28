"use server"

import { revalidatePath } from "next/cache"
import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm"
import type { z } from "zod"
import type { ActionState } from "@/types"
import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import { createSuccess, ErrorFactories, handleError } from "@/lib/error-utils"
import { getServerSession } from "@/lib/auth/server-session"
import { getUserIdByCognitoSubAsNumber } from "@/lib/db/drizzle"
import { executeQuery, executeTransaction } from "@/lib/db/drizzle-client"
import {
  nexusUserMemories,
  nexusUserPreferences,
  type NexusMemoryCategory,
  type NexusMemorySource,
} from "@/lib/db/schema"
import { memoryService } from "@/lib/nexus/memory/memory-service"
import {
  isNexusMemoryEnabledForUser,
  isNexusMemoryGloballyEnabled,
} from "@/lib/nexus/memory/memory-availability"
import { NEXUS_MEMORY_SETTINGS_PAGE_SIZE } from "@/lib/nexus/memory/memory-constants"
import { mergeNexusUserSettings } from "@/lib/nexus/user-settings"
import {
  AddNexusMemorySchema,
  BulkDeleteNexusMemoriesSchema,
  DeleteNexusMemorySchema,
  ListNexusMemoriesSchema,
  SetNexusMemoryEnabledSchema,
  UpdateNexusMemorySchema,
  type AddNexusMemoryInput,
  type ListNexusMemoriesInput,
  type UpdateNexusMemoryInput,
} from "@/lib/nexus/memory/memory-schemas"
import { hasCapabilityAccess } from "@/utils/roles"

export interface NexusMemoryListItem {
  id: string
  content: string
  category: NexusMemoryCategory
  source: NexusMemorySource
  createdAt: string
  updatedAt: string
}

export interface NexusMemoryCursor {
  updatedAtMicros: string
  id: string
}

export interface NexusMemoryTabData {
  memories: NexusMemoryListItem[]
  memoryEnabled: boolean
  globalMemoryEnabled: boolean
  nextCursor: NexusMemoryCursor | null
}

interface MemoryRequester {
  userId: number
  cognitoSub: string
}

interface OwnedMemoryRow {
  id: string
  userId: number
}

function validationFields(error: z.ZodError) {
  return error.issues.map((issue) => ({
    field: issue.path.join("."),
    message: issue.message,
  }))
}

async function requireMemoryRequester(): Promise<MemoryRequester> {
  const session = await getServerSession()
  if (!session) {
    throw ErrorFactories.authNoSession()
  }
  if (!(await hasCapabilityAccess("nexus-memory", session.sub))) {
    throw ErrorFactories.authzInsufficientPermissions(undefined, undefined, {
      requiredPermission: "nexus-memory",
    })
  }
  const userId = await getUserIdByCognitoSubAsNumber(session.sub)
  if (!userId) {
    throw ErrorFactories.dbRecordNotFound("users", session.sub)
  }
  return { userId, cognitoSub: session.sub }
}

async function requireOwnedMemory(
  memoryId: string,
  userId: number,
  operation: string,
): Promise<OwnedMemoryRow> {
  const [memory] = await executeQuery(
    (db) =>
      db
        .select({
          id: nexusUserMemories.id,
          userId: nexusUserMemories.userId,
        })
        .from(nexusUserMemories)
        .where(
          and(
            eq(nexusUserMemories.id, memoryId),
            isNull(nexusUserMemories.deletedAt),
          ),
        )
        .limit(1),
    "getNexusMemoryForOwnershipCheck",
  )
  if (!memory) {
    throw ErrorFactories.dbRecordNotFound("nexus_user_memories", memoryId)
  }
  if (memory.userId !== userId) {
    throw ErrorFactories.authzOwnerRequired(operation)
  }
  return memory
}

async function requireGlobalMemoryEnabled(operation: string): Promise<void> {
  if (!(await isNexusMemoryGloballyEnabled())) {
    throw ErrorFactories.bizInvalidState(
      operation,
      "disabled",
      "enabled",
      { userMessage: "Nexus memory is currently disabled" },
    )
  }
}

async function requireMemoryWritesEnabled(userId: number): Promise<void> {
  await requireGlobalMemoryEnabled("write Nexus memory")
  if (!(await isNexusMemoryEnabledForUser(userId))) {
    throw ErrorFactories.bizInvalidState(
      "write Nexus memory",
      "disabled for this account",
      "enabled for this account",
      {
        userMessage:
          "Enable memory for your account before adding or editing memories",
      },
    )
  }
}

function memoryListItem(memory: {
  id: string
  content: string
  category: NexusMemoryCategory
  source: NexusMemorySource
  createdAt: Date
  updatedAt: Date
}): NexusMemoryListItem {
  return {
    id: memory.id,
    content: memory.content,
    category: memory.category,
    source: memory.source,
    createdAt: memory.createdAt.toISOString(),
    updatedAt: memory.updatedAt.toISOString(),
  }
}

export async function listNexusMemories(
  input: ListNexusMemoriesInput = {},
): Promise<ActionState<NexusMemoryTabData>> {
  const requestId = generateRequestId()
  const timer = startTimer("listNexusMemories")
  const log = createLogger({ requestId, action: "listNexusMemories" })

  try {
    const { userId } = await requireMemoryRequester()
    const parsed = ListNexusMemoriesSchema.safeParse(input)
    if (!parsed.success) {
      throw ErrorFactories.validationFailed(validationFields(parsed.error))
    }
    const updatedAtMicros = sql`
      (extract(epoch from ${nexusUserMemories.updatedAt}) * 1000000)::bigint
    `
    const cursorCondition = parsed.data.cursor
      ? or(
          sql`${updatedAtMicros} < ${parsed.data.cursor.updatedAtMicros}::bigint`,
          and(
            sql`${updatedAtMicros} = ${parsed.data.cursor.updatedAtMicros}::bigint`,
            lt(nexusUserMemories.id, parsed.data.cursor.id),
          ),
        )
      : undefined
    const [memoryRows, preferences, globalMemoryEnabled] = await Promise.all([
      executeQuery(
        (db) =>
          db
            .select({
              id: nexusUserMemories.id,
              content: nexusUserMemories.content,
              category: nexusUserMemories.category,
              source: nexusUserMemories.source,
              createdAt: nexusUserMemories.createdAt,
              updatedAt: nexusUserMemories.updatedAt,
              cursorUpdatedAtMicros: sql<string>`
                ${updatedAtMicros}::text
              `,
            })
            .from(nexusUserMemories)
            .where(
              and(
                eq(nexusUserMemories.userId, userId),
                isNull(nexusUserMemories.deletedAt),
                cursorCondition,
              ),
            )
            .orderBy(
              desc(nexusUserMemories.updatedAt),
              desc(nexusUserMemories.id),
            )
            .limit(NEXUS_MEMORY_SETTINGS_PAGE_SIZE + 1),
        "listOwnedNexusMemories",
      ),
      executeQuery(
        (db) =>
          db
            .select({ settings: nexusUserPreferences.settings })
            .from(nexusUserPreferences)
            .where(eq(nexusUserPreferences.userId, userId))
            .limit(1),
        "getNexusMemoryPreference",
      ),
      isNexusMemoryGloballyEnabled(),
    ])
    const hasMore = memoryRows.length > NEXUS_MEMORY_SETTINGS_PAGE_SIZE
    const memories = memoryRows.slice(0, NEXUS_MEMORY_SETTINGS_PAGE_SIZE)
    const finalMemory = memories[memories.length - 1]
    const data = {
      memories: memories.map(memoryListItem),
      memoryEnabled: preferences[0]?.settings?.memoryEnabled !== false,
      globalMemoryEnabled,
      nextCursor:
        hasMore && finalMemory
          ? {
              updatedAtMicros: finalMemory.cursorUpdatedAtMicros,
              id: finalMemory.id,
            }
          : null,
    }
    timer({ status: "success" })
    log.info("Nexus memories listed", {
      userId,
      count: data.memories.length,
      hasMore,
    })
    return createSuccess(data)
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to load memories", {
      context: "listNexusMemories",
      requestId,
      operation: "listNexusMemories",
    })
  }
}

export async function addNexusMemory(
  input: AddNexusMemoryInput,
): Promise<ActionState<NexusMemoryListItem>> {
  const requestId = generateRequestId()
  const timer = startTimer("addNexusMemory")
  const log = createLogger({ requestId, action: "addNexusMemory" })

  try {
    const requester = await requireMemoryRequester()
    await requireMemoryWritesEnabled(requester.userId)
    const parsed = AddNexusMemorySchema.safeParse(input)
    if (!parsed.success) {
      throw ErrorFactories.validationFailed(validationFields(parsed.error))
    }
    const result = await memoryService.save({
      userId: requester.userId,
      sessionId: requester.cognitoSub,
      content: parsed.data.content,
      category: parsed.data.category,
      source: "manual",
    })
    timer({ status: "success" })
    log.info("Nexus memory saved manually", {
      userId: requester.userId,
      memoryId: result.memory.id,
      action: result.action,
    })
    revalidatePath("/settings")
    return createSuccess(
      memoryListItem(result.memory),
      result.action === "updated"
        ? "A similar memory was updated"
        : "Memory added",
    )
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to add memory", {
      context: "addNexusMemory",
      requestId,
      operation: "addNexusMemory",
    })
  }
}

export async function updateNexusMemory(
  input: UpdateNexusMemoryInput,
): Promise<ActionState<NexusMemoryListItem>> {
  const requestId = generateRequestId()
  const timer = startTimer("updateNexusMemory")
  const log = createLogger({ requestId, action: "updateNexusMemory" })

  try {
    const requester = await requireMemoryRequester()
    await requireMemoryWritesEnabled(requester.userId)
    const parsed = UpdateNexusMemorySchema.safeParse(input)
    if (!parsed.success) {
      throw ErrorFactories.validationFailed(validationFields(parsed.error))
    }
    await requireOwnedMemory(
      parsed.data.memoryId,
      requester.userId,
      "update this memory",
    )
    const memory = await memoryService.update({
      memoryId: parsed.data.memoryId,
      userId: requester.userId,
      sessionId: requester.cognitoSub,
      content: parsed.data.content,
      category: parsed.data.category,
    })
    if (!memory) {
      throw ErrorFactories.dbRecordNotFound(
        "nexus_user_memories",
        parsed.data.memoryId,
      )
    }
    timer({ status: "success" })
    log.info("Nexus memory updated", {
      userId: requester.userId,
      memoryId: memory.id,
    })
    revalidatePath("/settings")
    return createSuccess(memoryListItem(memory), "Memory updated")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to update memory", {
      context: "updateNexusMemory",
      requestId,
      operation: "updateNexusMemory",
    })
  }
}

export async function deleteNexusMemory(
  memoryId: string,
): Promise<ActionState<{ memoryId: string }>> {
  const requestId = generateRequestId()
  const timer = startTimer("deleteNexusMemory")
  const log = createLogger({ requestId, action: "deleteNexusMemory" })

  try {
    const requester = await requireMemoryRequester()
    const parsed = DeleteNexusMemorySchema.safeParse({ memoryId })
    if (!parsed.success) {
      throw ErrorFactories.validationFailed(validationFields(parsed.error))
    }
    await requireOwnedMemory(
      parsed.data.memoryId,
      requester.userId,
      "delete this memory",
    )
    if (!(await memoryService.forget(parsed.data.memoryId, requester.userId))) {
      throw ErrorFactories.dbRecordNotFound(
        "nexus_user_memories",
        parsed.data.memoryId,
      )
    }
    timer({ status: "success" })
    log.info("Nexus memory deleted", {
      userId: requester.userId,
      memoryId: parsed.data.memoryId,
    })
    revalidatePath("/settings")
    return createSuccess({ memoryId: parsed.data.memoryId }, "Memory deleted")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to delete memory", {
      context: "deleteNexusMemory",
      requestId,
      operation: "deleteNexusMemory",
    })
  }
}

export async function bulkDeleteNexusMemories(
  memoryIds: string[],
): Promise<ActionState<{ deletedCount: number }>> {
  const requestId = generateRequestId()
  const timer = startTimer("bulkDeleteNexusMemories")
  const log = createLogger({
    requestId,
    action: "bulkDeleteNexusMemories",
  })

  try {
    const requester = await requireMemoryRequester()
    const parsed = BulkDeleteNexusMemoriesSchema.safeParse({ memoryIds })
    if (!parsed.success) {
      throw ErrorFactories.validationFailed(validationFields(parsed.error))
    }
    const deletedCount = await executeTransaction(async (tx) => {
      const rows = await tx
        .select({
          id: nexusUserMemories.id,
          userId: nexusUserMemories.userId,
        })
        .from(nexusUserMemories)
        .where(
          and(
            inArray(nexusUserMemories.id, parsed.data.memoryIds),
            isNull(nexusUserMemories.deletedAt),
          ),
        )
        .for("update")
      const byId = new Map(rows.map((row) => [row.id, row]))
      for (const memoryId of parsed.data.memoryIds) {
        const row = byId.get(memoryId)
        if (!row) {
          throw ErrorFactories.dbRecordNotFound("nexus_user_memories", memoryId)
        }
        if (row.userId !== requester.userId) {
          throw ErrorFactories.authzOwnerRequired("delete these memories")
        }
      }
      const now = new Date()
      const deleted = await tx
        .update(nexusUserMemories)
        .set({ deletedAt: now, updatedAt: now })
        .where(
          and(
            inArray(nexusUserMemories.id, parsed.data.memoryIds),
            eq(nexusUserMemories.userId, requester.userId),
            isNull(nexusUserMemories.deletedAt),
          ),
        )
        .returning({ id: nexusUserMemories.id })
      if (deleted.length !== parsed.data.memoryIds.length) {
        throw ErrorFactories.dbQueryFailed(
          "Some Nexus memories changed before they could be deleted",
        )
      }
      return deleted.length
    }, "bulkSoftDeleteOwnedNexusMemories")
    timer({ status: "success" })
    log.info("Nexus memories bulk deleted", {
      userId: requester.userId,
      count: deletedCount,
    })
    revalidatePath("/settings")
    return createSuccess({ deletedCount }, `${deletedCount} memories deleted`)
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to delete selected memories", {
      context: "bulkDeleteNexusMemories",
      requestId,
      operation: "bulkDeleteNexusMemories",
    })
  }
}

export async function setNexusMemoryEnabled(
  enabled: boolean,
): Promise<ActionState<{ enabled: boolean }>> {
  const requestId = generateRequestId()
  const timer = startTimer("setNexusMemoryEnabled")
  const log = createLogger({
    requestId,
    action: "setNexusMemoryEnabled",
  })

  try {
    const requester = await requireMemoryRequester()
    const parsed = SetNexusMemoryEnabledSchema.safeParse({ enabled })
    if (!parsed.success) {
      throw ErrorFactories.validationFailed(validationFields(parsed.error))
    }
    await requireGlobalMemoryEnabled("change Nexus memory preference")
    await mergeNexusUserSettings(requester.userId, {
      memoryEnabled: parsed.data.enabled,
    })
    timer({ status: "success" })
    log.info("Nexus memory preference updated", {
      userId: requester.userId,
      enabled: parsed.data.enabled,
    })
    revalidatePath("/settings")
    return createSuccess(
      { enabled: parsed.data.enabled },
      parsed.data.enabled ? "Memory enabled" : "Memory disabled",
    )
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to update memory preference", {
      context: "setNexusMemoryEnabled",
      requestId,
      operation: "setNexusMemoryEnabled",
    })
  }
}
