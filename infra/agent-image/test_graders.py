"""Hermetic tests for the issue #1424 deterministic eval graders.

Run:
    uv run --python 3.12 --no-project -m unittest \
      infra/agent-image/test_graders.py
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path


AGENT_IMAGE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(AGENT_IMAGE_DIR / "eval"))

import graders  # noqa: E402


def grade(
    specs,
    *,
    result="done",
    metadata=None,
    requests=(),
    errors=(),
    catalog="",
):
    validated = graders.validate_grader_specs(specs)
    return graders.grade_trial(
        validated,
        result=result,
        metadata=metadata or {"tool_calls": []},
        artifacts=graders.TrialArtifacts(
            broker_requests=tuple(requests),
            broker_errors=tuple(errors),
            tools_catalog_log=catalog,
        ),
    )


class BrokerRequestGraderTests(unittest.TestCase):
    def test_method_and_all_body_matcher_types(self):
        decision = grade(
            [
                {
                    "type": "broker_request",
                    "route": "/api/agent/workspace-execute",
                    "method": "POST",
                    "body": {
                        "operation": {"exact": "calendar.events.create"},
                        "attendees": {"contains_any": ["staff@example.com"]},
                        "durationMinutes": {"numeric_equals": 30.0},
                        "params": {
                            "json_contains": {
                                "calendarId": "primary",
                                "maxResults": 20,
                            }
                        },
                        "note": {"text_equals": "requested text"},
                        "argv": {
                            "matches_any": [
                                {
                                    "0": "calendar",
                                    "1": "events",
                                    "2": "insert",
                                },
                                {
                                    "0": "calendar",
                                    "1": "+insert",
                                    "2": "--summary",
                                },
                            ]
                        },
                    },
                }
            ],
            requests=[
                {
                    "route": "/api/agent/workspace-execute",
                    "method": "POST",
                    "body": {
                        "operation": "calendar.events.create",
                        "attendees": ["owner@example.com", "staff@example.com"],
                        "durationMinutes": 30,
                        "params": (
                            '{"calendarId":"primary","maxResults":20,'
                            '"singleEvents":true}'
                        ),
                        "note": " requested text\n",
                        "argv": ["calendar", "+insert", "--summary", "Standup"],
                    },
                }
            ],
        )

        self.assertTrue(decision["passed"])
        self.assertIn("matching body", decision["results"][0]["reason"])

    def test_nested_field_mismatch_has_human_readable_reason(self):
        decision = grade(
            [
                {
                    "type": "broker_request",
                    "route": "/api/agent/failures",
                    "body": {
                        "failure.severity": {"exact": "critical"},
                    },
                }
            ],
            requests=[
                {
                    "route": "/api/agent/failures",
                    "method": "POST",
                    "body": {"failure": {"severity": "warning"}},
                }
            ],
        )

        self.assertFalse(decision["passed"])
        self.assertIn("expected exact", decision["results"][0]["reason"])

    def test_json_contains_rejects_missing_fields_and_malformed_json(self):
        spec = {
            "type": "broker_request",
            "route": "/api/agent/workspace-execute",
            "body": {
                "params": {
                    "json_contains": {
                        "q": "is:unread",
                        "maxResults": 20,
                    }
                }
            },
        }
        for params in ('{"q":"is:unread"}', "not-json"):
            with self.subTest(params=params):
                decision = grade(
                    [spec],
                    requests=[
                        {
                            "route": "/api/agent/workspace-execute",
                            "method": "POST",
                            "body": {"params": params},
                        }
                    ],
                )

                self.assertFalse(decision["passed"])
                self.assertIn(
                    "did not contain JSON",
                    decision["results"][0]["reason"],
                )

    def test_matches_any_rejects_when_no_structured_alternative_matches(self):
        decision = grade(
            [
                {
                    "type": "broker_request",
                    "route": "/api/agent/workspace-execute",
                    "body": {
                        "argv": {
                            "matches_any": [
                                {
                                    "0": "calendar",
                                    "1": "events",
                                    "2": "insert",
                                },
                                {
                                    "0": "calendar",
                                    "1": "+insert",
                                    "2": "--summary",
                                },
                            ]
                        }
                    },
                }
            ],
            requests=[
                {
                    "route": "/api/agent/workspace-execute",
                    "method": "POST",
                    "body": {"argv": ["calendar", "events", "list"]},
                }
            ],
        )

        self.assertFalse(decision["passed"])
        self.assertIn("matched none", decision["results"][0]["reason"])

    def test_no_route_called_rejects_a_forbidden_side_effect(self):
        decision = grade(
            [
                {
                    "type": "no_route_called",
                    "route": "/api/agent/email-triage",
                }
            ],
            requests=[
                {
                    "route": "/api/agent/email-triage",
                    "method": "POST",
                    "body": {},
                }
            ],
        )

        self.assertFalse(decision["passed"])
        self.assertIn("forbidden", decision["results"][0]["reason"])

    def test_no_route_called_can_forbid_only_matching_bodies_on_a_shared_route(self):
        spec = {
            "type": "no_route_called",
            "route": "/api/agent/workspace-execute",
            "body": {
                "argv": {
                    "contains_any": [
                        "+send",
                        "gmail.users.drafts.send",
                    ]
                }
            },
        }
        safe_draft = {
            "route": "/api/agent/workspace-execute",
            "method": "POST",
            "body": {
                "scope": "user",
                "argv": ["gmail", "+draft", "--to", "principal@psd401.net"],
            },
        }
        forbidden_send = {
            "route": "/api/agent/workspace-execute",
            "method": "POST",
            "body": {
                "scope": "user",
                "argv": ["gmail", "+send", "--to", "principal@psd401.net"],
            },
        }

        self.assertTrue(grade([spec], requests=[safe_draft])["passed"])
        decision = grade([spec], requests=[safe_draft, forbidden_send])
        self.assertFalse(decision["passed"])
        self.assertIn("matching body", decision["results"][0]["reason"])


class OutputAndTrajectoryGraderTests(unittest.TestCase):
    def test_output_match_supports_case_insensitive_regex(self):
        decision = grade(
            [
                {
                    "type": "output_match",
                    "pattern": r"ticket\s+#\d+",
                    "ignore_case": True,
                }
            ],
            result="Created Ticket #418.",
        )

        self.assertTrue(decision["passed"])

    def test_trajectory_requires_relative_order_but_allows_extra_steps(self):
        decision = grade(
            [
                {
                    "type": "trajectory_in_order",
                    "tools": ["skills.search", "skills.load", "workspace.execute"],
                }
            ],
            metadata={
                "tool_calls": [
                    {"name": "skills.search"},
                    {"name": "read"},
                    {"name": "skills.load"},
                    {"name": "think"},
                    {"name": "workspace.execute"},
                ]
            },
        )

        self.assertTrue(decision["passed"])
        self.assertEqual(
            len(decision["results"]),
            1,
            "extra tools are allowed instead of enforcing an exact sequence",
        )

    def test_trajectory_rejects_expected_tools_in_the_wrong_order(self):
        decision = grade(
            [
                {
                    "type": "trajectory_in_order",
                    "tools": ["skills.search", "skills.load"],
                }
            ],
            metadata={
                "tool_calls": [
                    {"name": "skills.load"},
                    {"name": "skills.search"},
                ]
            },
        )

        self.assertFalse(decision["passed"])

    def test_tools_catalog_requires_every_expected_entry(self):
        decision = grade(
            [
                {
                    "type": "tools_catalog",
                    "expected": ["skills.search", "workspace.execute"],
                }
            ],
            catalog='tools.catalog ok: [{"name":"skills.search"},{"name":"read"}]',
        )

        self.assertFalse(decision["passed"])
        self.assertIn("workspace.execute", decision["results"][0]["reason"])

    def test_tools_catalog_matches_name_fields_not_description_text(self):
        decision = grade(
            [
                {
                    "type": "tools_catalog",
                    "expected": ["workspace.execute"],
                }
            ],
            catalog=(
                'tools.catalog ok: [{"name":"read",'
                '"description":"use workspace.execute when needed"}]'
            ),
        )

        self.assertFalse(decision["passed"])

    def test_tools_catalog_handles_a_truncated_catalog_line(self):
        decision = grade(
            [
                {
                    "type": "tools_catalog",
                    "expected": ["skills.search", "workspace.execute"],
                }
            ],
            catalog=(
                'tools.catalog ok: [{"name":"skills.search"},'
                '{"name":"workspace.execute"},{"name":"truncated'
            ),
        )

        self.assertTrue(decision["passed"])

    def test_tools_catalog_ignores_schema_strings_that_look_like_tools(self):
        decision = grade(
            [
                {
                    "type": "tools_catalog",
                    "expected": ["workspace.execute"],
                }
            ],
            catalog=(
                'tools.catalog ok: [{"name":"read","inputSchema":'
                '{"required":["workspace.execute"],'
                '"properties":{"choice":{'
                '"name":"workspace.execute"}}}}]'
            ),
        )

        self.assertFalse(decision["passed"])


class ReliabilityAggregationTests(unittest.TestCase):
    def test_failed_invocation_cannot_pass_a_negative_route_grader(self):
        decision = grade(
            [
                {
                    "type": "no_route_called",
                    "route": "/api/agent/email-triage",
                }
            ],
            metadata={
                "tool_calls": [],
                "failed": True,
                "error_class": "AgentDeadlineExceeded",
            },
        )

        self.assertFalse(decision["passed"])
        self.assertEqual(decision["results"][0]["grader"], "invocation")
        self.assertIn(
            "AgentDeadlineExceeded",
            decision["results"][0]["reason"],
        )
        self.assertTrue(decision["results"][1]["passed"])

    def test_pass_k_fails_when_only_two_of_three_trials_pass(self):
        records = [
            {
                "task_id": "three-trial-task",
                "trial": trial,
                "trials": 3,
                "grade": {"passed": trial != 2},
            }
            for trial in range(1, 4)
        ]

        summary = graders.aggregate_pass_k(records)

        self.assertEqual(summary[0]["passed_trials"], 2)
        self.assertFalse(summary[0]["pass^k"])

    def test_missing_fixture_is_an_automatic_named_failure(self):
        decision = grade(
            [],
            errors=(
                "EvalFixtureMissing: no fixture for POST /api/agent/aistudio",
            ),
        )

        self.assertFalse(decision["passed"])
        self.assertEqual(decision["results"][0]["grader"], "broker_stub")
        self.assertIn("EvalFixtureMissing", decision["results"][0]["reason"])


class GraderValidationTests(unittest.TestCase):
    def test_broker_graders_reject_routes_outside_the_allowlist(self):
        for grader_type in ("broker_request", "no_route_called"):
            with self.subTest(grader=grader_type):
                with self.assertRaisesRegex(
                    graders.GraderConfigurationError,
                    "not an allowed agent broker route",
                ):
                    graders.validate_grader_specs(
                        [
                            {
                                "type": grader_type,
                                "route": "/api/agent/email-traige",
                            }
                        ]
                    )

    def test_broker_graders_reject_non_post_methods(self):
        for grader_type in ("broker_request", "no_route_called"):
            with self.subTest(grader=grader_type):
                with self.assertRaisesRegex(
                    graders.GraderConfigurationError,
                    "method must be POST",
                ):
                    graders.validate_grader_specs(
                        [
                            {
                                "type": grader_type,
                                "route": "/api/agent/email-triage",
                                "method": "GET",
                            }
                        ]
                    )

    def test_no_route_called_rejects_invalid_body_matchers(self):
        with self.assertRaisesRegex(
            graders.GraderConfigurationError,
            "must have exactly one operator",
        ):
            graders.validate_grader_specs(
                [
                    {
                        "type": "no_route_called",
                        "route": "/api/agent/workspace-execute",
                        "body": {"argv": {"contains_any": ["+send"], "exact": []}},
                    }
                ]
            )

    def test_json_contains_requires_an_object_selector(self):
        with self.assertRaisesRegex(
            graders.GraderConfigurationError,
            "must contain an object",
        ):
            graders.validate_grader_specs(
                [
                    {
                        "type": "broker_request",
                        "route": "/api/agent/workspace-execute",
                        "body": {"argv.5": {"json_contains": "is:unread"}},
                    }
                ]
            )

    def test_matches_any_requires_non_empty_alternatives(self):
        with self.assertRaisesRegex(
            graders.GraderConfigurationError,
            "must contain a non-empty list",
        ):
            graders.validate_grader_specs(
                [
                    {
                        "type": "broker_request",
                        "route": "/api/agent/workspace-execute",
                        "body": {"argv": {"matches_any": []}},
                    }
                ]
            )

    def test_invalid_regex_fails_when_the_suite_loads(self):
        with self.assertRaisesRegex(
            graders.GraderConfigurationError,
            "pattern is invalid",
        ):
            graders.validate_grader_specs(
                [{"type": "output_match", "pattern": "["}]
            )

    def test_unknown_grader_fails_closed(self):
        with self.assertRaisesRegex(
            graders.GraderConfigurationError,
            "unsupported grader",
        ):
            graders.validate_grader_specs(
                [{"type": "model_judge", "prompt": "be generous"}]
            )


if __name__ == "__main__":
    unittest.main()
