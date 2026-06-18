/**
 * Agentic Assistant Runtime — run-limit resolution (Issue #926).
 *
 * Resolves the effective per-run limits (step count, timeout, cost cap) from an
 * assistant's stored config, applying defaults for unset values and clamping
 * everything to hard ceilings as defense in depth. The DB also CHECK-constrains
 * these (migration 082); clamping here protects against any path that bypasses
 * the column constraints (e.g. a future bulk import).
 */

import {
  AGENT_LIMIT_CEILINGS,
  AGENT_LIMIT_DEFAULTS,
  type AgentRunLimits,
} from "./types";

/** A subset of the assistant row carrying the agentic limit columns. */
export interface AgentLimitConfig {
  agentMaxSteps?: number | null;
  agentTimeoutSeconds?: number | null;
  agentCostCapCents?: number | null;
}

/** Clamp `n` into [min, max]; fall back to `fallback` for non-finite/≤0 input. */
function clampPositive(
  n: number | null | undefined,
  fallback: number,
  max: number
): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

/**
 * Resolve effective limits for a run. Steps and timeout are clamped to ceilings;
 * the cost cap (if set and positive) is passed through, else null (no cap).
 */
export function resolveAgentRunLimits(
  config: AgentLimitConfig
): AgentRunLimits {
  const maxSteps = clampPositive(
    config.agentMaxSteps,
    AGENT_LIMIT_DEFAULTS.maxSteps,
    AGENT_LIMIT_CEILINGS.maxSteps
  );
  const timeoutSeconds = clampPositive(
    config.agentTimeoutSeconds,
    AGENT_LIMIT_DEFAULTS.timeoutSeconds,
    AGENT_LIMIT_CEILINGS.timeoutSeconds
  );
  const costCapCents =
    typeof config.agentCostCapCents === "number" &&
    Number.isFinite(config.agentCostCapCents) &&
    config.agentCostCapCents > 0
      ? Math.floor(config.agentCostCapCents)
      : null;

  return { maxSteps, timeoutSeconds, costCapCents };
}

/**
 * Decide whether a run has exceeded its cost cap. Returns true when a cap is set
 * AND the accumulated cost (in cents) is at or above it. Used by the execution
 * loop to stop scheduling further steps. A null cap never trips.
 */
export function isCostCapExceeded(
  limits: AgentRunLimits,
  accumulatedCostCents: number
): boolean {
  if (limits.costCapCents === null) return false;
  return accumulatedCostCents >= limits.costCapCents;
}
