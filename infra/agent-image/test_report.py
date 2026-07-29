"""Hermetic tests for agent-eval comparison reporting.

Run with:
    uv run --python 3.12 --no-project -m unittest \
      infra/agent-image/test_report.py
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path

AGENT_IMAGE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(AGENT_IMAGE_DIR / "eval"))

import report as eval_report  # noqa: E402
import summarize  # noqa: E402


TaskSpecs = dict[str, tuple[str, str, int]]


def pricing() -> dict[str, object]:
    return {
        "primary": "amazon-bedrock/synthetic-model",
        "provider": "amazon-bedrock",
        "model_id": "synthetic-model",
        "pricing_usd_per_million_tokens": {
            "input": Decimal("1"),
            "output": Decimal("0"),
            "cacheRead": Decimal("0"),
            "cacheWrite": Decimal("0"),
        },
    }


def build_summary(
    specs: TaskSpecs,
    *,
    digest_character: str,
    input_tokens: int = 1000,
    cache_reads: int = 100,
    duration_ms: int = 1000,
    model_calls: int = 2,
    nudged_tasks: frozenset[str] = frozenset(),
    runtime_failures: dict[str, str] | None = None,
) -> dict[str, object]:
    digest = "sha256:" + (digest_character * 64)
    image = (
        "123456789012.dkr.ecr.us-east-1.amazonaws.com/agent@" + digest
    )
    failures = runtime_failures or {}
    records: list[dict[str, object]] = []
    sequence = 0
    for task_id, (skill, suite, passed_trials) in specs.items():
        for trial in range(1, 4):
            sequence += 1
            failed = task_id in failures and trial == 1
            records.append(
                {
                    "task_id": task_id,
                    "image": image,
                    "skill": skill,
                    "suite": suite,
                    "level": "L1",
                    "workspace": "pure",
                    "trial": trial,
                    "trials": 3,
                    "prompt": "synthetic prompt",
                    "session_id": (
                        f"00000000-0000-4000-8000-{sequence:012d}"
                    ),
                    "result": "synthetic result",
                    "metadata": {
                        "input_tokens": input_tokens,
                        "output_tokens": 0,
                        "cache_read_input_tokens": cache_reads,
                        "cache_write_input_tokens": 0,
                        "model_call_count": model_calls,
                        "duration_ms": duration_ms + trial,
                        "latency_ms": duration_ms - 100 + trial,
                        "nudged": task_id in nudged_tasks and trial == 1,
                        "tool_calls": [],
                        "failed": failed,
                        "error_class": failures.get(task_id) if failed else None,
                    },
                    "broker_requests": [],
                    "grade": {
                        "passed": trial <= passed_trials,
                        "reason": "synthetic",
                        "results": [],
                    },
                    "run_started_at": "2026-07-29T00:00:00+00:00",
                    "recorded_at": (
                        f"2026-07-29T00:00:{sequence:02d}+00:00"
                    ),
                }
            )
    return summarize.summarize_records(
        records,
        pricing(),
        expected_image=image,
        source_commit="c" * 40,
        source_commit_provenance="image-label",
        eval_harness_commit="d" * 40,
    )


def write_summary(directory: Path, summary: dict[str, object]) -> Path:
    digest = str(summary["image_digest"])
    path = directory / f"{digest.replace(':', '-')}.json"
    path.write_text(json.dumps(summary), encoding="utf-8")
    return path


def summary_index_path(summary: dict[str, object]) -> Path:
    digest = str(summary["image_digest"])
    return Path(".eval-runs") / f"{digest.replace(':', '-')}.json"


def clause(
    comparison: eval_report.Comparison,
    key: str,
) -> eval_report.ClauseResult:
    return next(item for item in comparison.clauses if item.key == key)


class PromotionRuleTests(unittest.TestCase):
    def test_all_clauses_pass_at_exactly_twenty_percent_cost_increase(self):
        baseline = build_summary(
            {
                "reg-a": ("skill-a", "regression", 3),
                "cap-a": ("skill-a", "capability", 2),
            },
            digest_character="a",
            input_tokens=1000,
        )
        candidate = build_summary(
            {
                "reg-a": ("skill-a", "regression", 3),
                "cap-a": ("skill-a", "capability", 3),
            },
            digest_character="b",
            input_tokens=1200,
        )

        comparison = eval_report.compare_summaries(baseline, candidate)

        self.assertEqual(comparison.verdict, "PROMOTE")
        self.assertTrue(all(item.passed is True for item in comparison.clauses))
        self.assertIn("20.00%", clause(comparison, "c").detail)

    def test_single_skill_regression_blocks_aggregate_improvement(self):
        baseline = build_summary(
            {
                "reg-a": ("skill-a", "regression", 3),
                "cap-a": ("skill-a", "capability", 2),
                "cap-b": ("skill-b", "capability", 2),
            },
            digest_character="a",
        )
        candidate = build_summary(
            {
                "reg-a": ("skill-a", "regression", 2),
                "cap-a": ("skill-a", "capability", 3),
                "cap-b": ("skill-b", "capability", 3),
            },
            digest_character="b",
        )

        comparison = eval_report.compare_summaries(baseline, candidate)

        self.assertEqual(comparison.verdict, "REJECT")
        self.assertFalse(clause(comparison, "a").passed)
        self.assertTrue(clause(comparison, "b").passed)
        self.assertIn("skill-a", clause(comparison, "a").detail)

    def test_capability_must_strictly_improve(self):
        specs = {
            "reg-a": ("skill-a", "regression", 3),
            "cap-a": ("skill-a", "capability", 2),
        }
        baseline = build_summary(specs, digest_character="a")
        candidate = build_summary(specs, digest_character="b")

        comparison = eval_report.compare_summaries(baseline, candidate)

        self.assertTrue(clause(comparison, "a").passed)
        self.assertFalse(clause(comparison, "b").passed)
        self.assertTrue(clause(comparison, "c").passed)
        self.assertEqual(comparison.verdict, "REJECT")

    def test_cost_increase_over_twenty_percent_rejects(self):
        baseline = build_summary(
            {
                "reg-a": ("skill-a", "regression", 3),
                "cap-a": ("skill-a", "capability", 2),
            },
            digest_character="a",
            input_tokens=1000,
        )
        candidate = build_summary(
            {
                "reg-a": ("skill-a", "regression", 3),
                "cap-a": ("skill-a", "capability", 3),
            },
            digest_character="b",
            input_tokens=1201,
        )

        comparison = eval_report.compare_summaries(baseline, candidate)

        self.assertTrue(clause(comparison, "a").passed)
        self.assertTrue(clause(comparison, "b").passed)
        self.assertFalse(clause(comparison, "c").passed)
        self.assertEqual(comparison.verdict, "REJECT")

    def test_caching_mismatch_declines_cost_clause(self):
        baseline = build_summary(
            {
                "reg-a": ("skill-a", "regression", 3),
                "cap-a": ("skill-a", "capability", 2),
            },
            digest_character="a",
            cache_reads=100,
        )
        candidate = build_summary(
            {
                "reg-a": ("skill-a", "regression", 3),
                "cap-a": ("skill-a", "capability", 3),
            },
            digest_character="b",
            cache_reads=0,
        )

        comparison = eval_report.compare_summaries(baseline, candidate)
        rendered = eval_report.render_terminal(comparison)

        self.assertEqual(comparison.baseline_caching_status, "cached")
        self.assertEqual(comparison.candidate_caching_status, "uncached")
        self.assertIsNone(clause(comparison, "c").passed)
        self.assertEqual(comparison.verdict, "INDETERMINATE")
        self.assertIn("[DECLINED] (c)", rendered)
        self.assertIn("declined: caching mismatch", rendered)

    def test_zero_observed_cache_reads_are_derived_as_uncached(self):
        baseline = build_summary(
            {
                "reg-a": ("skill-a", "regression", 3),
                "cap-a": ("skill-a", "capability", 2),
            },
            digest_character="a",
            cache_reads=0,
        )
        candidate = build_summary(
            {
                "reg-a": ("skill-a", "regression", 3),
                "cap-a": ("skill-a", "capability", 3),
            },
            digest_character="b",
            cache_reads=0,
        )

        comparison = eval_report.compare_summaries(baseline, candidate)

        self.assertEqual(comparison.baseline_caching_status, "uncached")
        self.assertEqual(comparison.candidate_caching_status, "uncached")
        self.assertTrue(clause(comparison, "c").passed)


class ReportRenderingTests(unittest.TestCase):
    def test_changed_tasks_show_passed_trial_counts_in_both_formats(self):
        baseline = build_summary(
            {
                "reg-a": ("skill-a", "regression", 3),
                "cap-a": ("skill-a", "capability", 2),
            },
            digest_character="a",
        )
        candidate = build_summary(
            {
                "reg-a": ("skill-a", "regression", 3),
                "cap-a": ("skill-a", "capability", 3),
            },
            digest_character="b",
        )

        comparison = eval_report.compare_summaries(baseline, candidate)

        for rendered in (
            eval_report.render_terminal(comparison),
            eval_report.render_markdown(comparison),
        ):
            self.assertIn("cap-a", rendered)
            self.assertIn("2/3 (FAIL)", rendered)
            self.assertIn("3/3 (PASS)", rendered)

    def test_report_includes_all_required_telemetry_and_failures(self):
        specs = {
            "reg-a": ("skill-a", "regression", 3),
            "cap-a": ("skill-a", "capability", 2),
        }
        baseline = build_summary(
            specs,
            digest_character="a",
            duration_ms=1000,
            model_calls=2,
            nudged_tasks=frozenset({"reg-a"}),
            runtime_failures={"reg-a": "BaselineFailure"},
        )
        candidate = build_summary(
            {
                **specs,
                "cap-a": ("skill-a", "capability", 3),
            },
            digest_character="b",
            duration_ms=1200,
            model_calls=4,
            runtime_failures={"cap-a": "CandidateFailure"},
        )

        rendered = eval_report.render_markdown(
            eval_report.compare_summaries(baseline, candidate)
        )

        for expected in (
            "Per-skill pass^3",
            "Cost / task",
            "Duration mean",
            "Latency mean",
            "Model calls mean",
            "Nudged rate",
            "Runtime failure classes",
            "BaselineFailure",
            "CandidateFailure",
        ):
            self.assertIn(expected, rendered)

    def test_regression_rows_are_sorted_by_most_severe_drop(self):
        baseline_specs = {
            "reg-a1": ("skill-a", "regression", 3),
            "reg-a2": ("skill-a", "regression", 3),
            "reg-b1": ("skill-b", "regression", 3),
            "reg-b2": ("skill-b", "regression", 3),
            "cap-a": ("skill-a", "capability", 2),
        }
        candidate_specs = {
            **baseline_specs,
            "reg-a1": ("skill-a", "regression", 2),
            "reg-a2": ("skill-a", "regression", 2),
            "reg-b1": ("skill-b", "regression", 2),
            "cap-a": ("skill-a", "capability", 3),
        }
        comparison = eval_report.compare_summaries(
            build_summary(baseline_specs, digest_character="a"),
            build_summary(candidate_specs, digest_character="b"),
        )

        self.assertEqual(
            [row.skill for row in comparison.skill_deltas[:2]],
            ["skill-a", "skill-b"],
        )


class InputAndCliTests(unittest.TestCase):
    def test_task_identity_changes_are_rejected(self):
        baseline = build_summary(
            {
                "reg-a": ("skill-a", "regression", 3),
                "cap-a": ("skill-a", "capability", 2),
            },
            digest_character="a",
        )
        candidate = build_summary(
            {
                "reg-a": ("renamed-skill", "regression", 3),
                "cap-a": ("skill-a", "capability", 3),
            },
            digest_character="b",
        )

        with self.assertRaisesRegex(
            eval_report.EvalReportError,
            "changed skill",
        ):
            eval_report.compare_summaries(baseline, candidate)

    def test_cli_writes_markdown_and_enforces_promotion(self):
        baseline = build_summary(
            {
                "reg-a": ("skill-a", "regression", 3),
                "cap-a": ("skill-a", "capability", 2),
            },
            digest_character="a",
        )
        candidate = build_summary(
            {
                "reg-a": ("skill-a", "regression", 3),
                "cap-a": ("skill-a", "capability", 3),
            },
            digest_character="b",
        )
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            baseline_path = write_summary(root, baseline)
            candidate_path = write_summary(root, candidate)
            output_path = root / "comparison.md"

            exit_code = eval_report.main(
                [
                    str(baseline_path),
                    str(candidate_path),
                    "--format",
                    "markdown",
                    "--out",
                    str(output_path),
                    "--require-promotion",
                ]
            )

            self.assertEqual(exit_code, 0)
            self.assertIn("**Verdict: PROMOTE**", output_path.read_text())

    def test_cli_requirement_fails_for_rejected_candidate(self):
        specs = {
            "reg-a": ("skill-a", "regression", 3),
            "cap-a": ("skill-a", "capability", 2),
        }
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            baseline_path = write_summary(
                root,
                build_summary(specs, digest_character="a"),
            )
            candidate_path = write_summary(
                root,
                build_summary(specs, digest_character="b"),
            )

            exit_code = eval_report.main(
                [
                    str(baseline_path),
                    str(candidate_path),
                    "--require-promotion",
                    "--out",
                    str(root / "report.txt"),
                ]
            )

            self.assertEqual(exit_code, 1)

    def test_loader_rejects_non_digest_named_summary(self):
        summary = build_summary(
            {
                "reg-a": ("skill-a", "regression", 3),
                "cap-a": ("skill-a", "capability", 2),
            },
            digest_character="a",
        )
        with tempfile.TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "summary.json"
            path.write_text(json.dumps(summary), encoding="utf-8")

            with self.assertRaisesRegex(
                eval_report.EvalReportError,
                "digest-named",
            ):
                eval_report.load_summary(path)


class CommittedReportGuardTests(unittest.TestCase):
    def summaries(
        self,
    ) -> tuple[dict[str, object], dict[str, object]]:
        baseline = build_summary(
            {
                "reg-a": ("skill-a", "regression", 3),
                "cap-a": ("skill-a", "capability", 2),
            },
            digest_character="a",
        )
        candidate = build_summary(
            {
                "reg-a": ("skill-a", "regression", 3),
                "cap-a": ("skill-a", "capability", 3),
            },
            digest_character="b",
        )
        return baseline, candidate

    def test_exact_generated_markdown_is_accepted_and_tampering_is_rejected(
        self,
    ):
        baseline, candidate = self.summaries()
        comparison = eval_report.compare_summaries(baseline, candidate)
        path = Path(".eval-runs") / eval_report.committed_report_name(comparison)
        summary_blobs = {
            summary_index_path(baseline): json.dumps(baseline).encode("utf-8"),
            summary_index_path(candidate): json.dumps(candidate).encode("utf-8"),
        }
        content = eval_report.render_markdown(comparison).encode("utf-8")

        eval_report.validate_committed_report(path, content, summary_blobs)
        with self.assertRaisesRegex(
            eval_report.EvalReportError,
            "does not exactly match",
        ):
            eval_report.validate_committed_report(
                path,
                content + b"\nprivate note",
                summary_blobs,
            )

    def test_repository_guard_accepts_reproducible_markdown_from_index(self):
        baseline, candidate = self.summaries()
        comparison = eval_report.compare_summaries(baseline, candidate)
        with tempfile.TemporaryDirectory() as temporary_directory:
            repo = Path(temporary_directory)
            subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
            artifact_dir = repo / ".eval-runs"
            artifact_dir.mkdir()
            write_summary(artifact_dir, baseline)
            write_summary(artifact_dir, candidate)
            report_path = (
                artifact_dir / eval_report.committed_report_name(comparison)
            )
            report_path.write_text(
                eval_report.render_markdown(comparison),
                encoding="utf-8",
            )
            subprocess.run(
                ["git", "add", ".eval-runs"],
                cwd=repo,
                check=True,
            )

            tracked = summarize.check_repository(repo)

            self.assertEqual(len(tracked), 3)


if __name__ == "__main__":
    unittest.main()
