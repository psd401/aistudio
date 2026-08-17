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
                  [--year 2025-2026] [--grades K,1,2,3,4,5]
                  [--work-dir DIR] [--dry-run] [--plan-only]

Re-running with the same --work-dir skips work already done.
"""

import argparse
import datetime
import json
import pathlib
import re
import subprocess
import sys
import traceback

HERE = pathlib.Path(__file__).resolve().parent
PSD_DATA = "/opt/psd-skills/psd-data/run.js"
WORKSPACE = "/opt/psd-skills/psd-workspace/run.js"
PYTHON = sys.executable or "/opt/agentcore-venv/bin/python3"

# psd-data rate-limits at 60 req/min/user, so pages are deliberately large:
# a whole grade should be one or two calls, not twenty.
PAGE_SIZE = 5000
# Sized for the WORST case, not the requested one. If psd-data really caps at
# 30 rows per call, 40 pages is 1,200 rows — and this file's own docstring
# cites a real extraction of 1,706 matched grade-1 pairs. Now that paging
# correctly continues past a short page, too low a ceiling turns a silent
# truncation into a hard failure on every real school, which is better but
# still a broken report.
#
# 1,000 pages covers ~30,000 rows at a 30-row cap and one page at 5,000. The
# guard still exists to stop an infinite loop; it is not a size limit.
MAX_PAGES = 1000

# Grades in report order. K sorts first and is stored as "K", not 0.
DEFAULT_GRADES = ["K", "1", "2", "3", "4", "5"]

# Baselines are PER MEASURE, not per grade. SKILL.md's Windows table gives two
# exceptions and they are different shapes: K DIBELS has no Fall administration
# at all, while in grade 1 only ORF starts mid-year — every other grade-1
# measure has Fall data.
#
# Modelling this per grade looked simpler and silently dropped data: one
# baseline applied to a whole grade means the matched-pair join returns ZERO
# rows for any measure that lacks that window, so grade 1 ORF would vanish
# from the tab with no error and nothing to notice on a re-run. Review caught
# it. A measure missing from a report is worse than a report that fails.
BASELINE_DEFAULT = "Fall"
BASELINE_BY_GRADE = {"K": "Winter"}
BASELINE_BY_GRADE_MEASURE = {("1", "ORF"): "Winter"}


# The warehouse and the bundled norms file spell DIBELS measures differently,
# and aggregate.py joins on that string. Unmapped, it aborts the whole run:
#   "no norms at grade '1' for any requested measure (ORF Accuracy, ORF Errors,
#    ORF WC); the norms file has ... ORF-ACC ... ORF-WRC"
#
# That killed every grade with an ORF measure, which is grades 1-5 — i.e. the
# report. Matched case-insensitively on the warehouse spelling; an unmapped
# name is passed through unchanged so a NEW measure fails loudly in
# aggregate.py rather than being silently dropped here.
NORMS_NAME_BY_WAREHOUSE = {
    "orf accuracy": "ORF-ACC",
    "orf errors": "ORF-WRC",
    "orf wc": "ORF-WRC",
    "nwf cls": "NWF-CLS",
    "nwf wrc": "NWF-WRC",
    # Grade 5's warehouse name. Unmapped, aggregate.py aborts the whole grade-5
    # DIBELS block, and because the failure came out of a truncated result page
    # it read as "no measures" rather than "unmapped name".
    "maze adjusted score": "MAZE",
    "maze": "MAZE",
}

# Measures with no national norms at all. Passed with --no-norms rather than
# mapped, because inventing a percentile for them would misstate how a child
# scored against national peers in a document a principal reads as fact.
# Only measures with NO national norms at all. "orf errors" was in here and
# should not have been: NORMS_NAME_BY_WAREHOUSE already aliases it to ORF-WRC,
# which has real rows in the norms CSV. Once split_by_norms was wired in, that
# entry would have stripped norms from a measure that scores correctly today —
# the fix quietly breaking something that worked.
MEASURES_WITHOUT_NORMS = {"composite"}


def aggregate_group(work_dir, tag, grade, baseline, group, log):
    """Aggregate one baseline group, in two passes when norms differ.

    aggregate.py's --no-norms is per RUN, not per measure, and a measure with
    no national norms (Composite) aborts the whole call when the others need
    them. So the group is split and aggregated twice over the SAME extracted
    rows — never two extractions.

    A function rather than inline code so a test can prove the pipeline
    actually does this. The first version of split_by_norms was defined,
    unit-tested and never called from the report at all; review caught it, and
    the tests passed either way because none of them touched the call site.
    """
    records = []
    with_norms, without_norms = split_by_norms(group)
    for measures, skip_norms in ((with_norms, False), (without_norms, True)):
        if not measures:
            continue
        suffix = "nonorms" if skip_norms else "norms"
        records.extend(step(
            work_dir, f"{tag}-agg-{suffix}",
            lambda m=measures, sk=skip_norms: aggregate_rows(
                work_dir / f"{tag}-rows.json", grade, baseline,
                subgroups=SUBGROUPS, measures=m, no_norms=sk),
            log))
    return records


def split_by_norms(measures):
    """(with_norms, without_norms) for one grade's measure list."""
    with_norms, without = [], []
    for measure in measures:
        key = str(measure).strip().lower()
        (without if key in MEASURES_WITHOUT_NORMS else with_norms).append(measure)
    return with_norms, without


