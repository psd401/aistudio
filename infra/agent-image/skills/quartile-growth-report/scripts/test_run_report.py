"""The one-command report pipeline.

Every failure this report hit between 2026-08-14 and 2026-08-16 was
orchestration, never arithmetic: a no-op edit ending the run, assistant
messages fusing, a promoted job aborting its own run, `--export` timing out,
literal newline escapes in model-authored glue. This script exists to delete
that surface, so these tests pin the properties that make it deletable —
checkpoint resume, paging without export, a queried grade span, and SQL that
does not reintroduce the shapes that time out.

The two external CLIs (psd-data, psd-workspace) are stubbed. Everything
between them is the real code path.
"""

import json
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import run_report as R  # noqa: E402


class Checkpoints(unittest.TestCase):
    """A re-run must resume, not restart.

    The previous design had no checkpoints, so every interruption threw away
    everything — which is exactly what the user watched happen twice on
    2026-08-16, both times reported as "nothing has been written to the sheet".
    """

    def setUp(self):
        self.work = pathlib.Path(tempfile.mkdtemp())
        self.runs = 0

    def _produce(self):
        self.runs += 1
        return {"value": self.runs}

    def test_a_completed_step_is_not_recomputed(self):
        first = R.step(self.work, "s", self._produce, lambda m: None)
        second = R.step(self.work, "s", self._produce, lambda m: None)
        self.assertEqual(first, second)
        self.assertEqual(self.runs, 1)

    def test_a_truncated_checkpoint_is_discarded(self):
        # A half-written file from a killed run is not a checkpoint. Trusting
        # one would poison every later step with partial data.
        (self.work / "s.json").write_text('{"half')
        value = R.step(self.work, "s", self._produce, lambda m: None)
        self.assertEqual(value, {"value": 1})

    def test_the_checkpoint_survives_as_valid_json(self):
        R.step(self.work, "s", self._produce, lambda m: None)
        self.assertEqual(
            json.loads((self.work / "s.json").read_text()), {"value": 1}
        )


class Paging(unittest.TestCase):
    """`--export` is not used anywhere, on purpose.

    It timed out repeatedly on the grade-K extraction on 2026-08-16 while the
    same query in normal mode returned 2,232 rows in seconds, and it has a
    separate history of silently dropping numeric columns from the CSV.
    """

    def test_paging_stops_on_a_short_page(self):
        pages = [[{"r": i} for i in range(R.PAGE_SIZE)], [{"r": "last"}]]
        R.query = lambda *a, **k: pages.pop(0) if pages else []
        self.assertEqual(len(R.query_all("SELECT 1", "test")), R.PAGE_SIZE + 1)

    def test_paging_refuses_to_run_forever(self):
        # A query that never shortens is a bug somewhere else; looping until
        # the turn dies would hide it.
        R.query = lambda *a, **k: [{"r": i} for i in range(R.PAGE_SIZE)]
        with self.assertRaises(R.ReportError) as caught:
            R.query_all("SELECT 1", "runaway")
        self.assertIn("refusing to page forever", str(caught.exception))

    def test_export_is_never_requested(self):
        source = pathlib.Path(R.__file__).read_text()
        self.assertNotIn('"--export"', source)


