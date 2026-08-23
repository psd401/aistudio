"""The sheet layout.

layout.py places numbers; it never computes one. So these tests are about
whether a reader can trust what a cell means: that the quartile rows are in
the order the model report uses, that a column is labelled with the teacher
whose students are in it, that an em dash means "nobody" and not "not
measured", and that a block which produced nothing says so in the tab.

The column meanings come from gen_sql.specs(), which is the same list gen_sql
used to build the SELECT. Reading them off the data instead is what produced
a week of empty tabs.
"""

import pathlib
import sys
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import gen_sql  # noqa: E402
import layout  # noqa: E402

SPEC_QUARTILE = {
    "name": "g1_A_dibels_pr.sql", "grade": 1, "shape": "quartile",
    "values": [("a", "Raw"), ("p", "PR")], "order": 20,
    "title": "DIBELS 8 — Avg Raw Score & National PR Change (Fall→Spring)",
    # Deliberately in neither ascending nor descending id order: the column
    # order is the ROSTER's, and a stray sort in either direction must fail
    # the order test rather than accidentally reproduce it.
    "note": "Local quartiles.", "sections": [274398, 274349, 274500],
}
SPEC_SUBGROUP = {
    "name": "g1_C_sub_pr.sql", "grade": 1, "shape": "subgroup",
    "values": [("p", "PR")], "order": 50, "title": "By subgroup", "note": "",
    "sections": [],
}
SPEC_LEVELS = {
    "name": "g1_levels.sql", "grade": 1, "shape": "levels",
    "values": [("start", "PR Start"), ("end", "PR End")], "order": 60,
    "title": "School vs District", "note": "", "sections": [],
}
SPEC_PROF = {
    "name": "g3_sba_prof.sql", "grade": 3, "shape": "prof",
    "values": [("p", "% Met")], "order": 40, "title": "SBA Proficiency",
    "note": "", "sections": [274382],
}


def flatten(values):
    return ["|".join(str(cell) for cell in row) for row in values]


class QuartileRowsAreInTheModelReportsOrder(unittest.TestCase):
    """All, then D (highest) down to A (lowest).

    Not cosmetic: a workbook that orders quartiles differently from the report
    it is modeled on invites a reader to compare the wrong rows.
    """

    def setUp(self):
        rows = [
            {"meas": "LNF", "qt": qt, "a1": 3, "p1": -1, "n1": 5,
             "a2": 4, "p2": 2, "n2": 6, "a3": 5, "p3": 3, "n3": 7,
             "a_sch": 3.5, "p_sch": 0, "n_sch": 11,
             "a_dist": 3.1, "p_dist": 1, "n_dist": 900}
            for qt in ("All", "1", "2", "3", "4")
        ]
        self.block = layout.block(SPEC_QUARTILE, rows, {})

    def test_the_row_order_is_all_d_c_b_a(self):
        labels = [row[0] for row in self.block if row and row[0] in
                  ("All", "D (highest)", "C", "B", "A (lowest)")]
        self.assertEqual(labels,
                         ["All", "D (highest)", "C", "B", "A (lowest)"])

    def test_d_is_quartile_four_not_quartile_one(self):
        # NTILE(4) numbers the LOWEST baseline quartile 1. D is the highest.
        self.assertEqual(dict(layout.QUARTILE_ROWS)["D (highest)"], "4")
        self.assertEqual(dict(layout.QUARTILE_ROWS)["A (lowest)"], "1")

    def test_every_value_carries_its_own_n(self):
        row = [r for r in self.block if r and r[0] == "All"][0]
        # 3 sections + school + district, each Raw, PR, n
        self.assertEqual(len(row), 1 + 5 * 3)
        self.assertEqual(row[1:4], [3, -1, 5])

    def test_the_header_names_the_value_columns(self):
        sub = [r for r in self.block if r and r[0] == ""][0]
        self.assertEqual(sub[1:4], ["Raw", "PR", "n"])


