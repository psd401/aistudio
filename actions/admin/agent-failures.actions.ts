"use server"

import {
  createLogger,
  generateRequestId,
  startTimer,
} from "@/lib/logger"
import { handleError, createSuccess, ErrorFactories } from "@/lib/error-utils"
import type { ActionState } from "@/types"
import { requireRole } from "@/lib/auth/role-helpers"
import { executeQuery } from "@/lib/db/drizzle-client"
import { stripJsonQuotes, pgTimestampAsText } from "@/lib/db/drizzle-helpers"
import { sql, desc, eq, and, gte, inArray, type SQL } from "drizzle-orm"
import {
  agentFailures,
  type AgentFailureSource,
  type AgentFailureSeverity,
} from "@/lib/db/schema/tables/agent-failures"
import { agentMessages } from "@/lib/db/schema/tables/agent-messages"
import { getDateThreshold } from "@/lib/date-utils"
import { getServerSession } from "@/lib/auth/server-session"
import { revalidatePath } from "next/cache"

export type FailureRange = "7d" | "30d" | "90d" | "all"

const VALID_SOURCES: AgentFailureSource[] = [
  "router",
  "harness",
  "cron",
  "agent_self_report",
  "tool",
]

const VALID_SEVERITIES: AgentFailureSeverity[] = [
  "error",
  "warn",
  "empty_response",
]

const VALID_RANGES: FailureRange[] = ["7d", "30d", "90d", "all"]

export interface FailureRow {
  id: number
  occurredAt: string
  source: AgentFailureSource
  severity: AgentFailureSeverity
  userId: string | null
  sessionId: string | null
  scheduleName: string | null
  model: string | null
  errorClass: string | null
  errorMessage: string | null
  stackExcerpt: string | null
  context: Record<string, unknown> | null
  acknowledged: boolean
  acknowledgedBy: string | null
  acknowledgedAt: string | null
  notes: string | null
}

export interface FailureListFilters {
  range?: FailureRange
  source?: AgentFailureSource
  severity?: AgentFailureSeverity
  userId?: string
  acknowledged?: boolean
  limit?: number
}

export interface FailureListResult {
  failures: FailureRow[]
  total: number
}

function sanitizeRange(range: FailureRange | undefined): FailureRange {
  if (range && VALID_RANGES.includes(range)) return range
  return "30d"
}

function clampLimit(limit: number | undefined, max = 500): number {
  const value = typeof limit === "number" && Number.isFinite(limit) ? limit : 100
  return Math.min(Math.max(1, value), max)
}

function thresholdFor(range: FailureRange): Date | null {
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  )
}

function rowToFailure(r: {
  id: number | string | bigint
  occurredAt: string | null
  source: string
  severity: string
  userId: string | null
  sessionId: string | null
  scheduleName: string | null
  model: string | null
  errorClass: string | null
  errorMessage: string | null
  stackExcerpt: string | null
  context: unknown
  acknowledged: boolean
  acknowledgedBy: string | null
  acknowledgedAt: string | null
  notes: string | null
}): FailureRow {
  return {
    id: Number(r.id),
    occurredAt: stripJsonQuotes(r.occurredAt) ?? "",
    source: r.source as AgentFailureSource,
    severity: r.severity as AgentFailureSeverity,
    userId: r.userId,
    sessionId: r.sessionId,
    scheduleName: r.scheduleName,
    model: r.model,
    errorClass: r.errorClass,
    errorMessage: r.errorMessage,
    stackExcerpt: r.stackExcerpt,
    context: isPlainObject(r.context) ? r.context : null,
    acknowledged: Boolean(r.acknowledged),
    acknowledgedBy: r.acknowledgedBy,
    acknowledgedAt: r.acknowledgedAt
      ? stripJsonQuotes(r.acknowledgedAt) ?? null
      : null,
    notes: r.notes,
  }
}

/**
 * List agent failures with filters.
 */