class ExtractionSql(unittest.TestCase):
    """The only query shape that completes against dibels_scores.

    Window functions do not finish on this MCP at any size: a bare NTILE(4)
    over ~1,100 rows timed out on 2026-08-15 while the same query without it
    ran in seconds. Quartiles are computed locally by aggregate.py.
    """

    def _sql(self, grade="3", baseline="Fall"):
        return R.extraction_sql(1, 2, grade, ["ORF-WRC", "NWF-CLS"], baseline)

    def test_no_window_function_reaches_the_warehouse(self):
        upper = self._sql().upper()
        for banned in ("NTILE", "GROUPING SETS", "LATERAL", "OVER ("):
            self.assertNotIn(banned, upper, f"{banned} must stay out of SQL")

    def test_every_non_text_column_is_cast(self):
        # The export path drops unqualified numerics, and the boolean too.
        sql = self._sql()
        for column in ("m.studentid::text", "m.b::text", "m.e::text",
                       "hr.sectionid::text", "IS NOT NULL)::text"):
            self.assertIn(column, sql)

    def test_the_baseline_window_is_honored(self):
        # K has no Fall DIBELS; a Fall baseline there silently returns nothing.
        self.assertIn("'Winter'", self._sql(grade="K", baseline="Winter"))
        self.assertNotIn("'Fall'", self._sql(grade="K", baseline="Winter"))

    def test_kindergarten_defaults_to_a_winter_baseline(self):
        self.assertEqual(R.BASELINE_BY_GRADE.get("K"), "Winter")
        self.assertIsNone(R.BASELINE_BY_GRADE.get("3"))


class SqlEscaping(unittest.TestCase):
    def test_an_apostrophe_in_a_school_name_is_escaped(self):
        self.assertEqual(R.sql_escape("O'Brien"), "O''Brien")

    def test_the_escaped_name_reaches_the_query_intact(self):
        captured = {}

        def fake_query(sql, reason, **kwargs):
            captured["sql"] = sql
            return [{"schoolid": 1, "school_name": "O'Brien Elementary"}]

        R.query = fake_query
        R.resolve_school("O'Brien Elementary")
        self.assertIn("O''Brien Elementary", captured["sql"])


class SchoolResolution(unittest.TestCase):
    def test_an_ambiguous_name_refuses_rather_than_guessing(self):
        R.query = lambda *a, **k: [
            {"schoolid": 1, "school_name": "Harbor Ridge Middle"},
            {"schoolid": 2, "school_name": "Harbor Heights Elementary"},
        ]
        with self.assertRaises(R.ReportError) as caught:
            R.resolve_school("Harbor")
        self.assertIn("matched 2 schools", str(caught.exception))

    def test_an_exact_match_wins_over_a_substring_sibling(self):
        R.query = lambda *a, **k: [
            {"schoolid": 1, "school_name": "Artondale Elementary"},
            {"schoolid": 2, "school_name": "Artondale Elementary Annex"},
        ]
        self.assertEqual(
            R.resolve_school("Artondale Elementary")["schoolid"], 1
        )

    def test_no_match_is_an_error_not_an_empty_report(self):
        R.query = lambda *a, **k: []
        with self.assertRaises(R.ReportError):
            R.resolve_school("Nowhere Elementary")


class RosterDefinesTheGradeSpan(unittest.TestCase):
    """On 2026-08-15 the agent announced "Minter Creek is a K-2 school",
    invented the justification, and scoped a whole report to it. It is K-5.
    The span is a query result here, never an assertion.
    """

    ROWS = [
        {"sectionid": "1", "grade_level": "K", "teacher_name": "Hansen, Jane"},
        {"sectionid": "2", "grade_level": "1", "teacher_name": None},
        {"sectionid": "3", "grade_level": "5", "teacher_name": "Ruiz, Ana"},
    ]

    def test_the_span_comes_from_the_roster(self):
        R.query_all = lambda *a, **k: self.ROWS
        roster = R.fetch_roster(1, 2)
        self.assertEqual(sorted(roster["grades"]), ["1", "5", "K"])

    def test_a_section_with_no_lead_teacher_is_kept(self):
        # build_tab renders it "(Not on file)". Dropping the section would
        # silently remove a classroom column from the report.
        R.query_all = lambda *a, **k: self.ROWS
        roster = R.fetch_roster(1, 2)
        self.assertIn("2", roster["grades"]["1"])
        self.assertNotIn("2", roster["teachers"])

    def test_an_empty_roster_is_an_error(self):
        R.query_all = lambda *a, **k: []
        with self.assertRaises(R.ReportError):
            R.fetch_roster(1, 2)


if __name__ == "__main__":
    unittest.main()
