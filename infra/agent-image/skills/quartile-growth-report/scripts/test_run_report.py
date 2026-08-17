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

_PATCHABLE = ("query", "query_all", "run_json", "workspace")


class RestoresModuleFunctions(unittest.TestCase):
    """Stubs must not leak between tests.

    Patching R.query/R.query_all in place and leaving them there made the
    paging suite fail depending on test ORDER — a self-inflicted version of
    exactly the flakiness these tests exist to prevent.
    """

    def setUp(self):
        self._saved = {name: getattr(R, name) for name in _PATCHABLE}
        self.addCleanup(self._restore)

    def _restore(self):
        for name, value in self._saved.items():
            setattr(R, name, value)


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


class Paging(RestoresModuleFunctions):
    """`--export` is not used anywhere, on purpose.

    It timed out repeatedly on the grade-K extraction on 2026-08-16 while the
    same query in normal mode returned 2,232 rows in seconds, and it has a
    separate history of silently dropping numeric columns from the CSV.
    """

    def test_a_short_page_does_NOT_end_paging(self):
        # THE truncation bug. psd-data is documented as returning at most 30
        # rows per call, so asking for 5,000 and stopping when fewer arrive
        # would have ended after the first page — every extraction cut to 30
        # students, with quartiles over them looking entirely plausible.
        pages = [[{"r": 1}] * 30, [{"r": 2}] * 30, [{"r": 3}] * 7, []]
        R.query = lambda *a, **k: pages.pop(0) if pages else []
        self.assertEqual(len(R.query_all("SELECT 1", "capped")), 67)

    def test_paging_stops_on_an_empty_page(self):
        pages = [[{"r": 1}], []]
        R.query = lambda *a, **k: pages.pop(0) if pages else []
        self.assertEqual(len(R.query_all("SELECT 1", "test")), 1)

    def test_the_offset_follows_rows_received_not_the_page_size(self):
        # With a server cap, page N does not start at N * PAGE_SIZE.
        seen = []

        def fake(sql, reason, limit=None, offset=None):
            seen.append(offset)
            return [{"r": 1}] * 30 if len(seen) < 3 else []

        R.query = fake
        R.query_all("SELECT 1", "offsets")
        self.assertEqual(seen, [0, 30, 60])

    def test_paging_refuses_to_run_forever(self):
        R.query = lambda *a, **k: [{"r": i} for i in range(R.PAGE_SIZE)]
        with self.assertRaises(R.ReportError) as caught:
            R.query_all("SELECT 1", "runaway")
        self.assertIn("refusing to page forever", str(caught.exception))

    def test_a_count_mismatch_is_loud(self):
        # Silence here means a report whose every number is computed over a
        # fraction of the cohort.
        pages = [[{"r": 1}] * 30, []]
        R.query = lambda *a, **k: pages.pop(0) if pages else []
        with self.assertRaises(R.ReportError) as caught:
            R.query_all("SELECT 1", "extraction", expected=1706)
        self.assertIn("truncated", str(caught.exception))

    def test_a_matching_count_passes(self):
        pages = [[{"r": 1}] * 30, []]
        R.query = lambda *a, **k: pages.pop(0) if pages else []
        self.assertEqual(len(R.query_all("SELECT 1", "x", expected=30)), 30)

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
        # NTILE( with the paren: AVG(PERCENTILE) contains the substring
        # "NTILE", so the bare name matches the very column i-Ready reports on.
        for banned in ("NTILE(", "GROUPING SETS", "LATERAL", "OVER ("):
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

    def test_kindergarten_uses_a_winter_baseline_for_every_measure(self):
        # K DIBELS has no Fall administration at all.
        self.assertEqual(R.baseline_for("K", "ORF-WRC"), "Winter")
        self.assertEqual(R.baseline_for("K", "LNF"), "Winter")

    def test_grade_one_orf_is_winter_but_the_rest_of_grade_one_is_not(self):
        # ORF starts mid-year in grade 1 — and ONLY ORF. Applying one baseline
        # to the whole grade returns zero matched pairs for the odd measure,
        # which drops it from the tab with no error at all.
        self.assertEqual(R.baseline_for("1", "ORF-WRC"), "Winter")
        self.assertEqual(R.baseline_for("1", "NWF-CLS"), "Fall")

    def test_other_grades_are_fall_including_orf(self):
        self.assertEqual(R.baseline_for("3", "ORF-WRC"), "Fall")
        self.assertEqual(R.baseline_for("5", "NWF-CLS"), "Fall")

    def test_a_mixed_grade_runs_one_extraction_per_baseline(self):
        groups = R.group_by_baseline("1", ["ORF-WRC", "NWF-CLS", "PSF"])
        self.assertEqual(groups["Winter"], ["ORF-WRC"])
        self.assertEqual(sorted(groups["Fall"]), ["NWF-CLS", "PSF"])

    def test_a_uniform_grade_runs_a_single_extraction(self):
        groups = R.group_by_baseline("3", ["ORF-WRC", "NWF-CLS"])
        self.assertEqual(list(groups), ["Fall"])


class SqlEscaping(RestoresModuleFunctions):
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


class SchoolResolution(RestoresModuleFunctions):
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


class RosterDefinesTheGradeSpan(RestoresModuleFunctions):
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


