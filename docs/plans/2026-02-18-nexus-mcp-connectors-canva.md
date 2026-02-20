# Nexus MCP Connectors — Canva First

**Date:** 2026-02-18
**Scope:** Large — single phase
**Status:** Planning

---

## Problem

AI Studio's Nexus Chat needs to call external MCP servers ("connectors") so users can take actions in third-party services (starting with Canva) directly from conversations. The model decides when to invoke connector tools based on conversation context. DB schema for MCP servers/connections/capabilities/audit already exists but no implementation. The UI has a disabled "Connect" button placeholder.

## Key Decisions

- **AI SDK `@ai-sdk/mcp`** — `createMCPClient` with HTTP transport connects to Canva's hosted MCP server at `https://mcp.canva.com/mcp`
- **Per-user OAuth** — popup-based flow, encrypted tokens stored in new DB table using AES-256-GCM with KMS-derived key
- **Admin-registered servers** — admin UI to manage available MCP servers, users toggle per-conversation
- **Tool call UI** — visible tool call/result blocks in chat (similar to existing tool rendering)
- **Audit logging** — all connector tool calls logged to existing `nexus_mcp_audit_logs`
- **Role-based access** — admin & staff only (configurable for future expansion to students)
- **Connector state** — per-conversation toggle, persistent auth across session

## Technical Context

- Canva MCP is a hosted HTTP server at `https://mcp.canva.com/mcp` — no self-hosting
- `createMCPClient` (from `@ai-sdk/mcp` v1.0.21) — stable, supports HTTP transport with `authProvider`
- Current AI SDK: `ai@~6.0.0` → needs update to `~6.0.91`
- `@ai-sdk/mcp` not yet installed
- Next available migration: 058
- Existing DB tables: `nexus_mcp_servers`, `nexus_mcp_connections`, `nexus_mcp_capabilities`, `nexus_mcp_audit_logs`
- Missing: per-user encrypted token storage table

## Implementation Breakdown

### Task 1: Install `@ai-sdk/mcp` & Update AI SDK
- **Files:** `package.json`
- **Description:** Install `@ai-sdk/mcp@^1.0.21`, update `ai` to `~6.0.91`, `@ai-sdk/react` to `~3.0.93`
- **Dependencies:** None

### Task 2: DB Migration — Per-User Encrypted Token Table
- **Files:** `infra/database/schema/058-nexus-mcp-user-tokens.sql`, `infra/database/lambda/db-init-handler.ts`, `lib/db/schema/tables/nexus-mcp-user-tokens.ts`, `lib/db/schema/relations.ts`, `lib/db/types/index.ts`
- **Description:** Create `nexus_mcp_user_tokens` table (userId + serverId unique, encrypted access/refresh tokens, expiry, scope). Add Drizzle schema, relations, types. Register migration file.
- **Dependencies:** None

### Task 3: Token Encryption Module
- **Files:** `lib/crypto/token-encryption.ts`
- **Description:** AES-256-GCM encrypt/decrypt using a data encryption key (DEK) fetched from Secrets Manager at `aistudio/{env}/mcp/token-encryption-key`. Cache DEK in-process with 5-min TTL. Provider-agnostic.
- **Dependencies:** None

