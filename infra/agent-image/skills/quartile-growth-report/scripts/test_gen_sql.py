"""The generator must reproduce R&A's validated SQL byte-for-byte.

This is the only test in this skill that compares against material we did not
write. Everything I built from 2026-08-14 onward was designed from prose docs
and my own reading of the schema, and it failed on every invocation for a
week: guessed column names, guessed table names, a response format I asserted
without checking, quartiles computed locally because I had concluded NTILE
could not run.

James Cantonwine's handoff (2026-08-17) contains the 40 queries as actually
run against psd-data for Evergreen (schoolid 3055, yearid 35), and its first
instruction is that the skill be "a transcription of this material, not a
fresh design".

So the fixtures in tests/fixtures/sql-evergreen are the source of truth, and
this test fails if the generator drifts from them by a single byte. A test
against real validated output cannot pass while the thing it describes is
broken — which is exactly what my invented fixtures did.
"""

import pathlib
import subprocess
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
FIXTURES = HERE.parent / "tests" / "fixtures" / "sql-evergreen"
NORMS = HERE.parent / "references" / "norms"

sys.path.insert(0, str(HERE))

import gen_sql  # noqa: E402


class GeneratedSqlMatchesTheValidatedQueries(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.out = pathlib.Path(tempfile.mkdtemp())
        gen_sql.generate(gen_sql.SCHOOLS["evergreen"], cls.out)

    def test_every_validated_query_is_reproduced(self):
        expected = sorted(p.name for p in FIXTURES.glob("*.sql"))
        actual = sorted(p.name for p in self.out.glob("*.sql"))
        self.assertEqual(actual, expected)

    def test_each_query_is_byte_identical(self):
        drifted = []
        for fixture in sorted(FIXTURES.glob("*.sql")):
            produced = self.out / fixture.name
            if produced.read_bytes() != fixture.read_bytes():
                drifted.append(fixture.name)
        self.assertEqual(drifted, [], f"generator drifted from R&A: {drifted}")

    def test_there_are_forty_of_them(self):
        # A generator that silently stopped emitting a family would still be
        # "byte identical" over what it did emit.
        self.assertEqual(len(list(self.out.glob("*.sql"))), 40)


class TheNormsAssetIsBundled(unittest.TestCase):
    """A hard dependency the agent cannot derive.

    Extracted from UO Technical Report 2201 and validated (zero non-monotonic
    columns, zero gaps, 14/14 spot checks). Without it there is no national
    percentile change, and inventing one would misstate how a child scored
    against national peers in a document a principal reads as fact.
    """

    def test_a_fragment_exists_for_every_grade(self):
        for grade in range(6):
            self.assertTrue((NORMS / f"norms_sql_g{grade}.txt").exists(),
                            f"missing norms fragment for grade {grade}")

    def test_each_fragment_is_a_values_cte(self):
        for grade in range(6):
            text = gen_sql.norms_fragment(grade)
            self.assertTrue(text.startswith("norms(meas0, per, cut, pr) AS (VALUES"))
            self.assertTrue(text.rstrip().endswith(")"))

    def test_a_missing_fragment_fails_loudly(self):
        with self.assertRaises(FileNotFoundError):
            gen_sql.norms_fragment(99)


class TheNonNegotiablesAreInTheSql(unittest.TestCase):
    """R&A's list, each item learned the hard way. Asserted against the
    generated SQL so a future edit cannot quietly drop one."""

    @classmethod
    def setUpClass(cls):
        cls.sql = {p.name: p.read_text() for p in FIXTURES.glob("*.sql")}

    def test_every_ntile_has_the_studentid_tiebreak(self):
        # ORDER BY b alone splits tied baselines arbitrarily: 19 of 100
        # quartile cells moved between identical runs before this was added.
        for name, text in self.sql.items():
            for window in text.split("NTILE(4) OVER (")[1:]:
                clause = window.split(")")[0]
                self.assertIn("ORDER BY b, studentid", clause,
                              f"{name}: NTILE without the deterministic tiebreak")

    def test_sba_filters_out_participation_rows(self):
        # smarter_balanced_scores mixes IAB rows (score = 1) with summatives;
        # unfiltered averages are garbage.
        for name, text in self.sql.items():
            if "smarter_balanced_scores" not in text:
                continue
            self.assertIn("assessment_group LIKE 'Summative%'", text, name)
            self.assertIn("is_strand=false", text, name)

    def test_window_is_always_quoted(self):
        # `window` is a reserved word.
        for name, text in self.sql.items():
            self.assertNotIn(' window ', text, f"{name}: unquoted reserved word")

    def test_no_bare_numeric_cast(self):
        # The MCP rejects ::numeric without precision.
        for name, text in self.sql.items():
            self.assertNotIn("::numeric", text.lower(), name)

    def test_the_lead_teacher_join_never_filters_on_priorityorder(self):
        for name, text in self.sql.items():
            self.assertNotIn("priorityorder", text, name)


class TheManifestMatchesWhatIsGenerated(unittest.TestCase):
    """specs() says how to READ each query back; generate() writes them.

    They live in one module so the sheet layout is derived from the same list
    that built the SELECT. If they drift, a column gets read under the wrong
    heading and every number in that block is mislabelled — silently, because
    the numbers are all real.
    """

    def test_every_generated_file_has_a_spec(self):
        out = pathlib.Path(tempfile.mkdtemp())
        files = {p.name for p in
                 gen_sql.generate(gen_sql.SCHOOLS["evergreen"], out)}
        names = [s["name"] for s in gen_sql.specs(gen_sql.SCHOOLS["evergreen"])]
        self.assertEqual(sorted(names), sorted(files))
        self.assertEqual(len(names), len(set(names)), "duplicate spec")

    def test_a_quartile_spec_carries_the_sections_it_pivots_on(self):
        specs = {s["name"]: s
                 for s in gen_sql.specs(gen_sql.SCHOOLS["evergreen"])}
        spec = specs["g0_A_dibels_pr.sql"]
        self.assertEqual(spec["shape"], "quartile")
        self.assertEqual(spec["sections"],
                         gen_sql.SCHOOLS["evergreen"]["sections"][0])
        # The value prefixes must be the ones the SELECT aliased.
        sql = (FIXTURES / "g0_A_dibels_pr.sql").read_text()
        for prefix, _ in spec["values"]:
            self.assertIn(f" AS {prefix}1", sql)
            self.assertIn(f" AS {prefix}_sch", sql)

    def test_the_orf_block_is_labelled_with_its_own_baseline(self):
        # Grade 1 ORF starts mid-year: Winter->Spring while the rest of the
        # grade is Fall->Spring. Labelling both the same misstates what was
        # measured, which is the one thing a principal cannot check.
        specs = {s["name"]: s
                 for s in gen_sql.specs(gen_sql.SCHOOLS["evergreen"])}
        self.assertIn("Winter", specs["g1_A2_orf_pr.sql"]["title"])
        self.assertIn("Fall", specs["g1_A_dibels_pr.sql"]["title"])


class TheSchoolAndYearAreParameters(unittest.TestCase):
    """R&A's generator hardcoded both; the skill discovers them.

    Accepting a `year` argument and then interpolating the module constant is
    exactly the dead-parameter bug this skill has shipped before — the tests
    pass, the report is silently built for the wrong year.
    """

    def _blob(self, **kwargs):
        out = pathlib.Path(tempfile.mkdtemp())
        return "".join(p.read_text() for p in
                       gen_sql.generate(gen_sql.SCHOOLS["evergreen"], out,
                                        **kwargs))

    def test_the_year_argument_reaches_every_query(self):
        blob = self._blob(year=34)
        self.assertIn("yearid=34", blob)
        self.assertNotIn("yearid=35", blob)

    def test_the_prior_year_sba_follows_the_requested_year(self):
        self.assertIn("yearid=33", self._blob(year=34))

    def test_the_school_id_reaches_every_scoped_query(self):
        out = pathlib.Path(tempfile.mkdtemp())
        blob = "".join(p.read_text() for p in gen_sql.generate(
            {"id": 4242, "name": "X",
             "sections": {0: [11], 1: [12]}}, out))
        self.assertIn("schoolid=4242", blob)
        self.assertNotIn("schoolid=3055", blob)


class ASchoolNeedNotServeEveryGrade(unittest.TestCase):
    """A grade with no homeroom produces no query, not a query over nothing.

    The SBA, proficiency and levels families are written OUTSIDE the grade
    loop, so a guard that only covered the loop would still emit grade-3/4/5
    queries for a K-2 building — against sections that do not exist.
    """

    def setUp(self):
        self.out = pathlib.Path(tempfile.mkdtemp())
        self.names = {p.name for p in gen_sql.generate(
            {"id": 3055, "name": "K-2 School",
             "sections": {0: [11], 1: [12], 2: [13]}}, self.out)}

    def test_only_the_served_grades_are_generated(self):
        self.assertTrue(self.names)
        self.assertEqual(
            sorted(n for n in self.names
                   if n.startswith(("g3_", "g4_", "g5_"))), [])

    def test_the_served_grades_are_complete(self):
        for grade in (0, 1, 2):
            self.assertIn(f"g{grade}_A_dibels_pr.sql", self.names)
            self.assertIn(f"g{grade}_levels.sql", self.names)

    def test_a_school_with_no_sections_at_all_generates_nothing(self):
        out = pathlib.Path(tempfile.mkdtemp())
        self.assertEqual(
            gen_sql.generate({"id": 1, "name": "X", "sections": {}}, out), [])


if __name__ == "__main__":
    unittest.main()
