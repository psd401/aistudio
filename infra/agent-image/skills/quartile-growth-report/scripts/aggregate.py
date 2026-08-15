#!/usr/bin/env python3
"""Quartiles, national PR, and the report rollups — computed here, not in SQL.

The warehouse used to do all of this: three `NTILE` windows, `GROUPING SETS`,
and a per-row `LEFT JOIN LATERAL` against an inline `VALUES` norms table,
district-wide, for every grade and measure. It never completed.

Isolated on 2026-08-15 (Evergreen Elementary 2025-26): **window functions do not
complete against `dibels_scores` on this MCP server at any size.** A bare
`NTILE(4)` over ~1,100 rows — no norms join, no classroom breakdown — timed out,
while the same query without the window ran in seconds. The extraction query
this script consumes returned 2,232 matched rows for grade K in about 3 seconds.

So this is not an optimization. It is the only shape that runs. The norms were
already generated on this box by `norms_values.py`, so sending them to the
database to be joined back per row was pure overhead regardless; quartiles are a
sort and a split. The query returns raw matched pairs and this script does the
rest.

Student ids arrive here because the quartile tiebreak needs them. They are used
for ordering only and never appear in the output — every emitted record is an
aggregate cell.

Input is the raw rows as JSON (a list of objects, or one object per line) on
stdin or from --rows. Required keys per row:

    meas       measure name as the warehouse spells it
    studentid  used for the mandatory NTILE tiebreak
    b          baseline score (numeric)

Optional:

    e          spring score; omit or null for a Fall-only report
    sectionid  homeroom; null/absent means the student is not in one
    in_sch     true when the student is enrolled at the report's school

Output is JSON on stdout: one record per (meas, scope, quartile) with the same
columns the SQL used to emit, plus an 'All' row per measure and scope.
"""

import argparse
import csv
import io
import json
import os
import sys
from collections import defaultdict
from decimal import Decimal, ROUND_HALF_UP

NORMS = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "references",
    "dibels8_norms_2021-22.csv",
)


def ntile(rows, buckets=4):
    """Assign Postgres NTILE(n) bucket numbers to an ordered row list.

    Postgres divides N rows into n groups as equally as possible and gives the
    remainder to the EARLIEST buckets: bucket i holds floor(N/n) rows, plus one
    more while i <= N mod n. Splitting evenly and dumping the remainder at the
    end instead would move real students between quartiles on any partition
    whose size is not a multiple of four — which is most of them.

    `rows` must already be ordered. See order_key: the (b, studentid) tiebreak
    is mandatory, not stylistic — without it quartile membership is
    nondeterministic and a re-run moved 19 of 100 quartile cells.
    """
    total = len(rows)
    if total == 0:
        return []
    base, remainder = divmod(total, buckets)
    assigned = []
    index = 0
    for bucket in range(1, buckets + 1):
        size = base + (1 if bucket <= remainder else 0)
        for _ in range(size):
            if index >= total:
                break
            assigned.append((rows[index], bucket))
            index += 1
    return assigned


def order_key(row):
    """The mandatory NTILE ordering: baseline, then studentid as tiebreak.

    The id sorts NUMERICALLY when it is numeric. Postgres orders a numeric
    `studentid` column as a number — 9 before 10 — while `str()` would order it
    lexically and put 10 first. On any baseline tie involving multi-digit ids
    that picks a different student for the quartile boundary, which is the
    "19 of 100 quartile cells moved" failure this ordering exists to prevent,
    reintroduced one level down.

    The (kind, value) pair keeps numeric and non-numeric ids from being
    compared against each other; a real column is one or the other.
    """
    if row.get("b") is None:
        raise ValueError(
            f"row for student {row.get('studentid')!r} has no baseline score; "
            "the extraction query must not return null b"
        )
    sid = row["studentid"]
    try:
        # via float() so a JSON-decoded 10.0 still sorts as 10: int("10.0")
        # raises, which would drop an integer id into the string branch below
        # and sort it lexically — the exact tiebreak bug this function fixes.
        return (row["b"], 0, int(float(str(sid).strip())), "")
    except (TypeError, ValueError):
        return (row["b"], 1, 0, str(sid))


