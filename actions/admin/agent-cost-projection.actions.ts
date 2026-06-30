"use server"

/**
 * Agent platform cost — token×pricing source of truth (issue #1083).
 *
 * The AWS Cost Explorer path (agent-cost.actions.ts) cannot attribute GLM-5 /
 * Bedrock Mantle spend because Mantle runs through a separate IAM user's bearer
 * token, not the tagged AgentCore execution role — so that panel is now a
 * reconciliation-only view. THIS file is the authoritative model-cost answer:
 * it multiplies the real per-model token volume recorded in agent_messages by
 * the pricing rows in ai_models.
 *
 * Two questions the dashboard exists to answer:
 *   1. How much is GLM-5 actually costing?      → getAgentCostByModel
 *   2. What would a different model cost?        → getAgentCostProjection
 *
 * Pricing is computed ON READ (tokens × current ai_models pricing). No cost
 * snapshot column / migration is needed for V1. The trade-off: a price change
 * retroactively re-prices historical volume. A per-message cost-snapshot column
 * would give historical accuracy and is noted as a future follow-up.
 *
 * Missing-pricing is surfaced EXPLICITLY (pricingMissing: true, usd: 0) rather
 * than silently collapsing to $0 — per docs/guides/silent-failure-patterns.md,
 * a model id with no ai_models row must be visible, not invisible.
 */

import {
  createLogger,
  generateRequestId,
  startTimer,
} from "@/lib/logger"
import { handleError, createSuccess } from "@/lib/error-utils"
import type { ActionState } from "@/types"
import { requireRole } from "@/lib/auth/role-helpers"
import { executeQuery } from "@/lib/db/drizzle-client"
import { sql, gte, inArray, eq, and, isNotNull, ne } from "drizzle-orm"
import { agentMessages } from "@/lib/db/schema/tables/agent-messages"
import { aiModels } from "@/lib/db/schema/tables/ai-models"
import { getDateThreshold } from "@/lib/date-utils"
import type { TelemetryDateRange } from "@/actions/admin/agent-telemetry.actions"

// ============================================
// Types
// ============================================

export interface ModelCostItem {
  /** The model id recorded on agent_messages.model (e.g. "zai.glm-5"). */
  model: string
  messageCount: number
  inputTokens: number
  outputTokens: number
  /** Actual cost = inputTokens×inputPrice + outputTokens×outputPrice. */
  usd: number
  /** True when no ai_models pricing row matched this model id (usd is 0). */
  pricingMissing: boolean
}

export interface AgentCostByModel {
  byModel: ModelCostItem[]
  totalUsd: number
  /** Models with usage but no pricing row — admins must add ai_models rows. */
  modelsMissingPricing: string[]
  windowDays: number | null
}

export interface ProjectionItem {
  /** Candidate model id being priced against the actual token volume. */
  model: string
  /** Display name from ai_models, or the id when no row exists. */
  name: string
  /** Projected cost if the agents had run on this model. */
  usd: number
  /** True when the candidate has no pricing row (usd is 0, projection invalid). */
  pricingMissing: boolean
}

export interface AgentCostProjection {
  /** Actual token volume the projection is computed against. */
  actualInputTokens: number
  actualOutputTokens: number
  /** Actual cost on the model(s) actually used, for side-by-side comparison. */
  actualUsd: number
  /** One row per requested candidate model. */
  candidates: ProjectionItem[]
  windowDays: number | null
}

export interface PricableModel {
  modelId: string
  name: string
  provider: string
  inputCostPer1kTokens: number
  outputCostPer1kTokens: number
}

// ============================================
// Helpers
// ============================================

const VALID_RANGES: TelemetryDateRange[] = ["7d", "30d", "90d", "all"]

/** Validate range at runtime — server actions receive untyped JSON (CWE-20). */
function sanitizeRange(range: TelemetryDateRange): TelemetryDateRange {
  return VALID_RANGES.includes(range) ? range : "30d"
}

