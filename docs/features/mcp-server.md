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

**Atrium content tools** (`create_document`, `create_artifact`, `get_content`, `list_content`, `update_content`, `create_version`, `set_visibility`, `publish_content`, `unpublish_content`, `export_okf`, `import_okf`) are registered alongside these, scoped via `content:*` — see [atrium-agent-access.md](./atrium-agent-access.md) for the per-tool scope table, semantics (version-based, private+draft, §28.3-screened), and agent integration guide.

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
      → ToolCatalog (lib/tools/catalog) → code handler / existing service layer
```

### Catalog-backed dispatch (#924)

As of the unified tool catalog (Epic #922, workstream #2), `tools/list` and
`tools/call` resolve through the **`ToolCatalog`** (`lib/tools/catalog/catalog.ts`)
rather than the static MCP registry:

- `tools/list` returns catalog tools exposed on the `mcp` surface, filtered by the
  caller's scopes.
- `tools/call` resolves the tool in the catalog (scope-checked) and invokes its
  code handler.

The catalog is hybrid: **code-defined** tools live in a TypeScript manifest
(`lib/tools/catalog/manifest.ts`) and are reconciled into the `tool_catalog` table
on boot (`lib/tools/catalog/sync.ts`); **assistant/skill-derived** tools live in
the `tool_catalog` table and are merged at runtime. Each catalog entry carries
`surfaces`, `required_scopes`, `agent_callable`, and `version`. The 5 original MCP
tools migrated to `domain.action` identifiers (e.g. `decisions.search`); their MCP
wire `name` (`search_decisions`) is unchanged for client compatibility.

> Note: external MCP tools resolved per-user via `lib/mcp/connector-service.ts`
> are *consumed* tools, not part of this catalog (which tracks only tools AI Studio
> itself *exposes*).

### Surface coverage (#924)

The catalog is the single source of truth across every surface AI Studio exposes:

| Surface | How it reads the catalog |
|---------|--------------------------|
| `mcp` | `tools/list` / `tools/call` dispatch via `ToolCatalog` (above). |
| `ai_sdk` | The chat/Nexus tools have one source — `lib/tools/catalog/ai-sdk-tools.ts` — which the catalog manifest ingests. The Nexus route scope-gates `enabledTools` via `ToolCatalog.filterAiSdkToolNames`; the server + client tool registries derive their lists (and model-capability + UI metadata) from that same source. Adding a chat tool is one edit. |
| `rest` | Tool-backed `/api/v1` routes declare a `rest` surface + `surfaceScopes.rest` + a `rest` binding. The route resolves its scope from the catalog (`getRequiredScopes(id, 'rest')`), and the tool-endpoint OpenAPI is generated from the catalog (`scripts/openapi/generate-from-catalog.ts` → `docs/API/v1/generated/tool-catalog.openapi.json`, `bun run openapi:generate`). |
| `internal` | The agentic Assistant Architect runtime (#926). `lib/agents/tool-resolver.ts` lists via `ToolCatalog.list({ surface: 'internal', scopes, agentOnly: true })` (author allow-list ∩ caller scopes ∩ `agent_callable`) and dispatches via `ToolCatalog.dispatch(..., 'internal')`, which re-checks surface, scope, active state, and `agent_callable` (defense-in-depth). Agent platform tools (`images.generate`, `documents.generate`, `web.fetch`) are internal-only manifest entries. |

## Files

| Path | Purpose |
|------|---------|
| `app/api/mcp/route.ts` | HTTP route handler |
| `lib/mcp/types.ts` | Protocol type definitions |
| `lib/mcp/tool-registry.ts` | Tool schemas + scope mapping (sourced into the catalog manifest) |
| `lib/mcp/tool-handlers.ts` | Tool implementation adapters |
| `lib/mcp/jsonrpc-handler.ts` | JSON-RPC 2.0 dispatcher (catalog-backed) |
| `lib/mcp/session-manager.ts` | Optional session tracking |
| `lib/api-keys/scopes.ts` | MCP scope definitions |
| `lib/tools/catalog/catalog.ts` | Unified `ToolCatalog` runtime (merge + filter + dispatch) |
| `lib/tools/catalog/manifest.ts` | Code-defined tool catalog |
| `lib/tools/catalog/ai-sdk-tools.ts` | Single source for AI SDK chat tools (ingested by the manifest) |
| `lib/tools/catalog/sync.ts` | Boot-time `tool_catalog` reconciliation |
| `lib/db/schema/tables/tool-catalog.ts` | `tool_catalog` table schema |
| `scripts/openapi/build-spec.ts` | Catalog → OpenAPI fragment builder (REST surface) |
| `scripts/openapi/generate-from-catalog.ts` | `openapi:generate` / `openapi:check` CLI |
