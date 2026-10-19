---
title: next/server's NextResponse is not constructible under jest's node environment — subclass Response instead
category: test-failures
tags:
  - jest
  - next-server
  - nextresponse
  - route-handler
severity: medium
date: 2026-10-18
source: auto — issue #1898, PR #1941
applicable_to: project
---

## What Happened

Testing a streaming download Route Handler (`app/api/nexus/documents/[...key]/route.ts`)
under `@jest-environment node`, calling `new NextResponse(...)` throws
"NextResponse is not a constructor" — only the static `NextResponse.json()`
helper works. The node environment's own `Response` stub also only exposes
`json()`/`text()`, not `arrayBuffer()`, so draining a streamed body needs care
too.

## Root Cause

`next/server`'s real `NextResponse` class isn't usable standalone outside the
Next.js runtime under jest's `node` test environment. This is distinct from
the `jest-environment-jsdom` case (see
`docs/learnings/testing/2026-04-08-jsdom-response-body-spy-pattern.md`), which
has a different root cause (jsdom's `Response` polyfill lacks the Fetch `Body`
mixin entirely) — jest's `node` environment's native `Response` is usable, the
problem is specifically `NextResponse`.

## Solution

`jest.mock("next/server", ...)` with a class that `extends Response` and adds
a static `json()` matching `NextResponse.json`'s signature — this preserves
real header/status/body semantics (including streaming) for assertions.
Already used by `tests/unit/atrium-content-asset-bytes-route.test.ts`; applied
again in `tests/unit/nexus-document-download-route.test.ts`. Read the body via
`response.body` (a `ReadableStream`), not `response.arrayBuffer()`.

## Prevention

When unit-testing a Route Handler under `@jest-environment node` that returns
`NextResponse`, mock `next/server` with a `Response`-subclassing stub rather
than relying on the real class or on body-reading convenience methods.
