# Dev retrieval evaluation — 2026-07-30

## Result

The direct-PDF repository did not pass the retrieval gate:

| Measure | Result | Gate |
| --- | ---: | ---: |
| Class A named-question accuracy | 10/12 (83.3%) | 90% |
| Class B enumeration recall | 53/86 facts (61.6%) | 80% |
| Citation correctness | 64/108 facts (59.3%) | Reported separately |

**Recommendation: proceed with structured-markdown regeneration in #1478.**

Class A's miss required investigation before applying the Class B decision.
The investigation found the missing facts in the correct active indexed
chunks, so this was not a wrong-repository, incomplete-ingest, or OCR failure.
The live queries either ranked unrelated pages above the fact or returned the
correct page without retaining the expected fact in the skill's bounded
excerpt. Class B was independently below its 80% recall threshold.

## Environment

- Run: 2026-07-30T15:41:29Z through 2026-07-30T15:42:05Z
- Environment: dev (`https://dev.aistudio.psd401.ai`)
- Repository: `NSPRA Observances & School Calendar 2026-27` (id 166)
- Repository item: id 496, status `embedded`, active version processing
  `completed`
- Active index generation: `995bc0e7-5063-4c33-8740-5b24be0965a4`
- Canonical PDF artifact: 124 pages and 259 segments

The live repository reports `visibility: public`. This conflicts with the
staff-restricted, non-public operating requirement and needs an operational
access-control correction independent of the retrieval recommendation.

## Per-question measurements

Class A counts a question as correct only when every expected fact was present.
Citation counts are fact-level.

| Class A question id | Facts returned | Correct citations |
| --- | ---: | ---: |
| `named-american-education-week-2026` | 1/1 | 1/1 |
| `named-school-counseling-week-2027` | 0/1 | 0/1 |
| `named-paraprofessionals-day-2026` | 1/1 | 1/1 |
| `named-washington-school-holidays` | 11/11 | 7/11 |
| `named-national-pta-conference-2026` | 1/1 | 1/1 |
| `named-christmas-2029` | 0/1 | 0/1 |
| `named-school-nurse-day-2026` | 1/1 | 1/1 |
| `named-principals-month-2026` | 1/1 | 1/1 |
| `named-purim-2026` | 1/1 | 1/1 |
| `named-rosh-hashanah-2026` | 1/1 | 1/1 |
| `named-teacher-appreciation-week-2027` | 1/1 | 0/1 |
| `named-independence-day-2031` | 1/1 | 1/1 |

| Class B question id | Facts returned | Recall | Correct citations |
| --- | ---: | ---: | ---: |
| `enumerate-november-2026` | 13/23 | 56.5% | 12/23 |
| `enumerate-march-awareness-months-2027` | 3/8 | 37.5% | 3/8 |
| `enumerate-june-conferences-2026` | 4/7 | 57.1% | 4/7 |
| `enumerate-jewish-holidays-2026` | 3/11 | 27.3% | 3/11 |
| `enumerate-april-first-2026` | 7/8 | 87.5% | 5/8 |
| `enumerate-may-awareness-months-2026` | 5/5 | 100% | 5/5 |
| `enumerate-major-holidays-2031` | 11/16 | 68.8% | 11/16 |
| `enumerate-july-conferences-2026` | 7/8 | 87.5% | 6/8 |

## Class A investigation

- The counseling lookup returned pages 90, 93, and 96 instead of the
  observance page. The active page-42 chunks contain both the full expected
  name and date.
- The Christmas lookup returned the correct six-year-summary page 59, but the
  bounded skill output did not contain the 2029 fact. The active page-59
  chunks contain the expected name, year, weekday, and date.

Both checks queried the active index by repository, item, generation, and page
and returned only presence booleans and counts; no source prose was retained.

## OCR inspection

The repository PDF extractor reported:

```text
needsOcrPages: [10, 58, 60, 86, 102, 124]
```

The active index has no chunks for pages 10, 102, or 124. Pages 58, 60, and 86
each have one two-character chunk containing only the printed page number.
None of the six pages introduced spurious OCR content.

## Measurement hygiene

- All 20 expected-answer sets were verified against the authorized source PDF.
- The runner exercised the live MCP endpoint and the real
  `psd-observances/run.js` command boundary.
- The temporary API key had only repository list/read/search scopes.
- Raw PDF text and retrieval excerpts remained outside Git; the committed
  fixture and this report contain facts, page numbers, counts, and identifiers
  only.
