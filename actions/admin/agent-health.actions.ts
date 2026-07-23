"use server"

import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import { handleError, createSuccess } from "@/lib/error-utils"
import type { ActionState } from "@/types"
import { requireRole } from "@/lib/auth/role-helpers"
import { executeQuery } from "@/lib/db/drizzle-client"
import { stripJsonQuotes, pgTimestampAsText } from "@/lib/db/drizzle-helpers"
import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm"
import { agentHealthSnapshots } from "@/lib/db/schema/tables/agent-health-snapshots"
import { agentPatterns } from "@/lib/db/schema/tables/agent-patterns"
import { agentHealthScanRuns } from "@/lib/db/schema/tables/agent-health-scan-runs"
import { agentMessages } from "@/lib/db/schema/tables/agent-messages"
import { agentPatternScanRuns } from "@/lib/db/schema/tables/agent-pattern-scan-runs"

export interface AgentHealthRow {
  userEmail: string
  workspaceBytes: number
  objectCount: number
  skillCount: number
  memoryFileCount: number
  lastActivityAt: string | null
  daysInactive: number | null
  abandoned: boolean
  snapshotDate: string
}

export interface AgentHealthScanRun {
  runAt: string
  snapshotDate: string
  usersTotal: number
  abandoned: number
  error: string | null
}

export interface AgentHealthSummary {
  totalUsers: number
  abandonedCount: number
  totalWorkspaceBytes: number
  totalSkills: number
  totalMemoryFiles: number
  snapshotDate: string | null
  rows: AgentHealthRow[]
  lastScan: AgentHealthScanRun | null
}

async function loadLatestSnapshotDate(): Promise<string | null> {
  const rows = await executeQuery(
    (db) =>
      db
        .select({
          date: sql<string>`MAX(${agentHealthSnapshots.snapshotDate})::text`,
        })
        .from(agentHealthSnapshots),
    "agentHealth.latest",
  )
  return rows[0]?.date ?? null
}

async function loadLastHealthScan(): Promise<AgentHealthScanRun | null> {
  const rows = await executeQuery(
    (db) =>
      db
        .select({
          runAt: pgTimestampAsText(agentHealthScanRuns.runAt),
          snapshotDate: sql<string>`${agentHealthScanRuns.snapshotDate}::text`,
          usersTotal: agentHealthScanRuns.usersTotal,
          abandoned: agentHealthScanRuns.abandoned,
          error: agentHealthScanRuns.error,
        })
        .from(agentHealthScanRuns)
        .orderBy(desc(agentHealthScanRuns.runAt))
        .limit(1),
    "agentHealth.lastScan",
  )
  if (!rows[0]) return null
  return {
    runAt: stripJsonQuotes(rows[0].runAt) ?? "",
    snapshotDate: String(rows[0].snapshotDate),
    usersTotal: Number(rows[0].usersTotal),
    abandoned: Number(rows[0].abandoned),
    error: rows[0].error,
  }
}

/**
 * Load the most recent agent_health_snapshots — per-user workspace health.
 */
