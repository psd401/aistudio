---
title: Opening a Radix Dialog synchronously from a DropdownMenuItem never shows it
category: react-patterns
tags:
  - radix
  - dialog
  - dropdown-menu
  - dismissable-layer
  - atrium
severity: medium
date: 2026-07-25
source: auto — /work #1336 (PR #1339)
applicable_to: project
---

## What Happened

A `DropdownMenuItem`'s `onSelect` opened a `Dialog` synchronously. The dialog
never appeared.

## Root Cause

Radix closes the dropdown menu on select and tears down its dismissable layer in
the same tick. A dialog opened synchronously inside that handler gets caught by
the menu's own dismissal logic and is closed before it can render.

## Solution

Defer the `setOpen(true)` call by a macrotask (e.g. `setTimeout(() => setOpen(true), 0)`)
so it runs after the dropdown's dismissal cycle completes.

## Prevention

- Any Radix primitive that dismisses-on-select (DropdownMenu, ContextMenu,
  Select) and triggers another overlay (Dialog, AlertDialog, Popover) in the same
  handler needs the open call deferred — this is a known Radix composition
  gotcha, not specific to one component pairing.
