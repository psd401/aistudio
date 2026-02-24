---
title: Never mutate AI SDK tool args in-place — causes argsText drift in assistant-ui
category: streaming
tags:
  - ai-sdk
  - assistant-ui
  - xss
  - streaming
  - tool-args
  - mutation
severity: high
date: 2026-02-23
source: auto — /work
applicable_to: project
---

## What Happened

`sanitizeChartArgs()` mutated the AI SDK `args` object in-place, calling `escapeHtml()` which converted `&` to `&amp;`. assistant-ui uses an append-only `argsText` check for streaming consistency — after in-place mutation, the serialized args no longer matched the accumulated `argsText`, causing a drift/mismatch error.

## Root Cause

The function had a `void` return type and modified `args` directly. The AI SDK holds a reference to the original args object for streaming protocol bookkeeping. Any in-place mutation after the SDK has seen the object breaks the `argsText` invariant that assistant-ui relies on.

## Solution

Changed `sanitizeChartArgs()` to return a new object (spread/clone + sanitize) instead of mutating in place. Callers use the returned value; the SDK's original reference is untouched.

```typescript
// Before (mutates in place — WRONG)
function sanitizeChartArgs(args: ChartArgs): void {
  args.title = escapeHtml(args.title);
}

// After (returns new object — CORRECT)
function sanitizeChartArgs(args: ChartArgs): ChartArgs {
  return { ...args, title: escapeHtml(args.title) };
}
```

## Prevention

- Sanitization functions that accept SDK objects must always return new objects, never mutate.
- Treat AI SDK `args` as immutable after the `execute` function receives them.
- If XSS sanitization is needed on tool output, apply it to the rendered output layer, not the args layer.