def normalize_grade(value):
    """'3', '3.0', 3 -> '3'; 'K' -> '0'.

    Kindergarten is why this must stay in lockstep with `norms_values.py`'s
    function of the same name: SKILL.md labels the tabs K-5, so `--grade K` is
    the natural thing for an agent to pass, but the norms file stores
    kindergarten as grade 0. The two scripts key the same CSV on the same
    domain concept; a divergence here scores kindergarten against nothing.

    The shipped `dibels8_norms_2021-22.csv` stores grade as a plain integer
    (0-5); the float-tolerant parse is defensive, for a norms file or a
    `--grade` argument that arrives in the '3.0' form instead.

    Lockstep means the K mapping and the numeric normalization, not the
    invalid-input path, which intentionally differs: `norms_values.py` raises
    on `--grade banana` because nothing downstream would catch it, while here
    the unparsed text falls through to the no-norms-at-that-grade guard in
    `main()` and fails there with the measures listed. Do not "fix" this
    divergence into a raise without moving that guard.
    """
    text = str(value).strip()
    if text.upper() == "K":
        return "0"
    try:
        return str(int(float(text)))
    except (TypeError, ValueError):
        return text


def load_norms(path):
    """measure -> grade -> period -> ascending [(cut, pr)].

    Grade is part of the key, not an afterthought: the same measure has
    different cut points per grade — Fall ORF-WRC is 188 cuts topping at raw
    187 for grade 3, and 206 cuts topping at 205 for grade 5. Merging grades
    into one sorted list makes `percentile_for` return whichever grade's cut
    happened to be the largest one at or below the score, producing percentiles
    that are silently wrong rather than raising.

    `norms_values.py` filters by grade before emitting its rows, which is why
    the SQL this replaces never mixed them.
    """
    table = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))
    with open(path, newline="") as handle:
        for row in csv.DictReader(handle):
            try:
                raw = float(row["raw"])
                pr = float(row["percentile"])
            except (TypeError, ValueError):
                continue
            grade = normalize_grade(row["grade"])
            table[row["measure"]][grade][row["period"]].append((raw, pr))
    for measure in table:
        for grade in table[measure]:
            for period in table[measure][grade]:
                table[measure][grade][period].sort()
    return table


def percentile_for(points, score):
    """The pr of the largest cut <= score — the LATERAL lookup, done locally.

    Mirrors `WHERE cut <= s ORDER BY cut DESC LIMIT 1`: a score below every cut
    has no percentile (None), matching the LEFT JOIN's null rather than
    inventing a floor of 1.
    """
    if score is None or not points:
        return None
    best = None
    for cut, pr in points:
        if cut <= score:
            best = pr
        else:
            break
    return best


def mean(values):
    values = [v for v in values if v is not None]
    if not values:
        return None
    return sum(values) / len(values)


def pg_round(value, digits=0):
    """Round the way Postgres ROUND(numeric) does — half AWAY FROM ZERO.

    Python's round() is banker's rounding: round(12.5) is 12, round(0.5) is 0.
    Postgres answers 13 and 1. Every value here was previously rounded by
    ROUND() inside the query, so using Python's default would move percentile
    levels and growth figures by one against the validation workbook — on
    exactly the .5 boundaries a reviewer is most likely to spot-check.

    Verified against Postgres 12.5 -> 13, 0.5 -> 1, -12.5 -> -13.
    """
    if value is None:
        return None
    quantum = Decimal(1).scaleb(-digits)
    rounded = Decimal(repr(value)).quantize(quantum, rounding=ROUND_HALF_UP)
    return int(rounded) if digits == 0 else float(rounded)