class CommandStringsSurviveApostrophes(RestoresModuleFunctions):
    """psd-workspace's splitCommand has no escape syntax.

    Its own source records the live failure: "any content with an apostrophe,
    mixed quotes, or newlines cannot ride inside --command at all"
    (2026-07-06). `--params` has no file form, so anything spliced there must
    be quote-free by construction. The SQL path was already escaped; this is
    the same character arriving through the other door, and it would have
    broken the workbook AFTER every grade was extracted — a late failure in
    the script written to remove late failures.
    """

    def test_a_straight_apostrophe_never_reaches_a_command(self):
        self.assertNotIn("'", R.command_literal("O'Brien Elementary"))

    def test_the_name_still_reads_correctly(self):
        self.assertEqual(
            R.command_literal("O'Brien Elementary"),
            "O\u2019Brien Elementary",
        )

    def test_double_quotes_are_handled_too(self):
        self.assertNotIn('"', R.command_literal('The "Annex" School'))

    def test_newlines_cannot_split_a_token(self):
        self.assertEqual(R.command_literal("Harbor\nRidge"), "Harbor Ridge")

    def test_the_workbook_title_is_sanitised_before_it_is_spliced(self):
        seen = {}

        def fake_workspace(command, user, scope="agent", json_file=None):
            seen["command"] = command
            return {"spreadsheetId": "SHEET1"}

        R.workspace = fake_workspace
        R.create_workbook("O'Brien Elementary - Report (2025-26)", "u@psd401.net")
        self.assertNotIn("O'Brien", seen["command"])
        self.assertIn("Brien", seen["command"])

    def test_the_guard_refuses_a_command_it_cannot_quote(self):
        with self.assertRaises(R.ReportError):
            R.assert_command_safe("sheets spreadsheets create --params '{\'x\': 1}'")


class HungCallsAreBounded(unittest.TestCase):
    """Once this runs outside the turn deadline, nothing else stops a hang.

    And a hang leaves no checkpoint, so the re-run would wedge in the same
    place — the one failure mode checkpointing cannot help with.
    """

    def test_the_timeout_is_actually_passed_to_subprocess(self):
        # The point is the kwarg reaching subprocess.run. Asserting only that
        # TimeoutExpired becomes a ReportError tests the handler and lets the
        # kwarg be dropped silently — which is precisely how a hang would come
        # back.
        seen = {}

        def capture(argv, **kwargs):
            seen.update(kwargs)
            raise AssertionError("stop here")

        original = R.subprocess.run
        R.subprocess.run = capture
        try:
            with self.assertRaises(AssertionError):
                R.run_json(["true"], "call", timeout=42)
        finally:
            R.subprocess.run = original
        self.assertEqual(seen.get("timeout"), 42)

    def test_a_timeout_becomes_a_report_error(self):
        import subprocess as sp

        def boom(*a, **k):
            raise sp.TimeoutExpired(cmd="x", timeout=1)

        original = R.subprocess.run
        R.subprocess.run = boom
        try:
            with self.assertRaises(R.ReportError) as caught:
                R.run_json(["true"], "wedged call", timeout=1)
            self.assertIn("timed out", str(caught.exception))
        finally:
            R.subprocess.run = original

    def test_every_external_call_inherits_a_bound(self):
        # A default of None on run_json would make every caller unbounded
        # while these tests still passed.
        import inspect
        default = inspect.signature(R.run_json).parameters["timeout"].default
        self.assertIsInstance(default, int)
        self.assertGreater(default, 0)


class SideEffectsAreCheckpointed(RestoresModuleFunctions):
    """A retry must be able to succeed.

    add_tab was the one side effect not checkpointed: a failure between
    creating the tab and writing the grade's done-marker left the tab present
    and the marker absent, so the re-run tried to add it again, Sheets
    rejected the duplicate, and the report was stuck forever. A re-run that
    CANNOT succeed is worse than no checkpointing.
    """

    def setUp(self):
        super().setUp()
        self.work = pathlib.Path(tempfile.mkdtemp())
        self.calls = []

        # Both addSheet and deleteSheet are "sheets spreadsheets batchUpdate";
        # the request kind only shows up in the payload file, so record that.
        def fake_workspace(command, user, scope="agent", json_file=None):
            kind = command.split(" --")[0]
            if json_file:
                body = json.loads(pathlib.Path(json_file).read_text())
                requests = body.get("requests") or [{}]
                kind = next(iter(requests[0]), kind)
            self.calls.append(kind)
            return {"ok": True}

        R.workspace = fake_workspace

    def test_a_tab_is_created_once_across_re_runs(self):
        R.add_tab("SHEET1", "3", "u@psd401.net", self.work)
        R.add_tab("SHEET1", "3", "u@psd401.net", self.work)
        self.assertEqual(self.calls.count("addSheet"), 1)

    def test_each_tab_gets_its_own_marker(self):
        R.add_tab("SHEET1", "3", "u@psd401.net", self.work)
        R.add_tab("SHEET1", "4", "u@psd401.net", self.work)
        self.assertEqual(self.calls.count("addSheet"), 2)
        self.assertTrue((self.work / "tab-3-added.json").exists())
        self.assertTrue((self.work / "tab-4-added.json").exists())


