#!/usr/bin/env python3
"""Build the whole quartile growth report in one command.

WHY THIS EXISTS

The report's arithmetic was never the problem. Between 2026-08-14 and
2026-08-16 it failed on: a no-op edit ending the run, four assistant messages
fusing into one reply, a promoted background job aborting the run it existed to
continue, `--export` timing out, and the write tool emitting literal newline
escapes into model-authored glue. Every one of those is ORCHESTRATION. Not one
was in the quartiles, the norms, or the rollups.

That path has roughly eight serial failure points, and a run only ever reveals
the first one that fires — fix it, and the next run shows the next. So this
removes the path instead of hardening it. The agent's job becomes: resolve the
school, run this once, paste the link.

WHAT THAT DELETES

  - ~100 model round-trips, each a chance to derail
  - model-authored files, so the literal-newline bug is unreachable
  - the turn deadline, the promotion, and the continuation turn: this runs
    inside ONE exec, and re-running resumes from its checkpoints

WHAT IT DOES NOT FIX

Whether the numbers are right. It makes that answerable — the same school can
be run twice and diffed — which the previous design never allowed.

USAGE

    run_report.py --school "Artondale Elementary" --user you@psd401.net
                  [--year 2025-26] [--grades K,1,2,3,4,5]
                  [--work-dir DIR] [--dry-run] [--plan-only]

Re-running with the same --work-dir skips work already done.
"""

import argparse
import json
import pathlib
import re
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
PSD_DATA = "/opt/psd-skills/psd-data/run.js"
WORKSPACE = "/opt/psd-skills/psd-workspace/run.js"
PYTHON = sys.executable or "/opt/agentcore-venv/bin/python3"

# psd-data rate-limits at 60 req/min/user, so pages are deliberately large:
# a whole grade should be one or two calls, not twenty.
PAGE_SIZE = 5000
MAX_PAGES = 40

# Grades in report order. K sorts first and is stored as "K", not 0.
DEFAULT_GRADES = ["K", "1", "2", "3", "4", "5"]

# Per-grade DIBELS measures. Grade 1 ORF starts mid-year and K has no Fall
# DIBELS at all, both per SKILL.md's Windows table.
BASELINE_BY_GRADE = {"K": "Winter"}


class ReportError(RuntimeError):
    """A failure worth stopping the whole report for."""


def sql_escape(value):
    """Single-quote escaping for an inlined literal.

    The MCP takes SQL text, so a school name with an apostrophe would break
    the statement. School and year names are the only caller-supplied values
    that reach SQL here, and psd-data rejects anything that is not a SELECT.
    """
    return str(value).replace("'", "''")


def run_json(argv, what):
    """Run a command and parse its stdout as JSON.

    Errors carry the command's own stderr. A report that dies on step 4 of 30
    is only debuggable if the failure says which step and what the tool said.
    """
    done = subprocess.run(argv, capture_output=True, text=True)
    if done.returncode != 0:
        raise ReportError(
            f"{what} failed (exit {done.returncode}): "
            f"{(done.stderr or done.stdout or '').strip()[:800]}"
        )
    text = (done.stdout or "").strip()
    if not text:
        raise ReportError(f"{what} returned nothing")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # Some CLIs print a banner before the payload; take the first JSON
        # value rather than failing on a cosmetic prefix.
        match = re.search(r"[\[{].*[\]}]", text, re.S)
        if not match:
            raise ReportError(f"{what} did not return JSON: {text[:400]}")
        return json.loads(match.group(0))


def query(sql, reason, limit=None, offset=None):
    """One psd-data SELECT.

    NOT `--export`. Export mode timed out repeatedly on the grade-K extraction
    on 2026-08-16 while the same query in normal mode returned 2,232 rows in
    seconds, and it has a separate history of silently dropping numeric
    columns from the CSV. Paging is more calls and has actually worked.
    """
    argv = ["node", PSD_DATA, "query", "--reason", reason, "--sql", sql]
    if limit is not None:
        argv += ["--limit", str(limit)]
    if offset is not None:
        argv += ["--offset", str(offset)]
    payload = run_json(argv, f"psd-data query ({reason})")
    rows = payload.get("rows") if isinstance(payload, dict) else payload
    return rows or []


