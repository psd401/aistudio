/**
 * Custom Drizzle Column Types
 *
 * Shared custom type definitions for specialized PostgreSQL column types.
 * These types provide proper TypeScript integration with PostgreSQL extensions.
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #528 - Generate Drizzle schema from live database
 * Issue #599 - JSONB serialization fix for AWS Data API
 */

import { customType } from "drizzle-orm/pg-core";

/**
 * Custom JSONB type that properly serializes objects to JSON strings
 * for AWS Data API compatibility.
 *
 * The AWS RDS Data API driver requires JSONB values to be passed as
 * JSON strings, not raw JavaScript objects. The standard Drizzle jsonb()
 * type doesn't perform this serialization automatically.
 *
 * This is the ROOT CAUSE of Issue #599 - the standard jsonb() type causes
 * parameter binding errors because objects are passed directly instead of
 * being serialized to strings.
 *
 * Usage:
 * ```typescript
 * import { customJsonb } from "./custom-types";
 *
 * export const myTable = pgTable("my_table", {
 *   data: customJsonb<MyDataType>("data").default({}),
 * });
 * ```
 *
 * @see https://orm.drizzle.team/docs/custom-types
 * @template TData - The TypeScript type for the JSONB data
 * @param name - The column name in the database
 * @returns A Drizzle column builder for JSONB with proper serialization
 */
export function customJsonb<TData>(name: string) {
  return customType<{ data: TData; driverData: string }>({
    dataType() {
      return "jsonb";
    },
    toDriver(value: TData): string {
      return JSON.stringify(value);
    },
    fromDriver(value: unknown): TData {
      // AWS Data API may return already-parsed objects or strings
      if (typeof value === "string") {
        return JSON.parse(value) as TData;
      }
      return value as TData;
    },
  })(name);
}

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