function rangeThreshold(range: TelemetryDateRange): Date | null {
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

function rangeDays(range: TelemetryDateRange): number | null {
  switch (range) {
    case "7d":
      return 7
    case "30d":
      return 30
    case "90d":
      return 90
    case "all":
      return null
  }
}

/** Bound the candidate list so a malicious caller can't request 10k joins. */
const MAX_CANDIDATES = 12

// ============================================
// Actions
// ============================================

/**
 * Actual cost per model from token×pricing.
 *
 * LEFT JOINs agent_messages → ai_models on model_id so a model with usage but
 * no pricing row appears with usd=0 and pricingMissing=true (instead of being
 * dropped). Cost math is exact per-direction: input×inputPrice +
 * output×outputPrice, prices being per-1k-tokens.
 */
export async function getAgentCostByModel(
  range: TelemetryDateRange = "30d"
): Promise<ActionState<AgentCostByModel>> {
  const requestId = generateRequestId()
  const timer = startTimer("getAgentCostByModel")
  const log = createLogger({ requestId, action: "getAgentCostByModel" })

  try {
    await requireRole("administrator")

    const safeRange = sanitizeRange(range)
    const threshold = rangeThreshold(safeRange)

    const rows = await executeQuery(
      (db) =>
        db
          .select({
            model: sql<string>`COALESCE(${agentMessages.model}, 'unknown')`,
            messageCount: sql<number>`COUNT(${agentMessages.id})`,
            inputTokens: sql<number>`COALESCE(SUM(${agentMessages.inputTokens}), 0)`,
            outputTokens: sql<number>`COALESCE(SUM(${agentMessages.outputTokens}), 0)`,
            // Exact per-direction cost. Prices are per-1k-tokens, so /1000.
            // NULL pricing (no join match) makes the whole product NULL; the
            // COALESCE pins it to 0 and `hasPricing` below flags it.
            usd: sql<string>`COALESCE(
              SUM(${agentMessages.inputTokens}::numeric * ${aiModels.inputCostPer1kTokens} / 1000.0)
              + SUM(${agentMessages.outputTokens}::numeric * ${aiModels.outputCostPer1kTokens} / 1000.0)
            , 0)`,
            // A pricing row matched iff input OR output price is non-null.
            hasPricing: sql<boolean>`bool_or(
              ${aiModels.inputCostPer1kTokens} IS NOT NULL
              OR ${aiModels.outputCostPer1kTokens} IS NOT NULL
            )`,
          })
          .from(agentMessages)
          .leftJoin(aiModels, eq(agentMessages.model, aiModels.modelId))
          .where(
            threshold ? gte(agentMessages.createdAt, threshold) : undefined
          )
          .groupBy(sql`COALESCE(${agentMessages.model}, 'unknown')`)
          .orderBy(sql`SUM(${agentMessages.inputTokens} + ${agentMessages.outputTokens}) DESC`),
      "agentCost.byModel"
    )

    const byModel: ModelCostItem[] = rows.map((r) => {
      const usd = Number(r.usd) || 0
      const pricingMissing = r.hasPricing !== true
      return {
        model: String(r.model),
        messageCount: Number(r.messageCount) || 0,
        inputTokens: Number(r.inputTokens) || 0,
        outputTokens: Number(r.outputTokens) || 0,
        usd,
        pricingMissing,
      }
    })

    const totalUsd = byModel.reduce((sum, m) => sum + m.usd, 0)
    const modelsMissingPricing = byModel
      .filter((m) => m.pricingMissing && m.inputTokens + m.outputTokens > 0)
      .map((m) => m.model)

    const result: AgentCostByModel = {
      byModel,
      totalUsd,
      modelsMissingPricing,
      windowDays: rangeDays(safeRange),
    }

    timer({ status: "success" })
    log.info("Agent cost by model loaded", {
      range: safeRange,
      models: byModel.length,
      totalUsd,
      missingPricing: modelsMissingPricing.length,
    })
    return createSuccess(result)
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to load agent cost by model", {
      context: "getAgentCostByModel",
      requestId,
      operation: "getAgentCostByModel",
    })
  }
}

/**
 * Project cost onto alternative models.
 *
 * Takes the ACTUAL aggregate input/output token volume the agents consumed and
 * multiplies it by each candidate model's pricing → "what it would cost if the
 * agents ran on model X." A candidate with no pricing row is returned with
 * pricingMissing=true so the UI can flag it rather than imply $0.
 */