def measure_as_args(measures):
    """--measure-as WAREHOUSE=NORMS for every measure that needs mapping."""
    args = []
    for measure in measures:
        norms = NORMS_NAME_BY_WAREHOUSE.get(str(measure).strip().lower())
        if norms and norms != measure:
            args.append(f"{measure}={norms}")
    return args


def baseline_for(grade, measure):
    """The baseline window for one measure in one grade.

    Matched on an ORF prefix rather than an exact name because the warehouse's
    spelling is not guaranteed to be the norms file's — that mismatch is why
    every measure name is discovered rather than assumed.
    """
    grade = str(grade)
    for (g, prefix), window in BASELINE_BY_GRADE_MEASURE.items():
        if g == grade and str(measure).upper().startswith(prefix):
            return window
    return BASELINE_BY_GRADE.get(grade, BASELINE_DEFAULT)


def group_by_baseline(grade, measures):
    """{baseline: [measure, ...]} — one extraction pass per distinct window."""
    groups = {}
    for measure in measures:
        groups.setdefault(baseline_for(grade, measure), []).append(measure)
    return groups


class ReportError(RuntimeError):
    """A failure worth stopping the whole report for."""


def sql_escape(value):
    """Single-quote escaping for an inlined literal.

    The MCP takes SQL text, so a school name with an apostrophe would break
    the statement. School and year names are the only caller-supplied values
    that reach SQL here, and psd-data rejects anything that is not a SELECT.
    """
    return str(value).replace("'", "''")


# psd-workspace's splitCommand has NO escape syntax: a quote inside a
# same-quoted token ends the token. Its own source says so, from a live 2026-07-06
# failure — "any content with an apostrophe, mixed quotes, or newlines cannot
# ride inside --command at all". Payloads dodge this with --json-file, whose
# content becomes exactly one argv token, but `--params` has no file form, so
# whatever goes there must be quote-free by construction.
#
# The typographic apostrophe is not a quote character to the tokenizer and is
# what a title would use in print anyway, so a school like "O'Brien Elementary"
# keeps a correct-looking name instead of a broken command.
SAFE_APOSTROPHE = "\u2019"


def command_literal(value):
    """Make a value safe to splice into a --command string."""
    text = str(value).replace("'", SAFE_APOSTROPHE).replace('"', SAFE_APOSTROPHE)
    return " ".join(text.split())


def safe_path(path):
    """A filesystem path fit to splice into a --command string."""
    text = str(path)
    if any(ch.isspace() for ch in text) or "'" in text or '"' in text:
        raise ReportError(
            "work dir path must contain no spaces or quotes — splitCommand "
            f"would split it into separate tokens and lose the payload: {text}"
        )
    return text


def assert_command_safe(command):
    """Fail loudly if an unquotable character reached the command string.

    A late failure in the share step, after every grade has been extracted and
    written, is exactly what this script exists to prevent — so this refuses
    before the call rather than after.
    """
    payload = command.split("--params", 1)[-1]
    if "'" in payload.replace("'{", "").replace("}'", ""):
        raise ReportError(
            f"unquotable character in a workspace command: {command[:200]}"
        )
    return command


def run_json(argv, what, timeout=900):
    """Run a command and parse its stdout as JSON.

    Errors carry the command's own stderr. A report that dies on step 4 of 30
    is only debuggable if the failure says which step and what the tool said.
    """
    try:
        done = subprocess.run(
            argv, capture_output=True, text=True, timeout=timeout
        )
    except subprocess.TimeoutExpired:
        # Now that this runs outside the turn deadline, nothing else would
        # ever stop a hung call — and a hang leaves no checkpoint, so the
        # re-run would hang in the same place.
        raise ReportError(f"{what} timed out after {timeout}s")
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
    return parse_mcp_rows(payload, reason)


def parse_mcp_rows(payload, reason):
    """Rows out of psd-data's MCP envelope.

    run.js writes `JSON.stringify(response.result)` — the raw tools/call
    result, shaped {"content": [{"type": "text", "text": "<markdown table>"}],
    "isError": false}. There is no top-level "rows" key.

    This read `payload.get("rows")`, so EVERY query returned [] — school
    resolution, roster, every extraction — while real data sat behind it
    (1,706 matched grade-1 pairs existed while the script reported "no Fall
    matched pairs"). Combined with the empty-result path being a soft "no
    data", it produced a workbook with a tab per grade and nothing in them.

    An `isError` envelope is raised, not parsed: a query that failed must not
    read as a query that found nothing. That conflation is what let four other
    bugs hide behind this one.
    """
    if not isinstance(payload, dict):
        return payload or []
    if payload.get("isError"):
        raise ReportError(f"{reason}: psd-data returned an error: "
                          f"{_mcp_text(payload)[:400]}")
    if isinstance(payload.get("rows"), list):
        return payload["rows"]          # a future structured mode
    return parse_result_text(_mcp_text(payload))


def parse_result_text(text):
    """Rows out of the MCP's text block, whatever shape it is in.

    The one recorded fixture in this repo (psd-data/evals/fixtures/
    list-tables.json) has JSON inside `text`:

        "text": "{\"tables\":[\"EVAL_1426_ATTENDANCE\"]}"

    The #1679 report says query_data returns a markdown table there instead.
    I have no recorded query_data response either way, so this reads BOTH
    rather than betting on one — the previous version bet on markdown alone,
    and if the real shape is JSON it would have returned [] exactly like the
    bug it was written to fix.

    JSON is tried first because it is unambiguous; markdown is the fallback.
    """
    text = (text or "").strip()
    if not text:
        return []
    if text[0] in "[{":
        try:
            return rows_from_json(json.loads(text))
        except (json.JSONDecodeError, ValueError):
            pass
    return parse_markdown_table(text)


