"use server"

/**
 * Admin server actions for the Conversations tab on /admin/agents.
 *
 * Reads from agent_messages (summary) + agent_message_content (full text)
 * + agent_tool_invocations (timeline). Admin-only. Capped queries to
 * keep the dashboard snappy; deep filtering can be added later when we
 * see what admins actually search for.
 *
 * Privacy contract: viewing requires the `administrator` role. The tables
 * have a 90-day retention sweep (see agent-telemetry-prune Lambda) so
 * the blast radius is bounded.
 */

import { and, desc, eq, gte, sql } from "drizzle-orm"

import { requireRole } from "@/lib/auth/role-helpers"
import { handleError, createSuccess } from "@/lib/error-utils"
import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import { executeQuery } from "@/lib/db/drizzle-client"
import { agentMessages } from "@/lib/db/schema/tables/agent-messages"
import { agentMessageContent } from "@/lib/db/schema/tables/agent-message-content"
import { agentToolInvocations } from "@/lib/db/schema/tables/agent-tool-invocations"
import type { ActionState } from "@/types"

export interface ConversationListItem {
  sessionId: string
  userId: string
  startedAt: string
  lastTurnAt: string
  turnCount: number
  toolCallCount: number
  totalInputTokens: number
  totalOutputTokens: number
  models: string[]
  hasError: boolean
}

export interface ConversationDetailMessage {
  role: string
  contentText: string
  contentTruncated: boolean
  createdAt: string
}

export interface ConversationDetailTool {
  toolName: string
  status: string
  errorText: string | null
  durationMs: number
  startedAt: string
  finishedAt: string
  toolArgs: Record<string, unknown> | null
  toolResult: Record<string, unknown> | null
}

export interface ConversationDetail {
  sessionId: string
  userId: string
  turns: Array<{
    messageId: number
    model: string | null
    createdAt: string
    latencyMs: number
    inputTokens: number
    outputTokens: number
    messages: ConversationDetailMessage[]
    tools: ConversationDetailTool[]
  }>
}

const DEFAULT_DAYS = 7

/**
 * List sessions, newest activity first. Each row is one session with
 * aggregated counters across all of its turns. Defaults to the last 7
 * days so the table stays fast; admin can scope wider via filters.
 */
export async function listAgentConversations(
  daysBack: number = DEFAULT_DAYS,
  userIdFilter?: string,
): Promise<ActionState<ConversationListItem[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("listAgentConversations")
  const log = createLogger({ requestId, action: "listAgentConversations" })

  try {
    await requireRole("administrator")
    const days = Math.min(Math.max(1, daysBack), 90)
    const cutoff = new Date(Date.now() - days * 86400_000)

    const conditions = userIdFilter
      ? and(
          gte(agentMessages.createdAt, cutoff),
          eq(agentMessages.userId, userIdFilter.toLowerCase()),
        )
      : gte(agentMessages.createdAt, cutoff)

    const rows = await executeQuery(
      (db) =>
        db
          .select({
            sessionId: agentMessages.sessionId,
            userId: agentMessages.userId,
            startedAt: sql<string>`MIN(${agentMessages.createdAt})::text`,
            lastTurnAt: sql<string>`MAX(${agentMessages.createdAt})::text`,
            turnCount: sql<number>`COUNT(*)::int`,
            totalInputTokens: sql<number>`COALESCE(SUM(${agentMessages.inputTokens}), 0)::int`,
            totalOutputTokens: sql<number>`COALESCE(SUM(${agentMessages.outputTokens}), 0)::int`,
            models: sql<string[]>`array_remove(array_agg(DISTINCT ${agentMessages.model}), NULL)`,
            hasError: sql<boolean>`bool_or(${agentMessages.guardrailBlocked})`,
          })
          .from(agentMessages)
          .where(conditions)
          .groupBy(agentMessages.sessionId, agentMessages.userId)
          .orderBy(desc(sql`MAX(${agentMessages.createdAt})`))
          .limit(200),
      "agentConversations.list",
    )

    // Tool-call counts in one extra query, then merge.
    const sessionIds = rows.map((r) => r.sessionId)
    let toolCounts: Record<string, number> = {}
    if (sessionIds.length > 0) {
      const toolRows = await executeQuery(
        (db) =>
          db
            .select({
              sessionId: agentToolInvocations.sessionId,
              count: sql<number>`COUNT(*)::int`,
            })
            .from(agentToolInvocations)
            .where(gte(agentToolInvocations.startedAt, cutoff))
            .groupBy(agentToolInvocations.sessionId),
        "agentConversations.toolCounts",
      )
      toolCounts = Object.fromEntries(toolRows.map((r) => [r.sessionId, r.count]))
    }

    const items: ConversationListItem[] = rows.map((r) => ({
      sessionId: r.sessionId,
      userId: r.userId,
      startedAt: r.startedAt,
      lastTurnAt: r.lastTurnAt,
      turnCount: r.turnCount,
      toolCallCount: toolCounts[r.sessionId] ?? 0,
      totalInputTokens: r.totalInputTokens,
      totalOutputTokens: r.totalOutputTokens,
      models: r.models ?? [],
      hasError: r.hasError ?? false,
    }))

    timer({ status: "success" })
    log.info("Listed conversations", { count: items.length, days })
    return createSuccess(items)
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to list agent conversations", {
      context: "listAgentConversations",
      requestId,
      operation: "listAgentConversations",
    })
  }
}

