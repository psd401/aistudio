---
title: docx numbering reference without a distinct instance shares ONE counter across all ordered lists
category: integration
tags:
  - docx
  - numbering
  - document-generation
severity: medium
date: 2026-10-18
source: auto — issue #1898, PR #1941
applicable_to: project
---

## What Happened

Building DOCX output with the `docx` package, giving every ordered-list
paragraph `numbering: { reference, level }` without an `instance` made Word
run a single counter for the whole document — a second ordered list in the
same doc continued "3. 4." instead of restarting at "1.".

## Root Cause

`docx`'s numbering `reference` identifies the abstract numbering *definition*
(the 1./a./i. format); the per-list restart-at-1 counter is the `instance`.
Omitting `instance` leaves every paragraph pointing at the same implicit
counter.

## Solution

`document-docx-builder.ts` assigns a distinct `instance` per Markdown-source
list (`block.listId`), which required the block-IR (`markdown-blocks.ts`) to
carry a per-list id through — a flat block stream alone can't tell two
adjacent lists apart without it.

## Prevention

When generating DOCX ordered lists programmatically, always pass a unique
`instance` per logical list, not just a shared `reference`.
