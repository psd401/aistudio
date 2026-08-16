#!/usr/bin/env python3
"""Turn aggregate.py records into the grid a Sheets write takes. No glue.

The remaining hand-written script in this report was the one that reshaped
`aggregate.py`'s records into a 2D grid for the workbook — and that is where
the write tool's literal `\\n` bug kept landing, killing runs after all the
data was computed (agent_failures 6804; again 2026-08-15 twice, once with
every rollup finished).

Removing the CSV converter was half the job. This is the other half: the
layout step ships too, so the flow is query -> aggregate.py -> build_tab.py ->
sheets values batchUpdate, with no file the model has to author.

Input: aggregate.py's JSON on stdin or --rows.
Output: JSON `{"title": ..., "values": [[...], ...]}` — `values` is exactly
the 2D array `sheets spreadsheets values batchupdate` wants.

Row order is fixed by references/layout.md and is NOT cosmetic: All, then
D (highest) -> A (lowest). A workbook that orders quartiles differently from
the report it is modeled on invites a reader to compare the wrong rows.
"""

import argparse
import json
import sys
from collections import defaultdict

# layout.md: All first, then highest to lowest. Quartile 4 is the HIGHEST
# starting-point quartile, so D=4 .. A=1.
QUARTILE_ROWS = [("All", "All"), ("D (highest)", "4"), ("C", "3"), ("B", "2"), ("A (lowest)", "1")]
BLANK = ""


def cell(record):
    """`Raw/PR/n` for one cell, or an em dash when the cell has no students.

    layout.md: every value cell carries its own n, and `—` appears only when
    n is 0. A blank would read as "not measured" rather than "nobody here".
    """
    if record is None or record.get("n", 0) == 0:
        return "—"
    growth = record.get("growth")
    pr = record.get("pr_growth")
    parts = ["" if growth is None else f"{growth}"]
    if pr is not None:
        parts.append(f"{pr}")
    parts.append(str(record.get("n", 0)))
    return "/".join(part for part in parts if part != "")


def column_label(section_id, teachers):
    """The header for a classroom column: the teacher, not a section number.

    layout.md specifies `Teacher1 | … | School | District`. This emitted the
    raw sectionid instead, so a principal opening the workbook saw column
    headers like `274893` and had to be told which teacher that was. The agent
    papered over it by hand-writing relabeling scripts after the fact — the one
    thing this script exists to make unnecessary.

    The id is kept alongside the name because two teachers can share a name and
    section ids are what every downstream query keys on.
    """
    name = (teachers or {}).get(str(section_id))
    if not name:
        # A section with no Lead Teacher in PowerSchool. Named explicitly so it
        # cannot be mistaken for a lookup that silently failed.
        return f"(Not on file) ({section_id})"
    return f"{name} ({section_id})"


def build(records, school, grade, year, window, sections=None, teachers=None):
    """One tab's grid: a block per measure, quartile rows, then subgroups."""
    by_measure = defaultdict(lambda: defaultdict(dict))
    subgroups = defaultdict(list)
    for record in records:
        meas = record.get("meas")
        if record.get("subgroup"):
            subgroups[meas].append(record)
            continue
        scope = record.get("scope")
        if scope == "class" and record.get("sectionid"):
            scope = f"class:{record['sectionid']}"
        by_measure[meas][scope][record.get("qt")] = record

    # Deterministic ordering: a workbook whose blocks or columns move between
    # runs cannot be diffed against the prior year's report.
    section_ids = sections or sorted(
        {
            r.get("sectionid")
            for r in records
            if r.get("scope") == "class" and r.get("sectionid")
        }
    )

    values = [[f"{school} — Grade {grade} Growth by Quartile ({year})"], [BLANK]]

    for meas in sorted(by_measure):
        scopes = by_measure[meas]
        values.append([f"{meas} ({window})"])
        values.append(
            ["Quartile"]
            + [column_label(s, teachers) for s in section_ids]
            + ["School", "District"]
        )
        for label, key in QUARTILE_ROWS:
            row = [label]
            for section in section_ids:
                row.append(cell(scopes.get(f"class:{section}", {}).get(key)))
            row.append(cell(scopes.get("school", {}).get(key)))
            row.append(cell(scopes.get("district", {}).get(key)))
            values.append(row)
        values.append([BLANK])

    if subgroups:
        values.append(['Subgroups (All level) — School vs District'])
        values.append(["Subgroup", "Measure", "School", "District"])
        for meas in sorted(subgroups):
            by_label = defaultdict(dict)
            for record in subgroups[meas]:
                by_label[record["subgroup"]][record["scope"]] = record
            for label in sorted(by_label):
                scoped = by_label[label]
                values.append(
                    [label, meas, cell(scoped.get("school")), cell(scoped.get("district"))]
                )
        values.append([BLANK])

    return {"title": str(grade), "values": values}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rows", help="aggregate.py JSON; default stdin")
    parser.add_argument("--school", required=True)
    parser.add_argument("--grade", required=True)
    parser.add_argument("--year", required=True, help='e.g. "2025-26"')
    parser.add_argument(
        "--window",
        default="Fall→Spring",
        help="the window ACTUALLY used; a Fall→Winter report labeled "
        "Fall→Spring is a wrong report, not a cosmetic slip",
    )
    parser.add_argument(
        "--teachers",
        help='JSON map of sectionid -> teacher name, e.g. \'{"274893":"Hansen, Jane"}\'. '
        "Sections without an entry render as (Not on file).",
    )
    parser.add_argument(
        "--emit",
        choices=("grid", "values", "addsheet"),
        default="values",
        help="values: a ready --json body for `sheets spreadsheets values "
        "batchupdate`. addsheet: the body for `sheets spreadsheets "
        "batchupdate` that creates this tab. grid: the raw 2D array.",
    )
    args = parser.parse_args()

    if args.emit == "addsheet":
        # Emitted without reading rows: the tab has to exist before it can be
        # filled, and requiring the data first would force an extra pass.
        print(
            json.dumps(
                {
                    "requests": [
                        {"addSheet": {"properties": {"title": str(args.grade)}}}
                    ]
                },
                indent=1,
            )
        )
        return 0

    handle = open(args.rows) if args.rows else sys.stdin
    try:
        records = json.load(handle)
    finally:
        if args.rows:
            handle.close()

    teachers = None
    if args.teachers:
        # A raw JSONDecodeError here reads as a script bug and costs the agent
        # a debugging round trip — the exact tax this skill's docs exist to
        # avoid. Name what was wrong and what the argument should look like.
        try:
            teachers = json.loads(args.teachers)
        except (json.JSONDecodeError, ValueError) as exc:
            parser.error(
                f"--teachers is not valid JSON ({exc}). Expected a map of "
                'sectionid to teacher name, e.g. \'{"274893": "Hansen, Jane"}\''
            )
        if not isinstance(teachers, dict):
            parser.error(
                "--teachers must be a JSON object mapping sectionid to teacher "
                f"name, got {type(teachers).__name__}"
            )
    tab = build(
        records, args.school, args.grade, args.year, args.window, teachers=teachers
    )

    if args.emit == "grid":
        print(json.dumps(tab, indent=1))
        return 0

    # The complete request body, so the caller pipes this straight into gws
    # and authors no file. RAW because every cell is already a formatted
    # string — USER_ENTERED would let Sheets reinterpret "—" or a value like
    # "1/2/3" as a date.
    print(
        json.dumps(
            {
                "valueInputOption": "RAW",
                "data": [
                    {
                        "range": f"{tab['title']}!A1",
                        "values": tab["values"],
                    }
                ],
            },
            indent=1,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
