"""Tests for build_tab.py — the layout step, shipped so nothing is hand-written.

This script exists because the model kept having to author the records->grid
transform, and the write tool's literal \\n bug killed runs there after every
rollup was already computed (2026-08-15, twice, once with all data done).
"""

import json
import os
import subprocess
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import build_tab  # noqa: E402

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "build_tab.py")


def rec(scope, qt, n=4, growth=1.5, pr=None, meas="ORF", section=None, subgroup=None):
    return {
        "meas": meas, "scope": scope, "qt": qt, "n": n, "growth": growth,
        "pr_growth": pr, "sectionid": section, "subgroup": subgroup,
    }


class Cells(unittest.TestCase):
    def test_zero_n_is_an_em_dash_not_a_blank(self):
        # layout.md: `—` only when n = 0. A blank reads as "not measured".
        self.assertEqual(build_tab.cell(rec("school", "All", n=0)), "—")
        self.assertEqual(build_tab.cell(None), "—")

    def test_pr_is_omitted_when_the_measure_has_none(self):
        self.assertEqual(build_tab.cell(rec("school", "All", n=5, growth=2.0)), "2.0/5")

    def test_pr_is_included_when_present(self):
        self.assertEqual(
            build_tab.cell(rec("school", "All", n=5, growth=2.0, pr=3.0)), "2.0/3.0/5"
        )


class Layout(unittest.TestCase):
    RECORDS = [
        rec("district", "All"), rec("district", "4"), rec("district", "1"),
        rec("school", "All"), rec("school", "4"), rec("school", "1"),
        rec("class", "All", section="S1"), rec("class", "4", section="S1"),
        rec("class", "All", section="S2"),
    ]

    def grid(self):
        return build_tab.build(self.RECORDS, "Minter Creek", "K", "2025-26", "Fall→Spring")

    def test_quartile_row_order_is_all_then_high_to_low(self):
        # Not cosmetic: a different order invites comparing the wrong rows
        # against the report this is modeled on.
        labels = [r[0] for r in self.grid()["values"] if r and r[0] in
                  {"All", "D (highest)", "C", "B", "A (lowest)"}]
        self.assertEqual(labels[:5], ["All", "D (highest)", "C", "B", "A (lowest)"])

    def test_classroom_columns_appear(self):
        # The per-teacher breakdown is the point of the report; aggregate.py
        # emits sectionid so these columns can exist at all.
        header = next(r for r in self.grid()["values"] if r and r[0] == "Quartile")
        self.assertIn("S1", header)
        self.assertIn("S2", header)
        self.assertEqual(header[-2:], ["School", "District"])

    def test_section_columns_are_ordered_deterministically(self):
        shuffled = list(reversed(self.RECORDS))
        a = build_tab.build(self.RECORDS, "X", "K", "y", "w")["values"]
        b = build_tab.build(shuffled, "X", "K", "y", "w")["values"]
        ha = next(r for r in a if r and r[0] == "Quartile")
        hb = next(r for r in b if r and r[0] == "Quartile")
        self.assertEqual(ha, hb)

    def test_title_names_the_window_actually_used(self):
        # A Fall→Winter report labeled Fall→Spring is a wrong report.
        grid = build_tab.build(self.RECORDS, "X", "K", "2025-26", "Fall→Winter")
        block = next(r for r in grid["values"] if r and "Fall→Winter" in str(r[0]))
        self.assertIn("Fall→Winter", block[0])

    def test_subgroups_render_school_and_district(self):
        records = self.RECORDS + [
            rec("school", "All", n=18, growth=19.9, subgroup="Low Income"),
            rec("district", "All", n=402, growth=15.2, subgroup="Low Income"),
        ]
        values = build_tab.build(records, "X", "K", "y", "w")["values"]
        row = next(r for r in values if r and r[0] == "Low Income")
        self.assertEqual(row[2], "19.9/18")
        self.assertEqual(row[3], "15.2/402")


class Payloads(unittest.TestCase):
    """The point: gws-ready bodies, so the model authors no file."""

    def run_script(self, records, *extra):
        proc = subprocess.run(
            [sys.executable, SCRIPT, "--school", "X", "--grade", "K",
             "--year", "2025-26", *extra],
            input=json.dumps(records), capture_output=True, text=True,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return json.loads(proc.stdout)

    def test_values_payload_is_ready_for_batchupdate(self):
        out = self.run_script([rec("school", "All")])
        self.assertEqual(out["valueInputOption"], "RAW")
        self.assertEqual(out["data"][0]["range"], "K!A1")
        self.assertTrue(out["data"][0]["values"])

    def test_raw_not_user_entered(self):
        # USER_ENTERED would let Sheets reinterpret "—" or "1/2/3" as a date.
        out = self.run_script([rec("school", "All")])
        self.assertNotEqual(out["valueInputOption"], "USER_ENTERED")

    def test_addsheet_payload_needs_no_rows(self):
        proc = subprocess.run(
            [sys.executable, SCRIPT, "--school", "X", "--grade", "3",
             "--year", "y", "--emit", "addsheet"],
            capture_output=True, text=True,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        body = json.loads(proc.stdout)
        self.assertEqual(body["requests"][0]["addSheet"]["properties"]["title"], "3")


if __name__ == "__main__":
    unittest.main()
