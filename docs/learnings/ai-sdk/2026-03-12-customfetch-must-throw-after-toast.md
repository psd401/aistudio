---
title: customFetch must throw after showing a toast for error responses
category: ai-sdk
tags:
  - ai-sdk
  - customFetch
  - streaming
  - error-handling
severity: high
date: 2026-03-12
source: auto — /work
applicable_to: project
---

## What Happened

When a guardrail returned HTTP 400, `customFetch` showed a toast notification but returned the error response without throwing. The AI SDK runtime then attempted to parse the non-streaming JSON body as an SSE stream, causing a `TypeError` on `.id` access.

## Root Cause

The AI SDK `streamText` runtime assumes the fetch response is a valid stream when the promise resolves (even with a non-2xx status in some paths). A resolved promise with an error response body is not a valid stream — the SDK tries to read it as one.

## Solution

In `customFetch`, after calling `toast.error(...)` for an error response, immediately `throw` a new `Error` rather than returning the response:

```typescript
if (!response.ok) {
  toast.error("...");
  throw new Error("Request failed");  // MUST throw — do not return response
}
```

## Prevention

Any `customFetch` implementation used with AI SDK streaming must throw (not return) on error responses. Showing UI feedback (toast) and throwing are not mutually exclusive — do both. Review rule: if `customFetch` has a non-2xx branch that returns instead of throwing, it will cause a TypeError in the SDK stream parser.