def query_all(sql, reason):
    """Page a SELECT to completion."""
    out = []
    for page in range(MAX_PAGES):
        rows = query(sql, reason, limit=PAGE_SIZE, offset=page * PAGE_SIZE)
        out.extend(rows)
        if len(rows) < PAGE_SIZE:
            return out
    raise ReportError(
        f"{reason}: still returning full pages after {MAX_PAGES} "
        f"({len(out)} rows) — refusing to page forever"
    )


def workspace(command, user, scope="agent", json_file=None):
    """One psd-workspace (gws) call.

    Documents are created with --scope agent and shared explicitly; creating
    on the user slot is impersonation and is hard-blocked at the skill layer.
    """
    argv = ["node", WORKSPACE, "--user", user, "--scope", scope]
    if json_file:
        command = f"{command} --json-file {json_file}"
    argv += ["--command", command]
    return run_json(argv, f"workspace ({command.split(' --')[0]})")


# --- data steps ---------------------------------------------------------


def resolve_school(name):
    rows = query(
        "SELECT schoolid, school_name FROM schools "
        f"WHERE LOWER(school_name) LIKE LOWER('%{sql_escape(name)}%')",
        f"Resolve the school named {name} for a quartile growth report",
    )
    if not rows:
        raise ReportError(f"no school matched {name!r}")
    if len(rows) > 1:
        exact = [r for r in rows
                 if str(r.get("school_name", "")).lower() == name.lower()]
        if len(exact) != 1:
            names = ", ".join(str(r.get("school_name")) for r in rows[:6])
            raise ReportError(f"{name!r} matched {len(rows)} schools: {names}")
        rows = exact
    return rows[0]


def resolve_year(year):
    where = f"WHERE year_name = '{sql_escape(year)}'" if year else ""
    order = "" if year else "ORDER BY yearid DESC"
    rows = query(
        f"SELECT yearid, year_name FROM school_years {where} {order}".strip(),
        "Resolve the school year for a quartile growth report",
        limit=1,
    )
    if not rows:
        raise ReportError(f"no school year matched {year!r}")
    return rows[0]


def fetch_roster(schoolid, yearid):
    """Homeroom sections + lead teachers + the grades actually served.

    THE ROSTER DEFINES THE GRADE SPAN. On 2026-08-15 the agent announced
    "Minter Creek is a K-2 school", invented the justification, and scoped a
    whole report to it; Minter Creek is K-5. Nothing here may assert a span
    that was not queried.

    `role_name = 'Lead Teacher'` and never `priorityorder`, which is often
    null. An unresolvable teacher is labelled by build_tab, not dropped.
    """
    rows = query_all(
        "SELECT DISTINCT se.sectionid::text AS sectionid, "
        "  se.course_code, "
        "  sy.grade_level::text AS grade_level, "
        "  t.teacher_name "
        "FROM section_enrollments se "
        "JOIN school_year_enrollments sy "
        "  ON sy.studentid = se.studentid AND sy.yearid = se.yearid "
        "LEFT JOIN section_teachers st "
        "  ON st.sectionid = se.sectionid AND st.role_name = 'Lead Teacher' "
        "LEFT JOIN teachers t ON t.teacherid = st.teacherid "
        f"WHERE se.yearid = {int(yearid)} AND se.schoolid = {int(schoolid)} "
        "  AND se.course_code LIKE 'GR0%'",
        "Homeroom roster and lead teachers for a quartile growth report",
    )
    if not rows:
        raise ReportError(
            f"no GR0x homeroom sections for schoolid={schoolid} yearid={yearid}"
        )
    grades, teachers = {}, {}
    for row in rows:
        grade = str(row.get("grade_level") or "").strip()
        section = str(row.get("sectionid") or "").strip()
        if not grade or not section:
            continue
        grades.setdefault(grade, [])
        if section not in grades[grade]:
            grades[grade].append(section)
        name = row.get("teacher_name")
        if name:
            teachers[section] = str(name)
    return {"grades": grades, "teachers": teachers}


