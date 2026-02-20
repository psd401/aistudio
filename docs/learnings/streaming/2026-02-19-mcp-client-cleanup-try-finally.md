---
title: MCP client cleanup requires try/finally, not onFinish callback
category: streaming
tags:
  - mcp
  - streaming
  - resource-cleanup
  - oauth
severity: high
date: 2026-02-19
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #793 (issue #780) implemented MCP connector popover UI. During review, it was found that MCP client teardown was placed only inside the `onFinish` callback of the AI SDK stream. This caused client leaks whenever the stream ended abnormally — on errors, user cancellations, or disconnects — because `onFinish` only fires on successful completion.

## Root Cause

`onFinish` is a success-path callback in the AI SDK streaming pipeline. Any error thrown during `streamText` execution, a network drop, or a client-side abort bypasses `onFinish` entirely, leaving MCP clients open with no cleanup path.

## Solution

Wrap the stream execution in `try/finally`:

```typescript
const mcpClient = await createMcpClient(config);
try {
  const result = await streamText({ ..., tools: await mcpClient.tools() });
  // consume stream
} finally {
  await mcpClient.close();
}
```

`finally` runs regardless of success, error, or cancellation, guaranteeing client teardown.

## Prevention

- Any resource that must be released (MCP clients, DB connections, file handles) in async streaming code must be scoped with `try/finally`, never with success-only callbacks.
- Treat `onFinish` / `onComplete` callbacks as supplemental logging hooks, not cleanup mechanisms.
