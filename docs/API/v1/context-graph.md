# Context Graph API v1

REST API for managing context graph nodes and edges. Part of Epic #674 (External API Platform).

**Base URL:** `/api/v1`
**OpenAPI Spec:** [`docs/API/v1/openapi.yaml`](./openapi.yaml)
**Tool endpoints (catalog-generated):** [`generated/tool-catalog.openapi.json`](./generated/tool-catalog.openapi.json) — endpoints backed by a unified tool-catalog entry (e.g. assistant execute/list) are generated from the catalog manifest via `bun run openapi:generate` (issue #924).

---

## Authentication

All `/api/v1/graph/*` endpoints require authentication. Two modes are supported:

| Mode | Header / Mechanism | Scopes |
|------|--------------------|--------|
| API Key | `Authorization: Bearer sk-...` | Per-key scopes set at creation |
| Session | Browser cookie (`next-auth.session-token`) | Full access (`*`) for user's role |

**Scopes:**

| Scope | Grants |
|-------|--------|
| `graph:read` | List nodes, get node, list edges, get connections |
| `graph:write` | Create/update/delete nodes, create/delete edges |

API keys are created in **Settings > API Keys**. Administrators receive all scopes; staff receives `graph:read` by default.

---

## Rate Limiting

API key requests use a **sliding window** counter: **60 requests per minute** per key (default, configurable per key). Session requests bypass per-key rate limiting.

**Response headers** (included on every API key response):

| Header | Description |
|--------|-------------|
| `X-RateLimit-Limit` | Max requests per 1-minute window |
| `X-RateLimit-Remaining` | Requests left in current window |
| `X-RateLimit-Reset` | Unix timestamp (seconds) when window resets |

When exceeded, the API returns `429` with `Retry-After` (seconds to wait).

---

## Pagination

List endpoints use **cursor-based pagination** ordered by `createdAt` descending.

| Parameter | Type | Description |
|-----------|------|-------------|
| `limit` | integer | Items per page. Min 1, max 100, default 50. |
| `cursor` | string | Opaque token from previous `meta.nextCursor`. |

**How it works:**
1. First request: `GET /api/v1/graph/nodes?limit=10`
2. Response includes `meta.nextCursor` (or `null` if no more pages)
3. Next request: `GET /api/v1/graph/nodes?limit=10&cursor=<nextCursor>`
4. Repeat until `nextCursor` is `null`

Cursors are opaque base64url-encoded strings. Do not construct or parse them manually.

---

## Response Format

### Success (single resource)

```json
{
  "data": { ... },
  "meta": {
    "requestId": "req_abc123def456"
  }
}
```

### Success (list)

```json
{
  "data": [ ... ],
  "meta": {
    "requestId": "req_abc123def456",
    "limit": 50,
    "nextCursor": "eyJjcmVhdGVkQXQiOi..."
  }
}
```

### Error

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request body",
    "details": [ ... ]
  },
  "requestId": "req_abc123def456"
}
```

Every response includes an `X-Request-Id` header matching `meta.requestId` / `requestId`.

---

## Error Codes

| HTTP | Code | Description |
|------|------|-------------|
| 400 | `VALIDATION_ERROR` | Invalid query params or request body. `details` contains Zod issues. |
| 400 | `INVALID_JSON` | Request body is not valid JSON. |
| 401 | `INVALID_TOKEN` | Missing or invalid API key. |
| 401 | `UNAUTHORIZED` | No valid session or API key provided. |
| 403 | `INSUFFICIENT_SCOPE` | API key lacks required scope (e.g. `graph:write`). |
| 404 | `NOT_FOUND` | Node or edge does not exist. |
| 409 | `CONFLICT` | Duplicate edge (same source, target, and type). |
| 429 | `RATE_LIMIT_EXCEEDED` | Too many requests. Check `Retry-After` header. |
| 500 | `INTERNAL_ERROR` | Unexpected server error. |

---

## Endpoints

### Health Check

#### `GET /api/v1/health`

Public. No authentication required.

**Response `200`**

```json
{
  "status": "ok",
  "version": "v1",
  "timestamp": "2025-01-15T12:00:00.000Z"
}
```

---

### Nodes

#### `GET /api/v1/graph/nodes`

List nodes with optional filters and pagination. Requires `graph:read`.

**Query parameters:**

| Name | Type | Description |
|------|------|-------------|
| `nodeType` | string | Exact match filter |
| `nodeClass` | string | Exact match filter |
| `search` | string (1-100 chars) | Case-insensitive search on `name` and `description` |
| `limit` | integer (1-100) | Page size (default 50) |
| `cursor` | string | Pagination cursor |

**Example request:**

```bash
curl -H "Authorization: Bearer sk-your-key" \
  "https://your-domain/api/v1/graph/nodes?nodeType=decision&limit=10"
