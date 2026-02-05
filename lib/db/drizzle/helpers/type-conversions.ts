/**
 * Type conversion helpers for Drizzle ORM with postgres.js driver
 *
 * postgres.js returns raw primitive types from SQL aggregation functions,
 * despite Drizzle's sql<T> type hints being compile-time only.
 */

/**
 * Convert postgres.js aggregation result to Date
 *
 * postgres.js returns timestamps as ISO strings from aggregation functions
 * like MAX(), MIN(), etc., despite Drizzle's sql<Date> type annotation being
 * a compile-time hint only with no runtime conversion.
 *
 * @param value - Raw value from postgres.js aggregation (string, null, or undefined)
 * @returns Date object or null
 *
 * @example
 * ```typescript
 * const stats = await db.select({
 *   lastActivity: sql<Date>`max(created_at)`
 * }).from(table);
 *
 * const lastActivity = aggregationTimestampToDate(stats[0]?.lastActivity);
 * // lastActivity is now Date | null, not string | null
 * ```
 */
export function aggregationTimestampToDate(value: unknown): Date | null {
  if (!value) return null;
  return new Date(value as string);
}