/**
 * Full transcript + tool timeline for one session. Joins
 * agent_messages → agent_message_content → agent_tool_invocations and
 * groups by turn (message_id). Ordered chronologically within each turn.
 */
export async function getAgentConversationDetail(
  sessionId: string,
): Promise<ActionState<ConversationDetail | null>> {
  const requestId = generateRequestId()
  const timer = startTimer("getAgentConversationDetail")
  const log = createLogger({ requestId, action: "getAgentConversationDetail" })

  try {
    await requireRole("administrator")
    if (!sessionId.trim()) {
      return createSuccess(null, "No session id provided")
    }

    const turnRows = await executeQuery(
      (db) =>
        db
          .select()
          .from(agentMessages)
          .where(eq(agentMessages.sessionId, sessionId))
          .orderBy(agentMessages.createdAt),
      "agentConversations.detail.turns",
    )
    if (turnRows.length === 0) {
      return createSuccess(null, "Session not found")
    }

    const contentRows = await executeQuery(
      (db) =>
        db
          .select()
          .from(agentMessageContent)
          .where(eq(agentMessageContent.sessionId, sessionId))
          .orderBy(agentMessageContent.createdAt),
      "agentConversations.detail.content",
    )
    const toolRows = await executeQuery(
      (db) =>
        db
          .select()
          .from(agentToolInvocations)
          .where(eq(agentToolInvocations.sessionId, sessionId))
          .orderBy(agentToolInvocations.startedAt),
      "agentConversations.detail.tools",
    )

    // Group by messageId so the UI can render per-turn nicely.
    const byMessage = new Map<number, { messages: ConversationDetailMessage[]; tools: ConversationDetailTool[] }>()
    for (const t of turnRows) byMessage.set(t.id, { messages: [], tools: [] })
    for (const c of contentRows) {
      const bucket = byMessage.get(c.messageId) ?? { messages: [], tools: [] }
      bucket.messages.push({
        role: c.role,
        contentText: c.contentText,
        contentTruncated: c.contentTruncated,
        createdAt: c.createdAt.toISOString(),
      })
      byMessage.set(c.messageId, bucket)
    }
    for (const t of toolRows) {
      const bucket = byMessage.get(t.messageId) ?? { messages: [], tools: [] }
      bucket.tools.push({
        toolName: t.toolName,
        status: t.status,
        errorText: t.errorText,
        durationMs: t.durationMs,
        startedAt: t.startedAt.toISOString(),
        finishedAt: t.finishedAt.toISOString(),
        toolArgs: t.toolArgs ?? null,
        toolResult: t.toolResult ?? null,
      })
      byMessage.set(t.messageId, bucket)
    }

    const detail: ConversationDetail = {
      sessionId,
      userId: turnRows[0].userId,
      turns: turnRows.map((t) => {
        const bucket = byMessage.get(t.id) ?? { messages: [], tools: [] }
        return {
          messageId: t.id,
          model: t.model,
          createdAt: t.createdAt.toISOString(),
          latencyMs: t.latencyMs,
          inputTokens: t.inputTokens,
          outputTokens: t.outputTokens,
          messages: bucket.messages,
          tools: bucket.tools,
        }
      }),
    }

    timer({ status: "success" })
    log.info("Fetched conversation detail", {
      sessionId,
      turns: detail.turns.length,
    })
    return createSuccess(detail)
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to fetch conversation detail", {
      context: "getAgentConversationDetail",
      requestId,
      operation: "getAgentConversationDetail",
    })
  }
}
