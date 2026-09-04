---
title: Normalizing a request-time alias is not the same as querying on it — unpublish left a legacy-alias row live
category: security
tags:
  - atrium
  - destination-alias
  - normalization
  - unpublish
  - stale-state
severity: high
date: 2026-09-03
source: /lfg #1726 (PR #1732)
applicable_to: project
---

## What Happened

Two destination aliases existed for the same logical publication target. Publish
folded both onto one canonical row at the service boundary (normalizing the alias on
write), which fixed publish. Unpublish, however, filtered its query on the single
normalized destination value only — a legacy row still stored under the OLD alias
(written before the normalization existed) never matched the unpublish query.

Two shapes, both bad. Live ONLY under the old alias: the pre-gate check found
nothing and returned `{ unpublished: false }` — "there is nothing to take down"
while the page kept serving. Live under BOTH: one row flipped, the call returned
`unpublished: true`, and the object stayed reachable through the untouched row with
no UI path left that could reach it, because every request normalizes to the same
destination. In both cases the author was told the content was down and it was not.

## Root Cause

"Normalize on write" only protects rows written after the normalization shipped.
Assuming the read/query side can safely filter on the canonical value alone treats
normalization as if it were a migration (retroactive) when it was actually a
go-forward write-time behavior (prospective). No backfill or alias-inclusive query
existed to cover pre-existing rows.

## Solution

Unpublish now targets the whole alias SET (`LIVE_SURFACE_DESTINATIONS`) — the
pre-gate live check, the in-transaction select, and the status flip — and retires
every matching row in one update, with the post-commit teardown running once per
retired row so each destination's adapter still fires.

Note that normalizing on READ would NOT have helped: the stored row literally holds
the old alias, so no amount of normalizing the incoming request makes a
canonical-only filter match it. The read side has to widen to the set.

## Prevention

- When you normalize a value at a write boundary, ask separately: does every READ
  path that filters on that value also need to handle rows written before the
  normalization existed? Write-time normalization does not retroactively fix stored
  data.
- Normalizing the REQUEST and querying the right ROWS are different problems. If
  stored rows can hold the old value, the read path must widen to the alias set;
  normalizing the incoming request cannot reach them.
- Export the alias set as a named constant used by BOTH the readers and the
  retract/cleanup path, so "which values count" has one definition. A retract that
  is narrower than the readers is the dangerous asymmetry: it reports success while
  something is still being served.
