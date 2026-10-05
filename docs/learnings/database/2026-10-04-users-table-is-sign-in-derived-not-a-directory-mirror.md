---
title: users was sign-in-derived — roster staff are now pre-provisioned so per-user grants can name people who never signed in
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
assignment) was unexpressible for such people. The fix (#1860, PR #1862) is a
fifth insert path: after every fully successful OneRoster sync,
`provisionRosterStaffUsers` (`infra/lambdas/oneroster-sync/db.ts`) creates a
stub row — lowercased email, roster names, `cognito_sub` NULL — for each active
staff-roled roster user (no active student role) who has no row, plus `staff`
as `source='oneroster'`. First sign-in links the stub by `lower(email)`
(`lib/auth/resolve-user.ts`), keeping the id and every grant made to it.

Two non-obvious constraints drove the shape:
- The role must be inserted WITH the stub. The sign-in link path
  (`linkExistingUserByEmail`) never calls `assignDefaultRole` — only the
  brand-new-row path does — so a stub without a role would sign in roleless.
  Tagging it `oneroster` lets `reconcileOneRosterRoles` revoke it on departure.
- Source the population from data already synced (`oneroster_users`), not a
  new Google Directory call: group-sync's service account only holds group
  scopes, and adding `admin.directory.user.readonly` is a Google Admin change.

Still uncovered: students, non-roster accounts, hires newer than the last
nightly sync, and anyone whose roster email differs from their sign-in email
(the stub never links and sign-in creates a second row).

## Prevention

- Before building anything that resolves a person to `users.id`, check which
  insert path would have created their row — "has an email in the district
  directory" does not imply "has a `users` row" unless the roster covers them.
- Admin "pending" counts (`last_sign_in_at IS NULL`) now include roster stubs,
  so they no longer mean "invited but not yet signed in".