def extraction_sql(schoolid, yearid, grade, measures, baseline):
    """Raw matched pairs. No NTILE, no norms join, no GROUPING SETS.

    Window functions do not complete against dibels_scores on this MCP at any
    size — a bare NTILE(4) over ~1,100 rows timed out on 2026-08-15 while the
    same query without it ran in seconds. This is the only shape that runs,
    not a preference. Every non-text column is cast INSIDE the aggregate,
    because export/serialisation drops unqualified numerics.
    """
    measure_list = ", ".join(f"'{sql_escape(m)}'" for m in measures)
    return (
        "WITH stu AS ("
        "  SELECT assessment_group AS meas, studentid, \"window\", AVG(score) AS s"
        "  FROM dibels_scores"
        f"  WHERE yearid = {int(yearid)} AND grade_level = '{sql_escape(grade)}'"
        f"    AND assessment_group IN ({measure_list})"
        f"    AND \"window\" IN ('{sql_escape(baseline)}', 'Spring')"
        "  GROUP BY 1,2,3), "
        "m AS ("
        "  SELECT f.meas, f.studentid, f.s AS b, sp.s AS e"
        "  FROM stu f"
        "  JOIN stu sp ON sp.studentid = f.studentid AND sp.meas = f.meas"
        "    AND sp.\"window\" = 'Spring'"
        f"  WHERE f.\"window\" = '{sql_escape(baseline)}'), "
        "hr AS (SELECT DISTINCT ON (studentid) studentid, sectionid"
        "  FROM section_enrollments"
        f"  WHERE yearid = {int(yearid)} AND schoolid = {int(schoolid)}"
        "    AND course_code LIKE 'GR0%'"
        "  ORDER BY studentid, dateleft DESC), "
        "sch AS (SELECT DISTINCT studentid FROM school_year_enrollments"
        f"  WHERE yearid = {int(yearid)} AND schoolid = {int(schoolid)}"
        f"    AND grade_level = '{sql_escape(grade)}') "
        "SELECT m.meas, m.studentid::text AS studentid, m.b::text AS b, "
        "  m.e::text AS e, hr.sectionid::text AS sectionid, "
        "  (sch.studentid IS NOT NULL)::text AS in_sch "
        "FROM m LEFT JOIN hr USING (studentid) LEFT JOIN sch USING (studentid)"
    )


def discover_measures(yearid, grade):
    """Ask the warehouse which measures exist, never assume the spelling.

    The norms file uses UO's names (ORF-WRC, NWF-CLS); the warehouse may
    differ, and the join is on that string. A mismatch silently produces NULL
    percentiles, which read as "no growth" rather than "no norms".
    """
    rows = query(
        "SELECT DISTINCT assessment_group FROM dibels_scores "
        f"WHERE yearid = {int(yearid)} AND grade_level = '{sql_escape(grade)}'",
        f"List DIBELS measures present for grade {grade}",
    )
    return sorted(
        str(r.get("assessment_group")) for r in rows if r.get("assessment_group")
    )


def aggregate_rows(rows_path, grade, baseline, no_norms=False):
    argv = [
        PYTHON, str(HERE / "aggregate.py"),
        "--rows", str(rows_path),
        "--grade", str(grade),
        "--baseline", baseline,
        "--spring", "Spring",
    ]
    if no_norms:
        argv.append("--no-norms")
    return run_json(argv, f"aggregate.py (grade {grade})")


def build_values(records_path, school, grade, year, window, teachers):
    argv = [
        PYTHON, str(HERE / "build_tab.py"),
        "--rows", str(records_path),
        "--school", school,
        "--grade", str(grade),
        "--year", year,
        "--window", window,
        "--teachers", json.dumps(teachers),
        "--emit", "values",
    ]
    return run_json(argv, f"build_tab.py (grade {grade})")


# --- spreadsheet -------------------------------------------------------


