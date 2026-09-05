/**
 * Surface the real database error behind a Drizzle `DrizzleQueryError`.
 *
 * Drizzle wraps every driver failure in an error whose `message` is only
 * `Failed query: insert into "…"` plus the SQL text. The postgres.js error that
 * actually says WHY — the SQLSTATE code, the violated constraint, the detail
 * line — hangs off `.cause` and is dropped by any handler that logs
 * `error.message` alone.
 *
 * That cost real time during a 2026-09-05 production workspace outage: the
 * broker's logs showed only `Failed query: insert into
 * "workspace_upload_reservations"`, so the actual cause (a unique violation on
 * the partial index `uq_workspace_upload_target_active`) had to be inferred by
 * reading the schema rather than read off a log line.
 *
 * Returns `undefined` when there is no cause worth logging, so callers can
 * spread it into a log payload unconditionally.
 */

/** Fields postgres.js sets on its error objects (a superset of `pg`'s). */
interface DriverErrorShape {
  message?: unknown
  code?: unknown
  constraint_name?: unknown
  constraint?: unknown
  table_name?: unknown
  table?: unknown
  detail?: unknown
}

const MAX_CAUSE_DEPTH = 4
const MAX_FIELD_LENGTH = 500

function boundedString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined
  return value.slice(0, MAX_FIELD_LENGTH)
}

export interface QueryErrorCause {
  causeMessage?: string
  causeCode?: string
  causeConstraint?: string
  causeTable?: string
  causeDetail?: string
}

/**
 * Walk the `cause` chain and describe the deepest link that carries driver
 * detail. Bounded in depth so a self-referential chain cannot spin, and in
 * field length so a driver detail line cannot flood the log.
 */
export function describeQueryErrorCause(
  error: unknown,
): QueryErrorCause | undefined {
  let current: unknown = (error as { cause?: unknown } | null)?.cause
  let described: QueryErrorCause | undefined
  const seen = new Set<unknown>()
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!current || typeof current !== "object" || seen.has(current)) break
    seen.add(current)
    const shape = current as DriverErrorShape
    const candidate: QueryErrorCause = {}
    const message = boundedString(shape.message)
    const code = boundedString(shape.code)
    const constraint =
      boundedString(shape.constraint_name) ?? boundedString(shape.constraint)
    const table = boundedString(shape.table_name) ?? boundedString(shape.table)
    const detail = boundedString(shape.detail)
    if (message) candidate.causeMessage = message
    if (code) candidate.causeCode = code
    if (constraint) candidate.causeConstraint = constraint
    if (table) candidate.causeTable = table
    if (detail) candidate.causeDetail = detail
    if (Object.keys(candidate).length > 0) described = candidate
    current = (current as { cause?: unknown }).cause
  }
  return described
}