export async function getAgentCostProjection(
  range: TelemetryDateRange = "30d",
  candidateModelIds: string[] = []
): Promise<ActionState<AgentCostProjection>> {
  const requestId = generateRequestId()
  const timer = startTimer("getAgentCostProjection")
  const log = createLogger({ requestId, action: "getAgentCostProjection" })

  try {
    await requireRole("administrator")

    const safeRange = sanitizeRange(range)
    const threshold = rangeThreshold(safeRange)

    // Sanitize the candidate list: strings only, de-duped, bounded.
    const candidates = Array.from(
      new Set(
        (Array.isArray(candidateModelIds) ? candidateModelIds : [])
          .filter((c): c is string => typeof c === "string" && c.length > 0)
      )
    ).slice(0, MAX_CANDIDATES)

    // Actual token volume + actual cost (priced on the model actually used).
    const [totals] = await executeQuery(
      (db) =>
        db
          .select({
            inputTokens: sql<number>`COALESCE(SUM(${agentMessages.inputTokens}), 0)`,
            outputTokens: sql<number>`COALESCE(SUM(${agentMessages.outputTokens}), 0)`,
            actualUsd: sql<string>`COALESCE(
              SUM(${agentMessages.inputTokens}::numeric * ${aiModels.inputCostPer1kTokens} / 1000.0)
              + SUM(${agentMessages.outputTokens}::numeric * ${aiModels.outputCostPer1kTokens} / 1000.0)
            , 0)`,
          })
          .from(agentMessages)
          .leftJoin(aiModels, eq(agentMessages.model, aiModels.modelId))
          .where(
            threshold ? gte(agentMessages.createdAt, threshold) : undefined
          ),
      "agentCost.projectionTotals"
    )

    const actualInputTokens = Number(totals?.inputTokens) || 0
    const actualOutputTokens = Number(totals?.outputTokens) || 0
    const actualUsd = Number(totals?.actualUsd) || 0

    // Fetch pricing for the requested candidates in one query.
    const pricingRows =
      candidates.length > 0
        ? await executeQuery(
            (db) =>
              db
                .select({
                  modelId: aiModels.modelId,
                  name: aiModels.name,
                  inputCost: aiModels.inputCostPer1kTokens,
                  outputCost: aiModels.outputCostPer1kTokens,
                })
                .from(aiModels)
                .where(inArray(aiModels.modelId, candidates)),
            "agentCost.candidatePricing"
          )
        : []

    const pricingByModel = new Map(
      pricingRows.map((r) => [String(r.modelId), r])
    )

    const candidateResults: ProjectionItem[] = candidates.map((modelId) => {
      const row = pricingByModel.get(modelId)
      const inputCost = row?.inputCost != null ? Number(row.inputCost) : null
      const outputCost = row?.outputCost != null ? Number(row.outputCost) : null
      const pricingMissing = inputCost == null && outputCost == null
      const usd = pricingMissing
        ? 0
        : (actualInputTokens * (inputCost ?? 0)) / 1000 +
          (actualOutputTokens * (outputCost ?? 0)) / 1000
      return {
        model: modelId,
        name: row?.name ? String(row.name) : modelId,
        usd,
        pricingMissing,
      }
    })

    const result: AgentCostProjection = {
      actualInputTokens,
      actualOutputTokens,
      actualUsd,
      candidates: candidateResults,
      windowDays: rangeDays(safeRange),
    }

    timer({ status: "success" })
    log.info("Agent cost projection loaded", {
      range: safeRange,
      candidates: candidateResults.length,
      actualInputTokens,
      actualOutputTokens,
    })
    return createSuccess(result)
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to load agent cost projection", {
      context: "getAgentCostProjection",
      requestId,
      operation: "getAgentCostProjection",
    })
  }
}

/**
 * List models that have pricing and can be used as projection candidates.
 *
 * Excludes the agent's own model (zai.glm-5) — projecting GLM-5 onto GLM-5 is
 * meaningless. Returns text models with both input and output prices set,
 * sorted by blended cost so the cheapest alternatives surface first.
 */
export async function getPricableModels(): Promise<
  ActionState<PricableModel[]>
> {
  const requestId = generateRequestId()
  const timer = startTimer("getPricableModels")
  const log = createLogger({ requestId, action: "getPricableModels" })

  try {
    await requireRole("administrator")

    const rows = await executeQuery(
      (db) =>
        db
          .select({
            modelId: aiModels.modelId,
            name: aiModels.name,
            provider: aiModels.provider,
            inputCost: aiModels.inputCostPer1kTokens,
            outputCost: aiModels.outputCostPer1kTokens,
          })
          .from(aiModels)
          .where(
            and(
              isNotNull(aiModels.inputCostPer1kTokens),
              isNotNull(aiModels.outputCostPer1kTokens),
              // Exclude the agent's own model from the candidate list.
              ne(aiModels.modelId, "zai.glm-5")
            )
          )
          .orderBy(
            sql`(${aiModels.inputCostPer1kTokens} + ${aiModels.outputCostPer1kTokens}) ASC`
          ),
      "agentCost.pricableModels"
    )

    const models: PricableModel[] = rows.map((r) => ({
      modelId: String(r.modelId),
      name: String(r.name),
      provider: String(r.provider),
      inputCostPer1kTokens: Number(r.inputCost) || 0,
      outputCostPer1kTokens: Number(r.outputCost) || 0,
    }))

    timer({ status: "success" })
    log.info("Pricable models loaded", { count: models.length })
    return createSuccess(models)
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to load pricable models", {
      context: "getPricableModels",
      requestId,
      operation: "getPricableModels",
    })
  }
}