class TheDefaultTabIsRemoved(unittest.TestCase):
    """spreadsheets.create always makes a blank "Sheet1" nobody asked for.

    Grade tabs are appended after it, so the empty one stays LEFTMOST — the
    tab a principal opens onto. Cosmetic, but this report is entirely about
    not handing over something that looks complete and isn't.
    """

    def setUp(self):
        self.work = pathlib.Path(tempfile.mkdtemp())
        self.calls = []

        def fake_workspace(command, user, scope="agent", json_file=None):
            kind = command.split(" --")[0]
            if json_file:
                body = json.loads(pathlib.Path(json_file).read_text())
                requests = body.get("requests") or [{}]
                kind = next(iter(requests[0]), kind)
            self.calls.append(kind)
            return {"ok": True}

        self.fake_workspace = fake_workspace
        R.workspace = fake_workspace

    def test_the_blank_tab_is_deleted_after_a_real_one_exists(self):
        R.add_tab("SHEET1", "3", "u@psd401.net", self.work)
        self.assertEqual(self.calls, ["addSheet", "deleteSheet"])

    def test_it_is_deleted_only_once_however_many_tabs_are_added(self):
        for grade in ("K", "1", "2"):
            R.add_tab("SHEET1", grade, "u@psd401.net", self.work)
        self.assertEqual(self.calls.count("deleteSheet"), 1)

    def test_it_is_not_retried_after_a_resume(self):
        R.add_tab("SHEET1", "3", "u@psd401.net", self.work)
        self.calls.clear()
        R.add_tab("SHEET1", "4", "u@psd401.net", self.work)
        self.assertNotIn("deleteSheet", self.calls)

    def test_a_non_report_error_also_never_fails_the_report(self):
        # The docstring promises non-fatal; catching only ReportError meant an
        # OSError writing the request payload would still kill a finished run.
        def boom(command, user, scope="agent", json_file=None):
            if json_file and "deletesheet" in json_file:
                raise OSError("read-only file system")
            return self.fake_workspace(command, user, scope, json_file)

        R.workspace = boom
        R.add_tab("SHEET1", "3", "u@psd401.net", self.work)
        self.assertTrue((self.work / "default-tab-dropped.json").exists())

    def test_a_failed_delete_never_fails_the_report(self):
        # The numbers are all in by this point. Losing a finished report over
        # a cosmetic tab would be the worse trade by a wide margin.
        def boom(command, user, scope="agent", json_file=None):
            if json_file and "deletesheet" in json_file:
                raise R.ReportError("sheet not found")
            return self.fake_workspace(command, user, scope, json_file)

        R.workspace = boom
        R.add_tab("SHEET1", "3", "u@psd401.net", self.work)
        self.assertTrue((self.work / "default-tab-dropped.json").exists())

    def test_a_real_tab_must_exist_before_the_delete(self):
        # A spreadsheet must keep at least one sheet, so the order matters.
        R.add_tab("SHEET1", "3", "u@psd401.net", self.work)
        self.assertLess(self.calls.index("addSheet"),
                        self.calls.index("deleteSheet"))


class WindowLabels(unittest.TestCase):
    """A Fall→Winter block labelled Fall→Spring is a wrong report."""

    def test_a_measure_specific_window_wins(self):
        import build_tab
        window = {"ORF-WRC": "Winter→Spring", "*": "Fall→Spring"}
        self.assertEqual(build_tab.window_for("ORF-WRC", window), "Winter→Spring")
        self.assertEqual(build_tab.window_for("NWF-CLS", window), "Fall→Spring")

    def test_a_plain_string_still_applies_to_every_block(self):
        import build_tab
        self.assertEqual(
            build_tab.window_for("anything", "Fall→Spring"), "Fall→Spring"
        )


class TheWholeReportIsAttempted(RestoresModuleFunctions):
    """SBA, i-Ready and the subgroup rollups are part of the report.

    The first version of this pipeline did DIBELS growth only, while SKILL.md
    told the agent not to orchestrate anything itself — so a principal would
    have received a workbook silently missing SBA proficiency (half the
    report's name), i-Ready, and both subgroup breakdowns. Review caught it.
    That is the same "looks complete, isn't" class as the Minter Creek grade
    span and the district-column-mirrors-school-column bug.
    """

    def test_the_dibels_extraction_carries_the_subgroup_flags(self):
        sql = R.extraction_sql(1, 2, "3", ["ORF-WRC"], "Fall")
        self.assertIn("students_frl", sql)
        self.assertIn("students_specialed", sql)
        self.assertIn("low_income", sql)
        self.assertIn("special_ed", sql)

    def test_the_subgroup_join_is_district_wide(self):
        # Scoping it to the school made every District cell equal its School
        # cell on 2026-08-15 — grade K showed 18/18 against a district cohort
        # of 558 — and every number looked plausible.
        sql = R.extraction_sql(7, 2, "3", ["ORF-WRC"], "Fall")
        frl = sql.split("students_frl", 1)[1].split("LEFT JOIN", 1)[0]
        self.assertNotIn("schoolid", frl)

    def test_both_subgroups_are_requested_from_aggregate(self):
        seen = {}
        R.run_json = lambda argv, what, **k: seen.setdefault("argv", argv) or []
        R.aggregate_rows(pathlib.Path("/tmp/x.json"), "3", "Fall",
                         subgroups=R.SUBGROUPS)
        joined = " ".join(seen["argv"])
        self.assertIn("low_income=Low Income|Non-Low Income", joined)
        self.assertIn("special_ed=Special Ed|Non-Special Ed", joined)

    def test_sba_filters_out_iab_participation_rows(self):
        # smarter_balanced_scores mixes IAB/FIAB rows (score = 1) with
        # summatives; unfiltered averages are garbage.
        sql = R.sba_sql(1, 35, "4")
        self.assertIn("LIKE 'Summative%'", sql)
        self.assertIn("is_strand = false", sql)

    def test_sba_quartiles_on_the_prior_year_score(self):
        sql = R.sba_sql(1, 35, "5")
        self.assertIn("yearid = 34", sql)      # prior year
        self.assertIn("grade_level = '4'", sql)  # prior grade
        self.assertIn("prior.b::text", sql)

    def test_iready_uses_percentile_not_raw_score(self):
        sql = R.iready_sql(1, 2, "3", "iready_reading_diagnostics", "Reading")
        self.assertIn("AVG(percentile)", sql)

    def test_no_block_reintroduces_a_window_function(self):
        for sql in (R.sba_sql(1, 35, "4"),
                    R.iready_sql(1, 2, "3", "iready_reading_diagnostics", "Reading")):
            upper = sql.upper()
            for banned in ("NTILE(", "GROUPING SETS", "LATERAL"):
                self.assertNotIn(banned, upper)


