# React Patterns Guide

Recurring patterns and pitfalls specific to this codebase. Consolidated from 13 react-patterns and 2 frontend learnings.

## Initialization Guards: Use ID-Tracking Refs

Boolean `useRef(false)` breaks when Next.js App Router reuses component instances across route changes (e.g., `/prompt-library/1` → `/prompt-library/2`).

```typescript
// FRAGILE — requires separate reset effect, creates race window
const initializedRef = useRef(false)

useEffect(() => { initializedRef.current = false }, [resourceId])
useEffect(() => {
  if (initializedRef.current) return
  initializedRef.current = true
  // ... init
}, [resourceId])

// ROBUST — single effect, no reset needed
const initializedForRef = useRef<string | null>(null)

useEffect(() => {
  if (initializedForRef.current === resourceId) return
  initializedForRef.current = resourceId
  // ... init
}, [resourceId])
```

**Smell:** If you see a reset effect paired with a boolean init ref, collapse into ID-tracking ref.

## Never Put `key` on Providers

Changing a `key` on a Provider unmounts the entire subtree. The `null → UUID` transition when a conversation is created will always trigger this.

```tsx
// WRONG — full subtree remount when conversationId changes from null
<ConnectorToolProvider key={conversationId ?? 'new'} ...>

// CORRECT — stable provider, pass ID as prop
<ConnectorToolProvider conversationId={conversationId} ...>
```

## Hooks Before All Conditional Returns

React requires all hooks called on every render in the same order. Move all `useMemo`/`useCallback`/custom hooks above the first conditional `return`.

```tsx
function Component({ toolName, ...props }) {
  const meta = useContext(ToolContext)        // hooks first
  const display = useMemo(() => ..., [meta]) // hooks first

  if (!meta) return <Fallback {...props} />  // conditional return after hooks
  return <UI displayName={display} />
}
```

## Derived State Toggles

When using `null|boolean` override state (where `null` = "follow auto-logic"), toggle must invert the **displayed** value, not the **stored** value.

```typescript
// WRONG — first click sets true (still open) instead of false (closed)
const toggle = useCallback(() => {
  setManualExpanded(prev => prev === null ? true : !prev)
}, [])

// CORRECT — inverts what user actually sees
// derivedAutoExpand must be stable (useMemo or derived from stable state) —
// otherwise the callback recreates every render, defeating the optimization.
const derivedAutoExpand = useMemo(() => items.length > 0, [items.length])
const toggle = useCallback(() => {
  setManualExpanded(prev => !(prev !== null ? prev : derivedAutoExpand))
}, [derivedAutoExpand])  // deps array shown explicitly — derivedAutoExpand must be memoized
```

## Deferred Data Loading for Popovers

Load data on first open, not on mount. Prevents unnecessary backend queries on every page visit.

> **Note on boolean `useRef` here:** `loadedRef = useRef(false)` is appropriate for single-mounted-instance patterns like popovers where the component doesn't serve multiple parameterized routes. Use ID-tracking refs (see above) only when the same component instance is reused across route changes.

```typescript
const loadedRef = useRef(false)

const handleOpenChange = async (isOpen: boolean) => {
  setOpen(isOpen)
  if (isOpen && !loadedRef.current) {
    setIsLoading(true)  // NOT in startTransition
    try {
      loadedRef.current = true
      const result = await fetchData()
      setData(result)
    } catch (error) {
      showErrorToast(error instanceof Error ? error.message : 'Failed to load data')
      loadedRef.current = false  // reset for retry
    } finally {
      setIsLoading(false)
    }
  }
}
```

**Rules:**
- In **event handlers**: call `setIsLoading(true)` directly — `startTransition` delays the spinner
- In **`useEffect` bodies**: if the React Compiler flags synchronous `setState`, wrap it in `startTransition`
- Set `loadedRef.current = true` **before** the async call (prevents duplicate requests)
- Reset on error if retry is desired

## NextAuth SessionProvider

```tsx
// Required config — prevents silent remounts on tab switch
<SessionProvider refetchOnWindowFocus={false} refetchInterval={5 * 60}>
```

- `refetchOnWindowFocus={false}` — prevents new session object reference on every tab switch
- `refetchInterval={5 * 60}` — compensates by checking session validity every 5 minutes
- In `useEffect` deps: use `status` (primitive string), never `session` (object reference)

