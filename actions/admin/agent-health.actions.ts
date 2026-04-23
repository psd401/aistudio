"use server"

import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import { handleError, createSuccess } from "@/lib/error-utils"
import type { ActionState } from "@/types"
import { requireRole } from "@/lib/auth/role-helpers"
import { executeQuery } from "@/lib/db/drizzle-client"
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

    const rows = await executeQuery(
      (db) =>
        db
          .select({
            userEmail: agentHealthSnapshots.userEmail,
            workspaceBytes: agentHealthSnapshots.workspaceBytes,
            objectCount: agentHealthSnapshots.objectCount,
            skillCount: agentHealthSnapshots.skillCount,
            memoryFileCount: agentHealthSnapshots.memoryFileCount,
            lastActivityAt: sql<string>`${agentHealthSnapshots.lastActivityAt}::text`,
            daysInactive: agentHealthSnapshots.daysInactive,
            abandoned: agentHealthSnapshots.abandoned,
            snapshotDate: sql<string>`${agentHealthSnapshots.snapshotDate}::text`,
          })
          .from(agentHealthSnapshots)
          .where(eq(agentHealthSnapshots.snapshotDate, sql`${snapshotDate}::date`))
          .orderBy(desc(agentHealthSnapshots.workspaceBytes))
          .limit(limit),
      "agentHealth.rows"
    )

    const data: AgentHealthRow[] = rows.map((r) => ({
      userEmail: String(r.userEmail),
      workspaceBytes: Number(r.workspaceBytes),
      objectCount: Number(r.objectCount),
      skillCount: Number(r.skillCount),
      memoryFileCount: Number(r.memoryFileCount),
      lastActivityAt: r.lastActivityAt ?? null,
      daysInactive: r.daysInactive !== null ? Number(r.daysInactive) : null,
      abandoned: Boolean(r.abandoned),
      snapshotDate: String(r.snapshotDate),
    }))

    const summary: AgentHealthSummary = {
      totalUsers: data.length,
      abandonedCount: data.filter((r) => r.abandoned).length,
      totalWorkspaceBytes: data.reduce((s, r) => s + r.workspaceBytes, 0),
      totalSkills: data.reduce((s, r) => s + r.skillCount, 0),
      totalMemoryFiles: data.reduce((s, r) => s + r.memoryFileCount, 0),
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
            detectedAt: sql<string>`${agentPatterns.detectedAt}::text`,
          })
          .from(agentPatterns)
          .orderBy(desc(agentPatterns.week), desc(agentPatterns.signalCount))
          .limit(weeks * 20),
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
      detectedAt: String(r.detectedAt),
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

