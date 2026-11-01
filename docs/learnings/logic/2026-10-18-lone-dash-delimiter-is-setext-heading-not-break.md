---
title: A documented "lone --- line" convention parses as a setext heading, not a thematic break
category: logic
tags:
  - markdown
  - marked
  - nexus
  - documents-create
severity: medium
date: 2026-10-18
source: auto — issue #1898, PR #1941
applicable_to: project
---

## What Happened

`documents.create`'s PPTX convention documents slides as "separated by a line
containing only `---`", written without a blank line before the delimiter:
`Slide one\nbody\n---\nSlide two`. Any code that parses that body as CommonMark
(including `marked`) treats the `---` as a **setext heading underline** for the
preceding line, not a thematic break — so slide-splitting silently stops.

## Root Cause

CommonMark only treats `---` as a thematic break when it is not immediately
preceded by a paragraph line; directly after one, it closes that paragraph as
an `<h2>`. The documented convention predates this parsing path and never
accounted for it.

## Solution

`normalizeSlideDelimiters()` in `lib/ai/markdown-blocks.ts` inserts a blank line
before any lone `---` line before handing the text to `marked`, forcing the
thematic-break interpretation without changing the documented authoring format.

## Prevention

When parsing externally-documented "plain `---` separator" text as Markdown,
normalize spacing around the delimiter first — don't assume the delimiter's
plain-text appearance matches the parser's structural meaning of it.
