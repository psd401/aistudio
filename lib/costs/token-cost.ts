/**
 * Shared token-cost math (issue #1083, PR #1087 review finding #5).
 *
 * Cost is computed several ways across the app depending on WHAT token data the
 * call site has — and the formulas were duplicated inline with no shared home,
 * which let them silently drift:
 *
 *   • EXACT — separate input/output token counts are known (e.g. agent_messages
 *     has input_tokens + output_tokens). Price each direction on its own rate.
 *     This is the accurate method; use it whenever the split is available.
 *   • BLENDED — only a single total-token count is known (e.g. a pre-flight
 *     estimate before a request runs, or nexus_conversations.totalTokens which
 *     stores just a total). We approximate by weighting the two rates. Because
 *     the weight is an assumption, a blended figure is an ESTIMATE, not billing
 *     truth.
 *
 * Prices are per-1,000 tokens, matching ai_models.input/output_cost_per_1k_tokens.
 *
 * WHY THE WEIGHTS DIFFER (and why this file does not unify them): the Nexus
 * cost-optimizer uses a 0.6/0.4 input/output split; the Activity dashboard uses
 * 0.5/0.5. Those are pre-existing, user-visible cost numbers. Converging on one
 * weight is a PRODUCT decision — changing them here would silently re-price
 * historical data in unrelated features, so it is deliberately left as a
 * follow-up. This module only removes the duplicated arithmetic.
 *
 * NOTE: the SQL aggregation sites (agent-cost-projection's SUM(...) and
 * activity-management's conversation cost) compute inside the query and cannot
 * import this module; they mirror these formulas in SQL and reference this file.
 */

/**
 * Exact cost when input and output token counts are known separately.
 * `inputPricePer1k` / `outputPricePer1k` are dollars per 1,000 tokens.
 */
export function exactTokenCostUsd(
  inputTokens: number,
  outputTokens: number,
  inputPricePer1k: number,
  outputPricePer1k: number
): number {
  return (
    (inputTokens * inputPricePer1k) / 1000 +
    (outputTokens * outputPricePer1k) / 1000
  )
}

/**
 * Estimated cost when only a single total-token count is known. `inputWeight`
 * is the assumed fraction of tokens that are input (default 0.5 = even split);
 * the remainder (1 - inputWeight) is treated as output. The result is an
 * approximation — prefer {@link exactTokenCostUsd} whenever the real split is
 * available.
 */
export function blendedTokenCostUsd(
  totalTokens: number,
  inputPricePer1k: number,
  outputPricePer1k: number,
  inputWeight = 0.5
): number {
  const outputWeight = 1 - inputWeight
  return (
    (totalTokens / 1000) *
    (inputPricePer1k * inputWeight + outputPricePer1k * outputWeight)
  )
}
