---
title: Drizzle ORM VARCHAR types must be manually synced with SQL CHECK constraints
category: database
tags:
  - drizzle
  - postgresql
  - schema-mismatch
  - check-constraints
  - typescript
severity: high
date: 2026-02-19
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #790 review discovered that TypeScript type definitions in Drizzle schema files diverged from raw SQL migration CHECK constraints. Example: `auth_type` column had CHECK constraint in SQL `(api_key|oauth|jwt|none)` but TypeScript types defined `(bearer|oauth2|api_key|none)`. Same pattern: `transport` was `(stdio|http|websocket)` in SQL but `(http|sse)` in TypeScript. The mismatch only surfaced during code review — no automation caught it.

## Root Cause

Drizzle ORM schema files (`lib/db/schema/tables/*.ts`) define `varchar()` columns without CHECK constraint enforcement in the TypeScript layer. The actual CHECK constraints live only in raw SQL migration files (prefixed with `010-`). Since Drizzle doesn't serialize CHECK constraints into its schema, TypeScript type definitions must be manually maintained in sync — there is no compile-time or runtime validation that they match.

## Solution

When adding a VARCHAR column with constrained values to a Drizzle schema:

1. **Define the raw SQL CHECK constraint** in the migration file (e.g., `/infra/database/schema/010-*.sql`):
   ```sql
   auth_type VARCHAR(20) CHECK (auth_type IN ('api_key', 'oauth', 'jwt', 'none'))
   ```

2. **Define the TypeScript type** in the corresponding schema table file (`lib/db/schema/tables/*.ts`):
   ```typescript
   export type AuthType = 'api_key' | 'oauth' | 'jwt' | 'none';

   export const myTable = pgTable('my_table', {
     authType: varchar('auth_type').$type<AuthType>(),
   });
   ```

3. **Verify alignment** before opening a PR — grep both files to ensure the literal list matches exactly.

## Prevention

- During code review, whenever a VARCHAR column has a constrained set of values, require the reviewer to manually verify the TypeScript type against the SQL CHECK constraint.
- Add a checklist item to PR template: "If adding VARCHAR with CHECK constraint, verify TypeScript type matches SQL values exactly."
- Consider adding a TSConfig rule or lint rule to enforce that enum-like types are defined in a single canonical source (future improvement).