def rollup(rows, scope, partition_key, value_digits=1):
    """Quartile + 'All' rollups for one scope, mirroring the GROUPING SETS.

    Quartiles are assigned WITHIN each partition, which is why the class scope
    can be aggregated per section without leaking another section's
    distribution into it.
    """
    partitions = defaultdict(list)
    for row in rows:
        partitions[partition_key(row)].append(row)

    quartiled = []
    for _, group in partitions.items():
        group.sort(key=order_key)
        quartiled.extend(ntile(group))

    by_cell = defaultdict(list)
    for row, bucket in quartiled:
        by_cell[(row["meas"], str(bucket))].append(row)
        by_cell[(row["meas"], "All")].append(row)

    out = []
    for (meas, qt), members in sorted(by_cell.items()):
        growth = mean([r["e"] - r["b"] for r in members if r.get("e") is not None])
        pr_growth = mean(
            [
                r["pre"] - r["prb"]
                for r in members
                if r.get("pre") is not None and r.get("prb") is not None
            ]
        )
        # Levels as well as deltas, in one pass. The school-vs-district PR
        # mini-tables and the Fall-only report want averages of the values
        # themselves, not of the change; computing both here avoids a second
        # traversal and keeps the two views consistent by construction.
        start_pr = mean([r["prb"] for r in members])
        end_pr = mean([r["pre"] for r in members])
        start_raw = mean([r["b"] for r in members])
        end_raw = mean([r["e"] for r in members if r.get("e") is not None])

        # Carry the section on class-scope cells. Without it the workbook
        # cannot build its per-teacher columns — the breakdown this report
        # exists for — and the builder has no way to tell one class row from
        # another.
        sections = {r.get("sectionid") for r in members if r.get("sectionid")}
        out.append(
            {
                "meas": meas,
                "scope": scope,
                "sectionid": sections.pop() if len(sections) == 1 else None,
                "qt": qt,
                "growth": pg_round(growth, value_digits),
                "pr_growth": pg_round(pr_growth, value_digits),
                # Percentile levels round to whole percentiles, as the SQL did.
                "start_pr": pg_round(start_pr),
                "end_pr": pg_round(end_pr),
                "start_raw": pg_round(start_raw, value_digits),
                "end_raw": pg_round(end_raw, value_digits),
                "n": len(members),
            }
        )
    return out


TRUE_TEXT = {"true", "t", "yes", "y", "1"}


def coerce_row(row):
    """Parse the ::text columns the extraction query is required to emit.

    psd-data's export mode fails on decimal, integer and boolean columns, so
    references/sql.md casts every one of them to text. That means `b`, `e` and
    `in_sch` arrive here as strings, and a string baseline would sort
    lexically — '9' after '100' — silently reordering the quartile boundary
    rather than raising. Numbers are parsed back before anything compares them.

    Values that are already numeric or boolean pass through untouched, so rows
    from a non-export path behave the same.
    """
    for key in ("b", "e"):
        value = row.get(key)
        if isinstance(value, str):
            text = value.strip()
            row[key] = None if text == "" else float(text)

    flag = row.get("in_sch")
    if isinstance(flag, str):
        row["in_sch"] = flag.strip().lower() in TRUE_TEXT

    section = row.get("sectionid")
    if isinstance(section, str) and section.strip() == "":
        row["sectionid"] = None
    return row


UNKNOWN_FLAG = object()


def flag_value(raw):
    """Tri-state a subgroup flag: True, False, or UNKNOWN.

    A student with NO flag record is UNKNOWN, never False. Defaulting a missing
    record to the negative class is what made the district subgroup columns
    wrong AND invisible on 2026-08-15: only Evergreen students carried an
    FRL/SpEd record, so all 540 other district students silently became
    "Non-Low Income", and the district row became a copy of the school row.
    A missing record is not evidence that a student is not low income.
    """
    if raw is None:
        return UNKNOWN_FLAG
    if isinstance(raw, bool):
        return raw
    text = str(raw).strip().lower()
    if text == "":
        return UNKNOWN_FLAG
    if text in TRUE_TEXT:
        return True
    if text in {"false", "f", "no", "n", "0"}:
        return False
    return UNKNOWN_FLAG


