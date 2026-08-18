#!/usr/bin/env python3
"""Build the whole quartile growth report in one command.

WHY THIS SHAPE

R&A (James Cantonwine) ran this report for Evergreen and Purdy before the
skill existed, and handed over the 40 queries that produced it. The handoff's
first instruction is that the skill be "a transcription of this material, not
a fresh design — every non-obvious decision below cost a query cycle to
discover".

The design this replaces was mine, and it was wrong in three load-bearing
places. It paged raw student rows and computed quartiles locally, because I
had concluded NTILE could not run against this MCP; R&A's queries use 57 of
them. It converted national percentiles in Python; the validated queries do it
in SQL with a norms VALUES CTE and a LATERAL cut-point lookup. And it fought
the 30-row result cap by paging, where the queries pivot teachers into COLUMNS
and use GROUPING SETS so a whole block comes back in one page.

So this script no longer computes anything. It resolves the school and year,
discovers the homerooms, asks gen_sql for R&A's queries against them, runs
each one ONCE, and lays the results out. Every number in the workbook is
computed by the warehouse.

WHAT IT STILL DOES

  - one exec, so the turn deadline, the promotion, and the continuation turn
    are all out of the picture
  - checkpoints, so a re-run resumes instead of restarting
  - no model-authored files anywhere in the path

WHAT IT DOES NOT FIX

Whether the numbers are right. It makes that answerable: the same school run
twice is diffable, and every query is written to the work dir as it ran.

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

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import gen_sql  # noqa: E402
import layout  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
PSD_DATA = "/opt/psd-skills/psd-data/run.js"
WORKSPACE = "/opt/psd-skills/psd-workspace/run.js"

# Course codes ARE the grade span. gen_sql.MEASURES keys grades 0-5 to
# 'GR00K'..'GR005'; the roster query below asks which of those the school
# actually runs, and a grade with no homeroom simply produces no queries.
# Nothing in this script may assert a grade span it did not query — the agent
# announced "Minter Creek is a K-2 school" once, invented the reason, and
# scoped a whole report to it. Minter Creek is K-5.
GRADE_LABELS = {0: "K", 1: "1", 2: "2", 3: "3", 4: "4", 5: "5"}
GRADE_BY_LABEL = {label: grade for grade, label in GRADE_LABELS.items()}


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


def query(sql, reason):
    """One psd-data SELECT.

    NOT `--export`. Export mode timed out repeatedly on the grade-K extraction
    on 2026-08-16 while the same query in normal mode returned 2,232 rows in
    seconds, and it has a separate history of silently dropping numeric
    columns from the CSV.

    No --limit / --offset either: every query this script runs is an aggregate
    that fits in one result. Paging existed to move raw student rows, and
    those no longer leave the warehouse.
    """
    argv = ["node", PSD_DATA, "query", "--reason", reason, "--sql", sql]
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


def query_one(sql, reason):
    """Run one of R&A's queries. ONE call, no paging, no row count.

    These queries return aggregates: GROUPING SETS puts the All row beside the
    quartile rows, and teachers are pivoted into columns, so a whole block is
    a handful of rows. That is the point of the shapes R&A validated — the
    30-row display cap was designed around, not paged around.

    The previous design paged raw student rows here and then had to prove
    nothing was dropped, because a silently truncated extraction yields
    quartiles over a fraction of the cohort that look entirely plausible.
    There is nothing to truncate now.

    R&A's note: the long queries run about 90 seconds and occasionally time
    out on the MCP — "simply retry once before changing anything". So this
    does, once, rather than failing a whole grade over a slow warehouse.
    """
    try:
        return query(sql, reason)
    except ReportError as first:
        print(f"  {reason}: retrying once after {first}",
              file=sys.stderr, flush=True)
        return query(sql, reason)
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


def fetch_sections(schoolid, yearid, grade, course):
    """The homerooms and lead teachers for ONE grade.

    R&A's "Adapting to a school" step 1: `section_enrollments` for this year
    and school where `course_code` is the grade's GR0xx code, ordered by
    sectionid — that order becomes the classroom column order in the sheet.

    `role_name = 'Lead Teacher'` and never `priorityorder`, which is often
    null; an unresolvable teacher is labelled by layout.py, never dropped,
    because those students are still in the numbers.

    One call per grade rather than one for the school: a big building can have
    more homerooms than the MCP will display in a single result, and the whole
    report is built on this list being complete.
    """
    rows = query_one(
        "SELECT DISTINCT se.sectionid AS sectionid, "
        # Live schema: teachers has no teacher_name — only first_name /
        # last_name — and its PK is `id`, not `teacherid`.
        "  (t.first_name || ' ' || t.last_name) AS teacher_name "
        "FROM section_enrollments se "
        "LEFT JOIN section_teachers st "
        "  ON st.sectionid = se.sectionid AND st.role_name = 'Lead Teacher' "
        "LEFT JOIN teachers t ON t.id = st.teacherid "
        f"WHERE se.yearid = {int(yearid)} AND se.schoolid = {int(schoolid)} "
        f"  AND se.course_code = '{sql_escape(course)}' "
        "ORDER BY se.sectionid",
        f"Homeroom sections and lead teachers for grade {GRADE_LABELS[grade]}",
    )
    sections, teachers = [], {}
    for row in rows:
        section = str(row.get("sectionid") or "").strip()
        if not section or section in sections:
            continue
        sections.append(section)
        name = row.get("teacher_name")
        if name and str(name).strip():
            teachers[section] = str(name).strip()
    return {"sections": sections, "teachers": teachers}


def fetch_roster(schoolid, yearid):
    """Every grade this school actually serves, with its homerooms.

    THE ROSTER DEFINES THE GRADE SPAN — nothing here may assert one that was
    not queried.
    """
    sections, teachers = {}, {}
    for grade, cfg in sorted(gen_sql.MEASURES.items()):
        found = fetch_sections(schoolid, yearid, grade, cfg["course"])
        if not found["sections"]:
            continue
        sections[grade] = found["sections"]
        teachers.update(found["teachers"])
    if not sections:
        raise ReportError(
            f"no GR0x homeroom sections for schoolid={schoolid} "
            f"yearid={yearid} — this school serves no K-5 grades in that year"
        )
    return {"sections": sections, "teachers": teachers}


def section_ids(sections):
    """Section ids as ints, for splicing into SQL.

    The MCP returns them as text; gen_sql inlines them into FILTER clauses.
    A non-numeric id would be a SQL injection point AND a broken query, so it
    fails here rather than in the warehouse.
    """
    out = []
    for value in sections:
        try:
            out.append(int(str(value).strip()))
        except (TypeError, ValueError):
            raise ReportError(f"non-numeric sectionid from the roster: {value!r}")
    return out



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


# --- checkpointing ------------------------------------------------------


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


def build_school(school, roster):
    """The config gen_sql wants: schoolid, name, and sections per grade.

    R&A's generator took this from a hardcoded SCHOOLS dict — the handoff's
    step 2 is "either add a SCHOOLS entry and regenerate, or substitute
    schoolid + sectionids into the queries directly (they are otherwise
    school-independent)". This builds the entry from the live roster instead,
    so any school works without editing the generator.
    """
    return {
        "id": int(school["schoolid"]),
        "name": school["school_name"],
        "sections": {grade: section_ids(ids)
                     for grade, ids in roster["sections"].items()},
    }


def run_queries(specs, sqldir, work_dir, log):
    """Run every generated query once, checkpointed by filename.

    Checkpointed individually, not per grade: a run that dies on query 31 of
    40 resumes at 31. A block whose query fails is recorded as a GAP and the
    report continues — the alternative is losing 39 good queries to one bad
    one, and the gap is written into the tab where the reader can see it.
    """
    results, gaps = {}, {}
    for spec in specs:
        name = spec["name"]
        sql = (sqldir / name).read_text()
        try:
            rows = step(
                work_dir, f"q-{name[:-4]}",
                lambda s=sql, n=name: query_one(
                    s, f"Quartile growth report: {n[:-4]}"),
                log)
        except ReportError as exc:
            log(f"  {name}: FAILED — {exc}")
            gaps.setdefault(spec["grade"], []).append(
                f"{spec['title']}: not included (query failed: "
                f"{str(exc)[:160]})")
            continue
        results[name] = rows
        log(f"  {name}: {len(rows)} rows")
    return results, gaps


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
    # Aggregates now, not student rows — but the checkpoints still hold
    # classroom-level cells for real children in a predictable /tmp path for
    # as long as the container lives, and default mkdir permissions make that
    # world-readable. Owner-only costs nothing.
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
        log(f"  {school['school_name']} ({schoolid}), "
            f"{year['year_name']} ({yearid})")

        roster = step(work_dir, "roster",
                      lambda: fetch_roster(schoolid, yearid), log)
        # JSON turns the integer grade keys into strings on the way back out
        # of a checkpoint. Normalised here so a resumed run and a fresh one
        # agree about which grades exist.
        roster["sections"] = {int(g): v
                              for g, v in roster["sections"].items()}
        served = sorted(roster["sections"])
        if args.grades:
            wanted = [g.strip() for g in args.grades.split(",") if g.strip()]
            unknown = [g for g in wanted if GRADE_BY_LABEL.get(g) not in served]
            if unknown:
                raise ReportError(
                    f"grade(s) {unknown} are not in this school's roster "
                    f"(served: {[GRADE_LABELS[g] for g in served]})")
            grades = [GRADE_BY_LABEL[g] for g in wanted]
        else:
            grades = served
        log("  grades served: "
            + ", ".join(GRADE_LABELS[g] for g in served))
        for grade in served:
            log(f"    grade {GRADE_LABELS[grade]}: "
                f"{len(roster['sections'][grade])} homerooms")

        config = build_school(school, roster)
        config["sections"] = {g: config["sections"][g] for g in grades}
        sqldir = work_dir / "sql"
        gen_sql.generate(config, sqldir, year=int(yearid))
        specs = gen_sql.specs(config)
        log(f"  {len(specs)} queries generated into {sqldir}")

        if dry_run:
            print(json.dumps({
                "school": school, "year": year,
                "grades_served": [GRADE_LABELS[g] for g in served],
                "grades_planned": [GRADE_LABELS[g] for g in grades],
                "sections": {GRADE_LABELS[g]: config["sections"][g]
                             for g in grades},
                "queries": [s["name"] for s in specs],
                "work_dir": str(work_dir),
            }, indent=1))
            return 0

        title = (f"{school['school_name']} - Quartile Growth Report "
                 f"({year['year_name']})")
        sheet_id = step(work_dir, "sheet",
                        lambda: {"id": create_workbook(title, args.user)},
                        log)["id"]
        url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/edit"
        # Share IMMEDIATELY, not after the last grade. Until the transfer the
        # agent account owns the file, so a run that dies partway would
        # surface a link the user cannot open — which undercuts the whole
        # point of a diagnosable partial run.
        step(work_dir, "shared",
             lambda: {"result": share_workbook(sheet_id, args.user)}, log)
        log(f"  workbook: {url}")

        results, gaps = run_queries(specs, sqldir, work_dir, log)

        for grade in grades:
            label = GRADE_LABELS[grade]
            done_marker = f"grade-{label}-written"
            if (work_dir / f"{done_marker}.json").exists():
                log(f"grade {label}: already written")
                continue
            blocks = [(spec, results.get(spec["name"], []))
                      for spec in specs if spec["grade"] == grade]
            values = layout.tab(school["school_name"], grade,
                                year["year_name"], blocks,
                                roster["teachers"], gaps.get(grade, ()))
            add_tab(sheet_id, label, args.user, work_dir, log)
            write_tab(sheet_id, layout.body_for(label, values),
                      args.user, work_dir, label)
            step(work_dir, done_marker,
                 lambda b=blocks: {"blocks": len(b)}, log)
            log(f"grade {label}: written ({len(blocks)} blocks)")

        if not (work_dir / "definitions-written.json").exists():
            add_tab(sheet_id, "Definitions", args.user, work_dir, log)
            write_tab(sheet_id, definitions_values(), args.user,
                      work_dir, "Definitions")
            step(work_dir, "definitions-written", lambda: {"ok": True}, log)

        failed = sum(len(v) for v in gaps.values())
        if failed:
            log(f"done, with {failed} block(s) missing — see the tabs")
        else:
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