class ClassroomColumnsNameTheTeacher(unittest.TestCase):
    def test_the_teacher_name_and_id_are_both_shown(self):
        self.assertEqual(
            layout.teacher_label(274398, {"274398": "Jane Hansen"}),
            "Jane Hansen (274398)")

    def test_an_unresolvable_teacher_is_labelled_not_dropped(self):
        # R&A's rule. Those students are still in the numbers.
        self.assertEqual(layout.teacher_label(274398, {}),
                         "(Not on file) (274398)")

    def test_the_columns_follow_the_spec_section_order(self):
        block = layout.block(
            SPEC_QUARTILE,
            [{"meas": "LNF", "qt": "All", "n1": 1, "n2": 1, "n3": 1}],
            {"274398": "Jane Hansen", "274349": "Ann Lee",
             "274500": "Bo Ruiz"})
        header = [r for r in block if "School" in r][0]
        self.assertEqual(
            [c for c in header if c],
            ["LNF", "Jane Hansen (274398)", "Ann Lee (274349)",
             "Bo Ruiz (274500)", "School", "District"])


class AnEmDashMeansNobody(unittest.TestCase):
    """layout.md: `—` only when n = 0. A blank would read as "not measured"."""

    def test_a_zero_n_group_is_all_dashes(self):
        block = layout.block(
            SPEC_QUARTILE,
            [{"meas": "LNF", "qt": "All", "a1": None, "p1": None, "n1": 0,
              "a2": 4, "p2": 2, "n2": 6}], {})
        row = [r for r in block if r and r[0] == "All"][0]
        self.assertEqual(row[1:4], ["—", "—", "—"])
        self.assertEqual(row[4:7], [4, 2, 6])

    def test_a_quartile_the_query_never_returned_is_dashes(self):
        block = layout.block(
            SPEC_QUARTILE, [{"meas": "LNF", "qt": "All", "a1": 3, "n1": 5}], {})
        row = [r for r in block if r and r[0] == "A (lowest)"][0]
        self.assertEqual(set(row[1:]), {"—"})

    def test_a_null_value_with_a_real_n_is_a_dash_not_a_zero(self):
        # A missing PR is not a PR of zero: reporting 0 would say the students
        # scored at the bottom of the national distribution.
        block = layout.block(
            SPEC_QUARTILE,
            [{"meas": "LNF", "qt": "All", "a1": 3, "p1": None, "n1": 5}], {})
        row = [r for r in block if r and r[0] == "All"][0]
        self.assertEqual(row[1:4], [3, "—", 5])

    def test_a_string_null_from_the_mcp_is_also_a_dash(self):
        # The markdown reading returns strings; "NULL" is not a value.
        block = layout.block(
            SPEC_QUARTILE,
            [{"meas": "LNF", "qt": "All", "a1": "3.2", "p1": "NULL",
              "n1": "5"}], {})
        row = [r for r in block if r and r[0] == "All"][0]
        self.assertEqual(row[1:4], ["3.2", "—", 5])


class SubgroupsReadPaired(unittest.TestCase):
    def test_each_subgroup_sits_next_to_its_complement(self):
        rows = [{"meas": "LNF", "lbl": lbl, "p_sch": 1, "n_sch": 10,
                 "p_dist": 2, "n_dist": 99}
                for lbl in ("Low Income", "Non-Low Income", "Special Ed",
                            "Non-Special Ed")]
        block = layout.block(SPEC_SUBGROUP, rows, {})
        labels = [r[0] for r in block if r and r[0] in layout.SUBGROUP_ROWS]
        self.assertEqual(labels, layout.SUBGROUP_ROWS)

    def test_a_subgroup_only_has_school_and_district_columns(self):
        block = layout.block(
            SPEC_SUBGROUP,
            [{"meas": "LNF", "lbl": "Low Income", "p_sch": 1, "n_sch": 10,
              "p_dist": 2, "n_dist": 99}], {})
        row = [r for r in block if r and r[0] == "Low Income"][0]
        self.assertEqual(row, ["Low Income", 1, 10, 2, 99])

    def test_an_unexpected_label_is_still_printed(self):
        # Dropping a returned row would hide real students.
        block = layout.block(
            SPEC_SUBGROUP,
            [{"meas": "LNF", "lbl": "Multilingual", "p_sch": 1, "n_sch": 4,
              "p_dist": 1, "n_dist": 9}], {})
        self.assertTrue(any(r and r[0] == "Multilingual" for r in block))


class LevelsAreStartAndEnd(unittest.TestCase):
    def test_the_columns_are_school_then_district_start_end_n(self):
        block = layout.block(
            SPEC_LEVELS,
            [{"meas": "LNF", "qt": "All", "s_start": 40, "s_end": 45,
              "n_sch": 60, "d_start": 38, "d_end": 44, "n_dist": 900}], {})
        row = [r for r in block if r and r[0] == "All"][0]
        self.assertEqual(row, ["All", 40, 45, 60, 38, 44, 900])

    def test_the_header_says_start_and_end(self):
        block = layout.block(
            SPEC_LEVELS, [{"meas": "LNF", "qt": "All", "n_sch": 1,
                           "n_dist": 1}], {})
        sub = [r for r in block if r and r[0] == ""][0]
        self.assertEqual(sub[1:4], ["PR Start", "PR End", "n"])


