# Quartile Growth Report — Skill Handoff Bundle

From James Cantonwine (R&A). Everything here was validated against psd-data for Evergreen Elementary and Purdy Elementary, 2025-26. Goal: your Chat-agent skill should be a **transcription of this material, not a fresh design** — every non-obvious decision below cost a query cycle to discover.

> **Editorial note — added by the skill, not by R&A. Everything below this
> block is James's document verbatim; nothing in it has been altered.**
>
> This was written for R&A's own workflow, where a person adapts the generator
> by hand. In this skill `run_report.py` does that automatically: it queries
> the roster, builds the school config, and calls `gen_sql.generate()`. Two
> consequences for anyone reading further:
>
> - **Ignore the second half of "Adapting to a school" step 2.** Substituting
>   ids into a pre-written query is a valid thing for a person to do at a psql
>   prompt with the school in front of them. It is not valid here: the queries
>   are pinned to Evergreen, and a mis-swapped id returns real, plausible,
>   internally consistent numbers for the wrong school in a document a
>   principal reads as fact. Generate; never hand-edit a pinned query.
> - **The `sql-evergreen/` paths describe R&A's bundle layout.** In this repo
>   those 40 queries live in `test-fixtures/`, and they are deliberately NOT in
>   the agent image — they exist so `test_gen_sql.py` can byte-compare the
>   generator against them.
>
> The norms fragments, the non-negotiables list and every method decision below
> apply exactly as written.

## Contents

| Path | What it is |
|---|---|
| `SKILL-PROPOSAL-quartile-growth-report.md` | The skill spec: triggers, inputs, method, reference SQL with parameter slots, sheet layout, privacy rules, pitfalls. **Start here.** |
| `sql-evergreen/*.sql` | The 40 exact queries as run against psd-data for Evergreen (schoolid 3055, yearid 35). Already shaped for the MCP: 30-row result cap handled via `GROUPING SETS` + pivoted teacher columns, no bare `::numeric` casts, `"window"` quoted. |
| `norms/norms_sql_g0.txt` … `g5.txt` | DIBELS 8 raw→national-PR cut points per grade, as ready-to-embed SQL `VALUES` fragments. **Hard dependency** — the agent cannot derive these; they were extracted from the UO 2021-22 percentile tables (Technical Report 2201). Bundle them in the skill. |
| `norms/dibels8_norms_2021-22.csv` | The full 10,674-cell norms lookup the fragments were compressed from (reference / regeneration source). |
| `gen_sql.py` | Generates all 40 queries for any school from a config entry (`SCHOOLS` dict: schoolid + homeroom sectionids per grade). Single source of truth for all 57 NTILE windows. Run: `uv run python3 gen_sql.py evergreen`. |

## Non-negotiables (each one was learned the hard way)

- **Deterministic NTILE tiebreak:** every `NTILE(4)` must be `ORDER BY b, studentid`. `ORDER BY b` alone splits tied baseline scores arbitrarily — quartile cells move between identical runs (measured: 19 of 100 cells shifted on a re-run before the fix).
- **Data only.** No narrative, interpretation, or commentary anywhere in the output; a factual Definitions tab is the only prose. The first Chat-agent attempt inserted analysis and was rejected.
- **SBA filter:** `smarter_balanced_scores` mixes IAB participation rows (score = 1) with summatives. Always `assessment_group LIKE 'Summative%' AND is_strand = false`.
- **Quartiles are local:** each classroom / school / district column is NTILE'd on its own matched population. The three assignments per student are computed in one query (see the `q` CTE in any `*_A_*.sql`).
- **Matched students only:** growth cells require both baseline and ending score; `AVG` per student per window neutralizes retests.
- **No minimum-n suppression:** `—` only when n = 0. Every value cell carries an adjacent n.
- **Teacher of record:** `section_teachers.role_name = 'Lead Teacher'`; never filter on `priorityorder` (often null); unresolvable id → "(Not on file)".
- Long queries (~90s) can time out on the MCP — retry once before changing anything.

## Adapting to a school

1. Find homerooms: query `section_enrollments` for `yearid = 35 AND schoolid = <id> AND course_code IN ('GR00K','GR001',…,'GR005')`, ordered by sectionid.
2. Either add a `SCHOOLS` entry to `gen_sql.py` and regenerate, or substitute schoolid + sectionids into the `sql-evergreen` queries directly (they are otherwise school-independent — measures/windows are district policy).
3. Cross-check: every `_dist` column is school-independent, so it must match another school's run for the same grade/measure.

## Output target

Google Sheets, one tab per grade + Definitions tab. The proposal's "Sheet layout" section is the layout spec (block order, column structure, All → D → C → B → A row order, color rules).

Questions → James.