def rows_from_json(value):
    """A decoded JSON payload down to a list of row dicts."""
    if isinstance(value, list):
        return [v for v in value if isinstance(v, dict)]
    if not isinstance(value, dict):
        return []
    for key in ("rows", "records", "data", "results"):
        inner = value.get(key)
        if isinstance(inner, list):
            # {"columns": [...], "rows": [[...], ...]} — pair them up.
            columns = value.get("columns")
            if (inner and isinstance(inner[0], list)
                    and isinstance(columns, list)):
                return [dict(zip(columns, row)) for row in inner
                        if isinstance(row, list)]
            return [v for v in inner if isinstance(v, dict)]
    # A single object that is itself the row.
    return [value] if value else []


def _mcp_text(payload):
    parts = []
    for block in payload.get("content") or []:
        if isinstance(block, dict) and isinstance(block.get("text"), str):
            parts.append(block["text"])
    return "\n".join(parts)


def parse_markdown_table(text):
    """`| a | b |` blocks into dicts. Empty result sets return [].

    Deliberately strict about the separator row: a markdown table without one
    is prose, and guessing at prose is how a "no rows" message becomes a fake
    data row.
    """
    lines = [ln.strip() for ln in (text or "").splitlines() if ln.strip()]
    table = [ln for ln in lines if ln.startswith("|")]
    if len(table) < 2:
        return []

    def cells(line):
        return [c.strip() for c in line.strip().strip("|").split("|")]

    header = cells(table[0])
    separator = cells(table[1])
    if not all(set(c) <= set("-: ") and c for c in separator):
        return []
    rows = []
    for line in table[2:]:
        values = cells(line)
        if len(values) != len(header):
            continue
        rows.append({
            key: (None if value in ("", "NULL", "null") else value)
            for key, value in zip(header, values)
        })
    return rows


def query_all(sql, reason, expected=None):
    """Page a SELECT to completion.

    STOPS ON AN EMPTY PAGE, NOT A SHORT ONE. psd-data is documented as
    returning at most 30 rows per call (SKILL.md's pitfalls list). Asking for
    5,000 and stopping when fewer come back would have ended after the FIRST
    page — every extraction silently truncated to 30 students, and quartiles
    computed over them would look entirely plausible and be wrong.

    I could not verify that cap from outside the warehouse, which is exactly
    why the loop no longer depends on knowing it: a short page proves nothing,
    an empty one proves the end.
    """
    out = []
    for page in range(MAX_PAGES):
        rows = query(sql, reason, limit=PAGE_SIZE, offset=len(out))
        if not rows:
            break
        out.extend(rows)
        # If the warehouse caps pages at 30 and rate-limits at 60/min, a large
        # grade is minutes of paging with nothing on stdout. Say so, so a slow
        # run is visibly working rather than apparently hung — the promoted
        # job has a two-hour budget and no way to ask.
        if page and page % 25 == 0:
            logger_line = (f"  {reason}: {len(out)} rows after "
                           f"{page + 1} pages")
            print(logger_line, file=sys.stderr, flush=True)
    else:
        raise ReportError(
            f"{reason}: still returning rows after {MAX_PAGES} pages "
            f"({len(out)}) — refusing to page forever"
        )
    if expected is not None and len(out) != expected:
        # A count that disagrees with what paging returned means the result
        # was capped or the offsets skipped. Loud, because the alternative is
        # a report whose every number is computed over a fraction of the
        # cohort and looks fine.
        raise ReportError(
            f"{reason}: expected {expected} rows, paged {len(out)}. "
            "The result set is being truncated; the numbers would be wrong."
        )
    return out


def extract_verified(sql, reason):
    """Page an extraction and prove nothing was dropped.

    The count is the whole point: paging that silently returns a subset yields
    quartiles over a fraction of the cohort that look entirely plausible. A
    COUNT(*) costs one call and turns that into a loud failure.

    A count the warehouse will not give (null, unparseable) is not treated as
    a mismatch — that would fail reports over a diagnostic. It is logged as
    unverified instead.
    """
    expected = count_rows(sql, f"Row count for {reason}")
    return query_all(sql, reason, expected=expected)


def count_rows(sql, reason):
    """COUNT(*) over a SELECT, so truncation cannot pass unnoticed."""
    rows = query(f"SELECT COUNT(*) AS n FROM ({sql}) AS counted", reason,
                 limit=1)
    if not rows:
        return None
    value = (rows[0] or {}).get("n")
    try:
        return int(str(value).replace(",", ""))
    except (TypeError, ValueError):
        return None


def workspace(command, user, scope="agent", json_file=None):
    """One psd-workspace (gws) call.

    Documents are created with --scope agent and shared explicitly; creating
    on the user slot is impersonation and is hard-blocked at the skill layer.
    """
    argv = ["node", WORKSPACE, "--user", user, "--scope", scope]
    if json_file:
        # The path is spliced into --command like everything else, and
        # splitCommand tokenizes on whitespace with no escape syntax — so a
        # path containing a space or a quote silently becomes two tokens and
        # the payload is lost. Ours are derived from a slugged school name and
        # are safe, but --work-dir is caller-supplied. Refuse loudly here
        # rather than produce a workbook missing a tab.
        command = f"{command} --json-file {safe_path(json_file)}"
    argv += ["--command", assert_command_safe(command)]
    return run_json(argv, f"workspace ({command.split(' --')[0]})")