class OmissionsAreVisibleInTheWorkbook(RestoresModuleFunctions):
    """A principal does not read the run log.

    Every previous "looks complete, isn't" failure was invisible at the point
    of use. A block that cannot be produced is written INTO the tab.
    """

    def setUp(self):
        super().setUp()
        self.work = pathlib.Path(tempfile.mkdtemp())

    def test_a_failed_block_becomes_a_gap_not_an_absence(self):
        def boom():
            raise R.ReportError("table does not exist")

        gaps = []
        R.query_all = lambda *a, **k: (_ for _ in ()).throw(
            R.ReportError("table does not exist"))
        out = R.run_block(self.work, "t", "3", lambda: "SELECT 1", "why",
                          lambda m: None, gaps, "SBA grades 4-5")
        self.assertEqual(out, [])
        self.assertEqual(len(gaps), 1)
        self.assertIn("SBA grades 4-5", gaps[0])
        self.assertIn("not included", gaps[0])

    def test_an_empty_block_is_also_a_gap(self):
        gaps = []
        R.query_all = lambda *a, **k: []
        R.run_block(self.work, "t2", "3", lambda: "SELECT 1", "why",
                    lambda m: None, gaps, "i-Ready Reading/Math")
        self.assertIn("no matched students", gaps[0])

    def test_gaps_are_rendered_into_the_tab(self):
        import build_tab
        tab = build_tab.build([], "S", "3", "2025-26", "Fall→Spring",
                              gaps=["SBA grades 4-5: not included (x)"])
        flat = [c for row in tab["values"] for c in row]
        self.assertIn("NOT INCLUDED IN THIS REPORT", flat)
        self.assertTrue(any("SBA grades 4-5" in c for c in flat))

    def test_a_complete_tab_carries_no_gap_banner(self):
        import build_tab
        tab = build_tab.build([], "S", "3", "2025-26", "Fall→Spring")
        flat = [c for row in tab["values"] for c in row]
        self.assertNotIn("NOT INCLUDED IN THIS REPORT", flat)

class LikeWildcards(RestoresModuleFunctions):
    """A school name is a literal, not a pattern.

    sql_escape closes the quote hole; it does nothing about `%` and `_`, which
    are still wildcards inside a LIKE. A stray one broadens the match, and the
    ambiguous branch then refuses a name that should have resolved cleanly.
    """

    def test_wildcards_are_escaped(self):
        self.assertEqual(R.like_escape("Harbor_Ridge"), "Harbor\\_Ridge")
        self.assertEqual(R.like_escape("100%"), "100\\%")

    def test_a_backslash_is_escaped_first(self):
        # Otherwise the escape character introduced here becomes escapable.
        self.assertEqual(R.like_escape("a\\b"), "a\\\\b")

    def test_an_ordinary_name_is_untouched(self):
        self.assertEqual(R.like_escape("Artondale Elementary"),
                         "Artondale Elementary")

    def test_the_query_declares_its_escape_character(self):
        captured = {}

        def fake_query(sql, reason, **kwargs):
            captured["sql"] = sql
            return [{"schoolid": 1, "school_name": "Harbor_Ridge"}]

        R.query = fake_query
        R.resolve_school("Harbor_Ridge")
        self.assertIn("ESCAPE", captured["sql"])
        self.assertIn("Harbor\\_Ridge", captured["sql"])


class FallbackWindowLabel(unittest.TestCase):
    """The '*' label follows the grade, not the global default.

    K has no Fall administration at all, so labelling a K block "Fall→Spring"
    states a window that was never measured.
    """

    def test_kindergarten_falls_back_to_winter(self):
        self.assertEqual(
            R.BASELINE_BY_GRADE.get("K", R.BASELINE_DEFAULT), "Winter"
        )

    def test_other_grades_fall_back_to_fall(self):
        self.assertEqual(
            R.BASELINE_BY_GRADE.get("3", R.BASELINE_DEFAULT), "Fall"
        )

    def test_the_hardcoded_default_label_is_gone(self):
        source = pathlib.Path(R.__file__).read_text()
        self.assertNotIn('windows["*"] = f"{BASELINE_DEFAULT}', source)


