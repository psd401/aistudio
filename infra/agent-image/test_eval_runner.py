"""Hermetic tests for the issue #1422 local Docker evaluation runner.

Run:
    uv run --python 3.12 --no-project -m unittest \
      infra/agent-image/test_eval_runner.py
"""

from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

AGENT_IMAGE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(AGENT_IMAGE_DIR / "eval"))

import probe  # noqa: E402
import runner  # noqa: E402


def metadata(session_id: str, **extra: object) -> dict[str, object]:
    value: dict[str, object] = {
        "session_id": session_id,
        "input_tokens": 10,
        "output_tokens": 2,
        "cache_read_input_tokens": 3,
        "cache_write_input_tokens": 4,
        "model_call_count": 1,
        "duration_ms": 120,
        "latency_ms": 100,
        "nudged": False,
        "tool_calls": [],
        "failed": False,
        "error_class": None,
    }
    value.update(extra)
    return value


class ProbeTests(unittest.TestCase):
    def test_last_result_event_ignores_prompt_echo_and_uses_last_result(self):
        stream = "\n".join(
            [
                'data: {"type":"start"}',
                'data: {"result":"first","metadata":{"messages":["Reply with exactly: OK"]}}',
                'data: {"type":"heartbeat","elapsed_s":30}',
                'data: {"result":"NOT OK","metadata":{"messages":["Reply with exactly: OK"]}}',
            ]
        )
        event = probe.extract_last_result_event(stream)
        self.assertEqual(event["result"], "NOT OK")

    def test_no_result_event_is_a_protocol_error(self):
        with self.assertRaises(probe.ProbeProtocolError):
            probe.extract_last_result_event('data: {"type":"start"}\n')

    def test_build_gate_last_result_cli_preserves_empty_answer_behavior(self):
        output = io.StringIO()
        with mock.patch.object(
            sys,
            "stdin",
            io.StringIO('data: {"type":"start"}\n'),
        ), redirect_stdout(output):
            status = probe.main(["last-result"])
        self.assertEqual(status, 0)
        self.assertEqual(output.getvalue(), "\n")

    def test_payload_round_trips_without_shell_escaping(self):
        serialized = probe.build_invocation_payload(
            "quotes ' and \" plus\nnewline",
            "canary@build-gate.invalid",
            "v1.context.signature",
            "proof",
        )
        self.assertEqual(
            json.loads(serialized)["prompt"],
            "quotes ' and \" plus\nnewline",
        )

    def test_payload_cli_accepts_a_leading_dash_proof_key(self):
        output = io.StringIO()
        with redirect_stdout(output):
            status = probe.main(
                [
                    "make-payload",
                    "--",
                    "prompt",
                    "owner@example.com",
                    "v1.context.signature",
                    "-leading-dash",
                ]
            )

        self.assertEqual(status, 0)
        self.assertEqual(
            json.loads(output.getvalue())["invocation_request_proof_key"],
            "-leading-dash",
        )

    def test_owner_email_falls_back_for_non_object_context_claims(self):
        self.assertEqual(
            probe.decode_owner_email("v1.W10.sig"),
            probe.DEFAULT_OWNER_EMAIL,
        )