### Task 4: MCP Connector Service (Backend Core)
- **Files:** `lib/mcp/connector-service.ts`, `lib/mcp/connector-types.ts`
- **Description:** Core service for:
  - Listing available servers for a user (role-filtered)
  - Creating MCP client via `createMCPClient` with HTTP transport
  - Fetching tools from a server (with user's decrypted token)
  - Executing tool calls through the client
  - Token refresh on 401 (with inline reconnect signal)
  - Audit log writes to `nexus_mcp_audit_logs`
  - Client lifecycle (create per-request, close in `onFinish`/`onError`)
- **Dependencies:** Task 2, Task 3

### Task 5: OAuth Flow — Popup + Callback
- **Files:** `app/api/connectors/oauth/authorize/route.ts`, `app/api/connectors/oauth/callback/route.ts`, `app/(protected)/nexus/_components/chat/oauth-popup.tsx`
- **Description:**
  - `/api/connectors/oauth/authorize` — generates OAuth URL for given serverId, stores PKCE state in encrypted cookie, redirects to provider
  - `/api/connectors/oauth/callback` — exchanges code for tokens, encrypts and stores in `nexus_mcp_user_tokens`, sends `postMessage` to close popup
  - Client-side popup helper that opens window, listens for `postMessage` completion
  - Canva MCP handles its own OAuth — the `authProvider` config on `createMCPClient` may handle this natively
- **Dependencies:** Task 2, Task 3

### Task 6: Connect Popover UI (Replaces MCPPopover)
- **Files:** `app/(protected)/nexus/_components/chat/mcp-popover.tsx`, `app/(protected)/nexus/_components/chat/composer-controls.tsx`
- **Description:** Rewrite MCPPopover to match ToolsPopover pattern:
  - Fetches available connectors for user's role
  - Shows each connector with name, description, connection status
  - Toggle enables/disables per-conversation
  - Toggle checks auth — opens OAuth popup if not connected
  - Badge shows active connector count
  - "Reconnect" action for expired tokens
  - Enabled only when connectors are available
- **Dependencies:** Task 4, Task 5

### Task 7: Integrate Connector Tools into Chat Stream
- **Files:** `app/api/chat/route.ts` (or wherever `streamText` is called), `app/api/chat/lib/` as needed
- **Description:**
  - When user has connectors enabled for a conversation, fetch tools from each enabled MCP server
  - Merge connector tools into the `tools` object passed to `streamText`
  - Pass conversation-scoped enabled connectors from client to API
  - Handle `onFinish` / `onError` to close MCP clients
  - On auth failure, return inline reconnect signal to client
- **Dependencies:** Task 4, Task 6

### Task 8: Tool Call/Result UI in Chat
- **Files:** `app/(protected)/nexus/_components/chat/` (message rendering components)
- **Description:**
  - Render connector tool calls visually (icon, tool name, args summary)
  - Render tool results (design preview, export link, etc.)
  - Render "Reconnect" inline prompt when auth fails
  - Follow existing message `parts` format (`UIMessage` with `parts`, not `content`)
- **Dependencies:** Task 7

### Task 9: Admin UI — MCP Server Management
- **Files:** `app/(protected)/admin/connectors/page.tsx`, `actions/admin/connector.actions.ts`
- **Description:**
  - List registered MCP servers
  - Add new server (name, URL, transport type, auth type, allowed roles, description)
  - Edit/disable servers
  - View connection health stats
  - Seed Canva as the first server
- **Dependencies:** Task 2

### Task 10: Seed Data & E2E Testing
- **Files:** `infra/database/seeds/`, `tests/e2e/`
- **Description:**
  - Seed Canva MCP server record for dev/staging
  - E2E test: connector popover loads, shows Canva, toggle triggers auth flow
  - E2E test: connected Canva tools appear in chat
  - Manual test: full Canva OAuth + design creation flow
- **Dependencies:** All above

## Acceptance Criteria

| Criterion | Source |
|-----------|--------|
| Admin can register Canva MCP server via admin UI | Explicit |
| Staff/admin users see active "Connect" popover with Canva listed | Explicit |
| Toggling Canva triggers OAuth popup if not authenticated | Explicit |
| OAuth tokens stored encrypted (AES-256-GCM) in DB | Explicit |
| Model can invoke Canva tools (create, find, autofill, export) during chat | Explicit |
| Tool calls/results render visually in chat | Explicit |
| Expired token shows inline "Reconnect" link | Explicit |
| All connector tool calls logged to `nexus_mcp_audit_logs` | Explicit |
| Student role cannot see/use connectors | Explicit |
| Existing tests pass, no new lint/typecheck errors | Implicit |

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Canva MCP OAuth flow may differ from standard OAuth (it's MCP-native) | High | AI SDK `authProvider` on `createMCPClient` may handle natively — test early |
| `createMCPClient` HTTP transport + OAuth interaction is new territory | Med | Build fallback manual HTTP integration if SDK's authProvider doesn't work with Canva |
| Per-request MCP client creation adds latency | Med | Canva's hosted server should handle ephemeral connections; monitor latency via audit logs |
| Nexus streaming breaks on component remount (documented history) | High | Do NOT pass mutable connector state as props to `ConversationInitializer`; use refs |
| DEK not yet in Secrets Manager | Low | CDK change or manual creation required before first deployment |

## Unresolved Questions

- Canva's MCP OAuth — does `createMCPClient`'s `authProvider` handle the full popup flow, or do we need custom OAuth endpoints?
- Does Canva MCP require app registration / API keys on their developer portal, or is it purely user-level OAuth?
- Admin connector UI — new page under `/admin/connectors` or a tab on an existing admin page?

## Research Sources

- AI SDK docs: `createMCPClient` with HTTP transport (`@ai-sdk/mcp`)
- Canva MCP setup: `https://www.canva.dev/docs/connect/canva-mcp-server-setup/`
- Existing codebase: `nexus_mcp_*` tables, `MCPPopover`, `ToolsPopover` patterns
- MCP spec 2025-03-26: Streamable HTTP transport, per-user token requirements
- Nexus conversation architecture: `stableConversationId` pattern, UIMessage `parts` format
