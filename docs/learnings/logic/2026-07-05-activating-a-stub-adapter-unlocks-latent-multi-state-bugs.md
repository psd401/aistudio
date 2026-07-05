---
title: Activating a previously-stubbed adapter retroactively unlocks latent multi-state bugs
category: logic
tags:
  - state-machine
  - adapters
  - unpublish
  - multi-destination
  - atrium
  - regression
severity: medium
date: 2026-07-05
source: auto — /lfg #1057 (PR #1110 review, chatgpt-codex P2)
applicable_to: project
---

## What Happened

Atrium Phase 7 (#1057) turned `public_web` from a throw-before-tx STUB into a real
live publish adapter. `publishService.unpublish()` had always, inside its
transaction, unconditionally reverted `content_objects.status` to `'draft'` after
tearing down the requested destination. That was correct while `intranet` was the
*only* destination that could ever be `live` — an object could be live at exactly
one place, so unpublishing it always meant "nothing is live anymore."

Making `public_web` live silently made a new state reachable: an object live on
`intranet` AND `public_web` at once. Now unpublishing one destination flipped the
whole object to `draft` while the other reader route kept serving it — list/filter
UI reported "draft" for content that was still publicly live. No test caught it
because no prior test could construct the multi-live state.

## The Fix

Only downgrade the object when NO other publication remains live — checked inside
the same locked tx, AFTER flipping the current row to `unpublished` (so the
`status = 'live'` re-query correctly excludes the just-torn-down row):

```ts
await tx.update(contentPublications).set({ status: "unpublished", ... })
  .where(eq(contentPublications.id, pub[0].id));

const stillLive = await tx.select({ id: contentPublications.id })
  .from(contentPublications)
  .where(and(eq(contentPublications.objectId, objectId),
             eq(contentPublications.status, "live")))
  .limit(1);
if (!stillLive[0]) {
  await tx.update(contentObjects).set({ status: "draft", ... })
    .where(eq(contentObjects.id, objectId));
}
```

## The General Lesson

When you promote a stub/no-op/single-value path to a real one (adapter, provider,
feature flag, enum member), the change is not local. Audit every piece of
surrounding logic that was *correct only because the old state space was smaller* —
especially "there can be at most one X" assumptions. Activating one destination
made `count(live) > 1` reachable and broke an unconditional revert that had been
fine for years. Grep the callers of the newly-live thing for unconditional writes
that assume single-instance state, and add a test that constructs the newly-reachable
combined state.
