---
title: Schema comments that contradict live code logic are high-severity silent failures
category: database
tags:
  - atrium
  - schema
  - grants
  - documentation-drift
  - permissions
  - postgres
severity: high
date: 2026-06-29
source: auto — /work
applicable_to: project
---

## What Happened

The `content_visibility_grants` table comment stated: "For `role` and `user` grants this is the numeric id stored as text." In reality, `canView` and `buildVisibilitySql` match role grants against `principal.roles` which contains role **names** (strings like `"staff"`), not numeric IDs. A developer following the schema comment would insert role grants with `value = "7"` (numeric ID) — no constraint violation, no error, and no authorization ever granted. Silent access denial.

## Root Cause

The schema comment was written when `user` grants were the primary use case (numeric IDs). Role grant semantics were added later with different value conventions, but the column comment was not updated to reflect the split.

## Solution

Update the column comment to precisely specify per-kind semantics:
- `user` grants: `grant_value` = numeric user ID as text (e.g. `"42"`)
- `role` grants: `grant_value` = role name string (e.g. `"staff"`)
- `group` grants (if added): document the value type at implementation time

## Prevention

- Whenever a column's meaning differs by a discriminator column (`grant_kind` here), the schema comment must enumerate the semantics for **each** discriminator value.
- Schema comments that refer to "id" for what is actually a name string are a high-severity mismatch — they produce code that passes validation and inserts successfully but never authorizes anyone.
- During PR review: if a new grant kind is added, verify the schema comment is updated before merge.
