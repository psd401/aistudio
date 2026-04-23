"use server"

import {
  createLogger,
  generateRequestId,
  startTimer,
} from "@/lib/logger"
import {
  handleError,
  createSuccess,
} from "@/lib/error-utils"
import type { ActionState } from "@/types"
import { requireRole } from "@/lib/auth/role-helpers"
import { executeQuery } from "@/lib/db/drizzle-client"
import { sql, desc, count, gte, and, eq } from "drizzle-orm"
import { agentMessages } from "@/lib/db/schema/tables/agent-messages"
import { agentSessions } from "@/lib/db/schema/tables/agent-sessions"
import { agentFeedback } from "@/lib/db/schema/tables/agent-feedback"
import { getDateThreshold } from "@/lib/date-utils"

// ============================================
// Types
// ============================================

export type TelemetryDateRange = "7d" | "30d" | "90d" | "all"

export interface AgentTelemetryStats {
  totalMessages: number
  totalSessions: number
  totalTokens: number
  totalFeedback: number
  positiveRate: number
  activeUsers7d: number
  messages24h: number
  messages7d: number
  guardrailFlags: number
  avgLatencyMs: number
}

export interface DailyUsagePoint {
  date: string
  messages: number
  tokens: number
  sessions: number
}

export interface ModelBreakdownItem {
  model: string
  messageCount: number
  totalTokens: number
  avgLatencyMs: number
}

export interface UserUsageItem {
  userId: string
  messageCount: number
  totalTokens: number
  sessionCount: number
  lastActive: string | null
}

export interface GuardrailEvent {
  id: number
  userId: string
  model: string | null
  spaceName: string | null
  createdAt: string
}

export interface FeedbackItem {
  id: number
  userId: string
  messageId: number
  thumbsUp: boolean
  createdAt: string
}

// ============================================
// Helpers
// ============================================

function getDateRangeThreshold(range: TelemetryDateRange): Date | null {
  switch (range) {
    case "7d":
      return getDateThreshold(7)
    case "30d":
      return getDateThreshold(30)
    case "90d":
      return getDateThreshold(90)
    case "all":
      return null
  }
}

// ============================================
// Actions
// ============================================

/**
 * Get aggregate telemetry statistics for the agent platform.
 */
