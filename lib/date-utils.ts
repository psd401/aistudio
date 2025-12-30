/**
 * Date formatting utilities
 */

/**
 * Format a date string for display
 * @param dateString - ISO date string or null/undefined
 * @param includeTime - Whether to include time in the formatted output
 * @returns Formatted date string or "Never" if no date provided
 */
export function formatDate(
  dateString: string | null | undefined,
  includeTime = false
): string {
  if (!dateString) return "Never"

  // Ensure UTC string format
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
