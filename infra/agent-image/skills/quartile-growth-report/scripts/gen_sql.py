"""Generate the aggregate SQL for the quartile growth report (local quartiles +
DIBELS national PR change), for any configured school.

Usage: uv run python3 gen_sql.py [evergreen|purdy]

Writes one file per query to the school's sql dir (agg/sql for Evergreen,
agg/<slug>/sql otherwise). Each is pasted verbatim into psd-data query_data.
All queries return aggregates only (PII protocol).
"""
import pathlib
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
# Bundled with the skill — see norms_fragment().
NORMS_DIR = ROOT.parent / "references" / "norms"

YEAR = 35

# Per-grade measure config is district policy (which subtests have district
# coverage, which window is the baseline) and is identical across schools;
# only the school id and its homeroom sections differ.
MEASURES = {
    0: dict(course="GR00K", pr_meas=["LNF", "PSF", "NWF CLS", "NWF WRC"], pr_base="Winter",
            orf=False, plain=[]),
    1: dict(course="GR001", pr_meas=["LNF", "PSF", "NWF CLS", "NWF WRC"], pr_base="Fall",
            orf=True, orf_base="Winter",
            plain=[("iReady Reading", "Fall"), ("iReady Math", "Fall"),
                   ("D:ORF Accuracy", "Winter")]),
    2: dict(course="GR002", pr_meas=["NWF CLS", "NWF WRC", "ORF WC"], pr_base="Fall",
            orf=False,
            plain=[("iReady Reading", "Fall"), ("iReady Math", "Fall"),
                   ("D:ORF Accuracy", "Fall")]),
    3: dict(course="GR003", pr_meas=["ORF WC"], pr_base="Fall", orf=False,
            plain=[("iReady Reading", "Fall"), ("iReady Math", "Fall"),
                   ("D:ORF Accuracy", "Fall")]),
    4: dict(course="GR004", pr_meas=["ORF WC"], pr_base="Fall", orf=False,
            plain=[("iReady Reading", "Fall"), ("iReady Math", "Fall"),
                   ("D:ORF Accuracy", "Fall")]),
    5: dict(course="GR005", pr_meas=["ORF WC"], pr_base="Fall", orf=False,
            plain=[("iReady Reading", "Fall"), ("iReady Math", "Fall"),
                   ("D:ORF Accuracy", "Fall")]),
}

# Homeroom sections per school, ordered as the report's classroom columns
# (sectionid order; labels live in build_workbook.py).
SCHOOLS = {
    "evergreen": dict(
        id=3055, name="Evergreen Elementary", subdir=None,
        sections={0: [274378, 274379, 274411],
                  1: [274398, 274349],
                  2: [274351, 274391, 280328, 274389],
                  3: [274382, 274392, 274423],
                  4: [274390, 274414, 274424],
                  5: [274386, 274395, 274431]}),
    "purdy": dict(
        id=3685, name="Purdy Elementary", subdir="purdy",
        sections={0: [274895, 274896, 274910],
                  1: [274903, 274965, 275038],
                  2: [274929, 274960, 274966],
                  3: [274893, 274904, 274961, 274985, 274988],
                  4: [274894, 274911, 274923, 274962],
                  5: [274905, 274909, 274940, 275006]}),
}

SUBGROUP_LATERAL = """CROSS JOIN LATERAL (VALUES ('Low Income', fr.frl IS TRUE), ('Non-Low Income', fr.frl IS FALSE), ('Special Ed', sp2.special_education IS TRUE), ('Non-Special Ed', sp2.special_education IS FALSE)) AS sg(lbl, inc)"""


def grades_for(school):
    """Merge district measure config with this school's sections.

    A grade with no homeroom sections is DROPPED, not defaulted. The sections
    come from a live roster query, and not every building serves K-5 — the
    agent asserted a grade span it had not queried once already (Minter Creek
    announced as K-2; it is K-5). A missing grade must therefore make the
    query disappear, never make a query over an empty section list.
    """
    out = {}
    for g, m in MEASURES.items():
        sections = school["sections"].get(g)
        if sections:
            out[g] = dict(m, sections=list(sections))
    return out


def hr_sch(g, cfg, school, year):
    return f"""hr AS (SELECT DISTINCT ON (studentid) studentid, sectionid FROM section_enrollments WHERE yearid={year} AND schoolid={school['id']} AND course_code='{cfg["course"]}' ORDER BY studentid, dateleft DESC),
sch AS (SELECT DISTINCT studentid FROM school_year_enrollments WHERE yearid={year} AND schoolid={school['id']} AND grade_level={g})"""


