---
title: docx copies a numbering definition's first-level `start` into every instance — a non-1 list start needs its own definition
category: integration
tags:
  - docx
  - numbering
  - document-generation
severity: low
date: 2026-10-19
source: auto — issue #1898, PR #1941 (Codex review round 3)
applicable_to: project
---

## What Happened

Markdown `5. Fifth / 6. Sixth` rendered as "1. 2." in the generated Word
document. `marked` exposes the first number as `Tokens.List.start`, but the
block IR kept only the `ordered` flag, so the DOCX builder never saw it.

## Root Cause

Two layers dropped the value. The IR had no field for it, and even with one
there is no obvious place to put it on the `docx` side: a paragraph's
`numbering: { reference, level, instance }` has no `start`, and
`Numbering.createConcreteNumberingInstance()` is the only way an instance is
made. That method copies the *definition's* first-level `start` into the
instance's `startOverride` (or 1 when absent) and exposes no per-instance
override — `IConcreteNumberingOptions.overrideLevels` exists but is internal.

## Solution

- `markdown-blocks.ts` carries `start` on a `listItem` only when the list's
  first number is not 1 (mirrors `checked`: absent means nothing to restore).
- `document-docx-builder.ts` declares one numbering definition per distinct
  start value in the document (`psd-ordered-list-from-5`), with `start` on its
  level 0, and points each list's paragraphs at the definition for its own
  start. Nested lists keep the default: Word restarts a nested level from the
  definition's value under every parent item, so honouring one nested start
  would renumber its siblings too.

## Prevention

When a `docx` list must start at N, set `start` on level 0 of a dedicated
numbering definition; do not look for it on the paragraph or the instance.
Verify by reading `<w:startOverride w:val="N"/>` inside the instance's
`<w:num>` in `word/numbering.xml` — that override, not the abstract
definition's `<w:start>`, is what Word honours.
