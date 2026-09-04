---
title: A migration that retires rows the OLD image still reads is not deploy-order-safe under a rolling deploy
category: database
tags:
  - atrium
  - migration
  - rolling-deploy
  - ecs
  - backward-compatibility
severity: high
date: 2026-09-03
source: /lfg #1726 (PR #1732)
applicable_to: project
---

## What Happened

Issue #1726 shipped a migration that retires the multi-state publication rows the
NEW application image no longer needs (collapsed to a single Live/Draft flag). The
new image tolerates the table in either its old or new shape, which was documented as
"migration and code deploy can happen in either order." That framing is wrong for an
ECS rolling deploy: OLD tasks keep serving live traffic — reading and writing rows in
the OLD shape — for the entire drain window after the migration runs and until the
last old task is replaced. If the migration retires/removes rows the old image's
queries still depend on mid-drain, those in-flight old tasks break, even though the
new image alone would have been fine with the migration applied first.

## Root Cause

"The new code tolerates either order" is a claim about the NEW image only. A rolling
deploy runs old and new code concurrently for a non-zero window, so the real
constraint is "the OLD image must also tolerate the migrated schema for the duration
of the drain" — a different and stricter requirement that wasn't stated or checked.

## Solution

Reading the OLD image's actual queries showed it is NOT safe: its `/p/[slug]` gate
selects specifically on the rows migration 180 retires, so any object live only
through the retired alias 404s for anonymous visitors on every request routed to an
old task, for the whole drain window.

The migration was not changed — retiring those rows is the point — but its header
now states the ordering requirement (**run it after the image is fully rolled out**)
and separates what is and is not order-insensitive, instead of claiming "either
order". The internal `/c/[slug]` reader was never at risk in that direction, because
step 1 gives every affected object a live canonical row BEFORE step 2 retires
anything — which is worth checking per-reader rather than assuming it holds for all
of them.

## Prevention

- For any migration that deletes/retires rows or narrows a column's meaning, state
  the constraint as "the OLD image, not just the NEW image, must tolerate this
  schema" and verify it against the old image's actual queries — don't infer safety
  from the new image's tolerance alone.
- Check it PER READER. In this case one reader was safe (the migration gives it a
  replacement row before retiring the old one) and another was not. "The old image is
  fine" is not a single fact.
- If the old image cannot tolerate it, that is not necessarily a reason to change the
  migration — but it IS a reason to write the deploy order into the migration header,
  next to the SQL, where whoever runs it will see it.
- Rolling deploys guarantee old and new code run concurrently against the same
  database for the drain window; migrations must be safe for BOTH, not just the
  target state.
