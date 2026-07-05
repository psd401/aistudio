---
title: A bulk export/serialization must walk the visibility-filtered tree, not raw rows — filtering only leaf objects still leaks container names
category: security
tags:
  - authorization
  - information-disclosure
  - permission-boundary
  - export
  - serialization
  - atrium
  - canView
severity: high
date: 2026-07-05
source: auto — /lfg #1103 (PR #1111 review, chatgpt-codex P1)
applicable_to: project
---

## What Happened

Atrium Phase 8 (#1103) added `export_okf` — serialize a `content_collections`
subtree to a portable OKF bundle. The export enforced `visibilityService.canView`
on every **object** (via `listVisible`, permission pushed into SQL), so no object
the requester couldn't see landed in the bundle. That felt like the whole
permission story — the acceptance criteria were even written as "a student-identity
bundle excludes staff-only objects."

But the subtree itself was built from `loadAllCollections()` — **every row** in
`content_collections` under the root — and for each collection the exporter emitted
an `index.md` (with the collection **name**), a `log.md`, and child-collection
links. So a `content:read` caller who exported a parent collection learned the
**names and slugs of every descendant collection**, including private/group
sections they cannot enter and sections with zero visible objects. In a `public`
bundle (meant for anonymous distribution) those hidden section names would escape
entirely. The leak was of *container* metadata, not leaf content — which is exactly
the gap object-level filtering leaves open.

## Root Cause

Two different granularities have two different visibility rules, and only one was
enforced:

- **Objects** have per-object `canView` (level + grants). This WAS enforced.
- **Collections** have no per-object grant table; they are "enterable or not" by
  the level rule + whether they hold a visible object — the logic already encoded
  in `collectionService.tree(req)` / `computeKeepSet` (what the reader sidebar uses,
  §21). This was NOT enforced — the export walked raw rows.

## The Fix

Build the exported subtree from the **already-visibility-filtered tree**, never
from raw rows:

```ts
const tree = await collectionService.tree(req);   // the reader-sidebar filter
const rootNode = findNode(tree, rootCollectionId);
if (!rootNode) throw new NotFoundError(...);       // unenterable root → 404 (mask)
const { subtree, childrenByParent } = flattenVisibleSubtree(rootNode);
// every collection + child-link now comes from the visible tree only
```

An unenterable root 404s (existence-masking, consistent with content reads). Child
links come from the visible tree, so a hidden sibling is never named.

## The Rule

When you **serialize or export a container hierarchy** (collections, folders,
projects, boards…), filtering the leaf items by the read predicate is **not
sufficient** — the container names/slugs/structure are themselves disclosure.
Drive the walk from the same visibility-filtered structure the interactive UI
already uses (here `collectionService.tree(req)`), so containers the requester
cannot enter are absent entirely, not merely emptied. "I filtered the objects" is a
false sense of security whenever the output also names the objects' containers.

Corollary: a portable artifact (a bundle, a zip, a report) is the highest-stakes
place to get this right — it escapes `canView` the moment it is written, so any
name that leaks into it leaks permanently.
