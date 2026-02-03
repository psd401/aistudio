"use server"

import {
  createLogger,
  generateRequestId,
  startTimer,
  sanitizeForLogging,
} from "@/lib/logger"
import {
  handleError,
  ErrorFactories,
  createSuccess,
} from "@/lib/error-utils"
import type { ActionState } from "@/types"
import { requireRole } from "@/lib/auth/role-helpers"
import { executeQuery } from "@/lib/db/drizzle-client"
import { eq, sql, desc, count, gte, and, ilike, or, asc } from "drizzle-orm"
import { users } from "@/lib/db/schema"
import { nexusConversations } from "@/lib/db/schema/tables/nexus-conversations"
import { nexusMessages } from "@/lib/db/schema/tables/nexus-messages"
import { executionResults } from "@/lib/db/schema/tables/execution-results"
import { scheduledExecutions } from "@/lib/db/schema/tables/scheduled-executions"
import { assistantArchitects } from "@/lib/db/schema/tables/assistant-architects"
import { modelComparisons } from "@/lib/db/schema/tables/model-comparisons"
import { getDateThreshold } from "@/lib/date-utils"

// ============================================
// Types
// ============================================

export interface ActivityStats {
  totalNexusConversations: number
  totalArchitectExecutions: number
  totalComparisons: number
  nexus24h: number
  executions24h: number
  comparisons24h: number
  nexus7d: number
  executions7d: number
  comparisons7d: number
  activeUsers7d: number
}

export interface NexusActivityItem {
  id: string
  userId: number
  userEmail: string | null
  userName: string
  title: string | null
  provider: string
  modelUsed: string | null
  messageCount: number
  totalTokens: number
  lastMessageAt: Date | null
  createdAt: Date | null
}

export interface NexusMessageItem {
  id: string
  role: string
  content: string | null
  tokenUsage: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
  } | null
  createdAt: Date | null
}

export interface ExecutionActivityItem {
  id: number
  status: string
  executedAt: Date | null
  executionDurationMs: number | null
  assistantName: string
  scheduleName: string
  userName: string
  userEmail: string | null
  errorMessage: string | null
}

export interface ExecutionDetailItem extends ExecutionActivityItem {
  resultData: Record<string, unknown>
  assistantDescription: string | null
  inputData: Record<string, string>
}

export interface ComparisonActivityItem {
  id: number
  userId: number | null
  userName: string
  userEmail: string | null
  prompt: string
  model1Name: string | null
  model2Name: string | null
  executionTimeMs1: number | null
  executionTimeMs2: number | null
  tokensUsed1: number | null
  tokensUsed2: number | null
  createdAt: Date | null
}

export interface ComparisonDetailItem extends ComparisonActivityItem {
  response1: string | null
  response2: string | null
  metadata: Record<string, unknown>
}

export interface ActivityFilters {
  search?: string
  userId?: number
  dateFrom?: string
  dateTo?: string
  page?: number
  pageSize?: number
}

// ============================================
// Server Actions
// ============================================

/**
 * Get activity dashboard statistics
 */