def sch_only(g, school, year):
    return (f"sch AS (SELECT DISTINCT studentid FROM school_year_enrollments "
            f"WHERE yearid={year} AND schoolid={school['id']} AND grade_level={g})")


def quartile_tail(cfg, val_exprs):
    """val_exprs: list of (alias_prefix, sql_expr). Builds cls/scha/dist + final select."""
    secs = cfg["sections"]
    cls_cols, sel_cols = [], []
    for i, sec in enumerate(secs, 1):
        for prefix, expr in val_exprs:
            cls_cols.append(f"ROUND(AVG({expr}) FILTER (WHERE sectionid={sec}),1) AS {prefix}{i}")
            sel_cols.append(f"{prefix}{i}")
        cls_cols.append(f"COUNT(*) FILTER (WHERE sectionid={sec}) AS n{i}")
        sel_cols.append(f"n{i}")
    for scope in ("sch", "dist"):
        for prefix, expr in val_exprs:
            sel_cols.append(f"{prefix}_{scope}")
        sel_cols.append(f"n_{scope}")
    scha_cols = ", ".join(
        [f"ROUND(AVG({expr}),1) AS {prefix}_sch" for prefix, expr in val_exprs]
        + ["COUNT(*) AS n_sch"])
    dist_cols = ", ".join(
        [f"ROUND(AVG({expr}),1) AS {prefix}_dist" for prefix, expr in val_exprs]
        + ["COUNT(*) AS n_dist"])
    return f""",
mm AS (SELECT m.*, hr.sectionid, (sch.studentid IS NOT NULL) AS in_sch
       FROM m LEFT JOIN hr ON hr.studentid=m.studentid LEFT JOIN sch ON sch.studentid=m.studentid),
q AS (SELECT mm.*,
        NTILE(4) OVER (PARTITION BY meas, sectionid ORDER BY b, studentid) AS q_cls,
        NTILE(4) OVER (PARTITION BY meas, in_sch ORDER BY b, studentid) AS q_sch,
        NTILE(4) OVER (PARTITION BY meas ORDER BY b, studentid) AS q_dist
      FROM mm),
cls AS (SELECT meas, COALESCE(q_cls::text,'All') AS qt, {", ".join(cls_cols)}
        FROM q WHERE sectionid IS NOT NULL GROUP BY GROUPING SETS ((meas, q_cls),(meas))),
scha AS (SELECT meas, COALESCE(q_sch::text,'All') AS qt, {scha_cols}
        FROM q WHERE in_sch GROUP BY GROUPING SETS ((meas, q_sch),(meas))),
dist AS (SELECT meas, COALESCE(q_dist::text,'All') AS qt, {dist_cols}
        FROM q GROUP BY GROUPING SETS ((meas, q_dist),(meas)))
SELECT meas, qt, {", ".join(sel_cols)}
FROM dist LEFT JOIN scha USING (meas, qt) LEFT JOIN cls USING (meas, qt)
ORDER BY meas, qt"""


def section_pivot(cfg, val_exprs, rounding=0):
    """Non-quartile section pivot: value + n per section, then school and district."""
    cols = []
    for i, sec in enumerate(cfg["sections"], 1):
        for prefix, expr in val_exprs:
            cols.append(f"ROUND(AVG({expr}) FILTER (WHERE sectionid={sec}),{rounding}) AS {prefix}{i}")
        cols.append(f"COUNT(*) FILTER (WHERE sectionid={sec}) AS n{i}")
    for prefix, expr in val_exprs:
        cols.append(f"ROUND(AVG({expr}) FILTER (WHERE in_sch),{rounding}) AS {prefix}_sch")
    cols.append("COUNT(*) FILTER (WHERE in_sch) AS n_sch")
    for prefix, expr in val_exprs:
        cols.append(f"ROUND(AVG({expr}),{rounding}) AS {prefix}_dist")
    cols.append("COUNT(*) AS n_dist")
    return ", ".join(cols)


def subgroup_select(val_exprs, rounding=1):
    """meas | lbl | <vals>_sch | n_sch | <vals>_dist | n_dist."""
    cols = [f"ROUND(AVG({expr}) FILTER (WHERE sch.studentid IS NOT NULL),{rounding}) AS {p}_sch"
            for p, expr in val_exprs]
    cols.append("COUNT(sch.studentid) AS n_sch")
    cols += [f"ROUND(AVG({expr}),{rounding}) AS {p}_dist" for p, expr in val_exprs]
    cols.append("COUNT(*) AS n_dist")
    return ", ".join(cols)


def dibels_pairs(cfg):
    """(measure, baseline window) for every DIBELS measure reported at this grade."""
    pairs = [(m, cfg["pr_base"]) for m in cfg["pr_meas"]]
    if cfg.get("orf"):
        pairs.append(("ORF WC", cfg["orf_base"]))
    return pairs


