"use server"

import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  type Granularity,
} from "@aws-sdk/client-cost-explorer"
import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import { handleError, createSuccess } from "@/lib/error-utils"
import type { ActionState } from "@/types"
import { requireRole } from "@/lib/auth/role-helpers"

// Cost Explorer lives in us-east-1 regardless of stack region.
const ceClient = new CostExplorerClient({ region: "us-east-1" })

export type CostDateRange = "7d" | "30d" | "90d"

export interface AgentCostSummary {
  /** Total Bedrock spend attributable to the agent platform over the window */
  totalUsd: number
  /** Per-day spend for charting */
  daily: Array<{ date: string; usd: number }>
  /** Breakdown by model (usage type dimension) */
  byModel: Array<{ model: string; usd: number }>
  /** Linear projection: avg daily spend × 30 */
  projectedMonthlyUsd: number
  /** Source window */
  windowDays: number
}

interface CostQueryParams {
  start: string
  end: string
  granularity: Granularity
  groupBy?: Array<{ Type: "DIMENSION" | "TAG"; Key: string }>
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function rangeToDays(range: CostDateRange): number {
  return range === "7d" ? 7 : range === "30d" ? 30 : 90
}

async function queryCost(params: CostQueryParams) {
  // costCenter=ai-agents is applied to AgentCore execution role in
  // infra/lib/agent-platform-stack.ts (line 731). Cost Explorer surfaces
  // the tag via its TAG filter dimension.
  return ceClient.send(
    new GetCostAndUsageCommand({
      TimePeriod: { Start: params.start, End: params.end },
      Granularity: params.granularity,
      Metrics: ["UnblendedCost"],
      Filter: {
        Tags: {
          Key: "costCenter",
          Values: ["ai-agents"],
        },
      },
      ...(params.groupBy ? { GroupBy: params.groupBy } : {}),
    })
  )
}

/**
 * Get agent platform cost summary from AWS Cost Explorer.
 *
 * Uses the `costCenter=ai-agents` tag applied to the AgentCore execution
 * role. Bedrock IAM cost allocation (issue #887) propagates this tag to
 * every Bedrock invocation under that role, so the Cost Explorer filter
 * catches per-user spend without per-user IAM roles.
 */
export async function getAgentCostSummary(
  range: CostDateRange = "30d"
): Promise<ActionState<AgentCostSummary>> {
  const requestId = generateRequestId()
  const timer = startTimer("getAgentCostSummary")
  const log = createLogger({ requestId, action: "getAgentCostSummary" })

  try {
    await requireRole("administrator")

    const days = rangeToDays(range)
    const end = new Date()
    const start = new Date(end.getTime() - days * 86400000)

    const [daily, byModel] = await Promise.all([
      queryCost({
        start: isoDate(start),
        end: isoDate(end),
        granularity: "DAILY",
      }),
      queryCost({
        start: isoDate(start),
        end: isoDate(end),
        granularity: "MONTHLY",
        groupBy: [{ Type: "DIMENSION", Key: "USAGE_TYPE" }],
      }),
    ])

    const dailyPoints = (daily.ResultsByTime ?? []).map((p) => ({
      date: String(p.TimePeriod?.Start ?? ""),
      usd: Number(p.Total?.UnblendedCost?.Amount ?? 0),
    }))

    const totalUsd = dailyPoints.reduce((sum, p) => sum + p.usd, 0)

    const modelMap = new Map<string, number>()
    for (const bucket of byModel.ResultsByTime ?? []) {
      for (const group of bucket.Groups ?? []) {
        const key = group.Keys?.[0] ?? "unknown"
        const amount = Number(group.Metrics?.UnblendedCost?.Amount ?? 0)
        modelMap.set(key, (modelMap.get(key) ?? 0) + amount)
      }
    }
    const byModelList = Array.from(modelMap.entries())
      .map(([model, usd]) => ({ model, usd }))
      .sort((a, b) => b.usd - a.usd)

    const avgDaily = dailyPoints.length > 0 ? totalUsd / dailyPoints.length : 0

    const summary: AgentCostSummary = {
      totalUsd,
      daily: dailyPoints,
      byModel: byModelList,
      projectedMonthlyUsd: avgDaily * 30,
      windowDays: days,
    }

    timer({ status: "success" })
    log.info("Agent cost summary loaded", { range, totalUsd, days })
    return createSuccess(summary)
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to load agent cost summary", {
      context: "getAgentCostSummary",
      requestId,
      operation: "getAgentCostSummary",
    })
  }
}