export async function getActivityStats(): Promise<ActionState<ActivityStats>> {
  const requestId = generateRequestId()
  const timer = startTimer("getActivityStats")
  const log = createLogger({ requestId, action: "getActivityStats" })

  try {
    log.info("Fetching activity stats")

    // Verify admin role
    await requireRole("administrator")

    const oneDayAgo = getDateThreshold(1)
    const sevenDaysAgo = getDateThreshold(7)

    // Parallelize all stat queries
    const [
      nexusTotalResult,
      nexus24hResult,
      nexus7dResult,
      executionsTotalResult,
      executions24hResult,
      executions7dResult,
      comparisonsTotalResult,
      comparisons24hResult,
      comparisons7dResult,
      activeUsersResult,
    ] = await Promise.all([
      // Nexus conversations
      executeQuery(
        (db) => db.select({ count: count() }).from(nexusConversations),
        "getActivityStats-nexusTotal"
      ),
      executeQuery(
        (db) =>
          db
            .select({ count: count() })
            .from(nexusConversations)
            .where(gte(nexusConversations.createdAt, oneDayAgo)),
        "getActivityStats-nexus24h"
      ),
      executeQuery(
        (db) =>
          db
            .select({ count: count() })
            .from(nexusConversations)
            .where(gte(nexusConversations.createdAt, sevenDaysAgo)),
        "getActivityStats-nexus7d"
      ),
      // Execution results
      executeQuery(
        (db) => db.select({ count: count() }).from(executionResults),
        "getActivityStats-executionsTotal"
      ),
      executeQuery(
        (db) =>
          db
            .select({ count: count() })
            .from(executionResults)
            .where(gte(executionResults.executedAt, oneDayAgo)),
        "getActivityStats-executions24h"
      ),
      executeQuery(
        (db) =>
          db
            .select({ count: count() })
            .from(executionResults)
            .where(gte(executionResults.executedAt, sevenDaysAgo)),
        "getActivityStats-executions7d"
      ),
      // Model comparisons
      executeQuery(
        (db) => db.select({ count: count() }).from(modelComparisons),
        "getActivityStats-comparisonsTotal"
      ),
      executeQuery(
        (db) =>
          db
            .select({ count: count() })
            .from(modelComparisons)
            .where(gte(modelComparisons.createdAt, oneDayAgo)),
        "getActivityStats-comparisons24h"
      ),
      executeQuery(
        (db) =>
          db
            .select({ count: count() })
            .from(modelComparisons)
            .where(gte(modelComparisons.createdAt, sevenDaysAgo)),
        "getActivityStats-comparisons7d"
      ),
      // Active users (based on nexus conversations in last 7 days)
      executeQuery(
        (db) =>
          db
            .select({ count: sql<number>`count(distinct ${nexusConversations.userId})::int` })
            .from(nexusConversations)
            .where(gte(nexusConversations.createdAt, sevenDaysAgo)),
        "getActivityStats-activeUsers"
      ),
    ])

    const stats: ActivityStats = {
      totalNexusConversations: nexusTotalResult[0]?.count ?? 0,
      totalArchitectExecutions: executionsTotalResult[0]?.count ?? 0,
      totalComparisons: comparisonsTotalResult[0]?.count ?? 0,
      nexus24h: nexus24hResult[0]?.count ?? 0,
      executions24h: executions24hResult[0]?.count ?? 0,
      comparisons24h: comparisons24hResult[0]?.count ?? 0,
      nexus7d: nexus7dResult[0]?.count ?? 0,
      executions7d: executions7dResult[0]?.count ?? 0,
      comparisons7d: comparisons7dResult[0]?.count ?? 0,
      activeUsers7d: activeUsersResult[0]?.count ?? 0,
    }

    timer({ status: "success" })
    log.info("Activity stats fetched", sanitizeForLogging(stats))

    return createSuccess(stats, "Stats fetched successfully")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to fetch activity stats", {
      context: "getActivityStats",
      requestId,
      operation: "getActivityStats",
    })
  }
}

/**
 * Get paginated Nexus conversations with user info
 */
