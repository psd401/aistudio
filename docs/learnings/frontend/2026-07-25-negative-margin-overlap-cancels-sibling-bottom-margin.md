---
title: A negative-margin overlap exactly cancels a sibling's bottom margin — put spacing on a wrapper
category: frontend
tags:
  - css
  - margin
  - layout
  - atrium
severity: low
date: 2026-07-25
source: auto — /work #1336 (PR #1339)
applicable_to: project
---

## What Happened

An emoji tile used a `-28px` negative margin to overlap a cover band below it. A
`margin-bottom` placed on the cover band (intended to create spacing after the
whole cover unit) was exactly canceled by the tile's negative margin, collapsing
the spacing to zero.

## Root Cause

Negative margins and positive margins on elements in the same margin-collapsing
context net out arithmetically. Placing the spacing on the overlapped element
itself put it in the same context as the overlap, so the two canceled.

## Solution

Move the spacing to a wrapper element that contains both the tile and the band,
outside the overlap's margin context.

## Prevention

- When intentionally overlapping elements with negative margins, put any
  "spacing after the group" margin on an ancestor wrapper, not on either
  overlapping element.
