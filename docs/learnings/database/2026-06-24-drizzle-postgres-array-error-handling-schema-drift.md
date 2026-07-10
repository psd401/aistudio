---
title: "Drizzle + postgres.js: sql ANY() array bindings fail; TypedError level field required; schema column additions cascade type errors"
category: database
tags:
  - lfg
  - autonomous
  - drizzle
  - postgres
  - sql-any-array
  - error-handling
  - schema-drift
  - transactions
  - s3
  - sanitization
  - atrium
severity: high
date: 2026-06-24
source: auto — /lfg
applicable_to: project
---

## What Happened

Atrium Phase 0 (#1058) added 7 content tables, a lib/content/ service layer, and 61 unit tests. Post-implementation 5-agent self-review surfaced three silent, non-obvious failures that would have reached production: a Drizzle `= ANY(${arr})` SQL binding crash, a custom error class missing `.level` that caused all service errors to be silently dropped from logs, and a newly added DB column that cascaded type errors into every transform and sibling accessor that omitted it from their select projections.

## Root Cause

**1. `= ANY()` with postgres.js bound JS arrays**
Drizzle's `sql` tag passes a JS array to postgres.js as a scalar, not as a PostgreSQL array literal. Result: empty arrays produce `syntax error at ()` and non-empty arrays produce `Array value must start with {`. This is a postgres.js driver constraint, not a Drizzle bug.

**2. CustomError missing `.level` field**
`handleError` in `lib/error-utils.ts` routes any error with a `code` property into the `TypedError` branch, then switches on `typedError.level` to decide log severity. `ContentError` set `.code` but omitted `.level`, so the switch fell through all cases — the error was never logged and the caller got a generic 500.

**3. Adding a column to a Drizzle table widens `$inferSelect`**
Adding `navigation_items.content_object_id` to the schema widened `$inferSelect<typeof navigationItems>`. Every hand-written transform that destructured the inferred type then had a missing-field type error, and every sibling accessor whose `.select()` column list omitted the new column failed with a union-narrowing mismatch on return type.

## Solution

**1. Drizzle IN-list for array membership**
```typescript
// WRONG — crashes with postgres.js
.where(sql`visibility_scope = ANY(${grantArray})`)

// CORRECT — build a bound IN-list
import { sql } from "drizzle-orm";

const inList = grantArray.length > 0
  ? sql`visibility_scope IN (${sql.join(grantArray.map(v => sql`${v}`), sql`, `)})`
  : sql`false`;

.where(inList)
```

**2. Always set `.level` on custom Error classes that carry `.code`**
```typescript
class ContentError extends Error {
  code: string;
  level: "warn" | "error" | "fatal"; // REQUIRED — handleError switches on this
  constructor(code: string, message: string, level: "warn" | "error" | "fatal" = "error") {
    super(message);
    this.code = code;
    this.level = level;
  }
}
```

**3. Update all select projections for a table together**
When adding a column to a Drizzle schema, search for every `.select()` and hand-written transform referencing that table and update them in the same PR. The type system surfaces this as union-narrowing errors, not missing-property errors — grep for `$inferSelect<typeof tableName>` to find all affected sites.

## Prevention

- Run `bun run typecheck` after any schema column addition before committing — cascading errors surface immediately.
- Prefer `where(inArray(col, values))` from `drizzle-orm` over raw `sql` for array membership checks; it handles empty arrays (renders `WHERE 1=0`).
- Add a lint rule or code-review checklist item: any Error subclass with a `code` property must also declare `level`.
- Never add DB-side work inside `executeTransaction` callbacks; S3/HTTP writes must run post-commit (documented anti-pattern in `drizzle-client.ts` JSDoc).
