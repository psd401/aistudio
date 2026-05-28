---
title: customFetch must handle network-level errors and 413 responses before the AI SDK reads the body
category: ai-sdk
tags:
  - ai-sdk
  - customFetch
  - streaming
  - error-handling
  - 413
  - network-error
severity: high
date: 2026-05-28
source: auto — lfg-issue-993
applicable_to: project
---

## What Happened

PR #1005 fixed two gaps in the Nexus `customFetch` wrapper that caused uncaught errors surfaced as generic "network error" toasts:

1. **Network-level failures** — if the underlying `fetch()` threw (e.g., DNS failure, connection refused, timeout), the exception propagated unhandled through the AI SDK and appeared as an opaque crash rather than a user-readable message.
2. **413 Payload Too Large** — when the request body exceeded the server limit, the server returned HTTP 413 before the AI SDK had a chance to handle it. Because `customFetch` did not check for 413 before returning the response, the SDK attempted to parse the 413 body as an SSE stream and produced a confusing error.

## Root Cause

`customFetch` previously only intercepted non-2xx responses that were processed by the SDK. Two cases fell outside that path:
- `fetch()` itself can throw synchronously or reject its promise (network-layer failure); this was not wrapped in try/catch.
- HTTP 413 arrives before any stream is established; the AI SDK has no special handling for it and will try to read the body as a stream.

## Solution

```typescript
async function customFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let response: Response;

  // 1. Wrap the underlying fetch in try/catch for network-level errors
  try {
    response = await fetch(input, init);
  } catch (err) {
    toast.error("Network error — check your connection and try again.");
    throw err; // must re-throw so the AI SDK stops processing
  }

  // 2. Intercept 413 before the SDK body-reads the response
  if (response.status === 413) {
    toast.error("Your message or attachments are too large. Please reduce the size and try again.");
    throw new Error("413 Payload Too Large");
  }

  // ... existing non-2xx handling ...
  return response;
}
```

## Prevention

- Every `customFetch` implementation used with AI SDK streaming needs **both** a network-error try/catch around `fetch()` **and** an explicit `status === 413` check.
- Always `throw` after calling `toast.error()` — returning a non-2xx or error response will cause the SDK stream parser to throw a cryptic TypeError (see `2026-03-12-customfetch-must-throw-after-toast.md`).
- Add status checks for any other HTTP codes that arrive before a stream is established (e.g., 429 rate-limit, 503 overload) following the same pattern.
