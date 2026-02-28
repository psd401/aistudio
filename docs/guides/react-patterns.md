# React Patterns Guide

Recurring patterns and pitfalls specific to this codebase. Consolidated from 7 react-patterns and 2 frontend learnings.

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
- `setIsLoading(true)` called directly — never inside `startTransition` (delays spinner)
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

---

*Source: `docs/learnings/react-patterns/` and `docs/learnings/frontend/` (2026-02-19 through 2026-02-26)*
