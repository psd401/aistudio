---
title: Scope returned grant data to editor role; guard every REST/MCP-boundary field as optional at runtime
category: security
tags:
  - permissions
  - authorization
  - idor
  - info-leak
  - optional-chaining
  - race-condition
  - select-for-update
  - sql-js-parity
  - dry
  - atrium
severity: high
date: 2026-06-29
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #1081 (Atrium Phase 3 — Permissions & visibility) Round 4 code review surfaced four distinct issues:

1. **Info-leak**: `getVisibilityAction` returned the full grant list — including numeric user IDs — to any caller who passed `canView`, not just callers who passed `canEdit`. Viewers could enumerate user IDs they should never see.
2. **TypeError crash**: `input.visibility.grants` was typed as required, but REST/MCP callers can omit it. Calling `.map()` without a `?? []` guard crashed the action instead of treating it as an empty list.
3. **SQL/JS parity gap**: `buildVisibilitySql` gated group-grant evaluation with `AND visibility_level = 'group'`. The parallel `canView` JS function swept group grants unconditionally — meaning a document at `visibility_level = 'internal'` with leftover group grants could pass `canView` for group members while the SQL query correctly excluded them.
4. **Concurrent publish race**: The publish transaction did `INSERT INTO content_visibility_grants` without first locking the parent row. Two concurrent publishes could each read "no grants yet" and both attempt the same INSERT, hitting `uq_cvg` (unique constraint) as a 500 instead of a clean idempotency check.

## Root Cause

1. Read actions returned all stored data without gating on the caller's permission level.
2. TypeScript `required` in schema does not guarantee runtime presence when input crosses a REST or MCP boundary.
3. `canView` and `buildVisibilitySql` were written/extended independently; the `visibilityLevel === 'group'` guard was added only to the SQL path.
4. Publish transaction relied on application-level uniqueness without a database row lock to serialize concurrent writers.

## Solution

- `getVisibilityAction`: return `grants` only when the session user passes `canEdit`; return `{ level }` only for plain viewers.
- Add `?? []` (or `?? null`) at every field that flows in from a REST or MCP boundary, regardless of the TypeScript type.
- In `canView`, add `if (visibilityLevel !== 'group') return false` before the group-grant sweep, matching the SQL `AND visibility_level = 'group'` gate. Add a fail-closed default (`return false`) after all branches.
- In the publish transaction, issue `SELECT id FROM content_versions WHERE id = $1 FOR UPDATE` before any INSERT to serialize concurrent publishes on the same document.

## Prevention

- **Dual-path predicates** (`canView` JS + `buildVisibilitySql` SQL): every `AND` clause in the SQL must have a matching `if` guard in the JS, and vice versa. Keep them adjacent with a comment block listing all conditional branches.
- **Read actions**: default to returning the minimum data set for the caller's permission level. Escalate to full data only after passing the higher-permission check.
- **REST/MCP input fields**: treat every incoming field as `T | undefined` at runtime, even when the schema says required. Apply `?? []` / `?? null` at the first use site.
- **Concurrent write paths**: any transaction that inserts rows constrained by a unique key must `SELECT ... FOR UPDATE` the parent row first, or use `ON CONFLICT DO NOTHING` with an explicit idempotency check.