def subgroup_rollups(rows, column, positive_label, negative_label):
    """School and district rollups for one flag column, at the All level.

    Students whose flag is UNKNOWN are excluded from BOTH sides rather than
    swelling the negative class. That makes the denominators smaller and
    honest; the alternative reports a number that looks complete and is not.
    """
    out = []
    for scope, population in (
        ("district", rows),
        ("school", [r for r in rows if r.get("in_sch")]),
    ):
        for label, wanted in ((positive_label, True), (negative_label, False)):
            members = [r for r in population if flag_value(r.get(column)) is wanted]
            if not members:
                continue
            for cell in rollup(members, scope, lambda r: r["meas"]):
                if cell["qt"] != "All":
                    continue
                cell["subgroup"] = label
                out.append(cell)
    return out


def subgroup_scope_warning(records):
    """Warn when a subgroup's district row is identical to its school row.

    That is the fingerprint of a flag joined only for the report's own school:
    the district cell is really the school cell, and its complement is
    contaminated with every unflagged student in the district. It reads as
    plausible data, which is exactly why it needs to be called out rather than
    left for a reader to notice.
    """
    by_key = defaultdict(dict)
    for record in records:
        subgroup = record.get("subgroup")
        if subgroup:
            by_key[(record["meas"], subgroup)][record["scope"]] = record

    suspect = []
    for (meas, subgroup), scopes in sorted(by_key.items()):
        school, district = scopes.get("school"), scopes.get("district")
        if not school or not district:
            continue
        if school["n"] == district["n"] and school["growth"] == district["growth"]:
            suspect.append(f"{meas}/{subgroup}")
    return suspect


