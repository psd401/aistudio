"""Tests for the agent skill eval-coverage drift gate."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path


AGENT_IMAGE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(AGENT_IMAGE_DIR))

import check_eval_coverage  # noqa: E402


class EvalCoverageTests(unittest.TestCase):
    def test_committed_skill_inventory_has_no_coverage_gaps(self) -> None:
        self.assertEqual(
            check_eval_coverage.coverage_gaps(
                check_eval_coverage.DEFAULT_SKILLS_ROOT
            ),
            [],
        )

    def test_skill_without_evals_fails_the_drift_gate(self) -> None:
        with tempfile.TemporaryDirectory(
            prefix="issue-1426-eval-coverage-"
        ) as directory:
            skills_root = Path(directory)
            covered = skills_root / "covered"
            covered.joinpath("evals").mkdir(parents=True)
            covered.joinpath("SKILL.md").write_text(
                "---\nname: covered\n---\n",
                encoding="utf-8",
            )
            covered.joinpath("evals", "task.yaml").write_text(
                "id: covered-task\n",
                encoding="utf-8",
            )
            missing = skills_root / "missing"
            missing.mkdir()
            missing.joinpath("SKILL.md").write_text(
                "---\nname: missing\n---\n",
                encoding="utf-8",
            )
            skills_root.joinpath("_shared").mkdir()

            self.assertEqual(
                check_eval_coverage.coverage_gaps(skills_root, {}),
                [
                    "missing: expected at least one task in "
                    "missing/evals"
                ],
            )

    def test_opt_outs_must_be_current_and_explained(self) -> None:
        with tempfile.TemporaryDirectory(
            prefix="issue-1426-eval-opt-out-"
        ) as directory:
            skills_root = Path(directory)
            rules = skills_root / "rules"
            rules.mkdir()
            rules.joinpath("SKILL.md").write_text(
                "---\nname: rules\n---\n",
                encoding="utf-8",
            )

            self.assertEqual(
                check_eval_coverage.coverage_gaps(
                    skills_root,
                    {"rules": "global policy"},
                ),
                [],
            )
            self.assertEqual(
                check_eval_coverage.coverage_gaps(
                    skills_root,
                    {"rules": "", "retired": "gone"},
                ),
                [
                    "stale opt-out 'retired': no shipped SKILL.md exists",
                    "opt-out 'rules' must include a reason",
                ],
            )


if __name__ == "__main__":
    unittest.main()
