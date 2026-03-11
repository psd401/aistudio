---
title: Stale-while-revalidate cache breaks when DB accessor returns null for both not-found and error
category: infrastructure
tags:
  - cache
  - stale-while-revalidate
  - database
  - null-safety
  - settings
severity: high
date: 2026-03-10
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #831 implemented a stale-while-revalidate (SWR) cache for settings. Review caught two bugs: (1) the DB accessor returned `null` for both "row not found" and "DB error", making the SWR refresh logic unable to distinguish them. (2) `revalidateSettingsCache` had a race condition where an in-flight background refresh could write stale data back to the cache after an explicit invalidation.

## Root Cause

The DB accessor's null return type conflated two distinct conditions. SWR refresh logic that writes `null` back to cache (or falls back to defaults) will silently overwrite valid cached state when the DB is temporarily unavailable or the row doesn't exist yet.

## Solution

- DB accessor must distinguish not-found from error: throw on error, return `null` only for not-found, or use a discriminated union `{ found: false } | { found: true; data: T }`.
- SWR refresh: on null/error from DB, preserve existing cache entry rather than overwriting it.
- Cache invalidation must cancel or ignore in-flight background refreshes (e.g., generation counter or `AbortController`).

## Prevention

- Before implementing SWR, audit the DB accessor's null semantics. If it returns null for errors, fix the accessor first.
- Background refresh callbacks must check whether the cache has been invalidated since the refresh was triggered before writing.
- Use a generation/version counter on the cache entry: only write if `generation === currentGeneration`.
