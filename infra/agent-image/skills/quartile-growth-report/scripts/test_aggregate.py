"""Tests for aggregate.py — the quartile/PR work moved out of the warehouse.

The two things worth pinning are the ones that fail silently against the
validation workbook rather than raising: Postgres NTILE's remainder rule, and
the largest-cut-<=-score percentile lookup.

Run:
    uv run --python 3.12 --no-project python3 -m unittest \
      infra/agent-image/skills/quartile-growth-report/scripts/test_aggregate.py
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import aggregate  # noqa: E402

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "aggregate.py")


def rows_of(pairs, meas="ORF-WRC", in_sch=True, sectionid="S1"):
    """pairs: (studentid, baseline, spring)."""
    return [
        {
            "meas": meas,
            "studentid": sid,
            "b": b,
            "e": e,
            "in_sch": in_sch,
            "sectionid": sectionid,
        }
        for sid, b, e in pairs
    ]


class NtileMatchesPostgres(unittest.TestCase):
    def buckets(self, n, k=4):
        assigned = aggregate.ntile([{"i": i} for i in range(n)], k)
        sizes = [0] * k
        for _, bucket in assigned:
            sizes[bucket - 1] += 1
        return sizes

    def test_even_split(self):
        self.assertEqual(self.buckets(12), [3, 3, 3, 3])

    def test_remainder_goes_to_the_earliest_buckets(self):
        # Postgres gives the extra rows to the FIRST buckets. Splitting evenly
        # and appending the remainder would move students between quartiles on
        # any partition whose size is not a multiple of four.
        self.assertEqual(self.buckets(13), [4, 3, 3, 3])
        self.assertEqual(self.buckets(14), [4, 4, 3, 3])
        self.assertEqual(self.buckets(15), [4, 4, 4, 3])

    def test_fewer_rows_than_buckets(self):
        # Postgres fills one row per bucket until it runs out.
        self.assertEqual(self.buckets(2), [1, 1, 0, 0])

    def test_every_row_is_assigned_exactly_once(self):
        for n in range(1, 40):
            assigned = aggregate.ntile([{"i": i} for i in range(n)], 4)
            self.assertEqual(len(assigned), n)
            self.assertEqual(len({id(r) for r, _ in assigned}), n)

    def test_empty_partition(self):
        self.assertEqual(aggregate.ntile([], 4), [])


class OrderingIsDeterministic(unittest.TestCase):
    def test_studentid_breaks_ties_on_equal_baseline(self):
        # Without the tiebreak, quartile membership is nondeterministic across
        # runs; a re-run once moved 19 of 100 quartile cells.
        tied = [{"b": 10, "studentid": s} for s in ("c", "a", "b")]
        self.assertEqual(
            [r["studentid"] for r in sorted(tied, key=aggregate.order_key)],
            ["a", "b", "c"],
        )

    def test_numeric_studentids_sort_numerically_like_postgres(self):
        # Postgres orders a numeric studentid column as a number: 9 before 10.
        # str() would order lexically and put 10 first, picking a different
        # student at the quartile boundary on any baseline tie.
        tied = [{"b": 1, "studentid": 10}, {"b": 1, "studentid": 9}]
        ordered = sorted(tied, key=aggregate.order_key)
        self.assertEqual([r["studentid"] for r in ordered], [9, 10])

    def test_numeric_strings_also_sort_numerically(self):
        tied = [{"b": 1, "studentid": "100"}, {"b": 1, "studentid": "99"}]
        ordered = sorted(tied, key=aggregate.order_key)
        self.assertEqual([r["studentid"] for r in ordered], ["99", "100"])

    def test_alphanumeric_ids_still_sort(self):
        tied = [{"b": 1, "studentid": "b7"}, {"b": 1, "studentid": "a3"}]
        ordered = sorted(tied, key=aggregate.order_key)
        self.assertEqual([r["studentid"] for r in ordered], ["a3", "b7"])

    def test_null_baseline_raises_instead_of_TypeError(self):
        with self.assertRaises(ValueError):
            aggregate.order_key({"b": None, "studentid": "a"})


class NormsAreScopedByGrade(unittest.TestCase):
    """The same measure has different cut points per grade.

    Fall ORF-WRC is 188 cuts topping at raw 187 for grade 3, and 206 topping at
    205 for grade 5. A lookup that ignores grade returns whichever grade's cut
    happened to be largest at or below the score — silently wrong, never
    raising. Asserting only that a percentile is non-null would not catch it,
    so these pin actual values from the shipped CSV.
    """

    @classmethod
    def setUpClass(cls):
        cls.norms = aggregate.load_norms(aggregate.NORMS)

    def test_the_same_score_scores_differently_by_grade(self):
        g3 = self.norms["ORF-WRC"]["3"]["Fall"]
        g5 = self.norms["ORF-WRC"]["5"]["Fall"]
        score = 100.0
        self.assertNotEqual(
            aggregate.percentile_for(g3, score),
            aggregate.percentile_for(g5, score),
            "grade 3 and grade 5 must not share a cut table",
        )

    def test_grade_tables_have_their_own_ceilings(self):
        self.assertEqual(max(c for c, _ in self.norms["ORF-WRC"]["3"]["Fall"]), 187.0)
        self.assertEqual(max(c for c, _ in self.norms["ORF-WRC"]["5"]["Fall"]), 205.0)

    def test_grade_is_normalized_from_the_csvs_float_form(self):
        self.assertEqual(aggregate.normalize_grade("3.0"), "3")
        self.assertEqual(aggregate.normalize_grade(3), "3")
        self.assertEqual(aggregate.normalize_grade("K"), "K")


class PercentileLookup(unittest.TestCase):
    points = [(0.0, 1.0), (10.0, 25.0), (20.0, 50.0), (30.0, 75.0)]

    def test_picks_the_largest_cut_at_or_below_the_score(self):
        self.assertEqual(aggregate.percentile_for(self.points, 24), 50.0)

    def test_exact_cut_matches_its_own_row(self):
        self.assertEqual(aggregate.percentile_for(self.points, 20), 50.0)

    def test_score_above_every_cut_takes_the_last(self):
        self.assertEqual(aggregate.percentile_for(self.points, 999), 75.0)

    def test_score_below_every_cut_is_none_not_a_floor(self):
        # Mirrors the LEFT JOIN returning null rather than inventing a 1.
        self.assertIsNone(aggregate.percentile_for([(5.0, 1.0)], 4))

    def test_missing_score_or_table(self):
        self.assertIsNone(aggregate.percentile_for(self.points, None))
        self.assertIsNone(aggregate.percentile_for([], 10))


class Rollups(unittest.TestCase):
    def test_quartiles_are_local_to_each_partition(self):
        # A class rollup must quartile within the section, not across sections
        # — that is what made the SQL's FILTER safe and must survive the move.
        rows = rows_of([("a", 1, 2), ("b", 2, 4)], sectionid="S1") + rows_of(
            [("c", 100, 101), ("d", 200, 204)], sectionid="S2"
        )
        for row in rows:
            row["prb"] = row["pre"] = None
        out = aggregate.rollup(rows, "class", lambda r: (r["meas"], r["sectionid"]))
        firsts = [r for r in out if r["qt"] == "1"]
        # Each section contributes its own bucket 1, so the low scorer in S2
        # (100) lands in bucket 1 despite dwarfing every S1 score.
        self.assertEqual(sum(r["n"] for r in firsts), 2)

    def test_all_row_covers_every_member(self):
        rows = rows_of([("a", 1, 2), ("b", 2, 4), ("c", 3, 3), ("d", 4, 8)])
        for row in rows:
            row["prb"] = row["pre"] = None
        out = aggregate.rollup(rows, "district", lambda r: r["meas"])
        all_row = next(r for r in out if r["qt"] == "All")
        self.assertEqual(all_row["n"], 4)
        # growth = mean(1,2,0,4) = 1.75 -> 1.8 at one decimal
        self.assertEqual(all_row["growth"], 1.8)

    def test_missing_spring_scores_do_not_poison_the_mean(self):
        rows = rows_of([("a", 1, 3), ("b", 2, None)])
        for row in rows:
            row["prb"] = row["pre"] = None
        out = aggregate.rollup(rows, "district", lambda r: r["meas"])
        all_row = next(r for r in out if r["qt"] == "All")
        self.assertEqual(all_row["growth"], 2.0)  # only student a contributes
        self.assertEqual(all_row["n"], 2)  # but both are counted


class RoundingMatchesPostgres(unittest.TestCase):
    """Values verified against Postgres ROUND(numeric) on 2026-08-15."""

    def test_half_goes_away_from_zero(self):
        self.assertEqual(aggregate.pg_round(12.5), 13)
        self.assertEqual(aggregate.pg_round(0.5), 1)
        self.assertEqual(aggregate.pg_round(-12.5), -13)

    def test_agrees_with_python_where_python_is_right(self):
        self.assertEqual(aggregate.pg_round(25.5), 26)
        self.assertEqual(aggregate.pg_round(1.5), 2)

    def test_one_decimal_boundary(self):
        self.assertEqual(aggregate.pg_round(1.05, 1), 1.1)
        self.assertEqual(aggregate.pg_round(-1.05, 1), -1.1)

    def test_none_passes_through(self):
        self.assertIsNone(aggregate.pg_round(None))
        self.assertIsNone(aggregate.pg_round(None, 1))


class Levels(unittest.TestCase):
    """The mini-tables and the Fall-only report read levels, not deltas."""

    def cells(self, rows):
        return aggregate.rollup(rows, "district", lambda r: r["meas"])

    def test_raw_levels_average_the_values_themselves(self):
        rows = rows_of([("a", 10, 20), ("b", 30, 50)])
        for row in rows:
            row["prb"] = row["pre"] = None
        all_row = next(r for r in self.cells(rows) if r["qt"] == "All")
        self.assertEqual(all_row["start_raw"], 20.0)
        self.assertEqual(all_row["end_raw"], 35.0)

    def test_pr_levels_round_half_away_from_zero_like_postgres(self):
        # Python's round() is banker's: round(12.5) is 12. Postgres answers 13.
        # These values were rounded by ROUND() inside the query before, so the
        # Python default would move levels by one against the validation
        # workbook, on exactly the .5 boundaries someone would spot-check.
        rows = rows_of([("a", 1, 2), ("b", 3, 4)])
        rows[0]["prb"], rows[0]["pre"] = 10.0, 20.0
        rows[1]["prb"], rows[1]["pre"] = 15.0, 31.0
        all_row = next(r for r in self.cells(rows) if r["qt"] == "All")
        self.assertEqual(all_row["start_pr"], 13)  # mean 12.5 -> 13, not 12
        self.assertEqual(all_row["end_pr"], 26)  # mean 25.5 -> 26

    def test_fall_only_rows_still_report_a_start(self):
        # No spring score anywhere: deltas are undefined but Start must survive.
        rows = rows_of([("a", 10, None), ("b", 20, None)])
        for row in rows:
            row["prb"] = 40.0
            row["pre"] = None
        all_row = next(r for r in self.cells(rows) if r["qt"] == "All")
        self.assertIsNone(all_row["growth"])
        self.assertEqual(all_row["start_raw"], 15.0)
        self.assertEqual(all_row["start_pr"], 40)
        self.assertIsNone(all_row["end_raw"])


class EndToEnd(unittest.TestCase):
    def run_script(self, rows, *extra):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
            json.dump(rows, fh)
            path = fh.name
        try:
            proc = subprocess.run(
                [sys.executable, SCRIPT, "--rows", path, *extra],
                capture_output=True,
                text=True,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            return json.loads(proc.stdout)
        finally:
            os.unlink(path)

    def test_no_norms_mode_emits_growth_without_pr(self):
        out = self.run_script(rows_of([("a", 1, 2), ("b", 5, 9)]), "--no-norms")
        self.assertTrue(out)
        self.assertTrue(all(r["pr_growth"] is None for r in out))
        self.assertTrue(any(r["growth"] is not None for r in out))

    def test_all_three_scopes_are_emitted(self):
        out = self.run_script(rows_of([("a", 1, 2), ("b", 5, 9)]), "--no-norms")
        self.assertEqual({r["scope"] for r in out}, {"district", "school", "class"})

    def test_rows_outside_the_school_are_district_only(self):
        rows = rows_of([("a", 1, 2)], in_sch=False, sectionid=None)
        out = self.run_script(rows, "--no-norms")
        self.assertEqual({r["scope"] for r in out}, {"district"})

    def test_empty_input_is_not_an_error(self):
        self.assertEqual(self.run_script([], "--no-norms"), [])

    def test_jsonl_input_is_accepted(self):
        rows = rows_of([("a", 1, 2), ("b", 5, 9)])
        proc = subprocess.run(
            [sys.executable, SCRIPT, "--no-norms"],
            input="\n".join(json.dumps(r) for r in rows),
            capture_output=True,
            text=True,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue(json.loads(proc.stdout))

    def test_real_norms_file_produces_percentile_growth(self):
        # Exercises the shipped CSV, not a fixture: ORF-WRC grade 3 exists in
        # the UO norms, so a real baseline/spring pair must yield a PR delta.
        rows = rows_of([("a", 20.0, 60.0), ("b", 30.0, 90.0)])
        out = self.run_script(rows, "--grade", "3", "--measure-as", "ORF-WRC=ORF-WRC")
        district_all = next(
            r for r in out if r["scope"] == "district" and r["qt"] == "All"
        )
        self.assertIsNotNone(district_all["pr_growth"])

    def test_the_same_scores_score_differently_at_a_different_grade(self):
        # End-to-end proof that --grade is actually threaded through: identical
        # input, different --grade, different percentile growth. Before this
        # fix --grade was parsed and never used, so both runs agreed.
        rows = rows_of([("a", 20.0, 60.0), ("b", 30.0, 90.0)])
        args = ("--measure-as", "ORF-WRC=ORF-WRC")
        g3 = self.run_script(rows, "--grade", "3", *args)
        g5 = self.run_script(rows, "--grade", "5", *args)
        pr3 = next(r for r in g3 if r["scope"] == "district" and r["qt"] == "All")
        pr5 = next(r for r in g5 if r["scope"] == "district" and r["qt"] == "All")
        self.assertNotEqual(pr3["pr_growth"], pr5["pr_growth"])

    def test_missing_grade_is_refused_rather_than_guessed(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
            json.dump(rows_of([("a", 20.0, 60.0)]), fh)
            path = fh.name
        try:
            proc = subprocess.run(
                [sys.executable, SCRIPT, "--rows", path],
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn("--grade is required", proc.stderr)
        finally:
            os.unlink(path)

    def test_a_grade_with_no_norms_fails_loudly(self):
        # A silent null percentile for every student would read as missing
        # data rather than a wrong invocation.
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
            json.dump(rows_of([("a", 20.0, 60.0)]), fh)
            path = fh.name
        try:
            proc = subprocess.run(
                [sys.executable, SCRIPT, "--rows", path, "--grade", "42",
                 "--measure-as", "ORF-WRC=ORF-WRC"],
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn("no norms for measure", proc.stderr)
        finally:
            os.unlink(path)

    def run_expecting_failure(self, rows, *extra):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
            json.dump(rows, fh)
            path = fh.name
        try:
            proc = subprocess.run(
                [sys.executable, SCRIPT, "--rows", path, *extra],
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(proc.returncode, 0, proc.stdout)
            return proc.stderr
        finally:
            os.unlink(path)

    def test_a_measure_with_no_norms_fails_loudly(self):
        # The same silent-null failure as an unmatched grade, one level up: a
        # measure the norms file has never heard of scored every student null.
        err = self.run_expecting_failure(
            rows_of([("a", 20.0, 60.0)], meas="I-READY-READING"), "--grade", "3"
        )
        self.assertIn("no norms for measure 'I-READY-READING'", err)
        self.assertIn("available measures:", err)

    def test_a_mistyped_measure_alias_fails_loudly(self):
        # A typo in --measure-as is the likeliest way to reach the above.
        err = self.run_expecting_failure(
            rows_of([("a", 20.0, 60.0)]),
            "--grade", "3",
            "--measure-as", "ORF-WRC=ORF_WRC",
        )
        self.assertIn("no norms for measure 'ORF_WRC'", err)
        self.assertIn("--no-norms", err)

    def test_an_unnormed_measure_still_runs_under_no_norms(self):
        # --no-norms remains the documented escape hatch for i-Ready/SBA, so
        # the new guard must not fire there.
        out = self.run_script(
            rows_of([("a", 1, 2), ("b", 5, 9)], meas="I-READY-READING"), "--no-norms"
        )
        self.assertTrue(out)
        self.assertTrue(all(r["pr_growth"] is None for r in out))


if __name__ == "__main__":
    unittest.main()
