"use server"

/**
 * Agent platform cost — token×pricing source of truth (issue #1083, cache-aware #1089).
 *
 * The AWS Cost Explorer path (agent-cost.actions.ts) cannot attribute the
 * harness model's Bedrock Mantle spend because Mantle runs through a separate
 * IAM user's bearer token, not the tagged AgentCore execution role — so that
 * panel is now a reconciliation-only view. THIS file is the authoritative
 * model-cost answer: it multiplies the real per-model token volume recorded in
 * agent_messages (input/output plus the cache-read/cache-write split, #1089) by
 * the pricing rows in ai_models.
 *
 * Two questions the dashboard exists to answer:
 *   1. How much is the agent (Claude Sonnet 5) actually costing? → getAgentCostByModel
 *   2. What would a different model cost?                        → getAgentCostProjection
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
import { AGENT_MODEL_ID } from "@/lib/agents/platform-model"
import { exactTokenCostUsd } from "@/lib/costs/token-cost"
import type { TelemetryDateRange } from "@/actions/admin/agent-telemetry.actions"

// ============================================
// Types
// ============================================

export interface ModelCostItem {
  /** The model id recorded on agent_messages.model (e.g. "anthropic.claude-sonnet-5"). */
  model: string
  messageCount: number
  inputTokens: number
  outputTokens: number
  /** Bedrock prompt-caching split (issue #1089). 0 on non-caching models (GLM-5). */
  cacheReadTokens: number
  cacheWriteTokens: number
  /**
   * Cache-aware actual cost (issue #1089):
   *   input×inputPrice + output×outputPrice
   *   + cacheRead×cachedInputPrice + cacheWrite×cacheWritePrice.
   */
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

/**
 * Cache-aware per-direction cost as a single reusable SQL fragment — the SQL
 * mirror of exactTokenCostUsd (lib/costs/token-cost.ts). agent_messages stores
 * the input/output/cache-read/cache-write split, so no blend is needed; prices
 * are per-1k-tokens (÷1000).
 *
 * Four priced directions (issue #1089): full-price input, output, cache-READ
 * (~0.1× input, column cached_input_cost_per_1k_tokens) and cache-WRITE (2×
 * input at 1h TTL, column cache_write_cost_per_1k_tokens). Note input_tokens is
 * already the DE-CACHED billable input (mantle_proxy.py subtracts cache tokens
 * from the OpenAI prompt_tokens total), so the four terms don't double-count.
 *
 * The per-direction COALESCE is load-bearing: a model priced on only SOME
 * directions (e.g. GLM-5 has input/output set but cache rates NULL) must still
 * count the priced sides. A single outer COALESCE would let any NULL side
 * poison the whole sum (X + NULL = NULL) and collapse a real cost to $0 (gemini
 * review, #1083). GLM-5's cache tokens are 0 anyway, so its cache terms are 0.
 *
 * Shared between getAgentCostByModel and getAgentCostProjection so a future
 * pricing change (discount tier, rounding) can't be applied to only one of the
 * two aggregation sites (claude review, #1087). Mirrors the countAsInt fragment
 * pattern in lib/db/drizzle/helpers/pagination.ts.
 */
const perDirectionCostUsdSql = sql<string>`
  COALESCE(SUM(${agentMessages.inputTokens}::numeric * ${aiModels.inputCostPer1kTokens} / 1000.0), 0)
  + COALESCE(SUM(${agentMessages.outputTokens}::numeric * ${aiModels.outputCostPer1kTokens} / 1000.0), 0)
  + COALESCE(SUM(${agentMessages.cacheReadInputTokens}::numeric * ${aiModels.cachedInputCostPer1kTokens} / 1000.0), 0)
  + COALESCE(SUM(${agentMessages.cacheWriteInputTokens}::numeric * ${aiModels.cacheWriteCostPer1kTokens} / 1000.0), 0)`

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
 *
 * NOTE: agent_messages rows written before #1083 recorded a placeholder model
 * id ("default" / "kimi-k2.5" / "unknown") with no ai_models pricing row, so
 * that historical spend legitimately reports pricingMissing=true / $0. It is old
 * data, not a pricing-config gap; pricing it would need a per-message cost
 * snapshot or a one-time relabel (out of scope here). (claude review, #1087)
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
            cacheReadTokens: sql<number>`COALESCE(SUM(${agentMessages.cacheReadInputTokens}), 0)`,
            cacheWriteTokens: sql<number>`COALESCE(SUM(${agentMessages.cacheWriteInputTokens}), 0)`,
            // Cache-aware per-direction cost — see perDirectionCostUsdSql above.
            usd: perDirectionCostUsdSql,
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
          // COALESCE inside the SUM: input_tokens/output_tokens are NOT NULL
          // (schema default 0), but coalescing is defensive and keeps NULL rows
          // from floating to the top under DESC (gemini review, #1083).
          .orderBy(sql`SUM(COALESCE(${agentMessages.inputTokens}, 0) + COALESCE(${agentMessages.outputTokens}, 0)) DESC`),
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
        cacheReadTokens: Number(r.cacheReadTokens) || 0,
        cacheWriteTokens: Number(r.cacheWriteTokens) || 0,
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
            // Exact per-direction cost — see perDirectionCostUsdSql above.
            actualUsd: perDirectionCostUsdSql,
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
        : exactTokenCostUsd(
            actualInputTokens,
            actualOutputTokens,
            inputCost ?? 0,
            outputCost ?? 0
          )
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
 * Excludes the agent's own model (AGENT_MODEL_ID, anthropic.claude-sonnet-5) —
 * projecting the harness model onto itself is meaningless. Returns ACTIVE models
 * with both input and output prices set, sorted by blended cost so the cheapest
 * alternatives surface first. Inactive models are excluded so a retired model
 * with stale pricing can't be projected (the harness Sonnet 5 row is inactive,
 * so it's excluded here too).
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
              // Only active models are selectable elsewhere in the product;
              // a deactivated/retired model with a stale pricing row must not
              // appear as a live "compare to" candidate (claude review, #1087).
              eq(aiModels.active, true),
              isNotNull(aiModels.inputCostPer1kTokens),
              isNotNull(aiModels.outputCostPer1kTokens),
              // Exclude the agent's own model from the candidate list.
              ne(aiModels.modelId, AGENT_MODEL_ID)
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
