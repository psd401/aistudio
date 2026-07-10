"""Tests for check_bootstrap_budget — the instruction-budget gate (#1161).

Pure-function module, no Docker/AWS deps. Run:
    uv run --with pytest python3 -m pytest infra/agent-image/test_check_bootstrap_budget.py
"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(__file__))

import check_bootstrap_budget as cbb  # noqa: E402


def _write(path: str, text: str) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


class ReadBudgetsTests(unittest.TestCase):
    def _config(self, defaults) -> str:
        d = tempfile.mkdtemp()
        p = os.path.join(d, "openclaw.json")
        _write(p, json.dumps({"agents": {"defaults": defaults}}))
        return p

    def test_reads_budgets_from_config(self):
        p = self._config({"bootstrapMaxChars": 32000, "bootstrapTotalMaxChars": 80000})
        self.assertEqual(cbb.read_budgets(p), (32000, 80000))

    def test_missing_per_file_raises(self):
        p = self._config({"bootstrapTotalMaxChars": 80000})
        with self.assertRaises(cbb.BudgetError):
            cbb.read_budgets(p)

    def test_non_positive_total_raises(self):
        p = self._config({"bootstrapMaxChars": 32000, "bootstrapTotalMaxChars": 0})
        with self.assertRaises(cbb.BudgetError):
            cbb.read_budgets(p)

    def test_missing_file_raises(self):
        with self.assertRaises(cbb.BudgetError):
            cbb.read_budgets("/nonexistent/openclaw.json")


class StripFrontmatterTests(unittest.TestCase):
    def test_strips_yaml_frontmatter(self):
        text = "---\nname: psd-rules\n---\nBODY LINE 1\nBODY LINE 2\n"
        self.assertEqual(cbb._strip_frontmatter(text), "BODY LINE 1\nBODY LINE 2\n")

    def test_no_frontmatter_returns_unchanged(self):
        text = "just a body\nno fences\n"
        self.assertEqual(cbb._strip_frontmatter(text), text)


class EffectiveSizesTests(unittest.TestCase):
    def test_soul_includes_psd_rules_body(self):
        d = tempfile.mkdtemp()
        _write(os.path.join(d, "SOUL.md"), "SOUL")
        os.makedirs(os.path.join(d, "skills", "psd-rules"))
        _write(
            os.path.join(d, "skills", "psd-rules", "SKILL.md"),
            "---\nname: x\n---\nRULES BODY",
        )
        sizes = cbb.effective_bootstrap_sizes(d)
        # SOUL.md effective = "SOUL" + separator + "RULES BODY" (frontmatter stripped)
        expected = len("SOUL") + len(cbb._PSD_RULES_SEPARATOR) + len("RULES BODY")
        self.assertEqual(sizes["SOUL.md"], expected)

    def test_omits_absent_files(self):
        d = tempfile.mkdtemp()
        _write(os.path.join(d, "SOUL.md"), "SOUL")
        sizes = cbb.effective_bootstrap_sizes(d)
        self.assertIn("SOUL.md", sizes)
        self.assertNotIn("IDENTITY.md", sizes)


class FindViolationsTests(unittest.TestCase):
    def test_within_budget_no_violations(self):
        self.assertEqual(cbb.find_violations({"SOUL.md": 100}, 200, 500), [])

    def test_per_file_over_budget_flagged(self):
        v = cbb.find_violations({"SOUL.md": 300}, 200, 5000)
        self.assertEqual(len(v), 1)
        self.assertIn("SOUL.md", v[0])
        self.assertIn("bootstrapMaxChars", v[0])

    def test_total_over_budget_flagged(self):
        v = cbb.find_violations({"A.md": 100, "B.md": 100}, 200, 150)
        self.assertTrue(any("TOTAL" in s for s in v))


class CheckRuntimeBootstrapTests(unittest.TestCase):
    def test_returns_violations_over_budget(self):
        d = tempfile.mkdtemp()
        _write(os.path.join(d, "openclaw.json"),
               json.dumps({"agents": {"defaults": {
                   "bootstrapMaxChars": 3, "bootstrapTotalMaxChars": 100}}}))
        _write(os.path.join(d, "SOUL.md"), "way too long")
        violations = cbb.check_runtime_bootstrap(
            os.path.join(d, "openclaw.json"), d)
        self.assertTrue(violations)

    def test_never_raises_on_bad_config(self):
        # Missing config -> empty list, not an exception (telemetry must not
        # break a boot).
        self.assertEqual(cbb.check_runtime_bootstrap("/nope.json", "/nope"), [])

    def test_within_budget_returns_empty(self):
        d = tempfile.mkdtemp()
        _write(os.path.join(d, "openclaw.json"),
               json.dumps({"agents": {"defaults": {
                   "bootstrapMaxChars": 1000, "bootstrapTotalMaxChars": 5000}}}))
        _write(os.path.join(d, "SOUL.md"), "short")
        self.assertEqual(
            cbb.check_runtime_bootstrap(os.path.join(d, "openclaw.json"), d), [])


class MainCliTests(unittest.TestCase):
    def test_real_repo_files_within_budget(self):
        # The actual agent-image files must pass the gate at HEAD.
        here = os.path.dirname(os.path.abspath(__file__))
        rc = cbb.main(["--config", os.path.join(here, "openclaw.json"),
                       "--source-dir", here])
        self.assertEqual(rc, 0)


if __name__ == "__main__":
    unittest.main()