export async function getAgentFailures(
  filters: FailureListFilters = {},
): Promise<ActionState<FailureListResult>> {
  const requestId = generateRequestId()
  const timer = startTimer("getAgentFailures")
  const log = createLogger({ requestId, action: "getAgentFailures" })

  try {
    await requireRole("administrator")

    const range = sanitizeRange(filters.range)
    const threshold = thresholdFor(range)
    const limit = clampLimit(filters.limit, 500)

    const conditions: SQL[] = []
    if (threshold) conditions.push(gte(agentFailures.occurredAt, threshold))
    if (filters.source && VALID_SOURCES.includes(filters.source)) {
      conditions.push(eq(agentFailures.source, filters.source))
    }
    if (filters.severity && VALID_SEVERITIES.includes(filters.severity)) {
      conditions.push(eq(agentFailures.severity, filters.severity))
    }
    if (filters.userId) {
      conditions.push(eq(agentFailures.userId, filters.userId))
    }
    if (typeof filters.acknowledged === "boolean") {
      conditions.push(eq(agentFailures.acknowledged, filters.acknowledged))
    }
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined

    const rows = await executeQuery(
      (db) =>
        db
          .select({
            id: agentFailures.id,
            occurredAt: pgTimestampAsText(agentFailures.occurredAt),
            source: agentFailures.source,
            severity: agentFailures.severity,
            userId: agentFailures.userId,
            sessionId: agentFailures.sessionId,
            scheduleName: agentFailures.scheduleName,
            model: agentFailures.model,
            errorClass: agentFailures.errorClass,
            errorMessage: agentFailures.errorMessage,
            stackExcerpt: agentFailures.stackExcerpt,
            context: agentFailures.context,
            acknowledged: agentFailures.acknowledged,
            acknowledgedBy: agentFailures.acknowledgedBy,
            acknowledgedAt: pgTimestampAsText(agentFailures.acknowledgedAt),
            notes: agentFailures.notes,
            totalCount: sql<number>`COUNT(*) OVER()`.as("total_count"),
          })
          .from(agentFailures)
          .where(whereClause)
          .orderBy(desc(agentFailures.occurredAt))
          .limit(limit),
      "agentFailures.list",
    )

    const total = rows.length > 0 ? Number(rows[0].totalCount) : 0
    const failures = rows.map((r) => rowToFailure(r))

    timer({ status: "success" })
    log.info("Agent failures loaded", {
      range,
      total,
      returned: failures.length,
    })
    return createSuccess({ failures, total })
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to load agent failures", {
      context: "getAgentFailures",
      requestId,
      operation: "getAgentFailures",
    })
  }
}

export interface AcknowledgeInput {
  ids: number[]
  notes?: string
}

/**
 * Acknowledge one or more failures so they drop off the unack queue.
 */
export async function acknowledgeFailures(
  input: AcknowledgeInput,
): Promise<ActionState<{ updated: number }>> {
  const requestId = generateRequestId()
  const timer = startTimer("acknowledgeFailures")
  const log = createLogger({ requestId, action: "acknowledgeFailures" })

  try {
    await requireRole("administrator")
    const session = await getServerSession()
    if (!session) throw ErrorFactories.authNoSession()

    const ids = Array.isArray(input.ids)
      ? input.ids
          .map((n) => Number(n))
          .filter((n) => Number.isInteger(n) && n > 0)
          .slice(0, 500)
      : []
    if (ids.length === 0) throw ErrorFactories.validationFailed([
      { field: "ids", message: "ids must be a non-empty list of positive integers" },
    ])
    const notes =
      typeof input.notes === "string" && input.notes.trim().length > 0
        ? input.notes.slice(0, 4000)
        : null

    const ackBy = session.email ?? session.sub ?? "unknown"

    const updated = await executeQuery(
      (db) =>
        db
          .update(agentFailures)
          .set({
            acknowledged: true,
            acknowledgedBy: ackBy,
            acknowledgedAt: new Date(),
            notes: notes ?? null,
          })
          .where(inArray(agentFailures.id, ids))
          .returning({ id: agentFailures.id }),
      "agentFailures.acknowledge",
    )

    revalidatePath("/admin/agents")

    timer({ status: "success" })
    log.info("Failures acknowledged", { count: updated.length })
    return createSuccess({ updated: updated.length }, "Failures acknowledged")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to acknowledge failures", {
      context: "acknowledgeFailures",
      requestId,
      operation: "acknowledgeFailures",
    })
  }
}

