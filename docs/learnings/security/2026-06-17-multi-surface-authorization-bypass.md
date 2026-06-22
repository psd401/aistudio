---
title: Parallel API surfaces silently bypass controls enforced only on one surface
category: security
tags:
  - authorization
  - multi-surface
  - tool-catalog
  - silent-fallback
  - openapi
  - code-review
  - 924
severity: critical
date: 2026-06-17
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #1038 (single-source AI SDK tool catalog, issue #924) review found that `tool_catalog.is_active` was enforced by the MCP dispatch path but not by the parallel REST execute route. Admin-disabled tools were callable via REST while being correctly blocked via MCP. Six independent review agents converged on the same finding.

## Root Cause

The MCP path enforced `is_active` through a shared dispatch layer. The REST execute route bypassed that layer and called the underlying service directly, so the active-state gate was never re-checked. Each surface assumed the other had already validated — neither had.

A second distinct issue: the server registry recovered a tool's friendly name by reverse-mapping the wire name through `TOOL_NAME_MAPPING`. For any tool not in that table, the reverse-map returned `undefined` and silently fell back to the wire name. This made an unmapped tool use the wrong identity downstream without any log or error.

## Solution

1. Added an explicit `isActive` gate in the REST execute route returning 404 for disabled tools — authorization checks must live at every entry point, not assumed from a shared lower layer.
2. Eliminated the reverse-map: carry `friendlyName` directly on the catalog entry so no lookup is needed and no fallback is possible.
3. Replaced unchecked `as ToolCategory`/`as keyof ModelCapabilities` casts on DB-sourced data with runtime validation.
4. De-duplicated capability filtering into a shared helper.

## Prevention

- When a control (active-state, scope, rate-limit) must hold across multiple API surfaces, enforce it at each entry point explicitly. Never assume a parallel surface has already checked.
- Reverse-mapping an identity through a partial lookup table is a silent-fallback trap. Carry the canonical value forward from the point of origin instead of reconstructing it downstream.
- In code review, enumerate all surfaces that can invoke a service and confirm each one independently enforces the same security invariants.
