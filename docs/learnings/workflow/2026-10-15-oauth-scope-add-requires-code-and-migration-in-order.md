---
title: Adding an OAuth client scope needs matching code change AND migration, deployed together
category: workflow
tags: [oauth, scopes, deployment, migrations]
severity: high
date: 2026-10-15
source: auto — /work (issue #1907)
applicable_to: project
---

## What Happened

Adding `repositories:write` / `repositories:create` to the first-party OpenClaw agent
required editing `AISTUDIO_OPENCLAW_SCOPES` in `lib/oauth/openclaw-client.ts` AND adding
migration 189 to widen the client row's `allowed_scopes` column.

## Root Cause

`oidc-provider` validates every scope in an authorization request against the client's
persisted `allowed_scopes`. If the app code requests a scope the DB row doesn't yet
allow, the ENTIRE authorization request is rejected — not just the new scope — so a
deploy-order skew window breaks agent-connect for every user of that client, not only
those wanting the new capability.

## Solution

Both changes must land in the same deploy, and the DB migration (which widens
`allowed_scopes`) must apply before or atomically with the code referencing the new
scope constant. The migration itself documents this ordering requirement inline.

## Prevention

Treat "new OAuth scope" as a two-part change: code constant + DB migration, verified
against each other, deployed as one unit. Never ship the code half ahead of the
migration.
