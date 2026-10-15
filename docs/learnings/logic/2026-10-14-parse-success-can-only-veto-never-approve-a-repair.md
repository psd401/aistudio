---
title: A syntax check can only veto a repair, never approve one — and must verify its own veto
category: logic
tags:
  - psd-rules
  - literal-newline-repair
  - compile-as-safety-check
  - utf8-bom
  - tokenize
  - python
  - javascript
severity: high
date: 2026-10-14
source: auto — /work
applicable_to: project
---

## What Happened

Issue #1896 / PR #1930: `repair_literal_newlines.py` (psd-rules skill) repairs source files whose real line breaks arrived as the literal two-character sequence `\n`. It judged the whole file at once — "repair only if `compile()` fails and the file has <=2 real lines" — so it refused the common *partial*-collapse shape (most lines fine, one line collapsed) and silently left it unrepaired.

## Root Cause

"It parses" was used as a "nothing to do" short-circuit, but a collapsed file can be syntactically valid: a file starting `#!/usr/bin/env python3\n...` is one Python comment, so `compile()` succeeds on a completely broken file. Separately, `compile()` raises `SyntaxError` on a UTF-8 BOM'd `str` even though CPython runs the identical file fine (PEP 263 strips the BOM from bytes) — so BOM'd files were always treated as "broken," silently disabling the protective check for all of them. Neither failure was caught by reading the code; both were found by reproducing a failure on a file that worked before the tool touched it.

## Solution

- Judge line-by-line, not file-by-file: for Python, use `tokenize` STRING/FSTRING token spans (the only thing that correctly sees triple-quoted strings) to tell which lines are collapsed bodies vs. multi-line string continuations; for JS/TS (no stdlib parser), scan the whole file as one stream with a stack tracking template-literal `` ` `` nesting through `${}` interpolation — a flat backtick toggle misreads the backtick that *opens* a nested template as the one that *closes* the outer one.
- Let a parse check only veto a repair ("still won't parse, don't touch it"), never approve one ("it parses, so it's fine") — and require a second proof (does it still parse *after* the edit?) before trusting the veto.
- Decode with `utf-8-sig` and restore the BOM on write, so BOM'd files get the real protective check instead of a false "broken" verdict.
- Scoped repair strictly to extensions whose comment/string rules are modelled (`.py`, `.js`/`.ts`, `.json`); a previous generic fallback silently gave `.sh`/`.md` zero protection while appearing supported.

## Prevention

- Treat "it parses" as evidence of absence of one failure mode, not proof of correctness — a syntactically valid file can still be semantically destroyed.
- When a heuristic (regex-vs-division, backtick toggle, brace counting) can't distinguish two real cases, don't add more rules to narrow the gap — add a bail-out ("unclassifiable, refuse") with a documented exit code. Refusing is cheap; silently corrupting a working file is not.
- Reproduce the failure on a real file first — these defects were found by running the tool, not by reading its docstring (which claimed the opposite behavior).
- **Enumerate the set, then its interactions.** Twenty findings over five review rounds were all one mistake in a new costume: a construct where the escape is legitimate, read as evidence. Fixing them one at a time never converged. What converged was listing every construct in which the sequence is legitimate per language — in valid Python and JSON a backslash can only appear in a string or a comment; in valid JavaScript only in a string, template, regex or comment — and asserting a working file of each kind comes back byte-identical.
- Then test the **interactions**, because that is where the later rounds' bugs lived: the same construct placed before and after a genuinely broken line, and the same construct with CRLF endings. A per-construct table passes while a per-interaction table still fails — a tokeniser that stops at the broken line leaves a later literal unprotected, and a whole-file judgement lets one real candidate drag a legitimate neighbour into the edit with it.
- Prefer per-item decisions to group ones in any "which of these do I touch" loop: an `all(...)` over candidates let one genuine candidate cancel the protection earned by another.
