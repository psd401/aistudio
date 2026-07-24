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
| Session | Browser cookie (`next-auth.session-token`) | Role-derived scopes (REV-SEC-161) |

> **Session scopes (REV-SEC-161):** A browser session is **not** granted wildcard
> (`*`) access. Its scopes are derived from the caller's roles via `ROLE_SCOPES`
> (`lib/api/auth-middleware.ts`), the same single source of truth used for API keys.
> A logged-in user therefore only satisfies `graph:write` if their role grants it
> (administrators do; staff receive `graph:read`). This closed a prior gap where
> every session received `["*"]` and any authenticated user could satisfy
> admin-only scope-gated routes with just their browser cookie.

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
| `status` | enum (`proposed` \| `accepted` \| `superseded` \| `rejected`) | Decision lifecycle filter (Issue #1252). Combine with `nodeType=decision&status=accepted` for the "current decision on X" query. Excludes NULL-status (non-decision) nodes. |
| `search` | string (1-100 chars) | Case-insensitive **lexical** (ILIKE) search on `name` and `description` |
| `q` | string (1-500 chars) | **Semantic** (embedding-based) search — returns paraphrase matches ranked by similarity (Issue #1252). Falls back to lexical search on the same text if embeddings are unavailable. Combine with `nodeType` to scope (e.g. `nodeType=decision`). |
| `limit` | integer (1-100) | Page size (default 50) |
| `cursor` | string | Pagination cursor (lexical results only; semantic results are unpaginated) |

When `q` is supplied, each result includes a `similarity` (0-1) score and the
response `meta.method` is `"semantic"` (or `"lexical-fallback"` if embedding failed).

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

#### `GET /api/v1/graph/nodes/{nodeId}/package`

Get a self-contained **decision package** for a node (Issue #1252): the decision
plus its evidence, constraints, reasoning, persons, conditions, outcomes, and
supersession chain, gathered by a depth-bounded, cycle-safe recursive CTE (graph
expansion). Requires `graph:read`.

**Query parameters:**

| Name | Type | Description |
|------|------|-------------|
| `depth` | integer (1-3) | Graph-expansion radius in hops (default 2) |

**Response `200`**

```json
{
  "data": {
    "decision": { "id": "…", "name": "Adopt PostgreSQL", "nodeType": "decision", "status": "accepted", "supersededAt": null, "depth": 0 },
    "persons": [ { "id": "…", "name": "Engineering", "nodeType": "person", "depth": 1 } ],
    "evidence": [ { "id": "…", "name": "Benchmarks", "nodeType": "evidence", "depth": 1 } ],
    "constraints": [],
    "reasoning": [],
    "conditions": [ { "id": "…", "name": "Revisit at 10TB", "nodeType": "condition", "depth": 1 } ],
    "outcomes": [],
    "policies": [],
    "edges": [ { "id": "…", "sourceNodeId": "…", "targetNodeId": "…", "edgeType": "SUPERSEDED_BY" } ],
    "supersessionChain": [ { "supersededId": "…old…", "supersededById": "…new…" } ],
    "depth": 2
  },
  "meta": { "requestId": "req_abc123", "depth": 2 }
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
| `metadata` | object | Arbitrary JSONB key-value pairs. Agent-authored captures include a typed `provenance` block (`extractionMethod`, `sourceRef`, `confidence`); auto-reused nodes include `dedup` (`matchedNodeId`, `similarity`) — Issue #1252 |
| `status` | string\|null | Decision lifecycle (Issue #1252): `proposed` \| `accepted` \| `superseded` \| `rejected`. Null for non-decision nodes |
| `supersededAt` | ISO 8601\|null | Set when a newer decision supersedes this one (Issue #1252) |
| `createdBy` | integer\|null | Creator's user ID |
| `createdAt` | ISO 8601 | Creation timestamp |
| `updatedAt` | ISO 8601 | Last update timestamp |

> `embedding` (512-dim pgvector, Issue #1252) also exists on the row for entity
> resolution + semantic search but is never returned in API responses.

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

This is a high-level endpoint that accepts a structured decision and automatically creates the appropriate nodes, edges, and relationships in the context graph. It also runs completeness validation (deterministic rule-based score, with optional LLM-authored advisory warnings).

All node/edge types are drawn from the closed decision vocabulary (`lib/graph/decision-framework.ts`) and enforced at write time. `relatedTo` UUIDs are de-duplicated; duplicate or self-referencing edges are rejected with a typed `400` validation error rather than a raw database error.

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
| `consulted` | string[] | no | max 20, each 1-500 — DACI parties consulted (person node + `CONSULTED` edge) — Issue #1252 |
| `notified` | string[] | no | max 20, each 1-500 — DACI parties notified/informed (person node + `NOTIFIED` edge) — Issue #1252 |
| `supersedes` | UUID[] | no | max 20 — existing decision node IDs this decision supersedes (each marked `status=superseded` + `SUPERSEDED_BY` edge) — Issue #1252 |
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
| `alternatives_considered[i]` | `decision` (metadata: `{rejected: true}`, `status: rejected`) | `REJECTED` + `COMPARED_AGAINST` | person → alt (REJECTED), alt → decision (COMPARED_AGAINST) |
| `consulted[i]` | `person` | `CONSULTED` | decision → person |
| `notified[i]` | `person` | `NOTIFIED` | decision → person |
| `supersedes[i]` | (existing `decision`) | `SUPERSEDED_BY` | old → new; old node set `status=superseded` + `supersededAt` |
| `relatedTo[i]` | (existing node) | `CONTEXT` | related → decision |

All created nodes have `nodeClass: "decision"`. The primary decision is stamped `status: "accepted"`. When `agentId` is provided, nodes include `metadata.source: "agent"` and `metadata.agentId`; otherwise `metadata.source: "api"`. Every node/edge carries a typed `metadata.provenance` block (Issue #1252). Person/evidence/policy nodes are deduplicated against existing nodes at write time (entity resolution) — the response `warnings` array surfaces any auto-reuse or near-duplicate candidates.

**Completeness scoring:**

The response includes a `completenessScore` (0-100) based on four criteria (25 points each):
1. At least one `decision` node
2. At least one `person` connected via `PROPOSED` or `APPROVED_BY`
3. At least one `evidence` or `constraint` connected via `INFORMED` or `CONSTRAINED`
4. At least one `condition` connected via `CONDITION`

The rule-based score is **authoritative** — it is deterministic and auditable, and the returned `completenessScore` always reflects it. If the `DECISION_CAPTURE_MODEL` setting is configured, an LLM pass runs and may **append advisory warnings/insights** to `warnings`; it never changes the numeric score. When `completenessMethod` is `"llm-enhanced"`, advisory warnings were appended; `"rule-based"` means the LLM pass was unavailable or failed (LLM scoring never blocks a capture). Always check `warnings` for actionable feedback.

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
    "completenessMethod": "rule-based",
    "warnings": []
  },
  "meta": {
    "requestId": "req_abc123"
  }
}
```

**Response `400`** — Validation error (Zod issues), missing `relatedTo` UUIDs, an off-vocabulary node/edge type, or a self-referencing / duplicate edge. Returns a typed error message, never a raw database string.
**Response `401`** — Missing or invalid API key.
**Response `403`** — API key lacks `graph:write` scope.
**Response `500`** — Internal error.

---

## Assistant execution runtime files

`POST /api/v1/assistants/{id}/execute` and
`POST /api/v1/assistants/{id}/conversations` accept the same structured
`inputs` object used by Assistant Architect. A `file_upload` value can contain
an opaque canonical temporary-attachment marker returned by the authenticated
staging API:

```json
{
  "inputs": {
    "question": "Summarize the rollout risks",
    "plan": "[[repository-attachment:v1:123e4567-e89b-42d3-a456-426614174000:44:implementation-plan.pdf]]"
  }
}
```

Clients must treat this marker as opaque and must not construct or edit it.
At most 10 distinct temporary sources may appear in one execution input object.

Before creating an execution row, async polling job, conversation, or first
conversation message, the server:

1. resolves every binding/item pair as the executing `userId`;
2. accepts only an active, unexpired durable or ephemeral repository and active
   item owned by that user;
3. replaces the caller-carried filename with the authoritative repository item
   name and removes binding/item identifiers from persisted and provider-facing
   input values;
4. unions every resolved repository with each prompt's configured repositories
   for both eager retrieval and vector/keyword/hybrid repository tools; and
5. reapplies the executing principal's current repository ACL before execution,
   inside retrieval, and inside each repository tool.

Assistant ownership never lends repository access. The synchronous REST path,
the `Accept: application/json` async-job path, and MCP
`execute_assistant` all use the same execution service and authorization rules.
The conversation endpoint reuses the exact server-prepared input for execution,
so it does not persist raw marker data or resolve the source twice. It binds
temporary references to the new owned conversation before the first message
write and records only the bounded resolved repository IDs in server-owned
conversation metadata. If binding or that first write fails, the empty
conversation is removed and the attachment remains retryable.

`POST /api/v1/assistants/{id}/conversations/{cid}/messages` and the matching
history route require the conversation's server-owned assistant ID to match
`{id}`; a mismatched path returns the same `404` as a missing conversation.
Before parsing or persisting a follow-up, the server unions all prompt-bound
repositories with the conversation's runtime repositories and rechecks the
executing principal's current ACL. The model receives tokenizer-bounded hybrid
retrieval context and repository tools; durable history retains only the
caller's original message text, not injected source content.

**Authentication and scopes:** Bearer API key or authenticated session.
Requires `assistants:execute`, `assistants:*`,
`assistant:{id}:execute`, or `*`, plus per-resource access to the assistant and
every model/repository used by the run.

**Streaming request:**

```bash
curl -N -X POST \
  -H "Authorization: Bearer sk-your-key" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"inputs":{"question":"Summarize the rollout risks","plan":"[[repository-attachment:v1:123e4567-e89b-42d3-a456-426614174000:44:implementation-plan.pdf]]"}}' \
  "https://your-domain/api/v1/assistants/17/execute"
```

**Async response `202`:**

```json
{
  "data": {
    "jobId": "123e4567-e89b-42d3-a456-426614174111",
    "status": "pending",
    "pollUrl": "/api/v1/jobs/123e4567-e89b-42d3-a456-426614174111"
  },
  "meta": {
    "requestId": "req_abc123"
  }
}
```

**Conversation response `200`:** SSE response with
`X-Conversation-Id: <uuid>`. The first persisted user message contains a safe
label such as `[Attached repository content: implementation-plan.pdf]`, never
the opaque marker.

**Response `400`** — Input shape/size failure, more than 10 temporary sources,
or a missing, foreign, expired, or otherwise unavailable temporary source.
Every unavailable-source variant returns the same
`VALIDATION_ERROR: Temporary repository input is unavailable`; the conversation
and async job are not created.

**Response `401`** — Missing or invalid authentication.

**Response `403`** — Missing assistant execution scope or current
assistant/model/repository access.

**Response `404`** — Assistant not found, assistant execution is disabled, or a
conversation does not belong to the assistant ID in the path.

**Response `500`** — Provider, persistence, or other internal execution failure.

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
| `content:delete` | Hard-delete a content object (owner/admin only — service-gated) |
| `content:publish_internal` | Publish to / unpublish from a destination |
| `content:publish_public` | Publish to a public-facing destination without approval |
| `content:delegate` | Mint short-lived delegated tokens (`POST /api/v1/agents/delegated-token`) — agent-held authority, never present in a minted token |

Staff API keys may hold up to `content:publish_internal`; `content:publish_public`
is administrator-held. A caller without it that requests a `public`-facing outcome on
an EXISTING object is not rejected — it returns `202` with `data.status =
"approval_required"` and enters the review queue (the §26.4 gate):
`PATCH /content/{id}/visibility` (widen to `public`), `POST /content/{id}/publish`
(publish to `public_web`), and `DELETE /content/{id}/publish/{destination}`
(unpublish from `public_web` — taking public content down needs the same authority
as putting it up). Each of these persists a durable `content_publish_requests` row
that an admin approves at /admin/atrium; approving a `publish` replays the PINNED
raise-time version (issue #1118), not a newer edited head.

`POST /content` (create at `visibility.level: "public"`) is the ONE exception: rather
than block, it uses **create-as-private** (issue #1118) — the object is created
`private` (returned `201`) and a `visibility_widen` request is queued for it. Inspect
`data.visibilityLevel` in the `201` body to see whether the requested `public` was
applied or downgraded.

**Mutation idempotency and optimistic concurrency (#1287):**

- `POST /content`, `POST /content/{id}/versions`, and
  `POST /content/{id}/publish` accept `Idempotency-Key` (1-255 visible ASCII
  characters).
- Keys are scoped by deployment environment, authenticated principal,
  OAuth-client/API-key identity, method, and canonical route. Only SHA-256 key
  and semantic-request digests are stored; raw keys and request bodies are not.
- Repeating the same scoped key and request within seven days returns the original
  status/body and safe response headers with `Idempotency-Replayed: true`.
  Reusing it with different input returns `409 IDEMPOTENCY_KEY_REUSED`.
- Terminal responses below HTTP 500 are retained. A returned 5xx releases the
  reservation so retrying with the same key can execute again; a thrown or
  interrupted execution remains pending so an ambiguous mutation is not repeated.
- A concurrent or interrupted request keeps its durable reservation and returns
  retryable `409 IDEMPOTENCY_IN_PROGRESS` (`Retry-After: 1`) rather than running a
  second mutation. Completed response payloads are field-encrypted with the
  existing Secrets Manager-backed application DEK. Expired records are removed
  in bounded 500-row sweeps by hourly scheduled maintenance, with opportunistic
  sweeps retained as a fallback.
- `GET /content/{id}` returns a strong ETag containing `currentVersionId` (or
  `"none"`). Send that ETag as `If-Match` on version creation to prevent lost
  updates. A stale value returns `412 VERSION_PRECONDITION_FAILED` before body
  screening, S3 writes, audit/event emission, or DB mutation. The successful
  `201` returns the new head ETag. Omitting `If-Match` preserves existing
  last-writer behavior for older clients.
- Publish accepts the same `If-Match` precondition. The service rechecks it while
  holding the object lock, so a concurrent version advance returns `412` without
  publishing or queuing approval. A successful `200` returns the pinned version
  as the response ETag.

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
| 409 | `IDEMPOTENCY_KEY_REUSED` | The scoped key was already used for different semantic input. |
| 409 | `IDEMPOTENCY_IN_PROGRESS` | The scoped operation is pending/interrupted; retry later without changing the key. |
| 412 | `VERSION_PRECONDITION_FAILED` | `If-Match` does not match the current version; details include expected/current ids. |
| 503 | `CONTENT_STORAGE_ERROR` | Canonical source storage is unavailable, oversized, or invalid; storage coordinates are not exposed. |

> The public-publish gate surfaces as a `202` **success** whose body is
> `{ "data": { "status": "approval_required", "message": ... }, "meta": ... }`.
> `approval_required` is a `data.status` value, not an `error.code`.

---

### Collection discovery (#1286)

#### `GET /api/v1/content/collections?shape=tree|flat`

Returns the same requester-visible hierarchy as `collectionService.tree(req)`.
Requires `content:read`. Filtering and visible-object counts are permission-pushed
on the server; a hidden collection is never loaded into the client or exposed
through a secondary id/name lookup.

- `shape=tree` (default) retains nested `children`.
- `shape=flat` walks that tree in stable Atrium position/name pre-order, omits
  `children`, and retains the full name `path` for compact extension/native pickers.
- A token that also holds `content:create` receives `selectableForCreate` on every
  returned node. The decision lives in the collection service so future collection
  author ACLs can narrow it without an API contract change.

```json
{
  "data": [
    {
      "id": "c0ffee00-0000-4000-8000-000000000001",
      "name": "Technology Guides",
      "slug": "technology-guides",
      "parentId": null,
      "path": ["Technology Guides"],
      "defaultVisibilityLevel": "internal",
      "visibleObjectCount": 42,
      "selectableForCreate": true,
      "children": []
    }
  ],
  "meta": { "requestId": "req_abc123", "shape": "tree", "count": 1 }
}
```

`400 VALIDATION_ERROR` is returned for an invalid `shape`; normal auth/scope
failures are `401`/`403`. A slug/UUID selected from this response is passed to
`POST /content` unchanged. If it is deleted before create, the existing typed
`400 CONTENT_VALIDATION` collection-not-found response is returned.

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
| `body` | string | no | markdown (document) or code (artifact). Omit to create no v1. base64 when `codeEncoding: "base64"` |
| `bodyFormat` | `markdown` \| `html` \| `jsx` | no | — |
| `codeEncoding` | `base64` | no | Transit encoding for `body` (see below) |
| `visibility` | object | no | `{ level, grants? }` (see Visibility below). Defaults to the collection default, else `private` |
| `tags` | string[] | no | — |
| `sourceRef` | object | no | Create-only typed provenance; see Capture provenance below |

**Capture provenance (#1290):** Atrium Capture may send
`sourceRef: { type: "capture", provider, externalId, clientSurface, clientVersion,
capturedAt, sourceOrigins? }`. `clientSurface` is `browser` or `mac`; identifiers
are bounded and unknown fields are rejected. At most 20 `sourceOrigins` may be
sent. Only HTTP(S) origins are retained: paths, queries, and fragments are
discarded, credentials and invalid/non-network URLs are rejected, duplicates are
removed, and district policy can disable origin retention entirely with
`ATRIUM_CAPTURE_SOURCE_ORIGINS_ENABLED=false`. The reference is immutable through
metadata updates. `(owner, provider, externalId)` is unique for capture references,
so a permanently repeated recorder session returns `409 CONTENT_CONFLICT` without
creating a second object. Audit/support records include only the provider,
external id, and client surface—never captured steps, typed values, or page text.

**Artifact code with JS/CSS — `codeEncoding: "base64"`:** artifacts are self-contained
HTML/JS/CSS, so their code legitimately contains `<script>`, `<style>`, and inline
`style="…"`. The edge WAF (AWS managed `CrossSiteScripting_BODY`) inspects every raw
request body and BLOCKS that markup with a bare `403` (the request never reaches the
app). To send it, set `codeEncoding: "base64"` and put the **base64-encoded** body in
`body`; the server decodes it BEFORE the §28.3 screening and the decoded-size cap
(max 5,000,000 decoded bytes) run, so screening always operates on the real content.
Invalid base64 → `400 CONTENT_VALIDATION`. base64's alphabet carries no XSS signature,
so the WAF stays fully active for every other request. Omit `codeEncoding` for plain
text/markdown (raw body — unchanged behavior). The same field is accepted by
`POST /content/{id}/versions`. Artifact code is rendered only inside a cross-origin
sandboxed iframe (§28.1), never on the app origin.

**Example request:**

```bash
curl -X POST -H "Authorization: Bearer sk-your-key" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: create-policy-2026-07-23" \
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

**Example — an artifact with JS/CSS (base64):**

```bash
# body is base64("<html><style>…</style><script>…</script></html>")
curl -X POST -H "Authorization: Bearer sk-your-key" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "artifact",
    "title": "Enrollment Chart",
    "bodyFormat": "html",
    "codeEncoding": "base64",
    "body": "PGh0bWw+PHN0eWxlPi4uLjwvc3R5bGU+PHNjcmlwdD4uLi48L3NjcmlwdD48L2h0bWw+"
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

**Create-as-private (issue #1118):** requesting `visibility.level: "public"` (explicitly,
or inherited from a collection whose default is `public`) without `content:publish_public`
is NOT rejected and does NOT return `202`. The object is created at
`visibilityLevel: "private"` (returned in the `201` body) and a durable
`visibility_widen` request is queued for it — an admin approves it at /admin/atrium to
make it public. Inspect `data.visibilityLevel` to see whether `public` was applied or
downgraded to `private`.

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

#### `DELETE /api/v1/content/{id}`

**Hard-delete** a content object — permanently removes it and every dependent row
(all versions, publications, live-collab state, comments, embed links, visibility
grants, publish-approval requests, retrieval-index entry) plus its S3 bodies.
Irreversible — prefer `PATCH { "status": "archived" }` for reversible cleanup.
Requires `content:delete`.

Guards (in order — an unviewable object never reveals its existence):

- `404 CONTENT_NOT_FOUND` — the object does not exist, or the caller may not view it.
- `403 CONTENT_FORBIDDEN` — viewable but the caller is not the OWNER (nor an admin).
  A `content:delete` key can only delete content its owner owns.
- `409 CONTENT_CONFLICT` — the object is still **live** at a publish destination.
  Delete never auto-unpublishes; unpublish from every destination first, then delete.

Any other kind/status (draft, archived, private, internal) is deletable — the guards
above are the protection, not the lifecycle status. A `delete` row is appended to the
content audit trail (capturing the removed title/kind/owner) before the row vanishes.

**Example request:**

```bash
curl -X DELETE -H "Authorization: Bearer sk-your-key" \
  "https://your-domain/api/v1/content/a1b2c3d4-e5f6-7890-abcd-ef1234567890"
```

**Response `200`:**

```json
{
  "data": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "slug": "field-trip-form",
    "title": "Field Trip Form",
    "kind": "document",
    "versionsDeleted": 3
  },
  "meta": { "requestId": "req_..." }
}
```

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
For lossless optimistic concurrency, first read `ETag` from
`GET /api/v1/content/{id}` and send it as `If-Match`. Use `If-Match: "none"` only
when the object must not yet have a head version.

**Request body:**

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `body` | string | yes | min 1 char. base64 when `codeEncoding: "base64"` |
| `bodyFormat` | `markdown` \| `html` \| `jsx` | no | — |
| `codeEncoding` | `base64` | no | Set `base64` when `body` is artifact code with `<script>`/`<style>` — decoded server-side before screening/size cap (see `POST /content`). Invalid base64 → 400 |
| `summary` | string | no | max 2000 chars — change note |

**Example request:**

```bash
curl -X POST -H "Authorization: Bearer sk-your-key" \
  -H "Content-Type: application/json" \
  -H 'If-Match: "11111111-2222-4333-8444-555555555555"' \
  -H "Idempotency-Key: update-policy-rev-2" \
  -d '{ "body": "# Acceptable Use (rev 2)...", "summary": "Tightened data retention" }' \
  "https://your-domain/api/v1/content/a1b2c3d4-e5f6-7890-abcd-ef1234567890/versions"
```

**Response `201`** — the object joined with its new current `version` (no `url`);
the `ETag` header is the new `currentVersionId`.
**Response `404`** — `CONTENT_NOT_FOUND`.
**Response `409`** — `CONTENT_CONFLICT` (version-number race).
**Response `412`** — `VERSION_PRECONDITION_FAILED`; no screening or side effects
occurred.

---

### Canonical source reads (#1288)

- `GET /api/v1/content/{id}/source` reads the current committed snapshot.
- `GET /api/v1/content/{id}/versions/{versionId}/source` reads a specific retained
  immutable version.

Both require `content:read` and run the normal object `canView` check before the
version lookup or storage read. An invisible object, missing version, or a version
that belongs to another object all return `404 CONTENT_NOT_FOUND`; version ids
cannot be used to probe unrelated content.

```json
{
  "data": {
    "objectId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "versionId": "22222222-3333-4444-8555-666666666666",
    "versionNumber": 4,
    "bodyFormat": "markdown",
    "body": "# Guide title\n...",
    "sha256": "base64url-sha256"
  },
  "meta": { "requestId": "req_abc123" }
}
```

The body is the exact UTF-8 string supplied at snapshot time: document markdown
comes from its immutable `source.md`, small artifacts from `body_inline`, and
larger artifacts from their immutable Atrium object. Storage is uncompressed; no
decompression or content-encoding transform occurs. Reads are capped at the
existing 5,000,000-byte decoded-body limit. A storage failure returns typed
`503 CONTENT_STORAGE_ERROR` without bucket names, object keys, or presigned URLs.

The `ETag` is the quoted version id. `If-None-Match` (including weak/list
validators) returns `304` with no body. The current alias uses
`Cache-Control: private, no-store` because its head can change. Specific immutable
versions use `private, no-cache, must-revalidate`: their bytes and ETag do not
change, but every reuse revalidates permission so a visibility revocation takes
effect. These endpoints expose committed snapshots only, never unsnapshotted live
Proof/collaborative state.

---

### Immutable authored assets (#1284)

Documents reference uploaded PNG/JPEG/WebP images with a canonical, portable
Markdown directive:

```md
::atrium-asset{id="11111111-2222-4333-8444-555555555555" alt="Enrollment chart"}
```

The editor, internal reader, and public reader all resolve that directive through
the same same-origin byte route. A storage URL is never persisted in Markdown or
returned in metadata.

Upload flow:

1. `POST /api/v1/content/{id}/assets` with `content:update`, object edit
   permission, filename, MIME, byte length, base64url SHA-256, purpose, and
   optional pixel dimensions.
2. `PUT` the exact bytes to the 15-minute presigned URL using the exact
   `Content-Type` and `x-amz-checksum-sha256` headers returned by step 1.
3. `POST /api/v1/content/{id}/assets/{assetId}/complete` with the same SHA-256.
   Completion is idempotent once the asset is `ready`.
4. Insert the returned `embedRef` into document Markdown and create a version.
   Snapshot creation rejects references that are unready, missing, or owned by a
   different object, then pins the authoritative asset set in
   `content_version_assets`.

```json
{
  "filename": "enrollment.png",
  "contentType": "image/png",
  "byteLength": 48321,
  "sha256": "base64url-sha256",
  "purpose": "document_image",
  "width": 1600,
  "height": 900
}
```

Initiation returns safe asset metadata plus:

```json
{
  "upload": {
    "method": "PUT",
    "url": "https://s3-presigned.example/...",
    "headers": {
      "content-type": "image/png",
      "x-amz-checksum-sha256": "base64-sha256"
    },
    "expiresAt": "2026-07-24T12:15:00.000Z"
  }
}
```

Completion verifies the exact declared byte length and digest, byte-signature MIME,
decodability, single-frame constraint, 12,000-pixel dimension cap, and 40-million
pixel cap. It then applies orientation, strips EXIF/XMP/IPTC and other metadata,
and re-encodes a normalized image. The untrusted original lives only under the
short-lived `atrium/pending-assets/` prefix; lifecycle policy expires that prefix
after one day. Ready bytes are written once under the immutable
`atrium/objects/{objectId}/assets/{assetId}` key. A hard object delete removes both
prefixes.

`GET /api/v1/content/{id}/assets` and
`GET /api/v1/content/{id}/assets/{assetId}` require `content:read` and the normal
object audience check. They never expose storage keys. The same-origin
`GET /api/v1/content/assets/{assetId}/bytes` route rechecks authorization on every
read and masks all denied cases as `404`: authenticated readers must be in the
current object audience; anonymous readers are admitted only when the asset is
pinned to the exact version in a live `public_web` publication and the object is
currently public. Unpublished, private, unready, or unreferenced assets are never
publicly readable. Responses are `nosniff`, `private, no-store`, and carry an
ETag derived from the normalized digest.

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

`grants[].kind` is one of `role`, `building`, `department`, `grade`, `user`, `group`; `value` is the matching identifier (for `group`, the synced Google group's lowercase email).

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
Supply the strong ETag from `GET /content/{id}` in `If-Match` to prevent a
concurrent head change from publishing an unintended version. The service checks
the precondition again under lock.

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
  -H "Idempotency-Key: publish-policy-intranet" \
  -H 'If-Match: "11111111-2222-4333-8444-555555555555"' \
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
**Response `412`** — `VERSION_PRECONDITION_FAILED`; the object head changed.

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

### Delegated agent tokens (§26.1, Epic #1059)

#### `POST /api/v1/agents/delegated-token`

Exchange an autonomous agent's OAuth client-credentials JWT for a **short-lived
(300 s) delegated token** that acts on behalf of a named human user. Requires the
agent-held `content:delegate` scope, and the caller must be an **OIDC agent
bearer** (a JWT whose client id maps to an active `agent_identities` row) — a
session or `sk-` API key cannot mint even if it holds the scope, and a delegated
token cannot re-mint. The returned `access_token` is used as the Bearer token on
`/api/v1/content/*`, where it resolves to an `agent-delegated` requester bound to
the named user (`isAdmin` forced false).

**Request body:**

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `delegated_for` | integer | yes | Positive user id of the human to act for |
| `scope` | string | no | Space-delimited narrowing (≤ 500 chars). Omit for the full grantable intersection |

**Scope bounding:** minted scope = requested ∩ the agent's content scopes ∩ the
user's role-derived content scopes. It never includes `content:delegate`, and
includes `content:publish_public` only when the user is an administrator AND the
agent holds it. An empty intersection returns `403 INSUFFICIENT_SCOPE` — no token.

**Token claims:** `sub` is the low-privilege **system user** (§26.5), not the
human — a surface that does not honor `delegated_for` resolves the token to the
system account, not the full human. The human is named by the **numeric**
`delegated_for` claim; `act.sub` carries the agent's (non-numeric) client id for
audit.

**Stateless / non-revocable:** the token is signed by the platform OIDC signer
and is not persisted — it cannot be revoked before expiry. The 300-second TTL is
the mitigation; treat the minted token as single-task-scoped.

**Example request:**

```bash
curl -X POST -H "Authorization: Bearer <agent-oidc-jwt>" \
  -H "Content-Type: application/json" \
  -d '{ "delegated_for": 42, "scope": "content:read content:create" }' \
  "https://your-domain/api/v1/agents/delegated-token"
```

**Response `200`**

```json
{
  "data": {
    "access_token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
    "token_type": "Bearer",
    "expires_in": 300,
    "scope": "content:create content:read",
    "delegated_for": 42
  },
  "meta": { "requestId": "req_abc123" }
}
```

**Response `400`** — `VALIDATION_ERROR` (missing/non-positive `delegated_for`, `scope` over 500 chars).
**Response `403`** — `INSUFFICIENT_SCOPE` (caller lacks `content:delegate`, or the scope intersection is empty — including for an **unknown** `delegated_for` user, which has no grantable scopes) or `FORBIDDEN` (session/`sk-` caller, no active agent identity, or a delegated token attempting to re-mint). An unknown user is deliberately indistinguishable from a role-less one (same `INSUFFICIENT_SCOPE`) so a delegation-capable agent cannot enumerate valid user ids.
**Response `500`** — `CONFIGURATION_ERROR` (`ATRIUM_SYSTEM_USER_ID` not configured).

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
| `sourceRef` | typed object \| null | Create-only provenance (`capture`, `upload`, `object`, `chat`, `okf`, or `none`); known variants reject additional properties |
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
| `grants[].kind` | `role` \| `building` \| `department` \| `grade` \| `user` \| `group` | Dimension to widen along (`group` = synced Google group email) |
| `grants[].value` | string | Matching identifier for that dimension |