def read_rows(handle):
    """Accept the export CSV as-is, or JSON, without being told which.

    psd-data exports CSV. Requiring JSON here forced a hand-written CSV->JSON
    converter on every run, and that glue is where runs kept dying: the write
    tool emits literal `\\n` sequences into helper scripts, producing a
    SyntaxError and a retry loop that has now burned parts of three sessions
    (agent_failures 6804, and again 2026-08-15 mid-report).

    The fix is to remove the need for the script rather than to warn about it
    again. Detection is by content, not by extension, because the export
    filename is not always .csv.
    """
    text = handle.read().strip()
    if not text:
        return []
    if text.lstrip().startswith(("[", "{")):
        if text.lstrip().startswith("["):
            return json.loads(text)
        return [json.loads(line) for line in text.splitlines() if line.strip()]
    # CSV: a header line naming the extraction columns.
    return list(csv.DictReader(io.StringIO(text)))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rows", help="JSON rows file; default stdin")
    parser.add_argument("--baseline", default="Fall", help="baseline window name")
    parser.add_argument("--spring", default="Spring", help="end window name")
    # Required, matching norms_values.py's contract. The same measure has
    # different cut points per grade, so a norms lookup without a grade is not
    # a lookup — it silently mixes them.
    parser.add_argument(
        "--grade", help="grade for the norms lookup; required unless --no-norms"
    )
    parser.add_argument(
        "--measure-as",
        action="append",
        default=[],
        metavar="WAREHOUSE=NORMS",
        help="map a warehouse measure name to its norms-file name; repeatable",
    )
    parser.add_argument(
        "--subgroup",
        action="append",
        default=[],
        metavar="COLUMN=POSITIVE|NEGATIVE",
        help="emit School+District rollups for a flag column, e.g. "
        "low_income='Low Income|Non-Low Income'; repeatable",
    )
    parser.add_argument(
        "--no-norms",
        action="store_true",
        help="skip national PR entirely (i-Ready, ORF Accuracy, SBA)",
    )
    parser.add_argument("--norms", default=NORMS)
    args = parser.parse_args()

    handle = open(args.rows) if args.rows else sys.stdin
    try:
        rows = read_rows(handle)
    finally:
        if args.rows:
            handle.close()

    if not rows:
        print(json.dumps([]))
        return 0

    # `order_key` raises on a null baseline too — that is the sort's own
    # invariant and stays — but it fires from inside `sorted()` deep in
    # `rollup`, so the operator (an agent reading stderr, per SKILL.md) gets a
    # traceback rather than something diagnosable. Same loud failure, checked
    # up front in this file's parser.error style.
    no_baseline = [r for r in rows if r.get("b") is None]
    if no_baseline:
        parser.error(
            f"{len(no_baseline)} of {len(rows)} rows have a null baseline "
            f"score (first: student {no_baseline[0].get('studentid')!r}); the "
            "extraction query must not return null b — filter those rows out "
            "in SQL, or use the Fall-only status view if there is no baseline."
        )

    alias = {}
    for pair in args.measure_as:
        if "=" not in pair:
            parser.error(f"--measure-as expects WAREHOUSE=NORMS, got {pair!r}")
        warehouse, norms_name = pair.split("=", 1)
        alias[warehouse] = norms_name

    if not args.no_norms and not args.grade:
        parser.error("--grade is required unless --no-norms (cut points differ by grade)")

    norms = {} if args.no_norms else load_norms(args.norms)
    grade = normalize_grade(args.grade) if args.grade else None

    if not args.no_norms:
        measures = sorted({alias.get(r["meas"], r["meas"]) for r in rows})
        unnormed = [m for m in measures if grade not in norms.get(m, {})]

        if len(unnormed) == len(measures):
            # Nothing in this run can be scored at all — a wrong --grade, a
            # mistyped --measure-as, or the wrong norms file. Loud, not a null
            # percentile for every student in the report, which reads as
            # missing data rather than a wrong invocation.
            have = ", ".join(f"{m} {sorted(norms[m])}" for m in sorted(norms))
            parser.error(
                f"no norms at grade {grade!r} for any requested measure "
                f"({', '.join(measures)}); the norms file has {have}. "
                "Map warehouse names with --measure-as WAREHOUSE=NORMS, or "
                "pass --no-norms to skip percentiles entirely."
            )

        for measure in unnormed:
            # Partial coverage is normal, not an error: LNF and PSF stop after
            # grade 1, MAZE does not start until 2. SKILL.md is explicit that a
            # measure-window missing from the file emits raw change only "and
            # say so" — so one unnormed measure must not abort the measures
            # that can be scored. Still loud: named on stderr so the null PR is
            # attributable rather than mistaken for missing data.
            print(
                f"warning: no norms for measure {measure!r} at grade {grade!r} "
                f"(available grades: {sorted(norms.get(measure, {})) or 'none'}); "
                "emitting raw change only for it",
                file=sys.stderr,
            )

    for row in rows:
        row.setdefault("e", None)
        row.setdefault("sectionid", None)
        row.setdefault("in_sch", False)
        coerce_row(row)
        if args.no_norms:
            row["prb"] = row["pre"] = None
            continue
        measure = alias.get(row["meas"], row["meas"])
        periods = norms.get(measure, {}).get(grade, {})
        row["prb"] = percentile_for(periods.get(args.baseline, []), row.get("b"))
        row["pre"] = percentile_for(periods.get(args.spring, []), row.get("e"))

    results = []
    results.extend(rollup(rows, "district", lambda r: r["meas"]))
    results.extend(
        rollup(
            [r for r in rows if r.get("in_sch")],
            "school",
            lambda r: (r["meas"], True),
        )
    )
    results.extend(
        rollup(
            [r for r in rows if r.get("sectionid") is not None],
            "class",
            lambda r: (r["meas"], r["sectionid"]),
        )
    )

    for spec in args.subgroup:
        if "=" not in spec or "|" not in spec:
            parser.error(
                f"--subgroup expects COLUMN='POSITIVE|NEGATIVE', got {spec!r}"
            )
        column, labels = spec.split("=", 1)
        positive, negative = labels.split("|", 1)
        results.extend(
            subgroup_rollups(rows, column, positive.strip(), negative.strip())
        )

    suspect = subgroup_scope_warning(results)
    if suspect:
        print(
            "WARNING: district subgroup rows are identical to school rows for: "
            + ", ".join(suspect)
            + ". The flag column is almost certainly joined only for this "
            "school, so the district figure is the school figure and its "
            "complement includes every unflagged district student. Join the "
            "flags district-wide (see references/sql.md).",
            file=sys.stderr,
        )

    print(json.dumps(results, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
