---
title: A greedy negated class before a required literal is quadratic, and detect-unsafe-regex does not flag it
category: security
tags:
  - redos
  - regex
  - eslint
  - lambda
  - dos
  - email-triage
severity: high
date: 2026-10-04
source: auto — /lfg #1861
applicable_to: project
---

## What Happened

While fixing #1861 I replaced `text.includes("?")` with a clause matcher,
`/[^.!?\n]*\?/g`, to tell a question put to the reader from a rhetorical
marketing one. It passed `bun run lint` with `--max-warnings 0`, including
`security/detect-unsafe-regex`. It was quadratic.

Measured on the real input:

| input length | time |
|---|---|
| 2,000 | 3.8 ms |
| 8,000 | 48.2 ms |
| 32,000 | 617.4 ms |
| 64,000 | **2,485.3 ms** |

16x per 4x of length. An independent reviewer reproduced the same curve out
to 400,000 chars / 107 seconds.

## Root Cause

Two separate things had to be true.

**1. The pattern is quadratic without a nested quantifier.** On text
containing no `?`, the greedy `[^.!?\n]*` consumes to the end of the
string, fails to find the required `\?`, backtracks one character at a
time, and then the entire walk repeats from the next start position.
`safe-regex`, which backs `security/detect-unsafe-regex`, scores *star
height* — nested quantifiers like `(a+)+`. A single `*` followed by a
required literal has star height 1, so the rule passes it. **A clean
`detect-unsafe-regex` run is not evidence that a regex is linear.**

**2. The input was unbounded and attacker-controlled.**
`detectContentSignals` builds
`(subject + "\n" + body).slice(0, OPENING_TEXT_CHARS + subject.length)`.
That cap bounds the *body* at 400 chars but adds `subject.length`
unconditionally, so the **subject is never truncated**. The subject is an
RFC 5322 header from any sender on the internet, foldable to arbitrary
length. This runs for every inbound message on a 4-minute Lambda behind a
per-user FIFO queue with 25 reserved concurrent executions — a single
email was a per-user DoS with a 30-minute SQS redelivery after the stall.

The slice expression was pre-existing and looked like a bound. It is only a
bound on one of its two inputs.

## Solution

Replaced the regex with an explicit single-pass character scan: visit each
character once, test each `?`-terminated clause once. Same inputs:
64,000 → 0.1 ms (25,000x), 1,000,000 → 1.7 ms.

Equivalence was not assumed. The new implementation was **differentially
fuzzed against the regex version over 200,016 inputs** drawn from an
alphabet built to stress every shared boundary (`.`, `!`, `?`, newline,
bare and contracted second-person forms, stray apostrophes, empty clauses,
adjacent terminators). Zero mismatches. A 1 MB canary test now pins the
linearity with a deliberately loose bound, so it cannot flake under load
but fails outright on a regression to a backtracking implementation.

## Prevention

- **Treat a greedy quantifier followed by a required literal as suspect**,
  even when it is a negated class and even when the linter is silent. Ask
  what happens when the literal is absent from the input.
- **Check what actually bounds the input.** `slice(0, CAP + x.length)` caps
  nothing when `x` is attacker-controlled. Grep for `.length` inside a
  slice bound.
- **When replacing a regex with hand-written scanning, fuzz the two against
  each other** rather than hand-picking cases. It is cheap (one script,
  200k cases, seconds) and it is the only way to be sure a performance
  rewrite did not change behaviour.
- The same applies to the companion defect found later in review: a
  character that *usually* ends a sentence often does not (`v1.2`,
  `example.com`, `3.5`, a hard line wrap in a plain-text body). Clause
  splitting on raw punctuation needs the token-interior cases enumerated,
  and both directions tested — the fix must not re-open the hole the
  splitting existed to close.