export async function getAgentHealthSummary(
  limit = 200
): Promise<ActionState<AgentHealthSummary>> {
  const requestId = generateRequestId()
  const timer = startTimer("getAgentHealthSummary")
  const log = createLogger({ requestId, action: "getAgentHealthSummary" })

  try {
    await requireRole("administrator")

    // Clamp limit to prevent unbounded result sets (CWE-400).
    // Cap at 500: the UI renders a paginated table, 500 rows is the practical
    // maximum before client-side rendering degrades; the Lambda scans ~200
    // users today and this cap leaves headroom for 2.5x growth.
    const safeLim = Math.min(Math.max(1, limit), 500)

    const [latest, lastScan] = await Promise.all([
      loadLatestSnapshotDate(),
      loadLastHealthScan(),
    ])
    const snapshotDate = latest

    if (!snapshotDate) {
      return createSuccess<AgentHealthSummary>({
        totalUsers: 0,
        abandonedCount: 0,
        totalWorkspaceBytes: 0,
        totalSkills: 0,
        totalMemoryFiles: 0,
        snapshotDate: null,
        rows: [],
        lastScan,
      })
    }

    // Fetch aggregate stats separately so they are not capped by the
    // per-page limit. The totalUsers stat is used on the dashboard card
    // and would silently under-count when there are more users than the
    // result set size.
    const [rows, aggregates] = await Promise.all([
      executeQuery(
        (db) =>
          db
            .select({
              userEmail: agentHealthSnapshots.userEmail,
              workspaceBytes: agentHealthSnapshots.workspaceBytes,
              objectCount: agentHealthSnapshots.objectCount,
              skillCount: agentHealthSnapshots.skillCount,
              memoryFileCount: agentHealthSnapshots.memoryFileCount,
              lastActivityAt: pgTimestampAsText(agentHealthSnapshots.lastActivityAt),
              daysInactive: agentHealthSnapshots.daysInactive,
              abandoned: agentHealthSnapshots.abandoned,
              snapshotDate: sql<string>`${agentHealthSnapshots.snapshotDate}::text`,
            })
            .from(agentHealthSnapshots)
            .where(eq(agentHealthSnapshots.snapshotDate, sql`${snapshotDate}::date`))
            .orderBy(desc(agentHealthSnapshots.workspaceBytes))
            .limit(safeLim),
        "agentHealth.rows"
      ),
      executeQuery(
        (db) =>
          db
            .select({
              totalUsers: sql<number>`COUNT(*)`,
              abandonedCount: sql<number>`COUNT(*) FILTER (WHERE ${agentHealthSnapshots.abandoned} = true)`,
              totalWorkspaceBytes: sql<number>`COALESCE(SUM(${agentHealthSnapshots.workspaceBytes}), 0)`,
              totalSkills: sql<number>`COALESCE(SUM(${agentHealthSnapshots.skillCount}), 0)`,
              totalMemoryFiles: sql<number>`COALESCE(SUM(${agentHealthSnapshots.memoryFileCount}), 0)`,
            })
            .from(agentHealthSnapshots)
            .where(eq(agentHealthSnapshots.snapshotDate, sql`${snapshotDate}::date`)),
        "agentHealth.aggregates"
      ),
    ])

    const data: AgentHealthRow[] = rows.map((r) => ({
      userEmail: String(r.userEmail),
      workspaceBytes: Number(r.workspaceBytes),
      objectCount: Number(r.objectCount),
      skillCount: Number(r.skillCount),
      memoryFileCount: Number(r.memoryFileCount),
      lastActivityAt: stripJsonQuotes(r.lastActivityAt),
      daysInactive: r.daysInactive !== null ? Number(r.daysInactive) : null,
      abandoned: Boolean(r.abandoned),
      snapshotDate: String(r.snapshotDate),
    }))

    const agg = aggregates[0]
    const summary: AgentHealthSummary = {
      totalUsers: Number(agg?.totalUsers ?? 0),
      abandonedCount: Number(agg?.abandonedCount ?? 0),
      totalWorkspaceBytes: Number(agg?.totalWorkspaceBytes ?? 0),
      totalSkills: Number(agg?.totalSkills ?? 0),
      totalMemoryFiles: Number(agg?.totalMemoryFiles ?? 0),
      snapshotDate,
      rows: data,
      lastScan,
    }

    timer({ status: "success" })
    log.info("Agent health loaded", {
      snapshotDate,
      users: data.length,
      abandoned: summary.abandonedCount,
    })
    return createSuccess(summary)
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to load agent health summary", {
      context: "getAgentHealthSummary",
      requestId,
      operation: "getAgentHealthSummary",
    })
  }
}

export interface AgentPatternRow {
  week: string
  topic: string
  signalCount: number
  buildingCount: number
  rollingAvg: number
  spikeRatio: number
  isEmerging: boolean
  buildings: string
  detectedAt: string
}

export interface AgentPatternScanRun {
  runAt: string
  week: string
  signalsTotal: number
  topicsTotal: number
  detected: number
  suppressed: number
}

export interface AgentPatternsEnvelope {
  rows: AgentPatternRow[]
  lastScan: AgentPatternScanRun | null
}

/**
 * Load detected patterns from the Pattern Scanner Lambda.
 * Filtered to the most recent N weeks. Privacy guarantee: rows contain
 * no user identity or message content.
 */
