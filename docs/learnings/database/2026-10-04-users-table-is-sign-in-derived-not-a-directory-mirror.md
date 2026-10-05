---
title: users was sign-in-derived — group sync now pre-provisions staff so per-user grants can name people who never signed in
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

Any feature keyed on `users.id` (per-user visibility grants, per-user
assignment) was unexpressible for such people. The fix (#1860, PR #1862) adds a
fifth insert path in the hourly group-sync Lambda: `provisionGroupMemberUsers`
creates a stub row (lowercased email, `cognito_sub` NULL, no names) for each
district-domain, non-numeric member of an active synced group, plus `staff`
(source `manual`). First sign-in links the stub by `lower(email)`
(`lib/auth/resolve-user.ts`), keeping the id and every grant made to it.

Non-obvious constraints:
- **Check the source is actually running.** The first attempt hung this on the
  OneRoster sync, which exists in code but has never been enabled anywhere — it
  would have created zero rows. Group sync is the live directory feed.
- **The role must ship with the stub.** The sign-in link path
  (`linkExistingUserByEmail`) never calls `assignDefaultRole`; only the
  brand-new-row path does, so a roleless stub would sign in with no role.
- **No names.** Cloud Identity memberships carry no display names (and the
  service account has group scopes only), so stubs match people-search by
  email only until first sign-in.

## Prevention

- Before building anything that resolves a person to `users.id`, check which
  insert path would have created their row; coverage of pre-provisioning is
  "member of a synced group", not "in the district directory".
- Before building on a sync or feed, confirm it is enabled and populated in
  production, not just present in the codebase.
- Admin "pending" counts (`last_sign_in_at IS NULL`) now include stubs, so they
  no longer mean "invited but not yet signed in".
