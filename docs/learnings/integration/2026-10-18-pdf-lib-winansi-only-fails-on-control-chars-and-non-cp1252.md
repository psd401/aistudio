---
title: pdf-lib StandardFonts (WinAnsi) handle most "smart" punctuation fine — only control chars and truly non-CP1252 glyphs throw
category: integration
tags:
  - pdf-lib
  - winansi
  - cp1252
  - fonts
  - document-generation
severity: low
date: 2026-10-18
source: auto — issue #1898, PR #1941
applicable_to: project
---

## What Happened

Building PDF export with `pdf-lib`'s `StandardFonts.Helvetica`, the assumption
that curly quotes, en/em dashes, ellipsis, bullet, euro, and accented Latin-1
letters would need transliteration was wrong — all of those are inside CP1252
(WinAnsi) and round-trip through `font.encodeText()` without error.

## Root Cause

`StandardFonts` use WinAnsi (CP1252) encoding. What actually breaks
`encodeText`/`drawText` is tab and other control characters (WinAnsi has no
slot for them) and characters genuinely outside CP1252 (arrows, CJK, Cyrillic,
emoji) — a much narrower set than "anything non-ASCII."

## Solution

`sanitizeForWinAnsi()` in `lib/ai/document-generation-service.ts` only
transliterates the specific CP1252-missing set (tab, a handful of hyphen/arrow
variants) and falls back to `?` per-character only for genuinely unencodable
characters, verified against `font.encodeText()` directly rather than assumed.

## Prevention

Before writing a broad sanitizer for a StandardFonts/WinAnsi text path, check
`font.encodeText()` against the actual character, not a general "is this
ASCII" heuristic — CP1252 covers more of Latin-1 punctuation than expected.
