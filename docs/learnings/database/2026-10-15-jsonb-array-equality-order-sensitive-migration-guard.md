---
title: jsonb array equality is order-sensitive — use containment for migration guards
category: database
tags: [postgres, jsonb, migrations, oauth]
severity: medium
date: 2026-10-15
source: auto — /work (issue #1907)
applicable_to: project
---

## What Happened

Migration 189 (`infra/database/schema/189-openclaw-repository-write-scopes.sql`) widens
the first-party OpenClaw OAuth client's `allowed_scopes` jsonb column to add
`repositories:write` / `repositories:create`.

## Root Cause

Postgres normalizes jsonb OBJECT keys for equality but not ARRAY element order. A guard
written as `WHERE allowed_scopes = '[...]'::jsonb` would silently match zero rows — no
error, no CI signal — if any prior process ever rewrote the column with the same scopes
in a different order, leaving the app requesting scopes the client doesn't allow.

## Solution

Guard with set containment in both directions instead of equality:
`allowed_scopes @> '[...]'::jsonb AND '[...]'::jsonb @> allowed_scopes`. This also makes
a re-run after a successful update an intentional no-op, and never overwrites an
administrator-modified client.

## Prevention

For any migration that updates a jsonb array column with an idempotent/conditional
`WHERE`, use `@>` containment both ways for set comparison — never `=` — unless the
column is known to never be rewritten with reordered elements.