export async function getAgentTelemetryStats(
  range: TelemetryDateRange = "30d"
): Promise<ActionState<AgentTelemetryStats>> {
  const requestId = generateRequestId()
  const timer = startTimer("getAgentTelemetryStats")
  const log = createLogger({ requestId, action: "getAgentTelemetryStats" })

  try {
    await requireRole("administrator")

    const threshold = getDateRangeThreshold(range)
    const threshold24h = getDateThreshold(1)
    const threshold7d = getDateThreshold(7)

    // Run all stats queries in parallel
    const [
      messageStats,
      sessionStats,
      feedbackStats,
      activeUsers7d,
      messages24h,
      messages7d,
      guardrailFlags,
    ] = await Promise.all([
      // Total messages + tokens + avg latency
      executeQuery(
        (db) =>
          db
            .select({
              totalMessages: count(agentMessages.id),
              totalTokens:
                sql<number>`COALESCE(SUM(${agentMessages.inputTokens} + ${agentMessages.outputTokens}), 0)`,
              avgLatencyMs:
                sql<number>`COALESCE(AVG(${agentMessages.latencyMs}), 0)`,
            })
            .from(agentMessages)
            .where(
              threshold
                ? gte(agentMessages.createdAt, threshold)
                : undefined
            ),
        "agentTelemetry.messageStats"
      ),

      // Total sessions
      executeQuery(
        (db) =>
          db
            .select({ totalSessions: count(agentSessions.id) })
            .from(agentSessions)
            .where(
              threshold
                ? gte(agentSessions.sessionStart, threshold)
                : undefined
            ),
        "agentTelemetry.sessionStats"
      ),

      // Feedback stats
      executeQuery(
        (db) =>
          db
            .select({
              totalFeedback: count(agentFeedback.id),
              positiveCount:
                sql<number>`COUNT(CASE WHEN ${agentFeedback.thumbsUp} THEN 1 END)`,
            })
            .from(agentFeedback)
            .where(
              threshold
                ? gte(agentFeedback.createdAt, threshold)
                : undefined
            ),
        "agentTelemetry.feedbackStats"
      ),

      // Active users in last 7 days
      executeQuery(
        (db) =>
          db
            .select({
              userCount:
                sql<number>`COUNT(DISTINCT ${agentMessages.userId})`,
            })
            .from(agentMessages)
            .where(gte(agentMessages.createdAt, threshold7d)),
        "agentTelemetry.activeUsers7d"
      ),

      // Messages in last 24h
      executeQuery(
        (db) =>
          db
            .select({ cnt: count(agentMessages.id) })
            .from(agentMessages)
            .where(gte(agentMessages.createdAt, threshold24h)),
        "agentTelemetry.messages24h"
      ),

      // Messages in last 7d
      executeQuery(
        (db) =>
          db
            .select({ cnt: count(agentMessages.id) })
            .from(agentMessages)
            .where(gte(agentMessages.createdAt, threshold7d)),
        "agentTelemetry.messages7d"
      ),

      // Guardrail flags count
      executeQuery(
        (db) =>
          db
            .select({ cnt: count(agentMessages.id) })
            .from(agentMessages)
            .where(
              threshold
                ? and(
                    eq(agentMessages.guardrailBlocked, true),
                    gte(agentMessages.createdAt, threshold)
                  )
                : eq(agentMessages.guardrailBlocked, true)
            ),
        "agentTelemetry.guardrailFlags"
      ),
    ])

    const msgRow = messageStats[0]
    const sessRow = sessionStats[0]
    const fbRow = feedbackStats[0]
    const totalFeedback = Number(fbRow?.totalFeedback ?? 0)
    const positiveCount = Number(fbRow?.positiveCount ?? 0)

    const stats: AgentTelemetryStats = {
      totalMessages: Number(msgRow?.totalMessages ?? 0),
      totalSessions: Number(sessRow?.totalSessions ?? 0),
      totalTokens: Number(msgRow?.totalTokens ?? 0),
      totalFeedback,
      positiveRate: totalFeedback > 0 ? positiveCount / totalFeedback : 0,
      activeUsers7d: Number(activeUsers7d[0]?.userCount ?? 0),
      messages24h: Number(messages24h[0]?.cnt ?? 0),
      messages7d: Number(messages7d[0]?.cnt ?? 0),
      guardrailFlags: Number(guardrailFlags[0]?.cnt ?? 0),
      avgLatencyMs: Math.round(Number(msgRow?.avgLatencyMs ?? 0)),
    }

    timer({ status: "success" })
    log.info("Agent telemetry stats loaded", { range })
    return createSuccess(stats)
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to load agent telemetry stats", {
      context: "getAgentTelemetryStats",
      requestId,
      operation: "getAgentTelemetryStats",
    })
  }
}

/**
 * Get daily usage data for charts.
 */
