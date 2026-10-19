---
title: ExcelJS addWorksheet() throws on forbidden characters or names over 31 chars
category: runtime-errors
tags:
  - exceljs
  - xlsx
  - document-generation
severity: medium
date: 2026-10-18
source: auto — issue #1898, PR #1941
applicable_to: project
---

## What Happened

Using a document title directly as an ExcelJS sheet name turned an ordinary
request ("a spreadsheet called Q4 Results: Mathematics") into a failed
download: `wb.addWorksheet(title)` throws on any of `* ? : \ / [ ]` or a name
over 31 characters, and a colon in a title is common.

## Root Cause

ExcelJS enforces Excel's own worksheet-name rules at `addWorksheet()` call
time and throws synchronously rather than truncating/escaping — unlike the
Markdown-table sheet-name case (SheetJS reading XLSX into Markdown, see
`docs/learnings/security/2026-05-28-xlsx-markdown-injection-pipe-newline-sheet-name.md`),
this is the opposite direction (writing a new XLSX) and a hard throw, not an
injection risk.

## Solution

`safeWorksheetName()` in `lib/ai/document-generation-service.ts` strips the
forbidden character class, collapses whitespace, and truncates to 31 chars
independently of the title, which is still displayed verbatim everywhere else
the document uses it.

## Prevention

Never pass a user-supplied or model-generated title straight into
`addWorksheet()` — sanitize for Excel's sheet-name rules as a separate step
from the display title.
