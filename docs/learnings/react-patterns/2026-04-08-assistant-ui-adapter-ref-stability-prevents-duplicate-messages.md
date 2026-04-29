---
title: Keep assistant-ui history adapter stable via ref-based getter to prevent duplicate messages during streaming
category: react-patterns
tags:
  - assistant-ui
  - useChatRuntime
  - history-adapter
  - useRef
  - streaming
  - message-duplication
severity: high
date: 2026-04-08
source: auto — /work
applicable_to: project
---

## What Happened

Nexus chat showed duplicate AI messages during streaming. A second set of already-displayed messages appeared mid-stream, caused by the history adapter being recreated.

## Root Cause

The history adapter was constructed inside `useMemo` with `conversationId` as a dependency. When a new conversation is created, `conversationId` transitions from `null` to a UUID. This produced a new adapter reference, which caused `useChatRuntime` to detect a changed adapter and re-call `load()`, fetching all messages from the database again while streaming was still active.

## Solution

Use a ref to hold `conversationId` and pass a getter function into the adapter instead of a closure-captured value. The adapter instance is created once (outside `useMemo` or with an empty dep array), so its reference never changes:

```typescript
const conversationIdRef = useRef(conversationId);
conversationIdRef.current = conversationId;

const historyAdapter = useMemo(() => createHistoryAdapter(
  () => conversationIdRef.current   // getter reads latest value via ref
), []);                              // empty deps — instance stays stable
```

## Prevention

- Any object passed to `useChatRuntime` (adapter, runtime config) must have a stable reference across renders.
- When the adapter needs to read a value that changes over time (e.g., a conversation ID), pass a ref-based getter rather than the value directly.
- Treat `useChatRuntime` adapter props like `useEffect` cleanup — new reference = runtime teardown and re-initialization.
