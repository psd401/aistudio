---
title: jest-environment-jsdom Response lacks body-reading methods — use constructor spy
category: testing
tags:
  - jest
  - jsdom
  - response
  - api-testing
severity: medium
date: 2026-04-08
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #883 (issue #869) added tests for API route error responses. jest-environment-jsdom provides a `Response` global but its polyfill does not implement body-consuming methods (`text()`, `json()`, `arrayBuffer()`). Calling these in tests throws or returns nothing useful, making it impossible to assert on error response bodies the normal way.

## Root Cause

jsdom's `Response` polyfill is a stub sufficient for DOM APIs. It does not implement the Fetch `Body` mixin, so body-reading methods are absent or non-functional at test time.

## Solution

Spy on the `Response` constructor to capture the raw body string before it is consumed:

```typescript
const responseSpy = jest.spyOn(global, "Response" as never);
// ... invoke the handler ...
const [body] = responseSpy.mock.calls[0]; // first arg is the body string
expect(JSON.parse(body)).toMatchObject({ error: "Expected message" });
```

This captures the body at construction time, sidestepping the missing body-reader methods entirely.

## Prevention

When writing API route tests under `jest-environment-jsdom`, default to the constructor spy pattern for response body assertions rather than calling `.text()` or `.json()` on the returned `Response`.
