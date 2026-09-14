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
| **Content Visibility** | `/api/v1/content/:id/visibility` | Read object's visibility level and grant entries (#1763) |
| **Agents** | `/api/v1/agents` | Delegated token minting for autonomous agents (Epic #1059) |
| **Tools** | `/api/v1/tools` | Tool catalog inspection |
| **Voice** | `/api/nexus/voice` | Real-time voice via WebSocket with Gemini Live API |

#### Content Publishing API

**Endpoint**: `POST /api/v1/content/{id}/publish`

The publish endpoint makes content LIVE (pins version, gives it a reader page, adds to retrieval). **Publishing does not change audience** — that is controlled by the object's visibility level.

**Request Changes** (#1726):
- `destination` is **optional** (defaults to `intranet`)
- `visibility` parameter removed — use `PATCH /content/{id}/visibility` instead
- `intranet` and `public_web` are aliases for the same live state

**Response**:
- `readerUrl` returns `/p/{slug}` for public objects, `/c/{slug}` otherwise — relay verbatim
- `destination` reports the normalized value (always `intranet` for live surface)

**Approval Gates** (HTTP 202):
- Connector destination (`schoology`/`google`) without `content:publish_public` scope
- Object in a section requiring review

**Key Sources**:
- `/docs/API/v1/openapi.yaml` — full schema
- `/docs/API/v1/context-graph.md` — §26.4 gate explanation
- `/lib/content/publish-service.ts` — implementation

#### Content Visibility API (#1763)

**Endpoint**: `GET /api/v1/content/{id}/visibility`

Returns an object's visibility level plus the actual grant entries, enabling safe audience management.

**Request**:
- Scope: `content:read`
- Authorization: Requires EDIT permission on the object (not just VIEW)

**Response**:
```json
{
  "id": "uuid",
  "visibility": {
    "visibilityLevel": "group",
    "grants": [
      { "kind": "role", "value": "staff" },
      { "kind": "building", "value": "GHS" }
    ]
  }
}
```

**Editor Gate Rationale**: The grant list names every principal with access, including numeric user IDs behind `user` grants. Someone who can merely VIEW an object must not be able to enumerate its audience. This matches the UI's `getVisibilityAction` behavior.

**Why This Exists**: The `grants` parameter on `PATCH /content/{id}/visibility` REPLACES the entire list — it does not append. Before #1763, API consumers had to guess the grant list, and a wrong guess silently revoked access. The GET endpoint lets agents and scripts read before modifying.

**Grant Types in Detail**:

| Kind | Value Format | Validation |
|------|--------------|------------|
| `role` | Role name | Must be valid role |
| `building` | Building code | Alphanumeric |
| `department` | Department name | String |
| `grade` | Grade level | String |
| `group` | Group email | Email format required |
| `user` | Numeric user ID | Positive integer, NOT email |

**Key Sources**:
- `/app/api/v1/content/[id]/visibility/route.ts` — GET and PATCH implementations
- `/lib/content/visibility-read.ts` — shared `readVisibilityForEdit()` helper
- `/docs/API/v1/openapi.yaml` — `getContentVisibility` operation schema

#### Artifact Content CSP

When creating artifacts via the REST API (`POST /api/v1/content` with `kind: "artifact"`), the body renders in a cross-origin sandbox with a strict Content Security Policy:

- **Inline scripts/styles**: Permitted and are the intended way to build artifacts
- **External scripts**: Only allowed from deployment's configured CDN allowlist (`atriumAllowedArtifactCdns` in `infra/cdk.json`)
- **Network requests**: `connect-src` is `'none'` — no fetch/XHR/WebSocket
- **Silent failures**: External scripts from non-allowlisted origins load silently — the page renders with the feature dead

**Pin exact versions**: The OpenAPI spec deliberately omits the actual origin list to avoid stale documentation. For the live allowlist, see the `create_artifact` MCP tool description or check `infra/cdk.json` → `atriumAllowedArtifactCdns`. For infrastructure configuration details, see **[infrastructure/overview.md](../infrastructure/overview.md#atrium-sandbox-configuration)**.

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

<!-- openwiki: broken internal link [../app-features/overview.md#visibility-grant-management] heading anchor "visibility-grant-management" does not exist in "../app-features/overview.md". Fix the href or restore the target, then delete this comment. -->
**Atrium content tools** (`create_document`, `create_artifact`, `get_content`, `get_visibility`, `list_content`, `update_content`, `create_version`, `set_visibility`, `publish_content`, `unpublish_content`, `export_okf`, `import_okf`) are registered alongside these, scoped via `content:*`. See **[app-features/overview.md](../app-features/overview.md#mcp-tools)** for the full tool list and **[app-features/overview.md](../app-features/overview.md#visibility-grant-management)** for visibility/grant management details (#1763).

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
