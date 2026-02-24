---
title: HTML Entity Decoder — Null Byte Injection and CodeQL Double-Unescaping
category: security
tags:
  - html-entities
  - codeql
  - null-byte
  - postgres
  - text-sanitization
severity: high
date: 2026-02-20
source: auto — /review-pr
applicable_to: project
---

## What Happened

PR #802 security review found that `decodeHtmlEntities` decoded `&#0;` via `String.fromCharCode(0)`, injecting a null byte into output destined for PostgreSQL storage (which cannot store U+0000). A sequential `.replace()` chain also triggered a CodeQL double-unescaping alert.

## Root Cause

- `&#0;`/`&#x0;` numeric entities resolve to U+0000, which PostgreSQL rejects
- Sequential `.replace()` chains (first decode `&amp;`, then decode others) are flagged by CodeQL as double-unescaping (the second pass operates on already-decoded output)
- `String.fromCharCode` does not handle supplementary Unicode planes correctly (surrogates)

## Solution

- Use a **single-pass regex** that matches all entity patterns in one `.replace()` call to eliminate the double-unescaping vector
- Filter decoded code points through the same control char exclusion ranges used by the existing DB sanitizer (reject U+0000–U+0008, U+000B–U+000C, U+000E–U+001F, U+FFFE, U+FFFF)
- Use `String.fromCodePoint` instead of `String.fromCharCode` for correct supplementary-plane handling

```typescript
// Single-pass, control-char-safe entity decoder
function decodeHtmlEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(\w+));/g, (match, dec, hex, named) => {
    const cp = dec ? parseInt(dec, 10) : hex ? parseInt(hex, 16) : namedEntities[named];
    if (!cp || isControlChar(cp)) return match; // keep original entity on rejection
    return String.fromCodePoint(cp);
  });
}
```

## Prevention

- Any HTML entity decoder that writes to a database must filter control chars at decode time, not just at save time
- Avoid chained `.replace()` for entity decoding — always use single-pass regex
- Test with `&#0;`, `&#x0;`, and surrogate-pair entities (`&#55357;&#56832;`) in unit tests
- Run CodeQL locally (`codeql database analyze`) before opening PR when touching string decode paths
