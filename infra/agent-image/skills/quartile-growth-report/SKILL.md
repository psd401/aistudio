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
   **The roster defines the grade span — never state one you did not query.**
   On 2026-08-15 the agent announced "Minter Creek is a K-2 school (it's PSD's
   K-2 primary)", invented the justification, and scoped an entire report to
   it. Minter Creek is K-5. The roster query answers this; asserting it from
   apparent knowledge is a Rule 3 fabrication in a document a principal reads
   as fact.
   **Keep the section -> teacher map from this step** and pass it to
   `build_tab.py --teachers`; the classroom columns are headed by teacher
   name, not section id.
3. **Run the report — ONE command.** It does the roster, every grade's
   extraction, the aggregation, the tabs, the Definitions tab, and the share:

   ```bash
   /opt/agentcore-venv/bin/python3 \
     /opt/psd-skills/quartile-growth-report/scripts/run_report.py \
     --school "<school>" --user "<caller email>"
   ```

   It prints the spreadsheet URL on stdout and progress on stderr.
4. Paste that bare URL on its own line.

**What the one command covers.** `run_report.py` builds the report:

| Block | Notes |
|---|---|
| DIBELS growth + national PR | per-measure baselines; K is Winter, grade 1 ORF is Winter |
| i-Ready Reading / Math | percentile change, no norms; skipped for K |
| SBA grades 4-5 | scale change vs the prior-year summative |
| Low Income / Special Ed subgroups | flags joined DISTRICT-WIDE |

**Anything it cannot produce is written INTO the tab** under `NOT INCLUDED IN
THIS REPORT`, with the reason — a failed query, no matched students, or a
table it could not find. Do not delete those rows and do not call the report
complete while they are present.

That banner is the whole point. Every past failure of this report was
invisible at the point of use — the Minter Creek grade span, the District
column mirroring School, the missing teacher names. A principal cannot tell
from a sheet that a measure was never queried, so the sheet has to say it.

Two blocks report themselves as gaps today: **SBA grade 3**, which needs the
Fall i-Ready quartile, and **i-Ready** where the warehouse table cannot be
found (its name is not recorded in this skill, unlike `smarter_balanced_scores`
and `students_frl`, so the script probes for it). Confirm the table name and
they stop being gaps.

`--dry-run` resolves the school, year and roster and prints the plan without
touching a spreadsheet. Use it when the user asks what the report will cover.

**What it covers**: DIBELS growth with national PR, i-Ready Reading/Math
(skipped for K), SBA grades 4-5 against the prior-year summative, and the Low
Income / Special Ed subgroup rollups joined district-wide.

**Anything it cannot produce is written INTO the tab** under "NOT INCLUDED IN
THIS REPORT", with the reason. Do not remove those rows, and do not describe
the report as complete when they are present — a principal does not read the
run log, and a workbook that silently omits SBA looks finished and is not.
SBA grade 3 needs the Fall i-Ready quartile and reports itself as a gap until
that table is confirmed.

**Write no scripts. Author no files.** Every step ships as a script that takes
the previous step's output and emits the next step's input, ending in a body
you pipe straight into `gws`:

```bash
P=/opt/agentcore-venv/bin/python3
S=/opt/psd-skills/quartile-growth-report/scripts

# tab first, then fill it
$P $S/build_tab.py --school "<school>" --grade K --year 2025-26 --emit addsheet
$P $S/aggregate.py --rows gradeK.csv --grade K --subgroup "low_income=Low Income|Non-Low Income" \
  | $P $S/build_tab.py --school "<school>" --grade K --year 2025-26 --window "Fall→Spring"
```

This is not a style preference. Every file the model authors is a chance for
the write tool to embed a literal `\n`, which produces a SyntaxError and a
retry loop — it has killed this report four times, twice with every rollup
already computed.

**If a step genuinely needs a script these do not cover**, psd-rules Rule 9a
governs: write a real file (never a `-c` heredoc), `head -5` it, and if the
newlines arrived literal run
`scripts/repair_literal_newlines.py` on it rather than rewriting it. Rule 9a
and this section agree — prefer a shipped script, and when you must write one,
repair rather than retry. Do not read "author no files" as a reason to reach
for `python3 -c` instead; that is the failure Rule 9a exists to prevent.

**Never put a window function or the norms lookup in SQL.** Window functions do
not complete against `dibels_scores` on this MCP server at any size — a bare
`NTILE(4)` over ~1,100 rows times out, while the same query without it runs in
seconds (isolated 2026-08-15, Evergreen Elementary). The extraction query is a
plain indexed read and returned 2,232 rows for grade K in about 3 seconds.

Do not try to make `NTILE` work by simplifying around it. That was attempted
over several passes — dropping the norms join, dropping the classroom
breakdown, splitting the partitions — and produced no report at all. If an
extraction query times out, simplify the extraction; never move arithmetic back
into it.

**One extraction query per grade, not per measure.** The `IN (…)` list takes
every measure for the grade at once. Per-measure querying turns 6 grades into
30+ round trips and is what makes this report feel endless.

### How to run it by hand — FALLBACK ONLY

**Everything from here to the end of this section applies only when
`run_report.py` cannot be used** (it is unavailable, or it fails in a way a
re-run does not clear, or you are covering a block it reports as a gap — see
*What the one command covers* above). For a normal quartile growth report, stop
reading here and run the one command in step 3.

This section describes the manual orchestration path. It is kept for the
blocks the one command still reports as gaps, and for debugging. Do not read
it as the default; the five consecutive failures that motivated
`run_report.py` all happened on this path.

**Work the grades one at a time, in this turn, start to finish.** Run a grade's
measure blocks, keep the rows, move to the next grade. Do not parallelize, do
not sample a subset, do not stop at a "representative" grade and offer the rest
later. Every grade in the roster, then one spreadsheet.

**A long turn is the intended shape of this report, not a problem to route
around.** Many queries per grade means this can run well past a normal turn.
That is fine and expected: when it outruns the turn deadline the platform
promotes it to a background job that resumes on ECS — up to two hours — and
posts the finished Sheet link into this thread. Running long is how the user
gets the report.

Two things break that, and both have happened:

- **Do not announce a follow-up.** Never "I'll send it when it's done" — nothing
  can send it, and the turn ends on a promise you cannot keep. If you say
  anything before starting, say "this runs long, stand by".
- **Do not spawn a subagent.** `sessions_*` is disabled here (psd-rules Rule 15)
  and children die without reporting. On 2026-08-14 this exact report was
  spawned into a subagent twice, promised twice, and produced nothing.

If a query fails, report which grade and measure failed and keep going — a
report missing one measure beats no report.

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

**Subgroups** (School + District, "All" level): Low Income / Non-Low Income /
Special Ed / Non-Special Ed, from `students_frl.frl` and
`students_specialed.special_education`.

**Join those flags district-wide, not just for this school**, and pass
`--subgroup` to `aggregate.py` rather than grouping them yourself. A
school-scoped join makes the District column a copy of the School column and
dumps every unflagged district student into the negative class — it reads as
real data. A student with no flag record is UNKNOWN and is excluded, never
counted as negative. See `references/sql.md`. If `aggregate.py` warns that a
district subgroup row matches its school row, the join is wrong; do not
publish that workbook.

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
/opt/agentcore-venv/bin/python3 /opt/psd-skills/quartile-growth-report/scripts/norms_values.py \
  --grade 3 --period Fall --period Spring \
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
