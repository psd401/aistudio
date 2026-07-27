/**
 * Unit tests for the pool guard (bounded DB waits + wedged-pool detection).
 *
 * Motivated by the 2026-07-26 dev-server wedge: requests queued in the
 * postgres.js pool forever with zero live connections, and nothing in the
 * stack applied a timeout, so the process never self-healed.
 *
 * @see lib/db/pool-guard.ts
 */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'

// Mock the logger before importing rds-error-handler (same pattern as
// rds-error-handler.test.ts).
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
  generateRequestId: () => 'test-request-id',
  startTimer: () => () => 100,
}))

import {
  DbPoolDeadlineError,
  resolvePoolDeadlineMs,
  resetPoolGuardState,
  getConsecutiveDeadlineFailures,
  withPoolDeadline,
} from '@/lib/db/pool-guard'
import { isRetryableError } from '@/lib/db/rds-error-handler'

const never = () => new Promise<never>(() => {})

describe('pool-guard', () => {
  beforeEach(() => {
    resetPoolGuardState()
  })

  describe('withPoolDeadline', () => {
    it('returns the work result when it settles before the deadline', async () => {
      const onWedged = jest.fn()
      const result = await withPoolDeadline(Promise.resolve(42), {
        deadlineMs: 1000,
        context: 'fast',
        onWedged,
      })
      expect(result).toBe(42)
      expect(onWedged).not.toHaveBeenCalled()
      expect(getConsecutiveDeadlineFailures()).toBe(0)
    })

    it('rejects with DbPoolDeadlineError when the deadline fires first', async () => {
      const onWedged = jest.fn()
      await expect(
        withPoolDeadline(never(), { deadlineMs: 10, context: 'stuck', onWedged })
      ).rejects.toBeInstanceOf(DbPoolDeadlineError)
      expect(getConsecutiveDeadlineFailures()).toBe(1)
      expect(onWedged).not.toHaveBeenCalled()
    })

    it('produces a NON-retryable error under rds-error-handler classification', async () => {
      const error = await withPoolDeadline(never(), {
        deadlineMs: 10,
        context: 'stuck',
        onWedged: jest.fn(),
      }).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(DbPoolDeadlineError)
      // If this ever becomes retryable, callers burn maxRetries × deadline
      // re-queueing into the same starved pool before failing.
      expect(isRetryableError(error)).toBe(false)
    })

    it('propagates work rejections unchanged and resets the wedge counter', async () => {
      const onWedged = jest.fn()
      // Two deadline failures first…
      for (let i = 0; i < 2; i++) {
        await expect(
          withPoolDeadline(never(), { deadlineMs: 10, context: 'stuck', onWedged })
        ).rejects.toBeInstanceOf(DbPoolDeadlineError)
      }
      expect(getConsecutiveDeadlineFailures()).toBe(2)
      // …then a REAL database error (work reached a connection → pool alive).
      const dbError = Object.assign(new Error('relation does not exist'), {
        name: 'PostgresError',
      })
      await expect(
        withPoolDeadline(Promise.reject(dbError), {
          deadlineMs: 1000,
          context: 'real-error',
          onWedged,
        })
      ).rejects.toBe(dbError)
      expect(getConsecutiveDeadlineFailures()).toBe(0)
      expect(onWedged).not.toHaveBeenCalled()
    })

    it('invokes onWedged after 3 consecutive deadline failures, then resets', async () => {
      const onWedged = jest.fn()
      for (let i = 0; i < 3; i++) {
        await expect(
          withPoolDeadline(never(), { deadlineMs: 10, context: 'stuck', onWedged })
        ).rejects.toBeInstanceOf(DbPoolDeadlineError)
      }
      expect(onWedged).toHaveBeenCalledTimes(1)
      expect(onWedged).toHaveBeenCalledWith(3)
      expect(getConsecutiveDeadlineFailures()).toBe(0)
    })

    it('disables the deadline entirely when deadlineMs is 0', async () => {
      const onWedged = jest.fn()
      const slow = new Promise<string>((resolve) => setTimeout(() => resolve('done'), 50))
      const result = await withPoolDeadline(slow, {
        deadlineMs: 0,
        context: 'no-deadline',
        onWedged,
      })
      expect(result).toBe('done')
      expect(onWedged).not.toHaveBeenCalled()
    })

    it('subscribes to lazy thenables exactly once (drizzle re-execution guard)', async () => {
      // Drizzle query builders execute the query on EVERY .then() call. The
      // guard must not subscribe twice (race + detached-rejection swallow) or
      // the query runs twice.
      let subscriptions = 0
      const lazyThenable: PromiseLike<never> = {
        then(onfulfilled, onrejected) {
          subscriptions++
          return never().then(onfulfilled, onrejected)
        },
      }
      await expect(
        withPoolDeadline(lazyThenable, {
          deadlineMs: 10,
          context: 'lazy',
          onWedged: jest.fn(),
        })
      ).rejects.toBeInstanceOf(DbPoolDeadlineError)
      expect(subscriptions).toBe(1)
    })
  })

  describe('resolvePoolDeadlineMs', () => {
    const savedQuery = process.env.DB_QUERY_DEADLINE_MS
    const savedTx = process.env.DB_TX_DEADLINE_MS

    afterEach(() => {
      if (savedQuery === undefined) delete process.env.DB_QUERY_DEADLINE_MS
      else process.env.DB_QUERY_DEADLINE_MS = savedQuery
      if (savedTx === undefined) delete process.env.DB_TX_DEADLINE_MS
      else process.env.DB_TX_DEADLINE_MS = savedTx
    })

    it('defaults to 90s for queries and 300s for transactions', () => {
      delete process.env.DB_QUERY_DEADLINE_MS
      delete process.env.DB_TX_DEADLINE_MS
      expect(resolvePoolDeadlineMs('query')).toBe(90_000)
      expect(resolvePoolDeadlineMs('transaction')).toBe(300_000)
    })

    it('honors valid env overrides, including 0 (disabled)', () => {
      process.env.DB_QUERY_DEADLINE_MS = '15000'
      process.env.DB_TX_DEADLINE_MS = '0'
      expect(resolvePoolDeadlineMs('query')).toBe(15_000)
      expect(resolvePoolDeadlineMs('transaction')).toBe(0)
    })

    it('falls back to the default on invalid values', () => {
      process.env.DB_QUERY_DEADLINE_MS = 'not-a-number'
      expect(resolvePoolDeadlineMs('query')).toBe(90_000)
      process.env.DB_QUERY_DEADLINE_MS = '-5'
      expect(resolvePoolDeadlineMs('query')).toBe(90_000)
    })
  })
})