class WorkDirIsOwnerOnly(unittest.TestCase):
    """Checkpoints are student data, not scratch metadata.

    grade-<g>-rows.json pairs studentid with assessment scores and lives at a
    predictable /tmp path for the life of the container. Default mkdir
    permissions leave that world-readable; owner-only costs nothing and does
    not rely on an assumption about how ephemeral the sandbox is.
    """

    def test_the_work_dir_is_restricted(self):
        work = pathlib.Path(tempfile.mkdtemp()) / "qgr-test"
        work.mkdir(parents=True, exist_ok=True)
        work.chmod(0o700)
        self.assertEqual(work.stat().st_mode & 0o777, 0o700)

    def test_main_restricts_the_work_dir_it_creates(self):
        source = pathlib.Path(R.__file__).read_text()
        self.assertIn("work_dir.chmod(0o700)", source)

class CheckpointsBelongToOneRun(RestoresModuleFunctions):
    """Keyed on school alone, a second report reused the first one's answers.

    `sheet` and `shared` are checkpointed, so a different caller received a
    URL they had no access to — exit 0, no error — and every run returned
    whatever the numbers were the first time that school was ever built. It
    also falsified this script's own claim that a school can be run twice and
    diffed.
    """

    def test_a_different_caller_gets_a_different_work_dir(self):
        a = R.default_work_dir("artondale", "2025-26", "one@psd401.net")
        b = R.default_work_dir("artondale", "2025-26", "two@psd401.net")
        self.assertNotEqual(a, b)

    def test_a_different_year_gets_a_different_work_dir(self):
        a = R.default_work_dir("artondale", "2024-25", "one@psd401.net")
        b = R.default_work_dir("artondale", "2025-26", "one@psd401.net")
        self.assertNotEqual(a, b)

    def test_the_same_run_resumes_within_the_day(self):
        # A retry after a failure must reuse checkpoints — that is the whole
        # point of having them.
        a = R.default_work_dir("artondale", "2025-26", "one@psd401.net")
        b = R.default_work_dir("artondale", "2025-26", "one@psd401.net")
        self.assertEqual(a, b)

    def test_the_date_is_in_the_path(self):
        import datetime
        path = R.default_work_dir("artondale", "2025-26", "one@psd401.net")
        self.assertIn(datetime.date.today().isoformat(), path)


class SbaIsNotLabelledFallToSpring(RestoresModuleFunctions):
    """SBA compares against the PRIOR YEAR's summative.

    The grade's DIBELS fallback would render "SBA ELA (Fall→Spring)", a window
    that was never measured. This file's own rule: a Fall→Winter block
    labelled Fall→Spring is a wrong report, not a cosmetic slip.
    """

    def test_run_report_labels_sba_records_itself(self):
        # Building the windows dict by hand in the test only proved build_tab
        # reads it. This proves run_report WRITES it — the mutation that
        # removed the labelling failed nothing until this existed.
        records = [{"meas": "SBA ELA"}, {"meas": "ORF-WRC"}]
        windows = R.label_windows({"*": "Fall→Spring"}, records)
        self.assertEqual(windows["SBA ELA"], R.SBA_WINDOW)
        self.assertNotEqual(windows["SBA ELA"], "Fall→Spring")

    def test_a_real_per_measure_label_beats_the_sba_default(self):
        windows = R.label_windows({"SBA ELA": "Winter→Spring"},
                                  [{"meas": "SBA ELA"}])
        self.assertEqual(windows["SBA ELA"], "Winter→Spring")

    def test_non_sba_records_are_left_alone(self):
        windows = R.label_windows({"*": "Fall→Spring"}, [{"meas": "ORF-WRC"}])
        self.assertNotIn("ORF-WRC", windows)

    def test_a_dibels_block_keeps_its_own_window(self):
        import build_tab
        windows = {"ORF-WRC": "Winter→Spring", "*": "Fall→Spring"}
        self.assertEqual(
            build_tab.window_for("ORF-WRC", windows), "Winter→Spring")

    def test_the_rendered_sba_header_says_prior_year(self):
        import build_tab
        records = [{"meas": "SBA ELA", "scope": "school", "qt": "All",
                    "growth": 12, "n": 30}]
        tab = build_tab.build(records, "S", "4", "2025-26",
                              {"SBA ELA": "prior year→this year",
                               "*": "Fall→Spring"})
        flat = [c for row in tab["values"] for c in row]
        self.assertIn("SBA ELA (prior year→this year)", flat)
        self.assertNotIn("SBA ELA (Fall→Spring)", flat)

class EveryBlockHonoursTheGapContract(RestoresModuleFunctions):
    """SKILL.md: "Anything it cannot produce is written INTO the tab."

    SBA and i-Ready went through run_block, which records a gap on a failed
    query and on an empty result. The DIBELS block — the one the report is
    named for — was built inline and did neither, so the PRIMARY measures
    could go missing while the secondary ones announced themselves. That
    asymmetry is precisely what makes a workbook look complete.
    """

    def test_the_source_records_a_gap_for_a_failed_dibels_extraction(self):
        source = pathlib.Path(R.__file__).read_text()
        block = source.split("One pass per distinct baseline", 1)[1]
        block = block.split("# i-Ready", 1)[0]
        self.assertIn("query failed", block)
        self.assertIn("no matched students", block)

    def test_a_grade_with_no_dibels_measures_still_reports_it(self):
        source = pathlib.Path(R.__file__).read_text()
        self.assertIn(
            "no DIBELS measures recorded for this grade", source
        )

    def test_the_dibels_gap_list_is_not_reset_before_the_other_blocks(self):
        # `gaps = []` appearing twice would silently discard whatever the
        # DIBELS pass recorded before SBA and i-Ready ran.
        source = pathlib.Path(R.__file__).read_text()
        self.assertEqual(source.count("            gaps = []"), 1)

    def test_a_gap_only_grade_still_produces_a_tab(self):
        # A grade with nothing to report must still say so in the workbook
        # rather than being skipped into silence.
        import build_tab
        tab = build_tab.build([], "S", "2", "2025-26", "Fall→Spring",
                              gaps=["DIBELS growth: not included (x)"])
        flat = [c for row in tab["values"] for c in row]
        self.assertIn("NOT INCLUDED IN THIS REPORT", flat)
        self.assertTrue(any("DIBELS growth" in c for c in flat))

