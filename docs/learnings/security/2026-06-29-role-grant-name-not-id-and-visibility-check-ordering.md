---
title: Role grants must carry role names, not IDs — and all canView failures must be 404
category: security
tags:
  - atrium
  - permissions
  - visibility
  - grants
  - existence-masking
  - authorization
  - idor
severity: high
date: 2026-06-29
source: auto — /work
applicable_to: project
---

## What Happened

Atrium Phase 3 (Issue #1053) introduced `assertValidGrant` for the Phase 0 content visibility system. The validator accepted role grants with numeric IDs (`{kind:"role", value:"7"}`), matching how `user` grants work. But `canView` and `buildVisibilitySql` both match against `principal.roles`, which is populated by `getUserRoles()` returning `roles.name` (strings like `"staff"`). A role grant with a numeric ID always fails silently — no error, no authorization, no visible feedback.

Separately, Atrium content pages must return `notFound()` when `canView` fails, not `forbidden()` — even for authenticated requests. Returning 403 leaks existence to an attacker who can distinguish "exists but forbidden" from "not found."

## Root Cause

1. **Grant validation was modeled after `user` grants** (which do use numeric IDs) without checking what `canView` actually matches against.
2. **Existence masking was not enforced** at the new Phase 3 page surfaces, repeating the same IDOR pattern caught in Phase 0 (see [[existence-leak-via-403-before-404]]) and Phase 1 (see [[scoped-fail-closed-existence-masking]]).

## Solution

- `role` grants carry the role **name** string (e.g. `"staff"`). Only `user` grants carry a numeric user ID.
- `assertValidGrant` must enforce: `kind === "role"` → value is a non-empty string matching a known role name; `kind === "user"` → value is a numeric-string ID.
- All Atrium page surfaces call `notFound()` when `canView` returns false. `forbidden()` is reserved for non-existence checks (e.g. wrong requester kind) that run only after the object is confirmed to exist.

## Prevention

- When adding a new grant kind, trace the full path: validation → storage → `canView` matching → `buildVisibilitySql`. All four must agree on what `value` contains.
- The 404-before-403 rule is project-wide for content objects. See [[existence-leak-via-403-before-404]] and [[scoped-fail-closed-existence-masking]] for prior fixes.
