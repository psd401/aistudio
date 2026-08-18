"""The one-command report pipeline.

The report's arithmetic is not tested here — it is not in this file any more.
R&A validated 40 queries against psd-data before this skill existed and the
handoff's instruction was to transcribe them, so every number in the workbook
is computed by the warehouse. What is left in run_report.py is orchestration,
and orchestration is what failed on every run between 2026-08-14 and
2026-08-16: a no-op edit ending the run, assistant messages fusing, a promoted
job aborting its own run, `--export` timing out, literal newline escapes in
model-authored glue.

So these tests pin what makes the script safe to re-run and hard to mislead:
checkpoint resume, a grade span that came from a query, SQL escaping on the
only caller-supplied values, quote-safe workspace commands, and a response
parser that does not confuse an error with an empty result.

The two external CLIs (psd-data, psd-workspace) are stubbed. Everything
between them is the real code path.
"""

import json
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import gen_sql  # noqa: E402
import layout  # noqa: E402
import run_report as R  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
FIXTURES = HERE.parent / "tests" / "fixtures" / "sql-evergreen"

_PATCHABLE = ("query", "query_one", "run_json", "workspace")


class RestoresModuleFunctions(unittest.TestCase):
    """Stubs must not leak between tests.

    Patching R.query in place and leaving it there made the suite fail
    depending on test ORDER — a self-inflicted version of exactly the
    flakiness these tests exist to prevent.
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


class SqlMatchesTheLiveSchema(RestoresModuleFunctions):
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
            return [{"sectionid": "1", "teacher_name": "Jane Hansen"}]

        R.query_one = fake
        R.fetch_sections(1, 2, 0, "GR00K")
        self.assertIn("teachers t ON t.id = st.teacherid", captured["sql"])
        self.assertNotIn("t.teacherid = st.teacherid", captured["sql"])
        self.assertIn("first_name", captured["sql"])
        self.assertNotIn("t.teacher_name", captured["sql"])

    def test_the_subgroup_tables_are_not_year_scoped(self):
        # THE most damaging of the seven bugs in #1679: students_frl and
        # students_specialed have no yearid, so the predicate errored the
        # whole extraction for every grade and produced a complete-looking,
        # empty workbook. R&A's queries join them unscoped; this asserts
        # against the generated SQL so the fix cannot regress.
        blob = "".join(
            path.read_text() for path in
            (FIXTURES.glob("*_sub*.sql")))
        self.assertIn("students_frl fr ON fr.studentid=m.studentid", blob)
        self.assertNotIn("fr.yearid", blob)
        self.assertNotIn("sp2.yearid", blob)


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


class TheDefaultYearMustHaveStarted(RestoresModuleFunctions):
    """`ORDER BY id DESC` picked a year that had not begun.

    On 2026-08-17 the default resolved to 2026-27 — no roster, no scores — and
    the report came out empty until the user worked out what had happened and
    passed the completed year by hand. A growth report needs a baseline AND an
    ending window, so a year that has not started cannot produce one.
    """

    YEARS = [
        {"yearid": 36, "year_name": "2026-2027", "first_day": "2026-09-01"},
        {"yearid": 35, "year_name": "2025-2026", "first_day": "2025-09-02"},
        {"yearid": 34, "year_name": "2024-2025", "first_day": "2024-09-03"},
    ]

    def test_a_year_that_has_not_started_is_skipped(self):
        R.query = lambda *a, **k: self.YEARS
        self.assertEqual(R.resolve_year(None)["year_name"], "2025-2026")

    def test_the_newest_started_year_wins(self):
        started = [dict(y, first_day="2020-09-01") for y in self.YEARS]
        R.query = lambda *a, **k: started
        self.assertEqual(R.resolve_year(None)["yearid"], 36)

    def test_no_started_year_refuses_rather_than_guessing(self):
        future = [dict(y, first_day="2099-09-01") for y in self.YEARS]
        R.query = lambda *a, **k: future
        with self.assertRaises(R.ReportError) as caught:
            R.resolve_year(None)
        self.assertIn("--year", str(caught.exception))


class TheYearFormatIsForgiving(RestoresModuleFunctions):
    """The warehouse says "2025-2026"; this skill's usage line said "2025-26".

    The user hit that too. Being strict about a format we documented wrong is
    our error to absorb, not theirs to work around.
    """

    YEARS = [{"yearid": 35, "year_name": "2025-2026", "first_day": "2025-09-02"}]

    def test_the_short_form_matches_the_long_one(self):
        R.query = lambda *a, **k: self.YEARS
        self.assertEqual(R.resolve_year("2025-26")["yearid"], 35)

    def test_the_exact_form_still_matches(self):
        R.query = lambda *a, **k: self.YEARS
        self.assertEqual(R.resolve_year("2025-2026")["yearid"], 35)

    def test_a_slash_form_matches(self):
        R.query = lambda *a, **k: self.YEARS
        self.assertEqual(R.resolve_year("2025/26")["yearid"], 35)

    def test_an_unknown_year_lists_what_exists(self):
        # "no school year matched" with nothing else is a dead end for the
        # user; the warehouse's own spelling is the useful part.
        R.query = lambda *a, **k: self.YEARS
        with self.assertRaises(R.ReportError) as caught:
            R.resolve_year("1999-2000")
        self.assertIn("2025-2026", str(caught.exception))

    def test_an_exact_match_beats_a_loose_one(self):
        R.query = lambda *a, **k: [
            {"yearid": 1, "year_name": "2025-26", "first_day": "2025-09-02"},
            {"yearid": 2, "year_name": "2025-2026", "first_day": "2025-09-02"},
        ]
        self.assertEqual(R.resolve_year("2025-2026")["yearid"], 2)

class TheRosterDrivesEveryQuery(RestoresModuleFunctions):
    """R&A's "Adapting to a school" step, done from a live query.

    Their generator carried a hardcoded SCHOOLS dict. This builds the same
    entry from `section_enrollments`, so the grade span and the classroom
    column order come from the warehouse and not from an assertion — the
    agent once announced "Minter Creek is a K-2 school", invented the reason,
    and scoped a whole report to it. Minter Creek is K-5.
    """

    def _roster(self, by_course):
        def fake(sql, reason):
            for course, rows in by_course.items():
                if f"course_code = '{course}'" in sql:
                    return rows
            return []
        R.query_one = fake

    def test_the_grade_span_comes_from_the_roster(self):
        self._roster({
            "GR00K": [{"sectionid": "11", "teacher_name": "Jane Hansen"}],
            "GR001": [{"sectionid": "12", "teacher_name": "Ann Lee"}],
        })
        roster = R.fetch_roster(3055, 35)
        self.assertEqual(sorted(roster["sections"]), [0, 1])

    def test_a_school_without_grade_five_generates_no_grade_five_queries(self):
        self._roster({
            "GR00K": [{"sectionid": "11", "teacher_name": "Jane Hansen"}],
            "GR001": [{"sectionid": "12", "teacher_name": "Ann Lee"}],
            "GR002": [{"sectionid": "13", "teacher_name": "Bo Ruiz"}],
        })
        roster = R.fetch_roster(3055, 35)
        config = R.build_school(
            {"schoolid": 3055, "school_name": "Somewhere K-2"}, roster)
        out = pathlib.Path(tempfile.mkdtemp())
        names = {path.name for path in gen_sql.generate(config, out, year=35)}
        self.assertTrue(names)
        # Not just "no g5_" — the SBA families are written OUTSIDE the grade
        # loop, so a guard that only covered the loop would still emit them.
        stray = sorted(n for n in names
                       if n.startswith(("g3_", "g4_", "g5_")))
        self.assertEqual(stray, [])
        self.assertEqual(names, {s["name"] for s in gen_sql.specs(config)})

    def test_a_section_with_no_lead_teacher_is_kept(self):
        self._roster({"GR00K": [{"sectionid": "11", "teacher_name": None}]})
        roster = R.fetch_roster(3055, 35)
        # The students are still in the numbers; layout labels the column.
        self.assertEqual(roster["sections"][0], ["11"])
        self.assertNotIn("11", roster["teachers"])

    def test_a_school_with_no_homerooms_is_an_error(self):
        self._roster({})
        with self.assertRaises(R.ReportError):
            R.fetch_roster(3055, 35)

    def test_section_order_is_the_query_order(self):
        # sectionid order IS the classroom column order in the sheet.
        self._roster({"GR00K": [{"sectionid": "274411"},
                                {"sectionid": "274378"},
                                {"sectionid": "274379"}]})
        roster = R.fetch_roster(3055, 35)
        self.assertEqual(roster["sections"][0], ["274411", "274378", "274379"])

    def test_a_non_numeric_sectionid_is_refused(self):
        # Section ids are inlined into FILTER clauses by gen_sql. A
        # non-numeric one is both a broken query and an injection point.
        with self.assertRaises(R.ReportError):
            R.section_ids(["274378", "274379); DROP"])

    def test_numeric_ids_become_ints(self):
        self.assertEqual(R.section_ids(["274378", " 274379 "]),
                         [274378, 274379])


class TheYearReachesTheWarehouse(RestoresModuleFunctions):
    """The resolved yearid must appear in the SQL, not the module default."""

    def test_the_generated_sql_uses_the_resolved_year(self):
        config = {"id": 3055, "name": "X", "sections": {0: [11]}}
        out = pathlib.Path(tempfile.mkdtemp())
        blob = "".join(p.read_text()
                       for p in gen_sql.generate(config, out, year=34))
        self.assertIn("yearid=34", blob)
        self.assertNotIn("yearid=35", blob)


class QueriesRunOnceAndRetryOnce(RestoresModuleFunctions):
    """No paging, no export, and R&A's "retry once" for the ~90s queries."""

    def test_a_query_is_one_call(self):
        calls = []
        R.query = lambda sql, reason: calls.append(reason) or [{"meas": "x"}]
        R.query_one("SELECT 1", "why")
        self.assertEqual(len(calls), 1)

    def test_a_timeout_is_retried_exactly_once(self):
        calls = []

        def flaky(sql, reason):
            calls.append(reason)
            if len(calls) == 1:
                raise R.ReportError("statement timeout")
            return [{"meas": "x"}]

        R.query = flaky
        self.assertEqual(R.query_one("SELECT 1", "why"), [{"meas": "x"}])
        self.assertEqual(len(calls), 2)

    def test_a_second_failure_is_not_swallowed(self):
        def always(sql, reason):
            raise R.ReportError("statement timeout")

        R.query = always
        with self.assertRaises(R.ReportError):
            R.query_one("SELECT 1", "why")

    def test_export_is_never_requested(self):
        seen = {}

        def fake(argv, what, **kwargs):
            seen["argv"] = argv
            return {"content": [{"type": "text", "text": "[]"}]}

        R.run_json = fake
        self.assertEqual(R.query("SELECT 1", "why"), [])
        self.assertNotIn("--export", seen["argv"])
        self.assertNotIn("--limit", seen["argv"])
        self.assertNotIn("--offset", seen["argv"])


