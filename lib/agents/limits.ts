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

/**
 * Clamp `n` into [1, max]; fall back to `fallback` for non-finite input or any
 * value `< 1`. The `< 1` guard (not `<= 0`) matters: a fractional value like
 * `0.5` is truthy and `> 0`, but `Math.floor(0.5)` is `0`, which would violate
 * the DB CHECK constraints (steps/timeout are `BETWEEN 1 AND <max>`). Anything
 * below 1 therefore resolves to the default rather than an invalid `0`.
 */
function clampPositive(
  n: number | null | undefined,
  fallback: number,
  max: number
): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 1) return fallback;
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
 * Decide whether an accumulated cost (in cents) has reached a run's cost cap.
 * Returns true when a cap is set AND `accumulatedCostCents >= cap`. A null cap
 * never trips.
 *
 * NOTE: the loop's actual mid-run enforcement lives in the streaming provider
 * adapter's `stopWhen` cost condition (it has per-step token usage). This pure
 * predicate is the shared definition of the cap boundary — usable for pre-flight
 * checks or post-run reconciliation against the same semantics.
 */
export function isCostCapExceeded(
  limits: AgentRunLimits,
  accumulatedCostCents: number
): boolean {
  if (limits.costCapCents === null) return false;
  return accumulatedCostCents >= limits.costCapCents;
}

/** Length of the per-assistant rate-limit window (one rolling hour). */
export const AGENT_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/**
 * Decide whether a per-assistant rate limit is exceeded (Issue #926). `cap` is
 * the author-configured max runs per rolling hour; null/≤0/non-finite means no
 * cap (never invent a default). Returns true when a cap is set AND the count of
 * runs already started in the window is at or above it.
 */
export function isAgentRateLimitExceeded(
  recentCount: number,
  cap: number | null | undefined
): boolean {
  if (typeof cap !== "number" || !Number.isFinite(cap) || cap <= 0) return false;
  return recentCount >= cap;
}
