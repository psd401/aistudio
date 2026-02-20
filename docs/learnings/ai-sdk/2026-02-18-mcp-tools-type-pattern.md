---
title: "@ai-sdk/mcp doesn't export McpToolSet — use Awaited<ReturnType<MCPClient[\"tools\"]>> pattern"
category: ai-sdk
tags:
  - ai-sdk
  - mcp
  - typescript
  - type-extraction
severity: high
date: 2026-02-18
source: auto — /work
applicable_to: project
---

## What Happened

Implemented MCP connector service (`lib/mcp/connector-service.ts`) for external MCP server integration. Attempted to import `McpToolSet` type from `@ai-sdk/mcp` to annotate the tools returned by `MCPClient.tools()`. The type was not exported — only `MCPClient` interface is publicly available.

## Root Cause

`@ai-sdk/mcp` exports the `MCPClient` interface but does not expose the internal `McpToolSet` type. The type must be extracted from the client's `tools()` method signature.

## Solution

Define the type manually as a type alias using TypeScript's `Awaited` and `ReturnType` utilities:

```typescript
// lib/mcp/connector-types.ts
import type { MCPClient } from "@ai-sdk/mcp"

/** The tool set returned by MCPClient.tools() */
export type McpToolSet = Awaited<ReturnType<MCPClient["tools"]>>
```

Usage in service:
```typescript
export interface McpConnectorToolsResult {
  serverId: string
  serverName: string
  tools: McpToolSet  // ✓ Properly typed
  close: () => Promise<void>
}
```

## Prevention

- When a package doesn't export a type you need, check if it can be extracted from a public interface using `Awaited<ReturnType<...>>` or `Parameters<...>`
- Export extracted types in a `*-types.ts` file for reusability
- Document the extraction pattern in comments for future maintainers