def norms_fragment(grade):
    """The per-grade DIBELS 8 cut points, as a ready-to-embed VALUES CTE.

    A HARD DEPENDENCY, bundled with the skill. The agent cannot derive these —
    they were extracted from UO Technical Report 2201 and validated (zero
    non-monotonic columns, zero gaps, 14/14 spot checks). Inventing a
    percentile would misstate how a child scored against national peers.
    """
    path = NORMS_DIR / f"norms_sql_g{grade}.txt"
    if not path.exists():
        raise FileNotFoundError(f"missing bundled norms fragment: {path}")
    return path.read_text().strip()


def _g3_sba_queries(cfg, school, year, sqldir):
    """The three grade-3-only SBA queries.

    Grade 3 has no prior-year summative to quartile on, so it is baselined on
    the Fall i-Ready percentile instead. Lifted out of generate() unchanged so
    a school that does not serve grade 3 can skip them; the SQL strings are
    byte-identical to R&A's and the fixture test proves it.
    """
    # --- G3 SBA by Fall i-Ready quartile (no prior-year SBA exists at grade 3)
    g3_base = f"""base AS (
  SELECT 'ELA' AS subject, studentid, AVG(percentile) AS b FROM iready_reading_diagnostics WHERE yearid={year} AND grade_level=3 AND "window"='Fall' GROUP BY 2
  UNION ALL
  SELECT 'Math', studentid, AVG(percentile) FROM iready_math_diagnostics WHERE yearid={year} AND grade_level=3 AND "window"='Fall' GROUP BY 2)"""
    g3_cur = f"""cur AS (SELECT studentid, subject, AVG(score) AS e, BOOL_OR(met_standard) AS met FROM smarter_balanced_scores
  WHERE yearid={year} AND grade_level=3 AND is_strand=false AND assessment_group LIKE 'Summative%' GROUP BY 1,2)"""
    sql = (f"""WITH {g3_base},
{g3_cur},
m AS (SELECT c.subject AS meas, c.studentid, b.b, c.e, CASE WHEN c.met THEN 100.0 ELSE 0.0 END AS metv
      FROM cur c JOIN base b ON b.studentid=c.studentid AND b.subject=c.subject),
{hr_sch(3, cfg, school, year)}"""
           + quartile_tail(cfg, [("a", "e"), ("p", "metv")]))
    (sqldir / "g3_sba_quartile_local.sql").write_text(sql)

    # --- G3 SBA subgroup values on the same matched (Fall i-Ready) set
    sql = f"""WITH {g3_base},
{g3_cur},
m AS (SELECT c.subject AS meas, c.studentid, c.e, CASE WHEN c.met THEN 100.0 ELSE 0.0 END AS metv
      FROM cur c JOIN base b ON b.studentid=c.studentid AND b.subject=c.subject),
{sch_only(3, school, year)}
SELECT m.meas, sg.lbl, {subgroup_select([("a", "e"), ("p", "metv")], rounding=0)}
FROM m
LEFT JOIN sch ON sch.studentid=m.studentid
LEFT JOIN students_frl fr ON fr.studentid=m.studentid
LEFT JOIN students_specialed sp2 ON sp2.studentid=m.studentid
{SUBGROUP_LATERAL}
WHERE sg.inc
GROUP BY 1,2 ORDER BY 1,2"""
    (sqldir / "g3_sba_sub.sql").write_text(sql)

    # --- G3 proficiency by subgroup (G4/5 fold proficiency into their sba_sub query)
    cur3 = f"""cur AS (SELECT studentid, subject, BOOL_OR(met_standard) AS met FROM smarter_balanced_scores
  WHERE yearid={year} AND grade_level=3 AND is_strand=false AND assessment_group LIKE 'Summative%' GROUP BY 1,2)"""
    sql = f"""WITH {cur3},
m AS (SELECT subject AS meas, studentid, CASE WHEN met THEN 100.0 ELSE 0.0 END AS metv FROM cur),
{sch_only(3, school, year)}
SELECT m.meas, sg.lbl, {subgroup_select([("p", "metv")], rounding=0)}
FROM m
LEFT JOIN sch ON sch.studentid=m.studentid
LEFT JOIN students_frl fr ON fr.studentid=m.studentid
LEFT JOIN students_specialed sp2 ON sp2.studentid=m.studentid
{SUBGROUP_LATERAL}
WHERE sg.inc
GROUP BY 1,2 ORDER BY 1,2"""
    (sqldir / "g3_sba_prof_sub.sql").write_text(sql)


