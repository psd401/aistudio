---
title: TipTap BubbleMenu registers its plugin before editability flips — toolbar stays dead
category: react-patterns
tags:
  - tiptap
  - prosemirror
  - bubblemenu
  - useEffect
  - useLayoutEffect
  - atrium
severity: medium
date: 2026-07-25
source: auto — /work #1336 (PR #1339)
applicable_to: project
---

## What Happened

A `BubbleMenu` stayed dead (never showed) until an unrelated transaction changed
the document, even though `editor.isEditable` was already true by the time the
user tried to select text.

## Root Cause

Child passive effects run before the parent's. The `BubbleMenu` registered its
ProseMirror plugin while `editor.isEditable` was still `false` (parent hadn't
flipped it yet). Its constructor-time `shouldShow` sampled `false` at that
moment. `editor.setEditable()` does not re-evaluate `shouldShow` — ProseMirror's
`updatePluginViews` early-returns when the selection/doc are unchanged, so the
plugin's stale sampled state persists until some other transaction forces a
re-evaluation.

## Solution

- Flip editability in `useLayoutEffect` (runs top-down, parent before child)
  instead of `useEffect`.
- Mount the `BubbleMenu` based on `editor` existing, not on a separate permission
  flag — `shouldShow` already internally gates on `editor.isEditable`, so gating
  the mount on the same flag is redundant and reintroduces the ordering hazard.

## Prevention

- Any TipTap extension whose `shouldShow`/visibility is sampled once at plugin
  construction is sensitive to effect ordering relative to `setEditable()` — use
  `useLayoutEffect` for editability toggles that gate such extensions.
