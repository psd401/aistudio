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

const VALID_COST_RANGES: CostDateRange[] = ["7d", "30d", "90d"]

/** Validate range parameter at runtime — server actions receive untyped JSON (CWE-20) */
function sanitizeCostRange(range: CostDateRange): CostDateRange {
  return VALID_COST_RANGES.includes(range) ? range : "30d"
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
 * RECONCILIATION ONLY — this is NOT the model-cost source of truth (issue
 * #1083). It surfaces AgentCore / infrastructure spend tagged
 * `costCenter=ai-agents` on the execution role.
 *
 * It does NOT capture GLM-5 model spend: GLM-5 runs through Bedrock Mantle
 * (`bedrock-mantle.us-east-1.api.aws`) authenticated by a SEPARATE IAM user's
 * bearer token (`AWS_BEARER_TOKEN_BEDROCK`, IAM user `psd-agent-bedrock-<env>`),
 * not the tagged AgentCore execution role — so that model spend never carries
 * the `costCenter` tag and won't appear here. Model cost is computed from
 * tokens × ai_models pricing in agent-cost-projection.actions.ts.
 *
 * Follow-ups to investigate: (a) activate the `costCenter` cost-allocation tag
 * in Billing; (b) determine whether Bedrock Marketplace/Mantle usage is
 * taggable at all. Until then, the token×pricing path is authoritative.
 */
export async function getAgentCostSummary(
  range: CostDateRange = "30d"
): Promise<ActionState<AgentCostSummary>> {
  const requestId = generateRequestId()
  const timer = startTimer("getAgentCostSummary")
  const log = createLogger({ requestId, action: "getAgentCostSummary" })

  try {
    await requireRole("administrator")

    const safeRange = sanitizeCostRange(range)
    const days = rangeToDays(safeRange)
    const end = new Date()
    const start = new Date(end.getTime() - days * 86400000)

    // Only the DAILY series is consumed by the reconciliation panel (daily /
    // totalUsd / windowDays / projected). The prior USAGE_TYPE-grouped query
    // built a `byModel` breakdown that nothing renders anymore (model cost is
    // token×pricing now) — dropped to save an AWS Cost Explorer call per load
    // (claude review round 2).
    const daily = await queryCost({
      start: isoDate(start),
      end: isoDate(end),
      granularity: "DAILY",
    })

    const dailyPoints = (daily.ResultsByTime ?? []).map((p) => ({
      date: String(p.TimePeriod?.Start ?? ""),
      usd: Number.parseFloat(p.Total?.UnblendedCost?.Amount ?? "0") || 0,
    }))

    const totalUsd = dailyPoints.reduce((sum, p) => sum + p.usd, 0)
    const avgDaily = dailyPoints.length > 0 ? totalUsd / dailyPoints.length : 0

    const summary: AgentCostSummary = {
      totalUsd,
      daily: dailyPoints,
      projectedMonthlyUsd: avgDaily * 30,
      windowDays: days,
    }

    timer({ status: "success" })
    log.info("Agent cost summary loaded", { range: safeRange, totalUsd, days })
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
