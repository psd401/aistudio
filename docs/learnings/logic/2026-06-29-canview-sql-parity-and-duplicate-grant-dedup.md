---
title: canView and buildVisibilitySql must have identical check ordering, and grants must be deduped before bulk INSERT
category: logic
tags:
  - atrium
  - visibility
  - permissions
  - grants
  - sql
  - canview
  - divergence
  - unique-constraint
severity: high
date: 2026-06-29
source: auto — /work
applicable_to: project
---

## What Happened

Two separate logic bugs in Atrium Phase 3 (Issue #1053):

1. `canView` (in-memory) and `buildVisibilitySql` (SQL predicate) implement the same visibility rules but had `isAdmin` appearing at different positions in the check chain relative to the `internal` level check. Any new visibility level inserted between those two positions would create a divergence where the in-memory and SQL paths return different results for the same user/object combination — a subtle authorization bug with no immediate error.

2. `applyGrantsInTx` does delete-then-insert. When a caller supplied duplicate `{kind, value}` pairs (e.g. the same role name twice from a UI multi-select), the bulk INSERT hit the unique constraint `uq_cvg` on `(object_id, grant_kind, grant_value)` and rolled back with a 23505 error that surfaced as a generic save failure.

## Root Cause

1. **No shared ordering contract** between `canView` and `buildVisibilitySql`. They were written independently and the `isAdmin` shortcut was added to each at different times.
2. **No deduplication before INSERT** in `applyGrantsInTx`. The caller (UI) can legitimately submit the same grant twice, and the function had no guard.

## Solution

1. Establish and enforce a canonical check ordering: `guest early-exit → isAdmin → public → internal → group/private`. Both `canView` and `buildVisibilitySql` must follow this exact sequence. Add a code comment citing the ordering contract.
2. Deduplicate `{kind, value}` pairs with a `Set` keyed by `${kind}:${value}` before the INSERT. The DELETE already cleared prior rows, so deduplication is safe and idempotent.

## Prevention

- Keep `canView` and `buildVisibilitySql` adjacent in the file with a shared comment block listing the canonical ordering. Any change to one must be mirrored in the other.
- `applyGrantsInTx` (and any delete-then-insert pattern) must deduplicate inputs before the INSERT to prevent unique-constraint violations from caller-supplied duplicates.
