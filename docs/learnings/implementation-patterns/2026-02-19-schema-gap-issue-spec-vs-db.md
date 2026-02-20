---
title: Schema gaps between issue specs and actual DB schema
category: implementation-patterns
tags: [admin, schema-gaps, drizzle, nexus, issue-management]
severity: medium
date: 2026-02-19
source: auto — /work
applicable_to: project
---

## What Happened

Issue #XXX specified admin UI fields for MCP connector management: `description`, `enabled`, `allowed_roles`. Implemented admin page following oauth-clients pattern (server page + client component + sheet form). Discovered actual Drizzle schema lacked `description` and `enabled` columns; `allowed_roles` was typed as `allowed_users: integer[]`.

## Root Cause

Specs written independently of schema verification. No validation step between issue creation and implementation that checked DB schema against feature requirements.

## Solution

Implemented with existing schema columns:
- Omitted `description` field from admin UI (no DB column)
- Used `allowed_users` array (dropped `allowed_roles` concept)
- Added connection count via LEFT JOIN + `count()` aggregation

Documented schema gaps in PR description rather than creating migrations on the fly.

## Prevention

Before implementing admin features:
1. Run `bun run drizzle:introspect` or inspect `/lib/db/schema` directly
2. Cross-check issue spec fields against actual schema columns
3. If gap exists, document it in PR and create separate schema issue—don't migrate in feature branch
4. Reference oauth-clients admin pattern for consistent form structure (server page + client component + sheet form)

