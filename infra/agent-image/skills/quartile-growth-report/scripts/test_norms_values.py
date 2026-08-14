"""Tests for the norms VALUES generator.

These numbers become national percentile ranks in a report a principal reads as
fact, so the compression must be lossless and a missing measure must fail loudly
rather than yield silently-NULL PR columns.
"""
import bisect
import csv
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "norms_values.py")
NORMS = os.path.join(os.path.dirname(HERE), "references", "dibels8_norms_2021-22.csv")


def run(*args):
    return subprocess.run(
        [sys.executable, SCRIPT, *args], capture_output=True, text=True
    )


def full_table():
    table = {}
    with open(NORMS, newline="") as handle:
        for row in csv.DictReader(handle):
            key = (row["measure"], str(int(float(row["grade"]))), row["period"])
            table.setdefault(key, []).append(
                (float(row["raw"]), int(float(row["percentile"])))
            )
    return table


class NormsValuesTest(unittest.TestCase):
    def test_emitted_rows_reproduce_every_percentile(self):
        # The generator drops rows where the percentile is unchanged. Walk every
        # raw score in the full table through the SQL lookup semantics
        # (`cut <= score ORDER BY cut DESC LIMIT 1`) and require an exact match.
        table = full_table()
        for (measure, grade, period), points in table.items():
            result = run("--grade", grade, "--period", period, "--measure", measure)
            self.assertEqual(result.returncode, 0, result.stderr)
            cuts, prs = [], []
            for line in result.stdout.strip().rstrip(",").split(",\n"):
                _, _, raw, pr = line.strip("()").split(",")
                cuts.append(float(raw))
                prs.append(int(pr))
            for raw, expected in sorted(points):
                index = bisect.bisect_right(cuts, raw) - 1
                self.assertGreaterEqual(index, 0, f"{measure} {grade} {period} {raw}")
                self.assertEqual(
                    prs[index], expected, f"{measure} g{grade} {period} raw={raw}"
                )

    def test_above_range_score_clamps_to_99(self):
        result = run("--grade", "3", "--period", "Spring", "--measure", "ORF-WRC")
        last = result.stdout.strip().rstrip(",").split(",\n")[-1]
        self.assertTrue(last.endswith(",99)"), last)

    def test_relabel_matches_the_warehouse_name(self):
        # The norms file uses UO's names; the join is against the warehouse's
        # assessment_group, which may differ.
        result = run(
            "--grade", "3", "--period", "Fall", "--measure", "ORF-WRC",
            "--as", "ORF Words Correct",
        )
        self.assertIn("('ORF Words Correct','Fall'", result.stdout)
        self.assertNotIn("('ORF-WRC'", result.stdout)

    def test_missing_measure_window_fails_loudly(self):
        # Silently emitting nothing would produce a query whose PR columns are
        # all NULL, which reads as "no growth" rather than "no norms".
        result = run("--grade", "3", "--period", "Fall", "--measure", "NOT-A-MEASURE")
        self.assertEqual(result.returncode, 1)
        self.assertIn("no norms for", result.stderr)

    def test_mismatched_as_count_is_rejected(self):
        result = run(
            "--grade", "3", "--period", "Fall",
            "--measure", "ORF-WRC", "--measure", "PSF", "--as", "only one",
        )
        self.assertEqual(result.returncode, 2)


if __name__ == "__main__":
    unittest.main()
