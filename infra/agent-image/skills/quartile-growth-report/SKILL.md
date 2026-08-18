---
name: quartile-growth-report
summary: Build a principal's growth-by-quartile spreadsheet from psd-data — average growth per starting-point quartile by classroom, school, district, and subgroup, one tab per grade.
description: Produce a growth-by-quartile report for an elementary school as a Google Sheet — average growth for each starting-point quartile (A = lowest 25% … D = highest) by classroom, school, district and subgroup, one tab per grade. Use when someone asks for a quartile growth report, growth by quartile, a teacher quartile report, or how their lowest quartile grew.
allowed-tools: Bash(/opt/agentcore-venv/bin/python3:*), Bash(node:*)
---

# quartile-growth-report

A principal asks "quartile growth report for Evergreen" and gets one Google
Sheet: one tab per grade served, plus a Definitions tab. Modeled on the 24-25
Teacher Quartile Growth and SBA Proficiency report.

**Data only.** No narrative, interpretation, or commentary anywhere in the
output. The Definitions tab is the only prose. A narrative first draft was
piloted and explicitly rejected — do not reintroduce it, in any tab, including
as a "summary" row or a note next to a number.

## Run it

```bash
/opt/agentcore-venv/bin/python3 \
  /opt/psd-skills/quartile-growth-report/scripts/run_report.py \
  --school "<school>" --user "<caller email>"
```

That is the whole workflow. Confirm the school back to the user, run the
command, paste the bare URL it prints on stdout on its own line. Progress goes
to stderr.

Options: `--year "2025-2026"` (default: the most recent year that has
STARTED), `--grades K,1,2` (default: every grade the roster shows),
`--work-dir DIR` (checkpoints; re-running resumes), `--dry-run` (resolve the
school, year and roster and print the plan — including every query it will
run — without touching a spreadsheet).

**Do not write SQL, scripts, or files for this report.** The script generates
all 40 queries itself. Author nothing.

## What the script does

1. Resolves the school and year against `schools` / `school_years`.
2. Queries `section_enrollments` for each `GR00K`-`GR005` homeroom and its
   Lead Teacher. **The roster defines the grade span — never state one you did
   not query.** On 2026-08-15 the agent announced "Minter Creek is a K-2
   school", invented the justification, and scoped an entire report to it.
   Minter Creek is K-5.
3. Generates R&A's validated queries against that school id, year id and
   section list (`scripts/gen_sql.py`).
4. Runs each query once — they return aggregates, so there is nothing to page.
5. Lays the results out one tab per grade, adds Definitions, shares the
   workbook to the caller as OWNER.

**Anything it cannot produce is written INTO the tab** under `Not included in
this report`, with the reason. Do not delete those rows and do not call the
report complete while they are present. Every past failure of this report was
invisible at the point of use — the Minter Creek grade span, the District
column mirroring School, the missing teacher names. A principal cannot tell
from a sheet that a measure was never queried, so the sheet has to say it.

## The queries are transcribed, not designed

`scripts/gen_sql.py` is R&A's generator (James Cantonwine, handoff
2026-08-17), vendored. It reproduces the 40 queries that actually produced the
Evergreen and Purdy workbooks, and `scripts/test_gen_sql.py` byte-compares its
output against them.

**Do not rewrite these queries.** Every non-obvious choice in them cost a
query cycle to discover, and the previous version of this skill — designed
from prose rather than transcribed — failed on every invocation for a week.
If a query needs to change, the change belongs in `gen_sql.py` with the
fixtures regenerated and re-validated against psd-data, not in an ad-hoc
statement typed into the MCP.

Three things that version got wrong, so they are not re-derived:

- **`NTILE(4)` works here.** The validated queries use 57 windows. The old
  skill claimed window functions never complete against `dibels_scores` and
  computed quartiles locally instead.
- **The 30-row display cap is designed around, not paged around.** Teachers
  are pivoted into COLUMNS and `GROUP BY GROUPING SETS ((meas, qt), (meas))`
  returns the All row beside the quartile rows, so a whole block is one page.
- **National PR is converted in SQL** — a `norms(meas0, per, cut, pr)` VALUES
  CTE plus `LEFT JOIN LATERAL (SELECT pr … WHERE cut <= score ORDER BY cut
  DESC LIMIT 1)`, which also clamps above-range scores to 99. Not in Python.

