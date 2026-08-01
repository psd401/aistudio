---
title: The /u flag makes lone-surrogate detection a one-liner — and a /g regex reused for .test() leaks lastIndex between callers
category: logic
tags:
  - regex
  - unicode
  - surrogate-pairs
  - lastIndex
  - text-sanitization
  - sqs
severity: medium
date: 2026-08-01
source: auto — /lfg (issue #1525, PR #1532)
applicable_to: universal
---

## What Happened

`sanitizeTextForMessaging` (`lib/utils/text-sanitizer.ts:136`) must strip the
code points SQS rejects — including **unpaired** surrogates — while preserving
emoji and supplementary-plane CJK, which are encoded as *well-formed* surrogate
pairs in a JS string. The naive reading is that this needs a manual pair-scanner
that walks the string tracking high/low surrogates. It does not.

The same character class is needed twice: once to `.replace()` and once as a
cheap predicate (`containsMessagingUnsafeCharacters`,
`lib/utils/text-sanitizer.ts:157`). Reusing a single `/gu` regex for both is a
correctness bug.

## Root Cause

Two independent JS regex facts:

1. **Under the `u` flag, a regex operates on code points, not code units.** A
   well-formed surrogate pair is a *single* code point in `[#x10000-#x10FFFF]`,
   so the character class `[\uD800-\uDFFF]` can never match it — it matches only
   surrogate code units that are genuinely unpaired. Without `/u`, that same
   class shreds every emoji in the corpus.
2. **A regex with `/g` carries mutable `lastIndex` across `.test()` calls.**
   `re.test(x)` advances `lastIndex` on a match and only resets on a miss, so a
   shared `/g` instance returns alternating true/false for the *same* input
   depending on who called it last — a stateful global masquerading as a pure
   predicate.

## Solution

Build the class once as a string, then instantiate it twice with different
flags:

```typescript
const MESSAGING_UNSAFE_CHARACTER_CLASS =
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F' +
  '\\uD800-\\uDFFF' +      // /u ⇒ lone surrogates only; pairs untouched
  '\\uFDD0-\\uFDEF' +
  '\\uFFFE\\uFFFF' +
  SUPPLEMENTARY_NONCHARACTER_RANGES +
  ']';

// Global instance drives .replace(); non-global instance backs the predicate.
const MESSAGING_UNSAFE_PATTERN = new RegExp(MESSAGING_UNSAFE_CHARACTER_CLASS, 'gu');
const MESSAGING_UNSAFE_PROBE   = new RegExp(MESSAGING_UNSAFE_CHARACTER_CLASS, 'u');
```

Verified exhaustively in `lib/utils/__tests__/text-sanitizer.test.ts`: all
2048/2048 lone surrogates (`\uD800`–`\uDFFF` standing alone) are detected, and
0 well-formed pairs are broken. The suite also pins the invariant
`containsMessagingUnsafeCharacters(t) === (sanitizeTextForMessaging(t) !== t)`,
which is exactly the assertion a `lastIndex` leak would fail.

Supplementary ranges are built programmatically rather than typed out, so the
`\u{n FFFE}`/`\u{n FFFF}` noncharacter pair in each of the 16 astral planes
can't be fat-fingered:

```typescript
const SUPPLEMENTARY_NONCHARACTER_RANGES = Array.from({ length: 16 }, (_u, i) => {
  const cp = (i + 1) * 0x10000 + 0xfffe;
  return `\\u{${cp.toString(16)}}-\\u{${(cp + 1).toString(16)}}`;
}).join('');
```

## Prevention

- Any regex touching user/document text should carry `/u`. Without it,
  character classes silently operate on UTF-16 code units and mangle
  supplementary-plane content.
- Don't hand-roll surrogate-pair scanning to find lone surrogates —
  `/[\uD800-\uDFFF]/u` already means exactly "unpaired surrogate".
- Never call `.test()` on a module-level `/g` (or `/y`) regex. Either drop the
  flag for the predicate instance, or reset `lastIndex = 0` before every call.
  Prefer two instances built from one shared source string so the two can't
  drift apart.
- When exporting both a "fix it" and an "is it broken?" function over the same
  rule, pin their equivalence in a test — it catches both class drift and
  `lastIndex` leaks in one assertion.