```

**Response `200`**

```json
{
  "data": [
    {
      "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "nodeType": "decision",
      "nodeClass": "policy",
      "name": "Adopt AI Usage Policy",
      "description": "Board-approved policy for AI tools in classrooms",
      "metadata": { "priority": "high" },
      "createdBy": 1,
      "createdAt": "2025-01-15T12:00:00.000Z",
      "updatedAt": "2025-01-15T12:00:00.000Z"
    }
  ],
  "meta": {
    "requestId": "req_abc123",
    "limit": 10,
    "nextCursor": "eyJjcmVhdGVkQXQiOiIyMDI1LTAxLTE1VDEyOjAwOjAwLjAwMFoiLCJpZCI6ImExYjJjM2Q0LWU1ZjYtNzg5MC1hYmNkLWVmMTIzNDU2Nzg5MCJ9"
  }
}
```

---

#### `POST /api/v1/graph/nodes`

Create a new node. Requires `graph:write`.

**Request body:**

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `name` | string | yes | 1-500 chars |
| `nodeType` | string | yes | 1-100 chars |
| `nodeClass` | string | yes | 1-100 chars |
| `description` | string\|null | no | max 5000 chars |
| `metadata` | object | no | Arbitrary key-value pairs |

**Example request:**

```bash
curl -X POST -H "Authorization: Bearer sk-your-key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Adopt AI Usage Policy",
    "nodeType": "decision",
    "nodeClass": "policy",
    "description": "Board-approved policy for AI tools in classrooms",
    "metadata": { "priority": "high" }
  }' \
  "https://your-domain/api/v1/graph/nodes"
```

**Response `201`** — returns the created node in `data`.

---

#### `GET /api/v1/graph/nodes/{nodeId}`

Get a single node by UUID. Requires `graph:read`.

**Response `200`**

```json
{
  "data": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "nodeType": "decision",
    "nodeClass": "policy",
    "name": "Adopt AI Usage Policy",
    "description": "Board-approved policy for AI tools in classrooms",
    "metadata": { "priority": "high" },
    "createdBy": 1,
    "createdAt": "2025-01-15T12:00:00.000Z",
    "updatedAt": "2025-01-15T12:00:00.000Z"
  },
  "meta": { "requestId": "req_abc123" }
}
```

**Response `404`** — Node not found.

---

#### `PATCH /api/v1/graph/nodes/{nodeId}`

Partial update. At least one field must be provided. Requires `graph:write`.

**Request body** (all fields optional, at least one required):

| Field | Type | Constraints |
|-------|------|-------------|
| `name` | string | 1-500 chars |
| `nodeType` | string | 1-100 chars |
| `nodeClass` | string | 1-100 chars |
| `description` | string\|null | max 5000 chars, or `null` to clear |
| `metadata` | object | Replaces entire metadata object |

**Example request:**

```bash
curl -X PATCH -H "Authorization: Bearer sk-your-key" \
  -H "Content-Type: application/json" \
  -d '{ "description": "Updated description" }' \
  "https://your-domain/api/v1/graph/nodes/a1b2c3d4-e5f6-7890-abcd-ef1234567890"
```

**Response `200`** — returns the updated node.
**Response `404`** — Node not found.

---

#### `DELETE /api/v1/graph/nodes/{nodeId}`

Delete a node. All connected edges are **cascade-deleted**. Requires `graph:write`.

**Response `200`**

```json
{
  "data": { "deletedId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890" },
  "meta": { "requestId": "req_abc123" }
}
```

**Response `404`** — Node not found.

---

#### `GET /api/v1/graph/nodes/{nodeId}/connections`

Get all connections (incoming + outgoing edges) for a node. Requires `graph:read`.

**Response `200`**

```json
{
  "data": [
    {
      "edge": {
        "id": "e1e2e3e4-f5f6-7890-abcd-ef1234567890",
        "sourceNodeId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        "targetNodeId": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
        "edgeType": "informed_by",
        "metadata": {},
        "createdBy": 1,
        "createdAt": "2025-01-15T12:30:00.000Z"
      },
      "connectedNode": {
        "id": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
        "name": "Staff Survey Results",
        "nodeType": "document",
        "nodeClass": "survey"
      },
      "direction": "outgoing"
    }
  ],
  "meta": {
    "requestId": "req_abc123",
    "total": 1
  }
}
```

**Response `404`** — Node not found.

---

### Edges

#### `GET /api/v1/graph/edges`

List edges with optional filters and pagination. Requires `graph:read`.

**Query parameters:**

| Name | Type | Description |
|------|------|-------------|
| `edgeType` | string | Exact match filter |
| `sourceNodeId` | UUID | Filter by source node |
| `targetNodeId` | UUID | Filter by target node |
| `limit` | integer (1-100) | Page size (default 50) |
| `cursor` | string | Pagination cursor |

**Example request:**

```bash
curl -H "Authorization: Bearer sk-your-key" \
  "https://your-domain/api/v1/graph/edges?edgeType=informed_by&limit=20"
