---
title: Hardcoded surface in catalog dispatch silently rejects tools on new surfaces
category: integration
tags:
  - tool-catalog
  - multi-surface-dispatch
  - agentic
  - ai-sdk
  - mcp
  - silent-failure
  - 926
severity: critical
date: 2026-06-17
source: auto — /lfg
applicable_to: project
---

## What Happened

Issue #926 added an 'internal' surface for the agentic Assistant Architect runtime. The catalog dispatch function had 'mcp' hardcoded as the surface, so every tool call from the agent runtime returned 'unknown' instead of resolving. The error was silent — no exception, just a dead dispatch result.

## Root Cause

`catalog.dispatch` had the surface hardcoded to `'mcp'` rather than accepting it as a parameter. This worked for the MCP path (which was the only caller) but silently broke any other surface. The hardcoded value also applied the wrong `surfaceScopes`, meaning even tools that happened to resolve would have been authorized against MCP scopes instead of the new surface's scopes.

## Solution

Added a `surface` parameter to the dispatch function so the caller declares which surface the tool call originates from. The 'internal' agent surface now passes `'internal'` and receives the correct scope resolution.

## Prevention

- Any function that routes tool calls through a catalog must accept `surface` as an explicit parameter — never hardcode it.
- When adding a new surface, grep for hardcoded surface strings in dispatch/authorization code before wiring the first call.
- Write a dispatch-level integration test for each surface that asserts tools resolve (not 'unknown') and scopes match the surface definition. A test for only the 'mcp' surface will not catch a regression introduced by a new surface.
