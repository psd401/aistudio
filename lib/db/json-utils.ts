/**
 * JSON Utilities for Database Operations
 *
 * Provides safe JSON serialization for JSONB database fields.
 * Used with AWS Data API driver workaround for JSONB serialization.
 *
 * @see /docs/database/drizzle-patterns.md - AWS Data API JSONB Workaround
 */

/**
 * Safely stringify a value for JSONB database insertion
 *
 * Handles edge cases:
 * - Circular references (throws descriptive error)
 * - Undefined values (converts to null in JSON)
 * - Special values (Infinity, NaN become null)
 *
 * @param value - Value to stringify for JSONB storage
 * @returns JSON string safe for database insertion
 * @throws Error if value cannot be serialized (e.g., circular reference)
 *
 * @example
 * // Basic usage
 * const jsonStr = safeJsonbStringify({ key: 'value' });
 *
 * @example
 * // With sql template tag
 * inputData: sql`${safeJsonbStringify(data)}::jsonb`
 */
export function safeJsonbStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to stringify JSONB value: ${errorMessage}`);
  }
}
