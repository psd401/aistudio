---
title: AI SDK v6 onStepFinish fires before tool execution — read tool results from onFinish event.steps
category: ai-sdk
tags:
  - ai-sdk-v6
  - mcp
  - streaming
  - tool-results
  - onFinish
severity: high
date: 2026-02-20
source: auto — /review-pr
applicable_to: project
---

## What Happened

MCP tool call results were never persisted to the database. The `onStepFinish` callback was used to capture tool results, but `toolResults` was always an empty array at that point.

## Root Cause

In AI SDK v6, `onStepFinish` fires before tool execution completes. The `toolResults` field in `onStepFinish` is always `[]`. Tool results are only fully populated by the time `onFinish` fires, accessible via `event.steps`.

## Solution

Move tool result persistence to `onFinish`:

```typescript
onFinish: async (event) => {
  for (const step of event.steps) {
    for (const toolResult of step.toolResults) {
      await persistToolResult(toolResult);
    }
  }
}
```

Do not rely on `onStepFinish` for reading tool results — use it only for step-level metadata that does not depend on tool output.

## Prevention

- Treat `onStepFinish.toolResults` as unreliable in AI SDK v6; always use `onFinish event.steps` for tool result capture.
- Validate persistence in integration tests by asserting DB rows exist after a streamed tool call.