*See also: `docs/guides/silent-failure-patterns.md` — NextAuth SessionProvider section for the root cause explanation.*

## Form Extraction Checklist

When refactoring inline form fields into extracted components:

- [ ] `maxLength`, `minLength`, `required` carried to new component props
- [ ] `aria-required`, `aria-invalid`, `aria-describedby` carried over
- [ ] Character counters and `onBlur` validation triggers preserved
- [ ] Don't wrap `useState` setters in `useCallback` — React guarantees they're referentially stable across renders, so wrapping is redundant

## Polling Timer Churn: Track `isLoading` via `useRef`

`isLoading` state inside a polling `useEffect` dep array causes the effect to tear down and re-run on every fetch cycle (false → true → false), collapsing the intended backoff interval to near-zero.

```typescript
// WRONG — isLoading state in deps causes timer to reset on every toggle
const [isLoading, setIsLoading] = useState(false)
useEffect(() => {
  const poll = async () => {
    setIsLoading(true)
    await fetchData()
    setIsLoading(false)
    timer = setTimeout(poll, interval)
  }
  poll()
  return () => clearTimeout(timer)
}, [isLoading, interval]) // isLoading change triggers teardown/recreate

// CORRECT — ref mutation doesn't trigger the effect
const isLoadingRef = useRef(false)
useEffect(() => {
  let timer: ReturnType<typeof setTimeout>
  const poll = async () => {
    if (isLoadingRef.current) return
    isLoadingRef.current = true
    try {
      await fetchData()
    } finally {
      isLoadingRef.current = false
      timer = setTimeout(poll, currentInterval)
    }
  }
  poll()
  return () => clearTimeout(timer)
}, [status, currentInterval]) // status is a primitive (useSession().status)
```

**Rules:**
- Audit every `useEffect` dep: if it changes inside the effect's async callback, convert to `useRef`
- Prefer `useSession().status` (primitive string) over `session` (object) for session-gated effects
- Use `setTimeout` chains for dynamic intervals; `setInterval` only when interval is fixed

## Polling Cleanup: Pair `clearTimeout` with a `cancelled` Flag

`clearTimeout` only cancels a timer that hasn't fired yet — it does not stop a `.then()` continuation already in the microtask queue. Without a `cancelled` guard, the loop continues after `useEffect` cleanup.

```typescript
// WRONG — clearTimeout cannot stop a .then() already queued
useEffect(() => {
  let timer: ReturnType<typeof setTimeout>
  const scheduleNext = () => { timer = setTimeout(poll, interval) }
  const poll = () => { fetchData().then(scheduleNext) } // leaks after cleanup
  poll()
  return () => clearTimeout(timer) // too late if .then() already in flight
}, [interval])

// CORRECT — cancelled flag stops the chain regardless of timing
useEffect(() => {
  let cancelled = false
  let timer: ReturnType<typeof setTimeout>

  const scheduleNext = () => {
    if (cancelled) return
    timer = setTimeout(poll, interval)
  }
  const poll = () => {
    fetchData()
      .then(() => { if (!cancelled) scheduleNext() })
      .catch((err) => {
        // Always handle rejections — unhandled promise rejections in useEffect
        // closures are not caught by React error boundaries.
        log.warn('poll failed', err)
        if (!cancelled) scheduleNext() // retry or stop based on your error strategy
      })
  }

  poll()
  return () => {
    cancelled = true
    clearTimeout(timer)
  }
}, [interval])
```

**Rules:**
- Any `.then()` or `.finally()` inside a polling `useEffect` must guard on a `cancelled` flag
- Always pair `clearTimeout` with a `cancelled = true` assignment in cleanup
- **Always add a `.catch()`** — unhandled promise rejections inside `useEffect` closures bypass React error boundaries and can produce silent polling failures
- Handle errors inside `fetchData` or at the `.catch()` on the polling chain; do not let rejections go unhandled

*See also: Polling Timer Churn section above — `cancelled` flag and `useRef` for `isLoading` are complementary; both are needed.*

## Callback Ref Timing: Assign in Render Body, Not `useEffect`

Updating a callback ref inside `useEffect` introduces a timing gap: between render and effect flush, queued timers or microtask continuations can fire and call the stale function from the previous render.