```

**Response `200`**

```json
{
  "data": [
    {
      "id": "e1e2e3e4-f5f6-7890-abcd-ef1234567890",
      "sourceNodeId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "targetNodeId": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
      "edgeType": "informed_by",
      "metadata": {},
      "createdBy": 1,
      "createdAt": "2025-01-15T12:30:00.000Z"
    }
  ],
  "meta": {
    "requestId": "req_abc123",
    "limit": 20,
    "nextCursor": null
  }
}
```

---

#### `POST /api/v1/graph/edges`

Create a new edge between two nodes. Requires `graph:write`.

**Request body:**

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `sourceNodeId` | UUID | yes | Must reference an existing node |
| `targetNodeId` | UUID | yes | Must differ from sourceNodeId |
| `edgeType` | string | yes | 1-100 chars |
| `metadata` | object | no | Arbitrary key-value pairs |

**Validation rules:**
- `sourceNodeId` and `targetNodeId` must be different (no self-reference)
- Both nodes must exist (returns `404` if either is missing)
- Duplicate edges (same source, target, type) return `409`

**Example request:**

```bash
curl -X POST -H "Authorization: Bearer sk-your-key" \
  -H "Content-Type: application/json" \
  -d '{
    "sourceNodeId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "targetNodeId": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
    "edgeType": "informed_by"
  }' \
  "https://your-domain/api/v1/graph/edges"
```

**Response `201`** — returns the created edge.
**Response `404`** — Referenced node not found.
**Response `409`** — Duplicate edge.

---

#### `DELETE /api/v1/graph/edges/{edgeId}`

Delete a single edge. Requires `graph:write`.

**Response `200`**

```json
{
  "data": { "deletedId": "e1e2e3e4-f5f6-7890-abcd-ef1234567890" },
  "meta": { "requestId": "req_abc123" }
}
```

**Response `404`** — Edge not found.

---

### Tools (catalog versioning — Issue #927)

Inspect the unified tool catalog and its version history. Tools are versioned
`v1`/`v2`/`v3` (not semver). A version is **immutable** once published; a breaking
change is a new version. Deprecated versions stay callable for a grace period
(default **90 days**) before an admin may remove them. All endpoints require the
`tools:read` scope.

Tool versions are addressed in the catalog as `identifier@version` (e.g.
`documents.create@v2`); the REST API itself stays at `/api/v1` — per-tool
versioning is in the path/query below, not in the API version.

#### `GET /api/v1/tools/{identifier}`

Returns the latest **non-deprecated** version of a tool.

- `?include=all` returns every version (including deprecated) under a `versions`
  array.

**Response `200`** (latest)

```json
{
  "data": {
    "identifier": "documents.create",
    "version": "v2",
    "name": "create_document",
    "surfaces": ["internal"],
    "requiredScopes": ["chat:write"],
    "agentCallable": true,
    "isActive": true,
    "deprecated": false,
    "deprecatedAt": null,
    "replacedBy": null,
    "removalDate": null
  },
  "meta": { "requestId": "req_abc123" }
}
```

**Response `404`** — No tool with that identifier.

#### `GET /api/v1/tools/{identifier}/versions/{version}`

Returns one specific version. `{version}` may be `v2` or a bare `2`.

**Response `200`** — the `ToolVersion` object (same shape as above).

**Response `404`** — That version was removed (past its grace period) or never
existed. The message points the caller at the latest version. This is the error a
skill or assistant pinned to a removed version receives.

---

## Data Model Reference

### GraphNode

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Auto-generated primary key |
| `nodeType` | string | Category (e.g. `decision`, `person`, `document`) |
| `nodeClass` | string | Sub-classification (e.g. `policy`, `budget`) |
| `name` | string | Display name |
| `description` | string\|null | Optional description |
| `metadata` | object | Arbitrary JSONB key-value pairs |
| `createdBy` | integer\|null | Creator's user ID |
| `createdAt` | ISO 8601 | Creation timestamp |
| `updatedAt` | ISO 8601 | Last update timestamp |

### GraphEdge

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Auto-generated primary key |
| `sourceNodeId` | UUID | Origin node (FK, cascade delete) |
| `targetNodeId` | UUID | Target node (FK, cascade delete) |
| `edgeType` | string | Relationship type (e.g. `informed_by`) |
| `metadata` | object | Arbitrary JSONB key-value pairs |
| `createdBy` | integer\|null | Creator's user ID |
| `createdAt` | ISO 8601 | Creation timestamp |

**Database constraints:**
- Unique constraint on `(sourceNodeId, targetNodeId, edgeType)` — multiple edge types between the same pair are allowed
- Check constraint prevents self-referencing edges (`sourceNodeId != targetNodeId`)
- Cascade delete: deleting a node removes all its edges

---

### Decisions

#### `POST /api/v1/graph/decisions`

Create a structured decision subgraph from a single payload. Requires `graph:write`.

This is a high-level endpoint that accepts a structured decision and automatically creates the appropriate nodes, edges, and relationships in the context graph. It also runs completeness validation (rule-based, with optional LLM enhancement).

**Request body:**

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `decision` | string | yes | 1-2000 chars — what was decided |
| `decidedBy` | string | yes | 1-500 chars — who proposed/made the decision |
| `reasoning` | string | no | max 5000 chars — rationale behind the decision |
| `evidence` | string[] | no | max 20 items, each 1-2000 chars |
| `constraints` | string[] | no | max 20 items, each 1-2000 chars |
| `conditions` | string[] | no | max 20 items — triggers to revisit |
| `alternatives_considered` | string[] | no | max 20 items — rejected alternatives |
| `relatedTo` | UUID[] | no | max 50 — existing node IDs to link via CONTEXT edges |
| `agentId` | string | no | max 200 chars — external agent identifier |
| `metadata` | object | no | Arbitrary key-value pairs (attached to decision node) |

**Graph mapping:**

| Input field | Node type | Edge type | Direction |
|------------|-----------|-----------|-----------|
| `decision` | `decision` | — | (root node) |
| `decidedBy` | `person` | `PROPOSED` | person → decision |
| `evidence[i]` | `evidence` | `INFORMED` | evidence → decision |
| `constraints[i]` | `constraint` | `CONSTRAINED` | constraint → decision |
| `reasoning` | `reasoning` | `PART_OF` | reasoning → decision |
| `conditions[i]` | `condition` | `CONDITION` | condition → decision |
| `alternatives_considered[i]` | `decision` (metadata: `{rejected: true}`) | `REJECTED` + `COMPARED_AGAINST` | person → alt (REJECTED), alt → decision (COMPARED_AGAINST) |
| `relatedTo[i]` | (existing node) | `CONTEXT` | related → decision |

All created nodes have `nodeClass: "decision"`. When `agentId` is provided, nodes include `metadata.source: "agent"` and `metadata.agentId`; otherwise `metadata.source: "api"`.

**Completeness scoring:**

The response includes a `completenessScore` (0-100) based on four criteria (25 points each):
1. At least one `decision` node
2. At least one `person` connected via `PROPOSED` or `APPROVED_BY`
3. At least one `evidence` or `constraint` connected via `INFORMED` or `CONSTRAINED`
4. At least one `condition` connected via `CONDITION`

If the `DECISION_CAPTURE_MODEL` setting is configured, an LLM-enhanced score may replace the rule-based score (with warnings). The scoring method is not guaranteed — always check `warnings` for actionable feedback.

**Example request:**

```bash
curl -X POST -H "Authorization: Bearer sk-your-key" \
  -H "Content-Type: application/json" \
  -d '{
    "decision": "Adopt Chromebooks for 1:1 student devices",
    "decidedBy": "Technology Committee",
    "evidence": ["TCO analysis showed 40% savings", "Staff survey preferred Chrome OS"],
    "constraints": ["$2M annual budget cap", "Must support state testing platform"],
    "conditions": ["Revisit if per-unit cost exceeds $400"],
    "alternatives_considered": ["Windows laptops", "iPads"],
    "agentId": "meeting-bot-v2"
  }' \
  "https://your-domain/api/v1/graph/decisions"
