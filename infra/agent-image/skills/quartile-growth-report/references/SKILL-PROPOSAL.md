# Skill Proposal: `quartile-growth-report` (v2)

**Status:** Proposal — not deployed. For PSD's Google Chat agent (Sonnet 5) with psd-data MCP access.
**Validated against:** Evergreen Elementary, 2025-26 (`Evergreen Quartile Growth Report (2025-26).xlsx`, rebuilt 2026-08-10 with local quartiles + DIBELS national PR change), and Purdy Elementary, 2025-26 (built 2026-08-14 from the same scripts with only a school-config change — see README "Adding a school").

## Purpose

Let a principal ask, in plain language, for a "growth by quartile" report for their school and receive a spreadsheet — one tab per grade — showing average growth for each starting-point quartile (A = lowest 25% … D = highest 25%) by classroom, school, district, and subgroup. Modeled on the 24-25 Teacher Quartile Growth and SBA Proficiency report; extended to DIBELS subtests, i-Ready Reading/Math, and SBA with Low Income / Non-Low Income / Special Ed / Non-Special Ed subgroups.

**Trigger phrases:** "quartile growth report", "growth by quartile", "teacher quartile report", "how did my lowest quartile grow", "quartile report for [school]".

**Inputs:** school name (required; resolve against `schools`), school year (default: most recent), grades (default: all served K-5), window (default: maximum available — see Windows).

## Output format

- **Google Sheets** (the agent already knows how to produce these) — one spreadsheet, one tab per grade + a Definitions tab. Excel was used for local validation; the layout is identical.
- **Data only.** No narrative analysis, interpretation, or commentary anywhere in the file. A factual Definitions tab is the only prose. (First pilot inserted analysis text; explicitly rejected.)
- Every value cell has an adjacent **n** (matched count). `—` only when n = 0; **no other suppression** (decided).
- Quartile rows ordered: All, D (highest), C, B, A (lowest).

## Windows (decided: support all, default to maximum view)

| Data available for the year | Report produced |
|---|---|
| Fall + Spring (and SBA posted) | Fall→Spring growth + SBA blocks — the full report |
| Fall + Winter only (mid-year) | Fall→Winter growth, labeled as such |
| Fall only | **Fall status view**: avg baseline raw score and national PR (no change columns) by quartile — same layout, "status" instead of "change" |

Pick the deepest view the data supports per measure; a user may explicitly request a narrower one ("fall-only", "fall to winter"). Per-measure exceptions persist regardless of view: K DIBELS baseline = Winter where Fall isn't administered; Grade 1 ORF baseline = Winter (ORF starts mid-year).

## Method (validated design decisions)

| Decision | Rule |
|---|---|
| Quartiles are **local** | `NTILE(4)` is computed separately within each column's own population: each classroom on its own students, School on all of the school's matched students in the grade, District on all matched students. A = lowest 25% *of that group*. (Decided: principals find class-level quartiles more intelligible for teachers. Consequence: a classroom's "A" students are not the same cut as the district's "A" students — the Definitions tab must say this.) |
| Matched students | Growth cells include only students with both baseline and ending scores (same measure/grade/year). Multiple scores per window → `AVG` per student per window. |
| Classroom | Homeroom section (`section_enrollments.course_code = 'GR0xx'`), most recent enrollment (`DISTINCT ON (studentid) … ORDER BY dateleft DESC`). Teacher = `section_teachers.role_name = 'Lead Teacher'` (`priorityorder` is often null — never filter on it), `LEFT JOIN teachers`; unresolvable id → label "(Not on file)" (decided: acceptable). |
| DIBELS — Raw + PR | Non-accuracy subtests (LNF, PSF, NWF CLS, NWF WRC, ORF WC) show BOTH avg raw score change AND avg change in **national percentile rank**. PR is converted per student in SQL from the DIBELS 8th Edition 2021-2022 Percentiles (Technical Report 2201, University of Oregon) — see Norms asset. ORF Accuracy: raw change only. Include a subtest only where district matched n ≥ 100 (NWF at grade 3 is single-school — omit). |
| i-Ready | `percentile` change (already national percentile), Fall→Spring diagnostic. Skip K (not district-representative). |
| SBA grades 4-5 | Scale score change from prior-year summative (prior grade, prior yearid), quartiled locally on prior-year score. |
| SBA grade 3 | Spring scale score + % met by Fall i-Ready quartile (matching subject); no prior SBA exists. |
| SBA proficiency block | % met standard among all tested students, rows ELA/Math. |
| Subgroups | `students_frl.frl IS TRUE/FALSE`; `students_specialed.special_education IS TRUE/FALSE` (current-status flags). Shown at the "All" level for School + District, with Raw and PR columns where the measure has both. |