class EverySplicedValueIsSanitised(RestoresModuleFunctions):
    """One unsanitised value is enough.

    The title was fixed after review caught it; share_workbook still spliced
    the caller's address raw. Same tokenizer, same missing escape syntax, and
    the failure would land on the LAST step of a finished report. Rather than
    reason about which values can contain a quote, every one goes through the
    same door — and this test fails if a new splice site skips it.
    """

    def test_no_raw_interpolation_reaches_any_command_string(self):
        # Scoped to --params/--body at first, which is exactly why the
        # --json-file path slipped through as the FOURTH variant of this bug.
        # Any interpolation into a command string counts now.
        source = pathlib.Path(R.__file__).read_text()
        offenders = []
        for line in source.splitlines():
            stripped = line.strip()
            if "--params" not in stripped and "--body" not in stripped \
                    and "--json-file" not in stripped:
                continue
            if "{" not in stripped:
                continue
            if any(guard in stripped for guard in
                   ("command_literal", "safe_path", "json.dumps(params)",
                    "json.dumps(body)")):
                continue
            offenders.append(stripped)
        self.assertEqual(offenders, [], f"unsanitised splice: {offenders}")

    def test_a_work_dir_with_a_space_is_refused_not_mangled(self):
        with self.assertRaises(R.ReportError) as caught:
            R.safe_path("/tmp/my reports/x.json")
        self.assertIn("separate tokens", str(caught.exception))

    def test_a_work_dir_with_a_quote_is_refused(self):
        with self.assertRaises(R.ReportError):
            R.safe_path("/tmp/o'brien/x.json")

    def test_an_ordinary_path_passes_through(self):
        self.assertEqual(R.safe_path("/tmp/qgr-a-b/x.json"), "/tmp/qgr-a-b/x.json")

    def test_the_share_body_sanitises_the_caller(self):
        seen = {}
        R.workspace = lambda command, user, scope="agent", json_file=None: (
            seen.setdefault("command", command) or {"ok": True})
        R.share_workbook("SHEET1", "o'brien@psd401.net")
        self.assertNotIn("o'brien", seen["command"])
        self.assertIn("brien", seen["command"])

    def test_a_normal_address_is_unchanged(self):
        self.assertEqual(
            R.command_literal("hagelk@psd401.net"), "hagelk@psd401.net"
        )

# --- issue #1679: seven bugs that every existing test missed ---------------
#
# Every test above passed while run_report.py failed on EVERY invocation
# against the live warehouse. They asserted shapes this file invented rather
# than shapes the warehouse and psd-workspace actually use — the same mistake
# as the authored `questionId` fixture that let #1660 ship as a no-op.
#
# These pin the real ones, taken from the live schema recorded in #1679.


