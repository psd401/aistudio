---
title: A "list" view and its "dispatch/resolve" path must share one policy helper, or they silently disagree
category: mcp
tags:
  - lfg
  - autonomous
  - tool-catalog
  - versioning
  - deprecation
  - mcp
  - consistency
  - issue-927
  - epic-922
  - pr-1044
severity: medium
date: 2026-06-22
source: auto — /lfg (PR #1044 review round)
applicable_to: project
---

## What Happened

The unified tool catalog (#927) had two paths that answer different questions about the same tools:

- `tools/list` (discovery) pre-filtered with `list({ excludeDeprecated: true })`, then collapsed to the latest version per identifier.
- `tools/call` / `resolve()` (invocation) used `pickLatestNonDeprecated`, which falls back to the **latest deprecated** version when *every* version of a tool is deprecated.

For a tool whose versions are **all deprecated**, the two paths disagreed: `tools/list` returned nothing (the `excludeDeprecated` filter removed every row), but `tools/call` would happily dispatch the latest deprecated version. The tool was **invisible yet invocable** — a client could never discover a tool it was still allowed to call.

## Root Cause

Two code paths re-implemented "which version do we surface?" with *different* rules:

- The list path encoded "hide deprecated" as a blunt upstream filter.
- The resolve path encoded the nuanced "prefer live, fall back to latest deprecated when none are live."

Whenever a discovery/list view and an action/resolve path apply *separately authored* selection logic to the same entities, an edge case (here: all-deprecated) exposes the divergence. Type checkers and unit tests that only cover the common case (one live + one deprecated) pass right over it.

## Solution

- Stopped pre-filtering in the MCP handler: `tools/list` now lists the **full** version set and delegates the collapse to `selectListedTools`.
- Rewrote `selectListedTools` to call the **same** pure `pickLatestNonDeprecated` helper that `resolve()` uses, grouped per identifier. The two paths now agree *by construction* — an all-deprecated tool is surfaced (and tagged `deprecated: true`) exactly when it is dispatchable.
- Added unit + integration coverage for the all-deprecated fallback specifically (not just the mixed live/deprecated case).

## Prevention

- When a "list/discover" surface and an "act/resolve" surface answer the same selection question, extract ONE pure helper and call it from both. Don't let a list path use a coarse filter while the resolve path uses a refined rule.
- Write the edge-case test first: "every candidate is in the filtered-out state." Mixed-state tests (one in, one out) hide the divergence because the collapse still returns *something*.
- A filter that can empty a group entirely (`excludeDeprecated`, `activeOnly`, `nonExpired`) is a smell on a discovery path whose companion action path has a fallback — the fallback won't be honored unless the same helper runs on both.