def create_workbook(title, user):
    """Create the workbook on the AGENT slot, then hand it to the caller.

    Creating on the user slot is impersonation and hard-blocked at the skill
    layer. Ownership is transferred because Drive only lets an OWNER trash a
    file — without it the user cannot delete their own report and has to open
    a ticket (issue #1636).
    """
    created = workspace(
        "sheets spreadsheets create "
        f"--params '{json.dumps({'properties': {'title': title}})}'",
        user,
    )
    sheet_id = created.get("spreadsheetId") or (
        created.get("result") or {}).get("spreadsheetId")
    if not sheet_id:
        raise ReportError(f"spreadsheet create returned no id: {created}")
    return sheet_id


def share_workbook(sheet_id, user):
    params = {"fileId": sheet_id, "transferOwnership": "true"}
    body = {"type": "user", "role": "owner", "emailAddress": user}
    return workspace(
        f"drive permissions create --params '{json.dumps(params)}' "
        f"--body '{json.dumps(body)}'",
        user,
    )


def add_tab(sheet_id, title, user, work_dir):
    payload = work_dir / f"addsheet-{title}.json"
    payload.write_text(json.dumps(
        {"requests": [{"addSheet": {"properties": {"title": str(title)}}}]}))
    return workspace(
        "sheets spreadsheets batchUpdate "
        f"--params '{json.dumps({'spreadsheetId': sheet_id})}'",
        user, json_file=str(payload),
    )


def write_tab(sheet_id, body, user, work_dir, title):
    """Write one tab's values.

    build_tab.py already emits the exact `values batchUpdate` body, RAW, so
    nothing here reshapes it — that reshaping step is what the model used to
    hand-write, and where the literal-newline bug kept landing.
    """
    payload = work_dir / f"values-{title}.json"
    payload.write_text(json.dumps(body))
    return workspace(
        "sheets spreadsheets values batchUpdate "
        f"--params '{json.dumps({'spreadsheetId': sheet_id})}'",
        user, json_file=str(payload),
    )


def definitions_values():
    """The Definitions tab, from the shipped reference text."""
    path = HERE.parent / "references" / "definitions.md"
    lines = path.read_text().splitlines() if path.exists() else [
        "Definitions unavailable — references/definitions.md is missing.",
    ]
    return {
        "valueInputOption": "RAW",
        "data": [{"range": "Definitions!A1",
                  "values": [[line] for line in lines]}],
    }


# --- checkpointing ------------------------------------------------------


