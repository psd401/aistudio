# PSD Observances Live Retrieval Evaluation

This gate measures the direct-PDF repository, not a mock. The committed
[`retrieval-cases.json`](retrieval-cases.json) fixture contains 20
source-verified questions:

- 12 Class A named lookups across observances, Washington school holidays,
  conferences, and the six-year summary;
- 8 Class B enumeration questions; and
- expected answers represented only as names, dates, and printed-PDF page
  numbers.

No NSPRA source prose belongs in the fixture, report, test output, or Git
history.

## Run against a named environment

Use a short-lived API key with only `repositories:list`, `repositories:read`,
and `repositories:search`. Supply it through an environment variable so it
does not appear in the process list:

```bash
export PSD_OBSERVANCES_EVAL_API_KEY="<short-lived key>"

bun run eval:skill:psd-observances-retrieval -- \
  --environment dev \
  --base-url https://dev.aistudio.psd401.ai \
  --out /tmp/issue-1477-dev-retrieval-report.json

unset PSD_OBSERVANCES_EVAL_API_KEY
```

The runner calls the live MCP endpoint but executes every question through
`psd-observances/run.js`, including runtime NSPRA repository resolution,
command-specific query shaping, result caps, excerpting, and citation shaping.
Raw retrieval excerpts remain in memory and are discarded after scoring.
Progress and saved reports contain only question ids, expected fact
names/dates, page numbers, counts, timing, and aggregate scores.

Run the skill unit and fixture-contract tests separately:

```bash
bun run test:skill:psd-observances
```

## Scoring and decision

- Class A accuracy is the fraction of named questions for which every expected
  fact was returned.
- Class B recall is the number of expected enumeration facts returned divided
  by the total expected facts.
- Citation correctness is scored separately for every expected fact against
  its printed-PDF page.
- Class A accuracy below 90% requires ingest/retrieval investigation before a
  chunking decision.
- Otherwise, Class B recall below 80% recommends structured-markdown
  regeneration.
- Class A accuracy at least 90% and Class B recall at least 80% means the
  direct PDF is sufficient.

Extra retrieved facts do not reduce a score: recall, not precision, is the
enumeration decision metric.

The first dev measurement and its post-investigation recommendation are in
[`dev-2026-07-30-report.md`](dev-2026-07-30-report.md).

## OCR-page check

The live retrieval run must be paired with a source-PDF extraction using
`lib/repositories/content-platform/pdf-processing.ts`. Record
`needsOcrPages`, then inspect the active repository chunks for those pages
using counts or hashes rather than copying source text. Report whether OCR
introduced any spurious content.

Keep the source PDF and any extraction/transcript artifacts in an
issue-specific temporary directory outside the repository, and remove them
after the evaluation.
