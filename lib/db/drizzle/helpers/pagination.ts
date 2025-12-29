/**
 * Type-Safe Pagination Helpers
 *
 * Reusable pagination utilities for Drizzle ORM queries.
 * Supports both cursor-based (recommended for performance) and offset-based pagination.
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #543 - Add type-safe query helpers for common patterns
 *
 * @see https://orm.drizzle.team/docs/select#limit--offset
 */

import { sql, gt, lt, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

// ============================================
// Types
// ============================================

/**
 * Parameters for offset-based pagination
 */
export interface OffsetPaginationParams {
  /** Page number (1-indexed). Default: 1 */
  page?: number;
  /** Number of items per page. Default: 25 */
  limit?: number;
}

/**
 * Parameters for cursor-based pagination
 */
export interface CursorPaginationParams<T> {
  /** Cursor value (usually the last item's sort column value) */
  cursor?: T;
  /** Number of items to fetch. Default: 25 */
  limit?: number;
  /** Sort direction. Default: "desc" */
  direction?: "asc" | "desc";
}

/**
 * Pagination metadata returned with paginated results
 */
export interface PaginationMeta {
  /** Current page number (1-indexed) */
  page: number;
  /** Items per page */
  limit: number;
  /** Total number of items matching the query */
  total: number;
  /** Total number of pages */
  totalPages: number;
  /** Whether there are more pages after this one */
  hasNextPage: boolean;
  /** Whether there are pages before this one */
  hasPreviousPage: boolean;
}

/**
 * Paginated result wrapper
 */
export interface PaginatedResult<T> {
  /** Array of items for the current page */
  data: T[];
  /** Pagination metadata */
  pagination: PaginationMeta;
}

/**
 * Cursor-based paginated result
 */
export interface CursorPaginatedResult<T, C> {
  /** Array of items */
  data: T[];
  /** Cursor for the next page (undefined if no more pages) */
  nextCursor?: C;
  /** Whether there are more items after this batch */
  hasMore: boolean;
}

// ============================================
// Configuration
// ============================================

/** Default number of items per page */
export const DEFAULT_PAGE_SIZE = 25;

/** Maximum allowed page size to prevent resource exhaustion */
export const MAX_PAGE_SIZE = 100;

/** Minimum page number */
export const MIN_PAGE = 1;

// ============================================
// Offset Pagination Helpers
// ============================================

/**
 * Calculate offset and limit for offset-based pagination
 *
 * @param params - Pagination parameters
 * @param maxLimit - Maximum allowed limit (default: MAX_PAGE_SIZE)
 * @returns Object with offset and limit values
 *
 * @example
 * ```typescript
 * const { offset, limit } = calculateOffset({ page: 2, limit: 20 });
 * // offset: 20, limit: 20
 *
 * db.select().from(users).limit(limit).offset(offset);
 * ```
 */
export function calculateOffset(
  params: OffsetPaginationParams,
  maxLimit: number = MAX_PAGE_SIZE
): { offset: number; limit: number } {
  const page = Math.max(MIN_PAGE, params.page ?? MIN_PAGE);
  const limit = Math.min(Math.max(1, params.limit ?? DEFAULT_PAGE_SIZE), maxLimit);
  const offset = (page - 1) * limit;

  return { offset, limit };
}

/**
 * Build pagination metadata from query results
 *
 * @param params - Original pagination parameters
 * @param total - Total count of items matching the query
 * @returns Pagination metadata object
 *
 * @example
 * ```typescript
 * const meta = buildPaginationMeta({ page: 2, limit: 20 }, 100);
 * // { page: 2, limit: 20, total: 100, totalPages: 5, hasNextPage: true, hasPreviousPage: true }
 * ```
 */
export function buildPaginationMeta(
  params: OffsetPaginationParams,
  total: number
): PaginationMeta {
  const { offset, limit } = calculateOffset(params);
  const page = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(total / limit);

  return {
    page,
    limit,
    total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
}

/**
 * Create a paginated result object
 *
 * @param data - Array of items for the current page
 * @param params - Pagination parameters used for the query
 * @param total - Total count of items matching the query
 * @returns PaginatedResult with data and metadata
 *
 * @example
 * ```typescript
 * const users = await db.select().from(usersTable).limit(limit).offset(offset);
 * const count = await db.select({ count: sql`count(*)::int` }).from(usersTable);
 * return createPaginatedResult(users, { page: 1, limit: 25 }, count[0].count);
 * ```
 */
export function createPaginatedResult<T>(
  data: T[],
  params: OffsetPaginationParams,
  total: number
): PaginatedResult<T> {
  return {
    data,
    pagination: buildPaginationMeta(params, total),
  };
}

// ============================================
// Cursor Pagination Helpers
// ============================================

/**
 * Build cursor condition for cursor-based pagination
 *
 * Cursor-based pagination is more efficient than offset for large datasets
 * because it doesn't require counting rows to skip.
 *
 * @param column - The column to use as cursor (usually createdAt or id)
 * @param cursor - The cursor value (last item's column value)
 * @param direction - Sort direction ("asc" or "desc")
 * @returns SQL condition for WHERE clause, or undefined if no cursor
 *
 * @example
 * ```typescript
 * const cursorCondition = buildCursorCondition(
 *   users.createdAt,
 *   lastUser?.createdAt,
 *   "desc"
 * );
 *
 * db.select()
 *   .from(users)
 *   .where(cursorCondition)
 *   .orderBy(desc(users.createdAt))
 *   .limit(25);
 * ```
 */
export function buildCursorCondition<T>(
  column: PgColumn,
  cursor: T | undefined,
  direction: "asc" | "desc" = "desc"
): SQL | undefined {
  if (cursor === undefined || cursor === null) {
    return undefined;
  }

  // For descending order, get items LESS than cursor (older)
  // For ascending order, get items GREATER than cursor (newer)
  return direction === "desc" ? lt(column, cursor) : gt(column, cursor);
}

/**
 * Process results for cursor-based pagination
 *
 * Fetches one extra item to determine if there are more pages.
 *
 * @param results - Query results (should fetch limit + 1 items)
 * @param limit - Requested page size
 * @param getCursor - Function to extract cursor value from an item
 * @returns CursorPaginatedResult with hasMore indicator
 *
 * @example
 * ```typescript
 * const limit = 25;
 * const results = await db.select()
 *   .from(users)
 *   .orderBy(desc(users.createdAt))
 *   .limit(limit + 1); // Fetch one extra
 *
 * return processCursorResults(results, limit, (user) => user.createdAt);
 * ```
 */
export function processCursorResults<T, C>(
  results: T[],
  limit: number,
  getCursor: (item: T) => C
): CursorPaginatedResult<T, C> {
  const hasMore = results.length > limit;
  const data = hasMore ? results.slice(0, limit) : results;
  const nextCursor = hasMore && data.length > 0 ? getCursor(data[data.length - 1]) : undefined;

  return {
    data,
    nextCursor,
    hasMore,
  };
}

// ============================================
// SQL Count Helper
// ============================================

/**
 * SQL expression for counting rows as integer
 *
 * Use in select queries to get total count for pagination.
 *
 * @example
 * ```typescript
 * const [{ count }] = await db
 *   .select({ count: countAsInt })
 *   .from(users)
 *   .where(eq(users.isActive, true));
 * ```
 */
export const countAsInt = sql<number>`count(*)::int`;