def step(work_dir, name, produce, log):
    """Run `produce` once, then reuse its output on later runs.

    Checkpointing is what makes a re-run cheap instead of a restart. The
    previous design had none, so every interruption threw away everything —
    which is what happened twice on 2026-08-16.
    """
    path = work_dir / f"{name}.json"
    if path.exists():
        try:
            log(f"  {name}: reusing checkpoint")
            return json.loads(path.read_text())
        except json.JSONDecodeError:
            # A half-written checkpoint from a killed run is not a checkpoint.
            log(f"  {name}: checkpoint was truncated, recomputing")
            path.unlink()
    value = produce()
    path.write_text(json.dumps(value, indent=1))
    return value


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build a full quartile growth report in one command.",
    )
    parser.add_argument("--school", required=True)
    parser.add_argument("--user", required=True, help="caller email for gws")
    parser.add_argument("--year", help='e.g. "2025-26"; default most recent')
    parser.add_argument("--grades", help="comma list; default the roster's own")
    parser.add_argument("--work-dir", help="checkpoints; default /tmp/qgr-<school>")
    parser.add_argument("--dry-run", action="store_true",
                        help="resolve and plan only; touch no spreadsheet")
    parser.add_argument("--plan-only", action="store_true",
                        help="alias for --dry-run")
    args = parser.parse_args()
    dry_run = args.dry_run or args.plan_only

    def log(message):
        # stderr, so stdout stays the machine-readable result.
        print(message, file=sys.stderr, flush=True)

    slug = re.sub(r"[^a-z0-9]+", "-", args.school.lower()).strip("-")
    work_dir = pathlib.Path(args.work_dir or f"/tmp/qgr-{slug}")
    work_dir.mkdir(parents=True, exist_ok=True)
    log(f"work dir: {work_dir}")

    try:
        school = step(work_dir, "school",
                      lambda: resolve_school(args.school), log)
        year = step(work_dir, "year", lambda: resolve_year(args.year), log)
        schoolid, yearid = school["schoolid"], year["yearid"]
        log(f"  {school['school_name']} ({schoolid}), {year['year_name']} ({yearid})")

        roster = step(work_dir, "roster",
                      lambda: fetch_roster(schoolid, yearid), log)
        served = sorted(roster["grades"], key=lambda g: (g != "K", g))
        grades = [g.strip() for g in args.grades.split(",")] if args.grades else served
        unknown = [g for g in grades if g not in roster["grades"]]
        if unknown:
            raise ReportError(
                f"grade(s) {unknown} are not in this school's roster "
                f"(served: {served})"
            )
        log(f"  grades served: {', '.join(served)}")

        if dry_run:
            print(json.dumps({
                "school": school, "year": year,
                "grades_served": served, "grades_planned": grades,
                "sections": {g: roster["grades"][g] for g in grades},
                "work_dir": str(work_dir),
            }, indent=1))
            return 0

        title = (f"{school['school_name']} - Quartile Growth Report "
                 f"({year['year_name']})")
        sheet_id = step(work_dir, "sheet",
                        lambda: {"id": create_workbook(title, args.user)},
                        log)["id"]
        url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/edit"
        log(f"  workbook: {url}")

        for grade in grades:
            done_marker = f"grade-{grade}-written"
            if (work_dir / f"{done_marker}.json").exists():
                log(f"grade {grade}: already written")
                continue
            log(f"grade {grade}: extracting")
            baseline = BASELINE_BY_GRADE.get(grade, "Fall")
            measures = step(work_dir, f"grade-{grade}-measures",
                            lambda g=grade: discover_measures(yearid, g), log)
            if not measures:
                log(f"grade {grade}: no DIBELS measures present — skipping")
                step(work_dir, done_marker, lambda: {"skipped": "no measures"}, log)
                continue

            rows = step(
                work_dir, f"grade-{grade}-rows",
                lambda g=grade, b=baseline, m=measures: query_all(
                    extraction_sql(schoolid, yearid, g, m, b),
                    f"Matched {b}/Spring pairs for grade {g}"),
                log)
            if not rows:
                log(f"grade {grade}: no matched pairs — skipping")
                step(work_dir, done_marker, lambda: {"skipped": "no rows"}, log)
                continue
            log(f"grade {grade}: {len(rows)} matched rows")

            rows_path = work_dir / f"grade-{grade}-rows.json"
            records = step(
                work_dir, f"grade-{grade}-agg",
                lambda g=grade, b=baseline: aggregate_rows(rows_path, g, b),
                log)
            records_path = work_dir / f"grade-{grade}-agg.json"

            window = f"{baseline}→Spring"
            body = step(
                work_dir, f"grade-{grade}-values",
                lambda g=grade, w=window: build_values(
                    records_path, school["school_name"], g,
                    year["year_name"], w, roster["teachers"]),
                log)

            add_tab(sheet_id, grade, args.user, work_dir)
            write_tab(sheet_id, body, args.user, work_dir, grade)
            step(work_dir, done_marker, lambda: {"rows": len(rows)}, log)
            log(f"grade {grade}: written")

        if not (work_dir / "definitions-written.json").exists():
            add_tab(sheet_id, "Definitions", args.user, work_dir)
            write_tab(sheet_id, definitions_values(), args.user,
                      work_dir, "Definitions")
            step(work_dir, "definitions-written", lambda: {"ok": True}, log)

        step(work_dir, "shared",
             lambda: {"result": share_workbook(sheet_id, args.user)}, log)
        log("done")
        print(url)
        return 0
    except ReportError as exc:
        log(f"FAILED: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
