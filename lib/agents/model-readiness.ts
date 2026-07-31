import type { ModelRouterTier } from "@/lib/ai/model-router/core"

export const AGENTIC_MODEL_CONFIGURATION_ERROR =
  "No agentic-ready model is available. An administrator must configure " +
  "explicit context/output limits, complete input/output pricing, and enable " +
  "Agentic Ready for an active Assistant Architect model."

export interface AgenticModelAdmissionFields {
  active?: boolean | null
  architectEnabled?: boolean | null
  agenticReady?: boolean | null
  contextWindowTokens?: number | null
  maxOutputTokens?: number | null
  inputCostPer1kTokens?: string | null
  outputCostPer1kTokens?: string | null
}

export type AgenticModelAdmissionIssue =
  | "inactive"
  | "architect_disabled"
  | "not_approved"
  | "missing_context_window"
  | "missing_output_limit"
  | "output_exceeds_context"
  | "missing_input_pricing"
  | "missing_output_pricing"

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function validPrice(value: string | null | undefined): boolean {
  if (value === null || value === undefined || value === "") return false
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0
}

export function agenticModelAdmissionIssues(
  model: AgenticModelAdmissionFields
): AgenticModelAdmissionIssue[] {
  const issues: AgenticModelAdmissionIssue[] = []
  if (model.active !== true) issues.push("inactive")
  if (model.architectEnabled !== true) issues.push("architect_disabled")
  if (model.agenticReady !== true) issues.push("not_approved")
  if (!positiveInteger(model.contextWindowTokens)) {
    issues.push("missing_context_window")
  }
  if (!positiveInteger(model.maxOutputTokens)) {
    issues.push("missing_output_limit")
  }
  if (
    positiveInteger(model.contextWindowTokens) &&
    positiveInteger(model.maxOutputTokens) &&
    model.maxOutputTokens > model.contextWindowTokens
  ) {
    issues.push("output_exceeds_context")
  }
  if (!validPrice(model.inputCostPer1kTokens)) {
    issues.push("missing_input_pricing")
  }
  if (!validPrice(model.outputCostPer1kTokens)) {
    issues.push("missing_output_pricing")
  }
  return issues
}

export function isAgenticModelReady(
  model: AgenticModelAdmissionFields
): boolean {
  return agenticModelAdmissionIssues(model).length === 0
}

export interface AgenticTierReadiness {
  tier: ModelRouterTier
  readyModelCount: number
}

export function missingAgenticRoutingTiers(
  readiness: AgenticTierReadiness[]
): ModelRouterTier[] {
  const ready = new Set(
    readiness
      .filter((entry) => entry.readyModelCount > 0)
      .map((entry) => entry.tier)
  )
  return (["light", "medium", "high"] as const).filter(
    (tier) => !ready.has(tier)
  )
}
