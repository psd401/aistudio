---
title: users is populated only by sign-in-adjacent paths — per-user grants fail silently for staff who never authenticated
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
assignment) is unexpressible for such people. The people-lookup endpoint
returns "not found" rather than fabricating a row — do not auto-provision a
`users` row from a lookup, since JIT provisioning elsewhere assumes it happens
at the moment of actual sign-in (and carries auth-specific fields like
`cognito_sub`).

## Prevention

- Before building anything that resolves a person to `users.id`, check which
  of the four insert paths would have created their row — "has an email in
  the district directory" does not imply "has a `users` row."
- Surface this constraint in error messages/UI: "grant pending — user has not
  yet signed in" is more honest than a silent no-op or a generic not-found.
