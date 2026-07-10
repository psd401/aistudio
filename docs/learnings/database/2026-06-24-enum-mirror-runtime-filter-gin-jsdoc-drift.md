---
title: Postgres enum extension requires auditing TS unions AND runtime allow-list filters; GIN indexes and JSDoc architecture comments rot independently
category: database
tags:
  - drizzle
  - schema-drift
  - gin-index
  - postgres-enum
  - silent-failure
  - jsdoc-drift
  - navigation
  - pr-review
  - incremental-review
severity: high
date: 2026-06-24
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #1061 (Atrium Phase 0) added `'content'` to the `navigation_type` Postgres enum. A review pass found two independent silent-failure surfaces: (1) the TypeScript union type alias for `NavigationUpdateData.type` was missing `'content'`, and (2) a runtime string filter in `applyNavigationStringFields` used an explicit `if (x === 'a' || x === 'b')` allow-list that did not include `'content'`, so any navigation record with `type: 'content'` was silently dropped at runtime even though the TS type compiled clean. Additionally, a GIN index on `tags` was present in migration 085 SQL but not declared in the Drizzle schema table callback (invisible to introspection), and two JSDoc file-header comments described stale architecture (S3 writes inside a transaction; "no updated_at triggers") that no longer matched the code.

## Root Cause

- **Enum mirrors are hand-maintained in multiple places**: the Postgres migration, the TS type alias, and any runtime allow-list filter. These three are decoupled — changing one does not break the others at compile time.
- **Runtime allow-lists are a silent-failure surface independent of the type system**: a TS union can be correct while a runtime filter quietly drops new values.
- **Drizzle index declarations are optional relative to raw SQL**: a `CREATE INDEX USING GIN` in a migration does not auto-appear in Drizzle schema introspection unless also declared via `index(name).using('gin', t.col)`.
- **JSDoc describing architecture (transaction boundaries, trigger presence) rots** when the surrounding implementation changes without updating the comment.

## Solution

- Added `'content'` to the `NavigationUpdateData.type` TS union.
- Updated the runtime filter in `applyNavigationStringFields` to include `'content'` in the allow-list.
- Declared the GIN index in the Drizzle schema table callback: `index('idx_tags_gin').using('gin', t.tags)`.
- Updated the two stale JSDoc file-header comments to reflect current architecture.
- Typecheck/lint clean; 69/69 unit tests pass after all fixes.

## Prevention

When a Postgres enum gains a new value:
1. `grep -r` for every hand-maintained mirror: TS type aliases, Zod schemas, and runtime allow-list filters.
2. Runtime `if (x === 'a' || x === 'b')` filters are NOT caught by TS exhaustiveness checks — audit them explicitly.

When writing raw-SQL migration indexes (especially GIN/GiST):
- Declare the equivalent in the Drizzle schema table callback in the same PR.
- `index(name).using('gin', table.column)` for GIN indexes.

When moving side effects out of a transaction or adding/removing triggers:
- Update file-header JSDoc in the same commit, not as a follow-up.
