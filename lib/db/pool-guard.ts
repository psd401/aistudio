/**
 * Pool guard: bounded waits + wedged-pool detection for the postgres.js pool.
 *
 * Motivation (2026-07-26 dev-server wedge): a dev server entered a terminal
 * state where every DB-bound request hung forever — the postgres.js pool had
 * zero live sockets while its queue never drained, and nothing in the stack
 * (pool, driver, route handlers) applied a timeout, so leaked capacity was
 * never reclaimed and the process could not self-heal. Client-side aborts
 * (Playwright's 60s timeout) do not propagate into route handlers, so every
 * aborted request left a zombie awaiting the pool forever.
 *
 * This module provides:
 * - `withPoolDeadline()`: races DB work against a deadline so a request can
 *   never await the pool forever. The deadline is deliberately generous —
 *   it fires only when work never even reached a connection (queue
 *   starvation), because `statement_timeout` (see drizzle-client) bounds
 *   work that DID get a connection.
 * - A wedge detector: consecutive deadline failures with no success in
 *   between mean the pool itself is stuck (not one slow query), and the
 *   registered callback rebuilds the pool to restore capacity.
 *
 * `DbPoolDeadlineError` is intentionally NON-retryable under
 * rds-error-handler's classification: its name is not in the retryable list
 * and its message avoids every retryable pattern (/timeout/i, /connection/i,
 * /network/i, …). Retrying would re-queue into the same starved pool and
 * multiply the hang.
 */

export class DbPoolDeadlineError extends Error {
  constructor(context: string, deadlineMs: number) {
    // Wording matters: must not match rds-error-handler's retryable message
    // patterns (no "timeout", "connection", "network", …) or the caller would
    // burn maxRetries × deadline before failing.
    super(
      `database pool deadline exceeded after ${deadlineMs}ms awaiting capacity (${context})`
    )
    this.name = "DbPoolDeadlineError"
  }
}

const DEFAULT_QUERY_DEADLINE_MS = 90_000
const DEFAULT_TX_DEADLINE_MS = 300_000
/** Consecutive deadline failures (no success in between) that declare the pool wedged. */
const WEDGE_THRESHOLD = 3

function envNonNegativeInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback
}

/**
 * Resolve the deadline for a unit of DB work. `0` disables the deadline.
 * Transactions get a higher default: they hold a connection across many
 * statements plus application logic, so a single-query bound would misfire.
 */
export function resolvePoolDeadlineMs(kind: "query" | "transaction"): number {
  return kind === "transaction"
    ? envNonNegativeInt("DB_TX_DEADLINE_MS", DEFAULT_TX_DEADLINE_MS)
    : envNonNegativeInt("DB_QUERY_DEADLINE_MS", DEFAULT_QUERY_DEADLINE_MS)
}

let consecutiveDeadlineFailures = 0

/** Test hook: reset the wedge detector between test cases. */
export function resetPoolGuardState(): void {
  consecutiveDeadlineFailures = 0
}

/** Current consecutive-deadline-failure count (monitoring/tests). */
export function getConsecutiveDeadlineFailures(): number {
  return consecutiveDeadlineFailures
}

export interface PoolDeadlineOptions {
  /** Deadline in ms; 0 disables the race entirely. */
  deadlineMs: number
  /** Operation label for the error message. */
  context: string
  /**
   * Invoked when consecutive deadline failures reach the wedge threshold —
   * the pool is stuck, not merely slow. The callback owns recovery (pool
   * rebuild) and any rate limiting of it.
   */
  onWedged: (consecutiveFailures: number) => void
}

/**
 * Race DB work against a deadline so no request can await the pool forever.
 *
 * On deadline: the work promise is detached (its eventual settlement is
 * swallowed — the underlying query keeps running until statement_timeout or
 * a pool rebuild rejects it) and a non-retryable DbPoolDeadlineError is
 * thrown. A success resets the wedge detector.
 */
export async function withPoolDeadline<T>(
  work: Promise<T> | PromiseLike<T>,
  options: PoolDeadlineOptions
): Promise<T> {
  const { deadlineMs, context, onWedged } = options
  // Drizzle query builders are LAZY thenables that re-execute on every .then()
  // subscription. Normalize to a real promise so the race and the
  // detached-rejection guard below share ONE subscription — subscribing twice
  // would run the query twice.
  const settled = Promise.resolve(work)
  if (deadlineMs <= 0) {
    const result = await settled
    consecutiveDeadlineFailures = 0
    return result
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new DbPoolDeadlineError(context, deadlineMs))
    }, deadlineMs)
    // Do not hold the process open for a watchdog timer.
    if (typeof timer === "object" && "unref" in timer) timer.unref()
  })

  try {
    const result = await Promise.race([settled, deadline])
    consecutiveDeadlineFailures = 0
    return result
  } catch (error) {
    if (error instanceof DbPoolDeadlineError) {
      consecutiveDeadlineFailures++
      // The abandoned work promise may reject much later (statement_timeout,
      // pool rebuild); swallow it so it cannot surface as an unhandled
      // rejection.
      settled.catch(() => {})
      if (consecutiveDeadlineFailures >= WEDGE_THRESHOLD) {
        const failures = consecutiveDeadlineFailures
        consecutiveDeadlineFailures = 0
        onWedged(failures)
      }
    } else {
      // A real database error means the work reached a connection — the pool
      // is alive, so it is not wedged. Only uninterrupted runs of deadline
      // failures count toward the wedge threshold.
      consecutiveDeadlineFailures = 0
    }
    throw error
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