export async function getAgentDailyUsage(
  range: TelemetryDateRange = "30d"
): Promise<ActionState<DailyUsagePoint[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("getAgentDailyUsage")
  const log = createLogger({ requestId, action: "getAgentDailyUsage" })

  try {
    await requireRole("administrator")

    const threshold = getDateRangeThreshold(range)

    const rows = await executeQuery(
      (db) =>
        db
          .select({
            date: sql<string>`TO_CHAR(${agentMessages.createdAt}, 'YYYY-MM-DD')`,
            messages: count(agentMessages.id),
            tokens:
              sql<number>`COALESCE(SUM(${agentMessages.inputTokens} + ${agentMessages.outputTokens}), 0)`,
            sessions:
              sql<number>`COUNT(DISTINCT ${agentMessages.sessionId})`,
          })
          .from(agentMessages)
          .where(
            threshold ? gte(agentMessages.createdAt, threshold) : undefined
          )
          .groupBy(
            sql`TO_CHAR(${agentMessages.createdAt}, 'YYYY-MM-DD')`
          )
          .orderBy(
            sql`TO_CHAR(${agentMessages.createdAt}, 'YYYY-MM-DD')`
          ),
      "agentTelemetry.dailyUsage"
    )

    const data: DailyUsagePoint[] = rows.map((r) => ({
      date: String(r.date),
      messages: Number(r.messages),
      tokens: Number(r.tokens),
      sessions: Number(r.sessions),
    }))

    timer({ status: "success" })
    log.info("Agent daily usage loaded", { range, points: data.length })
    return createSuccess(data)
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to load agent daily usage", {
      context: "getAgentDailyUsage",
      requestId,
      operation: "getAgentDailyUsage",
    })
  }
}

/**
 * Get model usage breakdown.
 */
export async function getAgentModelBreakdown(
  range: TelemetryDateRange = "30d"
): Promise<ActionState<ModelBreakdownItem[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("getAgentModelBreakdown")
  const log = createLogger({ requestId, action: "getAgentModelBreakdown" })

  try {
    await requireRole("administrator")

    const threshold = getDateRangeThreshold(range)

    const rows = await executeQuery(
      (db) =>
        db
          .select({
            model: sql<string>`COALESCE(${agentMessages.model}, 'unknown')`,
            messageCount: count(agentMessages.id),
            totalTokens:
              sql<number>`COALESCE(SUM(${agentMessages.inputTokens} + ${agentMessages.outputTokens}), 0)`,
            avgLatencyMs:
              sql<number>`COALESCE(AVG(${agentMessages.latencyMs}), 0)`,
          })
          .from(agentMessages)
          .where(
            threshold ? gte(agentMessages.createdAt, threshold) : undefined
          )
          .groupBy(sql`COALESCE(${agentMessages.model}, 'unknown')`)
          .orderBy(desc(count(agentMessages.id))),
      "agentTelemetry.modelBreakdown"
    )

    const data: ModelBreakdownItem[] = rows.map((r) => ({
      model: String(r.model),
      messageCount: Number(r.messageCount),
      totalTokens: Number(r.totalTokens),
      avgLatencyMs: Math.round(Number(r.avgLatencyMs)),
    }))

    timer({ status: "success" })
    log.info("Agent model breakdown loaded", { range, models: data.length })
    return createSuccess(data)
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to load agent model breakdown", {
      context: "getAgentModelBreakdown",
      requestId,
      operation: "getAgentModelBreakdown",
    })
  }
}

/**
 * Get per-user usage breakdown (top users).
 */
export async function getAgentUserUsage(
  range: TelemetryDateRange = "30d",
  limit = 25
): Promise<ActionState<UserUsageItem[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("getAgentUserUsage")
  const log = createLogger({ requestId, action: "getAgentUserUsage" })

  try {
    await requireRole("administrator")

    const threshold = getDateRangeThreshold(range)

    const rows = await executeQuery(
      (db) =>
        db
          .select({
            userId: agentMessages.userId,
            messageCount: count(agentMessages.id),
            totalTokens:
              sql<number>`COALESCE(SUM(${agentMessages.inputTokens} + ${agentMessages.outputTokens}), 0)`,
            sessionCount:
              sql<number>`COUNT(DISTINCT ${agentMessages.sessionId})`,
            lastActive:
              sql<string>`MAX(${agentMessages.createdAt})::text`,
          })
          .from(agentMessages)
          .where(
            threshold ? gte(agentMessages.createdAt, threshold) : undefined
          )
          .groupBy(agentMessages.userId)
          .orderBy(desc(count(agentMessages.id)))
          .limit(limit),
      "agentTelemetry.userUsage"
    )

    const data: UserUsageItem[] = rows.map((r) => ({
      userId: String(r.userId),
      messageCount: Number(r.messageCount),
      totalTokens: Number(r.totalTokens),
      sessionCount: Number(r.sessionCount),
      lastActive: r.lastActive ?? null,
    }))

    timer({ status: "success" })
    log.info("Agent user usage loaded", { range, users: data.length })
    return createSuccess(data)
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to load agent user usage", {
      context: "getAgentUserUsage",
      requestId,
      operation: "getAgentUserUsage",
    })
  }
}