class McpResponseIsAMarkdownTable(RestoresModuleFunctions):
    """psd-data returns the raw tools/call envelope, not a rows array.

    run.js writes JSON.stringify(response.result), shaped
    {"content": [{"type": "text", "text": "<markdown>"}], "isError": false}.
    Reading payload["rows"] returned [] for EVERY query — while 1,706 matched
    grade-1 pairs sat behind it — and an empty result read as "no data", so
    the workbook came out with a tab per grade and nothing in any of them.
    """

    ENVELOPE = {
        "content": [{"type": "text", "text":
                     "| schoolid | school_name |\n"
                     "| --- | --- |\n"
                     "| 3299 | Artondale Elementary |\n"}],
        "isError": False,
    }

    def test_rows_are_parsed_out_of_the_envelope(self):
        rows = R.parse_mcp_rows(self.ENVELOPE, "test")
        self.assertEqual(rows, [{"schoolid": "3299",
                                 "school_name": "Artondale Elementary"}])

    def test_query_itself_returns_rows_from_a_real_envelope(self):
        # Testing parse_mcp_rows directly proved nothing about query(): with
        # the old payload["rows"] line restored, every direct test still
        # passed. This one goes through query(), which is where the bug was.
        R.run_json = lambda argv, what, **k: self.ENVELOPE
        rows = R.query("SELECT 1", "resolve the school")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["school_name"], "Artondale Elementary")

    def test_query_all_pages_a_real_envelope(self):
        envelopes = [self.ENVELOPE, {"content": [{"type": "text",
                                                  "text": ""}],
                                     "isError": False}]
        R.run_json = lambda argv, what, **k: (
            envelopes.pop(0) if envelopes else {"content": [], "isError": False})
        self.assertEqual(len(R.query_all("SELECT 1", "roster")), 1)

    def test_query_raises_on_an_error_envelope(self):
        R.run_json = lambda argv, what, **k: {
            "content": [{"type": "text",
                         "text": 'column "schoolid" does not exist'}],
            "isError": True}
        with self.assertRaises(R.ReportError):
            R.query("SELECT 1", "resolve the school")

    def test_an_error_envelope_raises_instead_of_reading_as_no_data(self):
        # This conflation is what let four other bugs hide: a query that
        # FAILED looked exactly like a query that found nothing.
        envelope = {"content": [{"type": "text",
                                 "text": 'column "schoolid" does not exist'}],
                    "isError": True}
        with self.assertRaises(R.ReportError) as caught:
            R.parse_mcp_rows(envelope, "resolve the school")
        self.assertIn("does not exist", str(caught.exception))

    def test_an_empty_result_set_is_empty_not_a_fake_row(self):
        envelope = {"content": [{"type": "text", "text": "No rows returned."}],
                    "isError": False}
        self.assertEqual(R.parse_mcp_rows(envelope, "test"), [])

    def test_json_inside_the_text_block_is_read(self):
        # The one recorded fixture in this repo (psd-data/evals/fixtures/
        # list-tables.json) puts JSON in `text`, not a markdown table. #1679
        # reported markdown for query_data. With no recorded query_data
        # response either way, both are read — betting on markdown alone would
        # have returned [] on a JSON payload, which is the same bug again.
        envelope = {"content": [{"type": "text", "text":
                                 '{"rows":[{"schoolid":"3299",'
                                 '"school_name":"Artondale Elementary"}]}'}],
                    "isError": False}
        rows = R.parse_mcp_rows(envelope, "test")
        self.assertEqual(rows[0]["school_name"], "Artondale Elementary")

    def test_a_bare_json_array_is_read(self):
        envelope = {"content": [{"type": "text",
                                 "text": '[{"a":"1"},{"a":"2"}]'}],
                    "isError": False}
        self.assertEqual(len(R.parse_mcp_rows(envelope, "test")), 2)

    def test_columns_plus_row_arrays_are_paired(self):
        self.assertEqual(
            R.rows_from_json({"columns": ["a", "b"], "rows": [["1", "2"]]}),
            [{"a": "1", "b": "2"}],
        )

    def test_json_wins_over_a_markdown_reading(self):
        # Unambiguous beats heuristic.
        self.assertEqual(R.parse_result_text('{"rows":[{"a":"1"}]}'),
                         [{"a": "1"}])

    def test_malformed_json_falls_back_to_markdown(self):
        text = '{"broken"\n| a |\n| --- |\n| 1 |\n'
        self.assertEqual(R.parse_result_text(text), [{"a": "1"}])

    def test_a_structured_rows_key_is_used_when_present(self):
        # So a future psd-data JSON mode needs no change here.
        envelope = {"rows": [{"a": 1}], "isError": False}
        self.assertEqual(R.parse_mcp_rows(envelope, "test"), [{"a": 1}])

    def test_null_cells_become_none(self):
        text = "| a | b |\n| --- | --- |\n| 1 | NULL |\n"
        self.assertEqual(R.parse_markdown_table(text), [{"a": "1", "b": None}])

    def test_prose_without_a_separator_row_is_not_a_table(self):
        self.assertEqual(R.parse_markdown_table("| not a table"), [])


class SqlMatchesTheLiveSchema(unittest.TestCase):
    """The column names in #1679, not the ones this file guessed."""

    def test_schools_is_id_and_name(self):
        R.query = lambda sql, *a, **k: [{"schoolid": 1, "school_name": "X"}]
        captured = {}

        def fake(sql, *a, **k):
            captured["sql"] = sql
            return [{"schoolid": 1, "school_name": "Artondale Elementary"}]

        original = R.query
        R.query = fake
        try:
            R.resolve_school("Artondale Elementary")
        finally:
            R.query = original
        self.assertIn("id AS schoolid", captured["sql"])
        self.assertIn("name AS school_name", captured["sql"])
        self.assertNotIn("LOWER(school_name)", captured["sql"])

    def test_school_years_is_id_and_name(self):
        captured = {}

        def fake(sql, *a, **k):
            captured["sql"] = sql
            return [{"yearid": 35, "year_name": "2025-26"}]

        original = R.query
        R.query = fake
        try:
            R.resolve_year("2025-26")
        finally:
            R.query = original
        self.assertIn("id AS yearid", captured["sql"])
        self.assertIn("name AS year_name", captured["sql"])
        self.assertNotIn("WHERE year_name", captured["sql"])

    def test_the_teacher_join_uses_the_real_primary_key(self):
        captured = {}

        def fake(sql, *a, **k):
            captured["sql"] = sql
            return [{"sectionid": "1", "grade_level": "K",
                     "teacher_name": "Hansen, Jane"}]

        original = R.query_all
        R.query_all = fake
        try:
            R.fetch_roster(1, 2)
        finally:
            R.query_all = original
        self.assertIn("teachers t ON t.id = st.teacherid", captured["sql"])
        self.assertNotIn("t.teacherid = st.teacherid", captured["sql"])
        self.assertIn("first_name", captured["sql"])
        self.assertNotIn("t.teacher_name", captured["sql"])

    def test_the_subgroup_tables_are_not_year_scoped(self):
        # THE most damaging of the seven: students_frl and students_specialed
        # have no yearid, so the predicate errored the whole extraction for
        # every grade and produced a complete-looking, empty workbook.
        sql = R.extraction_sql(1, 35, "3", ["ORF WC"], "Fall")
        self.assertIn("students_frl f ON f.studentid = m.studentid", sql)
        self.assertNotIn("f.yearid", sql)
        self.assertNotIn("sp.yearid", sql)


