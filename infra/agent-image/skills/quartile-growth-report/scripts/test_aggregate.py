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

    def test_float_shaped_ids_sort_numerically_too(self):
        # A JSON-decoded studentid can arrive as 10.0. int("10.0") raises, so
        # without the float() hop these fall into the string branch and sort
        # lexically — 10.0 before 9.0, the tiebreak bug one form further out.
        tied = [{"b": 1, "studentid": 10.0}, {"b": 1, "studentid": 9.0}]
        ordered = sorted(tied, key=aggregate.order_key)
        self.assertEqual([r["studentid"] for r in ordered], [9.0, 10.0])
        # and a float-shaped id ties with its integer form, not against it
        self.assertEqual(
            aggregate.order_key({"b": 1, "studentid": "10.0"}),
            aggregate.order_key({"b": 1, "studentid": 10}),
        )

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

    def test_grade_K_is_kindergarten_not_a_literal_K(self):
        # The norms file stores kindergarten as grade 0 and SKILL.md labels the
        # tabs K-5, so --grade K is what an agent passes. Returning a literal
        # "K" keys nothing in the table — every K report would fail.
        # norms_values.py has the same mapping; the two must not diverge.
        self.assertEqual(aggregate.normalize_grade("K"), "0")
        self.assertEqual(aggregate.normalize_grade("k"), "0")
        self.assertEqual(
            aggregate.normalize_grade("K"), aggregate.normalize_grade("0")
        )


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
            self.assertIn("no norms at grade '42'", proc.stderr)
            self.assertIn("ORF-WRC", proc.stderr)
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
        self.assertIn("I-READY-READING", err)
        self.assertIn("no norms at grade '3' for any requested measure", err)
        # The message must show what the file does have, so the operator can
        # see the name it expected rather than guessing.
        self.assertIn("ORF-WRC", err)

    def test_a_mistyped_measure_alias_fails_loudly(self):
        # A typo in --measure-as is the likeliest way to reach the above.
        err = self.run_expecting_failure(
            rows_of([("a", 20.0, 60.0)]),
            "--grade", "3",
            "--measure-as", "ORF-WRC=ORF_WRC",
        )
        self.assertIn("ORF_WRC", err)
        self.assertIn("no norms at grade '3' for any requested measure", err)
        self.assertIn("--no-norms", err)

    def test_grade_K_scores_against_kindergarten_norms(self):
        # End-to-end counterpart: --grade K must behave exactly like --grade 0,
        # not die in the no-norms guard. LNF is a K measure in the shipped file.
        rows = rows_of([("a", 10.0, 40.0), ("b", 20.0, 55.0)], meas="LNF")
        args = ("--measure-as", "LNF=LNF")
        k = self.run_script(rows, "--grade", "K", *args)
        zero = self.run_script(rows, "--grade", "0", *args)
        self.assertEqual(k, zero)
        district_all = next(
            r for r in k if r["scope"] == "district" and r["qt"] == "All"
        )
        self.assertIsNotNone(district_all["pr_growth"])

    def test_one_unnormed_measure_does_not_abort_the_normed_ones(self):
        # LNF has no grade-3 norms, ORF-WRC does. SKILL.md: a measure-window
        # missing from the file emits raw change only "and say so" — so the
        # run must survive, warn on stderr, and still score ORF-WRC.
        rows = rows_of([("a", 20.0, 60.0)]) + rows_of([("b", 30.0, 50.0)], meas="LNF")
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
            json.dump(rows, fh)
            path = fh.name
        try:
            proc = subprocess.run(
                [sys.executable, SCRIPT, "--rows", path, "--grade", "3"],
                capture_output=True,
                text=True,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertIn("no norms for measure 'LNF' at grade '3'", proc.stderr)
            self.assertIn("raw change only", proc.stderr)
            out = json.loads(proc.stdout)
        finally:
            os.unlink(path)
        by_meas = {
            r["meas"]: r
            for r in out
            if r["scope"] == "district" and r["qt"] == "All"
        }
        self.assertIsNotNone(by_meas["ORF-WRC"]["start_pr"])
        self.assertIsNone(by_meas["LNF"]["start_pr"])
        self.assertIsNotNone(by_meas["LNF"]["start_raw"])

    def test_a_null_baseline_is_diagnosable_not_a_traceback(self):
        # order_key still raises (its own invariant, unit-tested above), but
        # the operator is an agent reading stderr — a traceback out of
        # sorted() is not actionable, so main() catches it up front.
        rows = rows_of([("a", 20.0, 60.0)]) + [
            {"meas": "ORF-WRC", "studentid": "b", "b": None, "e": 40.0,
             "in_sch": True, "sectionid": "S1"}
        ]
        err = self.run_expecting_failure(rows, "--grade", "3")
        self.assertIn("null baseline", err)
        self.assertIn("extraction query must not return null b", err)
        self.assertNotIn("Traceback", err)

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


class TextCastColumnsAreParsedBack(unittest.TestCase):
    """references/sql.md casts every numeric and boolean column to ::text.

    psd-data's export mode fails on decimal, integer and boolean columns, so
    the extraction query is required to cast them. That means b/e/in_sch arrive
    as strings — and a string baseline sorts lexically ('9' after '100'),
    silently reordering the quartile boundary instead of raising.
    """

    def test_numeric_strings_become_numbers(self):
        row = aggregate.coerce_row({"b": "12.5", "e": "20"})
        self.assertEqual(row["b"], 12.5)
        self.assertEqual(row["e"], 20.0)

    def test_string_baselines_would_otherwise_sort_lexically(self):
        rows = [{"b": "100", "studentid": 1}, {"b": "9", "studentid": 2}]
        for row in rows:
            aggregate.coerce_row(row)
        ordered = sorted(rows, key=aggregate.order_key)
        self.assertEqual([r["b"] for r in ordered], [9.0, 100.0])

    def test_boolean_text_forms(self):
        for text in ("true", "t", "TRUE", "yes", "1"):
            self.assertIs(aggregate.coerce_row({"b": 1, "in_sch": text})["in_sch"], True)
        for text in ("false", "f", "FALSE", "no", "0", ""):
            self.assertIs(
                aggregate.coerce_row({"b": 1, "in_sch": text})["in_sch"], False
            )

    def test_empty_text_becomes_null_not_zero(self):
        # An empty spring score must stay missing; 0.0 would be a real score
        # and would drag every growth average toward a fabricated decline.
        self.assertIsNone(aggregate.coerce_row({"b": "1", "e": ""})["e"])
        self.assertIsNone(aggregate.coerce_row({"b": "1", "sectionid": ""})["sectionid"])

    def test_already_typed_values_pass_through(self):
        row = aggregate.coerce_row({"b": 1.5, "e": None, "in_sch": True})
        self.assertEqual(row["b"], 1.5)
        self.assertIsNone(row["e"])
        self.assertIs(row["in_sch"], True)

    def test_end_to_end_with_every_column_as_text(self):
        rows = [
            {"meas": "ORF-WRC", "studentid": "9", "b": "10", "e": "20",
             "in_sch": "true", "sectionid": "S1"},
            {"meas": "ORF-WRC", "studentid": "100", "b": "30", "e": "50",
             "in_sch": "t", "sectionid": "S1"},
        ]
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
            json.dump(rows, fh)
            path = fh.name
        try:
            proc = subprocess.run(
                [sys.executable, SCRIPT, "--rows", path, "--no-norms"],
                capture_output=True, text=True,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            out = json.loads(proc.stdout)
            school = [r for r in out if r["scope"] == "school"]
            self.assertTrue(school, "in_sch text must resolve to a real boolean")
            all_row = next(r for r in school if r["qt"] == "All")
            self.assertEqual(all_row["growth"], 15.0)
        finally:
            os.unlink(path)


class CsvInputNeedsNoGlueScript(unittest.TestCase):
    """psd-data exports CSV; requiring JSON forced a hand-written converter.

    That glue is where runs kept dying — the write tool emits literal \\n into
    helper scripts, producing a SyntaxError and a retry loop (agent_failures
    6804, and again mid-report 2026-08-15). Reading the export directly removes
    the script rather than warning about it again.
    """

    def run_on(self, text, *extra, suffix=".csv"):
        with tempfile.NamedTemporaryFile("w", suffix=suffix, delete=False) as fh:
            fh.write(text)
            path = fh.name
        try:
            proc = subprocess.run(
                [sys.executable, SCRIPT, "--rows", path, *extra],
                capture_output=True, text=True,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            return json.loads(proc.stdout)
        finally:
            os.unlink(path)

    CSV = (
        "meas,studentid,b,e,sectionid,in_sch\n"
        "ORF-WRC,9,10,20,S1,true\n"
        "ORF-WRC,100,30,50,S1,t\n"
    )

    def test_csv_export_is_read_directly(self):
        out = self.run_on(self.CSV, "--no-norms")
        cell = next(r for r in out if r["scope"] == "district" and r["qt"] == "All")
        self.assertEqual(cell["growth"], 15.0)
        self.assertEqual(cell["n"], 2)

    def test_csv_text_columns_are_coerced_like_json(self):
        # Everything arrives as text from CSV, so the numeric/boolean coercion
        # has to apply on this path too — otherwise b sorts lexically.
        out = self.run_on(self.CSV, "--no-norms")
        self.assertIn("school", {r["scope"] for r in out})

    def test_detection_is_by_content_not_extension(self):
        # The export filename is not always .csv.
        out = self.run_on(self.CSV, "--no-norms", suffix=".txt")
        self.assertTrue(out)

    def test_json_array_still_works(self):
        rows = rows_of([("a", 1, 2), ("b", 5, 9)])
        out = self.run_on(json.dumps(rows), "--no-norms", suffix=".json")
        self.assertTrue(out)

    def test_jsonl_still_works(self):
        rows = rows_of([("a", 1, 2), ("b", 5, 9)])
        text = "\n".join(json.dumps(r) for r in rows)
        out = self.run_on(text, "--no-norms", suffix=".jsonl")
        self.assertTrue(out)

    def test_empty_csv_header_only(self):
        self.assertEqual(self.run_on("meas,studentid,b,e\n", "--no-norms"), [])


class SubgroupsAreScopedAndTriState(unittest.TestCase):
    """District subgroup rows must not be copies of the school rows.

    On 2026-08-15 every grade reported School and District identically for Low
    Income and Special Ed — grade K showed 18/18 against a district cohort of
    558. The flags were joined only for the report's own school, so the
    district cell WAS the school cell and its complement silently absorbed all
    540 unflagged district students. It looked like data.
    """

    ROWS = [
        {"meas": "ORF", "studentid": 1, "b": 10, "e": 20, "in_sch": True, "low_income": True},
        {"meas": "ORF", "studentid": 2, "b": 20, "e": 35, "in_sch": True, "low_income": False},
        {"meas": "ORF", "studentid": 3, "b": 30, "e": 40, "in_sch": False, "low_income": True},
        {"meas": "ORF", "studentid": 4, "b": 40, "e": 55, "in_sch": False, "low_income": None},
    ]

    def cells(self):
        return aggregate.subgroup_rollups(
            [dict(r, prb=None, pre=None) for r in self.ROWS],
            "low_income", "Low Income", "Non-Low Income",
        )

    def test_district_is_wider_than_school(self):
        cells = self.cells()
        school = next(c for c in cells if c["scope"] == "school" and c["subgroup"] == "Low Income")
        district = next(c for c in cells if c["scope"] == "district" and c["subgroup"] == "Low Income")
        self.assertEqual(school["n"], 1)
        self.assertEqual(district["n"], 2)
        self.assertGreater(district["n"], school["n"])

    def test_missing_flag_is_excluded_not_counted_as_negative(self):
        # Student 4 has no flag record. Counting them as Non-Low Income is the
        # bug; a missing record is not evidence of anything.
        cells = self.cells()
        negative = next(
            c for c in cells
            if c["scope"] == "district" and c["subgroup"] == "Non-Low Income"
        )
        self.assertEqual(negative["n"], 1)

    def test_flag_value_tri_states(self):
        self.assertIs(aggregate.flag_value(True), True)
        self.assertIs(aggregate.flag_value("t"), True)
        self.assertIs(aggregate.flag_value("false"), False)
        self.assertIs(aggregate.flag_value(None), aggregate.UNKNOWN_FLAG)
        self.assertIs(aggregate.flag_value(""), aggregate.UNKNOWN_FLAG)
        self.assertIs(aggregate.flag_value("maybe"), aggregate.UNKNOWN_FLAG)

    def test_identical_school_and_district_is_flagged(self):
        # The fingerprint of a school-only flag join.
        same = [
            {"meas": "ORF", "scope": "school", "qt": "All", "subgroup": "Low Income",
             "n": 18, "growth": 19.9},
            {"meas": "ORF", "scope": "district", "qt": "All", "subgroup": "Low Income",
             "n": 18, "growth": 19.9},
        ]
        self.assertEqual(aggregate.subgroup_scope_warning(same), ["ORF/Low Income"])

    def test_properly_scoped_subgroups_are_not_flagged(self):
        ok = [
            {"meas": "ORF", "scope": "school", "qt": "All", "subgroup": "Low Income",
             "n": 18, "growth": 19.9},
            {"meas": "ORF", "scope": "district", "qt": "All", "subgroup": "Low Income",
             "n": 402, "growth": 15.2},
        ]
        self.assertEqual(aggregate.subgroup_scope_warning(ok), [])


class MultipleSectionsStaySeparate(unittest.TestCase):
    """Two homerooms must produce two sets of class cells, not one merged set.

    Keying cells on (meas, qt) alone merged every section's rows together:
    quartiles were still computed per section, but the OUTPUT collapsed across
    them, sectionid became ambiguous and resolved to None, and build_tab
    rendered ZERO teacher columns. Silently absent, not wrong — which is why
    a member-count assertion did not catch it.

    Found by the agent while running Minter Creek (self-reported failure 793,
    with a synthetic two-section repro).
    """

    ROWS = [
        {"meas": "ORF", "studentid": i, "b": b, "e": b + 5,
         "in_sch": True, "sectionid": sec, "prb": None, "pre": None}
        for i, (b, sec) in enumerate(
            [(10, "S1"), (20, "S1"), (30, "S1"), (40, "S1"),
             (15, "S2"), (25, "S2"), (35, "S2"), (45, "S2")], start=1
        )
    ]

    def cells(self):
        return aggregate.rollup(
            [dict(r) for r in self.ROWS], "class", lambda r: (r["meas"], r["sectionid"])
        )

    def test_each_section_gets_its_own_cells(self):
        sections = {c["sectionid"] for c in self.cells()}
        self.assertEqual(sections, {"S1", "S2"})

    def test_sectionid_is_never_none_when_sections_are_partitioned(self):
        # None is the symptom build_tab sees: it cannot name a column for a
        # cell whose section is unknown, so the column disappears.
        self.assertTrue(all(c["sectionid"] is not None for c in self.cells()))

    def test_each_section_has_its_own_All_row(self):
        alls = [c for c in self.cells() if c["qt"] == "All"]
        self.assertEqual(len(alls), 2)
        self.assertEqual({c["n"] for c in alls}, {4})

    def test_a_merged_key_would_have_produced_one_All_of_eight(self):
        # Pins the actual bug shape: before the fix this was a single cell of 8.
        alls = [c for c in self.cells() if c["qt"] == "All"]
        self.assertNotEqual([c["n"] for c in alls], [8])

    def test_district_scope_still_collapses_to_one_cell(self):
        # The fix must not split scopes that are meant to be single-partition.
        cells = aggregate.rollup(
            [dict(r) for r in self.ROWS], "district", lambda r: r["meas"]
        )
        alls = [c for c in cells if c["qt"] == "All"]
        self.assertEqual(len(alls), 1)
        self.assertEqual(alls[0]["n"], 8)
