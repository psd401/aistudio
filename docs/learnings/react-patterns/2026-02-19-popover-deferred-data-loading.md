---
title: Defer popover data loading to first open, not mount
category: react-patterns
tags: [popover, lazy-loading, server-action, performance, oauth]
severity: medium
date: 2026-02-19
source: /review-pr
applicable_to: project
---

## What Happened

PR #793 code review revealed that a connector popover was loading OAuth server action data on component mount instead of waiting for the user to open it. This fired unnecessary backend queries on every page visit, even when the popover was never opened.

## Root Cause

The popover used `useEffect` with no dependency that would defer execution. Data loading happened immediately rather than lazily on first open event. Similar to lazy-loading patterns for modals, but often overlooked because the performance impact is less obvious.

## Solution

Use a `useRef` flag to track whether data has been loaded. Call the server action only when the `openChange` popover event fires AND the data hasn't been loaded yet:

```typescript
const [open, setOpen] = useState(false)
const loadedRef = useRef(false)
const [data, setData] = useState<ConnectorData | null>(null)
const [isLoading, setIsLoading] = useState(false)

const handleOpenChange = async (isOpen: boolean) => {
  setOpen(isOpen)

  // Load data only on first open
  if (isOpen && !loadedRef.current) {
    setIsLoading(true)  // Load state setter: call directly, NOT in startTransition
    try {
      loadedRef.current = true  // Mark as loaded before calling action
      const result = await getConnectorData(params)
      setData(result)
    } catch (error) {
      showErrorToast(error.message)  // Show toast on failure
      loadedRef.current = false  // Reset so retry on next open
    } finally {
      setIsLoading(false)
    }
  }
}

return (
  <Popover open={open} onOpenChange={handleOpenChange}>
    {/* popover content */}
  </Popover>
)
```

## Prevention

- **Deferred loading checklist**:
  - Server action data called from event handler (`onOpenChange`, `onClick`), not `useEffect`
  - Use `useRef` to track load state (survives re-renders, doesn't trigger re-render)
  - Set `loadedRef.current = true` BEFORE calling the action (prevents duplicate requests on rapid opens)
  - Reset `loadedRef` on error if retry is needed
  - **Never wrap loading state setters in `startTransition`** — mark updates non-urgent, delays spinner visibility
  - Always show error toast on user-initiated async failures (no silent catch blocks)

## Related Patterns

- **startTransition misuse**: Use for state updates that can safely deprioritize (e.g., search results). Never for UX feedback (spinner, button disabled state). Call `setIsLoading(true)` directly.
- **Stale closure in async callbacks**: If a callback awaits a long operation, use refs instead of captured state to avoid intermediate changes being overwritten.
- **OAuth reconnect UX**: After successful reconnect, auto-enable the feature (user intent signal).
