"""Tests for the norms VALUES generator.

These numbers become national percentile ranks in a report a principal reads as
fact, so the compression must be lossless and a missing measure must fail loudly
rather than yield silently-NULL PR columns.
"""
import bisect
import csv
import re
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

    def test_single_quote_in_a_label_is_escaped_not_injected(self):
        # `--as` carries a warehouse assessment_group the agent read back from
        # psd-data, so it is model-influenced input landing in a SQL literal.
        result = run(
            "--grade", "3", "--period", "Fall", "--measure", "ORF-WRC",
            "--as", "O'Brien Reading",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("('O''Brien Reading','Fall'", result.stdout)
        # No bare quote survives that could close the literal early.
        for line in result.stdout.strip().split("\n"):
            body = line.strip().rstrip(",")
            self.assertTrue(body.startswith("('") and body.endswith(")"), body)

    def test_injection_attempt_stays_inside_the_literal(self):
        payload = "x'),(SELECT 1)--"
        result = run(
            "--grade", "3", "--period", "Fall", "--measure", "ORF-WRC",
            "--as", payload,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        # The payload survives as DATA: its quote is doubled, so SQL reads the
        # whole thing as one string literal rather than a closed literal
        # followed by new syntax.
        self.assertIn("'" + payload.replace("'", "''") + "'", result.stdout)
        # Every emitted row is still exactly one 4-field tuple. Parsing back the
        # doubled quotes is what proves the statement was never closed early.
        for line in result.stdout.strip().split("\n"):
            body = line.strip().rstrip(",")
            self.assertTrue(body.startswith("(") and body.endswith(")"), body)
            # Outside the quoted label there must be exactly 3 commas.
            unquoted = re.sub(r"'(?:[^']|'')*'", "S", body[1:-1])
            self.assertEqual(unquoted.count(","), 3, body)

    def test_control_characters_and_backslashes_are_refused(self):
        for bad in ["line\nbreak", "back\\slash"]:
            result = run(
                "--grade", "3", "--period", "Fall", "--measure", "ORF-WRC",
                "--as", bad,
            )
            self.assertEqual(result.returncode, 2, result.stdout)
            self.assertIn("must not contain", result.stderr)

    def test_grade_K_is_accepted_as_kindergarten(self):
        # SKILL.md describes the report as K-5 and labels the tabs that way, so
        # `--grade K` is the natural token. The norms file stores K as 0.
        k = run("--grade", "K", "--period", "Fall", "--measure", "LNF")
        zero = run("--grade", "0", "--period", "Fall", "--measure", "LNF")
        self.assertEqual(k.returncode, 0, k.stderr)
        self.assertEqual(k.stdout, zero.stdout)

    def test_unparseable_grade_fails_with_a_message_not_a_traceback(self):
        result = run("--grade", "banana", "--period", "Fall", "--measure", "LNF")
        self.assertEqual(result.returncode, 2)
        self.assertIn("--grade must be K or a number", result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    def test_mismatched_as_count_is_rejected(self):
        result = run(
            "--grade", "3", "--period", "Fall",
            "--measure", "ORF-WRC", "--measure", "PSF", "--as", "only one",
        )
        self.assertEqual(result.returncode, 2)


if __name__ == "__main__":
    unittest.main()