export async function getNexusActivity(
  filters?: ActivityFilters
): Promise<ActionState<{ items: NexusActivityItem[]; total: number }>> {
  const requestId = generateRequestId()
  const timer = startTimer("getNexusActivity")
  const log = createLogger({ requestId, action: "getNexusActivity" })

  try {
    log.info("Fetching Nexus activity", { filters: sanitizeForLogging(filters) })

    await requireRole("administrator")

    const page = filters?.page ?? 1
    const pageSize = Math.min(filters?.pageSize ?? 25, 100)
    const offset = (page - 1) * pageSize

    // Validate pagination
    if (page < 1) {
      throw ErrorFactories.invalidInput("page", page, "Must be >= 1")
    }
    if (pageSize < 1 || pageSize > 100) {
      throw ErrorFactories.invalidInput("pageSize", pageSize, "Must be between 1 and 100")
    }

    // Build conditions
    const conditions = []

    if (filters?.search) {
      const searchInput = filters.search.trim()
      if (searchInput.length > 100) {
        throw ErrorFactories.invalidInput("search", searchInput, "Must be 100 characters or less")
      }
      if (searchInput.length > 0) {
        const escapedInput = searchInput
          .replace(/\\/g, "\\\\")
          .replace(/%/g, "\\%")
          .replace(/_/g, "\\_")
        const searchTerm = `%${escapedInput}%`
        conditions.push(
          or(
            ilike(nexusConversations.title, searchTerm),
            ilike(users.email, searchTerm),
            ilike(users.firstName, searchTerm),
            ilike(users.lastName, searchTerm)
          )!
        )
      }
    }

    if (filters?.userId) {
      conditions.push(eq(nexusConversations.userId, filters.userId))
    }

    if (filters?.dateFrom) {
      conditions.push(gte(nexusConversations.createdAt, new Date(filters.dateFrom)))
    }

    if (filters?.dateTo) {
      const endDate = new Date(filters.dateTo)
      endDate.setHours(23, 59, 59, 999)
      conditions.push(sql`${nexusConversations.createdAt} <= ${endDate}`)
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined

    // Parallel fetch: data + count
    const [items, countResult] = await Promise.all([
      executeQuery(
        (db) =>
          db
            .select({
              id: nexusConversations.id,
              userId: nexusConversations.userId,
              userEmail: users.email,
              userName: sql<string>`COALESCE(CONCAT(${users.firstName}, ' ', ${users.lastName}), 'Unknown')`,
              title: nexusConversations.title,
              provider: nexusConversations.provider,
              modelUsed: nexusConversations.modelUsed,
              messageCount: nexusConversations.messageCount,
              totalTokens: nexusConversations.totalTokens,
              lastMessageAt: nexusConversations.lastMessageAt,
              createdAt: nexusConversations.createdAt,
            })
            .from(nexusConversations)
            .innerJoin(users, eq(nexusConversations.userId, users.id))
            .where(whereClause)
            .orderBy(desc(nexusConversations.lastMessageAt))
            .limit(pageSize)
            .offset(offset),
        "getNexusActivity-list"
      ),
      executeQuery(
        (db) =>
          db
            .select({ count: count() })
            .from(nexusConversations)
            .innerJoin(users, eq(nexusConversations.userId, users.id))
            .where(whereClause),
        "getNexusActivity-count"
      ),
    ])

    timer({ status: "success" })
    log.info("Nexus activity fetched", { count: items.length, total: countResult[0]?.count ?? 0 })

    return createSuccess(
      { items: items as NexusActivityItem[], total: countResult[0]?.count ?? 0 },
      "Activity fetched successfully"
    )
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to fetch Nexus activity", {
      context: "getNexusActivity",
      requestId,
      operation: "getNexusActivity",
    })
  }
}

/**
 * Get messages for a specific conversation
 */
export async function getConversationMessages(
  conversationId: string
): Promise<ActionState<NexusMessageItem[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("getConversationMessages")
  const log = createLogger({ requestId, action: "getConversationMessages" })

  try {
    log.info("Fetching conversation messages", { conversationId })

    await requireRole("administrator")

    if (!conversationId) {
      throw ErrorFactories.invalidInput("conversationId", conversationId, "Required")
    }

    // Verify conversation exists
    const conversation = await executeQuery(
      (db) =>
        db
          .select({ id: nexusConversations.id })
          .from(nexusConversations)
          .where(eq(nexusConversations.id, conversationId))
          .limit(1),
      "getConversationMessages-check"
    )

    if (conversation.length === 0) {
      throw ErrorFactories.dbRecordNotFound("nexus_conversations", conversationId)
    }

    // Fetch messages
    const messages = await executeQuery(
      (db) =>
        db
          .select({
            id: nexusMessages.id,
            role: nexusMessages.role,
            content: nexusMessages.content,
            tokenUsage: nexusMessages.tokenUsage,
            createdAt: nexusMessages.createdAt,
          })
          .from(nexusMessages)
          .where(eq(nexusMessages.conversationId, conversationId))
          .orderBy(asc(nexusMessages.createdAt)),
      "getConversationMessages-list"
    )

    timer({ status: "success" })
    log.info("Conversation messages fetched", { count: messages.length })

    return createSuccess(messages as NexusMessageItem[], "Messages fetched successfully")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to fetch conversation messages", {
      context: "getConversationMessages",
      requestId,
      operation: "getConversationMessages",
    })
  }
}

