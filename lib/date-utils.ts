/**
 * Date formatting utilities
 *
 * IMPORTANT: All database timestamps are stored in UTC. This utility assumes
 * all date strings are UTC and formats them for display in the user's local timezone.
 */

/**
 * Format a UTC date string for display in the user's local timezone
 *
 * @param dateString - ISO 8601 date string from database (UTC)
 *   Expected formats:
 *   - "2025-01-15T10:30:00Z" (with explicit UTC indicator)
 *   - "2025-01-15T10:30:00+00:00" (with timezone offset)
 *   - "2025-01-15T10:30:00" (assumes UTC, appends "Z")
 *
 * @param includeTime - Whether to include time in the formatted output
 *
 * @returns Formatted date string in user's local timezone (e.g., "Jan 15, 2025" or "Jan 15, 2025, 10:30 AM")
 *          Returns "Never" if dateString is null/undefined
 *
 * @example
 * // Database returns: "2025-01-15T10:30:00" (UTC)
 * // User in PST sees: "Jan 15, 2025, 2:30 AM" (UTC-8)
 * formatDate("2025-01-15T10:30:00", true)
 *
 * @note This function ASSUMES all input dates are in UTC (standard for database timestamps).
 *       If you pass a local time string without timezone info, it will be misinterpreted as UTC.
 */
export function formatDate(
  dateString: string | null | undefined,
  includeTime = false
): string {
  if (!dateString) return "Never"

  // Ensure UTC timezone indicator
  // Database timestamps are UTC - if missing timezone, assume UTC and append "Z"
  const utcString =
    dateString.includes("Z") || dateString.includes("+")
      ? dateString
      : dateString + "Z"

  const date = new Date(utcString)

  if (includeTime) {
    return date.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })
  }

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}

/**
 * Calculate a threshold date by subtracting days from now
 *
 * @param daysAgo - Number of days to subtract from current date
 * @returns Date object representing the threshold (e.g., 30 days ago)
 *
 * @example
 * // Get date 30 days ago
 * const threshold = getDateThreshold(30)
 * // Use for comparisons: user.lastSignInAt >= threshold
 */
export function getDateThreshold(daysAgo: number): Date {
  const threshold = new Date()
  threshold.setDate(threshold.getDate() - daysAgo)
  return threshold
}
