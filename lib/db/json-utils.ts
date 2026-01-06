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
 * - Top-level undefined (converts to null)
 * - Circular references (throws descriptive error)
 * - Object properties with undefined (omitted from result per JSON.stringify spec)
 * - Array elements with undefined (becomes null per JSON.stringify spec)
 * - Special values (Infinity, NaN become null per JSON.stringify spec)
 *
 * @param value - Value to stringify for JSONB storage
 * @returns JSON string safe for database insertion, never returns undefined
 * @throws Error if value cannot be serialized (e.g., circular reference)
 *
 * @example
 * // Basic usage
 * const jsonStr = safeJsonbStringify({ key: 'value' });
 *
 * @example
 * // With sql template tag
 * inputData: sql`${safeJsonbStringify(data)}::jsonb`
 *
 * @example
 * // Top-level undefined becomes "null"
 * safeJsonbStringify(undefined) // Returns "null"
 *
 * @example
 * // Object property undefined is omitted
 * safeJsonbStringify({ a: 1, b: undefined }) // Returns '{"a":1}'
 *
 * @example
 * // Array element undefined becomes null
 * safeJsonbStringify([1, undefined, 3]) // Returns '[1,null,3]'
 */
export function safeJsonbStringify(value: unknown): string {
  // Handle top-level undefined - JSON.stringify(undefined) returns undefined, not a string
  // Convert to null for database compatibility
  if (value === undefined) {
    return 'null';
  }

  try {
    const result = JSON.stringify(value);

    // Defensive check: JSON.stringify can return undefined for functions and symbols
    // This should be rare given TypeScript types, but handle gracefully
    if (result === undefined) {
      return 'null';
    }

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to stringify JSONB value: ${errorMessage}`);
  }
}
