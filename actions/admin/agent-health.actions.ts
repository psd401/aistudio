"use server"

import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import { handleError, createSuccess } from "@/lib/error-utils"
import type { ActionState } from "@/types"
import { requireRole } from "@/lib/auth/role-helpers"
import { executeQuery } from "@/lib/db/drizzle-client"
import { stripJsonQuotes, pgTimestampAsText } from "@/lib/db/drizzle-helpers"
import { sql, desc, eq } from "drizzle-orm"
import { agentHealthSnapshots } from "@/lib/db/schema/tables/agent-health-snapshots"
import { agentPatterns } from "@/lib/db/schema/tables/agent-patterns"

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

export interface AgentHealthSummary {
  totalUsers: number
  abandonedCount: number
  totalWorkspaceBytes: number
  totalSkills: number
  totalMemoryFiles: number
  snapshotDate: string | null
  rows: AgentHealthRow[]
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

    // Use the latest snapshot_date that exists. If the Lambda hasn't run yet
    // the table is empty and the response is zeros.
    const latest = await executeQuery(
      (db) =>
        db
          .select({
            date: sql<string>`MAX(${agentHealthSnapshots.snapshotDate})::text`,
          })
          .from(agentHealthSnapshots),
      "agentHealth.latest"
    )
    const snapshotDate = latest[0]?.date ?? null

    if (!snapshotDate) {
      return createSuccess<AgentHealthSummary>({
        totalUsers: 0,
        abandonedCount: 0,
        totalWorkspaceBytes: 0,
        totalSkills: 0,
        totalMemoryFiles: 0,
        snapshotDate: null,
        rows: [],
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

/**
 * Load detected patterns from the Pattern Scanner Lambda.
 * Filtered to the most recent N weeks. Privacy guarantee: rows contain
 * no user identity or message content.
 */
export async function getAgentPatterns(
  weeks = 8
): Promise<ActionState<AgentPatternRow[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("getAgentPatterns")
  const log = createLogger({ requestId, action: "getAgentPatterns" })

  try {
    await requireRole("administrator")

    // Clamp weeks to prevent unbounded result sets (CWE-400)
    const safeWeeks = Math.min(Math.max(1, weeks), 52)

    const rows = await executeQuery(
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
      "agentPatterns.list"
    )

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

    timer({ status: "success" })
    log.info("Agent patterns loaded", { count: data.length })
    return createSuccess(data)
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to load agent patterns", {
      context: "getAgentPatterns",
      requestId,
      operation: "getAgentPatterns",
    })
  }
}

