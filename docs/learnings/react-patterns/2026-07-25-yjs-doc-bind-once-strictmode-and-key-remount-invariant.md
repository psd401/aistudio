---
title: Yjs Y.Doc binds once to TipTap — StrictMode cleanup and missing remount key both break it
category: react-patterns
tags:
  - yjs
  - tiptap
  - strictmode
  - collaboration
  - remount
  - atrium
severity: high
date: 2026-07-25
source: auto — /work #1336 (PR #1339)
applicable_to: project
---

## What Happened

`useCollabSession` destroyed its `Y.Doc` in the effect cleanup. Under dev-only
StrictMode double-invoke the component stays mounted, so cleanup killed the doc
TipTap was already bound to, and the re-run effect bound a fresh provider to a
dead doc — first sync never completed (byline stuck "connecting…"). Removing the
destroy-on-cleanup then made "one `Y.Doc` per document id, component remounts on
id change" load-bearing: `WorkspacePanel` mounted `DocumentEditor` with no `key`
and reset state during render instead of remounting, so switching documents bound
a provider for doc B to a Y.Doc still holding doc A's content — Yjs sync is a CRDT
merge, not an overwrite, so A's content would merge into B server-side.

## Root Cause

`Collaboration.configure({ document: ydoc })` binds the Y.Doc to the editor exactly
once at construction — it cannot be swapped later. Any code path (StrictMode
cleanup, a missing `key`) that keeps the component alive while expecting a new doc
violates that bind-once contract.

## Solution

- Don't destroy the Y.Doc in effect cleanup; its lifetime is the component's, not
  the effect's.
- Defend the invariant inside the hook itself: record the document id the Y.Doc
  was created for, and fail closed (throw/reset) if a later call requests a
  different id instead of trusting the caller to remount via `key`.

## Prevention

- When correctness depends on a `key`-driven remount (React only fully resets
  state/effects when `key` changes), don't trust every call site to supply it —
  make the hook itself detect an id mismatch and fail rather than silently
  reusing stale state.
- See also `integration/2026-06-26-yjs-collab-server-bun-and-ws-listener-race.md`
  for other Yjs/collab transport gotchas in this codebase.
