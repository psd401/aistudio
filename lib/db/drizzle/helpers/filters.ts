/**
 * Type-Safe Filter Helpers
 *
 * Dynamic filter building utilities for Drizzle ORM queries.
 * Supports equality, comparison, array, and null checks with type safety.
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #543 - Add type-safe query helpers for common patterns
 *
 * @see https://orm.drizzle.team/docs/operators
 */

import {
  eq,
  ne,
  gt,
  gte,
  lt,
  lte,
  like,
  ilike,
  inArray,
  notInArray,
  isNull,
  isNotNull,
  and,
  or,
  type SQL,
} from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

// ============================================
// Types
// ============================================

/**
 * Supported filter operators
 */
export type FilterOperator =
  | "eq"      // Equal
  | "ne"      // Not equal
  | "gt"      // Greater than
  | "gte"     // Greater than or equal
  | "lt"      // Less than
  | "lte"     // Less than or equal
  | "like"    // SQL LIKE (case-sensitive)
  | "ilike"   // SQL ILIKE (case-insensitive)
  | "in"      // IN array
  | "notIn"   // NOT IN array
  | "isNull"  // IS NULL
  | "isNotNull"; // IS NOT NULL

/**
 * Filter condition definition
 */
export interface FilterCondition<T = unknown> {
  /** Column to filter on */
  column: PgColumn;
  /** Filter operator */
  operator: FilterOperator;
  /** Value to compare (not required for isNull/isNotNull) */
  value?: T;
}

/**
 * Range filter for numeric or date columns
 */
export interface RangeFilter<T> {
  /** Minimum value (inclusive) */
  min?: T;
  /** Maximum value (inclusive) */
  max?: T;
}

/**
 * Convenience type for common filter patterns
 */
export type FilterValue<T> =
  | T                    // Exact match
  | T[]                  // IN array
  | RangeFilter<T>       // Range filter
  | null                 // IS NULL
  | undefined;           // Skip filter

// ============================================
// Filter Building Functions
// ============================================

/**
 * Build a single filter condition
 *
 * @param condition - Filter condition definition
 * @returns SQL condition or undefined if invalid
 *
 * @example
 * ```typescript
 * const condition = buildFilter({
 *   column: users.status,
 *   operator: "eq",
 *   value: "active"
 * });
 *
 * db.select().from(users).where(condition);
 * ```
 */
export function buildFilter<T>(condition: FilterCondition<T>): SQL | undefined {
  const { column, operator, value } = condition;

  switch (operator) {
    case "eq":
      return value !== undefined ? eq(column, value) : undefined;

    case "ne":
      return value !== undefined ? ne(column, value) : undefined;

    case "gt":
      return value !== undefined ? gt(column, value) : undefined;

    case "gte":
      return value !== undefined ? gte(column, value) : undefined;

    case "lt":
      return value !== undefined ? lt(column, value) : undefined;

    case "lte":
      return value !== undefined ? lte(column, value) : undefined;

    case "like":
      return typeof value === "string" ? like(column, value) : undefined;

    case "ilike":
      return typeof value === "string" ? ilike(column, value) : undefined;

    case "in":
      return Array.isArray(value) && value.length > 0 ? inArray(column, value) : undefined;

    case "notIn":
      return Array.isArray(value) && value.length > 0 ? notInArray(column, value) : undefined;

    case "isNull":
      return isNull(column);

    case "isNotNull":
      return isNotNull(column);

    default:
      return undefined;
  }
}

/**
 * Build multiple filter conditions and combine with AND
 *
 * Null/undefined values and invalid conditions are automatically filtered out.
 *
 * @param conditions - Array of filter conditions
 * @returns Combined SQL condition or undefined if no valid conditions
 *
 * @example
 * ```typescript
 * const where = buildFilters([
 *   { column: users.status, operator: "eq", value: "active" },
 *   { column: users.roleId, operator: "in", value: [1, 2, 3] },
 *   { column: users.deletedAt, operator: "isNull" }
 * ]);
 *
 * db.select().from(users).where(where);
 * ```
 */
export function buildFilters(conditions: FilterCondition[]): SQL | undefined {
  const validConditions = conditions
    .map(buildFilter)
    .filter((c): c is SQL => c !== undefined);

  if (validConditions.length === 0) {
    return undefined;
  }

  if (validConditions.length === 1) {
    return validConditions[0];
  }

  return and(...validConditions);
}

/**
 * Build filter conditions combined with OR
 *
 * @param conditions - Array of filter conditions
 * @returns Combined SQL condition with OR logic
 *
 * @example
 * ```typescript
 * const where = buildFiltersOr([
 *   { column: users.status, operator: "eq", value: "active" },
 *   { column: users.status, operator: "eq", value: "pending" }
 * ]);
 * // WHERE status = 'active' OR status = 'pending'
 * ```
 */
