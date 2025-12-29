/**
 * Query Helpers - Barrel Export
 *
 * Type-safe query helper utilities for common patterns:
 * - Pagination (cursor-based and offset-based)
 * - Filtering (dynamic WHERE clauses)
 * - Sorting (type-safe column references)
 * - Search (ILIKE patterns, multi-column)
 * - Domain queries (users with roles, conversations with messages)
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #543 - Add type-safe query helpers for common patterns
 *
 * @example
 * ```typescript
 * import {
 *   calculateOffset,
 *   createPaginatedResult,
 *   buildFilters,
 *   buildSortFromField,
 *   buildMultiColumnSearch,
 *   getUsersWithRoles,
 * } from '@/lib/db/drizzle/helpers';
 * ```
 */

// ============================================
// Pagination Helpers
// ============================================

export {
  // Types
  type OffsetPaginationParams,
  type CursorPaginationParams,
  type PaginationMeta,
  type PaginatedResult,
  type CursorPaginatedResult,
  // Constants
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MIN_PAGE,
  // Offset pagination
  calculateOffset,
  buildPaginationMeta,
  createPaginatedResult,
  // Cursor pagination
  buildCursorCondition,
  processCursorResults,
  // SQL helpers
  // IMPORTANT: Always use countAsInt for COUNT queries with RDS Data API.
  // RDS Data API returns bigint as strings; countAsInt casts to int for proper type safety.
  // Use: .select({ count: countAsInt }) instead of count()
  countAsInt,
} from "./pagination";

// ============================================
// Filter Helpers
// ============================================

export {
  // Types
  type FilterOperator,
  type FilterCondition,
  type RangeFilter,
  type FilterValue,
  // Filter builders
  buildFilter,
  buildFilters,
  buildFiltersOr,
  buildRangeFilter,
  // Convenience functions
  eqOrSkip,
  inArrayOrSkip,
  ilikeOrSkip,
  // Combinators
  combineAnd,
  combineOr,
} from "./filters";

// ============================================
// Sorting Helpers
// ============================================

export {
  // Types
  type SortDirection,
  type SortConfig,
  type SortSpec,
  type SortableColumns,
  // Sort builders
  buildSort,
  buildSortFromConfig,
  buildMultiSort,
  buildSortFromField,
  buildSortFromSpec,
  // Common patterns
  buildPinnedFirstSort,
  buildRecentActivitySort,
  // Configuration helper
  createSortableColumns,
} from "./sorting";

// ============================================
// Search Helpers
// ============================================

export {
  // Types
  type SearchOptions,
  type MultiColumnSearchConfig,
  // Search utilities
  escapeSearchPattern,
  buildSearchPattern,
  buildSearchCondition,
  buildMultiColumnSearch,
  buildSearchFromConfig,
  // Convenience functions
  searchContains,
  searchStartsWith,
  searchEndsWith,
  searchExact,
  // Configuration helper
  createSearchableColumns,
} from "./search";

// ============================================
// Domain Query Helpers
// ============================================

export {
  // Types - Users
  type UserWithRoles,
  type UserWithRolesAndTools,
  type UserQueryFilters,
  // Types - Conversations
  type ConversationWithMessages,
  type ConversationQueryFilters,
  // User queries
  getUsersWithRoles,
  getUserWithRolesAndTools,
  // Conversation queries
  getConversationsWithMessages,
  getConversationWithAllMessages,
} from "./domain-queries";
