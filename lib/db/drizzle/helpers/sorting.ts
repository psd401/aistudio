/**
 * Type-Safe Sorting Helpers
 *
 * Sorting utilities for Drizzle ORM queries with type-safe column references.
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #543 - Add type-safe query helpers for common patterns
 *
 * @see https://orm.drizzle.team/docs/select#order-by
 */

import { asc, desc, sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

// ============================================
// Types
// ============================================

/**
 * Sort direction
 */
export type SortDirection = "asc" | "desc";

/**
 * Single sort configuration
 */
export interface SortConfig {
  /** Column to sort by */
  column: PgColumn;
  /** Sort direction (default: "desc") */
  direction?: SortDirection;
}

/**
 * Sort specification using column name string
 * Useful when sort column comes from API params
 */
export interface SortSpec<T extends string = string> {
  /** Column name to sort by */
  field: T;
  /** Sort direction (default: "desc") */
  direction?: SortDirection;
}

/**
 * Map of sortable column names to their Drizzle column references
 */
export type SortableColumns<T extends string> = Record<T, PgColumn>;

// ============================================
// Sorting Functions
// ============================================

/**
 * Build a single sort expression
 *
 * @param column - Column to sort by
 * @param direction - Sort direction (default: "desc")
 * @returns SQL order by expression
 *
 * @example
 * ```typescript
 * db.select()
 *   .from(users)
 *   .orderBy(buildSort(users.createdAt, "desc"));
 * ```
 */
export function buildSort(column: PgColumn, direction: SortDirection = "desc"): SQL {
  return direction === "asc" ? asc(column) : desc(column);
}

/**
 * Build sort expression from config object
 *
 * @param config - Sort configuration
 * @returns SQL order by expression
 *
 * @example
 * ```typescript
 * db.select()
 *   .from(users)
 *   .orderBy(buildSortFromConfig({ column: users.createdAt, direction: "desc" }));
 * ```
 */
export function buildSortFromConfig(config: SortConfig): SQL {
  return buildSort(config.column, config.direction ?? "desc");
}

/**
 * Build multiple sort expressions
 *
 * @param configs - Array of sort configurations
 * @returns Array of SQL order by expressions
 *
 * @example
 * ```typescript
 * db.select()
 *   .from(users)
 *   .orderBy(...buildMultiSort([
 *     { column: users.isPinned, direction: "desc" },
 *     { column: users.createdAt, direction: "desc" }
 *   ]));
 * ```
 */
export function buildMultiSort(configs: SortConfig[]): SQL[] {
  return configs.map(buildSortFromConfig);
}

/**
 * Build sort from a field name string with a sortable columns map
 *
 * Provides type-safe column name validation at runtime.
 *
 * @param sortableColumns - Map of allowed column names to Drizzle columns
 * @param field - Field name to sort by
 * @param direction - Sort direction (default: "desc")
 * @param defaultColumn - Fallback column if field is invalid
 * @returns SQL order by expression
 * @throws Error if field is invalid and no default provided
 *
 * @example
 * ```typescript
 * const sortableUserColumns = {
 *   createdAt: users.createdAt,
 *   email: users.email,
 *   firstName: users.firstName,
 * } as const;
 *
 * type UserSortField = keyof typeof sortableUserColumns;
 *
 * function getUsers(sortBy: UserSortField = "createdAt", direction: SortDirection = "desc") {
 *   return db.select()
 *     .from(users)
 *     .orderBy(buildSortFromField(sortableUserColumns, sortBy, direction));
 * }
 * ```
 */
export function buildSortFromField<T extends string>(
  sortableColumns: SortableColumns<T>,
  field: string,
  direction: SortDirection = "desc",
  defaultColumn?: PgColumn
): SQL {
  const column = sortableColumns[field as T];

  if (!column) {
    if (defaultColumn) {
      return buildSort(defaultColumn, direction);
    }
    const validFields = Object.keys(sortableColumns).join(", ");
    throw new Error(`Invalid sort field: "${field}". Valid fields are: ${validFields}`);
  }

  return buildSort(column, direction);
}

/**
 * Build sort from a SortSpec with validation
 *
 * @param sortableColumns - Map of allowed column names to Drizzle columns
 * @param spec - Sort specification
 * @param defaultColumn - Fallback column if field is invalid
 * @returns SQL order by expression
 *
 * @example
 * ```typescript
 * const spec: SortSpec = { field: "createdAt", direction: "desc" };
 * db.select()
 *   .from(users)
 *   .orderBy(buildSortFromSpec(sortableUserColumns, spec, users.createdAt));
 * ```
 */
export function buildSortFromSpec<T extends string>(
  sortableColumns: SortableColumns<T>,
  spec: SortSpec<T>,
  defaultColumn?: PgColumn
): SQL {
  return buildSortFromField(sortableColumns, spec.field, spec.direction, defaultColumn);
}

// ============================================
// Common Sort Patterns
// ============================================

/**
 * Build a "pinned first" sort pattern
 *
 * Sorts pinned items first (at top), then by a secondary column.
 * Handles null values safely with COALESCE.
 *
 * @param pinnedColumn - Boolean column indicating pinned status
 * @param secondaryColumn - Secondary sort column
 * @param secondaryDirection - Direction for secondary sort (default: "desc")
 * @returns Array of SQL order by expressions
 *
 * @example
 * ```typescript
 * db.select()
 *   .from(conversations)
 *   .orderBy(...buildPinnedFirstSort(
 *     conversations.isPinned,
 *     conversations.lastMessageAt
 *   ));
 * // Pinned conversations first, then by most recent message
 * ```
 */
export function buildPinnedFirstSort(
  pinnedColumn: PgColumn,
  secondaryColumn: PgColumn,
  secondaryDirection: SortDirection = "desc"
): SQL[] {
  return [
    desc(sql`COALESCE(${pinnedColumn}, false)`),
    buildSort(secondaryColumn, secondaryDirection),
  ];
}

/**
 * Build a "most recent activity" sort pattern
 *
 * Sorts by whichever timestamp is more recent (useful when items have
 * multiple activity timestamps like lastMessageAt and updatedAt).
 *
 * @param primaryColumn - Primary timestamp column
 * @param fallbackColumn - Fallback timestamp column
 * @param direction - Sort direction (default: "desc")
 * @returns SQL order by expression
 *
 * @example
 * ```typescript
 * db.select()
 *   .from(conversations)
 *   .orderBy(buildRecentActivitySort(
 *     conversations.lastMessageAt,
 *     conversations.updatedAt
 *   ));
 * // Sorts by most recent of lastMessageAt or updatedAt
 * ```
 */
export function buildRecentActivitySort(
  primaryColumn: PgColumn,
  fallbackColumn: PgColumn,
  direction: SortDirection = "desc"
): SQL {
  const coalesced = sql`COALESCE(${primaryColumn}, ${fallbackColumn})`;
  return direction === "desc" ? desc(coalesced) : asc(coalesced);
}

// ============================================
// Helper to Create Sortable Column Maps
// ============================================

/**
 * Create a sortable columns map from a Drizzle table
 *
 * This is a type-safe way to define which columns can be sorted on.
 *
 * @param columns - Object mapping field names to column references
 * @returns Typed sortable columns map
 *
 * @example
 * ```typescript
 * const sortableUserColumns = createSortableColumns({
 *   createdAt: users.createdAt,
 *   email: users.email,
 *   firstName: users.firstName,
 *   lastName: users.lastName,
 * });
 *
 * // TypeScript knows the valid field names
 * type UserSortField = keyof typeof sortableUserColumns;
 * // "createdAt" | "email" | "firstName" | "lastName"
 * ```
 */
export function createSortableColumns<T extends Record<string, PgColumn>>(
  columns: T
): SortableColumns<Extract<keyof T, string>> {
  return columns as SortableColumns<Extract<keyof T, string>>;
}