```

**Response `201`**

```json
{
  "data": {
    "decisionNodeId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "nodesCreated": 9,
    "edgesCreated": 10,
    "completenessScore": 100,
    "warnings": []
  },
  "meta": {
    "requestId": "req_abc123"
  }
}
```

**Response `400`** — Validation error (Zod issues) or missing `relatedTo` UUIDs.
**Response `401`** — Missing or invalid API key.
**Response `403`** — API key lacks `graph:write` scope.
**Response `500`** — Internal error.

---

## Voice API (Issue #872, #877)

### GET `/api/nexus/voice/availability`

Returns voice availability with a human-readable reason string. Clients call this before attempting a WebSocket connection.

**Auth:** Session cookie (not API key).

**Response `200`:**

```json
{
  "available": false,
  "reason": "Voice mode is disabled by administrator"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `available` | boolean | Whether voice mode is available for this user |
| `reason` | string? | Human-readable reason when unavailable |

**Caching:** `Cache-Control: max-age=30, private`. Server-side settings cache TTL is 5 minutes.

**Response `401`** — No authenticated session.
**Response `500`** — Internal error.

### WebSocket `/api/nexus/voice`

Bidirectional audio streaming for real-time voice conversations. See [`features/voice-api.md`](../../features/voice-api.md) for the full WebSocket protocol specification including message types, close codes, and connection flow.

---

## Atrium Content API (Issue #1055, Phase 5)

Routes under `/api/v1/content/*` manage Atrium **content objects** (documents and
artifacts), their **versions**, **visibility**, and **publishing**. They follow the
same v1 conventions as the graph endpoints and mirror the Atrium MCP tools 1:1 — the
same service layer backs every surface (server actions, REST, MCP), so there is no
privileged write path. See [`features/atrium-design-spec.md`](../../features/atrium-design-spec.md) §23.

**Auth:** Bearer only — an `sk-` API key or an OIDC bearer (JWT). There is **no**
session-cookie path for these endpoints. Every response carries `X-Request-Id` and
(for API-key callers) the `X-RateLimit-*` headers. The success envelope is
`{ "data": ..., "meta": { "requestId": ... } }`; errors are
`{ "error": { "code", "message", "details"? }, "requestId" }`.

**Scopes:**

| Scope | Grants |
|-------|--------|
| `content:read` | List content, get an object, list versions |
| `content:create` | Create content objects (and their initial version) |
| `content:update` | Update metadata, create versions, set visibility |
| `content:publish_internal` | Publish to / unpublish from a destination |
| `content:publish_public` | Publish to a public-facing destination without approval |

Staff API keys may hold up to `content:publish_internal`; `content:publish_public`
is administrator-held. A caller without it that requests a `public`-facing outcome is
not rejected — it returns `202` with `data.status = "approval_required"` and enters
the review queue (the §26.4 gate). This applies everywhere a request could reach
`visibilityLevel: "public"` or take a `public_web` publication offline, not just the
publish endpoint: `POST /content` (create at `visibility.level: "public"`),
`PATCH /content/{id}/visibility` (widen to `public`), `POST /content/{id}/publish`
(publish to `public_web`), and `DELETE /content/{id}/publish/{destination}`
(unpublish from `public_web` — taking public content down needs the same authority
as putting it up).

**Content error codes** (in addition to the shared `INVALID_TOKEN`,
`INSUFFICIENT_SCOPE`, `RATE_LIMIT_EXCEEDED`, and `INTERNAL_ERROR`):

| HTTP | Code | Description |
|------|------|-------------|
| 400 | `VALIDATION_ERROR` | Invalid query params or request body. `details` carries Zod issues. |
| 400 | `INVALID_JSON` | Request body is not valid JSON. |
| 400 | `CONTENT_VALIDATION` | Service-level input failure (e.g. unknown collection slug, missing body). |
| 403 | `CONTENT_FORBIDDEN` | The caller may not edit / act on this object. |
| 404 | `CONTENT_NOT_FOUND` | The object does not exist — or is not visible to the caller (reads are 404-masked). |
| 409 | `CONTENT_CONFLICT` | Slug collision or version-number race. |

> The public-publish gate surfaces as a `202` **success** whose body is
> `{ "data": { "status": "approval_required", "message": ... }, "meta": ... }`.
> `approval_required` is a `data.status` value, not an `error.code`.

---

### Content objects

#### `GET /api/v1/content`

List content objects the caller may view (permission-filtered server-side). Requires `content:read`.

**Query parameters:**

| Name | Type | Description |
|------|------|-------------|
| `kind` | `document` \| `artifact` | Filter by content kind |
| `collection` | string (slug or UUID) | Scope to one collection |
| `tag` | string | Filter by a single tag (exact match) |
| `status` | `draft` \| `published` \| `archived` | Filter by lifecycle status |
| `query` | string (1–200 chars) | Case-insensitive title substring search |

**Example request:**

```bash
curl -H "Authorization: Bearer sk-your-key" \
  "https://your-domain/api/v1/content?kind=document&status=published&tag=policy&query=acceptable%20use"
```

**Response `200`** — `meta.count` is the number of items returned.

```json
{
  "data": [
    {
      "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "kind": "document",
      "title": "AI Acceptable Use Policy",
      "slug": "ai-acceptable-use-policy",
      "ownerUserId": 1,
      "createdByActor": "human",
      "createdByAgentId": null,
      "collectionId": "c0ffee00-0000-4000-8000-000000000001",
      "visibilityLevel": "internal",
      "currentVersionId": "11111111-2222-4333-8444-555555555555",
      "sourceRef": null,
      "tags": ["policy"],
      "status": "published",
      "indexedAt": "2026-06-30T12:00:00.000Z",
      "createdAt": "2026-06-29T09:00:00.000Z",
      "updatedAt": "2026-06-30T12:00:00.000Z"
    }
  ],
  "meta": { "requestId": "req_abc123", "count": 1 }
}
```

---

#### `POST /api/v1/content`

Create a document or artifact. **Does not publish.** When `body` is supplied, an
initial version (v1) is snapshotted. Requires `content:create`.

**Request body:**

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `kind` | `document` \| `artifact` | yes | — |
| `title` | string | yes | 1-500 chars |
| `collectionId` | string | no | Collection slug or UUID; resolved server-side |
| `body` | string | no | markdown (document) or code (artifact). Omit to create no v1 |
| `bodyFormat` | `markdown` \| `html` \| `jsx` | no | — |
| `visibility` | object | no | `{ level, grants? }` (see Visibility below). Defaults to the collection default, else `private` |
| `tags` | string[] | no | — |

**Example request:**

```bash
curl -X POST -H "Authorization: Bearer sk-your-key" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "document",
    "title": "AI Acceptable Use Policy",
    "collectionId": "governance",
    "body": "# Acceptable Use\n\nDraft policy...",
    "bodyFormat": "markdown",
    "visibility": { "level": "group", "grants": [{ "kind": "role", "value": "staff" }] },
    "tags": ["policy"]
  }' \
  "https://your-domain/api/v1/content"
```

**Response `201`** — the created object joined with its current `version` and the
internal reader `url` (`/c/{slug}`).

```json
{
  "data": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "kind": "document",
    "title": "AI Acceptable Use Policy",
    "slug": "ai-acceptable-use-policy",
    "ownerUserId": 1,
    "createdByActor": "human",
    "collectionId": "c0ffee00-0000-4000-8000-000000000001",
    "visibilityLevel": "group",
    "currentVersionId": "11111111-2222-4333-8444-555555555555",
    "tags": ["policy"],
    "status": "draft",
    "version": {
      "id": "11111111-2222-4333-8444-555555555555",
      "objectId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "versionNumber": 1,
      "authorActor": "human",
      "bodyFormat": "markdown",
      "summary": null,
      "createdAt": "2026-06-30T12:00:00.000Z"
    },
    "url": "/c/ai-acceptable-use-policy"
  },
  "meta": { "requestId": "req_abc123" }
}
```

**Response `400`** — Validation error, or `CONTENT_VALIDATION` (e.g. unknown collection slug).
**Response `403`** — API key lacks `content:create`.
**Response `409`** — `CONTENT_CONFLICT` (slug collision).
**Response `202`** — approval required: `visibility.level: "public"` was requested (explicitly,
or inherited from a collection whose default is `public`) without `content:publish_public`.
Nothing is created; body is `{ "data": { "status": "approval_required", "message": ... }, "meta": ... }`.

---

#### `GET /api/v1/content/{id}`

Get a single object joined with its current version and reader `url`. View
permission is enforced server-side; objects the caller may not view return `404`
(not `403`). Requires `content:read`.

**Response `200`** — same shape as the create response (object + `version` + `url`).
**Response `404`** — `CONTENT_NOT_FOUND` (missing or not visible).

---

#### `PATCH /api/v1/content/{id}`

Update object **metadata only** — body changes go through the versions endpoint.
Requires `content:update`.

**Request body** (all optional):

| Field | Type | Constraints |
|-------|------|-------------|
| `title` | string | 1-500 chars |
| `tags` | string[] \| null | Replaces all tags; `null` clears them |
| `collectionId` | string \| null | Collection slug or UUID; `null` clears the collection |
| `status` | `draft` \| `published` \| `archived` | — |

**Example request:**

```bash
curl -X PATCH -H "Authorization: Bearer sk-your-key" \
  -H "Content-Type: application/json" \
  -d '{ "status": "published", "tags": ["policy", "governance"] }' \
  "https://your-domain/api/v1/content/a1b2c3d4-e5f6-7890-abcd-ef1234567890"
```

**Response `200`** — returns the updated object metadata (no `version`/`url`).
**Response `404`** — `CONTENT_NOT_FOUND`.

---

### Versions

#### `GET /api/v1/content/{id}/versions`

List the object's versions, newest first. View permission is enforced (404-masked)
before the list is exposed. Requires `content:read`.

**Response `200`**

```json
{
  "data": [
    {
      "id": "22222222-3333-4444-8555-666666666666",
      "objectId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "versionNumber": 2,
      "authorActor": "agent",
      "authorUserId": null,
      "authorAgentId": "policy-bot",
      "bodyFormat": "markdown",
      "bodyLocation": "atrium/objects/a1b2.../v2.md",
      "bodyInline": null,
      "summary": "Tightened the data-retention section",
      "createdAt": "2026-06-30T13:00:00.000Z"
    }
  ],
  "meta": { "requestId": "req_abc123", "count": 1 }
}
```

---

#### `POST /api/v1/content/{id}/versions`

Snapshot a new version from `body` and make it the current version. Requires `content:update`.

**Request body:**

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `body` | string | yes | min 1 char |
| `bodyFormat` | `markdown` \| `html` \| `jsx` | no | — |
| `summary` | string | no | max 2000 chars — change note |

**Example request:**

```bash
curl -X POST -H "Authorization: Bearer sk-your-key" \
  -H "Content-Type: application/json" \
  -d '{ "body": "# Acceptable Use (rev 2)...", "summary": "Tightened data retention" }' \
  "https://your-domain/api/v1/content/a1b2c3d4-e5f6-7890-abcd-ef1234567890/versions"
```

**Response `201`** — the object joined with its new current `version` (no `url`).
**Response `404`** — `CONTENT_NOT_FOUND`.
**Response `409`** — `CONTENT_CONFLICT` (version-number race).

---

### Visibility

#### `PATCH /api/v1/content/{id}/visibility`

Set the visibility `level` and (for `group`) the widening `grants`. The route loads
the object (enforcing view permission, 404-masked) and gates edit before mutating.
Requires `content:update`.

**Request body** (the Visibility object):

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `level` | `private` \| `group` \| `internal` \| `public` | yes | — |
| `grants` | `{ kind, value }[]` | no | Only meaningful when `level` is `group` |

`grants[].kind` is one of `role`, `building`, `department`, `grade`, `user`; `value` is the matching identifier.

**Example request:**

```bash
curl -X PATCH -H "Authorization: Bearer sk-your-key" \
  -H "Content-Type: application/json" \
  -d '{ "level": "group", "grants": [{ "kind": "building", "value": "HS" }] }' \
  "https://your-domain/api/v1/content/a1b2c3d4-e5f6-7890-abcd-ef1234567890/visibility"
```

**Response `200`**

```json
{
  "data": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "visibility": { "visibilityLevel": "group" }
  },
  "meta": { "requestId": "req_abc123" }
}
```

**Response `403`** — `CONTENT_FORBIDDEN` (caller may not edit this object).
**Response `404`** — `CONTENT_NOT_FOUND`.
**Response `202`** — approval required: `level: "public"` was requested without
`content:publish_public` — the same §26.4 gate `POST /content/{id}/publish` enforces,
so a `content:update`-only caller cannot reach "public" through this endpoint either.
Body is `{ "data": { "status": "approval_required", "message": ... }, "meta": ... }`.

---

### Publishing

#### `POST /api/v1/content/{id}/publish`

Publish the object's current version to a destination. Requires `content:publish_internal`.

**Request body:**

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `destination` | `intranet` \| `public_web` \| `schoology` \| `google` \| `okf` | yes | `okf` serializes the single object to a portable OKF concept bundle in S3 (internal-publish authority) |
| `visibility` | object | no | Optional visibility to apply alongside the publish |

**Public-publish gate (§26.4):** if `destination`/`visibility` is public-facing and
the caller lacks `content:publish_public`, the request is **not** published — it
returns `202` with `data.status = "approval_required"` and enters the review queue.

**Example request:**

```bash
curl -X POST -H "Authorization: Bearer sk-your-key" \
  -H "Content-Type: application/json" \
  -d '{ "destination": "intranet" }' \
  "https://your-domain/api/v1/content/a1b2c3d4-e5f6-7890-abcd-ef1234567890/publish"
```

**Response `200`** (published)

```json
{
  "data": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "destination": "intranet",
    "publishedVersionId": "11111111-2222-4333-8444-555555555555"
  },
  "meta": { "requestId": "req_abc123" }
}
```

**Response `202`** (approval required — public publish without `content:publish_public`)

```json
{
  "data": {
    "status": "approval_required",
    "message": "Public publishing requires approval; your request has been queued for review."
  },
  "meta": { "requestId": "req_abc123" }
}
```

**Response `403`** — API key lacks `content:publish_internal`, or `CONTENT_FORBIDDEN`.
**Response `404`** — `CONTENT_NOT_FOUND`.

---

#### `DELETE /api/v1/content/{id}/publish/{destination}`

Unpublish the object from a destination. **Idempotent:** unpublishing an object that
is not live at the destination returns `unpublished: false` rather than erroring.
`{destination}` is one of `intranet`, `public_web`, `schoology`, `google` (no `okf`:
an okf publication is a serialized S3 bundle with no live surface to take down).
Mirrors the MCP `unpublish_content` tool. Requires `content:publish_internal`.

**Public-publish gate (§26.4):** taking any public-facing destination
(`public_web`, `schoology`, `google`) offline requires the same
`content:publish_public` authority needed to publish it — `content:publish_internal`
alone can publish/unpublish `intranet` (the only internal-audience destination) but
cannot publish to, or tear down a live, public-facing destination.

**Response `200`**

```json
{
  "data": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "destination": "intranet",
    "unpublished": true
  },
  "meta": { "requestId": "req_abc123" }
}
```

**Response `400`** — Invalid or missing destination.
**Response `404`** — `CONTENT_NOT_FOUND`.
**Response `202`** — approval required: unpublishing `public_web` was requested without
`content:publish_public`. Body is
`{ "data": { "status": "approval_required", "message": ... }, "meta": ... }`.

---

### OKF interoperability (Phase 8, §36)

[Open Knowledge Format (OKF v0.1)](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing)
is a portable, vendor-neutral serialization for agent context: a directory of
markdown files with YAML frontmatter (one *concept* per file), plus two reserved
filenames — `index.md` (navigation) and `log.md` (change history). Atrium exposes
**export** (a collection → an OKF bundle) and **import** (a bundle → content) at
REST + MCP parity. A bundle is transported as a JSON manifest of files
(`{ files: [{ path, content }] }`), returned inline and persisted to S3.

**Frontmatter mapping (§36.1):** `type` ← `content_objects.kind` (required),
`title` ← title, `description` ← head-version summary, `resource` ← a prior
publication URL, `tags` ← tags, `timestamp` ← `updated_at`; the body is the head
version (documents inline, artifacts in a fenced code block).

#### `POST /api/v1/content/export/okf`

Export a collection subtree as an OKF bundle. Requires `content:read`.

**Request body:**

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `collectionId` | string | yes | Root collection slug or id |
| `audience` | `internal` \| `public` | no | Default `internal` |

**Permission-at-export (the security-critical surface, §36.2):** every object is
filtered by the caller's view permission — a student-identity bundle excludes
staff-only concepts. **Public bundles:** `audience: "public"` restricts the bundle
to `visibility_level = 'public'` objects and requires `content:publish_public`;
without it (including for EVERY autonomous agent) the request returns `202` with
`data.status = "approval_required"` and enters the review queue.

**Example request:**

```bash
curl -X POST -H "Authorization: Bearer sk-your-key" \
  -H "Content-Type: application/json" \
  -d '{ "collectionId": "mathematics", "audience": "internal" }' \
  "https://your-domain/api/v1/content/export/okf"
```

**Response `200`** (the bundle)

```json
{
  "data": {
    "okfVersion": "0.1",
    "generator": "psd-aistudio-atrium/okf-exporter@0.1",
    "rootCollectionId": "c1111111-2222-4333-8444-555555555555",
    "audience": "internal",
    "objectCount": 2,
    "collectionCount": 1,
    "files": [
      { "path": "index.md", "content": "---\ntype: \"index\"\ntitle: \"Mathematics\"\n---\n..." },
      { "path": "fractions.md", "content": "---\ntype: \"document\"\ntitle: \"Fractions\"\n---\n..." },
      { "path": "log.md", "content": "# Change history — Fractions\n..." }
    ],
    "location": "https://s3.../atrium/okf/.../exp.json?X-Amz-..."
  },
  "meta": { "requestId": "req_abc123" }
}
```

**Response `202`** (approval required — public bundle without `content:publish_public`)
Body is `{ "data": { "status": "approval_required", "message": ... }, "meta": ... }`.
**Response `403`** — API key lacks `content:read`. **Response `400`** — `CONTENT_VALIDATION` (unresolvable `collectionId`). **Response `404`** — `CONTENT_NOT_FOUND` (a root collection the caller cannot enter is masked as not-found).

---

#### `POST /api/v1/content/import/okf`

Import an OKF bundle into content. Requires `content:create`.

**Request body:**

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `files` | array of `{ path, content }` | yes | ≥ 1 file |
| `targetCollectionId` | string | no | Import the bundle root INTO this collection; a fresh root is created when omitted |

**Provenance (§36.3):** imported objects are **agent-authored**
(`actor_kind = 'agent'`, attributed to the seeded `atrium-importer` identity) and
created **private + draft** — never fabricated human authorship, never pre-widened.
The triggering caller is recorded in the audit trail.

**Retry semantics (not transactional):** import is additive and not wrapped in a
single transaction (`contentService.create` does its own tx + post-commit S3 IO
per object). A run that fails partway leaves the already-created private/draft
content in place, and a retry re-imports the whole bundle as **new** objects (no
path/`sourceRef` dedup; slugs auto-suffix). For idempotency, import into a fresh
`targetCollectionId` and, on failure, delete that partial collection before retrying.

**Response `201`**

```json
{
  "data": {
    "rootCollectionId": "d1111111-2222-4333-8444-555555555555",
    "collectionsCreated": 1,
    "objectCount": 2,
    "objects": [
      { "id": "...", "slug": "fractions", "title": "Fractions", "collectionId": "d1111111-..." }
    ]
  },
  "meta": { "requestId": "req_abc123" }
}
```

**Response `400`** — `CONTENT_VALIDATION` (empty bundle / no concept files).
**Response `403`** — API key lacks `content:create`, or the `atrium-content` capability (session).

---

## Atrium Content Data Model Reference

### ContentObject

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Object primary key |
| `kind` | `document` \| `artifact` | Content kind |
| `title` | string | Display title |
| `slug` | string | URL slug (reader path is `/c/{slug}`) |
| `ownerUserId` | integer | Owning user |
| `createdByActor` | `human` \| `agent` | Who created it |
| `createdByAgentId` | string \| null | Agent identifier when created by an agent |
| `collectionId` | UUID \| null | Owning collection |
| `visibilityLevel` | `private` \| `group` \| `internal` \| `public` | Effective visibility level |
| `currentVersionId` | UUID \| null | Current version pointer |
| `sourceRef` | object \| null | Provenance reference when imported |
| `tags` | string[] | Free-form tags |
| `status` | `draft` \| `published` \| `archived` | Lifecycle status |
| `indexedAt` | ISO 8601 \| null | Last search-index time |
| `createdAt` | ISO 8601 \| null | Creation timestamp |
| `updatedAt` | ISO 8601 \| null | Last update timestamp |

Create / get responses additionally include a `version` object (the current
`ContentVersion`, or `null`) and a `url` (the internal reader deep link).

### ContentVersion

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Version primary key |
| `objectId` | UUID | Parent object |
| `versionNumber` | integer | Monotonic version number |
| `authorActor` | `human` \| `agent` | Who authored the version |
| `authorUserId` | integer \| null | Authoring user |
| `authorAgentId` | string \| null | Authoring agent identifier |
| `bodyFormat` | `markdown` \| `html` \| `jsx` | Body format |
| `bodyLocation` | string | Storage pointer (e.g. S3 key) for the body |
| `bodyInline` | string \| null | Raw inline body for small artifacts — **untrusted** code; only render in a code editor or the cross-origin sandboxed iframe |
| `renderLocation` | string \| null | Rendered-output pointer |
| `proofDocRef` | string \| null | Proof / provenance document reference |
| `summary` | string \| null | Change summary |
| `createdAt` | ISO 8601 \| null | Creation timestamp |

### Visibility

| Field | Type | Description |
|-------|------|-------------|
| `level` | `private` \| `group` \| `internal` \| `public` | Base visibility |
| `grants` | `{ kind, value }[]` | Group widening; only meaningful when `level` is `group` |
| `grants[].kind` | `role` \| `building` \| `department` \| `grade` \| `user` | Dimension to widen along |
| `grants[].value` | string | Matching identifier for that dimension |

