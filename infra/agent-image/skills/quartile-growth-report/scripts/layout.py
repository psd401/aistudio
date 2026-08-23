#!/usr/bin/env python3
"""Turn query results into the grid a Sheets write takes.

Every query in this skill returns AGGREGATES already shaped for the report —
GROUPING SETS gives the All row next to the quartile rows, and teachers are
pivoted into columns so a result fits in one page. So there is nothing to
compute here. This file only decides where each returned number sits.

It reads the column meanings from gen_sql.specs(), not from the data. The
previous layout step inferred them, and inferring the shape of a payload I had
never seen is how this skill spent a week producing empty tabs.

references/layout.md is the spec: row order All -> D (highest) -> A (lowest),
every value carries its own n, and an em dash appears only when n = 0.
"""

# layout.md. Quartile 4 is the HIGHEST starting-point quartile, so D = 4.
# A workbook that orders quartiles differently from the report it is modeled
# on invites a reader to compare the wrong rows.
QUARTILE_ROWS = [("All", "All"), ("D (highest)", "4"), ("C", "3"),
                 ("B", "2"), ("A (lowest)", "1")]

# The order SUBGROUP_LATERAL declares them in. The query returns them
# alphabetically (ORDER BY 1,2), which separates each subgroup from its
# complement — the two numbers a reader compares.
SUBGROUP_ROWS = ["Low Income", "Non-Low Income", "Special Ed",
                 "Non-Special Ed"]
EM_DASH = "—"
BLANK = ""


def grade_label(grade):
    """Kindergarten is "K" everywhere a human reads it; 0 in the warehouse."""
    return "K" if str(grade) in ("0", "K") else str(grade)


def teacher_label(section_id, teachers):
    """A classroom column header names the TEACHER, not the section number.

    A principal opening a workbook whose columns read `274893` has to be told
    which teacher that is. The id stays alongside because two teachers can
    share a name and every query keys on the id.
    """
    name = (teachers or {}).get(str(section_id))
    if not name:
        # A section with no Lead Teacher in PowerSchool. R&A's rule: label it,
        # never drop the column — the students are still in the numbers.
        return f"(Not on file) ({section_id})"
    return f"{name} ({section_id})"


def _num(value):
    """A cell value as it should print, or None if the query returned null."""
    if value is None:
        return None
    if isinstance(value, str):
        text = value.strip()
        if text == "" or text.lower() in ("null", "none"):
            return None
        return text
    return value


def _count(value):
    """n as an int. Anything unparseable counts as 0, i.e. an em dash."""
    text = _num(value)
    if text is None:
        return 0
    try:
        return int(float(text))
    except (TypeError, ValueError):
        return 0


def groups_for(spec, teachers):
    """The column groups of one block: (header, [value keys], n key).

    Derived from the spec's own value prefixes and section order — the same
    list gen_sql used to build the SELECT — so a column can never be read
    under the wrong heading.
    """
    values = spec["values"]
    groups = []
    if spec["shape"] in ("quartile", "prof"):
        for index, section in enumerate(spec["sections"], 1):
            groups.append((teacher_label(section, teachers),
                           [f"{prefix}{index}" for prefix, _ in values],
                           f"n{index}"))
        groups.append(("School", [f"{prefix}_sch" for prefix, _ in values],
                       "n_sch"))
        groups.append(("District", [f"{prefix}_dist" for prefix, _ in values],
                       "n_dist"))
    elif spec["shape"] == "subgroup":
        groups.append(("School", [f"{prefix}_sch" for prefix, _ in values],
                       "n_sch"))
        groups.append(("District", [f"{prefix}_dist" for prefix, _ in values],
                       "n_dist"))
    elif spec["shape"] == "levels":
        groups.append(("School", ["s_start", "s_end"], "n_sch"))
        groups.append(("District", ["d_start", "d_end"], "n_dist"))
    else:
        raise ValueError(f"unknown query shape {spec['shape']!r}")
    return groups


