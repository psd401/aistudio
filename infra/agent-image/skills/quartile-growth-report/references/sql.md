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

## Core pattern — local quartiles + national PR

Generate the `norms` body first:

```bash
/opt/agentcore-venv/bin/python3 /opt/psd-skills/quartile-growth-report/scripts/norms_values.py \
  --grade 3 --period Fall --period Spring \
  --measure ORF-WRC --measure NWF-CLS --as "<warehouse name>" --as "<warehouse name>"
```

```sql
WITH norms(meas0, per, cut, pr) AS (VALUES /* paste generated rows */),
stu AS (  -- one row per student/measure/window; AVG neutralizes retests
  SELECT assessment_group AS meas, studentid, "window", AVG(score) AS s
  FROM dibels_scores
  WHERE yearid = :yearid AND grade_level = :grade
    AND assessment_group IN (…) AND "window" IN (:baseline, 'Spring')
  GROUP BY 1,2,3),
m AS (   -- matched pairs + per-student PR at both windows
  SELECT f.meas, f.studentid, f.s AS b, sp.s AS e, pb.pr AS prb, pe.pr AS pre
  FROM stu f
  JOIN stu sp ON sp.studentid = f.studentid AND sp.meas = f.meas AND sp."window" = 'Spring'
  LEFT JOIN LATERAL (SELECT n.pr FROM norms n WHERE n.meas0 = f.meas AND n.per = :baseline
                     AND n.cut <= f.s ORDER BY n.cut DESC LIMIT 1) pb ON true
  LEFT JOIN LATERAL (SELECT n.pr FROM norms n WHERE n.meas0 = sp.meas AND n.per = 'Spring'
                     AND n.cut <= sp.s ORDER BY n.cut DESC LIMIT 1) pe ON true
  WHERE f."window" = :baseline),
hr AS (SELECT DISTINCT ON (studentid) studentid, sectionid FROM section_enrollments
       WHERE yearid = :yearid AND schoolid = :schoolid AND course_code = :course
       ORDER BY studentid, dateleft DESC),
sch AS (SELECT DISTINCT studentid FROM school_year_enrollments
        WHERE yearid = :yearid AND schoolid = :schoolid AND grade_level = :grade),
mm AS (SELECT m.*, hr.sectionid, (sch.studentid IS NOT NULL) AS in_sch
       FROM m LEFT JOIN hr USING (studentid) LEFT JOIN sch USING (studentid)),
q AS (SELECT mm.*,   -- THREE quartile assignments: class-local, school-local, district
        NTILE(4) OVER (PARTITION BY meas, sectionid ORDER BY b, studentid) AS q_cls,
        NTILE(4) OVER (PARTITION BY meas, in_sch  ORDER BY b, studentid) AS q_sch,
        NTILE(4) OVER (PARTITION BY meas          ORDER BY b, studentid) AS q_dist
      FROM mm),
cls AS (SELECT meas, COALESCE(q_cls::text,'All') AS qt,
          ROUND(AVG(e-b)     FILTER (WHERE sectionid = :sec1),1) AS a1,
          ROUND(AVG(pre-prb) FILTER (WHERE sectionid = :sec1),1) AS p1,
          COUNT(*)           FILTER (WHERE sectionid = :sec1)    AS n1
          -- …repeat per homeroom; FILTER is safe with GROUPING SETS because
          -- q_cls was computed within each section's own partition
        FROM q WHERE sectionid IS NOT NULL
        GROUP BY GROUPING SETS ((meas, q_cls),(meas))),
scha AS (SELECT meas, COALESCE(q_sch::text,'All') AS qt,
          ROUND(AVG(e-b),1) AS a_sch, ROUND(AVG(pre-prb),1) AS p_sch, COUNT(*) AS n_sch
         FROM q WHERE in_sch GROUP BY GROUPING SETS ((meas, q_sch),(meas))),
dist AS (SELECT meas, COALESCE(q_dist::text,'All') AS qt,
          ROUND(AVG(e-b),1) AS a_dist, ROUND(AVG(pre-prb),1) AS p_dist, COUNT(*) AS n_dist
         FROM q GROUP BY GROUPING SETS ((meas, q_dist),(meas)))
SELECT * FROM dist LEFT JOIN scha USING (meas, qt) LEFT JOIN cls USING (meas, qt)
ORDER BY meas, qt
```

**`ORDER BY b, studentid` in every `NTILE` is mandatory**, not stylistic. See
SKILL.md — without the tiebreak, quartile membership is nondeterministic across
runs and re-running moved 19 of 100 quartile cells.

## Variants

| Block | Change from the core pattern |
|---|---|
| i-Ready, ORF Accuracy | Drop `norms`; value is `e-b` only |
| SBA grades 4-5 | Replace `stu`/`m` with a prior-year join (`yearid-1`, `grade-1`), filter `assessment_group LIKE 'Summative%'` and `is_strand = false` |
| SBA grade 3 | Baseline = Fall i-Ready percentile; values `AVG(e)` scale and `AVG(metv)` % met |
| Subgroups | One query per grade over the same `m`, `CROSS JOIN LATERAL (VALUES …)` for the four flags, school + district scope |
| Fall-only status | Drop the Spring join; values are `AVG(b)` and `AVG(prb)` by quartile |

## School-vs-district PR mini-tables

Same `stu`/`m` CTEs, but keep **levels** rather than deltas — `bs` = baseline PR
(i-Ready: the percentile itself), `es` = spring PR:

```sql
q AS (SELECT mm.*, NTILE(4) OVER (PARTITION BY meas, in_sch ORDER BY b, studentid) AS q_sch,
                   NTILE(4) OVER (PARTITION BY meas ORDER BY b, studentid) AS q_dist FROM mm),
schq  AS (SELECT meas, COALESCE(q_sch::text,'All') AS qt,
                 ROUND(AVG(bs),0) AS s_start, ROUND(AVG(es),0) AS s_end, COUNT(*) AS n_sch
          FROM q WHERE in_sch GROUP BY GROUPING SETS ((meas, q_sch),(meas))),
distq AS (SELECT meas, COALESCE(q_dist::text,'All') AS qt,
                 ROUND(AVG(bs),0) AS d_start, ROUND(AVG(es),0) AS d_end, COUNT(*) AS n_dist
          FROM q GROUP BY GROUPING SETS ((meas, q_dist),(meas)))
SELECT * FROM distq LEFT JOIN schq USING (meas, qt) ORDER BY meas, qt
```

`NTILE` still orders on the raw baseline `b`; only the reported averages are in
PR space. SBA is excluded — scale scores have no PR. Fall-only: Start columns
only.
