"""Hermetic tests for transcript-free agent-eval run summaries.

Run with:
    uv run --python 3.12 --no-project -m unittest \
      infra/agent-image/test_eval_summary.py
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from decimal import Decimal
from io import StringIO
from pathlib import Path

AGENT_IMAGE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(AGENT_IMAGE_DIR / "eval"))

import summarize  # noqa: E402

IMAGE_DIGEST = "sha256:" + ("a" * 64)
IMAGE = f"123456789012.dkr.ecr.us-east-1.amazonaws.com/agent@{IMAGE_DIGEST}"


def pricing() -> dict[str, object]:
    return {
        "primary": "amazon-bedrock/example-model",
        "provider": "amazon-bedrock",
        "model_id": "example-model",
        "pricing_usd_per_million_tokens": {
            "input": Decimal("3"),
            "output": Decimal("15"),
            "cacheRead": Decimal("0.3"),
            "cacheWrite": Decimal("6"),
        },
    }


def trial_record(
    task_id: str,
    skill: str,
    suite: str,
    trial: int,
    *,
    passed: bool = True,
    cache_reads: int = 100,
    failed: bool = False,
    error_class: str | None = None,
    image: str = IMAGE,
) -> dict[str, object]:
    return {
        "task_id": task_id,
        "image": image,
        "skill": skill,
        "suite": suite,
        "level": "L1",
        "workspace": "pure",
        "trial": trial,
        "trials": 3,
        "prompt": "sensitive prompt that must not survive",
        "session_id": f"00000000-0000-4000-8000-{trial:012d}",
        "result": "sensitive result that must not survive",
        "metadata": {
            "input_tokens": 1000,
            "output_tokens": 200,
            "cache_read_input_tokens": cache_reads,
            "cache_write_input_tokens": 50,
            "model_call_count": trial,
            "duration_ms": trial * 1000,
            "latency_ms": trial * 900,
            "nudged": trial == 3,
            "tool_calls": [{"name": "secret", "args": {"value": "private"}}],
            "failed": failed,
            "error_class": error_class,
            "session_id": f"00000000-0000-4000-8000-{trial:012d}",
        },
        "broker_requests": [{"body": {"private": True}}],
        "grade": {
            "passed": passed,
            "reason": "sensitive grader reason",
            "results": [],
        },
        "run_started_at": "2026-07-28T23:59:59+00:00",
        "recorded_at": f"2026-07-29T00:00:0{trial}+00:00",
    }


def complete_records(*, cache_reads: int = 100) -> list[dict[str, object]]:
    records = [
        trial_record(
            "task-a",
            "skill-a",
            "regression",
            trial,
            cache_reads=cache_reads,
        )
        for trial in range(1, 4)
    ]
    records.extend(
        trial_record(
            "task-b",
            "skill-a",
            "capability",
            trial,
            passed=trial != 2,
            cache_reads=cache_reads,
            failed=trial == 2,
            error_class="ModelFailure" if trial == 2 else None,
        )
        for trial in range(1, 4)
    )
    return records


class SummaryAggregationTests(unittest.TestCase):
    def test_aggregates_pass_three_cost_latency_and_failure_telemetry(self):
        records = complete_records()
        records[-2]["grade"]["results"] = [
            {
                "grader": "output_match",
                "passed": False,
                "reason": "sensitive grader reason",
            }
        ]
        summary = summarize.summarize_records(
            records,
            pricing(),
            expected_image=IMAGE,
            source_commit="b" * 40,
            source_commit_provenance="image-label",
            eval_harness_commit="c" * 40,
        )

        self.assertEqual(summary["schema_version"], 2)
        self.assertEqual(summary["summary_kind"], "agent-eval-run")
        self.assertEqual(summary["image_digest"], IMAGE_DIGEST)
        self.assertEqual(summary["source_commit"], "b" * 40)
        self.assertEqual(summary["source_commit_provenance"], "image-label")
        self.assertEqual(summary["eval_harness_commit"], "c" * 40)
        self.assertEqual(summary["run"]["started_at"], "2026-07-28T23:59:59+00:00")
        self.assertEqual(summary["run"]["start_time_status"], "captured")
        self.assertEqual(
            summary["run"]["first_trial_recorded_at"],
            "2026-07-29T00:00:01+00:00",
        )
        self.assertEqual(summary["run"]["task_count"], 2)
        self.assertEqual(summary["run"]["trial_count"], 6)
        self.assertTrue(summary["tasks"]["task-a"]["pass^3"])
        self.assertFalse(summary["tasks"]["task-b"]["pass^3"])
        self.assertEqual(
            summary["overall"]["pass^3"],
            {"passed_tasks": 1, "total_tasks": 2, "rate": 0.5},
        )
        self.assertEqual(summary["skills"]["skill-a"]["task_count"], 2)
        telemetry = summary["overall"]["telemetry"]
        self.assertEqual(telemetry["tokens"]["input_tokens"], 6000)
        self.assertEqual(telemetry["cost"]["total_usd"], 0.03798)
        self.assertEqual(telemetry["duration_ms"]["p50"], 2000)
        self.assertEqual(telemetry["duration_ms"]["p95"], 3000)
        self.assertEqual(telemetry["model_call_count"]["total"], 12)
        self.assertEqual(telemetry["nudged"], {"trials": 2, "rate": 0.333333})
        self.assertEqual(
            telemetry["failures"]["by_error_class"],
            {"ModelFailure": 1},
        )
        self.assertEqual(telemetry["failures"]["graded_trials"], 1)
        self.assertEqual(
            telemetry["failures"]["by_failed_grader"],
            {"output_match": 1},
        )
        self.assertEqual(telemetry["caching_status"], "cached")

    def test_zero_cache_reads_are_derived_as_uncached(self):
        summary = summarize.summarize_records(
            complete_records(cache_reads=0),
            pricing(),
        )

        self.assertEqual(
            summary["overall"]["telemetry"]["caching_status"],
            "uncached",
        )
        self.assertEqual(
            summary["skills"]["skill-a"]["telemetry"]["caching_status"],
            "uncached",
        )

    def test_summary_contains_no_trial_transcript_fields_or_values(self):
        summary = summarize.summarize_records(complete_records(), pricing())
        encoded = json.dumps(summary)

        for forbidden in summarize.FORBIDDEN_SUMMARY_KEYS:
            self.assertNotIn(f'"{forbidden}"', encoded)
        self.assertNotIn("sensitive prompt", encoded)
        self.assertNotIn("sensitive result", encoded)
        self.assertNotIn("sensitive grader reason", encoded)
        self.assertNotIn("private", encoded)

    def test_mixed_images_are_rejected(self):
        records = complete_records()
        records[-1] = {
            **records[-1],
            "image": "123456789012.dkr.ecr.us-east-1.amazonaws.com/agent@sha256:"
            + ("c" * 64),
        }

        with self.assertRaisesRegex(
            summarize.EvalSummaryError,
            "same immutable image",
        ):
            summarize.summarize_records(records, pricing())

    def test_missing_trial_is_rejected_instead_of_inflating_pass_three(self):
        records = [
            record
            for record in complete_records()
            if not (record["task_id"] == "task-a" and record["trial"] == 2)
        ]

        with self.assertRaisesRegex(
            summarize.EvalSummaryError,
            "exactly trials 1, 2, and 3",
        ):
            summarize.summarize_records(records, pricing())

    def test_mutable_image_tag_is_rejected(self):
        records = [
            {**record, "image": "agent:latest"} for record in complete_records()
        ]

        with self.assertRaisesRegex(summarize.EvalSummaryError, "immutable"):
            summarize.summarize_records(records, pricing())

    def test_recorded_time_must_be_timezone_aware_iso_8601(self):
        records = complete_records()
        records[0] = {**records[0], "recorded_at": "yesterday"}

        with self.assertRaisesRegex(summarize.EvalSummaryError, "ISO 8601"):
            summarize.summarize_records(records, pricing())

    def test_legacy_records_report_missing_start_instead_of_guessing(self):
        records = complete_records()
        for record in records:
            record.pop("run_started_at")

        summary = summarize.summarize_records(records, pricing())

        self.assertIsNone(summary["run"]["started_at"])
        self.assertEqual(
            summary["run"]["start_time_status"],
            "unavailable-legacy-records",
        )
        self.assertEqual(
            summary["run"]["first_trial_recorded_at"],
            "2026-07-29T00:00:01+00:00",
        )


class ModelPricingTests(unittest.TestCase):
    def test_primary_model_pricing_is_loaded_from_openclaw_config(self):
        loaded = summarize.load_model_pricing(AGENT_IMAGE_DIR / "openclaw.json")

        self.assertEqual(
            loaded["primary"],
            "amazon-bedrock/us.anthropic.claude-sonnet-5",
        )
        self.assertEqual(
            loaded["pricing_usd_per_million_tokens"]["cacheRead"],
            Decimal("0.3"),
        )

    def test_missing_cost_category_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "openclaw.json"
            path.write_text(
                json.dumps(
                    {
                        "agents": {
                            "defaults": {
                                "model": {"primary": "provider/model"}
                            }
                        },
                        "models": {
                            "providers": {
                                "provider": {
                                    "models": [
                                        {
                                            "id": "model",
                                            "cost": {
                                                "input": 1,
                                                "output": 2,
                                                "cacheRead": 0.1,
                                            },
                                        }
                                    ]
                                }
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(
                summarize.EvalSummaryError,
                "cacheWrite",
            ):
                summarize.load_model_pricing(path)


class CommittedArtifactGuardTests(unittest.TestCase):
    def safe_summary_bytes(self) -> bytes:
        summary = summarize.summarize_records(
            complete_records(),
            pricing(),
            source_commit="b" * 40,
            source_commit_provenance="image-label",
            eval_harness_commit="c" * 40,
        )
        return json.dumps(summary).encode("utf-8")

    def test_digest_named_summary_is_accepted(self):
        summarize.validate_committed_summary(
            Path(".eval-runs") / f"{IMAGE_DIGEST.replace(':', '-')}.json",
            self.safe_summary_bytes(),
        )

    def test_jsonl_transcript_is_rejected_even_if_forced_into_git(self):
        with self.assertRaisesRegex(summarize.EvalSummaryError, "transcript"):
            summarize.validate_committed_summary(
                Path(".eval-runs") / "forced.jsonl",
                b'{"prompt":"private"}\n',
            )

    def test_markdown_and_nested_artifacts_are_rejected(self):
        with self.assertRaisesRegex(summarize.EvalSummaryError, "digest-named"):
            summarize.validate_committed_summary(
                Path(".eval-runs") / "notes.md",
                b"private trial output",
            )
        with self.assertRaisesRegex(summarize.EvalSummaryError, "directly inside"):
            summarize.validate_committed_summary(
                Path(".eval-runs")
                / "nested"
                / f"{IMAGE_DIGEST.replace(':', '-')}.json",
                self.safe_summary_bytes(),
            )

    def test_summary_with_a_forbidden_nested_field_is_rejected(self):
        value = json.loads(self.safe_summary_bytes())
        value["skills"]["skill-a"]["metadata"] = {"messages": ["private"]}

        with self.assertRaisesRegex(
            summarize.EvalSummaryError,
            "forbidden transcript field",
        ):
            summarize.validate_committed_summary(
                Path(".eval-runs") / f"{IMAGE_DIGEST.replace(':', '-')}.json",
                json.dumps(value).encode("utf-8"),
            )

    def assert_rejected(self, value: dict, pattern: str) -> None:
        with self.assertRaisesRegex(summarize.EvalSummaryError, pattern):
            summarize.validate_committed_summary(
                Path(".eval-runs") / f"{IMAGE_DIGEST.replace(':', '-')}.json",
                json.dumps(value).encode("utf-8"),
            )

    def test_transcript_under_an_unlisted_key_is_rejected(self):
        for container, key in (
            (("skills", "skill-a"), "notes"),
            (("skills", "skill-a"), "grader_reason"),
            (("tasks", "task-a"), "output"),
            ((), "completion"),
        ):
            with self.subTest(key=key):
                value = json.loads(self.safe_summary_bytes())
                target = value
                for step in container:
                    target = target[step]
                target[key] = "the model said something private"

                self.assert_rejected(value, f"unexpected field.*{key}")

    def test_differently_cased_transcript_key_is_rejected(self):
        value = json.loads(self.safe_summary_bytes())
        value["Prompt"] = "private"

        self.assert_rejected(value, "unexpected field")

    def test_secret_smuggled_beside_the_model_pricing_is_rejected(self):
        value = json.loads(self.safe_summary_bytes())
        value["model"]["api_key"] = "sk-not-a-real-key"

        self.assert_rejected(value, "unexpected field")

    def test_summary_missing_a_required_field_is_rejected(self):
        value = json.loads(self.safe_summary_bytes())
        del value["run"]["first_trial_recorded_at"]

        self.assert_rejected(value, "missing fields")

    def test_summary_field_of_the_wrong_type_is_rejected(self):
        value = json.loads(self.safe_summary_bytes())
        value["overall"]["telemetry"]["caching_status"] = {"prompt": "private"}

        self.assert_rejected(value, r"overall\.telemetry\.caching_status")

    def test_transcript_smuggled_as_a_free_form_key_is_rejected(self):
        value = json.loads(self.safe_summary_bytes())
        failures = value["overall"]["telemetry"]["failures"]
        failures["by_error_class"] = {"x" * 400: 1}

        self.assert_rejected(value, "not a safe identifier")

    def test_run_bounds_distinguish_start_from_trial_record_times(self):
        value = json.loads(self.safe_summary_bytes())

        self.assertIn("started_at", value["run"])
        self.assertIn("first_trial_recorded_at", value["run"])
        self.assertIn("completed_at", value["run"])
        self.assertLessEqual(
            value["run"]["started_at"],
            value["run"]["first_trial_recorded_at"],
        )

    def test_filename_must_match_the_summarized_image_digest(self):
        with self.assertRaisesRegex(summarize.EvalSummaryError, "filename"):
            summarize.validate_committed_summary(
                Path(".eval-runs") / f"sha256-{'c' * 64}.json",
                self.safe_summary_bytes(),
            )

    def test_image_with_sensitive_prefix_before_digest_is_rejected(self):
        value = json.loads(self.safe_summary_bytes())
        value["image"] = f"private prompt\n@{IMAGE_DIGEST}"

        self.assert_rejected(value, "complete immutable ECR sha256 URI")

    def test_task_pass_three_must_match_passed_trial_count(self):
        value = json.loads(self.safe_summary_bytes())
        value["tasks"]["task-a"]["pass^3"] = False

        self.assert_rejected(value, r"task-a\.pass\^3 is inconsistent")

    def test_scope_pass_three_must_match_its_tasks(self):
        value = json.loads(self.safe_summary_bytes())
        value["overall"]["pass^3"]["passed_tasks"] = 2
        value["overall"]["pass^3"]["rate"] = 1.0

        self.assert_rejected(
            value,
            r"overall\.pass\^3\.passed_tasks is inconsistent",
        )

    def test_scope_telemetry_must_match_counts_rates_and_pricing(self):
        mutations = (
            (
                ("overall", "telemetry", "failures", "trials"),
                7,
                r"failures\.trials exceeds trial_count",
            ),
            (
                ("overall", "telemetry", "failures", "rate"),
                0.5,
                r"failures\.rate is inconsistent",
            ),
            (
                ("overall", "telemetry", "failures", "by_error_class"),
                {"ModelFailure": 2},
                r"by_error_class is inconsistent",
            ),
            (
                ("overall", "telemetry", "tokens", "input_tokens"),
                6001,
                r"cost\.total_usd is inconsistent",
            ),
            (
                ("overall", "telemetry", "cost", "total_usd"),
                0,
                r"cost\.total_usd is inconsistent",
            ),
            (
                ("overall", "telemetry", "duration_ms", "mean"),
                1,
                r"duration_ms\.mean is inconsistent",
            ),
            (
                ("overall", "telemetry", "nudged", "trials"),
                7,
                r"nudged\.trials exceeds trial_count",
            ),
            (
                ("overall", "telemetry", "caching_status"),
                "uncached",
                r"caching_status is inconsistent",
            ),
        )

        for path, replacement, pattern in mutations:
            with self.subTest(path=".".join(path)):
                value = json.loads(self.safe_summary_bytes())
                target = value
                for field in path[:-1]:
                    target = target[field]
                target[path[-1]] = replacement

                self.assert_rejected(value, pattern)

    def test_scope_telemetry_partitions_must_reconcile_with_overall(self):
        def mutate_suite_tokens(value):
            telemetry = value["suites"]["regression"]["telemetry"]
            telemetry["tokens"]["output_tokens"] = 1600
            telemetry["cost"] = {
                "total_usd": 0.03399,
                "per_trial_usd": 0.01133,
                "per_task_usd": 0.03399,
            }

        def mutate_suite_duration(value):
            duration = value["suites"]["regression"]["telemetry"]["duration_ms"]
            duration["total"] = 6003
            duration["mean"] = 2001

        def mutate_suite_model_calls(value):
            calls = value["suites"]["regression"]["telemetry"][
                "model_call_count"
            ]
            calls["total"] = 9
            calls["mean"] = 3

        def mutate_suite_nudges(value):
            nudged = value["suites"]["regression"]["telemetry"]["nudged"]
            nudged["trials"] = 2
            nudged["rate"] = 0.666667

        def mutate_suite_failures(value):
            failures = value["suites"]["regression"]["telemetry"]["failures"]
            failures["trials"] = 1
            failures["rate"] = 0.333333
            failures["by_error_class"] = {"SyntheticFailure": 1}

        def mutate_suite_failed_graders(value):
            failures = value["suites"]["capability"]["telemetry"]["failures"]
            failures["by_failed_grader"] = {"unknown": 2}

        def mutate_skill_duration(value):
            duration = value["skills"]["skill-a"]["telemetry"]["duration_ms"]
            duration["total"] = 12006
            duration["mean"] = 2001

        mutations = (
            (
                "suite tokens",
                mutate_suite_tokens,
                r"tokens\.output_tokens.*suites partitions",
            ),
            (
                "suite duration",
                mutate_suite_duration,
                r"duration_ms\.total.*suites partitions",
            ),
            (
                "suite model calls",
                mutate_suite_model_calls,
                r"model_call_count\.total.*suites partitions",
            ),
            (
                "suite nudges",
                mutate_suite_nudges,
                r"nudged\.trials.*suites partitions",
            ),
            (
                "suite failures",
                mutate_suite_failures,
                r"failures\.trials.*suites partitions",
            ),
            (
                "suite failed graders",
                mutate_suite_failed_graders,
                r"by_failed_grader.*suites partitions",
            ),
            (
                "skill duration",
                mutate_skill_duration,
                r"duration_ms\.total.*skills partitions",
            ),
        )

        for name, mutate, pattern in mutations:
            with self.subTest(name=name):
                value = json.loads(self.safe_summary_bytes())
                mutate(value)

                self.assert_rejected(value, pattern)

    def test_skill_membership_must_match_task_summaries(self):
        value = json.loads(self.safe_summary_bytes())
        value["skills"]["skill-a"]["task_ids"] = ["task-a"]

        self.assert_rejected(value, r"task_ids is inconsistent")

    def test_repository_check_reads_the_git_index_not_only_gitignore(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            subprocess.run(
                ["git", "init", "-q"],
                cwd=repo,
                check=True,
            )
            artifact_dir = repo / ".eval-runs"
            artifact_dir.mkdir()
            transcript = artifact_dir / "forced.jsonl"
            transcript.write_text('{"prompt":"private"}\n', encoding="utf-8")
            subprocess.run(
                ["git", "add", "-f", ".eval-runs/forced.jsonl"],
                cwd=repo,
                check=True,
            )

            with self.assertRaisesRegex(summarize.EvalSummaryError, "transcript"):
                summarize.check_repository(repo)

    def test_repository_check_validates_index_blob_not_working_tree_copy(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            subprocess.run(
                ["git", "init", "-q"],
                cwd=repo,
                check=True,
            )
            artifact_dir = repo / ".eval-runs"
            artifact_dir.mkdir()
            artifact = artifact_dir / f"{IMAGE_DIGEST.replace(':', '-')}.json"
            safe_content = self.safe_summary_bytes()
            unsafe_value = json.loads(safe_content)
            unsafe_value["prompt"] = "private staged prompt"
            artifact.write_text(json.dumps(unsafe_value), encoding="utf-8")
            subprocess.run(
                ["git", "add", "-f", artifact.relative_to(repo)],
                cwd=repo,
                check=True,
            )
            artifact.write_bytes(safe_content)

            with self.assertRaisesRegex(
                summarize.EvalSummaryError,
                "forbidden transcript field",
            ):
                summarize.check_repository(repo)


class EvalAutomationContractTests(unittest.TestCase):
    def test_ci_creates_model_uid_before_agent_image_python_suites(self):
        workflow = (
            AGENT_IMAGE_DIR.parent.parent / ".github" / "workflows" / "ci.yml"
        ).read_text(encoding="utf-8")

        account_setup = workflow.index(
            "- name: Ensure model UID test account exists"
        )
        python_suites = workflow.index(
            "- name: Run all agent-image Python tests (unittest)"
        )
        root_isolation = workflow.index(
            "- name: Run model-UID isolation test as root"
        )

        self.assertLess(account_setup, python_suites)
        self.assertLess(python_suites, root_isolation)
        self.assertEqual(workflow.count("sudo useradd --system"), 1)

    def test_image_build_stamps_clean_aistudio_source_revision(self):
        dockerfile = (AGENT_IMAGE_DIR / "Dockerfile").read_text(encoding="utf-8")
        build_script = (AGENT_IMAGE_DIR / "build-and-push.sh").read_text(
            encoding="utf-8"
        )

        self.assertIn("ARG AISTUDIO_SOURCE_COMMIT", dockerfile)
        self.assertIn(
            'org.opencontainers.image.source="https://github.com/psd401/aistudio"',
            dockerfile,
        )
        self.assertIn(
            'org.opencontainers.image.revision="${AISTUDIO_SOURCE_COMMIT}"',
            dockerfile,
        )
        self.assertIn("status --porcelain --untracked-files=all", build_script)
        self.assertIn(
            '--build-arg "AISTUDIO_SOURCE_COMMIT=${SOURCE_COMMIT}"',
            build_script,
        )

    def test_nightly_binds_image_and_harness_commits_separately(self):
        workflow = (
            AGENT_IMAGE_DIR.parent.parent
            / ".github"
            / "workflows"
            / "agent-eval-nightly.yml"
        ).read_text(encoding="utf-8")

        self.assertIn("org.opencontainers.image.revision", workflow)
        self.assertIn(
            "--source-commit \"${{ steps.candidate.outputs.source_commit }}\"",
            workflow,
        )
        self.assertIn('--eval-harness-commit "${GITHUB_SHA}"', workflow)
        self.assertNotIn('--source-commit "${GITHUB_SHA}"', workflow)


class SummaryCliTests(unittest.TestCase):
    def test_cli_writes_safe_summary_and_can_enforce_pass_three(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            records_path = root / "run.jsonl"
            records_path.write_text(
                "".join(json.dumps(record) + "\n" for record in complete_records()),
                encoding="utf-8",
            )
            output = root / "summary.json"

            with redirect_stdout(StringIO()):
                result = summarize.main(
                    [
                        "--records",
                        str(records_path),
                        "--out",
                        str(output),
                        "--image",
                        IMAGE,
                        "--source-commit",
                        "b" * 40,
                        "--source-commit-provenance",
                        "image-label",
                        "--eval-harness-commit",
                        "c" * 40,
                        "--model-config",
                        str(AGENT_IMAGE_DIR / "openclaw.json"),
                        "--require-all-pass",
                    ]
                )

            self.assertEqual(result, 1)
            self.assertTrue(output.is_file())
            value = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(value["overall"]["pass^3"]["passed_tasks"], 1)


if __name__ == "__main__":
    unittest.main()
