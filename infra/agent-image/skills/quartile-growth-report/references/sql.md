# Query patterns

Parameters: `:yearid`, `:schoolid`, `:grade`, `:course`, section ids.
All patterns were validated against Evergreen Elementary 2025-26.

**Before the first query of a run**, confirm the warehouse's own
`assessment_group` strings with psd-data (`tables --detailed`, or a
`SELECT DISTINCT assessment_group`). The norms file uses UO's names
(`ORF-WRC`, `NWF-CLS`); the warehouse may differ, and the join in `norms`
is on that string. Pass `--as "<warehouse name>"` to `norms_values.py` so the
emitted rows join directly.

## Roster discovery

`GR0x` homeroom sections + lead teachers + counts. Homeroom is the most recent
enrollment per student; teacher is `role_name = 'Lead Teacher'`. Never filter on
`priorityorder` — it is often null. `LEFT JOIN teachers`; an unresolvable id is
labeled `(Not on file)`.

## Core pattern — extract raw pairs, aggregate locally

**The warehouse returns matched pairs. Quartiles and national PR are computed
on this box.** Do not put `NTILE`, norms, or `GROUPING SETS` in the query.

That is not a style preference. **Window functions do not complete against
`dibels_scores` on this MCP server at any size.** Isolated on 2026-08-15
(Evergreen Elementary 2025-26): a bare `NTILE(4)` over ~1,100 rows, with no
norms join and no classroom breakdown, timed out; the same query without the
window ran in seconds. Row count is not the variable — a 2,200-row window
function should be instant.

The extraction query below returned **2,232 matched rows for grade K in about
3 seconds**, confirmed in the same session.

So the split is not an optimization to tune, it is the only shape that runs. Do
not try to make `NTILE` work here by simplifying around it — that was tried
across several passes and cost hours without producing a report.

### Step 1 — the query (ONE per grade, covering every measure)

`assessment_group IN (…)` takes the whole measure list for the grade in a single
call. Do not run this per measure: that turns 6 grades into 30+ round trips for
no benefit, and pass count is what makes this report feel endless.

Student ids are pulled because the quartile tiebreak needs them. They stay in
the local rows and in `aggregate.py`; only aggregated cells reach the workbook
or the reply.

```sql
WITH stu AS (  -- one row per student/measure/window; AVG neutralizes retests
  SELECT assessment_group AS meas, studentid, "window", AVG(score) AS s
  FROM dibels_scores
  WHERE yearid = :yearid AND grade_level = :grade
    AND assessment_group IN (…) AND "window" IN (:baseline, 'Spring')
  GROUP BY 1,2,3),
m AS (   -- matched baseline/spring pairs
  SELECT f.meas, f.studentid, f.s AS b, sp.s AS e
  FROM stu f
  JOIN stu sp ON sp.studentid = f.studentid AND sp.meas = f.meas AND sp."window" = 'Spring'
  WHERE f."window" = :baseline),
hr AS (SELECT DISTINCT ON (studentid) studentid, sectionid FROM section_enrollments
       WHERE yearid = :yearid AND schoolid = :schoolid AND course_code = :course
       ORDER BY studentid, dateleft DESC),
sch AS (SELECT DISTINCT studentid FROM school_year_enrollments
        WHERE yearid = :yearid AND schoolid = :schoolid AND grade_level = :grade)
SELECT m.meas, m.studentid, m.b, m.e,
       hr.sectionid, (sch.studentid IS NOT NULL) AS in_sch
FROM m LEFT JOIN hr USING (studentid) LEFT JOIN sch USING (studentid)
```

No windows, no laterals, no grouping sets. It stays district-wide because the
district quartile needs the full cohort — but it is now a plain indexed read
returning a few thousand rows per grade.

**Cast every non-text column to `::text`.** psd-data's export mode fails on
decimal, integer and boolean columns; the rows come back malformed rather than
erroring cleanly. Casting fixes it, and the cast must be *inside* each
aggregate, not only at the final select — `AVG(score)::text` is wrong, it needs
the cast applied to the aggregate's result where the export sees it. The
boolean needs it too:

```sql
SELECT m.meas, m.studentid::text, m.b::text, m.e::text,
       hr.sectionid::text, (sch.studentid IS NOT NULL)::text AS in_sch
```

`aggregate.py` parses the numbers back, so the casts cost nothing downstream.
Skipping them cost roughly ten round trips of trial and error per run on
2026-08-15 — the agent rediscovered this the hard way, one column at a time.

### Step 2 — aggregate

**Feed the exported CSV straight in. Do not write a converter.** `aggregate.py`
reads the export as-is — CSV, a JSON array, or JSON lines, detected by content
rather than extension. Writing a CSV→JSON glue script is where runs keep dying:
the write tool emits literal `\n` into helper scripts, producing a SyntaxError
and a retry loop that has burned parts of three sessions.

`aggregate.py` applies the norms, assigns the three quartile scopes, and emits
the district/school/class rollups:

```bash
/opt/agentcore-venv/bin/python3 /opt/psd-skills/quartile-growth-report/scripts/aggregate.py \
  --rows grade3.csv --grade 3 --baseline Fall --spring Spring \
  --measure-as "<warehouse name>=ORF-WRC"
```

Output is one record per `(meas, scope, qt)` with `growth`, `pr_growth` and `n`,
including an `All` row per measure and scope — the same cells the SQL used to
return. Use `--no-norms` for i-Ready, ORF Accuracy and SBA, which have no
national PR.

`--measure-as` maps the warehouse's `assessment_group` spelling to the norms
file's (`ORF-WRC`, `NWF-CLS`); confirm the warehouse strings first, as above.

**The `(b, studentid)` ordering inside every quartile is mandatory**, not
stylistic. See SKILL.md — without the tiebreak, quartile membership is
nondeterministic across runs and re-running moved 19 of 100 quartile cells.
`aggregate.py` applies it and reproduces Postgres `NTILE(4)` exactly, remainder
rule included (verified against Postgres for partition sizes 2-23); its tests
pin both.

## Variants

Every variant below keeps the same split: the query returns raw pairs, and
`aggregate.py` does the quartiles. None of them should reintroduce `NTILE`,
`LATERAL` norms, or `GROUPING SETS` into SQL.

| Block | Change from the core pattern |
|---|---|
| i-Ready, ORF Accuracy | Pass `--no-norms`; value is `e-b` only |
| SBA grades 4-5 | Replace `stu`/`m` with a prior-year join (`yearid-1`, `grade-1`), filter `assessment_group LIKE 'Summative%'` and `is_strand = false` |
| SBA grade 3 | Baseline = Fall i-Ready percentile; values `AVG(e)` scale and `AVG(metv)` % met |
| Subgroups | Same extraction query plus the four flag columns; group locally rather than re-querying per subgroup |
| Fall-only status | Drop the Spring join and emit `e` as null; read `start_raw` / `start_pr` |

## School-vs-district PR mini-tables

No second query. `aggregate.py` already emits levels alongside the deltas from
the same run: read `start_pr` / `end_pr` (whole percentiles) instead of
`pr_growth`, filtered to `scope` of `school` and `district`.

Quartiles are still assigned on the raw baseline; only the reported averages are
in PR space. SBA is excluded — scale scores have no PR. Fall-only reports use
`start_pr` / `start_raw` and leave the End columns empty, which the script
already returns as null when no spring score exists.

Computing both views in one pass is deliberate: they were two queries over the
same rows, and keeping them together makes it impossible for the growth table
and the PR table to disagree about who is in which quartile.
