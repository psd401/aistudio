/**
 * Type-Safe Search Helpers
 *
 * Text search utilities for Drizzle ORM queries supporting ILIKE patterns
 * and multi-column search.
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #543 - Add type-safe query helpers for common patterns
 *
 * @see https://orm.drizzle.team/docs/operators#like
 */

import { ilike, like, or, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

// ============================================
// Types
// ============================================

/**
 * Search configuration options
 */
export interface SearchOptions {
  /** Use case-sensitive search (LIKE instead of ILIKE). Default: false */
  caseSensitive?: boolean;
  /** Search for exact match (no wildcards). Default: false */
  exactMatch?: boolean;
  /** Match at start of string only. Default: false */
  startsWith?: boolean;
  /** Match at end of string only. Default: false */
  endsWith?: boolean;
}

/**
 * Multi-column search configuration
 */
export interface MultiColumnSearchConfig {
  /** Columns to search across */
  columns: PgColumn[];
  /** Search term */
  term: string;
  /** Search options */
  options?: SearchOptions;
}

// ============================================
// Search Functions
// ============================================

/**
 * Escape special SQL LIKE pattern characters
 *
 * NOTE: This is NOT for SQL injection prevention (Drizzle handles that via parameterization).
 * This escapes LIKE wildcards so they're treated as literal characters.
 *
 * Without escaping: searching for "50%" would match "50abc", "50xyz", etc.
 * With escaping: searching for "50%" matches only the literal string "50%"
 *
 * @param value - String to escape
 * @returns Escaped string safe for LIKE patterns
 *
 * @example
 * ```typescript
 * escapeSearchPattern("50%")  // Returns "50\\%"
 * escapeSearchPattern("_test")  // Returns "\\_test"
 * ```
 */
export function escapeSearchPattern(value: string): string {
  return value
    .replace(/\\/g, "\\\\")  // Escape backslashes first
    .replace(/%/g, "\\%")     // Escape % wildcard (matches any characters)
    .replace(/_/g, "\\_");    // Escape _ wildcard (matches single character)
}

/**
 * Build a search pattern based on options
 *
 * @param term - Search term
 * @param options - Search options
 * @returns Search pattern with appropriate wildcards
 * @throws Error if term is not a string
 */
export function buildSearchPattern(term: string, options: SearchOptions = {}): string {
  // Validate input is a string
  if (typeof term !== "string") {
    throw new TypeError(`Search term must be a string. Received: ${typeof term}`);
  }

  const escaped = escapeSearchPattern(term.trim());

  if (options.exactMatch) {
    return escaped;
  }

  if (options.startsWith) {
    return `${escaped}%`;
  }

  if (options.endsWith) {
    return `%${escaped}`;
  }

  // Default: contains (wildcards on both sides)
  return `%${escaped}%`;
}

/**
 * Build a single column search condition
 *
 * @param column - Column to search
 * @param term - Search term
 * @param options - Search options
 * @returns SQL condition or undefined if term is empty
 *
 * @example
 * ```typescript
 * const where = buildSearchCondition(users.email, "john", { startsWith: true });
 * // WHERE email ILIKE 'john%'
 * ```
 */
export function buildSearchCondition(
  column: PgColumn,
  term: string,
  options: SearchOptions = {}
): SQL | undefined {
  const trimmedTerm = term.trim();

  if (!trimmedTerm) {
    return undefined;
  }

  const pattern = buildSearchPattern(trimmedTerm, options);
  const operator = options.caseSensitive ? like : ilike;

  return operator(column, pattern);
}

/**
 * Build a multi-column search condition (OR across columns)
 *
 * Searches for the term in any of the provided columns.
 *
 * @param columns - Array of columns to search
 * @param term - Search term
 * @param options - Search options
 * @returns SQL condition with OR logic, or undefined if term is empty
 *
 * @example
 * ```typescript
 * const where = buildMultiColumnSearch(
 *   [users.firstName, users.lastName, users.email],
 *   "john"
 * );
 * // WHERE first_name ILIKE '%john%' OR last_name ILIKE '%john%' OR email ILIKE '%john%'
 * ```
 */
export function buildMultiColumnSearch(
  columns: PgColumn[],
  term: string,
  options: SearchOptions = {}
): SQL | undefined {
  const trimmedTerm = term.trim();

  if (!trimmedTerm || columns.length === 0) {
    return undefined;
  }

  const conditions = columns
    .map((col) => buildSearchCondition(col, trimmedTerm, options))
    .filter((c): c is SQL => c !== undefined);

  if (conditions.length === 0) {
    return undefined;
  }

  if (conditions.length === 1) {
    return conditions[0];
  }

  return or(...conditions);
}

/**
 * Build search condition from config object
 *
 * @param config - Search configuration
 * @returns SQL condition or undefined
 *
 * @example
 * ```typescript
 * const where = buildSearchFromConfig({
 *   columns: [users.firstName, users.lastName, users.email],
 *   term: "john",
 *   options: { caseSensitive: false }
 * });
 * ```
 */
export function buildSearchFromConfig(config: MultiColumnSearchConfig): SQL | undefined {
  return buildMultiColumnSearch(config.columns, config.term, config.options);
}

// ============================================
// Convenience Functions
// ============================================

/**
 * Build a "contains" search (case-insensitive)
 *
 * @param column - Column to search
 * @param term - Search term
 * @returns SQL condition or undefined
 *
 * @example
 * ```typescript
 * db.select().from(users).where(searchContains(users.email, searchTerm));
 * ```
 */
export function searchContains(column: PgColumn, term: string | undefined | null): SQL | undefined {
  if (!term) {
    return undefined;
  }
  return buildSearchCondition(column, term);
}

/**
 * Build a "starts with" search (case-insensitive)
 *
 * @param column - Column to search
 * @param term - Search term
 * @returns SQL condition or undefined
 *
 * @example
 * ```typescript
 * db.select().from(users).where(searchStartsWith(users.email, "admin"));
 * // WHERE email ILIKE 'admin%'
 * ```
 */
export function searchStartsWith(column: PgColumn, term: string | undefined | null): SQL | undefined {
  if (!term) {
    return undefined;
  }
  return buildSearchCondition(column, term, { startsWith: true });
}

/**
 * Build an "ends with" search (case-insensitive)
 *
 * @param column - Column to search
 * @param term - Search term
 * @returns SQL condition or undefined
 *
 * @example
 * ```typescript
 * db.select().from(users).where(searchEndsWith(users.email, "@example.com"));
 * // WHERE email ILIKE '%@example.com'
 * ```
 */
export function searchEndsWith(column: PgColumn, term: string | undefined | null): SQL | undefined {
  if (!term) {
    return undefined;
  }
  return buildSearchCondition(column, term, { endsWith: true });
}

/**
 * Build an exact match search (case-insensitive)
 *
 * @param column - Column to search
 * @param term - Search term
 * @returns SQL condition or undefined
 *
 * @example
 * ```typescript
 * db.select().from(users).where(searchExact(users.email, "john@example.com"));
 * // WHERE email ILIKE 'john@example.com'
 * ```
 */
export function searchExact(column: PgColumn, term: string | undefined | null): SQL | undefined {
  if (!term) {
    return undefined;
  }
  return buildSearchCondition(column, term, { exactMatch: true });
}

// ============================================
// Search Field Configuration Helper
// ============================================

/**
 * Create a searchable columns configuration
 *
 * Defines which columns should be searched when performing multi-column search.
 *
 * @param columns - Array of columns to include in search
 * @returns Array of searchable columns
 *
 * @example
 * ```typescript
 * const searchableUserColumns = createSearchableColumns([
 *   users.firstName,
 *   users.lastName,
 *   users.email,
 * ]);
 *
 * function searchUsers(term: string) {
 *   const where = buildMultiColumnSearch(searchableUserColumns, term);
 *   return db.select().from(users).where(where);
 * }
 * ```
 */
export function createSearchableColumns(columns: PgColumn[]): PgColumn[] {
  return columns;
}