/**
 * Get paginated execution results with assistant info
 */
export async function getExecutionActivity(
  filters?: ActivityFilters & { status?: string }
): Promise<ActionState<{ items: ExecutionActivityItem[]; total: number }>> {
  const requestId = generateRequestId()
  const timer = startTimer("getExecutionActivity")
  const log = createLogger({ requestId, action: "getExecutionActivity" })

  try {
    log.info("Fetching execution activity", { filters: sanitizeForLogging(filters) })

    await requireRole("administrator")

    const page = filters?.page ?? 1
    const pageSize = Math.min(filters?.pageSize ?? 25, 100)
    const offset = (page - 1) * pageSize

    if (page < 1) {
      throw ErrorFactories.invalidInput("page", page, "Must be >= 1")
    }

    // Build conditions
    const conditions = []

    if (filters?.status) {
      conditions.push(eq(executionResults.status, filters.status))
    }

    if (filters?.dateFrom) {
      conditions.push(gte(executionResults.executedAt, new Date(filters.dateFrom)))
    }

    if (filters?.dateTo) {
      const endDate = new Date(filters.dateTo)
      endDate.setHours(23, 59, 59, 999)
      conditions.push(sql`${executionResults.executedAt} <= ${endDate}`)
    }

    if (filters?.search) {
      const searchInput = filters.search.trim()
      if (searchInput.length > 100) {
        throw ErrorFactories.invalidInput("search", searchInput, "Must be 100 characters or less")
      }
      if (searchInput.length > 0) {
        const escapedInput = searchInput
          .replace(/\\/g, "\\\\")
          .replace(/%/g, "\\%")
          .replace(/_/g, "\\_")
        const searchTerm = `%${escapedInput}%`
        conditions.push(
          or(
            ilike(assistantArchitects.name, searchTerm),
            ilike(scheduledExecutions.name, searchTerm),
            ilike(users.email, searchTerm)
          )!
        )
      }
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined

    const [items, countResult] = await Promise.all([
      executeQuery(
        (db) =>
          db
            .select({
              id: executionResults.id,
              status: executionResults.status,
              executedAt: executionResults.executedAt,
              executionDurationMs: executionResults.executionDurationMs,
              assistantName: assistantArchitects.name,
              scheduleName: scheduledExecutions.name,
              userName: sql<string>`COALESCE(CONCAT(${users.firstName}, ' ', ${users.lastName}), 'Unknown')`,
              userEmail: users.email,
              errorMessage: executionResults.errorMessage,
            })
            .from(executionResults)
            .innerJoin(
              scheduledExecutions,
              eq(executionResults.scheduledExecutionId, scheduledExecutions.id)
            )
            .innerJoin(
              assistantArchitects,
              eq(scheduledExecutions.assistantArchitectId, assistantArchitects.id)
            )
            .innerJoin(users, eq(scheduledExecutions.userId, users.id))
            .where(whereClause)
            .orderBy(desc(executionResults.executedAt))
            .limit(pageSize)
            .offset(offset),
        "getExecutionActivity-list"
      ),
      executeQuery(
        (db) =>
          db
            .select({ count: count() })
            .from(executionResults)
            .innerJoin(
              scheduledExecutions,
              eq(executionResults.scheduledExecutionId, scheduledExecutions.id)
            )
            .innerJoin(
              assistantArchitects,
              eq(scheduledExecutions.assistantArchitectId, assistantArchitects.id)
            )
            .innerJoin(users, eq(scheduledExecutions.userId, users.id))
            .where(whereClause),
        "getExecutionActivity-count"
      ),
    ])

    timer({ status: "success" })
    log.info("Execution activity fetched", { count: items.length, total: countResult[0]?.count ?? 0 })

    return createSuccess(
      { items: items as ExecutionActivityItem[], total: countResult[0]?.count ?? 0 },
      "Activity fetched successfully"
    )
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to fetch execution activity", {
      context: "getExecutionActivity",
      requestId,
      operation: "getExecutionActivity",
    })
  }
}