# --- data steps ---------------------------------------------------------


def like_escape(value):
    """Neutralise LIKE wildcards in a caller-supplied name.

    `sql_escape` stops the quote from breaking the literal, but inside a LIKE
    a bare `%` or `_` is still a pattern: "Harbor_" would match "Harbor Ridge"
    and "Harbor Heights" and land in the ambiguous-match branch, while a lone
    "%" matches every school in the district. Escaped with a backslash and
    declared via ESCAPE so the characters match themselves.
    """
    out = str(value).replace("\\", "\\\\")
    return out.replace("%", "\\%").replace("_", "\\_")


def resolve_school(name):
    rows = query(
        # Live schema: schools(id, abbreviation, name, level). There is no
        # schoolid/school_name. Aliased rather than renamed downstream, so the
        # rest of the script keeps one vocabulary.
        "SELECT id AS schoolid, name AS school_name FROM schools "
        "WHERE LOWER(name) LIKE LOWER("
        f"'%{sql_escape(like_escape(name))}%') ESCAPE '\\'",
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
    """The year to report on.

    DEFAULTS TO THE MOST RECENT year that has actually STARTED, not the most
    recent row. On 2026-08-17 `ORDER BY id DESC` picked 2026-27 — a year that
    had not begun, had no roster, and produced an empty report before the user
    noticed and asked for the completed year by hand.

    A growth report needs a baseline AND an ending window, so a year that has
    not started cannot produce one. first_day is the honest test.

    The name is matched leniently because the warehouse spells it "2025-2026"
    while this skill's own usage line said "2025-26" — the user hit that too,
    and being strict about a format we documented wrong is our error to
    absorb, not theirs to work around.
    """
    if year:
        wanted = str(year).strip()
        rows = query(
            "SELECT id AS yearid, name AS year_name FROM school_years",
            "List school years for a quartile growth report",
        )
        for row in rows:
            if str(row.get("year_name", "")).strip() == wanted:
                return row
        loose = _loose_year(wanted)
        for row in rows:
            if _loose_year(row.get("year_name")) == loose:
                return row
        names = ", ".join(str(r.get("year_name")) for r in rows[:8])
        raise ReportError(
            f"no school year matched {year!r}. The warehouse has: {names}"
        )

    rows = query(
        "SELECT id AS yearid, name AS year_name, first_day "
        "FROM school_years ORDER BY id DESC",
        "Resolve the most recent completed school year",
    )
    today = datetime.date.today().isoformat()
    for row in rows:
        first_day = str(row.get("first_day") or "")[:10]
        if first_day and first_day <= today:
            return row
    if rows:
        # No first_day recorded anywhere, so "has it started" cannot be
        # answered. Refuse and ask for --year rather than guess: picking the
        # newest row unverified is what produced the empty 2026-27 report.
        raise ReportError(
            "no school year has a first_day on or before today; pass --year "
            f"explicitly. Newest is {rows[0].get('year_name')!r}"
        )
    raise ReportError("no school years found")


def _loose_year(name):
    """"2025-26", "2025-2026" and "2025/26" compare equal."""
    digits = re.findall(r"\d+", str(name or ""))
    if not digits:
        return str(name or "").strip().lower()
    start = digits[0]
    end = digits[1] if len(digits) > 1 else ""
    return f"{start}-{end[-2:]}" if end else start


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
        # Live schema: teachers has no teacher_name — only first_name /
        # last_name — and its PK is `id`, not `teacherid`.
        "  (t.first_name || ' ' || t.last_name) AS teacher_name "
        "FROM section_enrollments se "
        "JOIN school_year_enrollments sy "
        "  ON sy.studentid = se.studentid AND sy.yearid = se.yearid "
        "LEFT JOIN section_teachers st "
        "  ON st.sectionid = se.sectionid AND st.role_name = 'Lead Teacher' "
        "LEFT JOIN teachers t ON t.id = st.teacherid "
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
        "  (sch.studentid IS NOT NULL)::text AS in_sch, "
        "  f.frl::text AS low_income, "
        "  sp.special_education::text AS special_ed "
        "FROM m LEFT JOIN hr USING (studentid) LEFT JOIN sch USING (studentid) "
        # DISTRICT-WIDE, never scoped to the school. On 2026-08-15 every grade
        # reported School and District identically — grade K showed 18/18
        # against a district cohort of 558 — because only this school's
        # students carried a flag, so the district cell WAS the school cell and
        # its complement absorbed 540 unflagged students. Every number looked
        # plausible.
        # NOT year-scoped: students_frl(studentid, frl) and
        # students_specialed(studentid, special_education, iep, s504, ...)
        # have no yearid at all. The predicate errored the WHOLE extraction
        # for every grade, and because a failed query read as an empty one,
        # the report came out with a tab per grade and no data in any of
        # them — the exact "looks complete, isn't" outcome this script was
        # written to prevent.
        "LEFT JOIN students_frl f ON f.studentid = m.studentid "
        "LEFT JOIN students_specialed sp ON sp.studentid = m.studentid"
    )


SUBGROUPS = (
    "low_income=Low Income|Non-Low Income",
    "special_ed=Special Ed|Non-Special Ed",
)


