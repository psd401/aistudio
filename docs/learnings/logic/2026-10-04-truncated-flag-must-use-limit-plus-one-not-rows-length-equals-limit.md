---
title: "truncated: rows.length === LIMIT" is wrong when the real match count lands exactly on the cap
category: logic
tags:
  - atrium
  - pagination
  - search
  - off-by-one
severity: medium
date: 2026-10-04
source: auto — /lfg #1860 (PR #1862)
applicable_to: project
---

## What Happened

The people-search query (`lib/content/people-search.ts`) capped results at a
fixed LIMIT and reported `truncated: rows.length === LIMIT`. If the true match
count is exactly LIMIT (not more), this reports `truncated: true` even though
every match was returned — a false "there are more results" signal to the
caller (and, for an agent-callable endpoint, a false signal into the model's
reasoning).

## Root Cause

`rows.length === LIMIT` cannot distinguish "exactly LIMIT matches exist" from
"more than LIMIT matches exist, and we got cut off at LIMIT" — both produce
the same row count.

## Solution

Query `LIMIT + 1`. If the result set has `LIMIT + 1` rows, there were more
matches than the cap; return only the first `LIMIT` and set
`truncated: rows.length > LIMIT`. If it has `LIMIT` or fewer, `truncated` is
false and every match is already present.

## Prevention

- Any search/list endpoint that caps results and reports a "truncated" or
  "hasMore" flag should query one row past the cap, not rely on an exact
  count-equals-limit comparison.
