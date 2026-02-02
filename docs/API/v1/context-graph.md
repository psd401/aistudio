# Context Graph API v1

REST API for managing context graph nodes and edges. Part of Epic #674 (External API Platform).

**Base URL:** `/api/v1`
**OpenAPI Spec:** [`docs/API/v1/openapi.yaml`](./openapi.yaml)

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
