---
title: Re-reading data on dialog/panel open to seed form state can clobber an edit already in progress
category: logic
tags:
  - form-state
  - race-condition
  - dirty-flag
  - atrium
severity: medium
date: 2026-07-25
source: auto — /work #1336 (PR #1339)
applicable_to: project
---

## What Happened

A panel re-fetched its source record on open and used the response to seed local
form state. If the user started editing before the async read landed, the read's
resolution overwrote their in-progress changes.

## Root Cause

The seed-on-read effect had no awareness of whether the user had already touched
the form; it always overwrote local state with the fetch result regardless of
timing.

## Solution

Track a `dirty` flag, set on first user edit. The seed effect only applies fetched
data if `dirty` is false. Reset `dirty` on open/close/save so the next open starts
clean.

## Prevention

- Any "re-read to refresh, then seed form state" pattern on open needs a dirty
  guard — the fetch and the user's first keystroke are an unordered race by
  default.