## Norms asset (required for PR change)

- `agg/dibels8_norms_2021-22.csv` — 10,674 cells extracted from the UO PDF (dibels.uoregon.edu, Technical Report 2201) via x-coordinate table parsing; validated: zero non-monotonic columns, zero gaps, 14/14 spot checks against the PDF. Covers LNF, PSF, NWF-CLS, NWF-WRC, WRF, ORF-WRC, ORF-ACC, MAZE × grades K-6+ × Fall/Winter/Spring. Conventions: `<1` → 1, `>99` → 99.
- The skill must bundle this CSV (or the pre-compressed per-grade SQL fragments in `agg/norms_sql_g{0-5}.txt`). At query time, embed the needed (measure, window) cut points as a `VALUES` CTE — compressed to rows where PR changes (~60-100 rows per measure-window) — and look up each student's PR with a `LATERAL (SELECT pr … WHERE cut <= score ORDER BY cut DESC LIMIT 1)`; this also clamps above-range scores correctly.
- These are the most recent published national percentile tables. If UO publishes newer norms, regenerate the CSV with `gen_sql.py`'s extractor pattern.

## Known data pitfalls (each cost a query cycle in validation)

- `window` is a reserved word — always quote `"window"`.
- `smarter_balanced_scores` mixes IAB/FIAB participation rows (score = 1) with summatives. **Always filter `assessment_group LIKE 'Summative%'` and `is_strand = false`** — unfiltered averages are garbage.
- The MCP rejects `::numeric` without precision — avoid casts; use `CASE WHEN met THEN 100.0 ELSE 0.0 END` for rates.
- Results display max 30 rows per call — pivot entities into columns, combine measures with a `meas` label, use `GROUP BY GROUPING SETS ((meas, qt), (meas))` for All + quartiles in one pass.
- Long queries (~90s) can time out — simply retry once.
- Multi-grade classrooms (2/3, 4/5 splits) appear on both grade tabs with small n — correct, not a bug.

## Privacy & permissions

- Aggregate-only queries: every SELECT returns `AVG`/`COUNT` grouped by classroom/quartile/subgroup — no student-level rows ever enter agent context or output.
- **Principals' psd-data access is role-restricted** (confirmed). The skill runs under the requester's own permissions: a principal can only produce this report where their role's row scope allows. District-scope columns depend on the principal's role being able to read other schools' rows in aggregate — verify during pilot; if district rows come back empty/partial for a principal account, note it in the sheet rather than failing. R&A staff can run any school.
- No minimum-n suppression (decided); classroom-quartile cells are ~5 students. Internal principal use; "not for public release" stays on the Definitions tab.

## Reference SQL — v2 core pattern (local quartiles + PR)

Parameters: `:yearid`, `:schoolid`, `:grade`, `:course`, section ids. Roster-discovery query unchanged from v1 (GR0x sections + lead teachers + counts).

