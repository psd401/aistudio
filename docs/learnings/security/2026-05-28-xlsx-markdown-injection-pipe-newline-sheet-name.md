---
title: SheetJS XLSX-to-Markdown conversion requires pipe, newline, and sheet-name escaping
category: security
tags:
  - xlsx
  - sheetjs
  - markdown
  - injection
  - document-processing
  - office-processor
severity: high
date: 2026-05-28
source: auto — lfg-issue-993
applicable_to: project
---

## What Happened

PR #1005 fixed three injection vectors in `office-processor.ts` when rendering XLSX data as Markdown:

1. **Pipe injection** — cell values containing `|` characters broke Markdown table syntax and could inject extra columns or rows.
2. **Newline injection** — cell values containing `\n` or `\r` characters escaped the current table row and injected arbitrary Markdown below it.
3. **Sheet name injection** — the sheet name was interpolated directly into a Markdown heading (`## SheetName`) without sanitization; a sheet named `Sheet1\n\n<script>` would inject HTML or break the document structure.

## Root Cause

SheetJS (`xlsx`) parses cell values as raw strings. When those strings are embedded verbatim into Markdown table syntax, special Markdown characters (`|`, `\n`, `\r`) are not content — they are structure. Treating cell data as safe text is incorrect because the Markdown renderer sees them as control characters.

## Solution

Escape cell values and sheet names at the point of Markdown construction:

```typescript
// Escape pipe and newline characters in cell values
function escapeCellValue(value: string): string {
  return value
    .replace(/\|/g, "\\|")       // escape pipe to avoid table column break
    .replace(/\r?\n/g, " ");     // flatten newlines to a space
}

// Sanitize sheet name before interpolating into a Markdown heading
function sanitizeSheetName(name: string): string {
  return name
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

// Usage
const heading = `## ${sanitizeSheetName(ws.name)}\n\n`;
const row = cells.map(escapeCellValue).join(" | ");
```

## Prevention

- Any time SheetJS cell values or sheet metadata are embedded in Markdown (tables, headings, code blocks), apply pipe-and-newline escaping.
- Treat sheet names as user-controlled even when they come from a "known" file — file contents are attacker-controlled in document-upload flows.
- During PR self-review on XLSX processing code, search for all string interpolation sites involving cell data and verify each one escapes before embedding.
- Also enforce `MAX_ROWS_PER_SHEET` truncation (500 rows) to prevent unbounded Lambda output that can exhaust memory or response size limits.
