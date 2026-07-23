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
const { status: sessionStatus } = useSession()
const sessionStatusRef = useRef(sessionStatus)
sessionStatusRef.current = sessionStatus  // inline assignment during render — always current

const customFetch = useCallback(async (input, init) => {
  if (sessionStatusRef.current === "unauthenticated") {
    // show toast + throw — block before hitting the network
  }
  // ... proceed
}, [])  // ref is stable — no churn on status changes
```

**Important**: the ref is updated with a direct render-time assignment (`sessionStatusRef.current = sessionStatus`), not via `useEffect`. This is the same pattern as `conversationIdRef` in the same component. The inline assignment is synchronous and ensures the ref is up to date before any callback fires; a `useEffect` update would lag one render behind the commit (async), creating a brief window where the ref holds a stale value.

This follows the `conversationIdRef` pattern already established in `ConversationRuntimeProvider`. The ref gives the callback a stable, always-current view of a value without triggering re-creation on every change.

## Pattern 3 — Per-message try/catch in fromThreadMessageLike map

`INTERNAL.fromThreadMessageLike` throws on malformed messages (e.g., tool-call format errors, encoding issues). In the history adapter's map over stored messages, one bad message was crashing the entire conversation load, making all prior context invisible.

**Fix**: wrap each `fromThreadMessageLike` call in its own try/catch and null-filter the results. A nested inner catch guards the fallback construction — if `msg.id` itself is null/corrupt, the fallback call can throw the same way as the primary:

```typescript
const threadMessages = storedMessages
  .map((msg, index) => {
    try {
      return {
        message: INTERNAL.fromThreadMessageLike({
          id: msg.id, role: msg.role,
          content: content as unknown as string,
          ...(msg.createdAt && { createdAt: new Date(msg.createdAt) }),
        }, msg.id, { type: 'complete', reason: 'unknown' }),
        parentId: index === 0 ? null : storedMessages[index - 1]?.id || null,
      }
    } catch (error) {
      log.warn('Message conversion failed, using placeholder', { messageId: msg.id, error })
      try {
        // Inner catch: the fallback call can also throw if msg.id is null/corrupt.
        // Preserve createdAt so ordering is maintained for valid surrounding messages.
        return {
          message: INTERNAL.fromThreadMessageLike({
            id: msg.id, role: msg.role,
            content: [{ type: 'text', text: '[Message could not be loaded]' }] as unknown as string,
            ...(msg.createdAt && { createdAt: new Date(msg.createdAt) }),
          }, msg.id, { type: 'complete', reason: 'unknown' }),
          parentId: index === 0 ? null : storedMessages[index - 1]?.id || null,
        }
      } catch (fallbackError) {
        log.error('Fallback construction failed, skipping message', { messageId: msg.id, fallbackError })
        return null  // filtered out below
      }
    }
  })
  .filter((item): item is NonNullable<typeof item> => item !== null)
```

The outer catch prevents a single bad message from aborting the whole load; the inner catch handles the double-failure case (e.g. `msg.id` is null); the filter removes any null entries from the output. Always preserve `createdAt` on the fallback so conversation ordering is not disrupted.

## Prevention

- Every `customFetch` non-2xx branch must throw — no exceptions, including 401
- Expose volatile values to stable callbacks via `useRef` with a direct render-time assignment (`ref.current = value` in the component body), not `useEffect` and not by adding to `useCallback` deps
- When mapping over persisted messages for `fromThreadMessageLike`, always isolate each call in its own try/catch; one corrupt message must not fail the batch