```typescript
// WRONG — gap between render and effect flush; stale function can be called
useEffect(() => {
  onFailureRef.current = onFailure
}, [onFailure])

// CORRECT — ref is current before any timer or microtask can fire
onFailureRef.current = onFailure  // synchronous in render body
```

React docs explicitly recommend this "event handler ref" pattern for stabilizing callback props. The ref object is stable; only `.current` changes.

**Smell:** A `useEffect` whose only body is `someRef.current = someValue` should be a render-body assignment instead.

## Hook Catch/Microtask Ordering: Caller Sees Stale Ref

When a hook's `.catch()` mutates a ref and re-throws, the caller's `catch` block runs in the **same microtask tick as the re-throw** — before the hook's internal `.catch()` executes. The ref is stale-by-1 at the point the caller reads it.

```typescript
// Inside hook (simplified)
const poll = () =>
  fetchData().catch((err) => {
    consecutiveFailuresRef.current += 1  // not yet incremented when caller catch fires
    throw err
  })

// Caller
poll().catch(() => {
  // consecutiveFailuresRef.current here is STILL the pre-increment value
  log.warn('failures', consecutiveFailuresRef.current)     // wrong
  log.warn('failures', consecutiveFailuresRef.current + 1) // correct
})
```

**Better solution:** expose an `onFailure(count)` callback on the hook (see Hook Circular Dependency section below) — the hook calls it with the accurate post-increment value, eliminating the `+1` arithmetic.

**Rule:** Any ref mutated inside a `.catch()` that also re-throws: assume callers read the pre-mutation value.

## Hook Circular Dependency: Use `onFailure` Callback, Not a Getter

A hook that returns an internal-state accessor (e.g., `getConsecutiveFailures()`) creates a circular dependency when the caller also supplies the hook's `fn` argument that needs to read that state — `fn` must reference the getter, but the getter doesn't exist until after the hook call that receives `fn`.

```typescript
// WRONG — circular forward-reference, requires ESLint suppression
const { getConsecutiveFailures } = usePollingWithBackoff({ fn: fetchResults })
// fetchResults needs getConsecutiveFailures, but it's declared after the hook call

// CORRECT — hook calls onFailure with accurate post-increment value
usePollingWithBackoff({
  fn: fetchResults,
  onFailure: (consecutiveFailures) => {
    if (consecutiveFailures >= THRESHOLD) reconnect()
  },
})
```

The circular dependency disappears entirely — the caller never holds a stale reference to internal state.

**Rules:**
- When a hook caller needs to react to internal hook state inside the `fn` it passes in, expose an event callback (`onFailure`, `onRetry`) not a state accessor
- Return getters only when the caller needs to read state outside the `fn` lifecycle (e.g., in a separate event handler)
- Callbacks receive accurate post-event state; getters require callers to reason about microtask ordering and staleness

## assistant-ui Adapter Ref Stability

Passing an unstable history adapter to `useChatRuntime` causes the runtime to detect a changed adapter and re-call `load()`, producing duplicate messages during streaming.

```typescript
// WRONG — new adapter instance on every render when conversationId changes
const historyAdapter = useMemo(
  () => createHistoryAdapter(conversationId),
  [conversationId] // null → UUID transition creates new adapter mid-stream
)

// CORRECT — stable adapter instance; reads latest value via ref getter
const conversationIdRef = useRef(conversationId)
conversationIdRef.current = conversationId // synchronous render-body assignment

const historyAdapter = useMemo(
  () => createHistoryAdapter(() => conversationIdRef.current),
  [] // empty deps — instance never recreated
  // The empty array is intentional: the ref object is stable across renders;
  // conversationIdRef.current always returns the latest value via the getter.
)
```

**Rules:**
- Any object passed to `useChatRuntime` (adapter, runtime config) must have a stable reference across renders
- When the adapter needs a value that changes over time, pass a ref-based getter, not the value directly
- Treat `useChatRuntime` adapter props like `useEffect` cleanup functions — new reference = runtime teardown and re-initialization
- The empty `useMemo` dep array here is correct, not an `exhaustive-deps` oversight — the getter function captures the ref object (stable), not the ref's value

---

*Source: `docs/learnings/react-patterns/` and `docs/learnings/frontend/` (2026-02-19 through 2026-04-08)*
