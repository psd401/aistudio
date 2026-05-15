---
title: Three patterns for preventing message loss on session expiry in Nexus
category: ai-sdk
tags:
  - ai-sdk
  - customFetch
  - nextauth
  - session-expiry
  - assistant-ui
  - useRef
  - history-adapter
  - silent-failure
severity: high
date: 2026-05-15
source: auto — /lfg issue-978
applicable_to: project
---

## What Happened

Issue #978: Nexus chat messages were silently lost when a session expired during a long conversation. Three separate failure modes contributed; each required its own fix.

## Pattern 1 — 401 in customFetch must throw, not return

When NextAuth's session expires mid-request, the API route returns HTTP 401. The existing `customFetch` error handler (see `2026-03-12-customfetch-must-throw-after-toast.md`) applied to guardrail 400s but was not wired for 401. A returned 401 response is parsed by the AI SDK as an SSE stream, corrupting state and losing the message silently.

**Fix**: treat 401 as a throw path in `customFetch`, just like any other non-2xx:

```typescript
if (response.status === 401) {
  toast.error("Session expired. Please sign in again.")
  throw new Error("Session expired")  // MUST throw — returning causes SSE parse corruption
}
```

The rule from the earlier learning applies to 401 equally: **any non-2xx response returned (not thrown) from customFetch will be misread as a stream.**

## Pattern 2 — Pre-send session gate via useRef in useCallback

The 5-minute poll interval (intentional — see PR #811/#812) means NextAuth may detect session expiry up to 5 minutes before the user's next action. Use a `useRef` to expose the current `status` inside a `useCallback` without adding it as a dependency, then block the request at send-time if already expired:

```typescript
const sessionStatusRef = useRef(status)
useEffect(() => { sessionStatusRef.current = status }, [status])

const handleRequest = useCallback(async () => {
  if (sessionStatusRef.current !== "authenticated") {
    toast.error("Session expired. Please sign in again.")
    return  // block before hitting the network
  }
  // ... proceed
}, [])  // ref is stable — no churn on status changes
```

This follows the `conversationIdRef` pattern already established in `ConversationRuntimeProvider`. The ref gives the callback a stable, always-current view of a value without triggering re-creation on every change.

## Pattern 3 — Per-message try/catch in fromThreadMessageLike map

`INTERNAL.fromThreadMessageLike` throws on malformed messages (e.g., tool-call format errors, encoding issues). In the history adapter's map over stored messages, one bad message was crashing the entire conversation load, making all prior context invisible.

**Fix**: wrap each `fromThreadMessageLike` call in its own try/catch and null-filter the results:

```typescript
const threadMessages = storedMessages
  .map((msg) => {
    try {
      return INTERNAL.fromThreadMessageLike(msg)
    } catch (outer) {
      try {
        // fallback: attempt text-only recovery or log
        logger.warn("Message load failed, skipping", { msgId: msg.id })
      } catch {
        // ignore double-failure
      }
      return null
    }
  })
  .filter((m): m is ThreadMessage => m !== null)
```

The outer catch prevents the crash; the inner catch guards against failures in the recovery path itself; the filter removes nulls before passing to the runtime.

## Prevention

- Every `customFetch` non-2xx branch must throw — no exceptions, including 401
- Expose volatile values to stable callbacks via `useRef` + sync effect, not by adding to `useCallback` deps
- When mapping over persisted messages for `fromThreadMessageLike`, always isolate each call in its own try/catch; one corrupt message must not fail the batch
