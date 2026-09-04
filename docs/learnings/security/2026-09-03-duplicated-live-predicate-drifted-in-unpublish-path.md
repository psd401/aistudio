---
title: Consolidating a duplicated predicate must include the write path's own internal check — the one that decides side effects
category: security
tags:
  - atrium
  - authorization
  - visibility
  - multi-surface
  - rag
  - okf
  - drift
severity: high
date: 2026-09-03
source: /lfg #1726 (PR #1732)
applicable_to: project
---

## What happened

Issue #1726 consolidated Atrium's "is this object live?" check. Five READ gates were
each hand-writing `destination = 'public_web' AND status = 'live'`, and all five were
routed through one helper.

A sixth reader of the same table was missed: `publishService.unpublish`'s own
`stillLive` check, which decides whether to revert the object to `draft` and whether
to prune its retrieval index. That query selected `content_publications` rows with
`status = 'live'` for ANY destination — no destination constraint at all.

That had always been true, and had always been harmless, because every destination
that could be live was a reader surface. #1726 changed that: the new shared predicate
deliberately EXCLUDES `okf` (an Open Knowledge Format export bundle in S3 — a
portable file, not a page). So the moment the readers narrowed, the write path's
check was broader than every one of them.

The concrete failure: an object exported to OKF and then unpublished kept
`status = 'published'` and kept its retrieval index. The Share dialog said Draft (it
asks `isLive`, which excludes `okf`), `/c/{slug}` and `/p/{slug}` both 404'd — and
assistant retrieval kept serving the content the author had just taken down. Invisible
in every UI and every reader, live only in RAG.

Found by adversarial review, not by the consolidation pass.

## Root cause

The consolidation was driven by the duplicated literal — grep for
`destination = 'public_web'` finds the five read gates. The write path never contained
that string: it was an independently authored check expressing the same concept in a
different shape (`status = 'live'`, unscoped), so no text search for the read
predicate's tokens could surface it.

The deeper trap is that the write path's check was CORRECT before the change. Narrowing
a shared definition silently widens every check that was written against the old,
broader one.

## Fix

Scoped `stillLive` (and therefore `anyLiveRemaining`, which gates the index prune) to
the same `LIVE_SURFACE_DESTINATIONS` the readers use, so all three predicates over the
table agree. A unit test now pins it: with only an `okf` row remaining, the object
drafts and the index prunes.

## Prevention

- When consolidating a predicate, enumerate every READER OF THE TABLE, not every
  occurrence of the string. Include the write paths' own internal checks — the ones
  that decide side effects ("should I also revert the status", "should I prune the
  search index", "should I invalidate the cache"). They re-derive the same fact
  independently and will not match a grep for the read path's phrasing.
- NARROWING a shared definition is the dangerous direction. Every check written
  against the old broader meaning is now wrong, and it is wrong in the permissive
  direction: it will report "still live" for things that no longer are.
- A predicate disagreement between a UI, a reader, and an index-pruning decision shows
  up as content that is invisible everywhere a human looks and still present in RAG —
  the hardest place to notice it.
