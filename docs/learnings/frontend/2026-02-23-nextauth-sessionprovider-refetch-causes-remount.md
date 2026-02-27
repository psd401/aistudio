---
title: NextAuth SessionProvider refetchOnWindowFocus=true causes component remounts on tab switch
category: frontend
tags:
  - nextauth
  - react
  - useEffect
  - session
  - tab-switch
  - remount
  - dependencies
severity: high
date: 2026-02-23
source: work
applicable_to: project
---

## What Happened

Nexus conversation was remounting on every tab switch, causing loss of draft text and UI state. Root cause: `SessionProvider` has `refetchOnWindowFocus=true` by default, which triggers a session refetch on tab focus. This refetch returns a new object reference, which was included in the `useEffect` dependency array of `ConversationInitializer`, causing the effect to re-run, setting `loading=true`, and unmounting the entire component tree.

## Root Cause

NextAuth `SessionProvider` refetches the session on window focus by default. Each refetch creates a **new object reference** even if the session data is unchanged. When `session` object is added to a `useEffect` dependency array, any tab switch will:

1. Trigger refetch → new session object reference
2. Dependency check fails → effect re-runs
3. Loading state reset → component tree unmounts
4. User loses any unsaved work

## Solution

**Always use `status` (primitive string) instead of `session` (object) in dependency arrays:**

```typescript
// WRONG: session is an object, new reference on every refetch
useEffect(() => {
  if (session?.user?.id) {
    initializeConversation()
  }
}, [session, conversationId])  // ❌ Remounts on tab switch

// RIGHT: status is a primitive string, stable across refetches
useEffect(() => {
  if (status === 'authenticated') {
    initializeConversation()
  }
}, [status, conversationId])  // ✅ No remount
```

**Disable refetchOnWindowFocus in SessionProvider:**

```typescript
// app/layout.tsx
<SessionProvider refetchOnWindowFocus={false}>
  {children}
</SessionProvider>
```

## Prevention

1. Add `refetchOnWindowFocus={false}` to NextAuth `SessionProvider` at app startup
2. When reading session state in effects: always use `status` (primitive) instead of `session` (object)
3. If you need the actual session data, store it in state/ref instead of dependency array
4. Code review: grep for `useEffect.*session` and replace with `useEffect.*status`
