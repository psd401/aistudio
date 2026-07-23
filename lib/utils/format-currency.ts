/**
 * Shared USD currency formatter (issue #1083, review round 2).
 *
 * Consolidates the near-duplicate `Intl.NumberFormat` USD wrappers that had
 * accreted in dashboard components (agent cost view, activity stats cards),
 * which differed only in decimal precision.
 *
 * @param value       amount in USD
 * @param maxFractionDigits  max decimals to show. Default 2 (whole-cent
 *   dashboards). Use 4 for sub-cent figures (e.g. per-turn agent spend) so a
 *   small-but-real cost doesn't round to $0.00 and read as "free".
 */
export function formatUsd(value: number, maxFractionDigits = 2): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: maxFractionDigits,
  }).format(value)
}
