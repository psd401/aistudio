# API v1 Quickstart

Get started with the AI Studio REST API for building integrations.

## Authentication Options

| Method | Format | Best For |
|--------|--------|----------|
| API Key | `Authorization: Bearer sk-...` | Scripts, CLI tools, personal automation |
| OAuth JWT | `Authorization: Bearer eyJ...` | Third-party apps acting on behalf of users |
| Session Cookie | Automatic via browser | Internal UI (not for external integrations) |

## Getting an API Key

1. Log in to AI Studio
2. Go to **Settings** > **API Keys** tab
3. Click **Create New Key**
4. Name it and select the scopes you need
5. Copy the key immediately — it's shown only once

Keys use the `sk-` prefix and are hashed with Argon2id for storage.

**Limits:** 10 keys per user, 60 requests/minute per key.

## First API Call

### Health Check (no auth required)

```bash
curl https://your-domain.com/api/v1/health
```

```json
{ "status": "healthy" }
```

### List Assistants

```bash
curl https://your-domain.com/api/v1/assistants \
  -H "Authorization: Bearer sk-your-api-key"
```

### Execute an Assistant

```bash
curl -X POST https://your-domain.com/api/v1/assistants/123/execute \
  -H "Authorization: Bearer sk-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"inputs": {"topic": "photosynthesis"}}'
```

For streaming responses, the endpoint returns Server-Sent Events (SSE).

## Context Graph (Decisions)

### Search Decisions

```bash
curl "https://your-domain.com/api/v1/graph/nodes?type=decision&search=database" \
  -H "Authorization: Bearer sk-your-api-key"
```

### Create a Decision

```bash
curl -X POST https://your-domain.com/api/v1/graph/decisions \
  -H "Authorization: Bearer sk-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Adopt Drizzle ORM",
    "context": "Need type-safe database access",
    "decision": "Use Drizzle ORM with postgres.js",
    "alternatives": ["Prisma", "Knex.js", "Raw SQL"]
  }'
```

### Get Decision Details

```bash
curl https://your-domain.com/api/v1/graph/nodes/456 \
  -H "Authorization: Bearer sk-your-api-key"
```

### Get Decision Connections

```bash
curl https://your-domain.com/api/v1/graph/nodes/456/connections \
  -H "Authorization: Bearer sk-your-api-key"
```

## Available Scopes

| Scope | Permission |
|-------|-----------|
| `chat:read` | Read conversations |
| `chat:write` | Send messages |
| `assistants:read` | View assistant details |
| `assistants:list` | List assistants |
| `assistants:execute` | Execute assistants |
| `models:read` | List AI models |
| `documents:read` | Read documents |
| `documents:write` | Upload documents |
| `graph:read` | Read context graph |
| `graph:write` | Create/update graph nodes |
| `mcp:*` | MCP server operations |

## Rate Limits

- **Default:** 60 requests per minute per API key
- **Window:** Sliding 1-minute window
- **Headers:** Every response includes rate limit info:
  - `X-RateLimit-Limit` — Max requests per window
  - `X-RateLimit-Remaining` — Requests left
  - `X-RateLimit-Reset` — Window reset time (Unix timestamp)
  - `Retry-After` — Seconds to wait (on 429 responses)

## Error Handling

All errors return JSON with a consistent structure:

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "Insufficient scope: requires graph:write"
  }
}
```

| Status | Meaning |
|--------|---------|
| 401 | Missing or invalid authentication |
| 403 | Valid auth but insufficient scope |
| 404 | Resource not found |
| 429 | Rate limit exceeded |
| 500 | Internal server error |

## Full API Reference

- **OpenAPI spec:** [`docs/API/v1/openapi.yaml`](../API/v1/openapi.yaml)
- **Human-readable reference:** [`docs/API/v1/context-graph.md`](../API/v1/context-graph.md)

---

*See also: [OAuth Integration](./oauth-integration.md) | [MCP Integration](./mcp-integration.md)*