## Rules that change the numbers

- **Quartiles are LOCAL.** `NTILE(4)` is computed inside each column's own
  population — each classroom over its own students, School over the school's
  matched students in that grade, District over all matched students. A
  classroom's "A" is not the district's "A". The Definitions tab says so.
- **`NTILE` needs a deterministic tiebreak: `ORDER BY b, studentid`.** Ties on
  the boundary value are routine (grade 3 district i-Ready: 7-17 students share
  each boundary), and without the tiebreak Postgres splits them differently per
  run — re-running moved 19 of 100 quartile cells by 1 PR point. It applies to
  **every** query family; a workbook mixing tiebroken and non-tiebroken tables
  is internally inconsistent.
- **Matched students only** in growth cells — both baseline and ending score for
  the same measure/grade/year. Multiple scores in a window → `AVG` per student
  per window.
- **Every value cell has an adjacent n.** `—` only when n = 0. No other
  suppression.
- Quartile row order: **All, D (highest), C, B, A (lowest)**.
- Per-measure baselines: **K DIBELS = Winter** (Fall not administered),
  **Grade 1 ORF = Winter** (ORF starts mid-year). Everything else is Fall.

## Measures

| Measure | Value |
|---|---|
| DIBELS non-accuracy (LNF, PSF, NWF CLS, NWF WRC, ORF WC) | avg raw change **and** avg national-PR change |
| DIBELS ORF Accuracy | raw change only |
| i-Ready Reading / Math | `percentile` change (already national). **Skip K** — not district-representative |
| SBA grades 4-5 | scale change vs prior-year summative, quartiled on the prior-year score |
| SBA grade 3 | spring scale + % met, by **Fall i-Ready quartile** (no prior SBA exists) |
| SBA proficiency | % met standard among all tested, rows ELA/Math |

**Subgroups** (School + District, "All" level): Low Income / Non-Low Income /
Special Ed / Non-Special Ed, from `students_frl.frl` and
`students_specialed.special_education`. Those tables have **no `yearid`** —
scoping them by year errors the whole query, and scoping them to one school
makes the District column a copy of the School column.

## National PR — the norms asset

`references/norms/norms_sql_g{0-5}.txt` are the per-grade DIBELS 8 cut points
as ready-to-embed SQL `VALUES` fragments, compressed from
`references/dibels8_norms_2021-22.csv` (UO Technical Report 2201, 2021-22;
10,674 cells; percentiles clamped 1-99). `gen_sql.py` embeds them.

**Never estimate a percentile.** These are a hard dependency the agent cannot
derive. A fabricated norm silently misstates how a child scored against
national peers, in a document a principal reads as fact.

## psd-data pitfalls — each one cost R&A a query cycle

- `window` is a **reserved word** — always quote `"window"`.
- `smarter_balanced_scores` mixes IAB/FIAB participation rows (score = 1) with
  summatives. **Always** filter `assessment_group LIKE 'Summative%'` and
  `is_strand = false`. Unfiltered averages are garbage.
- The MCP rejects `::numeric` without precision — avoid casts. Use
  `CASE WHEN met THEN 100.0 ELSE 0.0 END` for rates.
- Results display **max 30 rows** per call — the queries are shaped to fit.
- Long queries (~90s) can time out. The script **retries once** before
  reporting a failure; do the same by hand.
- Homeroom = `section_enrollments.course_code = 'GR0xx'`, most recent
  enrollment (`DISTINCT ON (studentid) … ORDER BY dateleft DESC`). Teacher =
  `section_teachers.role_name = 'Lead Teacher'` — **never filter on
  `priorityorder`**, it is often null. `LEFT JOIN teachers` (its PK is `id`,
  and it has `first_name`/`last_name`, not `teacher_name`); an unresolvable id
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

- `references/SKILL-PROPOSAL.md` — R&A's spec: method, reference SQL, layout
- `references/HANDOFF.md` — the non-negotiables list, verbatim
- `tests/fixtures/sql-evergreen/` — the 40 queries as actually run
- `references/definitions.md` — the Definitions tab text
- `references/layout.md` — per-grade tab layout
