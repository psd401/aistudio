---
title: Extracting a server action's logic must take the caller's action label as a parameter
category: logic
tags: [logging, refactoring, server-actions, mcp]
severity: low
date: 2026-10-15
source: auto — /work (issue #1907)
applicable_to: project
---

## What Happened

Extracted the session-free inline-text write core out of
`actions/repositories/repository-items.actions.ts` into
`lib/repositories/repository-write-service.ts` so both the server action and the new MCP
tool handlers share one implementation.

## Root Cause

`LogContext` (`lib/logger.ts`) types `action` as a named, dashboard-queryable field. A
shared module that hard-codes its own `action` tag (or uses an untyped `module:` tag
instead) would collapse both callers onto one log label, breaking any dashboard/alert
keyed on `action: "addTextItem"` and making the two callers indistinguishable in logs —
also losing the DB operation label passed to `executeQuery`/`executeTransaction`.

## Solution

`CreateRepositoryTextItemInput.callerAction` is passed in by each caller (`addTextItem`
for the server action, `repositories_add_item` for the MCP tool) and used both as the
`createLogger({ action: input.callerAction })` tag and the DB operation label — see
`lib/repositories/repository-write-service.ts` lines ~75-90, 171-174.

## Prevention

When extracting logic that used to run inside a `"use server"` action into a shared
module, pass the caller's action name through explicitly rather than hard-coding it in
the extracted function — preserves per-caller log/metric attribution.
