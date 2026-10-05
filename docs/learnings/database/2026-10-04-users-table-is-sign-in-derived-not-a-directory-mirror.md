---
title: users is sign-in-derived — give the caller an explicit create-by-email path instead of trying to mirror the directory
category: database
tags:
  - atrium
  - users
  - jit-provisioning
  - visibility
  - grants
  - directory
severity: high
date: 2026-10-04
source: auto — /lfg #1860 (PR #1862)
applicable_to: project
---

## What Happened

Building an agent-callable people lookup (resolve a person's email to
`users.id` for a per-user Atrium visibility grant) required auditing every
path that can INSERT into `users`. There are exactly four: first-request JIT
provisioning (`lib/auth/resolve-user.ts`, `actions/db/get-current-user-action.ts`),
Google Chat agent OAuth provisioning (`actions/agent-workspace.actions.ts`,
which writes rows with `cognito_sub IS NULL`), the admin `POST /api/admin/users`
endpoint, and two seeded service accounts.

## Root Cause

`users` is not a directory mirror of staff/students — group-sync and
OneRoster-sync only `JOIN users on lower(email)` to attach role/membership
data to rows that already exist; neither sync ever inserts a row. A person who
has never signed into the app and never connected the Google Chat agent has no
row at all, regardless of how long they've been a district employee.

## Solution

Any feature keyed on `users.id` (per-user visibility grants) needs an id for
people who never signed in. Two sync-based attempts on #1860 were reverted:
OneRoster-sync pre-provisioning (that sync has never been enabled anywhere, so
it created nothing) and group-sync pre-provisioning (covers only members of
selected groups and yields nameless rows). What shipped is on-demand:
`ensureDistrictPerson` (`lib/content/people-search.ts`, agent surface
`POST /_people` / `psd-atrium add-person`) returns the row for a district staff
email or creates it (lowercased email, optional names, `cognito_sub` NULL) plus
`staff` (source `manual`). First sign-in links it by `lower(email)`
(`lib/auth/resolve-user.ts`) and keeps the id.

The role must be created with the row: the sign-in LINK path
(`linkExistingUserByEmail`) never calls `assignDefaultRole` — only the
brand-new-row path does — so a roleless pre-created row signs in with no role.

## Prevention

- When a caller needs an id for a person who may not have signed in, give it
  an explicit create-by-email path with domain/role guards rather than trying
  to mirror the directory through a sync.
- Before building on a sync or feed, confirm it is enabled and populated in
  production, not just present in the codebase.