def sba_sql(schoolid, yearid, grade):
    """SBA scale growth vs the prior-year summative, quartiled on that prior score.

    smarter_balanced_scores mixes IAB/FIAB participation rows (score = 1) with
    summatives, so the two filters are mandatory — unfiltered averages are
    garbage (SKILL.md, psd-data pitfalls).
    """
    prior_grade = str(int(grade) - 1)
    return (
        "WITH cur AS ("
        "  SELECT studentid, assessment_group AS meas, AVG(score) AS e,"
        "         AVG(CASE WHEN met_standard THEN 100.0 ELSE 0.0 END) AS metv"
        "  FROM smarter_balanced_scores"
        f"  WHERE yearid = {int(yearid)} AND grade_level = '{sql_escape(grade)}'"
        "    AND assessment_group LIKE 'Summative%' AND is_strand = false"
        "  GROUP BY 1,2), "
        "prior AS ("
        "  SELECT studentid, assessment_group AS meas, AVG(score) AS b"
        "  FROM smarter_balanced_scores"
        f"  WHERE yearid = {int(yearid) - 1}"
        f"    AND grade_level = '{sql_escape(prior_grade)}'"
        "    AND assessment_group LIKE 'Summative%' AND is_strand = false"
        "  GROUP BY 1,2), "
        "hr AS (SELECT DISTINCT ON (studentid) studentid, sectionid"
        "  FROM section_enrollments"
        f"  WHERE yearid = {int(yearid)} AND schoolid = {int(schoolid)}"
        "    AND course_code LIKE 'GR0%'"
        "  ORDER BY studentid, dateleft DESC), "
        "sch AS (SELECT DISTINCT studentid FROM school_year_enrollments"
        f"  WHERE yearid = {int(yearid)} AND schoolid = {int(schoolid)}"
        f"    AND grade_level = '{sql_escape(grade)}') "
        "SELECT ('SBA ' || cur.meas) AS meas, cur.studentid::text AS studentid, "
        "  prior.b::text AS b, cur.e::text AS e, cur.metv::text AS met_pct, "
        "  hr.sectionid::text AS sectionid, "
        "  (sch.studentid IS NOT NULL)::text AS in_sch "
        "FROM cur JOIN prior USING (studentid, meas) "
        "LEFT JOIN hr USING (studentid) LEFT JOIN sch USING (studentid)"
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


def aggregate_rows(rows_path, grade, baseline, no_norms=False, subgroups=(),
                   measures=()):
    argv = [
        PYTHON, str(HERE / "aggregate.py"),
        "--rows", str(rows_path),
        "--grade", str(grade),
        "--baseline", baseline,
        "--spring", "Spring",
    ]
    if no_norms:
        argv.append("--no-norms")
    for spec in subgroups or ():
        argv += ["--subgroup", spec]
    for spec in measure_as_args(measures or ()):
        argv += ["--measure-as", spec]
    return run_json(argv, f"aggregate.py (grade {grade})")


def build_values(records_path, school, grade, year, window, teachers, gaps=()):
    argv = [
        PYTHON, str(HERE / "build_tab.py"),
        "--rows", str(records_path),
        "--school", school,
        "--grade", str(grade),
        "--year", year,
        "--window", window,
        "--teachers", json.dumps(teachers),
        "--gaps", json.dumps(list(gaps)),
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
        # --params is path/query parameters; the resource is the request
        # BODY. Sending it as a param returns HTTP 400 "Unknown name
        # 'properties': Cannot bind query parameter."
        "sheets spreadsheets create "
        f"--json '{json.dumps({'properties': {'title': command_literal(title)}})}'",
        user,
    )
    sheet_id = created.get("spreadsheetId") or (
        created.get("result") or {}).get("spreadsheetId")
    if not sheet_id:
        raise ReportError(f"spreadsheet create returned no id: {created}")
    return sheet_id


def share_workbook(sheet_id, user):
    # Sanitised like the title. An address is unlikely to carry a quote, but
    # this is the same tokenizer with the same lack of an escape syntax, and
    # the failure would land on the LAST step of a finished report — the
    # costliest place for it. Consistency here is cheaper than reasoning about
    # which values are safe.
    # psd-workspace has no --body flag (only --params/--json/--json-file),
    # and transferOwnership is a JSON boolean, not the string "true".
    params = {"fileId": command_literal(sheet_id), "transferOwnership": True}
    body = {"type": "user", "role": "owner",
            "emailAddress": command_literal(user)}
    return workspace(
        f"drive permissions create --params '{json.dumps(params)}' "
        f"--json '{json.dumps(body)}'",
        user,
    )


def add_tab(sheet_id, title, user, work_dir, log=lambda m: None):
    """Create one tab, ONCE.

    Checkpointed like every other side effect. Without it, a failure between
    the tab creation and the grade's done-marker leaves the tab present and
    the marker absent, so the re-run tries to add it again, Sheets rejects the
    duplicate, and the report is permanently stuck — a re-run that cannot
    succeed is worse than no checkpointing at all. Review caught this; it is
    exactly the failure class this script exists to remove.
    """
    added = step(work_dir, f"tab-{title}-added",
                 lambda: {"result": _add_tab(sheet_id, title, user, work_dir)},
                 log)
    # Only safe once a real tab exists: a spreadsheet must keep at least one.
    drop_default_tab(sheet_id, user, work_dir, log)
    return added


DEFAULT_SHEET_ID = 0


def drop_default_tab(sheet_id, user, work_dir, log=lambda m: None):
    """Remove the empty tab the Sheets API creates with every spreadsheet.

    `spreadsheets.create` is called with only `properties`, so Sheets adds its
    own first sheet ("Sheet1", sheetId 0). Grade tabs are appended after it,
    which leaves the blank one LEFTMOST — the first thing a principal sees on
    opening the link, in a report whose whole point is not shipping something
    that looks complete and isn't.

    Checkpointed, so it runs once no matter how many tabs are added or how
    often the script resumes. Deliberately NON-fatal: a leftover blank tab is
    cosmetic, and failing a run that otherwise produced every number would be
    the worse outcome by far.
    """
    marker = work_dir / "default-tab-dropped.json"
    if marker.exists():
        return
    try:
        _delete_sheet(sheet_id, DEFAULT_SHEET_ID, user, work_dir)
    except Exception as exc:  # noqa: BLE001 - non-fatal by design
        # Already gone, renamed by hand, or the payload file would not write —
        # every one of those is survivable. Catching only ReportError here
        # contradicted the docstring above: an OSError writing the request
        # would have propagated and killed a run whose numbers were all in.
        log(f"note: could not remove the default tab ({exc}); continuing")
    marker.write_text(json.dumps({"sheetId": DEFAULT_SHEET_ID}))


def _delete_sheet(sheet_id, tab_id, user, work_dir):
    payload = work_dir / f"deletesheet-{tab_id}.json"
    payload.write_text(json.dumps(
        {"requests": [{"deleteSheet": {"sheetId": tab_id}}]}))
    return workspace(
        "sheets spreadsheets batchUpdate "
        f"--params '{json.dumps({'spreadsheetId': command_literal(sheet_id)})}'",
        user, json_file=str(payload),
    )


def _add_tab(sheet_id, title, user, work_dir):
    payload = work_dir / f"addsheet-{title}.json"
    payload.write_text(json.dumps(
        {"requests": [{"addSheet": {"properties": {"title": str(title)}}}]}))
    # The title rides in the FILE here, not the command, so it needs no
    # sanitising — only the params below are spliced.
    return workspace(
        "sheets spreadsheets batchUpdate "
        f"--params '{json.dumps({'spreadsheetId': command_literal(sheet_id)})}'",
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
        f"--params '{json.dumps({'spreadsheetId': command_literal(sheet_id)})}'",
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


def discover_table(candidates, yearid):
    """Return the first candidate table that answers, or None.

    i-Ready's table name is not written down anywhere in this skill, unlike
    smarter_balanced_scores and students_frl. Rather than guess one and have
    the block vanish, ask — and if none answers, the caller records a VISIBLE
    gap instead of an absence.
    """
    for table in candidates:
        try:
            query(f"SELECT 1 FROM {table} WHERE yearid = {int(yearid)}",
                  f"Confirm {table} exists for the report", limit=1)
            return table
        except ReportError:
            continue
    return None


# One table PER SUBJECT, discovered on 2026-08-17 by asking the warehouse
# instead of guessing. The three names this used to probe —
# iready_scores, i_ready_scores, iready_diagnostic_scores — do not exist, so
# i-Ready reported itself as "table not found" on every run while the data sat
# there under a different name.
#
# Guessing table names was the mistake. These are recorded, and an unknown one
# still degrades to a stated gap rather than a silent omission.
IREADY_TABLES_BY_SUBJECT = {
    "Reading": "iready_reading_diagnostics",
    "Math": "iready_math_diagnostics",
}


def iready_sql(schoolid, yearid, grade, table, subject):
    """i-Ready percentile change for ONE subject table.

    Percentile is already national, so no norms lookup — this always runs
    --no-norms.
    """
    return (
        "WITH stu AS ("
        f"  SELECT '{sql_escape(subject)}' AS meas, studentid, \"window\","
        "         AVG(percentile) AS s"
        f"  FROM {table}"
        f"  WHERE yearid = {int(yearid)} AND grade_level = '{sql_escape(grade)}'"
        "    AND \"window\" IN ('Fall', 'Spring')"
        "  GROUP BY 1,2,3), "
        "m AS ("
        "  SELECT f.meas, f.studentid, f.s AS b, sp.s AS e"
        "  FROM stu f"
        "  JOIN stu sp ON sp.studentid = f.studentid AND sp.meas = f.meas"
        "    AND sp.\"window\" = 'Spring'"
        "  WHERE f.\"window\" = 'Fall'), "
        "hr AS (SELECT DISTINCT ON (studentid) studentid, sectionid"
        "  FROM section_enrollments"
        f"  WHERE yearid = {int(yearid)} AND schoolid = {int(schoolid)}"
        "    AND course_code LIKE 'GR0%'"
        "  ORDER BY studentid, dateleft DESC), "
        "sch AS (SELECT DISTINCT studentid FROM school_year_enrollments"
        f"  WHERE yearid = {int(yearid)} AND schoolid = {int(schoolid)}"
        f"    AND grade_level = '{sql_escape(grade)}') "
        "SELECT ('i-Ready ' || m.meas) AS meas, m.studentid::text AS studentid, "
        "  m.b::text AS b, m.e::text AS e, hr.sectionid::text AS sectionid, "
        "  (sch.studentid IS NOT NULL)::text AS in_sch "
        "FROM m LEFT JOIN hr USING (studentid) LEFT JOIN sch USING (studentid)"
    )


def run_block(work_dir, tag, grade, build_sql, reason, log, gaps,
              label, no_norms=False, subgroups=()):
    """Extract + aggregate one measure family, recording a GAP if it fails.

    A block that returns nothing, errors, or has no table must show up in the
    workbook — not only in a log the principal never reads. Silently omitting
    SBA or i-Ready produces a report that looks complete and is not, which is
    the exact failure this whole redesign exists to end.
    """
    try:
        rows = step(work_dir, f"{tag}-rows",
                    lambda: query_all(build_sql(), reason), log)
    except ReportError as exc:
        log(f"  {label}: FAILED — {exc}")
        gaps.append(f"{label}: not included (query failed: {str(exc)[:160]})")
        return []
    if not rows:
        log(f"  {label}: no matched rows")
        gaps.append(f"{label}: not included (no matched students)")
        return []
    log(f"  {label}: {len(rows)} rows")
    return step(work_dir, f"{tag}-agg",
                lambda: aggregate_rows(work_dir / f"{tag}-rows.json", grade,
                                       "Fall", no_norms=no_norms,
                                       subgroups=subgroups), log)


# --- checkpointing ------------------------------------------------------


SBA_WINDOW = "prior year→this year"


def label_windows(windows, records):
    """Give every measure block the window it was ACTUALLY measured over.

    SBA compares against the PRIOR YEAR's summative, so the grade's
    Fall→Spring fallback would render "SBA ELA (Fall→Spring)" — a window that
    was never measured. This file's own rule, from the build_tab docstring: a
    Fall→Winter block labelled Fall→Spring is a wrong report, not a cosmetic
    slip.

    setdefault, so a real per-measure label always wins over the fallback.
    """
    labelled = dict(windows)
    for record in records:
        meas = str(record.get("meas") or "")
        if meas.startswith("SBA "):
            labelled.setdefault(meas, SBA_WINDOW)
    return labelled


def default_work_dir(slug, year, user):
    """Checkpoints belong to ONE run, not to a school forever.

    Keyed on school alone, a second report for the same school silently
    reused the first one's checkpoints — including `sheet` and `shared`. So a
    different caller got a URL they had no access to (exit 0, no error), and
    everybody got whatever the numbers were the first time the school was
    ever run, however stale. It also falsified this script's own claim that a
    school can be run twice and diffed: the second run returned the first
    run's cache.

    Date, caller and year are in the path. A retry the same day resumes,
    which is what a failed run needs. Tomorrow's run is fresh. Another
    caller gets their own workbook and their own share. Pass --work-dir to
    resume deliberately across any of those boundaries.
    """
    who = re.sub(r"[^a-z0-9]+", "-", str(user).lower()).strip("-")
    stamp = datetime.date.today().isoformat()
    return f"/tmp/qgr-{slug}-{year or 'latest'}-{who}-{stamp}"


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
    parser.add_argument(
        "--year",
        help='e.g. "2025-2026" (the warehouse spelling; "2025-26" also '
        "works). Default: the most recent year that has STARTED — the newest "
        "row may not have begun yet, and a growth report needs both windows.")
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
    work_dir = pathlib.Path(args.work_dir or default_work_dir(
        slug, args.year, args.user))
    work_dir.mkdir(parents=True, exist_ok=True)
    # The checkpoints are not metadata: grade-<g>-rows.json holds studentid
    # paired with assessment scores, which is student-level FERPA data sitting
    # in a predictable /tmp path for as long as the container lives. Default
    # mkdir permissions make that world-readable. Owner-only costs nothing and
    # does not depend on an assumption about how ephemeral the sandbox is.
    try:
        work_dir.chmod(0o700)
    except OSError as exc:
        log(f"warning: could not restrict {work_dir} to owner-only: {exc}")
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

        iready_tables = step(
            work_dir, "iready-tables",
            lambda: {subject: table
                     for subject, table in IREADY_TABLES_BY_SUBJECT.items()
                     if discover_table([table], yearid)}, log)
        missing = sorted(set(IREADY_TABLES_BY_SUBJECT) - set(iready_tables))
        # The TABLE names, not the subject keys. This PR exists because the
        # wrong table names were baked in; a log that hides which table
        # answered is the one line you would want next time.
        log(f"  i-Ready: {', '.join(sorted(iready_tables.values())) or 'NONE FOUND'}"
            + (f" (missing: {', '.join(missing)})" if missing else ""))

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
        # Share IMMEDIATELY, not after the last grade. The URL is printed the
        # moment the workbook exists, and until the transfer the agent account
        # owns it — so a run that dies partway through would surface a link
        # the user cannot open. That undercuts the whole point of a
        # diagnosable partial run.
        step(work_dir, "shared",
             lambda: {"result": share_workbook(sheet_id, args.user)}, log)
        log(f"  workbook: {url}")

        for grade in grades:
            done_marker = f"grade-{grade}-written"
            if (work_dir / f"{done_marker}.json").exists():
                log(f"grade {grade}: already written")
                continue
            log(f"grade {grade}: extracting")
            gaps = []
            measures = step(work_dir, f"grade-{grade}-measures",
                            lambda g=grade: discover_measures(yearid, g), log)
            if not measures:
                log(f"grade {grade}: no DIBELS measures present")
                gaps.append(
                    "DIBELS growth: not included "
                    "(no DIBELS measures recorded for this grade)")

            # One pass per distinct baseline. Grade 1 ORF starts mid-year, so
            # it runs Winter→Spring while the rest of grade 1 runs
            # Fall→Spring; a single pass would return zero matched pairs for
            # the odd measure and drop it from the tab silently.
            groups = group_by_baseline(grade, measures)
            windows = {}
            records = []
            for baseline, group in sorted(groups.items()):
                tag = f"grade-{grade}-{baseline.lower()}"
                log(f"grade {grade}: {baseline}→Spring for {', '.join(group)}")
                try:
                    rows = step(
                        work_dir, f"{tag}-rows",
                        lambda g=grade, b=baseline, m=group: extract_verified(
                            extraction_sql(schoolid, yearid, g, m, b),
                            f"Matched {b}/Spring pairs for grade {g}"),
                        log)
                except ReportError as exc:
                    log(f"grade {grade}: {baseline} extraction FAILED — {exc}")
                    gaps.append(
                        f"DIBELS {', '.join(group)} ({baseline}→Spring): "
                        f"not included (query failed: {str(exc)[:160]})")
                    continue
                if not rows:
                    # SKILL.md's contract is "anything it cannot produce is
                    # written INTO the tab", and the DIBELS block is the one
                    # the whole report is named for. Logging and moving on
                    # would leave the primary measures silently absent while
                    # SBA and i-Ready announced themselves — the exact
                    # asymmetry that makes a workbook look complete.
                    log(f"grade {grade}: no {baseline} matched pairs")
                    gaps.append(
                        f"DIBELS {', '.join(group)} ({baseline}→Spring): "
                        "not included (no matched students)")
                    continue
                log(f"grade {grade}: {len(rows)} rows ({baseline})")

                records.extend(aggregate_group(
                    work_dir, tag, grade, baseline, group, log))
                for measure in group:
                    windows[measure] = f"{baseline}→Spring"

            # i-Ready. Skipped for K by SKILL.md (not district-representative).
            if grade != "K":
                for subject in sorted(IREADY_TABLES_BY_SUBJECT):
                    table = iready_tables.get(subject)
                    if not table:
                        gaps.append(
                            f"i-Ready {subject}: not included (table "
                            f"{IREADY_TABLES_BY_SUBJECT[subject]} not found)")
                        continue
                    records.extend(run_block(
                        work_dir, f"grade-{grade}-iready-{subject.lower()}",
                        grade,
                        lambda g=grade, t=table, sub=subject: iready_sql(
                            schoolid, yearid, g, t, sub),
                        f"i-Ready {subject} Fall/Spring percentiles, "
                        f"grade {grade}",
                        log, gaps, f"i-Ready {subject}", no_norms=True))

            # SBA grades 4-5: scale change against the prior-year summative.
            if grade in ("4", "5"):
                records.extend(run_block(
                    work_dir, f"grade-{grade}-sba", grade,
                    lambda g=grade: sba_sql(schoolid, yearid, g),
                    f"SBA summative pairs for grade {grade}",
                    log, gaps, "SBA grades 4-5", no_norms=True))
            elif grade == "3":
                # Grade 3 has no prior SBA to quartile on — SKILL.md puts it on
                # the Fall i-Ready quartile instead, which needs the i-Ready
                # table. Stated rather than silently absent.
                gaps.append(
                    "SBA grade 3: not included (needs the Fall i-Ready "
                    "baseline; implement once the i-Ready table is confirmed)")

            if not records:
                log(f"grade {grade}: nothing to report — writing gaps only")

            windows = label_windows(windows, records)

            records_path = work_dir / f"grade-{grade}-records.json"
            records_path.write_text(json.dumps(records))
            # The fallback label must follow the GRADE, not the global default.
            # Hardcoding "Fall→Spring" here mislabels every K block, where each
            # measure's baseline is actually Winter. Only reached for a measure
            # absent from the discovered set, so it is latent — but a wrong
            # window label misstates what was measured, which is the one thing
            # a principal cannot check from the sheet.
            grade_default = BASELINE_BY_GRADE.get(str(grade), BASELINE_DEFAULT)
            windows.setdefault("*", f"{grade_default}→Spring")
            body = step(
                work_dir, f"grade-{grade}-values",
                lambda g=grade, w=windows, gp=gaps: build_values(
                    records_path, school["school_name"], g,
                    year["year_name"], json.dumps(w), roster["teachers"], gp),
                log)

            add_tab(sheet_id, grade, args.user, work_dir, log)
            write_tab(sheet_id, body, args.user, work_dir, grade)
            step(work_dir, done_marker, lambda: {"records": len(records)}, log)
            log(f"grade {grade}: written")

        if not (work_dir / "definitions-written.json").exists():
            add_tab(sheet_id, "Definitions", args.user, work_dir, log)
            write_tab(sheet_id, definitions_values(), args.user,
                      work_dir, "Definitions")
            step(work_dir, "definitions-written", lambda: {"ok": True}, log)

        log("done")
        print(url)
        return 0
    except ReportError as exc:
        log(f"FAILED: {exc}")
        return 1
    except Exception as exc:  # noqa: BLE001 - see below
        # A ReportError is an expected, checkpoint-resumable stop. Anything
        # else is a genuine bug (a KeyError off an unexpected roster shape,
        # say) where a re-run will not help — but the agent reads stderr and
        # reports it, so it still needs the same one-line FAILED shape rather
        # than a raw traceback. The traceback is kept, below the summary, for
        # whoever fixes it.
        log(f"FAILED: unexpected {type(exc).__name__}: {exc}")
        log("This is a bug, not a resumable failure — re-running will not help.")
        traceback.print_exc(file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