/**
 * Build a self-contained markdown bundle for selected failures, intended to be
 * pasted into Claude Code for root-cause analysis.
 */
export async function generateTroubleshootingBundle(
  ids: number[],
): Promise<ActionState<{ markdown: string; count: number }>> {
  const requestId = generateRequestId()
  const timer = startTimer("generateTroubleshootingBundle")
  const log = createLogger({
    requestId,
    action: "generateTroubleshootingBundle",
  })

  try {
    await requireRole("administrator")

    const safeIds = Array.isArray(ids)
      ? ids
          .map((n) => Number(n))
          .filter((n) => Number.isInteger(n) && n > 0)
          .slice(0, 100)
      : []
    if (safeIds.length === 0) throw ErrorFactories.validationFailed([
      { field: "ids", message: "Select at least one failure" },
    ])

    const rows = await executeQuery(
      (db) =>
        db
          .select({
            id: agentFailures.id,
            occurredAt: pgTimestampAsText(agentFailures.occurredAt),
            source: agentFailures.source,
            severity: agentFailures.severity,
            userId: agentFailures.userId,
            sessionId: agentFailures.sessionId,
            scheduleName: agentFailures.scheduleName,
            model: agentFailures.model,
            errorClass: agentFailures.errorClass,
            errorMessage: agentFailures.errorMessage,
            stackExcerpt: agentFailures.stackExcerpt,
            context: agentFailures.context,
            acknowledged: agentFailures.acknowledged,
            acknowledgedBy: agentFailures.acknowledgedBy,
            acknowledgedAt: pgTimestampAsText(agentFailures.acknowledgedAt),
            notes: agentFailures.notes,
          })
          .from(agentFailures)
          .where(inArray(agentFailures.id, safeIds))
          .orderBy(desc(agentFailures.occurredAt)),
      "agentFailures.bundle",
    )

    const failures = rows.map((r) => rowToFailure(r))
    const sessionMessages = await fetchSessionMessagesForFailures(failures)

    const markdown = renderBundle(failures, sessionMessages)

    timer({ status: "success" })
    log.info("Troubleshooting bundle generated", { count: failures.length })
    return createSuccess(
      { markdown, count: failures.length },
      "Bundle ready",
    )
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to generate troubleshooting bundle", {
      context: "generateTroubleshootingBundle",
      requestId,
      operation: "generateTroubleshootingBundle",
    })
  }
}

async function fetchSessionMessagesForFailures(
  failures: FailureRow[],
): Promise<Map<string, SessionMessageRow[]>> {
  const sessionIds = [
    ...new Set(
      failures
        .map((f) => f.sessionId)
        .filter((s): s is string => typeof s === "string" && s.length > 0),
    ),
  ].slice(0, 25)
  const result = new Map<string, SessionMessageRow[]>()
  if (sessionIds.length === 0) return result

  const messageRows = await executeQuery(
    (db) =>
      db
        .select({
          id: agentMessages.id,
          sessionId: agentMessages.sessionId,
          userId: agentMessages.userId,
          model: agentMessages.model,
          inputTokens: agentMessages.inputTokens,
          outputTokens: agentMessages.outputTokens,
          latencyMs: agentMessages.latencyMs,
          guardrailBlocked: agentMessages.guardrailBlocked,
          topic: agentMessages.topic,
          createdAt: pgTimestampAsText(agentMessages.createdAt),
        })
        .from(agentMessages)
        .where(inArray(agentMessages.sessionId, sessionIds))
        .orderBy(desc(agentMessages.createdAt))
        .limit(500),
    "agentFailures.bundleMessages",
  )

  for (const row of messageRows) {
    const sid = row.sessionId
    if (!sid) continue
    if (!result.has(sid)) result.set(sid, [])
    const list = result.get(sid)
    if (list && list.length < 10) {
      list.push({
        id: Number(row.id),
        createdAt: stripJsonQuotes(row.createdAt) ?? "",
        model: row.model ?? null,
        inputTokens: row.inputTokens ?? 0,
        outputTokens: row.outputTokens ?? 0,
        latencyMs: row.latencyMs ?? 0,
        guardrailBlocked: Boolean(row.guardrailBlocked),
        topic: row.topic ?? null,
      })
    }
  }
  return result
}

