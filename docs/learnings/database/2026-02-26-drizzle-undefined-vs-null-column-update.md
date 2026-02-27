---
title: Drizzle ORM — undefined skips column updates, null explicitly clears
category: database
tags:
  - drizzle
  - orm
  - null-semantics
  - jsonb
severity: high
date: 2026-02-26
source: auto — /review-pr
applicable_to: project
---

## What Happened

A PR for prompt library settings used conditional column updates (`if (data.field !== undefined)`). When a user cleared an optional field, the value was passed as `undefined`, causing Drizzle to silently skip the DB update — the old value persisted.

## Root Cause

Drizzle ORM treats `undefined` as "omit this column from the SET clause entirely". It only includes columns explicitly set to a value, including `null`. This differs from SQL's explicit NULL semantics.

## Solution

Always pass `null` (not `undefined`) when the intent is to clear a column:

```typescript
// Wrong — skips update when user clears field
await db.update(table).set({
  optionalField: data.optionalField, // undefined silently skips
})

// Correct — explicitly clears the column
await db.update(table).set({
  optionalField: data.optionalField ?? null,
})
```

For conditional update patterns, prefer explicit nulling:

```typescript
const updates: Partial<typeof table.$inferInsert> = {}
if (data.field !== undefined) updates.field = data.field ?? null
```

## Prevention

- In any update action handling optional/clearable fields, default to `?? null` at the assignment site.
- Applies especially to JSONB columns and nullable text fields where clearing is a valid user action.
- Code review checklist: search for `data.field` in `.set({})` calls and verify null handling.
