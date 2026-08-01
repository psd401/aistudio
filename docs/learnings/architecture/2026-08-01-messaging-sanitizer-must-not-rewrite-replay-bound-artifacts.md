---
title: A messaging sanitizer must not rewrite replay-bound artifacts without a processor-version bump
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
adds `sanitizeTextForMessaging` and applies it at the SQS payload chokepoint. It
also sanitizes searchable segments at write time via
`sanitizeProcessedContent`, called from `publishProcessedContent`.

The initial write-time pass sanitized canonical text too. Although it was
removal-only, it would change the bytes of any previously published poisoned
artifact and violate the platform's replay binding before the repaired item
could reach embedding fan-out.

## Root Cause

`publishDocumentVersion` → `assertCanonicalArtifactReplayBinding` requires that
reprocessing an already-published item version reproduce its canonical artifact
exactly. The binding is keyed on
`{itemVersionId, kind: canonical_text, processorName, processorVersion}` and
compares the stored SHA-256 (and inline text) against the replay:

```typescript
if (storedSha256 && storedSha256 !== canonicalTextSha256) {
  throw new Error("Existing canonical artifact SHA-256 does not match the replay")
}
```

NFC normalization is not a no-op on legitimate text: it rewrites many
SQS-legal code points that are routine in extracted PDF output, including
EN/EM QUAD spacing, ANGSTROM SIGN, CJK compatibility ideographs, and
NFD-decomposed accents. A normalizing sanitizer would therefore break replay
for clean content.

Removal-only sanitization is still unsafe for canonical text. It changes fewer
artifacts, but it changes exactly the previously published poisoned artifacts
the production repair needs to replay. Canonical text is not an SQS payload, so
rewriting it buys no messaging safety and makes those items terminally
unrecoverable under their existing processor version.

## Solution

1. **Sanitize only messaging-bound content.** Searchable segment content and
   context prefixes become chunk rows and SQS payloads, so they are sanitized at
   write time. Canonical text and additional artifacts are never queued, so they
   remain byte-identical for replay.
2. **Keep the send-time chokepoint load-bearing.** Existing poisoned chunk rows
   cannot be repaired by write-time hygiene. `embeddingMessage` sanitizes them
   immediately before serialization, and batch sizing measures that exact body.
3. **Keep the messaging sanitizer removal-only.** Deletion makes SQS payloads no
   larger, preserves clean segment identity, and lets `sanitizeProcessedContent`
   recompute `contentHash` only for changed segment content.
4. **Any canonical-artifact transform requires a `processorVersion` bump.** The
   new version changes the artifact key and mints a new replay binding instead
   of violating the old one.
5. **Classify deterministic failures as terminal.** `PERMANENT_MESSAGE` includes
   the SQS invalid-body strings and canonical replay mismatch errors so neither
   class burns the full retry budget.

## Prevention

- Before adding any transform, ask what downstream consumer hashes or replays
  its output. If content is replay-bound, even removal-only sanitization needs a
  processor-version bump when previously stored bytes can contain the removed
  characters.
- Keep transport hygiene at the narrowest shared transport boundary, then add
  write-time hygiene only to fields that actually reach that transport.
- Do not reason from "the sibling sanitizer does it." Different consumers can
  have different byte-identity contracts.
- Test the property directly: unsafe characters confined to canonical text must
  leave the processed-content object unchanged, while the same characters in a
  searchable segment must be removed and its content hash recomputed.