```sql
WITH norms(meas0, per, cut, pr) AS (VALUES /* per-grade cut points from the norms asset */),
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
        -- studentid is the tiebreak; without it quartile membership is
        -- nondeterministic across runs (see NTILE ties, below)
      FROM mm),
cls AS (SELECT meas, COALESCE(q_cls::text,'All') AS qt,
          ROUND(AVG(e-b)     FILTER (WHERE sectionid = :sec1),1) AS a1,
          ROUND(AVG(pre-prb) FILTER (WHERE sectionid = :sec1),1) AS p1,
          COUNT(*)           FILTER (WHERE sectionid = :sec1)    AS n1
          -- …repeat per homeroom; FILTER makes GROUPING SETS safe because
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

Variants (all validated, see `agg/sql/`): i-Ready/Accuracy use the same skeleton without `norms` (value = `e-b` only). SBA grades 4-5 replace `stu/m` with prior-year join (`yearid-1`, `grade-1`, `Summative%` filter). SBA grade 3 baseline = Fall i-Ready percentile, values = `AVG(e)` scale + `AVG(metv)` % met. Subgroups: one query per grade over the same `m`, `CROSS JOIN LATERAL (VALUES …)` for the four flags, school + district scope. Fall-only status view: drop the Spring join; values = `AVG(b)` and `AVG(prb)` by quartile.

## School-vs-district comparison section (principal-requested)

At the bottom of every grade tab, mirror the model report's "PR Start / PR End / District" tables: for each PR-capable measure (i-Ready Reading/Math, DIBELS non-accuracy subtests), a mini-table with rows All → QD (highest) → QA (lowest) showing the **average national PR at baseline and at spring** for School vs District side by side, each with n. Quartiles are each group's own fourths of the baseline (matched students only); the All row is the pooled mean over every matched student in that group, matching the All row convention of the main blocks (principal request, 2026-08-13). SBA is excluded — scale scores have no PR, and start/end scale is covered by the change blocks.

Query (generated by `gen_sql.py`, saved as `agg/sql/g*_levels.sql`, results in `agg/v2/g*_levels.md`): same `stu/m` CTEs as the PR-change query but keep levels, not deltas — `bs` = baseline PR (i-Ready: the percentile itself), `es` = spring PR — then

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
`GROUPING SETS` produces the All row alongside the quartile rows in one pass (same pattern as the main blocks). NTILE ordering stays on the raw baseline `b` with `studentid` as tiebreak (consistent with the main blocks); only the reported averages are in PR space. Fall-only view: report Start columns only.

**NTILE ties — the skill MUST use a deterministic tiebreak (verified 2026-08-13).** `ORDER BY b` alone does not break ties, and quartile boundaries routinely land on a tied baseline value (grade 3 district i-Ready: 7-17 students share each boundary value). Postgres may split those tied students between quartiles differently on different runs, so quartile-row values were not reproducible: re-running the six levels queries moved 19 of 100 quartile cells by 1 PR point. Every moved cell was an `_end` value — tied students share a baseline, so a swap cannot move a Start mean or an n, only an End mean — which also ruled out a data refresh as the cause. The All row is immune (pooled over the whole matched set regardless of assignment).

Every `NTILE` in this spec therefore orders by `b, studentid`, not `b` alone. Applied to all 57 windows in `gen_sql.py` on 2026-08-13 and all 21 quartile-bearing aggregate tables re-run under it. The tiebreak must be applied to *every* query family at once — a workbook mixing tiebroken and non-tiebroken tables is internally inconsistent.

## Sheet layout (per grade tab)

```
Row 1  [School] — Grade N Growth by Quartile (YYYY-YY)
Blocks in order: i-Ready Reading · i-Ready Math · DIBELS subtests (grade-appropriate,
Raw+PR) · ORF Accuracy (raw) · SBA blocks · SBA Proficiency. Each block:
  title      "DIBELS 8 ORF Words Correct — Avg Raw Score & National PR Change (Fall→Spring)"
  subtitle   local-quartile + norms note (factual, one line)
  header   | Teacher1     | … | School      | District    |  | Subgroups | School      | District    |
  cols     |  Raw  PR  n  | … | Raw  PR  n  | Raw  PR  n  |  |           | Raw  PR  n  | Raw  PR  n  |
  rows: All · D (highest) · C · B · A (lowest)     subgroups: Low Income · Non-Low Income ·
                                                   Special Ed · Non-Special Ed  (All level)
Bottom of tab: "School vs District — Avg National PR by Quartile" mini-tables (see above).
```
Negative changes red, positive green, n gray; `—` for n = 0; final tab = Definitions (method notes incl. the local-quartile explanation and the Raw-vs-PR reading note: positive Raw with negative PR = grew, but slower than national norms).

## Open items before deployment

1. Pilot with a real principal account to confirm district-scope aggregates are visible under role restrictions (R&A validation used unrestricted access).
2. Decide whether principals may request schools other than their own (skill currently assumes own-school only; role scoping may enforce it anyway).
3. Norms refresh process when UO publishes updated percentile tables.
