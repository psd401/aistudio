---
title: When removing dead exports, verify the full import list at each call site
category: code-quality
tags:
  - dead-code
  - cleanup
  - grep-verification
  - chat-helpers
severity: medium
date: 2026-03-11
source: auto — /work
applicable_to: project
---

## What Happened

A dead-code removal PR deleted 3 entire files and removed 2 dead exports from a shared helper. All items were confirmed zero-caller via grep before removal. Typecheck and lint passed clean.

## Root Cause

When removing a named export from a shared helper file, it is easy to grep only for the target symbol and stop there. But callers import from the same file path — removing a dead export while leaving sibling exports intact is safe only if the import statement at each call site is also narrowed or still valid after removal.

## Solution

Before removing any export from a shared file:

1. Grep for the symbol name to confirm zero callers — as usual.
2. Also grep for the file path itself (`import.*from.*"@/lib/some-helper"`) and inspect the full import list at each site.
3. Confirm no co-imported symbol is accidentally invalidated or left with a stale path after the file is modified.

## Prevention

Treat "dead export removal" as a two-step grep: symbol-level AND import-site-level. The second check takes seconds and catches cases where the file restructure breaks a still-live sibling import.