class SuiteLoadingTests(unittest.TestCase):
    def test_committed_core_suite_has_three_l0_tasks(self):
        tasks = runner.load_suite(
            AGENT_IMAGE_DIR / "eval" / "suites" / "core.yaml"
        )
        self.assertEqual(len(tasks), 3)
        self.assertEqual({task.level for task in tasks}, {"L0"})
        self.assertEqual({task.workspace for task in tasks}, {"pure"})
        self.assertEqual({task.trials for task in tasks}, {3})

    def test_invalid_workspace_fails_closed(self):
        with self.subTest("validation happens after parsing"):
            with self.assertRaises(runner.EvalRunnerError):
                runner._task_from_mapping(
                    {
                        "id": "bad-workspace",
                        "skill": "runner-core",
                        "level": "L0",
                        "workspace": "sometimes",
                        "prompt": "hello",
                    },
                    Path("inline.yaml"),
                )

    def test_non_integer_trial_counts_are_rejected(self):
        base_task: dict[str, object] = {
            "id": "invalid-trials",
            "skill": "runner-core",
            "level": "L0",
            "workspace": "pure",
            "prompt": "hello",
        }
        for invalid_trials in (True, "3", 3.9):
            with self.subTest(trials=invalid_trials), self.assertRaisesRegex(
                runner.EvalRunnerError,
                "trials must be an integer",
            ):
                runner._task_from_mapping(
                    {**base_task, "trials": invalid_trials},
                    Path("inline.yaml"),
                )

    def test_context_ttl_outlives_the_invocation_timeout(self):
        self.assertEqual(runner._context_ttl_seconds(900), 965)
        with self.assertRaisesRegex(runner.EvalRunnerError, "7135"):
            runner._context_ttl_seconds(7136)

    def test_poll_interval_must_be_finite(self):
        for invalid_interval in ("nan", "inf", "-inf"):
            with self.subTest(interval=invalid_interval), self.assertRaises(
                runner.argparse.ArgumentTypeError
            ):
                runner._positive_float(invalid_interval)

    def test_blank_yaml_prompt_is_rejected_instead_of_coerced(self):
        with tempfile.TemporaryDirectory() as directory:
            task_path = Path(directory) / "blank-prompt.yaml"
            task_path.write_text(
                "\n".join(
                    [
                        "id: blank-prompt",
                        "skill: runner-core",
                        "level: L0",
                        "workspace: pure",
                        "prompt:",
                    ]
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                runner.EvalRunnerError,
                "prompt must be a string",
            ):
                runner.load_suite(task_path)

    def test_yaml_single_quote_escaping_preserves_the_prompt(self):
        with tempfile.TemporaryDirectory() as directory:
            task_path = Path(directory) / "quoted-prompt.yaml"
            task_path.write_text(
                "\n".join(
                    [
                        "id: quoted-prompt",
                        "skill: runner-core",
                        "level: L0",
                        "workspace: pure",
                        "prompt: 'Don''t use tools'",
                    ]
                ),
                encoding="utf-8",
            )

            [task] = runner.load_suite(task_path)

        self.assertEqual(task.prompt, "Don't use tools")

    def test_l1_task_loads_fixture_paths_and_inline_graders(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture = root / "directory.json"
            fixture.write_text(
                json.dumps(
                    [
                        {
                            "route": "/api/agent/directory-lookup",
                            "response": {"body": {"people": []}},
                        }
                    ]
                ),
                encoding="utf-8",
            )
            task_path = root / "task.yaml"
            task_path.write_text(
                "\n".join(
                    [
                        "id: directory-lookup",
                        "skill: psd-directory",
                        "level: L1",
                        "workspace: pure",
                        'prompt: "Find Ada."',
                        "fixtures:",
                        "  - directory.json",
                        "graders:",
                        (
                            '  - {"type":"broker_request",'
                            '"route":"/api/agent/directory-lookup"}'
                        ),
                    ]
                ),
                encoding="utf-8",
            )

            [task] = runner.load_suite(task_path)

            self.assertEqual(task.fixture_paths, (fixture.resolve(),))
            self.assertEqual(task.graders[0]["type"], "broker_request")

    def test_l1_task_without_a_grader_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            task_path = Path(directory) / "task.yaml"
            task_path.write_text(
                "\n".join(
                    [
                        "id: ungraded",
                        "skill: psd-directory",
                        "level: L1",
                        "workspace: pure",
                        'prompt: "Find Ada."',
                    ]
                ),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(
                runner.EvalRunnerError,
                "L1 tasks must configure",
            ):
                runner.load_suite(task_path)

    def test_live_tasks_reject_broker_capture_graders(self):
        for level in ("L0", "L2"):
            for grader_type in ("broker_request", "no_route_called"):
                with self.subTest(level=level, grader=grader_type):
                    with self.assertRaisesRegex(
                        runner.EvalRunnerError,
                        "broker graders require level L1",
                    ):
                        runner._task_from_mapping(
                            {
                                "id": "invalid-live-grader",
                                "skill": "runner-core",
                                "level": level,
                                "workspace": "pure",
                                "prompt": "hello",
                                "graders": [
                                    {
                                        "type": grader_type,
                                        "route": (
                                            "/api/agent/directory-lookup"
                                        ),
                                    }
                                ],
                            },
                            Path("inline.yaml"),
                        )

    def test_live_tasks_reject_ignored_fixture_files(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture_path = Path(directory) / "fixture.json"
            fixture_path.write_text("[]", encoding="utf-8")

            with self.assertRaisesRegex(
                runner.EvalRunnerError,
                "fixtures require level L1",
            ):
                runner._task_from_mapping(
                    {
                        "id": "invalid-live-fixture",
                        "skill": "runner-core",
                        "level": "L0",
                        "workspace": "pure",
                        "prompt": "hello",
                        "fixtures": [fixture_path.name],
                    },
                    Path(directory) / "task.yaml",
                )

    def test_fixture_loading_rejects_non_post_methods_and_scalar_selectors(self):
        invalid_fixtures = (
            {
                "route": "/api/agent/directory-lookup",
                "method": "GET",
                "response": {"body": {}},
            },
            {
                "route": "/api/agent/directory-lookup",
                "request_body": "Ada",
                "response": {"body": {}},
            },
        )
        for index, fixture in enumerate(invalid_fixtures):
            with self.subTest(fixture=fixture):
                with tempfile.TemporaryDirectory() as directory:
                    path = Path(directory) / f"invalid-{index}.json"
                    path.write_text(
                        json.dumps([fixture]),
                        encoding="utf-8",
                    )

                    with self.assertRaises(runner.EvalRunnerError):
                        runner._load_fixture_files((path,))

    def test_python_adjacent_string_syntax_is_not_accepted_as_yaml(self):
        with tempfile.TemporaryDirectory() as directory:
            task_path = Path(directory) / "adjacent-strings.yaml"
            task_path.write_text(
                "\n".join(
                    [
                        "id: adjacent-strings",
                        "skill: runner-core",
                        "level: L0",
                        "workspace: pure",
                        "prompt: 'Don' 't use tools'",
                    ]
                ),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(
                runner.EvalRunnerError,
                "invalid single-quoted YAML value",
            ):
                runner.load_suite(task_path)


class AdvancingClock:
    def __init__(self) -> None:
        self.value = datetime(2026, 7, 28, tzinfo=timezone.utc)

    def now(self) -> datetime:
        return self.value

    def advance(self, seconds: int) -> None:
        self.value += timedelta(seconds=seconds)


class FakeMinter:
    def __init__(self, clock: AdvancingClock, advance_seconds: int = 0) -> None:
        self.clock = clock
        self.advance_seconds = advance_seconds
        self.sessions: list[str] = []

    def mint(self, session_id: str) -> runner.InvocationAuthority:
        self.sessions.append(session_id)
        authority = runner.InvocationAuthority(
            invocation_context=f"context-{session_id}",
            request_proof_key=f"proof-{session_id}",
            owner_email="canary@build-gate.invalid",
            session_id=session_id,
            expires_at=self.clock.now() + timedelta(seconds=900),
        )
        self.clock.advance(self.advance_seconds)
        return authority


class FakeRuntime:
    def __init__(self, clock: AdvancingClock) -> None:
        self.clock = clock
        self.started = False
        self.stopped = False
        self.invocations: list[tuple[str, str]] = []
        self.memory: dict[str, str] = {}
        self.trial_active = False

    def prepare(self) -> bool:
        restarted = not self.started
        self.started = True
        return restarted

    def invoke(
        self,
        task: runner.Task,
        session_id: str,
        authority: runner.InvocationAuthority,
    ) -> dict[str, object]:
        if not self.started or self.stopped:
            raise AssertionError("runtime lifecycle violated")
        if authority.session_id != session_id:
            raise AssertionError("context/session binding violated")
        if authority.expires_at <= self.clock.now():
            return {
                "result": "invalid",
                "metadata": metadata(
                    session_id,
                    failed=True,
                    error_class="InvocationContextInvalid",
                ),
            }
        self.invocations.append((task.id, session_id))
        if task.id == "session-isolation-seed":
            self.memory[session_id] = "cobalt-orchid"
            result = "STORED"
        elif task.id == "session-isolation-recall":
            result = self.memory.get(session_id, "UNKNOWN")
        else:
            result = "323"
        return {
            "result": result,
            "metadata": metadata(session_id, future_field={"preserved": True}),
        }

    def begin_trial(self, task, trial_number, session_id) -> None:
        self.trial_active = True

    def end_trial(self) -> runner.TrialArtifacts:
        if not self.trial_active:
            raise AssertionError("trial lifecycle violated")
        self.trial_active = False
        return runner.TrialArtifacts()

    def stop(self) -> None:
        self.stopped = True


class FakeRuntimeFactory:
    def __init__(self, clock: AdvancingClock) -> None:
        self.clock = clock
        self.runtimes: list[FakeRuntime] = []

    def create(self, task: runner.Task) -> FakeRuntime:
        runtime = FakeRuntime(self.clock)
        self.runtimes.append(runtime)
        return runtime


class EvaluationRunnerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tasks = runner.load_suite(
            AGENT_IMAGE_DIR / "eval" / "suites" / "core.yaml"
        )

    def test_three_tasks_times_three_trials_emit_nine_well_formed_records(self):
        clock = AdvancingClock()
        factory = FakeRuntimeFactory(clock)
        minter = FakeMinter(clock)
        output = io.StringIO()
        records = runner.EvaluationRunner(
            factory,
            minter,
            now=clock.now,
        ).run(self.tasks, output)

        self.assertEqual(len(records), 9)
        self.assertEqual(len(output.getvalue().splitlines()), 9)
        self.assertEqual(len(set(minter.sessions)), 9)
        self.assertTrue(all(33 <= len(session) <= 256 for session in minter.sessions))
        self.assertEqual(len(factory.runtimes), 1, "pure trials share one container")
        self.assertTrue(factory.runtimes[0].stopped)
        self.assertTrue(
            all(
                runner.REQUIRED_METADATA_FIELDS.issubset(record["metadata"])
                for record in records
            )
        )
        self.assertTrue(
            all(record["metadata"]["future_field"] == {"preserved": True} for record in records)
        )
        self.assertEqual({record["image"] for record in records}, {"unknown"})

    def test_fresh_sessions_prevent_conversation_recall(self):
        clock = AdvancingClock()
        factory = FakeRuntimeFactory(clock)
        records = runner.EvaluationRunner(
            factory,
            FakeMinter(clock),
            now=clock.now,
        ).run(self.tasks[:2], io.StringIO(), trials_override=1)

        self.assertEqual(records[0]["result"], "STORED")
        self.assertEqual(records[1]["result"], "UNKNOWN")
        self.assertNotEqual(records[0]["session_id"], records[1]["session_id"])

    def test_multi_hour_run_remints_before_every_trial(self):
        clock = AdvancingClock()
        factory = FakeRuntimeFactory(clock)
        minter = FakeMinter(clock, advance_seconds=301)
        records = runner.EvaluationRunner(
            factory,
            minter,
            now=clock.now,
        ).run(self.tasks, io.StringIO())

        self.assertEqual(len(records), 9)
        self.assertEqual(len(minter.sessions), 9)
        self.assertGreater(
            (clock.now() - datetime(2026, 7, 28, tzinfo=timezone.utc)).total_seconds(),
            15 * 60,
        )
        self.assertNotIn(
            "InvocationContextInvalid",
            [record["metadata"]["error_class"] for record in records],
        )

    def test_credentials_are_rechecked_after_context_minting(self):
        clock = AdvancingClock()
        events: list[str] = []

        class OrderedRuntime(FakeRuntime):
            def prepare(self):
                events.append("prepare")
                return super().prepare()

            def invoke(self, task, session_id, authority):
                events.append("invoke")
                return super().invoke(task, session_id, authority)

        class OrderedFactory:
            def create(self, task):
                return OrderedRuntime(clock)

        class OrderedMinter(FakeMinter):
            def mint(self, session_id):
                events.append("mint")
                return super().mint(session_id)

        runner.EvaluationRunner(
            OrderedFactory(),
            OrderedMinter(clock),
            now=clock.now,
        ).run(self.tasks[:1], io.StringIO(), trials_override=1)

        self.assertEqual(events, ["prepare", "mint", "prepare", "invoke"])

    def test_authority_is_reminted_when_post_mint_prepare_restarts_runtime(self):
        clock = AdvancingClock()
        events: list[str] = []

        class RestartingRuntime(FakeRuntime):
            def __init__(self):
                super().__init__(clock)
                self.prepare_results = iter([True, True, False])

            def prepare(self):
                events.append("prepare")
                self.started = True
                return next(self.prepare_results)

            def invoke(self, task, session_id, authority):
                events.append("invoke")
                return super().invoke(task, session_id, authority)

        class RestartingFactory:
            def create(self, task):
                return RestartingRuntime()

        class RecordingMinter(FakeMinter):
            def mint(self, session_id):
                events.append("mint")
                return super().mint(session_id)

        minter = RecordingMinter(clock)
        runner.EvaluationRunner(
            RestartingFactory(),
            minter,
            now=clock.now,
        ).run(self.tasks[:1], io.StringIO(), trials_override=1)

        self.assertEqual(
            events,
            ["prepare", "mint", "prepare", "mint", "prepare", "invoke"],
        )
        self.assertEqual(len(minter.sessions), 2)
        self.assertEqual(len(set(minter.sessions)), 1)

    def test_mutating_task_gets_a_fresh_container_per_trial(self):
        task = runner.Task(
            id="mutating-task",
            skill="runner-core",
            level="L0",
            workspace="mutating",
            prompt="write a local file",
            trials=3,
        )
        clock = AdvancingClock()
        factory = FakeRuntimeFactory(clock)
        records = runner.EvaluationRunner(
            factory,
            FakeMinter(clock),
            now=clock.now,
        ).run([task], io.StringIO())

        self.assertEqual(len(records), 3)
        self.assertEqual(len(factory.runtimes), 3)
        self.assertTrue(all(runtime.stopped for runtime in factory.runtimes))
        self.assertEqual(
            [len(runtime.invocations) for runtime in factory.runtimes],
            [1, 1, 1],
        )

    def test_missing_metadata_field_is_never_silently_dropped(self):
        clock = AdvancingClock()

        class IncompleteRuntime(FakeRuntime):
            def invoke(self, task, session_id, authority):
                incomplete = metadata(session_id)
                del incomplete["latency_ms"]
                return {"result": "answer", "metadata": incomplete}

        class IncompleteFactory:
            def create(self, task):
                return IncompleteRuntime(clock)

        with self.assertRaisesRegex(runner.EvalRunnerError, "latency_ms"):
            runner.EvaluationRunner(
                IncompleteFactory(),
                FakeMinter(clock),
                now=clock.now,
            ).run(self.tasks[:1], io.StringIO(), trials_override=1)

    def test_missing_metadata_session_is_never_synthesized(self):
        clock = AdvancingClock()

        class MissingSessionRuntime(FakeRuntime):
            def invoke(self, task, session_id, authority):
                incomplete = metadata(session_id)
                del incomplete["session_id"]
                return {"result": "answer", "metadata": incomplete}

        class MissingSessionFactory:
            def create(self, task):
                return MissingSessionRuntime(clock)

        with self.assertRaisesRegex(runner.EvalRunnerError, "session_id"):
            runner.EvaluationRunner(
                MissingSessionFactory(),
                FakeMinter(clock),
                now=clock.now,
            ).run(self.tasks[:1], io.StringIO(), trials_override=1)

    def test_workspace_authority_change_is_a_runner_failure(self):
        clock = AdvancingClock()

        class RejectedRuntime(FakeRuntime):
            def invoke(self, task, session_id, authority):
                return {
                    "result": "rejected",
                    "metadata": metadata(
                        session_id,
                        failed=True,
                        error_class="WorkspaceAuthorityChanged",
                    ),
                }

        class RejectedFactory:
            def create(self, task):
                return RejectedRuntime(clock)

        with self.assertRaisesRegex(
            runner.EvalRunnerError,
            "WorkspaceAuthorityChanged",
        ):
            runner.EvaluationRunner(
                RejectedFactory(),
                FakeMinter(clock),
                now=clock.now,
            ).run(self.tasks[:1], io.StringIO(), trials_override=1)

    def test_output_file_is_owner_only(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "run.jsonl"
            with runner._open_output(path, overwrite=False) as output:
                output.write("{}\n")
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)

    def test_trial_artifacts_are_graded_and_preserved_in_the_record(self):
        clock = AdvancingClock()

        class CapturingRuntime(FakeRuntime):
            def end_trial(self):
                super().end_trial()
                return runner.TrialArtifacts(
                    broker_requests=(
                        {
                            "route": "/api/agent/directory-lookup",
                            "method": "POST",
                            "body": {"query": "Ada"},
                            "stub_error": None,
                        },
                    ),
                    tools_catalog_log=(
                        'tools.catalog ok: [{"name":"skills.search"}]'
                    ),
                )

        class CapturingFactory:
            def create(self, task):
                return CapturingRuntime(clock)

        task = runner.Task(
            id="graded-task",
            skill="psd-directory",
            level="L1",
            workspace="pure",
            prompt="Find Ada.",
            trials=1,
            graders=runner.validate_grader_specs(
                [
                    {
                        "type": "broker_request",
                        "route": "/api/agent/directory-lookup",
                        "body": {"query": {"exact": "Ada"}},
                    },
                    {
                        "type": "tools_catalog",
                        "expected": ["skills.search"],
                    },
                ]
            ),
        )

        records = runner.EvaluationRunner(
            CapturingFactory(),
            FakeMinter(clock),
            now=clock.now,
        ).run([task], io.StringIO())

        self.assertTrue(records[0]["grade"]["passed"])
        self.assertEqual(
            records[0]["broker_requests"][0]["route"],
            "/api/agent/directory-lookup",
        )


class RecordingExecutor:
    def __init__(self) -> None:
        self.calls: list[tuple[str, ...]] = []
        self.broker_trial_config: dict[str, object] | None = None
        self.broker_capture = ""

    def run(self, arguments, **options):
        call = tuple(arguments)
        self.calls.append(call)
        if call[-1:] == (runner.RUNNER_WRITE_TRIAL_COMMAND,):
            self.broker_trial_config = json.loads(options["input_text"])
            self.broker_capture = ""
            return runner.CommandResult(0, "", "")
        if call[-1:] == (runner.RUNNER_READ_CAPTURES_COMMAND,):
            self.broker_trial_config = None
            return runner.CommandResult(0, self.broker_capture, "")
        if call[:2] == ("docker", "run"):
            return runner.CommandResult(0, "container-123\n", "")
        if call[:2] == ("docker", "logs"):
            return runner.CommandResult(0, "BOOT_OK provider=test", "")
        if "http://127.0.0.1:8080/ping" in call:
            return runner.CommandResult(0, "", "")
        if "http://127.0.0.1:8080/invocations" in call:
            session_header = next(
                value
                for value in call
                if value.startswith(
                    "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id:"
                )
            )
            session_id = session_header.rsplit(" ", 1)[1]
            event = {"result": "ok", "metadata": metadata(session_id)}
            return runner.CommandResult(0, f"data: {json.dumps(event)}\n", "")
        if call[:3] == ("docker", "rm", "-f"):
            return runner.CommandResult(0, "", "")
        return runner.CommandResult(0, "true\n", "")


class FailedRemoveExecutor(RecordingExecutor):
    def run(self, arguments, **options):
        result = super().run(arguments, **options)
        if tuple(arguments)[:3] == ("docker", "rm", "-f"):
            return runner.CommandResult(1, "", "daemon unavailable")
        return result


class NeverBootExecutor(RecordingExecutor):
    def run(self, arguments, **options):
        result = super().run(arguments, **options)
        if tuple(arguments)[:2] == ("docker", "logs"):
            return runner.CommandResult(0, "still starting", "")
        return result


class NeverListenExecutor(RecordingExecutor):
    def run(self, arguments, **options):
        result = super().run(arguments, **options)
        if "http://127.0.0.1:8080/ping" in tuple(arguments):
            return runner.CommandResult(7, "", "connection refused")
        return result


class MissingResultExecutor(RecordingExecutor):
    def run(self, arguments, **options):
        result = super().run(arguments, **options)
        if "http://127.0.0.1:8080/invocations" in tuple(arguments):
            return runner.CommandResult(0, 'data: {"type":"start"}\n', "")
        return result


class CatalogExecutor(RecordingExecutor):
    def run(self, arguments, **options):
        result = super().run(arguments, **options)
        if tuple(arguments)[:3] == ("docker", "logs", "--since"):
            return runner.CommandResult(
                0,
                (
                    'tools.catalog ok: [{"name":"skills.search"},'
                    '{"name":"directory.lookup"}]'
                ),
                "",
            )
        return result


class SequenceCredentialProvider:
    def __init__(self, credentials: list[runner.AwsCredentials]) -> None:
        self.credentials = credentials
        self.calls = 0

    def resolve(self) -> runner.AwsCredentials:
        index = min(self.calls, len(self.credentials) - 1)
        self.calls += 1
        return self.credentials[index]


class MonotonicClock:
    def __init__(self) -> None:
        self.value = 0.0
        self.sleeps: list[float] = []

    def monotonic(self) -> float:
        return self.value

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.value += seconds


def aws_credentials(
    access_key: str = "access-1",
    session_token: str = "token-1",
    *,
    expires_at: datetime | None = datetime.max.replace(tzinfo=timezone.utc),
) -> runner.AwsCredentials:
    return runner.AwsCredentials(
        environment={
            "AWS_ACCESS_KEY_ID": access_key,
            "AWS_SECRET_ACCESS_KEY": f"secret-{access_key}",
            "AWS_SESSION_TOKEN": session_token,
        },
        expires_at=expires_at,
    )


class ProbeContextMinterTests(unittest.TestCase):
    def test_uses_resolved_credentials_and_requested_ttl(self):
        clock = AdvancingClock()
        executor = mock.Mock()
        executor.run.return_value = runner.CommandResult(
            0,
            json.dumps(
                {
                    "invocationContext": "context",
                    "requestProofKey": "proof",
                    "ownerEmail": "canary@build-gate.invalid",
                    "sessionId": "session-id",
                    "expiresAt": (
                        clock.now() + timedelta(seconds=965)
                    ).isoformat(),
                }
            ),
            "",
        )
        provider = SequenceCredentialProvider([aws_credentials("fresh", "fresh-token")])
        minter = runner.ProbeContextMinter(
            executor,
            AGENT_IMAGE_DIR.parent.parent,
            "dev",
            "us-east-1",
            credential_provider=provider,
            ttl_seconds=965,
            minimum_remaining_seconds=960,
            now=clock.now,
        )

        with mock.patch.dict(
            os.environ,
            {
                "AWS_ACCESS_KEY_ID": "stale",
                "AWS_SECRET_ACCESS_KEY": "stale",
                "AWS_SESSION_TOKEN": "stale",
            },
        ):
            authority = minter.mint("session-id")

        self.assertEqual(authority.session_id, "session-id")
        self.assertEqual(provider.calls, 1)
        call = executor.run.call_args
        self.assertEqual(call.args[0][-2:], ["--ttl", "965"])
        self.assertEqual(call.kwargs["env"]["AWS_ACCESS_KEY_ID"], "fresh")
        self.assertEqual(call.kwargs["env"]["AWS_SESSION_TOKEN"], "fresh-token")


class DockerRuntimeTests(unittest.TestCase):
    def test_process_credentials_preserve_expiration_for_refresh_decisions(self):
        expiration = "2026-07-28T18:00:00Z"
        executor = mock.Mock()
        executor.run.return_value = runner.CommandResult(
            0,
            json.dumps(
                {
                    "Version": 1,
                    "AccessKeyId": "access",
                    "SecretAccessKey": "secret",
                    "SessionToken": "token",
                    "Expiration": expiration,
                }
            ),
            "",
        )

        credentials = runner._resolve_aws_credentials(executor)

        self.assertEqual(credentials.environment["AWS_SESSION_TOKEN"], "token")
        self.assertEqual(
            credentials.expires_at,
            datetime(2026, 7, 28, 18, tzinfo=timezone.utc),
        )
        executor.run.assert_called_once_with(
            ["aws", "configure", "export-credentials", "--format", "process"],
            check=False,
            timeout=30,
        )

    def test_timeout_error_never_echoes_secret_arguments(self):
        executor = runner.CommandExecutor()
        secret = "secret-session-token"
        timeout_error = runner.subprocess.TimeoutExpired(
            ["docker", "run", "-e", f"AWS_SESSION_TOKEN={secret}"],
            60,
        )
        with mock.patch.object(
            runner.subprocess,
            "run",
            side_effect=timeout_error,
        ), self.assertRaisesRegex(
            runner.EvalRunnerError,
            "docker timed out after 60s",
        ) as raised:
            executor.run(
                ["docker", "run", "-e", f"AWS_SESSION_TOKEN={secret}"],
                timeout=60,
            )

        self.assertNotIn(secret, str(raised.exception))

    def test_invocation_sends_agentcore_session_header(self):
        executor = RecordingExecutor()
        runtime = runner.DockerRuntime(
            executor,
            "candidate@sha256:digest",
            "linux/arm64",
            {
                "APP_BASE_URL": "https://dev.example.invalid",
            },
            SequenceCredentialProvider([aws_credentials()]),
            boot_timeout_seconds=120,
            invocation_timeout_seconds=900,
            poll_interval_seconds=0,
            name_prefix="psd-agent-eval-issue-1422-test",
        )
        runtime.prepare()
        session_id = str("a" * 36)
        authority = runner.InvocationAuthority(
            invocation_context="context",
            request_proof_key="proof",
            owner_email="canary@build-gate.invalid",
            session_id=session_id,
            expires_at=datetime.now(timezone.utc) + timedelta(minutes=15),
        )
        event = runtime.invoke(
            runner.Task("task", "core", "L0", "pure", "prompt", 1),
            session_id,
            authority,
        )
        runtime.stop()

        self.assertEqual(event["result"], "ok")
        invocation_call = next(
            call
            for call in executor.calls
            if "http://127.0.0.1:8080/invocations" in call
        )
        self.assertIn(
            f"X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: {session_id}",
            invocation_call,
        )

    def test_l1_runtime_uses_root_tmpfs_and_collects_per_trial_capture(self):
        executor = RecordingExecutor()
        with tempfile.TemporaryDirectory() as directory:
            fixture_path = Path(directory) / "fixture.json"
            fixture_path.write_text(
                json.dumps(
                    [
                        {
                            "route": "/api/agent/directory-lookup",
                            "response": {"body": {"people": []}},
                        }
                    ]
                ),
                encoding="utf-8",
            )
            runtime = runner.DockerRuntime(
                executor,
                "candidate@sha256:digest",
                "linux/arm64",
                {"APP_BASE_URL": "https://dev.example.invalid"},
                SequenceCredentialProvider([aws_credentials()]),
                boot_timeout_seconds=120,
                invocation_timeout_seconds=900,
                poll_interval_seconds=0,
                name_prefix="psd-agent-eval-issue-1424-test",
                broker_stub_path=(
                    AGENT_IMAGE_DIR / "eval" / "broker_stub.py"
                ),
                use_broker_stub=True,
            )
            runtime.prepare()
            task = runner.Task(
                id="directory-lookup",
                skill="psd-directory",
                level="L1",
                workspace="pure",
                prompt="Find Ada.",
                trials=1,
                fixture_paths=(fixture_path,),
                graders=runner.validate_grader_specs(
                    [
                        {
                            "type": "broker_request",
                            "route": "/api/agent/directory-lookup",
                        }
                    ]
                ),
            )
            session_id = "a" * 36
            runtime.begin_trial(task, 1, session_id)
            trial = executor.broker_trial_config
            self.assertIsNotNone(trial)
            self.assertEqual(
                trial["fixtures"][0]["route"],
                "/api/agent/directory-lookup",
            )
            executor.broker_capture = (
                json.dumps(
                    {
                        "route": "/api/agent/directory-lookup",
                        "method": "POST",
                        "body": {"query": "Ada"},
                        "stub_error": None,
                    }
                )
                + "\n"
            )

            artifacts = runtime.end_trial()
            runtime.stop()

        docker_run = next(
            call for call in executor.calls if call[:2] == ("docker", "run")
        )
        joined = "\n".join(docker_run)
        self.assertIn("dst=/app/mantle_proxy.py,readonly", joined)
        self.assertIn("--tmpfs", docker_run)
        self.assertIn(runner.BROKER_CONTROL_TMPFS_OPTIONS, docker_run)
        self.assertIn("mode=0700,uid=0,gid=0", joined)
        self.assertNotIn("dst=/run/psd-agent-eval-broker", joined)
        self.assertEqual(docker_run.count("--mount"), 1)
        self.assertIn(
            "AGENT_EVAL_BROKER_CONTROL_DIR=/run/psd-agent-eval-broker",
            docker_run,
        )
        self.assertEqual(
            artifacts.broker_requests[0]["route"],
            "/api/agent/directory-lookup",
        )
        broker_execs = [
            call
            for call in executor.calls
            if call[:2] == ("docker", "exec")
            and call[-1]
            in {
                runner.RUNNER_WRITE_TRIAL_COMMAND,
                runner.RUNNER_READ_CAPTURES_COMMAND,
            }
        ]
        self.assertEqual(len(broker_execs), 2)
        self.assertTrue(
            all(
                ("--user", "0:0") == call[2:4]
                for call in broker_execs
            )
        )
        self.assertIsNone(executor.broker_trial_config)

    def test_runtime_collects_tools_catalog_diagnostic_for_its_trial(self):
        executor = CatalogExecutor()
        runtime = runner.DockerRuntime(
            executor,
            "candidate@sha256:digest",
            "linux/arm64",
            {"APP_BASE_URL": "https://dev.example.invalid"},
            SequenceCredentialProvider([aws_credentials()]),
            boot_timeout_seconds=120,
            invocation_timeout_seconds=900,
            poll_interval_seconds=0,
            name_prefix="psd-agent-eval-issue-1424-test",
        )
        runtime.prepare()
        task = runner.Task(
            id="catalog-task",
            skill="runner-core",
            level="L0",
            workspace="pure",
            prompt="hello",
            trials=1,
            graders=runner.validate_grader_specs(
                [
                    {
                        "type": "tools_catalog",
                        "expected": ["skills.search", "directory.lookup"],
                    }
                ]
            ),
        )

        runtime.begin_trial(task, 1, "a" * 36)
        artifacts = runtime.end_trial()
        runtime.stop()

        self.assertIn('"skills.search"', artifacts.tools_catalog_log)
        self.assertTrue(
            any(call[:3] == ("docker", "logs", "--since") for call in executor.calls)
        )

    def test_missing_result_is_reported_as_a_runner_error(self):
        runtime = runner.DockerRuntime(
            MissingResultExecutor(),
            "candidate@sha256:digest",
            "linux/arm64",
            {"APP_BASE_URL": "https://dev.example.invalid"},
            SequenceCredentialProvider([aws_credentials()]),
            boot_timeout_seconds=120,
            invocation_timeout_seconds=900,
            poll_interval_seconds=0,
            name_prefix="psd-agent-eval-issue-1422-test",
        )
        runtime.prepare()
        session_id = str("a" * 36)
        authority = runner.InvocationAuthority(
            invocation_context="context",
            request_proof_key="proof",
            owner_email="canary@build-gate.invalid",
            session_id=session_id,
            expires_at=datetime.now(timezone.utc) + timedelta(minutes=15),
        )

        with self.assertRaisesRegex(
            runner.EvalRunnerError,
            "invalid invocation response: invocation stream contained no result event",
        ):
            runtime.invoke(
                runner.Task("task", "core", "L0", "pure", "prompt", 1),
                session_id,
                authority,
            )
        runtime.stop()

    def test_rotated_credentials_recycle_shared_runtime_before_next_trial(self):
        executor = RecordingExecutor()
        first = aws_credentials()
        second = aws_credentials("access-2", "token-2")
        provider = SequenceCredentialProvider(
            [first, first, first, second, second]
        )
        runtime = runner.DockerRuntime(
            executor,
            "candidate@sha256:digest",
            "linux/arm64",
            {"APP_BASE_URL": "https://dev.example.invalid"},
            provider,
            boot_timeout_seconds=120,
            invocation_timeout_seconds=900,
            poll_interval_seconds=0,
            name_prefix="psd-agent-eval-issue-1422-test",
        )

        runtime.prepare()
        runtime.prepare()
        runtime.prepare()
        runtime.stop()

        docker_runs = [
            call for call in executor.calls if call[:2] == ("docker", "run")
        ]
        self.assertEqual(provider.calls, 5)
        self.assertEqual(len(docker_runs), 2)
        self.assertEqual(
            sum(call[:3] == ("docker", "rm", "-f") for call in executor.calls),
            2,
        )
        self.assertTrue(
            any(value == "AWS_SESSION_TOKEN=token-2" for value in docker_runs[1])
        )

    def test_credentials_must_outlive_invocation_timeout(self):
        executor = RecordingExecutor()
        now = datetime(2026, 7, 28, tzinfo=timezone.utc)
        runtime = runner.DockerRuntime(
            executor,
            "candidate@sha256:digest",
            "linux/arm64",
            {"APP_BASE_URL": "https://dev.example.invalid"},
            SequenceCredentialProvider(
                [aws_credentials(expires_at=now + timedelta(seconds=959))]
            ),
            boot_timeout_seconds=120,
            invocation_timeout_seconds=900,
            poll_interval_seconds=0,
            name_prefix="psd-agent-eval-issue-1422-test",
            now=lambda: now,
        )

        with self.assertRaisesRegex(runner.EvalRunnerError, "refresh the AWS login"):
            runtime.prepare()
        self.assertFalse(
            any(call[:2] == ("docker", "run") for call in executor.calls)
        )

    def test_temporary_credentials_require_known_expiration(self):
        executor = RecordingExecutor()
        runtime = runner.DockerRuntime(
            executor,
            "candidate@sha256:digest",
            "linux/arm64",
            {"APP_BASE_URL": "https://dev.example.invalid"},
            SequenceCredentialProvider([aws_credentials(expires_at=None)]),
            boot_timeout_seconds=120,
            invocation_timeout_seconds=900,
            poll_interval_seconds=0,
            name_prefix="psd-agent-eval-issue-1422-test",
        )

        with self.assertRaisesRegex(
            runner.EvalRunnerError,
            "temporary credentials have unknown expiration",
        ):
            runtime.prepare()
        self.assertFalse(
            any(call[:2] == ("docker", "run") for call in executor.calls)
        )

    def test_static_credentials_do_not_require_expiration(self):
        executor = RecordingExecutor()
        credentials = runner.AwsCredentials(
            environment={
                "AWS_ACCESS_KEY_ID": "static-access",
                "AWS_SECRET_ACCESS_KEY": "static-secret",
            },
            expires_at=None,
        )
        runtime = runner.DockerRuntime(
            executor,
            "candidate@sha256:digest",
            "linux/arm64",
            {"APP_BASE_URL": "https://dev.example.invalid"},
            SequenceCredentialProvider([credentials]),
            boot_timeout_seconds=120,
            invocation_timeout_seconds=900,
            poll_interval_seconds=0,
            name_prefix="psd-agent-eval-issue-1422-test",
        )

        self.assertTrue(runtime.prepare())
        runtime.stop()

    def test_credentials_are_rechecked_after_container_startup(self):
        executor = RecordingExecutor()
        now = datetime(2026, 7, 28, tzinfo=timezone.utc)
        runtime = runner.DockerRuntime(
            executor,
            "candidate@sha256:digest",
            "linux/arm64",
            {"APP_BASE_URL": "https://dev.example.invalid"},
            SequenceCredentialProvider(
                [
                    aws_credentials(expires_at=now + timedelta(seconds=961)),
                    aws_credentials(expires_at=now + timedelta(seconds=959)),
                ]
            ),
            boot_timeout_seconds=120,
            invocation_timeout_seconds=900,
            poll_interval_seconds=0,
            name_prefix="psd-agent-eval-issue-1422-test",
            now=lambda: now,
        )

        with self.assertRaisesRegex(runner.EvalRunnerError, "refresh the AWS login"):
            runtime.prepare()
        self.assertEqual(
            sum(call[:2] == ("docker", "run") for call in executor.calls),
            1,
        )
        self.assertEqual(
            sum(call[:3] == ("docker", "rm", "-f") for call in executor.calls),
            1,
        )

    def test_failed_container_removal_is_visible(self):
        executor = FailedRemoveExecutor()
        runtime = runner.DockerRuntime(
            executor,
            "candidate@sha256:digest",
            "linux/arm64",
            {"APP_BASE_URL": "https://dev.example.invalid"},
            SequenceCredentialProvider([aws_credentials()]),
            boot_timeout_seconds=120,
            invocation_timeout_seconds=900,
            poll_interval_seconds=0,
            name_prefix="psd-agent-eval-issue-1422-test",
        )
        runtime.prepare()

        with self.assertLogs("agent_eval", level="WARNING") as captured:
            runtime.stop()

        self.assertIn("daemon unavailable", "\n".join(captured.output))

    def test_boot_polling_never_sleeps_past_its_deadline(self):
        clock = MonotonicClock()
        runtime = runner.DockerRuntime(
            NeverBootExecutor(),
            "candidate@sha256:digest",
            "linux/arm64",
            {"APP_BASE_URL": "https://dev.example.invalid"},
            SequenceCredentialProvider([aws_credentials()]),
            boot_timeout_seconds=5,
            invocation_timeout_seconds=900,
            poll_interval_seconds=3600,
            name_prefix="psd-agent-eval-issue-1422-test",
            monotonic=clock.monotonic,
            sleep=clock.sleep,
        )

        with self.assertRaisesRegex(runner.EvalRunnerError, "within 5s"):
            runtime.prepare()

        self.assertEqual(clock.sleeps, [5.0])

    def test_listener_polling_never_sleeps_past_its_deadline(self):
        clock = MonotonicClock()
        runtime = runner.DockerRuntime(
            NeverListenExecutor(),
            "candidate@sha256:digest",
            "linux/arm64",
            {"APP_BASE_URL": "https://dev.example.invalid"},
            SequenceCredentialProvider([aws_credentials()]),
            boot_timeout_seconds=120,
            invocation_timeout_seconds=900,
            poll_interval_seconds=3600,
            name_prefix="psd-agent-eval-issue-1422-test",
            monotonic=clock.monotonic,
            sleep=clock.sleep,
        )

        with self.assertRaisesRegex(runner.EvalRunnerError, "listener never"):
            runtime.prepare()

        self.assertEqual(clock.sleeps, [30.0])


class MainWiringTests(unittest.TestCase):
    def test_invocation_timeout_controls_context_ttl_and_credentials(self):
        provider = mock.Mock()
        minter = mock.Mock()
        evaluation = mock.Mock()
        evaluation.run.return_value = []
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(
            runner,
            "load_suite",
            return_value=[],
        ), mock.patch.object(
            runner,
            "_resolve_app_base_url",
            return_value="https://dev.example.invalid",
        ), mock.patch.object(
            runner,
            "ActiveAwsCredentialProvider",
            return_value=provider,
        ), mock.patch.object(
            runner,
            "DockerRuntimeFactory",
        ) as runtime_factory, mock.patch.object(
            runner,
            "ProbeContextMinter",
            return_value=minter,
        ) as context_minter, mock.patch.object(
            runner,
            "EvaluationRunner",
            return_value=evaluation,
        ):
            status = runner.main(
                [
                    "--image",
                    "candidate@sha256:digest",
                    "--suite",
                    "suite.yaml",
                    "--out",
                    str(Path(directory) / "results.jsonl"),
                    "--invocation-timeout",
                    "1200",
                ]
            )

        self.assertEqual(status, 0)
        self.assertIs(runtime_factory.call_args.args[4], provider)
        self.assertEqual(
            runtime_factory.call_args.kwargs["invocation_timeout_seconds"],
            1200,
        )
        self.assertEqual(context_minter.call_args.kwargs["ttl_seconds"], 1265)
        self.assertEqual(
            context_minter.call_args.kwargs["minimum_remaining_seconds"],
            1260,
        )
        self.assertIs(
            context_minter.call_args.kwargs["credential_provider"],
            provider,
        )


class BuildGateCompatibilityTests(unittest.TestCase):
    def test_probe_artifact_schemas_and_shared_parser_remain_wired(self):
        build_script = (AGENT_IMAGE_DIR / "build-and-push.sh").read_text(
            encoding="utf-8"
        )
        self.assertIn('eval/probe.py" last-result', build_script)
        self.assertIn('eval/probe.py" make-payload --', build_script)
        self.assertIn(
            '\'{"tag":"%s","boot_ok":false,"boot_elapsed_s":%s,'
            '"canary_ok":false}\\n\'',
            build_script,
        )
        self.assertIn(
            '\'{"tag":"%s","boot_ok":true,"boot_elapsed_s":%s,'
            '"canary_ok":%s,"canary_elapsed_s":%s}\\n\'',
            build_script,
        )


if __name__ == "__main__":
    unittest.main()