class WorkspaceCallShapes(RestoresModuleFunctions):
    """--params is query parameters; the resource is the request body."""

    def test_create_sends_the_resource_as_json_not_params(self):
        seen = {}

        def fake(command, user, **kwargs):
            seen["c"] = command
            return {"spreadsheetId": "S"}

        R.workspace = fake
        R.create_workbook("T", "u@psd401.net")
        self.assertIn("--json", seen["c"])
        self.assertNotIn("--params", seen["c"])

    def test_share_uses_json_and_a_boolean(self):
        seen = {}

        def fake(command, user, **kwargs):
            seen["c"] = command
            return {"ok": True}

        R.workspace = fake
        R.share_workbook("S", "u@psd401.net")
        self.assertIn("--json", seen["c"])
        self.assertNotIn("--body ", seen["c"])
        self.assertIn('"transferOwnership": true', seen["c"])
        self.assertNotIn('"transferOwnership": "true"', seen["c"])


class NormsNamesAreMapped(unittest.TestCase):
    """The warehouse and the norms file disagree, and aggregate.py joins on it.

    Unmapped, it aborts the whole run for every grade with an ORF measure —
    grades 1-5, i.e. the report.
    """

    def test_orf_warehouse_names_map_to_norms_names(self):
        args = R.measure_as_args(["ORF Accuracy", "ORF WC", "ORF Errors"])
        self.assertIn("ORF Accuracy=ORF-ACC", args)
        self.assertIn("ORF WC=ORF-WRC", args)

    def test_an_already_matching_name_is_not_mapped(self):
        self.assertEqual(R.measure_as_args(["LNF", "PSF"]), [])

    def test_an_unknown_measure_passes_through_unmapped(self):
        # Loud in aggregate.py beats silently dropped here.
        self.assertEqual(R.measure_as_args(["BRAND NEW"]), [])

    def test_aggregate_receives_the_mapping(self):
        seen = {}
        original = R.run_json
        R.run_json = lambda argv, what, **k: seen.setdefault("argv", argv) or []
        try:
            R.aggregate_rows(pathlib.Path("/tmp/x.json"), "1", "Fall",
                             measures=["ORF WC"])
        finally:
            R.run_json = original
        joined = " ".join(seen["argv"])
        self.assertIn("--measure-as", joined)
        self.assertIn("ORF WC=ORF-WRC", joined)

class IReadyIsTwoTables(unittest.TestCase):
    """Guessed table names cost a whole measure family.

    The script probed iready_scores / i_ready_scores /
    iready_diagnostic_scores. None exist. i-Ready reported itself as "table
    not found" on every run while the data sat under
    iready_reading_diagnostics and iready_math_diagnostics — one table PER
    SUBJECT, not one table with a subject column.

    The gap banner did its job: the omission was stated in the sheet rather
    than silent. But the user still had to ask why, and the answer was that we
    guessed instead of asking the warehouse.
    """

    def test_the_recorded_tables_are_the_real_ones(self):
        self.assertEqual(
            R.IREADY_TABLES_BY_SUBJECT,
            {"Reading": "iready_reading_diagnostics",
             "Math": "iready_math_diagnostics"},
        )

    def test_each_subject_queries_its_own_table(self):
        reading = R.iready_sql(1, 2, "3", "iready_reading_diagnostics", "Reading")
        math = R.iready_sql(1, 2, "3", "iready_math_diagnostics", "Math")
        self.assertIn("iready_reading_diagnostics", reading)
        self.assertNotIn("iready_math_diagnostics", reading)
        self.assertIn("iready_math_diagnostics", math)

    def test_the_subject_is_a_literal_not_a_column(self):
        # There is no `subject` column to select — the table IS the subject.
        sql = R.iready_sql(1, 2, "3", "iready_reading_diagnostics", "Reading")
        self.assertIn("'Reading' AS meas", sql)
        self.assertNotIn("subject AS meas", sql)

    def test_the_measure_is_labelled_for_the_tab(self):
        sql = R.iready_sql(1, 2, "3", "iready_math_diagnostics", "Math")
        self.assertIn("'i-Ready ' || m.meas", sql)


class NormsGapsThatKilledAWholeGrade(unittest.TestCase):
    """Two measure names, each of which aborted an entire grade block."""

    def test_maze_adjusted_score_maps_to_maze(self):
        self.assertIn("MAZE Adjusted Score=MAZE",
                      R.measure_as_args(["MAZE Adjusted Score"]))

    def test_composite_has_no_norms_and_is_not_mapped(self):
        # Inventing a percentile for it would misstate how a child scored
        # against national peers, in a document read as fact.
        with_norms, without = R.split_by_norms(["ORF WC", "Composite"])
        self.assertEqual(with_norms, ["ORF WC"])
        self.assertEqual(without, ["Composite"])

    def test_a_normal_measure_keeps_its_norms(self):
        with_norms, without = R.split_by_norms(["ORF WC", "NWF CLS"])
        self.assertEqual(without, [])


# Keep this guard LAST in the file. It used to sit mid-file (line 214), which
# meant `python test_run_report.py` ran unittest.main() and sys.exit()ed before
# the four classes below it were even defined — 22 tests instead of 35,
# silently skipping the apostrophe-safety, timeout-bound, checkpointed
# side-effect and window-label suites. CI imports the module via
# `python -m unittest`, so it never noticed; a developer debugging locally got
# a green run that had not executed the tests they were debugging.
if __name__ == "__main__":
    unittest.main()