class OneBadQueryDoesNotLoseTheReport(RestoresModuleFunctions):
    """A failed block is a stated gap IN the tab, never a silent absence.

    Losing 39 good queries to one bad one is the failure mode this replaces;
    so is a workbook that looks complete because the block that could not be
    produced simply is not there.
    """

    def setUp(self):
        super().setUp()
        self.work = pathlib.Path(tempfile.mkdtemp())
        self.sqldir = self.work / "sql"
        self.sqldir.mkdir()
        self.specs = [
            {"name": "g0_A_dibels_pr.sql", "grade": 0, "shape": "quartile",
             "values": [("a", "Raw")], "order": 20, "title": "DIBELS",
             "note": "", "sections": [11]},
            {"name": "g0_levels.sql", "grade": 0, "shape": "levels",
             "values": [("start", "PR Start")], "order": 60,
             "title": "Levels", "note": "", "sections": []},
        ]
        for spec in self.specs:
            (self.sqldir / spec["name"]).write_text("SELECT 1")

    def test_a_failed_query_becomes_a_gap_and_the_rest_still_run(self):
        def fake(sql, reason):
            if "levels" in reason:
                raise R.ReportError("statement timeout")
            return [{"meas": "LNF", "qt": "All", "a1": 3, "n1": 5}]

        R.query_one = fake
        results, gaps = R.run_queries(self.specs, self.sqldir, self.work,
                                      lambda m: None)
        self.assertIn("g0_A_dibels_pr.sql", results)
        self.assertNotIn("g0_levels.sql", results)
        self.assertEqual(len(gaps[0]), 1)
        self.assertIn("Levels", gaps[0][0])

    def test_the_gap_is_written_into_the_tab(self):
        R.query_one = lambda sql, reason: (_ for _ in ()).throw(
            R.ReportError("boom"))
        results, gaps = R.run_queries(self.specs, self.sqldir, self.work,
                                      lambda m: None)
        values = layout.tab("Somewhere", 0, "2025-2026",
                            [(s, results.get(s["name"], [])) for s in self.specs],
                            {}, gaps.get(0, ()))
        flat = "\n".join(str(cell) for row in values for cell in row)
        self.assertIn("Not included in this report", flat)

    def test_each_query_is_checkpointed_separately(self):
        calls = []
        R.query_one = lambda sql, reason: calls.append(reason) or []
        R.run_queries(self.specs, self.sqldir, self.work, lambda m: None)
        self.assertEqual(len(calls), 2)
        # A resumed run must not re-run what already answered: a report that
        # dies on query 31 of 40 resumes at 31.
        R.run_queries(self.specs, self.sqldir, self.work, lambda m: None)
        self.assertEqual(len(calls), 2)

    def test_a_failed_query_is_retried_on_the_next_run(self):
        R.query_one = lambda sql, reason: (_ for _ in ()).throw(
            R.ReportError("boom"))
        R.run_queries(self.specs, self.sqldir, self.work, lambda m: None)
        calls = []
        R.query_one = lambda sql, reason: calls.append(reason) or []
        results, gaps = R.run_queries(self.specs, self.sqldir, self.work,
                                      lambda m: None)
        self.assertEqual(len(calls), 2)
        self.assertEqual(gaps, {})


if __name__ == "__main__":
    unittest.main()