def generate(school, sqldir, year=YEAR, verbose=False):
    """Write every query for one school. `school` is {id, name, sections}.

    Transcribed from R&A's validated generator (James Cantonwine, 2026-08-17
    handoff). The SQL shapes here are NOT a design — they are the exact
    queries run against psd-data for Evergreen and Purdy, and the test suite
    byte-compares this output against those files.
    """
    grades = grades_for(school)
    sqldir = pathlib.Path(sqldir)
    sqldir.mkdir(parents=True, exist_ok=True)

    for g, cfg in grades.items():
        norms = norms_fragment(g)

        # --- query A: DIBELS with PR (baseline pr_base -> Spring)
        meas_list = ", ".join(f"'{m}'" for m in cfg["pr_meas"])
        base_w = cfg["pr_base"]
        stu = f"""stu AS (SELECT assessment_group AS meas, studentid, "window", AVG(score) AS s
  FROM dibels_scores WHERE yearid={year} AND grade_level={g}
    AND assessment_group IN ({meas_list}) AND "window" IN ('{base_w}','Spring') GROUP BY 1,2,3)"""
        m = f"""m AS (SELECT f.meas, f.studentid, f.s AS b, sp.s AS e, pb.pr AS prb, pe.pr AS pre
  FROM stu f
  JOIN stu sp ON sp.studentid=f.studentid AND sp.meas=f.meas AND sp."window"='Spring'
  LEFT JOIN LATERAL (SELECT n.pr FROM norms n WHERE n.meas0=f.meas AND n.per='{base_w}' AND n.cut <= f.s ORDER BY n.cut DESC LIMIT 1) pb ON true
  LEFT JOIN LATERAL (SELECT n.pr FROM norms n WHERE n.meas0=sp.meas AND n.per='Spring' AND n.cut <= sp.s ORDER BY n.cut DESC LIMIT 1) pe ON true
  WHERE f."window"='{base_w}')"""
        sql = (f"WITH {norms},\n{stu},\n{m},\n{hr_sch(g, cfg, school, year)}"
               + quartile_tail(cfg, [("a", "e-b"), ("p", "pre-prb")]))
        (sqldir / f"g{g}_A_dibels_pr.sql").write_text(sql)

        # --- query A2 (grade 1 only): ORF WC Winter->Spring with PR
        if cfg.get("orf"):
            stu2 = f"""stu AS (SELECT assessment_group AS meas, studentid, "window", AVG(score) AS s
  FROM dibels_scores WHERE yearid={year} AND grade_level={g}
    AND assessment_group = 'ORF WC' AND "window" IN ('Winter','Spring') GROUP BY 1,2,3)"""
            m2 = m.replace(f"n.per='{base_w}'", "n.per='Winter'").replace(f'f."window"=\'{base_w}\'', 'f."window"=\'Winter\'')
            sql = (f"WITH {norms},\n{stu2},\n{m2},\n{hr_sch(g, cfg, school, year)}"
                   + quartile_tail(cfg, [("a", "e-b"), ("p", "pre-prb")]))
            (sqldir / f"g{g}_A2_orf_pr.sql").write_text(sql)

        # --- query B: plain measures (iReady + ORF Accuracy), no norms
        if cfg["plain"]:
            parts = []
            for meas, b0 in cfg["plain"]:
                if meas.startswith("iReady"):
                    tbl = ("iready_reading_diagnostics" if "Reading" in meas
                           else "iready_math_diagnostics")
                    parts.append(f"""SELECT '{meas}' AS meas, studentid, "window", AVG(percentile) AS s
  FROM {tbl} WHERE yearid={year} AND grade_level={g} AND "window" IN ('{b0}','Spring') GROUP BY 2,3""")
                else:
                    ag = meas[2:]
                    parts.append(f"""SELECT '{meas}', studentid, "window", AVG(score)
  FROM dibels_scores WHERE yearid={year} AND grade_level={g} AND assessment_group='{ag}' AND "window" IN ('{b0}','Spring') GROUP BY 2,3""")
            stu = "stu AS (" + "\n  UNION ALL\n".join(parts) + ")"
            base_case = ("CASE WHEN f.meas = 'D:ORF Accuracy' THEN '"
                         + dict(cfg["plain"])["D:ORF Accuracy"] + "' ELSE 'Fall' END")
            m3 = f"""m AS (SELECT f.meas, f.studentid, f.s AS b, sp.s AS e
  FROM stu f JOIN stu sp ON sp.studentid=f.studentid AND sp.meas=f.meas
  WHERE f."window" = {base_case} AND sp."window"='Spring')"""
            sql = (f"WITH {stu},\n{m3},\n{hr_sch(g, cfg, school, year)}"
                   + quartile_tail(cfg, [("a", "e-b")]))
            (sqldir / f"g{g}_B_plain.sql").write_text(sql)

        # --- query C: subgroup PR deltas for DIBELS PR measures (school + district)
        pairs = dibels_pairs(cfg)
        sel = ", ".join(f"('{m0}','{b0}')" for m0, b0 in pairs)
        stu = f"""stu AS (SELECT d.assessment_group AS meas, mp.b0, d.studentid, d."window", AVG(d.score) AS s
  FROM dibels_scores d
  JOIN (VALUES {sel}) mp(m0, b0) ON mp.m0 = d.assessment_group
  WHERE d.yearid={year} AND d.grade_level={g} AND d."window" IN (mp.b0, 'Spring')
  GROUP BY 1,2,3,4)"""
        m4 = """m AS (SELECT f.meas, f.studentid, pe.pr - pb.pr AS prd
  FROM stu f
  JOIN stu sp ON sp.studentid=f.studentid AND sp.meas=f.meas AND sp."window"='Spring'
  LEFT JOIN LATERAL (SELECT n.pr FROM norms n WHERE n.meas0=f.meas AND n.per=f.b0 AND n.cut <= f.s ORDER BY n.cut DESC LIMIT 1) pb ON true
  LEFT JOIN LATERAL (SELECT n.pr FROM norms n WHERE n.meas0=sp.meas AND n.per='Spring' AND n.cut <= sp.s ORDER BY n.cut DESC LIMIT 1) pe ON true
  WHERE f."window" = f.b0)"""
        sql = f"""WITH {norms},
{stu},
{m4},
{sch_only(g, school, year)}
SELECT m.meas, sg.lbl,
 ROUND(AVG(prd) FILTER (WHERE sch.studentid IS NOT NULL),1) AS p_sch, COUNT(sch.studentid) AS n_sch,
 ROUND(AVG(prd),1) AS p_dist, COUNT(*) AS n_dist
FROM m
LEFT JOIN sch ON sch.studentid=m.studentid
LEFT JOIN students_frl fr ON fr.studentid=m.studentid
LEFT JOIN students_specialed sp2 ON sp2.studentid=m.studentid
{SUBGROUP_LATERAL}
WHERE sg.inc
GROUP BY 1,2 ORDER BY 1,2"""
        (sqldir / f"g{g}_C_sub_pr.sql").write_text(sql)

        # --- query D: raw (non-PR) growth by subgroup, every measure on the tab
        raw_pairs = list(pairs) + [(meas[2:], b0) for meas, b0 in cfg["plain"]
                                   if not meas.startswith("iReady")]
        sel = ", ".join(f"('{m0}','{b0}')" for m0, b0 in raw_pairs)
        dsub = f"""dst AS (SELECT d.assessment_group AS meas, mp.b0, d.studentid, d."window", AVG(d.score) AS s
  FROM dibels_scores d
  JOIN (VALUES {sel}) mp(m0, b0) ON mp.m0 = d.assessment_group
  WHERE d.yearid={year} AND d.grade_level={g} AND d."window" IN (mp.b0, 'Spring')
  GROUP BY 1,2,3,4),
dm AS (SELECT 'D:' || f.meas AS meas, f.studentid, sp.s - f.s AS chg
  FROM dst f
  JOIN dst sp ON sp.studentid=f.studentid AND sp.meas=f.meas AND sp."window"='Spring'
  WHERE f."window" = f.b0)"""
        src = ["SELECT * FROM dm"]
        ir = [(meas, b0) for meas, b0 in cfg["plain"] if meas.startswith("iReady")]
        ictes = ""
        if ir:
            parts = []
            for meas, b0 in ir:
                tbl = ("iready_reading_diagnostics" if "Reading" in meas
                       else "iready_math_diagnostics")
                parts.append(f"""SELECT '{meas}' AS meas, studentid, "window", AVG(percentile) AS s
  FROM {tbl} WHERE yearid={year} AND grade_level={g} AND "window" IN ('{b0}','Spring') GROUP BY 1,2,3""")
            ictes = (",\nist AS (" + "\n  UNION ALL\n".join(parts) + """),
im AS (SELECT f.meas, f.studentid, sp.s - f.s AS chg
  FROM ist f JOIN ist sp ON sp.studentid=f.studentid AND sp.meas=f.meas AND sp."window"='Spring'
  WHERE f."window" <> 'Spring')""")
            src.append("SELECT * FROM im")
        sql = f"""WITH {dsub}{ictes},
m AS ({" UNION ALL ".join(src)}),
{sch_only(g, school, year)}
SELECT m.meas, sg.lbl, {subgroup_select([("a", "chg")])}
FROM m
LEFT JOIN sch ON sch.studentid=m.studentid
LEFT JOIN students_frl fr ON fr.studentid=m.studentid
LEFT JOIN students_specialed sp2 ON sp2.studentid=m.studentid
{SUBGROUP_LATERAL}
WHERE sg.inc
GROUP BY 1,2 ORDER BY 1,2"""
        (sqldir / f"g{g}_D_growth_sub.sql").write_text(sql)

    # --- SBA local-quartile change queries (G4/G5, by prior-year SBA quartile)
    for g in (4, 5):
        if g not in grades:
            continue
        cfg = grades[g]
        cur = f"""cur AS (SELECT studentid, subject, AVG(score) AS e FROM smarter_balanced_scores
  WHERE yearid={year} AND grade_level={g} AND is_strand=false AND assessment_group LIKE 'Summative%' GROUP BY 1,2)"""
        pri = f"""pri AS (SELECT studentid, subject, AVG(score) AS b FROM smarter_balanced_scores
  WHERE yearid={year - 1} AND grade_level={g-1} AND is_strand=false AND assessment_group LIKE 'Summative%' GROUP BY 1,2)"""
        m5 = """m AS (SELECT c.subject AS meas, c.studentid, p.b, c.e FROM cur c JOIN pri p ON p.studentid=c.studentid AND p.subject=c.subject)"""
        sql = (f"WITH {cur},\n{pri},\n{m5},\n{hr_sch(g, cfg, school, year)}"
               + quartile_tail(cfg, [("a", "e-b")]))
        (sqldir / f"g{g}_sba_change_local.sql").write_text(sql)

    # --- levels queries (School vs District PR start/end, bottom-of-tab tables)
    # Same matched sets as the change blocks, but reporting PR LEVELS not deltas:
    # bs = baseline PR, es = spring PR (i-Ready: the diagnostic percentile itself).
    # GROUPING SETS adds the 'All' row (pooled mean over all matched students).
    for g, cfg in grades.items():
        norms = norms_fragment(g)

        sel = ", ".join(f"('{m0}','{b0}')" for m0, b0 in dibels_pairs(cfg))
        dst = f"""dst AS (SELECT d.assessment_group AS meas, mp.b0, d.studentid, d."window", AVG(d.score) AS s
  FROM dibels_scores d
  JOIN (VALUES {sel}) mp(m0, b0) ON mp.m0 = d.assessment_group
  WHERE d.yearid={year} AND d.grade_level={g} AND d."window" IN (mp.b0, 'Spring')
  GROUP BY 1,2,3,4)"""
        dm = """dm AS (SELECT f.meas, f.studentid, f.s AS b, pb.pr AS bs, pe.pr AS es
  FROM dst f
  JOIN dst sp ON sp.studentid=f.studentid AND sp.meas=f.meas AND sp."window"='Spring'
  LEFT JOIN LATERAL (SELECT n.pr FROM norms n WHERE n.meas0=f.meas AND n.per=f.b0 AND n.cut <= f.s ORDER BY n.cut DESC LIMIT 1) pb ON true
  LEFT JOIN LATERAL (SELECT n.pr FROM norms n WHERE n.meas0=sp.meas AND n.per='Spring' AND n.cut <= sp.s ORDER BY n.cut DESC LIMIT 1) pe ON true
  WHERE f."window" = f.b0)"""

        ir = [(m0, b0) for m0, b0 in cfg["plain"] if m0.startswith("iReady")]
        src = ["SELECT * FROM dm"]
        parts = []
        for meas, b0 in ir:
            tbl = ("iready_reading_diagnostics" if "Reading" in meas
                   else "iready_math_diagnostics")
            parts.append(f"""SELECT '{meas}' AS meas, studentid, "window", AVG(percentile) AS s
  FROM {tbl} WHERE yearid={year} AND grade_level={g} AND "window" IN ('{b0}','Spring') GROUP BY 1,2,3""")
        ictes = ""
        if parts:
            ictes = (",\nist AS (" + "\n  UNION ALL\n".join(parts) + """),
im AS (SELECT f.meas, f.studentid, f.s AS b, f.s AS bs, sp.s AS es
  FROM ist f JOIN ist sp ON sp.studentid=f.studentid AND sp.meas=f.meas AND sp."window"='Spring'
  WHERE f."window" <> 'Spring')""")
            src.append("SELECT * FROM im")

        sql = f"""WITH {norms},
{dst},
{dm}{ictes},
m AS ({" UNION ALL ".join(src)}),
{sch_only(g, school, year)},
mm AS (SELECT m.*, (sch.studentid IS NOT NULL) AS in_sch
       FROM m LEFT JOIN sch ON sch.studentid=m.studentid),
q AS (SELECT mm.*,
        NTILE(4) OVER (PARTITION BY meas, in_sch ORDER BY b, studentid) AS q_sch,
        NTILE(4) OVER (PARTITION BY meas ORDER BY b, studentid) AS q_dist
      FROM mm),
schq AS (SELECT meas, COALESCE(q_sch::text,'All') AS qt,
           ROUND(AVG(bs),0) AS s_start, ROUND(AVG(es),0) AS s_end, COUNT(*) AS n_sch
         FROM q WHERE in_sch GROUP BY GROUPING SETS ((meas, q_sch),(meas))),
distq AS (SELECT meas, COALESCE(q_dist::text,'All') AS qt,
           ROUND(AVG(bs),0) AS d_start, ROUND(AVG(es),0) AS d_end, COUNT(*) AS n_dist
          FROM q GROUP BY GROUPING SETS ((meas, q_dist),(meas)))
SELECT meas, qt, s_start, s_end, n_sch, d_start, d_end, n_dist
FROM distq LEFT JOIN schq USING (meas, qt)
ORDER BY meas, qt"""
        (sqldir / f"g{g}_levels.sql").write_text(sql)

    # --- grade-3-only SBA queries (baselined on Fall i-Ready)
    if 3 in grades:
        _g3_sba_queries(grades[3], school, year, sqldir)

    # --- SBA proficiency (all tested), by section / school / district
    for g in (3, 4, 5):
        if g not in grades:
            continue
        cfg = grades[g]
        cur = f"""cur AS (SELECT studentid, subject, BOOL_OR(met_standard) AS met FROM smarter_balanced_scores
  WHERE yearid={year} AND grade_level={g} AND is_strand=false AND assessment_group LIKE 'Summative%' GROUP BY 1,2)"""
        sql = f"""WITH {cur},
{hr_sch(g, cfg, school, year)},
mm AS (SELECT c.subject AS meas, CASE WHEN c.met THEN 100.0 ELSE 0.0 END AS metv,
         hr.sectionid, (sch.studentid IS NOT NULL) AS in_sch
       FROM cur c LEFT JOIN hr ON hr.studentid=c.studentid LEFT JOIN sch ON sch.studentid=c.studentid)
SELECT meas, {section_pivot(cfg, [("p", "metv")], rounding=0)}
FROM mm GROUP BY 1 ORDER BY 1"""
        (sqldir / f"g{g}_sba_prof.sql").write_text(sql)

    # --- G4/G5 SBA subgroup: scale-score change (matched both years) + proficiency
    for g in (4, 5):
        if g not in grades:
            continue
        sql = f"""WITH cur AS (SELECT studentid, subject, AVG(score) AS e, BOOL_OR(met_standard) AS met FROM smarter_balanced_scores
  WHERE yearid={year} AND grade_level={g} AND is_strand=false AND assessment_group LIKE 'Summative%' GROUP BY 1,2),
pri AS (SELECT studentid, subject, AVG(score) AS b FROM smarter_balanced_scores
  WHERE yearid={year - 1} AND grade_level={g-1} AND is_strand=false AND assessment_group LIKE 'Summative%' GROUP BY 1,2),
m AS (SELECT 'SBA Chg ' || c.subject AS meas, c.studentid, c.e - p.b AS v
        FROM cur c JOIN pri p ON p.studentid=c.studentid AND p.subject=c.subject
      UNION ALL
      SELECT 'SBA Prof ' || subject, studentid, CASE WHEN met THEN 100.0 ELSE 0.0 END FROM cur),
{sch_only(g, school, year)}
SELECT m.meas, sg.lbl, {subgroup_select([("a", "v")])}
FROM m
LEFT JOIN sch ON sch.studentid=m.studentid
LEFT JOIN students_frl fr ON fr.studentid=m.studentid
LEFT JOIN students_specialed sp2 ON sp2.studentid=m.studentid
{SUBGROUP_LATERAL}
WHERE sg.inc
GROUP BY 1,2 ORDER BY 1,2"""
        (sqldir / f"g{g}_sba_sub.sql").write_text(sql)

    if verbose:
        print(f"{school['name']} (schoolid {school['id']}) -> {sqldir}")
        for f in sorted(sqldir.iterdir()):
            print(" ", f.name, len(f.read_text()))
    return sorted(sqldir.glob("*.sql"))


