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

    def prepare(self) -> None:
        self.started = True

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

    def stop(self) -> None:
        self.stopped = True


class FakeRuntimeFactory:
    def __init__(self, clock: AdvancingClock) -> None:
        self.clock = clock
        self.runtimes: list[FakeRuntime] = []

    def create(self) -> FakeRuntime:
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
                super().prepare()

            def invoke(self, task, session_id, authority):
                events.append("invoke")
                return super().invoke(task, session_id, authority)

        class OrderedFactory:
            def create(self):
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
            def create(self):
                return IncompleteRuntime(clock)

        with self.assertRaisesRegex(runner.EvalRunnerError, "latency_ms"):
            runner.EvaluationRunner(
                IncompleteFactory(),
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
            def create(self):
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


class RecordingExecutor:
    def __init__(self) -> None:
        self.calls: list[tuple[str, ...]] = []

    def run(self, arguments, **options):
        del options
        call = tuple(arguments)
        self.calls.append(call)
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


class SequenceCredentialProvider:
    def __init__(self, credentials: list[runner.AwsCredentials]) -> None:
        self.credentials = credentials
        self.calls = 0

    def resolve(self) -> runner.AwsCredentials:
        index = min(self.calls, len(self.credentials) - 1)
        self.calls += 1
        return self.credentials[index]


def aws_credentials(
    access_key: str = "access-1",
    session_token: str = "token-1",
    *,
    expires_at: datetime | None = None,
) -> runner.AwsCredentials:
    return runner.AwsCredentials(
        environment={
            "AWS_ACCESS_KEY_ID": access_key,
            "AWS_SECRET_ACCESS_KEY": f"secret-{access_key}",
            "AWS_SESSION_TOKEN": session_token,
        },
        expires_at=expires_at,
    )


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


class BuildGateCompatibilityTests(unittest.TestCase):
    def test_probe_artifact_schemas_and_shared_parser_remain_wired(self):
        build_script = (AGENT_IMAGE_DIR / "build-and-push.sh").read_text(
            encoding="utf-8"
        )
        self.assertIn('eval/probe.py" last-result', build_script)
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
