---
title: New agent-broker path segments must use a prefix slugifyTitle can never emit
category: api-patterns
tags:
  - atrium
  - agent-broker
  - routing
  - slug
  - collision
severity: medium
date: 2026-10-04
source: auto — /lfg #1860 (PR #1862)
applicable_to: project
---

## What Happened

Adding a people-lookup route to the owner-bound Atrium agent broker
(`GET /api/agent/atrium`) needed a static path segment alongside
slug-addressed and UUID-addressed content routes. A bare `/people` segment
would have shadowed any content object whose slug is literally `people` —
reachable in practice, since `slugifyTitle` can produce exactly that from a
title like "People" — making that object's content permanently unreachable by
slug. The route was added as `/_people` instead.

## Root Cause

`slugifyTitle` (used by `content-service.uniqueSlug`) emits only
`[a-z0-9-]` characters, by design, so it can never produce a segment starting
with `_`. A `_`-prefixed static segment is therefore provably disjoint from
every slug and every UUID the broker also routes on. The pre-existing bare
`/collections` entry does NOT have this protection — it already shadows any
content object slugified to `collections`.

## Solution

Reserve new broker path segments with a `_` prefix (`/_people`, matching the
existing convention) and add a route test asserting the segment is reachable
even when a content object with that literal slug exists.

## Prevention

- Never add a new bare-word static segment to a broker that also does
  slug-based lookups — check what characters the slugifier can emit before
  picking a reserved word.
- The existing `/collections` entry is a known latent collision; do not copy
  its pattern for new routes.
