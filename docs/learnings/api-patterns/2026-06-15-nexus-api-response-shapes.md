---
title: Nexus API response shapes — messages endpoint returns { messages, conversation, pagination }, not { messages, total, hasMore }
category: api-patterns
tags:
  - nexus
  - api
  - response-shape
  - pagination
  - e2e
severity: medium
date: 2026-06-15
source: auto — /lfg issue #154
applicable_to: project
---

## What Happened

PR #1014 (Nexus E2E test suite) initially assumed the messages API would return `{ messages, total, hasMore }` — a common pagination envelope. The actual shape returned by `GET /api/nexus/conversations/[id]/messages` is different and was verified by reading the route implementation.

## Verified API Response Shapes

### GET /api/nexus/conversations

```typescript
{
  conversations: Array<{
    id: string
    title: string
    isArchived: boolean
    isPinned: boolean
    provider: string
    // ...
  }>
  pagination: {
    total: number      // total matching conversations
    limit: number      // clamped to 500 max
    offset: number     // normalized to 0 if negative
    hasMore: boolean
  }
}
```

### GET /api/nexus/conversations/[id]/messages

```typescript
{
  messages: Array<{
    id: string
    role: 'user' | 'assistant' | 'system'
    content: Array<{ type: string; text?: string; [key: string]: unknown }>
    createdAt: Date
    metadata?: Record<string, unknown>
  }>
  conversation: { ... }  // conversation metadata
  pagination: {
    total: number
    // ...
  }
}
```

Note: NOT `{ messages, total, hasMore }` — the pagination is nested under `pagination.total`.

### POST /api/nexus/conversations

```typescript
// Request
{ title: string; provider: string; modelId?: string }

// Response — 200 OK
{ id: string; title: string; /* ... */ }
```

### PATCH /api/nexus/conversations/[id]

```typescript
// Request (any subset)
{ title?: string; isArchived?: boolean; isPinned?: boolean }

// Response — 200 OK: updated conversation object
// Response — 404: conversation not found
```

## Input Validation (Server-Enforced)

- `limit` clamped to `Math.min(rawLimit, 500)` — requesting `limit=99999` returns `pagination.limit <= 500`
- `offset` normalized: negative values → `0`
- `provider` filter validated against a whitelist; invalid values are silently ignored (returns all, logs warning)
- `includeArchived=true` query param controls whether archived conversations appear in list

## Boundary Conditions

- New empty conversation → messages endpoint returns `{ messages: [], pagination: { total: 0, ... } }`
- Archived conversation excluded from default list unless `?includeArchived=true`
- Non-existent conversation UUID → 404 on messages, PATCH, and fork endpoints

## E2E Test Assertion Pattern

```typescript
// Correct assertions for messages endpoint
expect(Array.isArray(result.messages)).toBe(true)
expect(result).toHaveProperty('pagination')
expect(typeof result.pagination.total).toBe('number')
// DO NOT assert result.total or result.hasMore — they don't exist at root level
```
