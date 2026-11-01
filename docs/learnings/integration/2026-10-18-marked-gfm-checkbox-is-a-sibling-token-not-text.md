---
title: marked's GFM task-item checkbox is a text-less sibling/inline token — read item.task/item.checked, not .text
category: integration
tags:
  - marked
  - gfm
  - task-list
  - markdown
severity: low
date: 2026-10-18
source: auto — issue #1898, PR #1941
applicable_to: project
---

## What Happened

`marked` represents a GFM task item (`- [x]` / `- [ ]`) by injecting a
text-less `checkbox` token — as a sibling of the item's text tokens in a
*tight* list, but spliced into the first paragraph's inline tokens in a
*loose* list. A walker keyed off `.text` silently drops the token in both
shapes, so `[x]` and `[ ]` render identically (both just the label).

## Root Cause

The `checkbox` token carries no text content; the checked state is only
reliably exposed on the parent `ListItem` object as `item.task` (is this a
task item) and `item.checked` (its state) — set consistently regardless of
tight/loose list shape.

## Solution

`lib/ai/markdown-blocks.ts` reads `item.task === true` / `item.checked` off
the `ListItem` directly rather than trying to detect or extract the
`checkbox` child token.

## Prevention

When walking `marked`'s token tree for list items, get task state from
`item.task`/`item.checked`, not by searching child tokens for a `checkbox`
type or non-empty text.
