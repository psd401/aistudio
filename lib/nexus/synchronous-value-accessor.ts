export interface SynchronousValueAccessor<T> {
  get: () => T
  set: (nextValue: T) => void
}

/**
 * Holds the latest value behind a stable closure.
 *
 * Nexus runtime adapters must retain object identity while still reading values
 * updated during render. A closure avoids React ref access during render and
 * preserves the synchronous update semantics required before effects run.
 */
export function createSynchronousValueAccessor<T>(
  initialValue: T
): SynchronousValueAccessor<T> {
  let value = initialValue

  return {
    get: () => value,
    set: (nextValue) => {
      value = nextValue
    },
  }
}
