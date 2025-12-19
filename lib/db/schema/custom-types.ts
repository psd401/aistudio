/**
 * Custom Drizzle Column Types
 *
 * Shared custom type definitions for specialized PostgreSQL column types.
 * These types provide proper TypeScript integration with PostgreSQL extensions.
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #528 - Generate Drizzle schema from live database
 */

import { customType } from "drizzle-orm/pg-core";

/**
 * pgvector type for embedding columns
 *
 * PostgreSQL vector type with dimension validation.
 * Used for semantic search with pgvector extension.
 *
 * @param dimensions - Vector dimensions (default: 1536 for OpenAI embeddings)
 *
 * @example
 * ```typescript
 * import { vector } from './custom-types';
 *
 * export const myTable = pgTable('my_table', {
 *   embedding: vector('embedding'), // 1536 dimensions (default)
 *   embedding512: vector('embedding_512', 512), // Custom dimensions
 * });
 * ```
 */
export function vector(columnName: string, dimensions: number = 1536) {
  return customType<{ data: number[] | null; driverData: string | null }>({
    dataType() {
      return `vector(${dimensions})`;
    },
    toDriver(value: number[] | null): string | null {
      if (value === null) {
        return null;
      }

      // Validation: must be array
      if (!Array.isArray(value)) {
        throw new TypeError(
          `Vector column "${columnName}": value must be an array, got ${typeof value}`
        );
      }

      // Validation: must have correct dimensions
      if (value.length !== dimensions) {
        throw new Error(
          `Vector column "${columnName}": expected ${dimensions} dimensions, got ${value.length}`
        );
      }

      // Validation: all values must be valid numbers
      if (!value.every((v) => typeof v === "number" && !Number.isNaN(v))) {
        const invalidIndex = value.findIndex(
          (v) => typeof v !== "number" || Number.isNaN(v)
        );
        throw new Error(
          `Vector column "${columnName}": invalid value at index ${invalidIndex} (must be a valid number)`
        );
      }

      return `[${value.join(",")}]`;
    },
    fromDriver(value: string | null): number[] | null {
      if (value === null) {
        return null;
      }

      try {
        const parsed = JSON.parse(value);

        // Validate parsed value
        if (!Array.isArray(parsed)) {
          throw new TypeError("Parsed value is not an array");
        }

        if (parsed.length !== dimensions) {
          throw new Error(
            `Expected ${dimensions} dimensions, got ${parsed.length}`
          );
        }

        return parsed;
      } catch (error) {
        throw new Error(
          `Vector column "${columnName}": failed to parse database value: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  })(columnName);
}