/**
 * Get guardrail flag events (messages where guardrail_blocked = true).
 */
export async function getAgentGuardrailEvents(
  range: TelemetryDateRange = "30d",
  limit = 50
): Promise<ActionState<GuardrailEvent[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("getAgentGuardrailEvents")
  const log = createLogger({ requestId, action: "getAgentGuardrailEvents" })

  try {
    await requireRole("administrator")

    const threshold = getDateRangeThreshold(range)

    const rows = await executeQuery(
      (db) =>
        db
          .select({
            id: agentMessages.id,
            userId: agentMessages.userId,
            model: agentMessages.model,
            spaceName: agentMessages.spaceName,
            createdAt: sql<string>`${agentMessages.createdAt}::text`,
          })
          .from(agentMessages)
          .where(
            threshold
              ? and(
                  eq(agentMessages.guardrailBlocked, true),
                  gte(agentMessages.createdAt, threshold)
                )
              : eq(agentMessages.guardrailBlocked, true)
          )
          .orderBy(desc(agentMessages.createdAt))
          .limit(limit),
      "agentTelemetry.guardrailEvents"
    )

    const data: GuardrailEvent[] = rows.map((r) => ({
      id: Number(r.id),
      userId: String(r.userId),
      model: r.model ?? null,
      spaceName: r.spaceName ?? null,
      createdAt: String(r.createdAt),
    }))

    timer({ status: "success" })
    log.info("Agent guardrail events loaded", {
      range,
      events: data.length,
    })
    return createSuccess(data)
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to load agent guardrail events", {
      context: "getAgentGuardrailEvents",
      requestId,
      operation: "getAgentGuardrailEvents",
    })
  }
}

/**
 * Get recent feedback entries.
 */
export async function getAgentFeedbackList(
  range: TelemetryDateRange = "30d",
  limit = 50
): Promise<ActionState<FeedbackItem[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("getAgentFeedbackList")
  const log = createLogger({ requestId, action: "getAgentFeedbackList" })

  try {
    await requireRole("administrator")

    const threshold = getDateRangeThreshold(range)

    const rows = await executeQuery(
      (db) =>
        db
          .select({
            id: agentFeedback.id,
            userId: agentFeedback.userId,
            messageId: agentFeedback.messageId,
            thumbsUp: agentFeedback.thumbsUp,
            createdAt: sql<string>`${agentFeedback.createdAt}::text`,
          })
          .from(agentFeedback)
          .where(
            threshold
              ? gte(agentFeedback.createdAt, threshold)
              : undefined
          )
          .orderBy(desc(agentFeedback.createdAt))
          .limit(limit),
      "agentTelemetry.feedbackList"
    )

    const data: FeedbackItem[] = rows.map((r) => ({
      id: Number(r.id),
      userId: String(r.userId),
      messageId: Number(r.messageId),
      thumbsUp: Boolean(r.thumbsUp),
      createdAt: String(r.createdAt),
    }))

    timer({ status: "success" })
    log.info("Agent feedback list loaded", {
      range,
      items: data.length,
    })
    return createSuccess(data)
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to load agent feedback list", {
      context: "getAgentFeedbackList",
      requestId,
      operation: "getAgentFeedbackList",
    })
  }
}
