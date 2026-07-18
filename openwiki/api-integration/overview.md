---
type: Integration Overview
title: API Platform & Integrations
description: REST API v1 with OpenAPI spec, OAuth2/OIDC provider, MCP tools, and scoped API keys for external integrations with K-12 AI platform.
tags: [api, rest, oauth, oidc, mcp, integrations]
---

# API Platform & Integrations

AI Studio exposes a comprehensive API platform for external integrations, supporting REST, OAuth2/OIDC authentication, and Model Context Protocol (MCP) tools.

## REST API v1

**Location**: `/app/api/v1/`

**OpenAPI Specification**: `/docs/API/v1/openapi.yaml`

The REST API provides programmatic access to AI Studio's core capabilities:

### Key Endpoint Categories

| Category | Path | Purpose |
|----------|------|---------|
| **Health** | `/api/v1/health` | Service health checks |
| **Context Graph** | `/api/v1/graph` | Node and edge operations for decision capture |
| **Assistants** | `/api/v1/assistants` | List and execute assistants via API |
| **Jobs** | `/api/v1/jobs` | Async job polling and cancellation |
| **Content** | `/api/v1/content` | Atrium content objects, versions, publishing (Issue #1055) |
| **Agents** | `/api/v1/agents` | Delegated token minting for autonomous agents (Epic #1059) |
| **Tools** | `/api/v1/tools` | Tool catalog inspection |
| **Voice** | `/api/nexus/voice` | Real-time voice via WebSocket with Gemini Live API |

### Authentication

Two authentication methods are supported:

1. **API Key**: `Authorization: Bearer sk-...`
   - Scoped permissions (e.g., `graph:read`, `assistants:execute`)
   - Rate-limited (default 60 requests per minute per key)

2. **Session Cookie**: Browser session for logged-in users
   - Full access based on user role
   - Not subject to per-key rate limiting

### Rate Limiting

API key requests include rate limit headers:
- `X-RateLimit-Limit` — Maximum requests per window
- `X-RateLimit-Remaining` — Remaining requests in current window
- `X-RateLimit-Reset` — Unix timestamp when window resets

When rate-limited (HTTP 429), a `Retry-After` header is included.

### Pagination

List endpoints use cursor-based pagination. Pass `cursor` from the previous response's `meta.nextCursor` to fetch the next page.

---

## OAuth2/OIDC Provider

**Location**: `/lib/oauth/`

AI Studio includes a full OAuth2/OIDC provider implementation (Issue #686) for third-party application authorization.

### Key Components

| Module | Purpose |
|--------|---------|
| `/lib/oauth/oidc-provider-config.ts` | OIDC provider configuration with node-oidc-provider |
| `/lib/oauth/drizzle-adapter.ts` | Drizzle adapter for OAuth token/client storage |
| `/lib/oauth/jwt-signer.ts` | KMS-backed JWT signing |
| `/lib/oauth/oauth-scopes.ts` | Scope definitions and mappings |
| `/lib/oauth/delegated-token.ts` | Short-lived delegated token minting for agents |

### Supported Grant Types

- **Authorization Code** — Interactive user login flow
- **Client Credentials** — Machine-to-machine authentication
- **Delegated Token** — Agent-initiated short-lived tokens (Atrium §26.1)

---

## MCP Tools

**Endpoint**: `/api/mcp` (JSON-RPC)

AI Studio exposes a Model Context Protocol server for AI agents to invoke platform capabilities.

### MCP Tool Categories

Tools are cataloged in `/lib/tools/catalog/` and exposed on the `mcp` surface:

| Scope | Tool | Purpose |
|-------|------|---------|
| `mcp:search_decisions` | `search_decisions` | Search decision graph nodes |
| `mcp:capture_decision` | `capture_decision` | Create decision nodes and edges |
| `mcp:execute_assistant` | `execute_assistant` | Execute an assistant via MCP |
| `mcp:list_assistants` | `list_assistants` | List available assistants |
| `mcp:get_decision_graph` | `get_decision_graph` | Get decision node details |

### MCP OAuth Flow

Per-user MCP connector tokens are stored in `nexus_mcp_user_tokens` table with encryption:

- `/lib/mcp/mcp-oauth-provider.ts` — OAuth client provider implementation
- `/lib/mcp/connector-service.ts` — MCP connector management
- `/lib/mcp/tool-handlers.ts` — MCP tool execution handlers

---

## API Key Scopes

**Location**: `/lib/api-keys/scopes.ts`

API keys are scoped to specific permissions. Key scope categories:

### Chat & Assistants
- `chat:read`, `chat:write` — Conversation access
- `assistants:read`, `assistants:write`, `assistants:list`, `assistants:execute` — Assistant management and execution

### Knowledge & Content
- `documents:read`, `documents:write` — Document management
- `content:read`, `content:create`, `content:update`, `content:delete` — Atrium content operations
- `content:publish_internal`, `content:publish_public` — Content publishing
- `content:delegate` — Agent authority to mint delegated tokens (never included in delegated tokens)

### Platform & Tools
- `models:read` — List AI models
- `tools:read` — View tool catalog
- `platform:read` — Read capability catalog (actions, features, scopes)
- `graph:read`, `graph:write` — Context graph access

### MCP Scopes
- `mcp:search_decisions`, `mcp:capture_decision` — Decision graph via MCP
- `mcp:execute_assistant`, `mcp:list_assistants`, `mcp:get_decision_graph` — Assistant operations via MCP

### Role-Based Scope Assignment

| Role | Key Capabilities |
|------|------------------|
| **Student** | `chat:read`, `chat:write`, `platform:read` |
| **Staff** | Chat, assistants (read/list/execute), documents, graph read, MCP tools (execute but not capture) |
| **Administrator** | All scopes including `graph:write`, `mcp:capture_decision`, `content:delegate` |

---

## Key Source Files

| Area | Path |
|------|------|
| REST API Routes | `/app/api/v1/*` |
| MCP Server Endpoint | `/app/api/mcp/route.ts` |
| OpenAPI Spec | `/docs/API/v1/openapi.yaml` |
| API Key Scopes | `/lib/api-keys/scopes.ts` |
| OAuth/OIDC Provider | `/lib/oauth/oidc-provider-config.ts` |
| MCP Tool Handlers | `/lib/mcp/tool-handlers.ts` |
| Tool Catalog | `/lib/tools/catalog/catalog.ts` |
| Capability Catalog | `/lib/capabilities/capability-catalog.ts` |