/**
 * Get detailed execution result
 */
export async function getExecutionDetail(
  executionId: number
): Promise<ActionState<ExecutionDetailItem | null>> {
  const requestId = generateRequestId()
  const timer = startTimer("getExecutionDetail")
  const log = createLogger({ requestId, action: "getExecutionDetail" })

  try {
    log.info("Fetching execution detail", { executionId })

    await requireRole("administrator")

    if (!executionId || executionId < 1) {
      throw ErrorFactories.invalidInput("executionId", executionId, "Must be a positive integer")
    }

    const result = await executeQuery(
      (db) =>
        db
          .select({
            id: executionResults.id,
            status: executionResults.status,
            executedAt: executionResults.executedAt,
            executionDurationMs: executionResults.executionDurationMs,
            resultData: executionResults.resultData,
            errorMessage: executionResults.errorMessage,
            assistantName: assistantArchitects.name,
            assistantDescription: assistantArchitects.description,
            scheduleName: scheduledExecutions.name,
            inputData: scheduledExecutions.inputData,
            userName: sql<string>`COALESCE(CONCAT(${users.firstName}, ' ', ${users.lastName}), 'Unknown')`,
            userEmail: users.email,
          })
          .from(executionResults)
          .innerJoin(
            scheduledExecutions,
            eq(executionResults.scheduledExecutionId, scheduledExecutions.id)
          )
          .innerJoin(
            assistantArchitects,
            eq(scheduledExecutions.assistantArchitectId, assistantArchitects.id)
          )
          .innerJoin(users, eq(scheduledExecutions.userId, users.id))
          .where(eq(executionResults.id, executionId))
          .limit(1),
      "getExecutionDetail"
    )

    if (result.length === 0) {
      throw ErrorFactories.dbRecordNotFound("execution_results", executionId)
    }

    timer({ status: "success" })
    log.info("Execution detail fetched", { executionId })

    return createSuccess(result[0] as ExecutionDetailItem, "Detail fetched successfully")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to fetch execution detail", {
      context: "getExecutionDetail",
      requestId,
      operation: "getExecutionDetail",
    })
  }
}

/**
 * Get paginated model comparisons
 */
