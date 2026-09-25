---
title: Viewport breakpoints lie inside resizable split-pane columns — use container queries
category: ui
tags: [tailwind, container-queries, responsive, split-pane, overflow, nexus]
severity: medium
date: 2026-09-24
source: auto — /work
applicable_to: project
---

## What Happened

Nexus chat/workspace split panel overflow (issue #1793, PR #1831): with the workspace panel
open at a 1255px window, the composer control dock measured `scrollWidth: 431` inside
`clientWidth: 371` (so "Connect" clipped to "Con…" under `overflow-hidden`), and the starter
card grid measured `scrollWidth: 438` inside `clientWidth: 373`.

## Root Cause

Tailwind `sm:`/`md:` breakpoints key off the viewport, not the column the element actually
lives in. A `sm:grid-cols-2` grid rendered two columns because the *window* was wide, even
though the *panel* it sat in was narrow. Separately, the shared shadcn `Button` base class
sets `whitespace-nowrap`, so each starter card's min-content width became the length of its
entire sentence — an unshrinkable floor no grid/flex sizing could reduce.

## Solution

- Replaced viewport breakpoints with a Tailwind v4 container query: wrap the region in
  `@container/composer` (or similar named container) and gate columns/wrapping on `@sm:` etc.,
  not `sm:`.
- Added `flex-wrap` to the composer control dock so it wraps instead of clipping.
- Overrode the inherited `whitespace-nowrap` with `whitespace-normal` + `min-w-0` on the
  starter cards so text can actually wrap.

## Prevention

- In any panel/split/drawer layout, never reach for `sm:`/`md:`/`lg:` on content nested inside
  a resizable or fixed-fraction column — use CSS container queries instead.
- When diagnosing overflow inside a shared component (Button, Card, etc.), check for an
  inherited `whitespace-nowrap` before assuming the sizing/grid classes are the bug — it turns
  a text node into a fixed min-content floor that no flex/grid sizing can shrink.
