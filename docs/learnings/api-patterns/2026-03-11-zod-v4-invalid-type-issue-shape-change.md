---
title: Zod v4 invalid_type issue shape changed — `received` replaced by `input`
category: api-patterns
tags:
  - zod
  - zod-v4
  - validation
  - sse
  - streaming
  - type-guards
severity: high
date: 2026-03-11
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #841 (SSE streaming fixes) used `ZodIssueCode` constants to replace Zod string matching in type guards. During review it was discovered that Zod v4 changed the shape of `invalid_type` issue objects, breaking any code that inspected the `received` field.

## Root Cause

Zod v4 renamed the discriminating field on `invalid_type` issues: the `received` property (a `ZodParsedType` string such as `"undefined"`) was replaced by `input` (the actual runtime value provided — `undefined` when a required field is absent). Any guard that checks `i.received === 'undefined'` or `i.message.includes('received undefined')` silently passes or throws on Zod v4.

## Solution

Replace `received`-based checks with `input`-based checks:

```typescript
// Zod v3 (broken on v4)
if (i.code === ZodIssueCode.invalid_type && i.received === 'undefined') { ... }

// Zod v4
if (i.code === ZodIssueCode.invalid_type && i.input === undefined) { ... }
```

Also prefer `ZodIssueCode.invalid_type` over string literals (`'invalid_type'`) so mismatches are caught at compile time.

## Prevention

- When upgrading Zod, grep for `.received` on ZodIssue objects and for `message.includes('received')` patterns.
- Pair any Zod schema change with a schema-sync unit test that exercises missing-field and wrong-type cases.
