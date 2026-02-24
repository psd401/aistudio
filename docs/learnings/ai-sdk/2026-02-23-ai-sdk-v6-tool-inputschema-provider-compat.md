---
title: "AI SDK v6 tool() uses inputSchema, not parameters — Bedrock fails silently when schema is missing"
category: ai-sdk
tags: [ai-sdk, bedrock, tool-schema, provider-compatibility, silent-failure]
severity: high
date: 2026-02-23
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #805: Fixed Bedrock tool compatibility by switching from `tool.parameters` to `tool.inputSchema`. Tools defined with only `parameters` silently failed on Bedrock (no error, just schema applied incorrectly), while Gemini accepted the same definition. Root cause: AI SDK v6's `streamText()` reads `tool.inputSchema`, not `tool.parameters`.

## Root Cause

AI SDK v6 `tool()` is an identity pass-through to the provider's inference API. When constructing tool calls:
- **Bedrock**: Reads `inputSchema` from the tool definition. If missing, produces an invalid schema (no `type: "object"`) that inference rejects silently.
- **Gemini**: Reads `parameters` (backward-compatible). If `parameters` exists, inference succeeds even if `inputSchema` is undefined.

Providers diverge on which field they read, creating a silent compatibility issue.

## Solution

Always define tools with `inputSchema` (not `parameters`) when using AI SDK v6:

```typescript
// ❌ WRONG — Bedrock fails silently, Gemini works
const tool = {
  name: "search",
  description: "Search the web",
  parameters: z.object({ query: z.string() })
}

// ✓ CORRECT — Works on all providers
import { tool } from "ai"

const searchTool = tool({
  description: "Search the web",
  parameters: z.object({ query: z.string() }),
  execute: async ({ query }) => { /* ... */ }
})
```

When working with plain objects (e.g., from MCP client tools), ensure `inputSchema` is populated:

```typescript
// Map MCP tool format to AI SDK format
const aisdkTool = {
  name: mcpTool.name,
  description: mcpTool.description,
  inputSchema: mcpTool.inputSchema,  // ← Required for Bedrock
  // Omit 'parameters' entirely to avoid confusion
}
```

## Prevention

- Use `tool()` factory from `ai` package when possible (automatically sets `inputSchema`)
- If manually constructing tool objects, validate that `inputSchema` is present before passing to `streamText()`
- Test tool definitions against **both Bedrock and Gemini** — different providers expose different schema bugs
- Add schema validation: Check `typeof tool.inputSchema === 'object'` and `tool.inputSchema.type === 'object'` before inference
