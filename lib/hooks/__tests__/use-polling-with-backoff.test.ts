/**
 * Unit tests for usePollingWithBackoff hook
 * Covers: backoff math, failure tracking, concurrent-call guard,
 * cancellation, isLoadingRef reset on cleanup, enabled transition semantics.
 */

import { renderHook, act } from '@testing-library/react'
import { usePollingWithBackoff } from '../use-polling-with-backoff'

// Mock Math.random to 0.5 so jitter = 0.5 * 0.2 + 0.9 = 1.0 (no jitter).
// This makes all interval calculations exact, avoiding flaky timer tests.
const mockRandom = jest.spyOn(Math, 'random').mockReturnValue(0.5)

describe('usePollingWithBackoff', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    mockRandom.mockReturnValue(0.5)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  afterAll(() => {
    mockRandom.mockRestore()
  })

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function makeFn(impl: () => Promise<void> = () => Promise.resolve()) {
    return jest.fn(impl)
  }

  // ---------------------------------------------------------------------------
  // Basic scheduling
  // ---------------------------------------------------------------------------

  it('calls fn after baseInterval', async () => {
    const fn = makeFn()
    renderHook(() => usePollingWithBackoff(fn, { baseInterval: 1000, enabled: true }))

    expect(fn).not.toHaveBeenCalled()

    await act(async () => {
      jest.advanceTimersByTime(1001)
    })

    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('does not call fn when enabled is false', async () => {
    const fn = makeFn()
    renderHook(() => usePollingWithBackoff(fn, { baseInterval: 1000, enabled: false }))

    await act(async () => {
      jest.advanceTimersByTime(5000)
    })

    expect(fn).not.toHaveBeenCalled()
  })

  it('does not call fn when baseInterval is 0', async () => {
    const fn = makeFn()
    renderHook(() => usePollingWithBackoff(fn, { baseInterval: 0, enabled: true }))

    await act(async () => {
      jest.advanceTimersByTime(5000)
    })

    expect(fn).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------------------
  // Backoff on failure (jitter = 1.0x due to Math.random mock)
  // ---------------------------------------------------------------------------

  it('doubles interval after each failure and caps at maxMultiplier', async () => {
    let callCount = 0
    const fn = makeFn(async () => {
      callCount++
      throw new Error('fail')
    })

    renderHook(() =>
      usePollingWithBackoff(fn, { baseInterval: 1000, maxMultiplier: 4, enabled: true })
    )

    // Failure 1 fires at 1000ms; next interval = min(2^1,4) * 1000 = 2000ms
    await act(async () => { jest.advanceTimersByTime(1001) })
    expect(callCount).toBe(1)

    // Should NOT fire at 1001ms into the 2000ms window
    await act(async () => { jest.advanceTimersByTime(999) })
    expect(callCount).toBe(1)

    // Failure 2 fires at 2000ms; next interval = min(2^2,4) * 1000 = 4000ms
    await act(async () => { jest.advanceTimersByTime(1001) })
    expect(callCount).toBe(2)

    // Should NOT fire at 3999ms into the 4000ms window
    await act(async () => { jest.advanceTimersByTime(3998) })
    expect(callCount).toBe(2)

    // Failure 3 fires at 4000ms; next interval = min(2^3,4) * 1000 = 4000ms (capped)
    await act(async () => { jest.advanceTimersByTime(2) })
    expect(callCount).toBe(3)

    // Interval remains capped at 4000ms
    await act(async () => { jest.advanceTimersByTime(3999) })
    expect(callCount).toBe(3)

    await act(async () => { jest.advanceTimersByTime(2) })
    expect(callCount).toBe(4)
  })

  it('resets backoff to base interval after success', async () => {
    let callCount = 0
    let failNext = true
    const fn = makeFn(async () => {
      callCount++
      if (failNext) {
        failNext = false
        throw new Error('fail')
      }
    })

    renderHook(() =>
      usePollingWithBackoff(fn, { baseInterval: 1000, maxMultiplier: 8, enabled: true })
    )

    // Failure at 1000ms; next interval = 2000ms
    await act(async () => { jest.advanceTimersByTime(1001) })
    expect(callCount).toBe(1)

    // Success at 2000ms; next interval resets to 1000ms
    await act(async () => { jest.advanceTimersByTime(2001) })
    expect(callCount).toBe(2)

    // Should fire at base interval, not 4000ms
    await act(async () => { jest.advanceTimersByTime(1001) })
    expect(callCount).toBe(3)
  })

  // ---------------------------------------------------------------------------
  // resetFailures — resets counter so the NEXT scheduled interval uses base
  // ---------------------------------------------------------------------------

  it('resetFailures clears the failure counter so subsequent intervals use base', async () => {
    let callCount = 0
    const fn = makeFn(async () => {
      callCount++
      if (callCount <= 2) throw new Error('fail')
    })

    const { result } = renderHook(() =>
      usePollingWithBackoff(fn, { baseInterval: 1000, maxMultiplier: 8, enabled: true })
    )

    // Failure 1 at 1000ms; next interval = 2000ms
    await act(async () => { jest.advanceTimersByTime(1001) })
    expect(callCount).toBe(1)

    // Reset before the 2000ms timeout fires
    act(() => { result.current.resetFailures() })

    // The already-scheduled 2000ms timeout still fires at 2000ms (resetFailures
    // only affects the counter; it does not reschedule the pending timeout)
    await act(async () => { jest.advanceTimersByTime(2001) })
    expect(callCount).toBe(2) // failure 2

    // Now the failure counter is at 1 again (incremented from 0 after reset).
    // Next interval = 2^1 * 1000 = 2000ms... but we call resetFailures again
    act(() => { result.current.resetFailures() })

    // Call 3 succeeds. Next interval = 1000ms (counter is 0 after reset + success)
    await act(async () => { jest.advanceTimersByTime(2001) })
    expect(callCount).toBe(3) // succeeded

    // Next call should be at base interval (1000ms)
    await act(async () => { jest.advanceTimersByTime(1001) })
    expect(callCount).toBe(4)
  })

  // ---------------------------------------------------------------------------
  // Concurrent-call guard (isLoadingRef)
  // ---------------------------------------------------------------------------

  it('skips a polling cycle when previous fetch is still in flight', async () => {
    let resolveInFlight!: () => void
    let callCount = 0

    const fn = makeFn(
      () =>
        new Promise<void>((resolve) => {
          callCount++
          resolveInFlight = resolve
        })
    )

    renderHook(() => usePollingWithBackoff(fn, { baseInterval: 1000, enabled: true }))

    // First call fires at 1000ms — does not resolve (simulating slow network)
    await act(async () => { jest.advanceTimersByTime(1001) })
    expect(callCount).toBe(1)

    // Second timer fires at 2000ms — in-flight guard should skip it
    await act(async () => { jest.advanceTimersByTime(1001) })
    expect(callCount).toBe(1) // Still only one call

    // Resolve the first call — scheduleNext fires, sets up the next timeout
    await act(async () => { resolveInFlight() })

    // Next call fires after another base interval
    await act(async () => { jest.advanceTimersByTime(1001) })
    expect(callCount).toBe(2)
  })

  // ---------------------------------------------------------------------------
  // Cancellation on unmount
  // ---------------------------------------------------------------------------

  it('stops scheduling after unmount', async () => {
    const fn = makeFn()
    const { unmount } = renderHook(() =>
      usePollingWithBackoff(fn, { baseInterval: 1000, enabled: true })
    )

    await act(async () => { jest.advanceTimersByTime(1001) })
    expect(fn).toHaveBeenCalledTimes(1)

    unmount()

    await act(async () => { jest.advanceTimersByTime(10000) })
    expect(fn).toHaveBeenCalledTimes(1) // No additional calls after unmount
  })

  it('resets isLoadingRef to false on cleanup so next mount polls immediately', async () => {
    let resolveInFlight!: () => void
    let callCount = 0

    const fn = makeFn(
      () =>
        new Promise<void>((resolve) => {
          callCount++
          resolveInFlight = resolve
        })
    )

    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        usePollingWithBackoff(fn, { baseInterval: 1000, enabled }),
      { initialProps: { enabled: true } }
    )

    // Trigger first call — leave in-flight
    await act(async () => { jest.advanceTimersByTime(1001) })
    expect(callCount).toBe(1)

    // Disable polling while fetch is still in-flight — cleanup runs
    rerender({ enabled: false })

    // Re-enable — isLoadingRef must be false so the first cycle fires
    rerender({ enabled: true })

    await act(async () => { jest.advanceTimersByTime(1001) })
    expect(callCount).toBe(2) // Would stay at 1 if isLoadingRef wasn't reset on cleanup

    // Settle the still-pending first promise
    await act(async () => { resolveInFlight() })
  })

  // ---------------------------------------------------------------------------
  // enabled transition semantics
  // ---------------------------------------------------------------------------

  it('resets failures only on false→true transition, not on fn ref change', async () => {
    let callCount = 0
    const failFn = jest.fn(async () => {
      callCount++
      throw new Error('fail')
    })

    const { rerender } = renderHook(
      ({ fn }: { fn: () => Promise<void> }) =>
        usePollingWithBackoff(fn, { baseInterval: 1000, enabled: true }),
      { initialProps: { fn: failFn } }
    )

    // Failure 1 at 1000ms — next interval = 2000ms
    await act(async () => { jest.advanceTimersByTime(1001) })
    expect(callCount).toBe(1)

    // Failure 2 at 2000ms — next interval = 4000ms
    await act(async () => { jest.advanceTimersByTime(2001) })
    expect(callCount).toBe(2)

    // Change fn reference while enabled stays true — backoff must NOT reset
    const newFn = jest.fn(async () => {
      callCount++
      throw new Error('fail')
    })
    rerender({ fn: newFn })

    // If backoff was incorrectly reset, next call would be at 1000ms
    await act(async () => { jest.advanceTimersByTime(1001) })
    expect(callCount).toBe(2) // No new call yet — 4000ms backoff preserved

    await act(async () => { jest.advanceTimersByTime(3000) })
    expect(callCount).toBe(3) // Fires at ~4000ms
  })

  it('resets failures when enabled goes false then true', async () => {
    let callCount = 0
    const fn = makeFn(async () => {
      callCount++
      throw new Error('fail')
    })

    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        usePollingWithBackoff(fn, { baseInterval: 1000, enabled }),
      { initialProps: { enabled: true } }
    )

    // Failure 1 at 1000ms — next interval = 2000ms
    await act(async () => { jest.advanceTimersByTime(1001) })
    expect(callCount).toBe(1)

    // Failure 2 at 2000ms — next interval = 4000ms
    await act(async () => { jest.advanceTimersByTime(2001) })
    expect(callCount).toBe(2)

    // Disable then re-enable — failures should reset
    rerender({ enabled: false })
    rerender({ enabled: true })

    // Should fire at base interval (1000ms), not 4000ms
    await act(async () => { jest.advanceTimersByTime(1001) })
    expect(callCount).toBe(3)
  })
})
