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