class ProficiencyHasNoQuartileRows(unittest.TestCase):
    def test_the_measure_is_the_row(self):
        block = layout.block(
            SPEC_PROF,
            [{"meas": "ELA", "p1": 62, "n1": 20, "p_sch": 58, "n_sch": 60,
              "p_dist": 55, "n_dist": 900},
             {"meas": "Math", "p1": 50, "n1": 20, "p_sch": 48, "n_sch": 60,
              "p_dist": 45, "n_dist": 900}], {})
        labels = [r[0] for r in block if r and r[0] in ("ELA", "Math")]
        self.assertEqual(labels, ["ELA", "Math"])
        self.assertNotIn("D (highest)", flatten(block))

    def test_the_header_is_written_once(self):
        block = layout.block(
            SPEC_PROF,
            [{"meas": "ELA", "p1": 1, "n1": 1},
             {"meas": "Math", "p1": 1, "n1": 1}], {})
        self.assertEqual(sum(1 for r in block if r and r[0] == "Measure"), 1)


class NothingIsSilentlyAbsent(unittest.TestCase):
    """SKILL.md's contract: what the report cannot produce is written IN."""

    def test_a_block_with_no_rows_says_so(self):
        block = layout.block(SPEC_QUARTILE, [], {})
        self.assertIn("— no data returned for this block", flatten(block))

    def test_the_block_title_is_still_shown(self):
        block = layout.block(SPEC_QUARTILE, [], {})
        self.assertEqual(block[0][0], SPEC_QUARTILE["title"])

    def test_gaps_are_listed_at_the_bottom_of_the_tab(self):
        values = layout.tab("Somewhere", 1, "2025-2026", [], {},
                            ["SBA: not included (query failed)"])
        flat = flatten(values)
        self.assertIn("Not included in this report", flat)
        self.assertIn("SBA: not included (query failed)", flat)

    def test_a_complete_tab_carries_no_gap_banner(self):
        values = layout.tab("Somewhere", 1, "2025-2026", [], {}, [])
        self.assertNotIn("Not included in this report", flatten(values))


class TheTabIsSelfDescribing(unittest.TestCase):
    def test_the_title_row_names_school_grade_and_year(self):
        values = layout.tab("Artondale Elementary", 0, "2025-2026", [], {})
        self.assertEqual(
            values[0][0],
            "Artondale Elementary — Grade K Growth by Quartile (2025-2026)")

    def test_kindergarten_reads_as_k_not_zero(self):
        self.assertEqual(layout.grade_label(0), "K")
        self.assertEqual(layout.grade_label(5), "5")

    def test_the_block_note_is_carried_into_the_tab(self):
        # The local-quartile explanation is the one thing a reader cannot
        # infer from the numbers: a classroom's A is not the district's A.
        values = layout.tab(
            "Somewhere", 1, "2025-2026",
            [(SPEC_QUARTILE, [{"meas": "LNF", "qt": "All", "n1": 1}])], {})
        self.assertIn("Local quartiles.", flatten(values))

    def test_the_write_body_is_the_exact_sheets_request(self):
        body = layout.body_for("K", [["a"], ["b"]])
        self.assertEqual(body["valueInputOption"], "RAW")
        self.assertEqual(body["data"][0]["range"], "'K'!A1")
        self.assertEqual(body["data"][0]["values"], [["a"], ["b"]])


class TheSpecsCoverEveryShapeLayoutKnows(unittest.TestCase):
    """A spec shape layout cannot render would be a blank block at runtime."""

    def test_every_generated_spec_renders(self):
        for spec in gen_sql.specs(gen_sql.SCHOOLS["evergreen"]):
            groups = layout.groups_for(spec, {})
            self.assertTrue(groups, spec["name"])
            self.assertTrue(layout.block(spec, [], {}), spec["name"])

    def test_an_unknown_shape_fails_loudly(self):
        with self.assertRaises(ValueError):
            layout.groups_for(dict(SPEC_QUARTILE, shape="mystery"), {})


if __name__ == "__main__":
    unittest.main()