export async function getComparisonActivity(
  filters?: ActivityFilters
): Promise<ActionState<{ items: ComparisonActivityItem[]; total: number }>> {
  const requestId = generateRequestId()
  const timer = startTimer("getComparisonActivity")
  const log = createLogger({ requestId, action: "getComparisonActivity" })

  try {
    log.info("Fetching comparison activity", { filters: sanitizeForLogging(filters) })

    await requireRole("administrator")

    const page = filters?.page ?? 1
    const pageSize = Math.min(filters?.pageSize ?? 25, 100)
    const offset = (page - 1) * pageSize

    if (page < 1) {
      throw ErrorFactories.invalidInput("page", page, "Must be >= 1")
    }

    // Build conditions
    const conditions = []

    if (filters?.userId) {
      conditions.push(eq(modelComparisons.userId, filters.userId))
    }

    if (filters?.dateFrom) {
      conditions.push(gte(modelComparisons.createdAt, new Date(filters.dateFrom)))
    }

    if (filters?.dateTo) {
      const endDate = new Date(filters.dateTo)
      endDate.setHours(23, 59, 59, 999)
      conditions.push(sql`${modelComparisons.createdAt} <= ${endDate}`)
    }

    if (filters?.search) {
      const searchInput = filters.search.trim()
      if (searchInput.length > 100) {
        throw ErrorFactories.invalidInput("search", searchInput, "Must be 100 characters or less")
      }
      if (searchInput.length > 0) {
        const escapedInput = searchInput
          .replace(/\\/g, "\\\\")
          .replace(/%/g, "\\%")
          .replace(/_/g, "\\_")
        const searchTerm = `%${escapedInput}%`
        conditions.push(
          or(
            ilike(modelComparisons.prompt, searchTerm),
            ilike(modelComparisons.model1Name, searchTerm),
            ilike(modelComparisons.model2Name, searchTerm),
            ilike(users.email, searchTerm)
          )!
        )
      }
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined

    const [items, countResult] = await Promise.all([
      executeQuery(
        (db) =>
          db
            .select({
              id: modelComparisons.id,
              userId: modelComparisons.userId,
              userName: sql<string>`COALESCE(CONCAT(${users.firstName}, ' ', ${users.lastName}), 'Anonymous')`,
              userEmail: users.email,
              prompt: modelComparisons.prompt,
              model1Name: modelComparisons.model1Name,
              model2Name: modelComparisons.model2Name,
              executionTimeMs1: modelComparisons.executionTimeMs1,
              executionTimeMs2: modelComparisons.executionTimeMs2,
              tokensUsed1: modelComparisons.tokensUsed1,
              tokensUsed2: modelComparisons.tokensUsed2,
              createdAt: modelComparisons.createdAt,
            })
            .from(modelComparisons)
            .leftJoin(users, eq(modelComparisons.userId, users.id))
            .where(whereClause)
            .orderBy(desc(modelComparisons.createdAt))
            .limit(pageSize)
            .offset(offset),
        "getComparisonActivity-list"
      ),
      executeQuery(
        (db) =>
          db
            .select({ count: count() })
            .from(modelComparisons)
            .leftJoin(users, eq(modelComparisons.userId, users.id))
            .where(whereClause),
        "getComparisonActivity-count"
      ),
    ])

    timer({ status: "success" })
    log.info("Comparison activity fetched", { count: items.length, total: countResult[0]?.count ?? 0 })

    return createSuccess(
      { items: items as ComparisonActivityItem[], total: countResult[0]?.count ?? 0 },
      "Activity fetched successfully"
    )
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to fetch comparison activity", {
      context: "getComparisonActivity",
      requestId,
      operation: "getComparisonActivity",
    })
  }
}

/**
 * Get detailed model comparison
 */
export async function getComparisonDetail(
  comparisonId: number
): Promise<ActionState<ComparisonDetailItem | null>> {
  const requestId = generateRequestId()
  const timer = startTimer("getComparisonDetail")
  const log = createLogger({ requestId, action: "getComparisonDetail" })

  try {
    log.info("Fetching comparison detail", { comparisonId })

    await requireRole("administrator")

    if (!comparisonId || comparisonId < 1) {
      throw ErrorFactories.invalidInput("comparisonId", comparisonId, "Must be a positive integer")
    }

    const result = await executeQuery(
      (db) =>
        db
          .select({
            id: modelComparisons.id,
            userId: modelComparisons.userId,
            userName: sql<string>`COALESCE(CONCAT(${users.firstName}, ' ', ${users.lastName}), 'Anonymous')`,
            userEmail: users.email,
            prompt: modelComparisons.prompt,
            model1Name: modelComparisons.model1Name,
            model2Name: modelComparisons.model2Name,
            response1: modelComparisons.response1,
            response2: modelComparisons.response2,
            executionTimeMs1: modelComparisons.executionTimeMs1,
            executionTimeMs2: modelComparisons.executionTimeMs2,
            tokensUsed1: modelComparisons.tokensUsed1,
            tokensUsed2: modelComparisons.tokensUsed2,
            metadata: modelComparisons.metadata,
            createdAt: modelComparisons.createdAt,
          })
          .from(modelComparisons)
          .leftJoin(users, eq(modelComparisons.userId, users.id))
          .where(eq(modelComparisons.id, comparisonId))
          .limit(1),
      "getComparisonDetail"
    )

    if (result.length === 0) {
      throw ErrorFactories.dbRecordNotFound("model_comparisons", comparisonId)
    }

    timer({ status: "success" })
    log.info("Comparison detail fetched", { comparisonId })

    return createSuccess(result[0] as ComparisonDetailItem, "Detail fetched successfully")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to fetch comparison detail", {
      context: "getComparisonDetail",
      requestId,
      operation: "getComparisonDetail",
    })
  }
}
