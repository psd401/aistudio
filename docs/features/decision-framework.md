# Decision Framework (Issue #680)

Part of Epic #675 — Context Graph Decision Capture Layer.

## Overview

Shared vocabulary and validation rules for decision capture in the context graph. All three capture channels (structured forms, conversational AI, MCP tools) use these definitions.

## Key Files

- `lib/graph/decision-framework.ts` — Node types, edge types, type guards, completeness validation, prompt getter
- `lib/graph/index.ts` — Barrel export
- `tests/unit/lib/graph/decision-framework.test.ts` — 30 unit tests

## Settings Dependency

The LLM prompt fragment is stored in the **settings table**, not in code.

| Key | Category | Description |
|-----|----------|-------------|
| `DECISION_FRAMEWORK_PROMPT` | `ai` | System prompt fragment describing node/edge types and completeness criteria |

This setting **must exist** in the database. `getDecisionFrameworkPrompt()` calls `getRequiredSetting()` and will throw if the setting is missing.

### Usage

```typescript
import { getDecisionFrameworkPrompt } from "@/lib/graph"

// In a system prompt for conversational or MCP-based capture:
const frameworkPrompt = await getDecisionFrameworkPrompt()
```

### Seeding

For local development, run after `npm run db:seed`:

```sql
INSERT INTO settings (key, value, description, category, is_secret)
VALUES (
  'DECISION_FRAMEWORK_PROMPT',
  '...prompt text...',
  'LLM system prompt fragment for decision capture in the context graph.',
  'ai',
  false
)
ON CONFLICT (key) DO NOTHING;
```

The full prompt text is in `DEFAULT_DECISION_FRAMEWORK_PROMPT` in `decision-framework.ts` for reference.

## Completeness Criteria

A decision subgraph is "complete" when it has:

1. At least one `decision` node
2. At least one `person` connected via `PROPOSED` or `APPROVED_BY`
3. At least one `evidence` or `constraint` connected via `INFORMED` or `CONSTRAINED`
4. At least one `condition` connected via `CONDITION`

Use `validateDecisionCompleteness(nodes, edges)` to check.

## Decision Lifecycle, Entity Resolution & Retrieval (Issue #1252)

Builds on the unified write path (#1251) — all additions are enforced in the
shared `persistDecisionSubgraph()` so every channel (REST, MCP, chat) inherits
them.

### Lifecycle status + supersession

- `graph_nodes.status` (nullable, `decision` nodes only): `proposed` | `accepted`
  | `superseded` | `rejected`. A captured decision defaults to `accepted`;
  rejected alternatives are `rejected`.
- `graph_nodes.superseded_at` is set when a newer decision supersedes an older one.
- **Mechanism**: any `SUPERSEDED_BY` edge (old decision → new decision) flips the
  SOURCE node to `status=superseded` + `superseded_at=now()`. REST/MCP express
  this with the `supersedes: [uuid]` field; the chat channel proposes the edge
  directly. `"what's the current decision on X"` becomes a `status='accepted'`
  filter (partial index `idx_graph_nodes_type_status`) instead of a traversal.

### DACI accountability edges

- `CONSULTED` (decision → person) and `NOTIFIED` (decision → person) capture the
  DACI "Consulted" / "Informed" parties. REST/MCP fields: `consulted[]`, `notified[]`.
- `SAME_AS` is available for non-destructive entity canonicalization.

### Entity resolution (dedup) at capture

`person` / `evidence` / `policy` candidates are embedded (512-dim, via the
direct-Bedrock helper `lib/graph/graph-embeddings.ts` — **not** the repository
`generateEmbedding` pipeline) and compared to existing same-type nodes before
insert:

| Cosine similarity | Action |
|-------------------|--------|
| ≥ `0.90` | auto-reuse the existing node, record `metadata.dedup`, emit a warning |
| `0.75`–`0.90` | create new, surface candidate matches in `warnings` / `propose_decision` |
| < `0.75` | create new silently |

Never destructive — reuse points a mention at an existing node; merges never
happen automatically. If the embedding call fails, capture proceeds **without**
dedup (a warning is returned) — a decision is never lost.

### Retrieval

- `getDecisionPackage(nodeId)` (`lib/graph/decision-retrieval.ts`) returns one
  self-contained package (decision + evidence/constraints/reasoning/persons/
  conditions/outcomes + supersession chain) via a depth-bounded, cycle-safe
  recursive CTE. Exposed as MCP `get_decision_graph` and
  `GET /api/v1/graph/nodes/{id}/package`.
- `semanticSearchNodes(q)` returns paraphrase matches (embedding-based, HNSW).
  Exposed as `?q=` on `GET /api/v1/graph/nodes` and the `q` arg on MCP
  `search_decisions`; both fall back to lexical ILIKE if embeddings are unavailable.

### Settings

| Key | Category | Default | Description |
|-----|----------|---------|-------------|
| `GRAPH_EMBEDDING_MODEL_ID` | `ai` | `amazon.titan-embed-text-v2:0` | Bedrock model for graph embeddings. The `embedding` column is fixed at 512 dims — a different-dimension model requires a re-embed backfill. |
