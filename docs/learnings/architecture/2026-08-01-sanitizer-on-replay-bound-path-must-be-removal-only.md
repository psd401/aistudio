---
title: A sanitizer on a replay-bound path must be removal-only — normalization rewrites clean content and breaks the byte-for-byte replay assertion
category: architecture
tags:
  - unified-content-processor
  - text-sanitization
  - unicode-normalization
  - replay-binding
  - sqs
  - idempotency
  - error-classification
severity: high
date: 2026-08-01
source: auto — /lfg (issue #1525, PR #1532)
applicable_to: project
---

## What Happened

Issue #1525: 188 production index generations failed because extracted PDF text
carried U+FFFF into an SQS message body, which SQS rejects
(`Invalid binary character '#xFFFF' was found in the message body`). The fix
adds `sanitizeTextForMessaging` (`lib/utils/text-sanitizer.ts:136`) and applies
it at write time via `sanitizeProcessedContent`
(`infra/lambdas/unified-content-processor/contract.ts:207`), called from
`publishProcessedContent` (`infra/lambdas/unified-content-processor/index.ts:1779`).

The obvious "while we're here" addition — `.normalize("NFC")`, which the sibling
`sanitizeTextForDatabase` can safely do — would have been a latent outage.

## Root Cause

`publishDocumentVersion` → `assertCanonicalArtifactReplayBinding`
(`lib/repositories/content-platform/publication-service.ts:146`) requires that
**reprocessing an already-published item version reproduces its canonical
artifact exactly**. The binding is keyed on
`{itemVersionId, kind: canonical_text, processorName, processorVersion}` and
compares the stored SHA-256 (and inline text) against the replay:

```typescript
if (storedSha256 && storedSha256 !== canonicalTextSha256) {
  throw new Error("Existing canonical artifact SHA-256 does not match the replay")
}
```

NFC is not a no-op on legitimate text — it rewrites ~1,120 perfectly SQS-legal
code points that are *routine* in extracted PDF output: EN/EM QUAD spacing,
ANGSTROM SIGN, CJK compatibility ideographs, and every NFD-decomposed accent.
So a normalizing sanitizer inserted on this path would silently change the
canonical bytes for a large share of the corpus on the *first replay after
deploy*, throwing at the replay assertion — for content that was never poisoned
at all.

Second-order failure: the resulting throw message matched **no**
`PERMANENT_MESSAGE` alternative in
`infra/lambdas/unified-content-processor/lifecycle.ts:36`, so a deterministic,
never-going-to-succeed failure burned all 5 SQS retries per message.

## Solution

1. **Removal-only.** `sanitizeTextForMessaging` only ever deletes members of a
   fixed character class. Clean content therefore comes back byte-identical and
   the replay binding holds. Two further properties fall out for free: the
   result is never longer than the input (batch byte-accounting stays correct),
   and `sanitizeProcessedContent` can return untouched segments *by reference*
   and recompute `contentHash` only for segments that actually changed.
2. **Rewriting normalization belongs at extraction time, behind a
   `processorVersion` bump** — which changes the artifact key and so mints a new
   binding instead of violating the old one.
3. **Extend the terminal classifier for error classes the new code path can
   newly produce.** Sanitizing at write time makes replay-mismatch reachable, so
   `PERMANENT_MESSAGE` gained `(?:do|does) not match the replay` and
   `canonical artifact has no bound payload` alongside the original SQS strings
   (`Invalid binary character`, `set of allowed characters is`).

## Prevention

- Before adding *any* transform to a shared sanitizer, ask what downstream
  consumer hashes or replays its output. If content on the path is content-
  addressed (SHA-256 artifact keys, idempotency keys, dedup hashes), the
  transform must be **removal-only** — deletions of code points that could not
  legally have been in a valid stored artifact anyway.
- Don't reason from "the sibling sanitizer does it" — `sanitizeTextForDatabase`
  can normalize precisely because nothing replays its output.
- When a fix opens a new failure mode, audit the retry/terminal classifier in
  the same PR. A permanent failure that isn't classified permanent doesn't just
  fail — it fails 5× per message and floods the DLQ with retries that can never
  succeed.
- Test the property directly, not just the happy path: assert
  `sanitize(clean) === clean` byte-for-byte over a corpus that includes NFD
  accents and CJK compatibility ideographs. A normalizing regression is
  invisible to "did it strip U+FFFF?" tests.