LOCAL_QUARTILE_NOTE = (
    "Local quartiles: A = lowest 25% and D = highest 25% WITHIN that column's "
    "own students. A classroom's A is not the district's A.")
PR_NOTE = (
    "National PR from DIBELS 8 norms, University of Oregon Technical Report "
    "2201 (2021-22); percentiles clamped to 1-99.")


def specs(school):
    """What every generated query returns, so the sheet layout is DERIVED.

    generate() writes SQL; this says how to read it back — the shape, the
    value columns, the section order, and where the block belongs on the tab.
    Keeping both in one module is deliberate: the layout step used to infer
    column meanings from data it had never seen, and a spec that drifts from
    the SQL is caught by test_gen_sql (the two name lists must match exactly).

    shape:
      quartile - meas, qt, per-section values + n, then school, then district
      prof     - meas, per-section values + n (no quartile rows)
      subgroup - meas, lbl, school values + n, district values + n
      levels   - meas, qt, school start/end + n, district start/end + n
    """
    grades = grades_for(school)
    out = []

    def add(name, grade, shape, values, order, title, note="", sections=None):
        out.append(dict(name=name, grade=grade, shape=shape, values=values,
                        order=order, title=title, note=note,
                        sections=list(sections or [])))

    for g, cfg in sorted(grades.items()):
        secs = cfg["sections"]
        base = cfg["pr_base"]

        if cfg["plain"]:
            add(f"g{g}_B_plain.sql", g, "quartile", [("a", "Change")], 10,
                "i-Ready percentile & ORF Accuracy - Avg Change (Fall\u2192Spring)",
                LOCAL_QUARTILE_NOTE, secs)

        add(f"g{g}_A_dibels_pr.sql", g, "quartile",
            [("a", "Raw"), ("p", "PR")], 20,
            f"DIBELS 8 - Avg Raw Score & National PR Change ({base}\u2192Spring)",
            f"{LOCAL_QUARTILE_NOTE} {PR_NOTE}", secs)

        if cfg.get("orf"):
            # ORF starts mid-year at grade 1, so its baseline is Winter while
            # every other grade-1 measure is Fall. Labelling both Fall->Spring
            # would misstate what was measured.
            add(f"g{g}_A2_orf_pr.sql", g, "quartile",
                [("a", "Raw"), ("p", "PR")], 21,
                f"DIBELS 8 ORF Words Correct - Avg Raw Score & National PR "
                f"Change ({cfg['orf_base']}\u2192Spring)",
                f"{LOCAL_QUARTILE_NOTE} {PR_NOTE}", secs)

        if g in (4, 5):
            add(f"g{g}_sba_change_local.sql", g, "quartile", [("a", "Change")],
                30, "SBA - Avg Scale Score Change (prior year\u2192this year)",
                LOCAL_QUARTILE_NOTE, secs)
        if g == 3:
            add("g3_sba_quartile_local.sql", g, "quartile",
                [("a", "Scale"), ("p", "% Met")], 30,
                "SBA - Avg Scale Score & % Met, by Fall i-Ready Quartile",
                LOCAL_QUARTILE_NOTE, secs)
        if g in (3, 4, 5):
            add(f"g{g}_sba_prof.sql", g, "prof", [("p", "% Met")], 40,
                "SBA Proficiency - % Met Standard (all tested students)",
                "", secs)

        add(f"g{g}_C_sub_pr.sql", g, "subgroup", [("p", "PR")], 50,
            "DIBELS National PR Change by Subgroup")
        add(f"g{g}_D_growth_sub.sql", g, "subgroup", [("a", "Change")], 51,
            "Avg Raw / Percentile Change by Subgroup")
        if g == 3:
            add("g3_sba_sub.sql", g, "subgroup",
                [("a", "Scale"), ("p", "% Met")], 52,
                "SBA Scale Score & % Met by Subgroup")
            add("g3_sba_prof_sub.sql", g, "subgroup", [("p", "% Met")], 53,
                "SBA Proficiency by Subgroup")
        if g in (4, 5):
            add(f"g{g}_sba_sub.sql", g, "subgroup", [("a", "Value")], 52,
                "SBA Scale Change & Proficiency by Subgroup")

        add(f"g{g}_levels.sql", g, "levels",
            [("start", "PR Start"), ("end", "PR End")], 60,
            "School vs District - Avg National PR by Quartile",
            LOCAL_QUARTILE_NOTE)

    return sorted(out, key=lambda s: (s["grade"], s["order"], s["name"]))


def main() -> int:
    key = sys.argv[1] if len(sys.argv) > 1 else "evergreen"
    out = sys.argv[2] if len(sys.argv) > 2 else f"/tmp/qgr-sql-{key}"
    if key not in SCHOOLS:
        print(f"unknown school {key!r}; known: {', '.join(SCHOOLS)}",
              file=sys.stderr)
        return 2
    generate(SCHOOLS[key], out, verbose=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