def _row_cells(row, groups):
    """One data row: value cells + n per group, em dash where n = 0."""
    cells = []
    for _, keys, n_key in groups:
        n = _count((row or {}).get(n_key))
        if n == 0:
            # layout.md: an em dash means nobody, not "not measured". A blank
            # would read as the second.
            cells.extend([EM_DASH] * len(keys) + [EM_DASH])
            continue
        for key in keys:
            value = _num((row or {}).get(key))
            cells.append(EM_DASH if value is None else value)
        cells.append(n)
    return cells


def _headers(groups, value_labels, corner):
    """Two header rows: the group name, then its value columns and n."""
    top = [corner]
    sub = [BLANK]
    for name, keys, _ in groups:
        top.append(name)
        top.extend([BLANK] * len(keys))
        labels = list(value_labels)
        # levels reports two fixed columns whatever the spec's prefixes are.
        if len(labels) != len(keys):
            labels = [str(k) for k in keys]
        sub.extend(labels)
        sub.append("n")
    return top, sub


def block(spec, rows, teachers):
    """One query's results as sheet rows, or a stated gap when it returned none.

    A block that produced nothing says so IN THE TAB. SKILL.md's contract is
    that anything the report cannot produce is written into the sheet; a
    silently absent block is what makes a workbook look complete when it is
    not.
    """
    out = [[spec["title"]]]
    if spec.get("note"):
        out.append([spec["note"]])
    if not rows:
        out.append([f"{EM_DASH} no data returned for this block"])
        out.append([BLANK])
        return out

    groups = groups_for(spec, teachers)
    value_labels = [label for _, label in spec["values"]]

    by_meas = {}
    for row in rows:
        by_meas.setdefault(str(row.get("meas") or ""), []).append(row)

    if spec["shape"] == "prof":
        # One row per measure, no quartiles: the measure IS the row, so the
        # header is written once for the whole block.
        top, sub = _headers(groups, value_labels, "Measure")
        out.append(top)
        out.append(sub)
        for meas in sorted(by_meas):
            out.append([meas] + _row_cells(by_meas[meas][0], groups))
        out.append([BLANK])
        return out

    for meas in sorted(by_meas):
        measure_rows = by_meas[meas]
        top, sub = _headers(groups, value_labels, meas)
        out.append(top)
        out.append(sub)
        if spec["shape"] == "subgroup":
            indexed = {str(r.get("lbl") or ""): r for r in measure_rows}
            labels = [lbl for lbl in SUBGROUP_ROWS if lbl in indexed]
            # Any label the query returned that we do not know about is still
            # printed — dropping a returned row would hide real students.
            labels += [lbl for lbl in sorted(indexed) if lbl not in SUBGROUP_ROWS]
            for label in labels:
                out.append([label] + _row_cells(indexed[label], groups))
        else:
            indexed = {str(r.get("qt") or ""): r for r in measure_rows}
            for label, key in QUARTILE_ROWS:
                out.append([label] + _row_cells(indexed.get(key), groups))
        out.append([BLANK])

    return out


def tab(school_name, grade, year_name, blocks, teachers, gaps=()):
    """A whole grade tab: title row, every block in spec order, then gaps."""
    values = [[f"{school_name} — Grade {grade_label(grade)} Growth by "
               f"Quartile ({year_name})"], [BLANK]]
    for spec, rows in blocks:
        values.extend(block(spec, rows, teachers))
    if gaps:
        values.append(["Not included in this report"])
        values.extend([[str(gap)] for gap in gaps])
    return values


def body_for(title, values):
    """The exact `sheets spreadsheets values batchUpdate` request body.

    RAW, and emitted whole, so nothing downstream reshapes it — that
    reshaping step is what the model used to hand-write, and where the write
    tool's literal-newline bug kept landing after every number was already in.
    """
    return {
        "valueInputOption": "RAW",
        "data": [{"range": f"'{title}'!A1", "values": values}],
    }
