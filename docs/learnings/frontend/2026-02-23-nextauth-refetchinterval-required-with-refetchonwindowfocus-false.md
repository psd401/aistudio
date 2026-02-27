---
title: NextAuth refetchInterval required when disabling refetchOnWindowFocus
category: frontend
tags:
  - nextauth
  - session
  - refetchInterval
  - pr-review
  - session-expiry
  - side-effects
severity: high
date: 2026-02-23
source: review-pr
applicable_to: project
---

## What Happened

PR #812 review caught that disabling `refetchOnWindowFocus` globally (to prevent component remounts on tab switch) created a session expiry blind spot for long-lived sessions. Sessions were no longer being re-validated, so an expired token would not be detected until the next explicit API call. Fix: added `refetchInterval={5*60}` to compensate.

## Root Cause

Disabling `refetchOnWindowFocus` stops NextAuth from checking session validity on every tab focus. For users who keep the app open in the background for hours, the session can expire silently. Without periodic refetch, the first sign of expiry is a failed API call — not ideal for UX or security.

## Solution

Pair `refetchOnWindowFocus={false}` with a periodic `refetchInterval`:

```typescript
// app/layout.tsx
<SessionProvider refetchOnWindowFocus={false} refetchInterval={5 * 60}>
  {children}
</SessionProvider>
```

This ensures session validity is checked every 5 minutes, catching expiry without causing remounts on window focus.

## Prevention

1. When disabling a NextAuth default behavior, **audit what safety mechanism you're removing**
2. **Compensate** with an alternative (e.g., interval-based polling, explicit refresh on auth-protected routes)
3. Test long-lived sessions (leave app open for 30+ min after token expiry time)
4. Code review: always question "why disable this?" and verify the replacement strategy
