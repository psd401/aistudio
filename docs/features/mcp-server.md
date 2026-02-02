# MCP Server

Issue #686 — Model Context Protocol server exposing AI Studio tools via JSON-RPC over Streamable HTTP.

## Endpoint

```
POST /api/mcp
Authorization: Bearer sk-... (API key) or Bearer <jwt> (OAuth token)
Content-Type: application/json
```

## Transport

Streamable HTTP (current MCP spec). Not the deprecated HTTP+SSE transport.

## Authentication

Three auth paths supported:
1. **API Key** (`sk-` prefix) — existing API key infrastructure
2. **JWT** (OAuth2 access token) — issued by the OIDC provider
3. **Session** — for browser-based testing

## Available Tools

| Tool | Required Scope | Description |
|------|---------------|-------------|
| `search_decisions` | `mcp:search_decisions` | Search decision graph nodes |
| `capture_decision` | `mcp:capture_decision` | Create decision nodes and edges |
| `execute_assistant` | `mcp:execute_assistant` | Execute an AI assistant |
| `list_assistants` | `mcp:list_assistants` | List accessible assistants |
| `get_decision_graph` | `mcp:get_decision_graph` | Get node details + connections |

## Protocol Methods

| Method | Purpose |
|--------|---------|
| `initialize` | Capability negotiation |
| `tools/list` | List tools (filtered by auth scopes) |
| `tools/call` | Execute a tool |
| `ping` | Health check |

## Example: List Tools

```bash
curl -X POST http://localhost:3000/api/mcp \
  -H "Authorization: Bearer sk-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

## Example: Execute Tool

```bash
curl -X POST http://localhost:3000/api/mcp \
  -H "Authorization: Bearer sk-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "search_decisions",
      "arguments": {"query": "budget policy", "limit": 10}
    },
    "id": 2
  }'
```

## Rate Limiting

- API key auth: per-key rate limit (default 60 req/min)
- JWT auth: default rate limit (60 req/min)
- Session auth: no per-key rate limiting

## Architecture

```
POST /api/mcp → authenticateRequest() → checkRateLimit()
  → parseJsonRpcRequest() → handleJsonRpcRequest()
    → initialize | tools/list | tools/call | ping
      → tool-handlers.ts → existing service layer
```

## Files

| Path | Purpose |
|------|---------|
| `app/api/mcp/route.ts` | HTTP route handler |
| `lib/mcp/types.ts` | Protocol type definitions |
| `lib/mcp/tool-registry.ts` | Tool schemas + scope mapping |
| `lib/mcp/tool-handlers.ts` | Tool implementation adapters |
| `lib/mcp/jsonrpc-handler.ts` | JSON-RPC 2.0 dispatcher |
| `lib/mcp/session-manager.ts` | Optional session tracking |
| `lib/api-keys/scopes.ts` | MCP scope definitions |