interface SessionMessageRow {
  id: number
  createdAt: string
  model: string | null
  inputTokens: number
  outputTokens: number
  latencyMs: number
  guardrailBlocked: boolean
  topic: string | null
}

function appendCodeBlock(lines: string[], label: string, body: string, fence = "```") {
  lines.push(`- **${label}:**`)
  lines.push(`  ${fence}`)
  for (const ln of body.split("\n").slice(0, 40)) {
    lines.push(`  ${ln}`)
  }
  lines.push(`  ${fence}`)
}

function appendFailureSection(lines: string[], index: number, f: FailureRow) {
  lines.push("")
  lines.push(`### [${index + 1}] ${f.source} · ${f.severity} · ${f.occurredAt}`)
  lines.push(`- **id:** ${f.id}`)
  if (f.userId) lines.push(`- **user:** ${f.userId}`)
  if (f.sessionId) lines.push(`- **session:** \`${f.sessionId}\``)
  if (f.scheduleName) lines.push(`- **schedule:** ${f.scheduleName}`)
  if (f.model) lines.push(`- **model:** ${f.model}`)
  if (f.errorClass) lines.push(`- **error class:** ${f.errorClass}`)
  if (f.errorMessage) appendCodeBlock(lines, "error message", f.errorMessage)
  if (f.context) {
    appendCodeBlock(lines, "context", JSON.stringify(f.context, null, 2), "```json")
  }
  if (f.stackExcerpt) appendCodeBlock(lines, "stack", f.stackExcerpt)
  if (f.notes) lines.push(`- **operator notes:** ${f.notes}`)
}

function renderBundle(
  failures: FailureRow[],
  sessionMessages: Map<string, SessionMessageRow[]> = new Map(),
): string {
  const generatedAt = new Date().toISOString()
  const sources = [...new Set(failures.map((f) => f.source))]
  const earliest = failures
    .map((f) => f.occurredAt)
    .filter(Boolean)
    .sort()[0]
  const latest = failures
    .map((f) => f.occurredAt)
    .filter(Boolean)
    .sort()
    .at(-1)

  const lines: string[] = []
  lines.push(`# Agent Failure Bundle (generated ${generatedAt})`)
  lines.push("")
  lines.push("## Summary")
  lines.push(`- Count: ${failures.length} failure(s)`)
  lines.push(`- Sources: ${sources.join(", ") || "(none)"}`)
  lines.push(
    `- Time range: ${earliest ?? "n/a"} → ${latest ?? "n/a"}`,
  )
  lines.push("")
  lines.push("## Failures")
  for (const [i, f] of failures.entries()) {
    appendFailureSection(lines, i, f)
    if (f.sessionId) {
      const msgs = sessionMessages.get(f.sessionId)
      if (msgs && msgs.length > 0) {
        lines.push(`- **session conversation (telemetry only — no message content stored):**`)
        lines.push("  ```")
        for (const m of msgs) {
          lines.push(
            `  ${m.createdAt} model=${m.model ?? "-"} in=${m.inputTokens} ` +
              `out=${m.outputTokens} latency=${m.latencyMs}ms ` +
              `topic=${m.topic ?? "-"}${m.guardrailBlocked ? " GUARDRAIL" : ""}`,
          )
        }
        lines.push("  ```")
      }
    }
  }
  lines.push("")
  lines.push("## Investigation prompt")
  lines.push(
    "Investigate these agent failures. For each: identify likely root cause,",
  )
  lines.push(
    "list the file(s) that need changes, and propose a minimal fix. Group",
  )
  lines.push(
    "common causes together. Flag any failures that look like infrastructure",
  )
  lines.push("issues (deploy/config/credentials) versus code bugs.")
  return lines.join("\n")
}
