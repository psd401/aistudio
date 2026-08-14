#!/usr/bin/env python3
"""Emit a compressed VALUES body for the `norms` CTE.

The full table is 10,674 rows; a query only ever needs the cut points for the
measures and windows it touches, and only the rows where the percentile
actually changes. That is ~60-100 rows per measure-window, which inlines fine.

Usage:
  norms_values.py --grade 3 --period Fall --period Spring \
                  --measure ORF-WRC --measure NWF-CLS
  norms_values.py --grade 3 --period Fall --measure ORF-WRC --as "ORF Words Correct"

`--as` re-labels the emitted measure so it can be joined directly against the
warehouse's own `assessment_group` value. Confirm those strings with psd-data
before generating — the norms file uses UO's names (ORF-WRC, NWF-CLS), which
are not guaranteed to match what the warehouse stores.
"""
import argparse
import csv
import os
import sys

NORMS = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "references",
    "dibels8_norms_2021-22.csv",
)


def load(path):
    with open(path, newline="") as handle:
        for row in csv.DictReader(handle):
            yield row


def compress(points):
    """Keep only rows where the percentile changes, plus the first row.

    The lookup is `WHERE cut <= score ORDER BY cut DESC LIMIT 1`, so a run of
    identical percentiles is fully represented by its lowest raw score.
    """
    points.sort()
    kept = [points[0]]
    for raw, pr in points[1:]:
        if pr != kept[-1][1]:
            kept.append((raw, pr))
    return kept


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--grade", required=True)
    parser.add_argument("--period", action="append", required=True)
    parser.add_argument("--measure", action="append", required=True)
    parser.add_argument("--as", dest="label", action="append", default=[])
    parser.add_argument("--norms", default=NORMS)
    args = parser.parse_args()

    if args.label and len(args.label) != len(args.measure):
        print("--as must be given once per --measure, in the same order", file=sys.stderr)
        return 2
    labels = dict(zip(args.measure, args.label)) if args.label else {}

    grade = str(int(float(args.grade)))
    wanted = {(m, p) for m in args.measure for p in args.period}
    buckets = {key: [] for key in wanted}

    for row in load(args.norms):
        key = (row["measure"], row["period"])
        if key not in buckets:
            continue
        if str(int(float(row["grade"]))) != grade:
            continue
        buckets[key].append((float(row["raw"]), int(float(row["percentile"]))))

    missing = [k for k, v in buckets.items() if not v]
    if missing:
        # Loud, not silent: a measure-window with no norms would otherwise
        # produce a query whose PR columns are quietly all NULL.
        for measure, period in sorted(missing):
            print(
                f"no norms for measure={measure} grade={grade} period={period}",
                file=sys.stderr,
            )
        return 1

    lines = []
    for (measure, period), points in sorted(buckets.items()):
        name = labels.get(measure, measure)
        for raw, pr in compress(points):
            value = int(raw) if float(raw).is_integer() else raw
            lines.append(f"('{name}','{period}',{value},{pr})")
    print(",\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