export function buildFiltersOr(conditions: FilterCondition[]): SQL | undefined {
  const validConditions = conditions
    .map(buildFilter)
    .filter((c): c is SQL => c !== undefined);

  if (validConditions.length === 0) {
    return undefined;
  }

  if (validConditions.length === 1) {
    return validConditions[0];
  }

  return or(...validConditions);
}

/**
 * Build a range filter (min <= column <= max)
 *
 * @param column - Column to filter on
 * @param range - Range object with min and/or max values
 * @returns Array of SQL conditions (may be 0-2 conditions)
 *
 * @example
 * ```typescript
 * const conditions = buildRangeFilter(users.createdAt, {
 *   min: new Date('2024-01-01'),
 *   max: new Date('2024-12-31')
 * });
 *
 * db.select().from(users).where(and(...conditions));
 * ```
 */
export function buildRangeFilter<T>(
  column: PgColumn,
  range: RangeFilter<T>
): SQL[] {
  const conditions: SQL[] = [];

  if (range.min !== undefined && range.min !== null) {
    conditions.push(gte(column, range.min));
  }

  if (range.max !== undefined && range.max !== null) {
    conditions.push(lte(column, range.max));
  }

  return conditions;
}

// ============================================
// Convenience Filter Builders
// ============================================

/**
 * Build equality filter (or skip if value is undefined/null)
 *
 * NOTE: This function treats `null` as "skip this filter", not "IS NULL".
 * If you need to filter for NULL values explicitly, use `isNull(column)` instead.
 *
 * @param column - Column to filter on
 * @param value - Value to compare
 * @returns SQL condition or undefined
 *
 * @example
 * ```typescript
 * const status = params.status; // may be undefined
 * const where = and(
 *   eq(users.isActive, true),
 *   eqOrSkip(users.status, status)
 * );
 *
 * // For explicit NULL checks, use:
 * // isNull(users.deletedAt)  // WHERE deleted_at IS NULL
 * ```
 */
export function eqOrSkip<T>(column: PgColumn, value: T | undefined | null): SQL | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return eq(column, value);
}

/**
 * Build IN filter (or skip if array is empty/undefined/null)
 *
 * NOTE: This function treats `null` and `undefined` as "skip this filter".
 *
 * @param column - Column to filter on
 * @param values - Array of values
 * @returns SQL condition or undefined
 *
 * @example
 * ```typescript
 * const roleIds = params.roleIds; // may be undefined or empty
 * const where = inArrayOrSkip(users.roleId, roleIds);
 * ```
 */
export function inArrayOrSkip<T>(column: PgColumn, values: T[] | undefined | null): SQL | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }
  return inArray(column, values);
}

/**
 * Build ILIKE filter with wildcards (or skip if value is empty/undefined/null)
 *
 * NOTE: This function treats `null` and `undefined` as "skip this filter".
 *
 * @param column - Column to filter on
 * @param value - Search string (wildcards are added automatically)
 * @returns SQL condition or undefined
 *
 * @example
 * ```typescript
 * const searchTerm = params.search; // may be undefined
 * const where = ilikeOrSkip(users.email, searchTerm);
 * // WHERE email ILIKE '%searchTerm%'
 * ```
 */
export function ilikeOrSkip(column: PgColumn, value: string | undefined | null): SQL | undefined {
  if (!value || value.trim() === "") {
    return undefined;
  }
  return ilike(column, `%${value.trim()}%`);
}

// ============================================
// Utility Functions
// ============================================

/**
 * Combine multiple SQL conditions with AND (filtering out undefined)
 *
 * @param conditions - Array of SQL conditions (may include undefined)
 * @returns Combined condition or undefined if no valid conditions
 *
 * @example
 * ```typescript
 * const where = combineAnd(
 *   eq(users.isActive, true),
 *   eqOrSkip(users.status, params.status),
 *   ilikeOrSkip(users.email, params.search)
 * );
 * ```
 */
export function combineAnd(...conditions: (SQL | undefined)[]): SQL | undefined {
  const valid = conditions.filter((c): c is SQL => c !== undefined);

  if (valid.length === 0) {
    return undefined;
  }

  if (valid.length === 1) {
    return valid[0];
  }

  return and(...valid);
}

/**
 * Combine multiple SQL conditions with OR (filtering out undefined)
 *
 * @param conditions - Array of SQL conditions (may include undefined)
 * @returns Combined condition or undefined if no valid conditions
 */
export function combineOr(...conditions: (SQL | undefined)[]): SQL | undefined {
  const valid = conditions.filter((c): c is SQL => c !== undefined);

  if (valid.length === 0) {
    return undefined;
  }

  if (valid.length === 1) {
    return valid[0];
  }

  return or(...valid);
}
