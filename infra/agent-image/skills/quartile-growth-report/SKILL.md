---
name: quartile-growth-report
summary: Build a principal's growth-by-quartile spreadsheet from psd-data — average growth per starting-point quartile by classroom, school, district, and subgroup, one tab per grade.
description: Produce a growth-by-quartile report for an elementary school as a Google Sheet — average growth for each starting-point quartile (A = lowest 25% … D = highest) by classroom, school, district and subgroup, one tab per grade. Use when someone asks for a quartile growth report, growth by quartile, a teacher quartile report, or how their lowest quartile grew.
allowed-tools: Bash(node:*)
---

# quartile-growth-report

A principal asks "quartile growth report for Evergreen" and gets one Google
Sheet: one tab per grade served, plus a Definitions tab. Modeled on the 24-25
Teacher Quartile Growth and SBA Proficiency report.

**Data only.** No narrative, interpretation, or commentary anywhere in the
output. The Definitions tab is the only prose. A narrative first draft was
piloted and explicitly rejected — do not reintroduce it, in any tab, including
as a "summary" row or a note next to a number.

## Inputs

| Input | Default |
|---|---|
| school | **required** — resolve against `schools` |
| school year | most recent |
| grades | all served (K-5) |
| window | the deepest the data supports (see Windows) |

## Workflow

1. Resolve the school. Confirm back which school and year you are running.
2. Discover the roster: `GR0x` homeroom sections + lead teachers + counts.
3. Per grade, run the measure blocks (see `references/sql.md`).
4. Build ONE spreadsheet with `psd-workspace`: a tab per grade + Definitions.
5. Share it and paste the bare URL on its own line.

Say up front that it takes a few minutes — this is many queries per grade.

## Windows

| Data available | Report |
|---|---|
| Fall + Spring (SBA posted) | Fall→Spring growth + SBA blocks — the full report |
| Fall + Winter only | Fall→Winter growth, **labeled as such** |
| Fall only | Fall **status** view: baseline raw + national PR by quartile, no change columns |

Pick the deepest view each measure supports; honor an explicit narrower request.
Per-measure exceptions regardless of view: **K DIBELS baseline = Winter** (Fall
not administered), **Grade 1 ORF baseline = Winter** (ORF starts mid-year).

## Rules that change the numbers

- **Quartiles are LOCAL.** `NTILE(4)` is computed inside each column's own
  population — each classroom over its own students, School over the school's
  matched students in that grade, District over all matched students. A
  classroom's "A" is not the district's "A". The Definitions tab must say so.
- **`NTILE` needs a deterministic tiebreak: `ORDER BY b, studentid`.** Ties on
  the boundary value are routine (grade 3 district i-Ready: 7-17 students share
  each boundary), and without the tiebreak Postgres splits them differently per
  run — re-running moved 19 of 100 quartile cells by 1 PR point. Apply it to
  **every** query family; a workbook mixing tiebroken and non-tiebroken tables
  is internally inconsistent.
- **Matched students only** in growth cells — both baseline and ending score for
  the same measure/grade/year. Multiple scores in a window → `AVG` per student
  per window.
- **Every value cell has an adjacent n.** `—` only when n = 0. No other
  suppression.
- Quartile row order: **All, D (highest), C, B, A (lowest)**.
- Include a DIBELS subtest only where **district matched n ≥ 100** (NWF at grade
  3 is single-school — omit).

## Measures

| Measure | Value |
|---|---|
| DIBELS non-accuracy (LNF, PSF, NWF CLS, NWF WRC, ORF WC) | avg raw change **and** avg national-PR change |
| DIBELS ORF Accuracy | raw change only |
| i-Ready Reading / Math | `percentile` change (already national). **Skip K** — not district-representative |
| SBA grades 4-5 | scale change vs prior-year summative, quartiled on the prior-year score |
| SBA grade 3 | spring scale + % met, by **Fall i-Ready quartile** (no prior SBA exists) |
| SBA proficiency | % met standard among all tested, rows ELA/Math |

Subgroups (School + District, "All" level): Low Income / Non-Low Income /
Special Ed / Non-Special Ed, from `students_frl.frl` and
`students_specialed.special_education`.

## National PR — the norms asset

`references/dibels8_norms_2021-22.csv` is bundled: DIBELS 8th Edition national
percentiles, UO Technical Report 2201 (2021-22). 10,674 rows covering LNF, PSF,
NWF-CLS, NWF-WRC, WRF, ORF-WRC, ORF-ACC and MAZE × grades K-5 ×
Fall/Winter/Spring. Percentiles are clamped 1-99. MAZE is scored in half-points,
so its cut points step by 0.5.

**Never estimate a percentile.** If a measure-window is not in the file, emit
raw-change only for it and say so in the Definitions tab. A fabricated norm
silently misstates how a child scored against national peers, in a document a
principal reads as fact.

Generate only the cuts a query needs — the full table is far too large to inline,
but one measure-window is ~60-100 rows:

```bash
python3 scripts/norms_values.py --grade 3 --period Fall --period Spring \
  --measure ORF-WRC --as "<warehouse assessment_group>"
```

It drops rows where the percentile does not change, which is lossless under the
lookup below (verified against all 10,674 scores), and exits non-zero if a
requested measure-window is missing rather than emitting nothing.

Look the value up per student in SQL with
`LATERAL (SELECT pr … WHERE cut <= score ORDER BY cut DESC LIMIT 1)`. That also
clamps above-range scores to 99. Every column starts at a 0 cut, so any real raw
score resolves.

**Confirm the warehouse's `assessment_group` strings first** and pass them via
`--as`. The file uses UO's names (`ORF-WRC`, `NWF-CLS`); if the warehouse spells
them differently the join silently matches nothing and every PR column comes back
NULL, which reads as "no growth" rather than "no norms".

## psd-data pitfalls — each one cost a query cycle

- `window` is a **reserved word** — always quote `"window"`.
- `smarter_balanced_scores` mixes IAB/FIAB participation rows (score = 1) with
  summatives. **Always** filter `assessment_group LIKE 'Summative%'` and
  `is_strand = false`. Unfiltered averages are garbage.
- The MCP rejects `::numeric` without precision — avoid casts. Use
  `CASE WHEN met THEN 100.0 ELSE 0.0 END` for rates.
- Results display **max 30 rows** per call — pivot entities into columns, label
  measures with `meas`, and use
  `GROUP BY GROUPING SETS ((meas, qt), (meas))` to get All + quartiles in one pass.
- Long queries (~90s) can time out. **Retry once** before reporting a failure.
- Homeroom = `section_enrollments.course_code = 'GR0xx'`, most recent enrollment
  (`DISTINCT ON (studentid) … ORDER BY dateleft DESC`). Teacher =
  `section_teachers.role_name = 'Lead Teacher'` — **never filter on
  `priorityorder`**, it is often null. `LEFT JOIN teachers`; an unresolvable id
  is labeled `(Not on file)`.
- Multi-grade classrooms (2/3, 4/5 splits) appear on both grade tabs with small
  n. Correct, not a bug.

## Privacy

Aggregate-only: every SELECT returns `AVG`/`COUNT` grouped by
classroom/quartile/subgroup. **No student-level row ever enters your context or
the output.** Queries run under the requester's own psd-data RLS scope, so a
principal sees what their role allows — if district rows come back empty or
partial, note it in the sheet rather than failing the report. Keep "not for
public release" on the Definitions tab.

## References

- `references/sql.md` — validated query patterns for every block
- `references/definitions.md` — the Definitions tab text
- `references/layout.md` — per-grade tab layout