export async function getAgentPatterns(
  weeks = 8
): Promise<ActionState<AgentPatternsEnvelope>> {
  const requestId = generateRequestId()
  const timer = startTimer("getAgentPatterns")
  const log = createLogger({ requestId, action: "getAgentPatterns" })

  try {
    await requireRole("administrator")

    // Clamp weeks to prevent unbounded result sets (CWE-400)
    const safeWeeks = Math.min(Math.max(1, weeks), 52)

    const [rows, lastScanRows] = await Promise.all([
      executeQuery(
        (db) =>
          db
            .select({
              week: agentPatterns.week,
              topic: agentPatterns.topic,
              signalCount: agentPatterns.signalCount,
              buildingCount: agentPatterns.buildingCount,
              rollingAvg: agentPatterns.rollingAvg,
              spikeRatio: agentPatterns.spikeRatio,
              isEmerging: agentPatterns.isEmerging,
              buildings: agentPatterns.buildings,
              detectedAt: pgTimestampAsText(agentPatterns.detectedAt),
            })
            .from(agentPatterns)
            .orderBy(desc(agentPatterns.week), desc(agentPatterns.signalCount))
            .limit(safeWeeks * 20),
        "agentPatterns.list",
      ),
      executeQuery(
        (db) =>
          db
            .select({
              runAt: pgTimestampAsText(agentPatternScanRuns.runAt),
              week: agentPatternScanRuns.week,
              signalsTotal: agentPatternScanRuns.signalsTotal,
              topicsTotal: agentPatternScanRuns.topicsTotal,
              detected: agentPatternScanRuns.detected,
              suppressed: agentPatternScanRuns.suppressed,
            })
            .from(agentPatternScanRuns)
            .orderBy(desc(agentPatternScanRuns.runAt))
            .limit(1),
        "agentPatterns.lastScan",
      ),
    ])

    const data: AgentPatternRow[] = rows.map((r) => ({
      week: String(r.week),
      topic: String(r.topic),
      signalCount: Number(r.signalCount),
      buildingCount: Number(r.buildingCount),
      rollingAvg: Number(r.rollingAvg),
      spikeRatio: Number(r.spikeRatio),
      isEmerging: Boolean(r.isEmerging),
      buildings: String(r.buildings),
      detectedAt: stripJsonQuotes(r.detectedAt) ?? "",
    }))

    const lastScan: AgentPatternScanRun | null = lastScanRows[0]
      ? {
          runAt: stripJsonQuotes(lastScanRows[0].runAt) ?? "",
          week: String(lastScanRows[0].week),
          signalsTotal: Number(lastScanRows[0].signalsTotal),
          topicsTotal: Number(lastScanRows[0].topicsTotal),
          detected: Number(lastScanRows[0].detected),
          suppressed: Number(lastScanRows[0].suppressed),
        }
      : null

    timer({ status: "success" })
    log.info("Agent patterns loaded", {
      count: data.length,
      hasLastScan: lastScan !== null,
    })
    return createSuccess({ rows: data, lastScan })
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to load agent patterns", {
      context: "getAgentPatterns",
      requestId,
      operation: "getAgentPatterns",
    })
  }
}

export interface RawSignalRow {
  topic: string
  signalCount: number
  uniqueUsers: number
  lastSeenAt: string
}

export interface RawSignalsEnvelope {
  rows: RawSignalRow[]
  daysBack: number
  totalMessages: number
  classifiedMessages: number
  unclassifiedMessages: number
}

/**
 * Raw signal volume by topic over the last N days, straight from
 * agent_messages.topic. Bypasses the pattern scanner's suppression
 * threshold so admins can see what the topic classifier actually
 * catches in real traffic — useful for tuning the classifier's
 * keyword patterns and for sanity-checking the Patterns panel when
 * it's empty.
 *
 * Returns both per-topic counts AND the unclassified count so admins
 * can see classifier coverage rate. Privacy: per-topic counts cross
 * many users; we don't return per-user counts (would defeat the
 * cross-building privacy guarantee).
 */
export async function getAgentRawSignals(
  daysBack = 7,
): Promise<ActionState<RawSignalsEnvelope>> {
  const requestId = generateRequestId()
  const timer = startTimer("getAgentRawSignals")
  const log = createLogger({ requestId, action: "getAgentRawSignals" })

  try {
    await requireRole("administrator")
    const safeDays = Math.min(Math.max(1, daysBack), 90)
    const cutoff = new Date(Date.now() - safeDays * 86400_000)

    const [perTopic, totals] = await Promise.all([
      executeQuery(
        (db) =>
          db
            .select({
              topic: agentMessages.topic,
              signalCount: sql<number>`COUNT(*)::int`,
              uniqueUsers: sql<number>`COUNT(DISTINCT ${agentMessages.userId})::int`,
              lastSeenAt: sql<string>`MAX(${agentMessages.createdAt})::text`,
            })
            .from(agentMessages)
            .where(
              and(
                gte(agentMessages.createdAt, cutoff),
                isNotNull(agentMessages.topic),
              ),
            )
            .groupBy(agentMessages.topic)
            .orderBy(desc(sql`COUNT(*)`))
            .limit(50),
        "agentMessages.rawSignalsByTopic",
      ),
      executeQuery(
        (db) =>
          db
            .select({
              total: sql<number>`COUNT(*)::int`,
              classified: sql<number>`COUNT(${agentMessages.topic})::int`,
            })
            .from(agentMessages)
            .where(gte(agentMessages.createdAt, cutoff)),
        "agentMessages.signalsCoverage",
      ),
    ])

    const total = totals[0]?.total ?? 0
    const classified = totals[0]?.classified ?? 0

    const rows: RawSignalRow[] = perTopic
      .filter((r) => r.topic !== null)
      .map((r) => ({
        topic: r.topic ?? "(null)",
        signalCount: Number(r.signalCount),
        uniqueUsers: Number(r.uniqueUsers),
        lastSeenAt: r.lastSeenAt,
      }))

    timer({ status: "success" })
    log.info("Raw signals loaded", {
      topicsFound: rows.length,
      daysBack: safeDays,
      total,
      classified,
    })
    return createSuccess({
      rows,
      daysBack: safeDays,
      totalMessages: total,
      classifiedMessages: classified,
      unclassifiedMessages: total - classified,
    })
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to load raw signals", {
      context: "getAgentRawSignals",
      requestId,
      operation: "getAgentRawSignals",
    })
  }
}

