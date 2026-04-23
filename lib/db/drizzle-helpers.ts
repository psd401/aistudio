/**
 * Drizzle ORM helper utilities for common SQL patterns.
 *
 * Centralizes patterns that repeat across server actions to avoid
 * duplicating logic in every action file.
 */

import { sql, type SQL, type Column } from "drizzle-orm"

/**
 * Wrap a timestamp column with `to_json()::text` for safe ISO-8601
 * serialization across browsers. Drizzle's default `::text` cast uses
 * PostgreSQL's `timestamp_out` which produces space-separated formats
 * that some browsers/date parsers reject.
 *
 * Accepts both Drizzle `Column` references (e.g. `table.createdAt`)
 * and raw `SQL` expressions (e.g. `sql\`MAX(col)\``).
 *
 * Usage in a Drizzle select:
 * ```ts
 * .select({ createdAt: pgTimestampAsText(table.createdAt) })
 * .select({ latest: pgTimestampAsText(sql`MAX(${table.createdAt})`) })
 * ```
 */
export function pgTimestampAsText(column: Column | SQL): SQL<string> {
  return sql<string>`to_json(${column})::text`
}

/**
 * Strip the JSON string quotes that `to_json()::text` adds around
 * timestamp values. The output of `to_json(timestamp)::text` is
 * `"2024-01-15T12:00:00+00:00"` (with surrounding double-quotes).
 *
 * Usage in a row mapper:
 * ```ts
 * createdAt: stripJsonQuotes(r.createdAt)
 * ```
 */
export function stripJsonQuotes(value: string | null | undefined): string | null {
  if (!value) return null
  return value.replace(/^"|"$/g, "")
}
