"""Tests for harness_adapter: the per-container gateway token (REV-INFRA-005),
text extraction / failed-turn framing / accumulation / deadlines / tool
telemetry (#1138 F4, r10-r12).

The adapter used to hardcode `GATEWAY_TOKEN = "psd-agent-internal-gateway-token"`
in source (readable by the sandboxed `node` agent, and committed to the repo).
It now generates a random token in `__init__` and reuses it for both the
`openclaw gateway --token` launcher and its own connect envelope, so launcher and
client always agree without any static secret.

Run:
    uv run --python 3.12 --no-project python3 -m unittest infra/agent-image/test_harness_adapter.py

harness_adapter only imports stdlib + two local pure-Python modules
(agent_failures, chat_format), so no dependency stubbing is required.
Instantiating OpenClawAdapter runs no subprocess/network — __init__ only sets
plain attributes.
"""

import json
import os
import pathlib
import sqlite3
import sys
import time
import unittest
from datetime import datetime, timezone
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))

import harness_adapter  # noqa: E402
from harness_adapter import OpenClawAdapter, _frame_failed_partial  # noqa: E402

# Bound staticmethod for readability.
extract_text = OpenClawAdapter._extract_text

OLD_LITERAL = "psd-agent-internal-gateway-token"


class CatalogDiagnosticTests(unittest.TestCase):
    def test_compacts_every_name_without_the_old_diagnostic_truncation(self):
        tools = [
            {
                "name": f"tool.{index:02d}",
                "description": "x" * 100,
            }
            for index in range(40)
        ]

        names = harness_adapter._catalog_tool_names(tools)
        compact = json.dumps({"names": names}, separators=(",", ":"))

        self.assertGreater(len(json.dumps(tools)), 1500)
        self.assertLess(len(compact), 1500)
        self.assertEqual(names[0], "tool.00")
        self.assertEqual(names[-1], "tool.39")
        self.assertEqual(len(names), 40)

    def test_reads_names_from_grouped_catalogs_and_deduplicates(self):
        names = harness_adapter._catalog_tool_names(
            {
                "workspace": [
                    {"name": "workspace.execute"},
                    {"name": "skills.search"},
                ],
                "core": [
                    {"name": "skills.search"},
                    {"name": "read"},
                ],
            }
        )

        self.assertEqual(
            names,
            ["workspace.execute", "skills.search", "read"],
        )

    def test_ignores_strings_and_name_fields_nested_inside_tool_schemas(self):
        names = harness_adapter._catalog_tool_names(
            [
                {
                    "name": "actual.tool",
                    "inputSchema": {
                        "required": ["phantom.required"],
                        "properties": {
                            "choice": {
                                "enum": ["phantom.enum"],
                                "name": "phantom.nested-name",
                            }
                        },
                    },
                }
            ]
        )

        self.assertEqual(names, ["actual.tool"])


class GatewayTokenTests(unittest.TestCase):
    def test_defaults_to_supported_baseline_gateway_identity(self):
        self.assertEqual(
            OpenClawAdapter.CLIENT_INFO,
            {
                "id": "gateway-client",
                "mode": "backend",
                "version": "dev",
                "platform": "linux",
            },
        )

    def test_token_generated_and_nonempty(self):
        a = harness_adapter.OpenClawAdapter()
        # secrets.token_urlsafe(32) yields ~43 url-safe chars; assert it is a
        # substantial random string, not a short/blank placeholder.
        self.assertIsInstance(a._gateway_token, str)
        self.assertGreaterEqual(len(a._gateway_token), 32)
        self.assertNotIn(a._gateway_token, ("", OLD_LITERAL))

    def test_token_is_per_instance_random(self):
        a = harness_adapter.OpenClawAdapter()
        b = harness_adapter.OpenClawAdapter()
        self.assertNotEqual(a._gateway_token, b._gateway_token)

    def test_no_hardcoded_class_constant(self):
        # The old committed literal must not survive as a class attribute.
        self.assertFalse(hasattr(harness_adapter.OpenClawAdapter, "GATEWAY_TOKEN"))

    def test_literal_absent_from_source(self):
        src = pathlib.Path(harness_adapter.__file__).read_text(encoding="utf-8")
        self.assertNotIn(OLD_LITERAL, src)

    def test_configure_passes_runtime_token_to_gateway_cli(self):
        # Behavioral check: the value handed to `openclaw gateway --token` is
        # exactly this instance's generated token — the same attribute the
        # connect envelope reads (harness_adapter.py: `gateway_token =
        # self._gateway_token`), so launcher and client cannot diverge.
        a = harness_adapter.OpenClawAdapter()
        with mock.patch.dict(
                harness_adapter.os.environ,
                {
                    "AWS_BEARER_TOKEN_BEDROCK": "secret",
                    "BEDROCK_API_KEY_SECRET_ARN": "secret-arn",
                    "CANDIDATE_MANTLE_BEARER_TOKEN": "relay-secret",
                },
                clear=False,
            ), mock.patch.object(harness_adapter.subprocess, "Popen") as popen, \
                mock.patch.object(harness_adapter.OpenClawAdapter, "_wait_for_ready"), \
                mock.patch.object(harness_adapter.time, "sleep"):
            a.configure({"gateway_port": 3100})

        popen.assert_called_once()
        argv = popen.call_args[0][0]
        self.assertIn("--token", argv)
        token_value = argv[argv.index("--token") + 1]
        self.assertEqual(token_value, a._gateway_token)
        self.assertNotEqual(token_value, OLD_LITERAL)
        child_environment = popen.call_args.kwargs["env"]
        self.assertNotIn("AWS_BEARER_TOKEN_BEDROCK", child_environment)
        self.assertNotIn("BEDROCK_API_KEY_SECRET_ARN", child_environment)
        self.assertNotIn("CANDIDATE_MANTLE_BEARER_TOKEN", child_environment)
        self.assertTrue(popen.call_args.kwargs["start_new_session"])

    def test_shutdown_kills_stubborn_children_after_parent_exits(self):
        adapter = harness_adapter.OpenClawAdapter()
        process = mock.Mock()
        process.pid = 4242
        process.poll.side_effect = [None, 0]
        adapter._process = process
        adapter._process_group_id = process.pid

        with mock.patch.object(
            harness_adapter.os,
            "killpg",
        ) as kill_group, mock.patch.object(
            harness_adapter,
            "_wait_for_process_group_quiescence",
        ) as wait_for_group:
            adapter.shutdown()

        self.assertEqual(
            kill_group.call_args_list,
            [
                mock.call(4242, harness_adapter.signal.SIGTERM),
                mock.call(4242, harness_adapter.signal.SIGKILL),
            ],
        )
        process.terminate.assert_not_called()
        process.wait.assert_called_once_with(timeout=10)
        wait_for_group.assert_called_once_with(4242)
        self.assertIsNone(adapter._process)
        self.assertIsNone(adapter._process_group_id)

    def test_shutdown_kills_the_process_group_after_timeout(self):
        adapter = harness_adapter.OpenClawAdapter()
        process = mock.Mock()
        process.pid = 4343
        process.poll.return_value = None
        process.wait.side_effect = [
            harness_adapter.subprocess.TimeoutExpired("openclaw", 10),
            None,
        ]
        adapter._process = process
        adapter._process_group_id = process.pid

        with mock.patch.object(
            harness_adapter.os,
            "killpg",
        ) as kill_group, mock.patch.object(
            harness_adapter,
            "_wait_for_process_group_quiescence",
        ) as wait_for_group:
            adapter.shutdown()

        self.assertEqual(
            kill_group.call_args_list,
            [
                mock.call(4343, harness_adapter.signal.SIGTERM),
                mock.call(4343, harness_adapter.signal.SIGKILL),
            ],
        )
        self.assertEqual(process.wait.call_count, 2)
        wait_for_group.assert_called_once_with(4343)

    def test_process_group_quiescence_waits_until_all_members_are_gone(self):
        with mock.patch.object(
            harness_adapter,
            "_process_group_has_live_members",
            side_effect=[True, True, False],
        ) as has_live_members, mock.patch.object(
            harness_adapter.time,
            "monotonic",
            return_value=10.0,
        ), mock.patch.object(
            harness_adapter.time,
            "sleep",
        ) as sleep:
            harness_adapter._wait_for_process_group_quiescence(
                4444,
                timeout_seconds=1.0,
            )

        self.assertEqual(has_live_members.call_count, 3)
        self.assertEqual(
            sleep.call_args_list,
            [
                mock.call(harness_adapter.PROCESS_GROUP_POLL_SECONDS),
                mock.call(harness_adapter.PROCESS_GROUP_POLL_SECONDS),
            ],
        )

    def test_process_group_quiescence_timeout_raises(self):
        with mock.patch.object(
            harness_adapter,
            "_process_group_has_live_members",
            return_value=True,
        ) as has_live_members, mock.patch.object(
            harness_adapter.time,
            "monotonic",
            side_effect=[10.0, 11.0],
        ), mock.patch.object(
            harness_adapter.time,
            "sleep",
        ) as sleep:
            with self.assertRaisesRegex(
                RuntimeError,
                "process group did not become quiescent",
            ):
                harness_adapter._wait_for_process_group_quiescence(
                    4545,
                    timeout_seconds=1.0,
                )

        has_live_members.assert_called_once_with(4545)
        sleep.assert_not_called()

    def test_gateway_socket_suppresses_browser_origin_header(self):
        websocket_module = mock.Mock()
        expected_socket = object()
        websocket_module.create_connection.return_value = expected_socket

        socket = OpenClawAdapter._open_gateway_socket(
            websocket_module,
            "ws://127.0.0.1:3100",
        )

        self.assertIs(socket, expected_socket)
        websocket_module.create_connection.assert_called_once_with(
            "ws://127.0.0.1:3100",
            timeout=120,
            suppress_origin=True,
        )


class GatewayClientIdentityTests(unittest.TestCase):
    def test_loopback_adapter_uses_supported_backend_identity(self):
        self.assertEqual(
            OpenClawAdapter.CLIENT_INFO,
            {
                "id": "gateway-client",
                "mode": "backend",
                "version": "dev",
                "platform": "linux",
            },
        )

    def test_adapter_does_not_claim_an_interactive_operator_ui_identity(self):
        self.assertNotIn(
            OpenClawAdapter.CLIENT_INFO["id"],
            {"openclaw-control-ui", "openclaw-browser-copilot", "openclaw-tui"},
        )

    def test_loopback_backend_socket_suppresses_browser_origin(self):
        source = pathlib.Path(harness_adapter.__file__).read_text(encoding="utf-8")
        self.assertIn("suppress_origin=True", source)


# Bound staticmethod for readability.
extract_text = OpenClawAdapter._extract_text


class TestExtractText(unittest.TestCase):
    def test_single_text_block_unchanged(self):
        self.assertEqual(
            extract_text([{"type": "text", "text": "hello world"}]),
            "hello world",
        )

    def test_multiple_text_blocks_joined_with_blank_line(self):
        # The incident shape: a narration block before each tool call, all
        # collapsed into one message's content list.
        blocks = [
            {"type": "text", "text": "Now let's find recordings from 7/1 in Plaud."},
            {"type": "tool_use", "name": "plaud", "input": {}},
            {"type": "text", "text": "Good, done. Let's read the file."},
            {"type": "tool_use", "name": "read", "input": {}},
            {"type": "text", "text": "Now getting the action-items breakdown."},
        ]
        result = extract_text(blocks)
        # Blocks are separated, not run together.
        self.assertNotIn("Plaud.Good", result)
        self.assertNotIn("file.Now", result)
        self.assertEqual(
            result,
            "Now let's find recordings from 7/1 in Plaud.\n\n"
            "Good, done. Let's read the file.\n\n"
            "Now getting the action-items breakdown.",
        )

    def test_empty_blocks_dropped_no_leading_or_trailing_separator(self):
        blocks = [
            {"type": "text", "text": ""},
            {"type": "text", "text": "real content"},
            {"type": "text", "text": "   "},
        ]
        self.assertEqual(extract_text(blocks), "real content")

    def test_only_tool_use_blocks_yield_empty(self):
        self.assertEqual(
            extract_text([{"type": "tool_use", "name": "x", "input": {}}]),
            "",
        )

    def test_plain_string_passthrough(self):
        self.assertEqual(extract_text("just a string"), "just a string")

    def test_json_string_of_blocks_is_parsed_and_joined(self):
        # _extract_text recurses into a JSON-encoded content list.
        import json

        payload = json.dumps(
            [
                {"type": "text", "text": "one"},
                {"type": "text", "text": "two"},
            ]
        )
        self.assertEqual(extract_text(payload), "one\n\ntwo")


class TestFrameFailedPartial(unittest.TestCase):
    def test_partial_is_prefaced_and_preserved(self):
        framed = _frame_failed_partial("Here is what I did so far.")
        self.assertTrue(framed.startswith("⚠️"))
        self.assertIn("couldn't finish", framed)
        self.assertIn("Here is what I did so far.", framed)

    def test_empty_partial_returns_standalone_error(self):
        framed = _frame_failed_partial("")
        self.assertTrue(framed.startswith("⚠️"))
        self.assertIn("couldn't complete", framed)

    def test_whitespace_only_partial_treated_as_empty(self):
        framed = _frame_failed_partial("   \n  ")
        self.assertIn("couldn't complete", framed)

    def test_none_partial_safe(self):
        framed = _frame_failed_partial(None)  # type: ignore[arg-type]
        self.assertIn("couldn't complete", framed)


class TestAccumulateAssistant(unittest.TestCase):
    """Boundary-aware accumulation of streamed assistant segments (#1138 F4)."""

    @staticmethod
    def acc(accum, increment, replace, boundary_pending):
        return OpenClawAdapter._accumulate_assistant(
            accum, increment, replace, boundary_pending
        )

    def test_increments_within_a_segment_join_without_separator(self):
        a = self.acc("", "Now let's find", False, False)
        a = self.acc(a, " recordings.", False, False)
        self.assertEqual(a, "Now let's find recordings.")

    def test_boundary_after_tool_activity_starts_terminal_assistant(self):
        # Live regression shape: transcript seq54 was an assistant toolUse
        # message with narration, seq55 was its tool result, and seq56 was the
        # terminal assistant stop message. Google Chat must receive seq56 only.
        a = self.acc(
            "Found it. This box has no channels config.",
            "Summary for you and the codex agent:",
            False,
            True,
        )
        self.assertEqual(a, "Summary for you and the codex agent:")

    def test_replace_resets_buffer_regardless_of_boundary(self):
        self.assertEqual(self.acc("old text", "fresh", True, True), "fresh")

    def test_boundary_with_empty_accum_starts_cleanly(self):
        self.assertEqual(self.acc("", "First words", False, True), "First words")

    def test_only_tool_like_item_streams_create_assistant_boundaries(self):
        is_boundary = OpenClawAdapter._is_tool_activity_stream
        self.assertTrue(is_boundary("item", {"kind": "tool"}))
        self.assertTrue(is_boundary("item", {"kind": "patch"}))
        self.assertTrue(is_boundary("command_output", {}))
        self.assertFalse(is_boundary("item", {"kind": "commentary"}))
        self.assertFalse(is_boundary("item", {"kind": "lifecycle"}))
        self.assertFalse(is_boundary("item", {}))


class TestTerminalAssistantSelection(unittest.TestCase):
    """A toolUse assistant block must not be folded into the terminal reply."""

    def test_process_returns_only_post_tool_terminal_assistant(self):
        chat_id = None

        class FakeWebSocket:
            def __init__(self, messages):
                self.messages = list(messages)
                self.sent = []

            def send(self, payload):
                nonlocal chat_id
                parsed = json.loads(payload)
                self.sent.append(parsed)
                if parsed.get("method") == "chat.send":
                    chat_id = parsed["id"]

            def recv(self):
                message = self.messages.pop(0)
                return message() if callable(message) else message

            def settimeout(self, _timeout):
                return None

            def close(self):
                return None

        def envelope(**fields):
            return json.dumps(fields)

        def current_run_event(event, payload):
            return envelope(
                type="event",
                event=event,
                payload={"runId": chat_id, **payload},
            )

        messages = [
            envelope(type="event", event="connect.challenge", payload={}),
            lambda: envelope(
                type="res",
                id=socket.sent[-1]["id"],
                ok=True,
                payload={},
            ),
            lambda: envelope(
                type="res",
                id=socket.sent[-1]["id"],
                ok=True,
                payload={"tools": []},
            ),
            lambda: envelope(
                type="res",
                id=socket.sent[-1]["id"],
                ok=True,
                payload={},
            ),
            lambda: envelope(
                type="res",
                id=chat_id,
                ok=True,
                payload={"runId": chat_id, "status": "started"},
            ),
            lambda: current_run_event(
                "agent",
                {
                    "stream": "assistant",
                    "data": {"deltaText": "Found it. Pre-tool narration."},
                },
            ),
            lambda: current_run_event(
                "agent",
                {
                    "stream": "item",
                    "data": {
                        "itemId": "tool-54",
                        "phase": "start",
                        "kind": "tool",
                        "name": "skill_workshop",
                    },
                },
            ),
            lambda: current_run_event(
                "agent",
                {
                    "stream": "item",
                    "data": {
                        "itemId": "tool-54",
                        "phase": "end",
                        "kind": "tool",
                        "name": "skill_workshop",
                        "status": "completed",
                        "output": "No skill proposals matched.",
                    },
                },
            ),
            lambda: current_run_event(
                "agent",
                {
                    "stream": "assistant",
                    "data": {
                        "deltaText": "Summary for you and the codex agent."
                    },
                },
            ),
            lambda: current_run_event(
                "chat",
                {"state": "final"},
            ),
        ]
        socket = FakeWebSocket(messages)
        fake_websocket_module = mock.Mock()
        fake_websocket_module.create_connection.return_value = socket
        fake_websocket_module.WebSocketTimeoutException = TimeoutError
        adapter = OpenClawAdapter()
        adapter._ready = True

        with (
            mock.patch.dict(sys.modules, {"websocket": fake_websocket_module}),
            mock.patch.object(
                adapter,
                "_read_turn_usage",
                return_value={
                    "input": 0,
                    "output": 0,
                    "cache_read": 0,
                    "cache_write": 0,
                    "model_calls": 0,
                    "capture_complete": False,
                },
            ),
        ):
            result = adapter.process("Diagnose this", "session-terminal")

        self.assertEqual(
            result.text,
            "Summary for you and the codex agent.",
        )
        self.assertNotIn("Pre-tool narration", result.text)
        self.assertEqual(len(result.tool_calls), 1)


class TestResolveDeadline(unittest.TestCase):
    """Turn-deadline resolution incl. the async-job override (#1138)."""

    resolve = staticmethod(OpenClawAdapter._resolve_deadline_s)

    def test_no_override_reserves_finalization_time(self):
        self.assertEqual(self.resolve(None), 550)

    def test_job_override_passes_within_ceiling(self):
        self.assertEqual(self.resolve(7200), 7200)
        self.assertEqual(self.resolve(3600), 3600)

    def test_job_override_clamps_to_bounds(self):
        self.assertEqual(self.resolve(50000), 7200)
        self.assertEqual(self.resolve(5), 60)

    def test_garbage_override_degrades_to_default(self):
        self.assertEqual(self.resolve("not-a-number"), 550)

    def test_env_path_still_clamped_to_interactive_ceiling(self):
        import os
        from unittest import mock
        with mock.patch.dict(os.environ, {"OPENCLAW_CHAT_DEADLINE_S": "7200"}):
            self.assertEqual(self.resolve(None), 550)


class TestChatDeadlineRegression(unittest.TestCase):
    """Aborted OpenClaw runs must retain their real lifecycle cause (#1461)."""

    @staticmethod
    def _message(**fields):
        return json.dumps(fields)

    def _run_context_overflow(self, *, include_abort):
        chat_id = None
        clock = [0.0]

        class FakeWebSocket:
            def __init__(self, messages):
                self.messages = list(messages)
                self.sent = []

            def send(self, payload):
                nonlocal chat_id
                parsed = json.loads(payload)
                self.sent.append(parsed)
                if parsed.get("method") == "chat.send":
                    chat_id = parsed["id"]

            def recv(self):
                message = self.messages.pop(0)
                if callable(message):
                    return message()
                return message

            def settimeout(self, _timeout):
                return None

            def close(self):
                return None

        def current_run_event(event, payload):
            return self._message(
                type="event",
                event=event,
                payload={"runId": chat_id, **payload},
            )

        def lifecycle_error_event():
            if not include_abort:
                # Simulate the chat channel never following the terminal
                # lifecycle error with its normal `state=aborted` event.
                clock[0] = 601.0
            return current_run_event(
                "agent",
                {
                    "stream": "lifecycle",
                    "data": {
                        "phase": "error",
                        "error": (
                            "Context overflow: prompt too large for the model."
                        ),
                    },
                },
            )

        messages = [
            self._message(type="event", event="connect.challenge", payload={}),
            lambda: self._message(
                type="res",
                id=socket.sent[-1]["id"],
                ok=True,
                payload={},
            ),
            lambda: self._message(
                type="res",
                id=socket.sent[-1]["id"],
                ok=True,
                payload={"tools": []},
            ),
            lambda: self._message(
                type="res",
                id=socket.sent[-1]["id"],
                ok=True,
                payload={},
            ),
            lambda: self._message(
                type="res",
                id=chat_id,
                ok=True,
                payload={"runId": chat_id, "status": "started"},
            ),
            lambda: current_run_event(
                "agent",
                {
                    "stream": "assistant",
                    "data": {"delta": "Working through the requested tools."},
                },
            ),
            lifecycle_error_event,
        ]
        if include_abort:
            messages.append(
                lambda: current_run_event(
                    "chat",
                    {"state": "aborted", "stopReason": "stop"},
                )
            )
        socket = FakeWebSocket(messages)
        fake_websocket_module = mock.Mock()
        fake_websocket_module.create_connection.return_value = socket
        fake_websocket_module.WebSocketTimeoutException = TimeoutError

        adapter = OpenClawAdapter()
        adapter._ready = True
        empty_usage = {
            "input": 0,
            "output": 0,
            "cache_read": 0,
            "cache_write": 0,
            "model_calls": 0,
            "capture_complete": False,
        }
        with (
            mock.patch.dict(
                sys.modules,
                {"websocket": fake_websocket_module},
            ),
            mock.patch.object(
                adapter,
                "_read_turn_usage",
                return_value=empty_usage,
            ),
            mock.patch(
                "harness_adapter.record_failure",
            ) as record_failure,
            mock.patch(
                "harness_adapter.time.time",
                side_effect=lambda: clock[0],
            ),
        ):
            result = adapter.process(
                "Run a complex multi-tool request",
                "session-1461",
                deadline_s=600,
            )

        return result, record_failure.call_args.kwargs

    def test_context_overflow_abort_is_not_recorded_as_deadline(self):
        result, failure = self._run_context_overflow(include_abort=True)

        self.assertTrue(result.failed)
        self.assertEqual(result.error_class, "ContextOverflow")
        self.assertIn("Working through", result.text)
        self.assertEqual(failure["error_class"], "ContextOverflow")
        self.assertNotEqual(
            failure["error_class"],
            "ChatDeadlineExpiredPartial",
        )
        self.assertEqual(failure["context"]["phase"], "chat_aborted")
        self.assertEqual(failure["context"]["deadline_s"], 600)
        self.assertLess(failure["context"]["elapsed_s"], 600)

    def test_lifecycle_overflow_without_abort_is_not_recorded_as_deadline(self):
        result, failure = self._run_context_overflow(include_abort=False)

        self.assertTrue(result.failed)
        self.assertEqual(result.error_class, "ContextOverflow")
        self.assertNotIn("deadline expired", failure["error_message"].lower())
        self.assertEqual(failure["context"]["phase"], "lifecycle_error")
        self.assertEqual(failure["context"]["deadline_s"], 600)
        self.assertGreaterEqual(failure["context"]["elapsed_s"], 600)


class TestIncompleteToolTurnTelemetry(unittest.TestCase):
    """Failure #260 must name and locate the exhausted OpenClaw recovery."""

    @staticmethod
    def _message(**fields):
        return json.dumps(fields)

    def test_replay_unsafe_chat_error_records_pipeline_context(self):
        chat_id = None

        class FakeWebSocket:
            def __init__(self, messages):
                self.messages = list(messages)
                self.sent = []

            def send(self, payload):
                nonlocal chat_id
                parsed = json.loads(payload)
                self.sent.append(parsed)
                if parsed.get("method") == "chat.send":
                    chat_id = parsed["id"]

            def recv(self):
                message = self.messages.pop(0)
                return message() if callable(message) else message

            def settimeout(self, _timeout):
                return None

            def close(self):
                return None

        def current_run_event(event, payload):
            return self._message(
                type="event",
                event=event,
                payload={"runId": chat_id, **payload},
            )

        error_message = (
            "⚠️ Agent couldn't generate a response. Note: some tool actions "
            "may have already been executed — please verify before retrying."
        )
        messages = [
            self._message(type="event", event="connect.challenge", payload={}),
            lambda: self._message(
                type="res",
                id=socket.sent[-1]["id"],
                ok=True,
                payload={},
            ),
            lambda: self._message(
                type="res",
                id=socket.sent[-1]["id"],
                ok=True,
                payload={"tools": []},
            ),
            lambda: self._message(
                type="res",
                id=socket.sent[-1]["id"],
                ok=True,
                payload={},
            ),
            lambda: self._message(
                type="res",
                id=chat_id,
                ok=True,
                payload={"runId": chat_id, "status": "started"},
            ),
            lambda: current_run_event(
                "agent",
                {
                    "stream": "lifecycle",
                    "sessionId": "openclaw-session-260",
                    "agentId": "main",
                    "data": {"phase": "start"},
                },
            ),
            lambda: current_run_event(
                "agent",
                {
                    "stream": "assistant",
                    "data": {"delta": "The"},
                },
            ),
            lambda: current_run_event(
                "agent",
                {
                    "stream": "item",
                    "data": {
                        "itemId": "tool-260",
                        "phase": "start",
                        "kind": "tool",
                        "name": "edit",
                    },
                },
            ),
            lambda: current_run_event(
                "agent",
                {
                    "stream": "item",
                    "data": {
                        "itemId": "tool-260",
                        "phase": "end",
                        "kind": "tool",
                        "name": "edit",
                        "status": "completed",
                        "output": "updated",
                    },
                },
            ),
            lambda: current_run_event(
                "chat",
                {
                    "seq": 34,
                    "state": "error",
                    "errorMessage": error_message,
                },
            ),
        ]
        socket = FakeWebSocket(messages)
        fake_websocket_module = mock.Mock()
        fake_websocket_module.create_connection.return_value = socket
        fake_websocket_module.WebSocketTimeoutException = TimeoutError
        empty_usage = {
            "input": 0,
            "output": 0,
            "cache_read": 0,
            "cache_write": 0,
            "model_calls": 0,
        }
        adapter = OpenClawAdapter()
        adapter._ready = True

        with (
            mock.patch.dict(
                sys.modules,
                {"websocket": fake_websocket_module},
            ),
            mock.patch.object(
                adapter,
                "_read_turn_usage",
                return_value=empty_usage,
            ),
            mock.patch(
                "harness_adapter.record_failure",
            ) as record_failure,
            mock.patch(
                "harness_adapter.time.time",
                return_value=100.0,
            ),
        ):
            result = adapter.process(
                "Continue a multi-tool task",
                "session-260",
                deadline_s=600,
            )

        failure = record_failure.call_args.kwargs
        context = failure["context"]
        self.assertTrue(result.failed)
        self.assertEqual(
            result.error_class,
            harness_adapter.INCOMPLETE_TOOL_TURN_ERROR_CLASS,
        )
        self.assertIn("The", result.text)
        self.assertEqual(
            failure["error_class"],
            harness_adapter.INCOMPLETE_TOOL_TURN_ERROR_CLASS,
        )
        self.assertEqual(context["phase"], "chat_event_error")
        self.assertEqual(context["run_id"], chat_id)
        self.assertEqual(context["event_sequence"], 34)
        self.assertEqual(context["response_chars"], 3)
        self.assertEqual(context["tool_call_count"], 1)
        self.assertEqual(context["active_tool_count"], 0)
        self.assertEqual(context["deadline_s"], 600)
        self.assertEqual(context["event_counts"]["event:chat"], 1)
        self.assertIn("event:agent", context["first_events"])


class TestQuestionEventEndsTurn(unittest.TestCase):
    """A clarifying question must end the turn, not hang it to the deadline.

    Google Chat is turn-based, so a question asked mid-turn can never be
    answered within that turn. Until 2026-08-05 the harness counted
    `event:question.requested` and dropped it, so the gateway blocked until the
    550s deadline — 25 dead turns across 15 users in three days, and 100% of
    ChatDeadlineExpired* rows carried this event.
    """

    @staticmethod
    def _message(**fields):
        return json.dumps(fields)

    def _run_with_question_event(self, question_payload):
        chat_id = None

        class FakeWebSocket:
            def __init__(self, messages):
                self.messages = list(messages)
                self.sent = []

            def send(self, payload):
                nonlocal chat_id
                parsed = json.loads(payload)
                self.sent.append(parsed)
                if parsed.get("method") == "chat.send":
                    chat_id = parsed["id"]

            def recv(self):
                message = self.messages.pop(0)
                return message() if callable(message) else message

            def settimeout(self, _timeout):
                return None

            def close(self):
                return None

        messages = [
            self._message(type="event", event="connect.challenge", payload={}),
            lambda: self._message(type="res", id=socket.sent[-1]["id"], ok=True, payload={}),
            lambda: self._message(type="res", id=socket.sent[-1]["id"], ok=True, payload={"tools": []}),
            lambda: self._message(type="res", id=socket.sent[-1]["id"], ok=True, payload={}),
            lambda: self._message(
                type="res", id=chat_id, ok=True,
                payload={"runId": chat_id, "status": "started"},
            ),
            lambda: self._message(
                type="event", event="agent",
                payload={
                    "runId": chat_id,
                    "stream": "assistant",
                    "data": {"delta": "Checking the roster."},
                },
            ),
            lambda: self._message(
                type="event", event="question.requested",
                payload={"runId": chat_id, **question_payload},
            ),
        ]
        socket = FakeWebSocket(messages)
        fake_websocket_module = mock.Mock()
        fake_websocket_module.create_connection.return_value = socket
        fake_websocket_module.WebSocketTimeoutException = TimeoutError
        empty_usage = {
            "input": 0, "output": 0, "cache_read": 0,
            "cache_write": 0, "model_calls": 0,
        }
        adapter = OpenClawAdapter()
        adapter._ready = True

        with (
            mock.patch.dict(sys.modules, {"websocket": fake_websocket_module}),
            mock.patch.object(adapter, "_read_turn_usage", return_value=empty_usage),
            mock.patch("harness_adapter.record_failure") as record_failure,
            mock.patch("harness_adapter.time.time", return_value=100.0),
        ):
            result = adapter.process("Which school?", "session-q", deadline_s=550)
        return result, record_failure

    def test_question_is_delivered_and_records_no_failure(self):
        result, record_failure = self._run_with_question_event(
            {"data": {"question": "Which school should I pull attendance for?"}}
        )
        self.assertFalse(result.failed)
        self.assertIn("Which school should I pull attendance for?", result.text)
        # The partial answer streamed before the question is preserved.
        self.assertIn("Checking the roster.", result.text)
        record_failure.assert_not_called()

    def test_question_text_found_at_payload_top_level(self):
        result, _ = self._run_with_question_event(
            {"question": "Confirm the school year?"}
        )
        self.assertFalse(result.failed)
        self.assertIn("Confirm the school year?", result.text)

    def test_unrecognized_question_shape_still_ends_the_turn(self):
        # Fail useful, not silent: an unknown schema must not resurrect the hang.
        result, record_failure = self._run_with_question_event({"someNewField": {}})
        self.assertFalse(result.failed)
        self.assertIn("clarify", result.text.lower())
        record_failure.assert_not_called()


class TestUpstreamRetry(unittest.TestCase):
    """A clean upstream failure is the one thing a turn can safely repeat.

    2026-08-06: Bedrock returned 5xx for ~25 minutes and cost 27 turns across
    9 users. Every one died in ~6s having executed nothing — no tool calls, no
    output. CloudWatch showed InvocationServerErrors peaking at 26/5min with
    InvocationThrottles flat at zero, so it was a server fault, not our quota.
    """

    @staticmethod
    def _result(**kw):
        defaults = dict(text="", failed=True, error_class="OpenClawChatError",
                        latency_ms=6000)
        defaults.update(kw)
        return harness_adapter.TurnResult(**defaults)

    def test_retries_a_clean_upstream_failure(self):
        self.assertTrue(
            OpenClawAdapter._should_retry_upstream(self._result())
        )

    def test_never_retries_a_turn_that_ran_tools(self):
        # The whole safety argument. A turn that created a Doc must not repeat.
        self.assertFalse(
            OpenClawAdapter._should_retry_upstream(
                self._result(tool_calls=[{"name": "docs.create"}])
            )
        )

    def test_never_retries_a_successful_turn(self):
        self.assertFalse(
            OpenClawAdapter._should_retry_upstream(
                self._result(failed=False, error_class=None)
            )
        )

    def test_leaves_classes_openclaw_already_handles_alone(self):
        # Deadlines promote to the job path, overflow restarts fresh, and an
        # incomplete tool turn is explicitly replay-unsafe.
        for cls in (
            "ChatDeadlineExpired",
            "ChatDeadlineExpiredPartial",
            "ContextOverflow",
            harness_adapter.INCOMPLETE_TOOL_TURN_ERROR_CLASS,
        ):
            self.assertFalse(
                OpenClawAdapter._should_retry_upstream(
                    self._result(error_class=cls)
                ),
                cls,
            )

    def test_does_not_retry_a_turn_that_died_late(self):
        # A late collapse is not "the model call failed" — something happened
        # during real work, so replay is not provably safe.
        self.assertFalse(
            OpenClawAdapter._should_retry_upstream(
                self._result(latency_ms=120_000)
            )
        )

    def test_process_retries_once_and_returns_the_recovery(self):
        adapter = OpenClawAdapter()
        calls = []

        def fake_once(message, session_id, model_override=None,
                      deadline_s=None, _is_nudge=False):
            calls.append(message)
            if len(calls) == 1:
                return self._result()
            return harness_adapter.TurnResult(text="recovered", failed=False)

        with mock.patch.object(adapter, "_process_once", side_effect=fake_once), \
                mock.patch.object(harness_adapter.time, "sleep"):
            result = adapter.process("chart attendance", "s1")

        self.assertEqual(len(calls), 2)
        self.assertFalse(result.failed)
        self.assertEqual(result.text, "recovered")

    def test_process_does_not_retry_when_unsafe(self):
        adapter = OpenClawAdapter()
        calls = []

        def fake_once(*_a, **_kw):
            calls.append(1)
            return self._result(tool_calls=[{"name": "write"}])

        with mock.patch.object(adapter, "_process_once", side_effect=fake_once), \
                mock.patch.object(harness_adapter.time, "sleep"):
            result = adapter.process("do work", "s1")

        self.assertEqual(len(calls), 1, "a tool-running turn must not repeat")
        self.assertTrue(result.failed)

    def test_a_second_failure_returns_the_retry_result(self):
        adapter = OpenClawAdapter()
        with mock.patch.object(
            adapter, "_process_once", side_effect=lambda *a, **k: self._result()
        ), mock.patch.object(harness_adapter.time, "sleep"):
            result = adapter.process("x", "s1")
        self.assertTrue(result.failed)
        self.assertEqual(result.error_class, "OpenClawChatError")

    def test_never_retries_a_turn_with_a_tool_still_in_flight(self):
        # The dangerous case tool_calls alone cannot see: the call STARTED,
        # may already have created the Doc, and its result event never
        # arrived — so it never landed in tool_calls at all.
        self.assertFalse(
            OpenClawAdapter._should_retry_upstream(
                self._result(tool_calls=[], tools_in_flight=1)
            )
        )

    def test_a_started_tool_with_no_result_blocks_the_retry_end_to_end(self):
        # The gate above is only real if _process_once actually populates the
        # field, so drive a real turn: a tool STARTS, never reports back, and
        # the turn then dies as a generic upstream error inside the latency
        # bound. tool_calls is empty — the old predicate would have replayed
        # it and asked the broker to run `edit` a second time.
        chat_id = None

        class FakeWebSocket:
            def __init__(self, messages):
                self.messages = list(messages)
                self.sent = []

            def send(self, payload):
                nonlocal chat_id
                parsed = json.loads(payload)
                self.sent.append(parsed)
                if parsed.get("method") == "chat.send":
                    chat_id = parsed["id"]

            def recv(self):
                message = self.messages.pop(0)
                return message() if callable(message) else message

            def settimeout(self, _timeout):
                return None

            def close(self):
                return None

        def envelope(**fields):
            return json.dumps(fields)

        def current_run_event(event, payload):
            return envelope(
                type="event",
                event=event,
                payload={"runId": chat_id, **payload},
            )

        messages = [
            envelope(type="event", event="connect.challenge", payload={}),
            lambda: envelope(type="res", id=socket.sent[-1]["id"], ok=True,
                             payload={}),
            lambda: envelope(type="res", id=socket.sent[-1]["id"], ok=True,
                             payload={"tools": []}),
            lambda: envelope(type="res", id=socket.sent[-1]["id"], ok=True,
                             payload={}),
            lambda: envelope(type="res", id=chat_id, ok=True,
                             payload={"runId": chat_id, "status": "started"}),
            # Starts, and never reports a terminal result.
            lambda: current_run_event(
                "agent",
                {
                    "stream": "item",
                    "data": {
                        "itemId": "tool-901",
                        "phase": "start",
                        "kind": "tool",
                        "name": "edit",
                    },
                },
            ),
            lambda: current_run_event(
                "chat",
                {"seq": 7, "state": "error", "errorMessage": "upstream boom"},
            ),
        ]
        socket = FakeWebSocket(messages)
        fake_websocket_module = mock.Mock()
        fake_websocket_module.create_connection.return_value = socket
        fake_websocket_module.WebSocketTimeoutException = TimeoutError
        empty_usage = {
            "input": 0,
            "output": 0,
            "cache_read": 0,
            "cache_write": 0,
            "model_calls": 0,
            "capture_complete": False,
        }
        adapter = OpenClawAdapter()
        adapter._ready = True

        with (
            mock.patch.dict(sys.modules, {"websocket": fake_websocket_module}),
            mock.patch.object(adapter, "_read_turn_usage",
                              return_value=empty_usage),
            mock.patch("harness_adapter.record_failure"),
            mock.patch("harness_adapter.time.time", return_value=100.0),
        ):
            result = adapter._process_once("edit the doc", "s1", deadline_s=600)

        self.assertEqual(result.error_class, "OpenClawChatError")
        self.assertEqual(result.tool_calls, [], "the start never completed")
        self.assertEqual(result.tools_in_flight, 1)
        self.assertFalse(OpenClawAdapter._should_retry_upstream(result))

    def test_retry_runs_inside_the_remaining_turn_budget(self):
        # A second FULL deadline would blow through the 550s ceiling that
        # reserves the rest of the Router invocation for flush + delivery.
        adapter = OpenClawAdapter()
        deadlines = []

        def fake_once(message, session_id, model_override=None,
                      deadline_s=None, _is_nudge=False):
            deadlines.append(deadline_s)
            if len(deadlines) == 1:
                return self._result()
            return harness_adapter.TurnResult(text="recovered", failed=False)

        clock = iter([0.0, 25.0])
        with mock.patch.object(adapter, "_process_once", side_effect=fake_once), \
                mock.patch.object(harness_adapter.time, "sleep"), \
                mock.patch.object(
                    harness_adapter.time, "monotonic", side_effect=lambda: next(clock)
                ):
            adapter.process("x", "s1", deadline_s=550)

        self.assertEqual(deadlines[0], 550)
        # 550 budget - 25s spent - 2s backoff.
        self.assertEqual(deadlines[1], 523)
        self.assertLess(deadlines[1], deadlines[0])

    def test_skips_the_retry_when_too_little_budget_remains(self):
        # Below the floor there is not enough turn left to be worth it — and
        # _resolve_deadline_s would clamp a smaller remainder back UP to 60,
        # turning the guard into the very overshoot it exists to prevent.
        adapter = OpenClawAdapter()
        calls = []

        def fake_once(*_a, **_kw):
            calls.append(1)
            return self._result()

        clock = iter([0.0, 45.0])
        with mock.patch.object(adapter, "_process_once", side_effect=fake_once), \
                mock.patch.object(harness_adapter.time, "sleep"), \
                mock.patch.object(
                    harness_adapter.time, "monotonic", side_effect=lambda: next(clock)
                ):
            result = adapter.process("x", "s1", deadline_s=60)

        self.assertEqual(len(calls), 1, "no budget left — must not retry")
        self.assertTrue(result.failed)


class TestRecordItemToolEvent(unittest.TestCase):
    """Native-mode tool items must land in tool_calls telemetry (#1138 r12)."""

    def test_start_then_end_records_one_call(self):
        starts, calls = {}, []
        OpenClawAdapter._record_item_tool_event(
            {"itemId": "t1", "phase": "start", "kind": "tool", "name": "exec", "meta": "run grants"},
            starts, calls,
        )
        self.assertIn("t1", starts)
        OpenClawAdapter._record_item_tool_event(
            {"itemId": "t1", "phase": "end", "kind": "tool", "status": "completed", "output": "done"},
            starts, calls,
        )
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["name"], "exec")
        self.assertEqual(calls[0]["status"], "success")
        self.assertEqual(calls[0]["result"], "done")

    def test_error_status_recorded(self):
        starts, calls = {}, []
        OpenClawAdapter._record_item_tool_event(
            {"itemId": "t2", "phase": "start", "kind": "tool", "name": "read"}, starts, calls)
        OpenClawAdapter._record_item_tool_event(
            {"itemId": "t2", "phase": "end", "kind": "tool", "status": "error", "error": "boom"},
            starts, calls,
        )
        self.assertEqual(calls[0]["status"], "error")
        self.assertEqual(calls[0]["error_text"], "boom")

    def test_end_without_start_still_records(self):
        starts, calls = {}, []
        OpenClawAdapter._record_item_tool_event(
            {"itemId": "t3", "phase": "end", "kind": "tool", "name": "write", "status": "completed"},
            starts, calls,
        )
        self.assertEqual(calls[0]["name"], "write")


class TestEmptyTurnNudge(unittest.TestCase):
    def test_nudge_text_demands_summary_without_rerunning_tools(self):
        n = OpenClawAdapter.EMPTY_TURN_NUDGE
        self.assertIn("[system-nudge]", n)
        self.assertIn("NO reply", n)
        self.assertIn("Do not", n)

    def test_no_tools_nudge_never_claims_tool_work_happened(self):
        # The tools variant opens with "finished tool work". Reusing it on a
        # turn that ran no tools would assert work that never happened and
        # invite the model to invent it (SOUL rule 4).
        n = OpenClawAdapter.EMPTY_TURN_NUDGE_NO_TOOLS
        self.assertIn("[system-nudge]", n)
        self.assertNotIn("tool work", n)
        self.assertNotIn("summary of", n)
        self.assertIn("did not actually perform", n)


class TestEmptyFinalNudgeFires(unittest.TestCase):
    """An empty final turn gets one nudge whether or not tools ran.

    Until 2026-08-09 the nudge was gated on tool_calls, so a turn that
    reached last_state=final having run nothing at all skipped straight to the
    canned fallback. Half the EmptyAgentResponse rows in prod since
    2026-08-01 are that shape (first_events=["event:chat"], no res/usage/
    lifecycle events), so they never got the recovery the tool case got.
    """

    def _drive_empty_final(self, adapter, *, with_tool, leave_in_flight=False,
                           second_tool_in_flight=False):
        """Run one turn that reaches state=final with no assistant text.

        leave_in_flight emits the tool start WITHOUT its terminal event, the
        shape where the side effect may already have happened but never got
        reported — tool_calls stays empty while tool_starts does not.

        second_tool_in_flight adds a SECOND tool (distinct itemId) that starts
        and never reports, on top of a first that completed. Both lists are
        then non-empty at once — the mixed shape neither flag alone builds,
        since they share the single "t-1" itemId.
        """
        chat_id = None

        class FakeWebSocket:
            def __init__(self, messages):
                self.messages = list(messages)
                self.sent = []

            def send(self, payload):
                nonlocal chat_id
                parsed = json.loads(payload)
                self.sent.append(parsed)
                if parsed.get("method") == "chat.send":
                    chat_id = parsed["id"]

            def recv(self):
                message = self.messages.pop(0)
                return message() if callable(message) else message

            def settimeout(self, _timeout):
                return None

            def close(self):
                return None

        def envelope(**fields):
            return json.dumps(fields)

        def current_run_event(event, payload):
            return envelope(
                type="event", event=event,
                payload={"runId": chat_id, **payload},
            )

        messages = [
            envelope(type="event", event="connect.challenge", payload={}),
            lambda: envelope(type="res", id=socket.sent[-1]["id"], ok=True,
                             payload={}),
            lambda: envelope(type="res", id=socket.sent[-1]["id"], ok=True,
                             payload={"tools": []}),
            lambda: envelope(type="res", id=socket.sent[-1]["id"], ok=True,
                             payload={}),
            lambda: envelope(type="res", id=chat_id, ok=True,
                             payload={"runId": chat_id, "status": "started"}),
        ]
        if with_tool or leave_in_flight:
            messages.append(lambda: current_run_event("agent", {
                "stream": "item",
                "data": {"itemId": "t-1", "phase": "start",
                         "kind": "tool", "name": "write"},
            }))
        if with_tool:
            messages.append(lambda: current_run_event("agent", {
                "stream": "item",
                "data": {"itemId": "t-1", "phase": "end",
                         "kind": "tool", "name": "write",
                         "status": "ok"},
            }))
        if second_tool_in_flight:
            # Starts after t-1 already reported, so t-1 has been popped off
            # tool_starts and only t-2 is left dangling at final.
            messages.append(lambda: current_run_event("agent", {
                "stream": "item",
                "data": {"itemId": "t-2", "phase": "start",
                         "kind": "tool", "name": "write"},
            }))
        # Final with no assistant text at all — the empty-turn shape.
        messages.append(lambda: current_run_event("chat", {"state": "final"}))

        socket = FakeWebSocket(messages)
        fake_websocket_module = mock.Mock()
        fake_websocket_module.create_connection.return_value = socket
        fake_websocket_module.WebSocketTimeoutException = TimeoutError
        adapter._ready = True
        return fake_websocket_module

    def _run(self, *, with_tool, is_nudge=False, nudge_reply=None,
             leave_in_flight=False, second_tool_in_flight=False):
        adapter = OpenClawAdapter()
        ws = self._drive_empty_final(
            adapter, with_tool=with_tool, leave_in_flight=leave_in_flight,
            second_tool_in_flight=second_tool_in_flight,
        )
        nudges = []
        recorded = []
        metrics = []

        def fake_process(message, *_a, **_kw):
            nudges.append(message)
            if nudge_reply is not None:
                return harness_adapter.TurnResult(
                    text=nudge_reply, failed=False
                )
            # A nudge leg that also ends empty does NOT return empty text — it
            # returns the canned fallback with error_class=EmptyAgentResponse.
            # Mocking an empty string here is an impossible shape, and it was
            # what hid the bug where the outer leg treated a failed nudge as a
            # success and never wrote its failure row.
            return harness_adapter.TurnResult(
                text="I processed your message but had no response.",
                failed=True,
                error_class="EmptyAgentResponse",
            )

        with (
            mock.patch.dict(sys.modules, {"websocket": ws}),
            mock.patch.object(adapter, "_read_turn_usage", return_value={
                "input": 0, "output": 0, "cache_read": 0,
                "cache_write": 0, "model_calls": 0,
                "capture_complete": False,
            }),
            mock.patch.object(adapter, "process", side_effect=fake_process),
            mock.patch("harness_adapter.record_failure",
                       side_effect=lambda **kw: recorded.append(kw)),
            mock.patch("harness_adapter.emit_agent_metric",
                       side_effect=lambda n, *a, **kw: metrics.append(n)),
        ):
            result = adapter._process_once(
                "hello", "s1", deadline_s=600, _is_nudge=is_nudge
            )
        return result, nudges, recorded, metrics

    def test_empty_final_without_tools_fires_the_no_tools_nudge(self):
        _result, nudges, _rec, metrics = self._run(with_tool=False)
        self.assertEqual(len(nudges), 1, "a no-tool empty turn must nudge")
        self.assertEqual(nudges[0], OpenClawAdapter.EMPTY_TURN_NUDGE_NO_TOOLS)
        # One metric per nudge, under the SAME name as the tools variant, so
        # the pre-2026-08-09 nudge-fire trend stays comparable across the
        # change instead of silently splitting into two series.
        self.assertEqual(metrics.count("AgentNudgeFired"), 1)

    def test_empty_final_with_tools_still_fires_the_tools_nudge(self):
        _result, nudges, _rec, metrics = self._run(with_tool=True)
        self.assertEqual(len(nudges), 1)
        self.assertEqual(nudges[0], OpenClawAdapter.EMPTY_TURN_NUDGE)
        self.assertEqual(metrics.count("AgentNudgeFired"), 1)

    def test_a_nudge_leg_does_not_nudge_again(self):
        # Recursion stays bounded by _is_nudge — this is the only thing
        # standing between one recovery attempt and an unbounded loop.
        _result, nudges, _rec, metrics = self._run(
            with_tool=False, is_nudge=True
        )
        self.assertEqual(nudges, [])
        self.assertEqual(metrics.count("AgentNudgeFired"), 0)

    def test_failure_row_records_whether_a_nudge_was_attempted(self):
        # Exactly one row, on the outer leg, and it must say a nudge happened.
        # Before the nudge_returned_text fix the outer leg saw the canned
        # fallback as non-empty text, returned early, and wrote NO row at all.
        _result, _nudges, recorded, _m = self._run(with_tool=False)
        self.assertEqual(len(recorded), 1, "exactly one row per user turn")
        ctx = recorded[0]["context"]
        self.assertTrue(ctx["nudge_attempted"])
        self.assertEqual(ctx["nudge_variant"], "no-tools")

    def test_nudge_leg_writes_no_row_of_its_own(self):
        # The nudge leg is an internal recovery attempt. If it recorded, the
        # turn would get two rows and the _is_nudge one would misleadingly read
        # nudge_attempted=false on the very row proving a nudge happened.
        _result, _nudges, recorded, _m = self._run(
            with_tool=False, is_nudge=True
        )
        self.assertEqual(recorded, [])

    def test_never_nudges_while_a_tool_is_still_in_flight(self):
        # The dangerous shape: "write" STARTED and its terminal event never
        # arrived, so it may already have created the file while tool_calls is
        # empty. Classifying that as no-tools would send the no-tools nudge,
        # whose wording does not forbid re-running tools — creating the file a
        # second time. Same replay-unsafety _should_retry_upstream refuses on
        # tools_in_flight. Before 2026-08-09 this case got no nudge either.
        _result, nudges, recorded, metrics = self._run(
            with_tool=False, leave_in_flight=True
        )
        self.assertEqual(nudges, [], "an in-flight tool must not be replayed")
        self.assertEqual(metrics.count("AgentNudgeFired"), 0)
        self.assertEqual(len(recorded), 1)
        ctx = recorded[0]["context"]
        self.assertFalse(ctx["nudge_attempted"])
        self.assertIsNone(ctx["nudge_variant"])
        self.assertTrue(ctx["nudge_skipped_tools_in_flight"])

    def test_completed_tool_plus_in_flight_still_gets_tools_nudge(self):
        # The mixed shape: t-1 completed, t-2 started and never reported. Both
        # tool_calls and tool_starts are non-empty, and the has_tools
        # short-circuit deliberately wins — this turn keeps the tools wording
        # rather than being silenced like the no-tools in-flight case above.
        #
        # Pinned as a DECISION, not an accident. Protection here is the
        # EMPTY_TURN_NUDGE wording ("Do not re-run any tools"), which the
        # no-tools variant cannot offer, which is why only that branch needs a
        # hard gate. Tightening this to skip on any in-flight tool would also
        # withdraw the nudge from turns that have had it since well before
        # 2026-08-09 — a behavior change beyond this fix's scope. If the
        # wording ever proves insufficient, flip the short-circuit here and
        # this test is the one that should change with it.
        _result, nudges, _rec, metrics = self._run(
            with_tool=True, second_tool_in_flight=True
        )
        # Prove the shape really is mixed before asserting on it — with_tool
        # alone lands tools_in_flight=0, so without this the test would just
        # restate test_empty_final_with_tools_still_fires_the_tools_nudge.
        self.assertEqual(len(_result.tool_calls), 1)
        self.assertEqual(_result.tools_in_flight, 1)
        self.assertEqual(nudges, [OpenClawAdapter.EMPTY_TURN_NUDGE])
        self.assertEqual(metrics.count("AgentNudgeFired"), 1)

    def test_mixed_shape_records_the_variant_that_actually_fired(self):
        # The telemetry must not report this as skipped-for-in-flight just
        # because tool_starts was non-empty; the row has to say a tools nudge
        # really went out, or the mixed shape is unreadable in prod.
        _result, _nudges, recorded, _m = self._run(
            with_tool=True, second_tool_in_flight=True
        )
        self.assertEqual(len(recorded), 1)
        ctx = recorded[0]["context"]
        self.assertTrue(ctx["nudge_attempted"])
        self.assertEqual(ctx["nudge_variant"], "tools")
        self.assertFalse(ctx["nudge_skipped_tools_in_flight"])

    def test_a_recovered_nudge_writes_no_failure_row(self):
        _result, nudges, recorded, _m = self._run(
            with_tool=False, nudge_reply="here is the answer"
        )
        self.assertEqual(len(nudges), 1)
        self.assertEqual(recorded, [], "a rescued turn is not a failure")
        self.assertEqual(_result.text, "here is the answer")


def _assistant(ts_ms, *, inp=0, out=0, cr=0, cw=0, stop="stop"):
    """One assistant transcript record in OpenClaw's on-disk JSONL shape."""
    return {
        "type": "message",
        "timestamp": "2026-07-27T14:20:19.758Z",
        "message": {
            "role": "assistant",
            "timestamp": ts_ms,
            "stopReason": stop,
            "model": "us.anthropic.claude-sonnet-5",
            "usage": {
                "input": inp, "output": out,
                "cacheRead": cr, "cacheWrite": cw,
            },
        },
    }


def _transcript_db(path, rows):
    """Build a transcript database in the pinned host's real shape.

    DDL copied from a checkpointed 2026.7.2-beta.5 `openclaw-agent.sqlite`
    (`SELECT sql FROM sqlite_master WHERE name='transcript_events'`), minus the
    FK to `session_windows` so a fixture needs only the one table. STRICT and
    the composite primary key are preserved because both constrain what the
    reader may assume.

    `rows` is an iterable of `(session_id, seq, event_json, created_at)`.
    """
    connection = sqlite3.connect(path)
    try:
        # The runtime keeps this DB in WAL mode; readers must cope with it.
        connection.execute("PRAGMA journal_mode=wal")
        connection.execute(
            "CREATE TABLE transcript_events ("
            "  session_id TEXT NOT NULL,"
            "  seq INTEGER NOT NULL,"
            "  event_json TEXT NOT NULL,"
            "  created_at INTEGER NOT NULL,"
            "  PRIMARY KEY (session_id, seq)"
            ") STRICT"
        )
        connection.executemany(
            "INSERT INTO transcript_events "
            "(session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)",
            rows,
        )
        connection.commit()
    finally:
        connection.close()


def _rows(session_id, records, *, created_at_skew_ms=0, start_seq=1):
    """Turn transcript records into `transcript_events` rows.

    `created_at` is the row's INSERT time, so it is at or after the record's own
    `message.timestamp` — verified across a real database (488 records, zero
    inversions). `created_at_skew_ms` models that lag.
    """
    rows = []
    for offset, record in enumerate(records):
        message = record.get("message") or {}
        timestamp = message.get("timestamp")
        if not isinstance(timestamp, int):
            # Undatable/ISO-only records still get a plausible insert time so
            # the created_at prefilter cannot be what excludes them.
            timestamp = 0
        rows.append((
            session_id,
            start_seq + offset,
            json.dumps(record),
            timestamp + created_at_skew_ms,
        ))
    return rows


class SqliteTranscriptUsageTests(unittest.TestCase):
    """Per-turn token usage read from `transcript_events` (2026.7.2-beta.5+).

    This is the only usage source on the post-#1384 SigV4 path: the gateway's
    WS event stream carries none. OpenClaw 2026.7.2-beta.5 migrated the
    per-session JSONL transcripts into this per-agent SQLite database and
    DELETED them, which silently zeroed input/output/cache telemetry on every
    invocation until the reader followed.
    """

    def setUp(self):
        import tempfile
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.adapter = OpenClawAdapter()
        self.adapter.WORKSPACE_DIR = self.tmp.name
        # Keep the settle loop from adding real seconds to the suite.
        self.adapter.USAGE_SETTLE_INTERVAL_S = 0
        self.agent_dir = pathlib.Path(self.tmp.name) / "agents" / "main" / "agent"
        self.agent_dir.mkdir(parents=True)
        self.db_path = self.agent_dir / "openclaw-agent.sqlite"

    def _write(self, session_uuid, records, **kwargs):
        _transcript_db(str(self.db_path), _rows(session_uuid, records, **kwargs))
        return self.db_path

    def test_sums_only_records_inside_the_turn_window(self):
        # transcript_events is append-only across the whole session, so a prior
        # turn's model calls sit in the same table. Billing them again would
        # inflate every turn by the entire session history.
        self._write("s1", [
            _assistant(1_000, inp=999, out=999),          # previous turn
            _assistant(5_000, inp=10, out=1, stop="toolUse"),
            _assistant(6_000, inp=20, out=2, cr=30, cw=40),
        ])
        usage = self.adapter._read_turn_usage("s1", "main", 5_000)
        self.assertTrue(usage["capture_complete"])
        self.assertEqual(usage["input"], 30)
        self.assertEqual(usage["output"], 3)
        self.assertEqual(usage["cache_read"], 30)
        self.assertEqual(usage["cache_write"], 40)
        self.assertEqual(usage["model_calls"], 2)

    def test_another_sessions_rows_are_never_billed_to_this_turn(self):
        # Session isolation used to be the FILENAME; it is now a WHERE clause.
        # A missing/broken session_id predicate would bill every concurrent
        # session's model calls to whichever turn read the table.
        rows = _rows("s1", [_assistant(5_000, inp=10, out=1)])
        rows += _rows("other", [_assistant(5_000, inp=7777, out=7777)])
        _transcript_db(str(self.db_path), rows)
        usage = self.adapter._read_turn_usage("s1", "main", 0)
        self.assertEqual(usage["input"], 10)
        self.assertEqual(usage["output"], 1)
        self.assertEqual(usage["model_calls"], 1)

    def test_boundary_record_at_since_ms_is_included(self):
        self._write("s1", [_assistant(5_000, inp=7, out=3)])
        self.assertEqual(
            self.adapter._read_turn_usage("s1", "main", 5_000)["input"], 7,
        )

    def test_created_at_lag_does_not_hide_an_in_window_record(self):
        # created_at is the row's INSERT time and runs AHEAD of the record's own
        # timestamp (up to ~20s observed). Because the prefilter is
        # `created_at >= since_ms` and created_at >= message.timestamp, it can
        # only ever be a superset of the real window — never narrower.
        self._write(
            "s1", [_assistant(5_000, inp=42, out=1)], created_at_skew_ms=19_941,
        )
        usage = self.adapter._read_turn_usage("s1", "main", 5_000)
        self.assertEqual(usage["input"], 42)
        self.assertEqual(usage["model_calls"], 1)

    def test_completeness_follows_seq_not_created_at(self):
        # created_at is only weakly ordered against seq (28 of 32 sessions in a
        # real database contain an inversion). `complete` is decided by the LAST
        # record, so ordering the scan by created_at would read the wrong one —
        # here it would see `toolUse` last and wrongly report the turn partial.
        rows = [
            (
                "s1", 1,
                json.dumps(_assistant(5_000, inp=10, stop="toolUse")),
                9_000,  # inserted LATE despite the lower seq
            ),
            (
                "s1", 2,
                json.dumps(_assistant(6_000, inp=20, stop="stop")),
                6_100,
            ),
        ]
        _transcript_db(str(self.db_path), rows)
        usage = self.adapter._read_turn_usage("s1", "main", 0)
        self.assertTrue(usage["capture_complete"])
        self.assertEqual(usage["input"], 30)

    def test_tool_use_stop_reason_means_the_turn_is_still_running(self):
        # `toolUse` is OpenClaw's "another model call is coming" marker; a read
        # that stops there would drop the turn's final (largest) model call.
        self._write("s1", [_assistant(5_000, inp=10, stop="toolUse")])
        _, complete = self.adapter._sum_sqlite_transcript_usage(
            str(self.db_path), "s1", 0,
        )
        self.assertFalse(complete)

        self.db_path.unlink()
        self._write("s2", [
            _assistant(5_000, inp=10, stop="toolUse"),
            _assistant(6_000, inp=20, stop="stop"),
        ])
        totals, complete = self.adapter._sum_sqlite_transcript_usage(
            str(self.db_path), "s2", 0,
        )
        self.assertTrue(complete)
        self.assertEqual(totals["input"], 30)

    def test_only_allowlisted_terminal_stop_reasons_complete_capture(self):
        cases = (
            (None, False),
            ("", False),
            ("toolUse", False),
            ("novel-terminal", False),
            ("stop", True),
            ("end_turn", True),
        )
        rows = []
        for index, (stop_reason, _expected) in enumerate(cases, start=1):
            rows += _rows(
                f"terminal-{index}",
                [_assistant(5_000, inp=10, stop=stop_reason)],
            )
        _transcript_db(str(self.db_path), rows)
        for index, (stop_reason, expected) in enumerate(cases, start=1):
            with self.subTest(stop_reason=stop_reason):
                _, complete = self.adapter._sum_sqlite_transcript_usage(
                    str(self.db_path), f"terminal-{index}", 0,
                )
                self.assertIs(complete, expected)

    def test_missing_database_and_transcript_returns_zeros_without_settling(self):
        started = time.monotonic()
        # Non-zero interval so a wrongly-taken settle path would be visible.
        self.adapter.USAGE_SETTLE_INTERVAL_S = 0.05
        usage = self.adapter._read_turn_usage("nope", "main", 0)
        self.assertFalse(usage["capture_complete"])
        self.assertEqual(usage["model_calls"], 0)
        self.assertLess(time.monotonic() - started, 0.05)

    def test_unknown_session_in_an_existing_database_reports_honest_zeros(self):
        self._write("s1", [_assistant(5_000, inp=10)])
        usage = self.adapter._read_turn_usage("absent-session", "main", 0)
        self.assertFalse(usage["capture_complete"])
        self.assertEqual(usage["model_calls"], 0)
        self.assertEqual(usage["input"], 0)

    def test_malformed_event_json_is_skipped_not_fatal(self):
        # event_json is TEXT, not JSON-validated by SQLite. A corrupt or
        # unrecognized row must not lose the records around it, and must clear
        # completeness so the settle loop re-reads.
        rows = _rows("s1", [_assistant(5_000, inp=11, out=2)])
        rows.append(("s1", 2, '{"message": {"rol', 5_100))
        _transcript_db(str(self.db_path), rows)
        usage = self.adapter._read_turn_usage("s1", "main", 0)
        self.assertFalse(usage["capture_complete"])
        self.assertEqual(usage["input"], 11)
        self.assertEqual(usage["model_calls"], 1)

    def test_non_json_and_non_object_event_json_are_ignored(self):
        rows = [
            ("s1", 1, "not json at all", 5_000),
            ("s1", 2, '"a bare string"', 5_050),
            ("s1", 3, "[1, 2, 3]", 5_060),
            ("s1", 4, "null", 5_070),
        ]
        rows += _rows("s1", [_assistant(5_100, inp=4, out=1)], start_seq=5)
        _transcript_db(str(self.db_path), rows)
        usage = self.adapter._read_turn_usage("s1", "main", 0)
        self.assertEqual(usage["model_calls"], 1)
        self.assertEqual(usage["input"], 4)

    def test_a_busy_database_degrades_to_zeros_without_raising(self):
        # A telemetry read must never break a chat turn. Hold the write lock
        # from another connection so the reader gets OperationalError, and
        # confirm the settle loop absorbs it.
        self._write("s1", [_assistant(5_000, inp=10, out=2)])
        blocker = sqlite3.connect(str(self.db_path))
        self.addCleanup(blocker.close)
        blocker.execute("PRAGMA journal_mode=delete")
        blocker.execute("BEGIN EXCLUSIVE")
        blocker.execute(
            "INSERT INTO transcript_events VALUES ('s1', 99, '{}', 1)",
        )
        usage = self.adapter._read_turn_usage("s1", "main", 0)
        self.assertFalse(usage["capture_complete"])
        self.assertEqual(usage["model_calls"], 0)

    def test_a_corrupt_database_file_does_not_retry_or_raise(self):
        # Retrying a non-SQLite file cannot help, so it must break out of the
        # settle loop rather than pay the full bounded wait on every turn.
        self.db_path.write_bytes(b"this is not a sqlite database" * 64)
        self.adapter.USAGE_SETTLE_INTERVAL_S = 0.05
        started = time.monotonic()
        usage = self.adapter._read_turn_usage("s1", "main", 0)
        self.assertFalse(usage["capture_complete"])
        self.assertEqual(usage["model_calls"], 0)
        self.assertLess(time.monotonic() - started, 0.05)

    def test_the_read_never_creates_or_writes_the_database(self):
        # mode=ro must be what opens the DB: a telemetry read may not create,
        # migrate, or mutate the runtime's own state.
        self._write("s1", [_assistant(5_000, inp=10)])
        before = self.db_path.stat().st_mtime_ns
        digest_before = self.db_path.read_bytes()
        self.adapter._read_turn_usage("s1", "main", 0)
        self.assertEqual(self.db_path.stat().st_mtime_ns, before)
        self.assertEqual(self.db_path.read_bytes(), digest_before)

    def test_a_missing_database_is_not_created_by_the_read(self):
        self.adapter._read_turn_usage("s1", "main", 0)
        self.assertFalse(self.db_path.exists())

    def test_non_assistant_and_usageless_records_ignored(self):
        self._write("s1", [
            {"type": "session", "timestamp": "2026-07-27T14:18:48.704Z"},
            {"type": "message", "message": {"role": "user", "timestamp": 5_000}},
            {"type": "message", "message": {"role": "toolResult", "timestamp": 5_100}},
            {"type": "message", "message": {"role": "assistant", "timestamp": 5_200}},
            _assistant(5_300, inp=4, out=1),
        ])
        usage = self.adapter._read_turn_usage("s1", "main", 0)
        self.assertEqual(usage["model_calls"], 1)
        self.assertEqual(usage["input"], 4)

    def test_iso_timestamp_used_when_message_timestamp_absent(self):
        record = _assistant(0, inp=5)
        del record["message"]["timestamp"]
        record["timestamp"] = "2026-07-27T14:20:19.758Z"
        since = int(
            datetime(2026, 7, 27, 14, 0, tzinfo=timezone.utc).timestamp() * 1000
        )
        # created_at must not be what admits the row — set it at the window edge.
        _transcript_db(
            str(self.db_path), [("s1", 1, json.dumps(record), since)],
        )
        self.assertEqual(
            self.adapter._read_turn_usage("s1", "main", since)["input"], 5,
        )

    def test_undatable_record_is_not_attributed_to_this_turn(self):
        record = _assistant(0, inp=5)
        del record["message"]["timestamp"]
        del record["timestamp"]
        _transcript_db(str(self.db_path), [("s1", 1, json.dumps(record), 5_000)])
        self.assertEqual(
            self.adapter._read_turn_usage("s1", "main", 0)["model_calls"], 0,
        )

    def test_session_and_agent_ids_are_path_constrained(self):
        # agentId is still a path component, and sessionId is still a path
        # component on the JSONL fallback, so both stay untrusted input.
        outside_dir = pathlib.Path(self.tmp.name) / "agent"
        outside_dir.mkdir(parents=True, exist_ok=True)
        _transcript_db(
            str(outside_dir / "openclaw-agent.sqlite"),
            _rows("s1", [_assistant(5_000, inp=123)]),
        )
        for sid, aid in (
            ("../../escaped", "main"),
            ("s1", "../.."),
            ("s1/../../escaped", "main"),
        ):
            self.assertEqual(
                self.adapter._read_turn_usage(sid, aid, 0)["input"], 0,
                f"unsafe ids must not read a database: {sid!r} {aid!r}",
            )

    def test_dot_dot_agent_id_cannot_climb_out_of_the_agent_directory(self):
        # `.` is a legal id character, so ".." satisfies the charset regex —
        # the one traversal a slash-free component can still perform. Plant a
        # READABLE database at exactly the path it would reach
        # (<workspace>/agents/../agent/ == <workspace>/agent/) so this fails
        # loudly if the guard regresses, instead of passing because the file
        # merely happened not to exist.
        sibling = pathlib.Path(self.tmp.name) / "agent"
        sibling.mkdir(parents=True, exist_ok=True)
        _transcript_db(
            str(sibling / "openclaw-agent.sqlite"),
            _rows("s1", [_assistant(5_000, inp=4242)]),
        )
        for aid in ("..", "."):
            usage = self.adapter._read_turn_usage("s1", aid, 0)
            self.assertEqual(
                usage["input"], 0, f"agentId={aid!r} must not read a database",
            )
            self.assertEqual(usage["model_calls"], 0)

    def test_symlinked_database_is_rejected_by_containment(self):
        # realpath containment also covers a database symlinked in from
        # elsewhere in the workspace.
        outside = pathlib.Path(self.tmp.name) / "elsewhere.sqlite"
        _transcript_db(str(outside), _rows("s1", [_assistant(5_000, inp=99)]))
        self.db_path.symlink_to(outside)
        self.assertEqual(
            self.adapter._read_turn_usage("s1", "main", 0)["input"], 0,
        )

    def test_agent_id_defaults_to_main(self):
        self._write("s1", [_assistant(5_000, inp=9)])
        self.assertEqual(
            self.adapter._read_turn_usage("s1", None, 0)["input"], 9,
        )

    def test_missing_session_id_is_a_no_op(self):
        self._write("s1", [_assistant(5_000, inp=9)])
        self.assertEqual(
            self.adapter._read_turn_usage(None, "main", 0)["model_calls"], 0,
        )

    def test_negative_and_non_int_usage_values_ignored(self):
        record = _assistant(5_000, inp=10, out=5)
        record["message"]["usage"]["cacheRead"] = -100
        record["message"]["usage"]["cacheWrite"] = "lots"
        self._write("s1", [record])
        usage = self.adapter._read_turn_usage("s1", "main", 0)
        self.assertEqual(usage["cache_read"], 0)
        self.assertEqual(usage["cache_write"], 0)
        self.assertEqual(usage["input"], 10)

    def test_boolean_usage_values_are_not_counted_as_tokens(self):
        # bool is an int subclass in Python; a JSON `true` must not add 1 token.
        record = _assistant(5_000, inp=10)
        record["message"]["usage"]["output"] = True
        self._write("s1", [record])
        self.assertEqual(
            self.adapter._read_turn_usage("s1", "main", 0)["output"], 0,
        )

    def test_the_database_wins_when_a_legacy_jsonl_also_exists(self):
        # A host migrated in place can have both. The database is authoritative;
        # the archived JSONL would double-bill the same model calls.
        sessions = pathlib.Path(self.tmp.name) / "agents" / "main" / "sessions"
        sessions.mkdir(parents=True)
        (sessions / "s1.jsonl").write_text(
            json.dumps(_assistant(5_000, inp=5555)) + "\n", encoding="utf-8",
        )
        self._write("s1", [_assistant(5_000, inp=10, out=2)])
        usage = self.adapter._read_turn_usage("s1", "main", 0)
        self.assertEqual(usage["input"], 10)
        self.assertEqual(usage["model_calls"], 1)


class TranscriptUsageJsonlFallbackTests(unittest.TestCase):
    """Legacy per-session JSONL transcripts (hosts before 2026.7.2-beta.5).

    Read only when the per-agent SQLite database is absent, so an older pinned
    host — or a candidate image on an older base — still reports real usage
    instead of silently regressing to zeros.
    """

    def setUp(self):
        import tempfile
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.adapter = OpenClawAdapter()
        self.adapter.WORKSPACE_DIR = self.tmp.name
        # Keep the settle loop from adding real seconds to the suite.
        self.adapter.USAGE_SETTLE_INTERVAL_S = 0
        self.sessions = pathlib.Path(self.tmp.name) / "agents" / "main" / "sessions"
        self.sessions.mkdir(parents=True)

    def _write(self, session_uuid, records):
        path = self.sessions / f"{session_uuid}.jsonl"
        path.write_text(
            "".join(json.dumps(r) + "\n" for r in records), encoding="utf-8",
        )
        return path

    def test_sums_only_records_inside_the_turn_window(self):
        # The transcript is append-only across the whole session, so a prior
        # turn's model calls sit in the same file. Billing them again would
        # inflate every turn by the entire session history.
        self._write("s1", [
            _assistant(1_000, inp=999, out=999),          # previous turn
            _assistant(5_000, inp=10, out=1, stop="toolUse"),
            _assistant(6_000, inp=20, out=2, cr=30, cw=40),
        ])
        usage = self.adapter._read_turn_usage("s1", "main", 5_000)
        self.assertTrue(usage["capture_complete"])
        self.assertEqual(usage["input"], 30)
        self.assertEqual(usage["output"], 3)
        self.assertEqual(usage["cache_read"], 30)
        self.assertEqual(usage["cache_write"], 40)
        self.assertEqual(usage["model_calls"], 2)

    def test_boundary_record_at_since_ms_is_included(self):
        self._write("s1", [_assistant(5_000, inp=7, out=3)])
        self.assertEqual(
            self.adapter._read_turn_usage("s1", "main", 5_000)["input"], 7,
        )

    def test_tool_use_stop_reason_means_the_turn_is_still_running(self):
        # `toolUse` is OpenClaw's "another model call is coming" marker; a read
        # that stops there would drop the turn's final (largest) model call.
        path = self._write("s1", [_assistant(5_000, inp=10, stop="toolUse")])
        _, complete = self.adapter._sum_transcript_usage(str(path), 0)
        self.assertFalse(complete)

        path = self._write("s2", [
            _assistant(5_000, inp=10, stop="toolUse"),
            _assistant(6_000, inp=20, stop="stop"),
        ])
        totals, complete = self.adapter._sum_transcript_usage(str(path), 0)
        self.assertTrue(complete)
        self.assertEqual(totals["input"], 30)

    def test_only_allowlisted_terminal_stop_reasons_complete_capture(self):
        cases = (
            (None, False),
            ("", False),
            ("toolUse", False),
            ("novel-terminal", False),
            ("stop", True),
            ("end_turn", True),
        )
        for index, (stop_reason, expected) in enumerate(cases, start=1):
            with self.subTest(stop_reason=stop_reason):
                path = self._write(
                    f"terminal-{index}",
                    [_assistant(5_000, inp=10, stop=stop_reason)],
                )
                _, complete = self.adapter._sum_transcript_usage(str(path), 0)
                self.assertIs(complete, expected)

    def test_missing_transcript_returns_zeros_without_settling(self):
        started = time.monotonic()
        # Non-zero interval so a wrongly-taken settle path would be visible.
        self.adapter.USAGE_SETTLE_INTERVAL_S = 0.05
        usage = self.adapter._read_turn_usage("nope", "main", 0)
        self.assertFalse(usage["capture_complete"])
        self.assertEqual(usage["model_calls"], 0)
        self.assertLess(time.monotonic() - started, 0.05)

    def test_torn_final_line_is_skipped_not_fatal(self):
        # We read while the runtime may be mid-append; a half-written line must
        # not lose the records before it.
        path = self.sessions / "s1.jsonl"
        path.write_text(
            json.dumps(_assistant(5_000, inp=11, out=2)) + "\n{\"message\": {\"rol",
            encoding="utf-8",
        )
        usage = self.adapter._read_turn_usage("s1", "main", 0)
        self.assertFalse(usage["capture_complete"])
        self.assertEqual(usage["input"], 11)
        self.assertEqual(usage["model_calls"], 1)

    def test_non_assistant_and_usageless_records_ignored(self):
        self._write("s1", [
            {"type": "session", "timestamp": "2026-07-27T14:18:48.704Z"},
            {"type": "message", "message": {"role": "user", "timestamp": 5_000}},
            {"type": "message", "message": {"role": "toolResult", "timestamp": 5_100}},
            {"type": "message", "message": {"role": "assistant", "timestamp": 5_200}},
            _assistant(5_300, inp=4, out=1),
        ])
        usage = self.adapter._read_turn_usage("s1", "main", 0)
        self.assertEqual(usage["model_calls"], 1)
        self.assertEqual(usage["input"], 4)

    def test_iso_timestamp_used_when_message_timestamp_absent(self):
        record = _assistant(0, inp=5)
        del record["message"]["timestamp"]
        record["timestamp"] = "2026-07-27T14:20:19.758Z"
        self._write("s1", [record])
        since = int(
            datetime(2026, 7, 27, 14, 0, tzinfo=timezone.utc).timestamp() * 1000
        )
        self.assertEqual(
            self.adapter._read_turn_usage("s1", "main", since)["input"], 5,
        )

    def test_undatable_record_is_not_attributed_to_this_turn(self):
        record = _assistant(0, inp=5)
        del record["message"]["timestamp"]
        del record["timestamp"]
        self._write("s1", [record])
        self.assertEqual(
            self.adapter._read_turn_usage("s1", "main", 0)["model_calls"], 0,
        )

    def test_session_and_agent_ids_are_path_constrained(self):
        # These ids arrive on the gateway event stream, so they are untrusted
        # input to a filesystem path.
        outside = pathlib.Path(self.tmp.name) / "escaped.jsonl"
        outside.write_text(
            json.dumps(_assistant(5_000, inp=123)) + "\n", encoding="utf-8",
        )
        for sid, aid in (
            ("../../escaped", "main"),
            ("s1", "../.."),
            ("s1/../../escaped", "main"),
        ):
            self.assertEqual(
                self.adapter._read_turn_usage(sid, aid, 0)["input"], 0,
                f"unsafe ids must not read a file: {sid!r} {aid!r}",
            )

    def test_dot_dot_agent_id_cannot_climb_out_of_the_agent_directory(self):
        # `.` is a legal id character, so ".." satisfies the charset regex —
        # the one traversal a slash-free component can still perform. Plant a
        # READABLE transcript at exactly the path it would reach
        # (<workspace>/agents/../sessions/ == <workspace>/sessions/) so this
        # fails loudly if the guard regresses, instead of passing because the
        # file merely happened not to exist.
        sibling = pathlib.Path(self.tmp.name) / "sessions"
        sibling.mkdir(parents=True, exist_ok=True)
        (sibling / "s1.jsonl").write_text(
            json.dumps(_assistant(5_000, inp=4242)) + "\n", encoding="utf-8",
        )
        for aid in ("..", "."):
            usage = self.adapter._read_turn_usage("s1", aid, 0)
            self.assertEqual(
                usage["input"], 0, f"agentId={aid!r} must not read a transcript",
            )
            self.assertEqual(usage["model_calls"], 0)

    def test_symlinked_transcript_is_rejected_by_containment(self):
        # realpath containment also covers a transcript symlinked in from
        # elsewhere in the workspace.
        outside = pathlib.Path(self.tmp.name) / "elsewhere.jsonl"
        outside.write_text(
            json.dumps(_assistant(5_000, inp=99)) + "\n", encoding="utf-8",
        )
        (self.sessions / "linked.jsonl").symlink_to(outside)
        self.assertEqual(
            self.adapter._read_turn_usage("linked", "main", 0)["input"], 0,
        )

    def test_dot_names_rejected_by_the_component_check(self):
        self.assertFalse(harness_adapter._is_safe_path_component(".."))
        self.assertFalse(harness_adapter._is_safe_path_component("."))
        self.assertFalse(harness_adapter._is_safe_path_component("a/b"))
        self.assertFalse(harness_adapter._is_safe_path_component(""))
        # Dots remain legal INSIDE an id — only the dot-only names are banned.
        self.assertTrue(harness_adapter._is_safe_path_component("..a"))
        self.assertTrue(harness_adapter._is_safe_path_component("fc4b475b-65d9"))
        self.assertTrue(harness_adapter._is_safe_path_component("main.v2"))

    def test_missing_session_id_is_a_no_op(self):
        self.assertEqual(
            self.adapter._read_turn_usage(None, "main", 0)["model_calls"], 0,
        )

    def test_agent_id_defaults_to_main(self):
        self._write("s1", [_assistant(5_000, inp=9)])
        self.assertEqual(
            self.adapter._read_turn_usage("s1", None, 0)["input"], 9,
        )

    def test_negative_and_non_int_usage_values_ignored(self):
        record = _assistant(5_000, inp=10, out=5)
        record["message"]["usage"]["cacheRead"] = -100
        record["message"]["usage"]["cacheWrite"] = "lots"
        self._write("s1", [record])
        usage = self.adapter._read_turn_usage("s1", "main", 0)
        self.assertEqual(usage["cache_read"], 0)
        self.assertEqual(usage["cache_write"], 0)
        self.assertEqual(usage["input"], 10)


class TurnResultCacheFieldTests(unittest.TestCase):
    def test_cache_fields_default_to_zero(self):
        # The wrapper reads result.cache_read/.cache_write unconditionally on
        # the non-proxy path; a missing default would be an AttributeError on
        # every turn.
        from harness_adapter import TurnResult
        result = TurnResult(text="hi")
        self.assertEqual(result.cache_read, 0)
        self.assertEqual(result.cache_write, 0)
        self.assertFalse(result.usage_capture_complete)


class ChatErrorClassificationTests(unittest.TestCase):
    """Recoverable and replay-unsafe failures must not look like crashes.

    Every chat-channel error used to arrive as the same OpenClawChatError, with
    the distinguishing detail buried in free text. That conflation is why the
    prod Morning Dispatch could not be recovered on 2026-07-27: an overflow —
    which is fixable by starting a fresh session — looked exactly like a fault
    that must not be auto-retried.

    Downstream, agent-cron promotes ContextOverflow into a background RESTART
    and leaves OpenClawChatError alone. Misclassifying in either direction is
    costly: a missed overflow fails the task silently every morning, and an
    over-eager match hands real crashes a two-hour retry budget.
    """

    def test_recognizes_the_message_prod_actually_emitted(self):
        # Verbatim from the 2026-07-27 prod failure.
        message = (
            "Context overflow: prompt too large for the model. Try /reset "
            "(or /new) to start a fresh session, or use a larger-context model."
        )
        self.assertEqual(
            harness_adapter._classify_chat_error(message),
            harness_adapter.CONTEXT_OVERFLOW_ERROR_CLASS,
        )

    def test_matches_either_stable_phrase_case_insensitively(self):
        for message in (
            "Context overflow",
            "context overflow (mid-turn precheck)",
            "prompt too large for the model",
            "PROMPT TOO LARGE",
        ):
            self.assertEqual(
                harness_adapter._classify_chat_error(message),
                harness_adapter.CONTEXT_OVERFLOW_ERROR_CLASS,
                f"should classify as overflow: {message!r}",
            )

    def test_recognizes_the_replay_unsafe_message_from_failure_260(self):
        message = (
            "⚠️ Agent couldn't generate a response. Note: some tool actions "
            "may have already been executed — please verify before retrying."
        )
        self.assertEqual(
            harness_adapter._classify_chat_error(message),
            harness_adapter.INCOMPLETE_TOOL_TURN_ERROR_CLASS,
        )

    def test_does_not_treat_a_side_effect_free_generic_error_as_tool_turn(self):
        self.assertEqual(
            harness_adapter._classify_chat_error(
                "Agent couldn't generate a response. Please try again."
            ),
            "OpenClawChatError",
        )

    def test_leaves_every_other_failure_generic(self):
        # These MUST NOT become promotable — each is a real fault where an
        # automatic two-hour retry is the wrong answer.
        for message in (
            "reply session initialization conflicted",
            "websocket closed unexpectedly",
            "tool_search_code timed out",
            "AccessDeniedException calling InvokeModel",
            "",
        ):
            self.assertEqual(
                harness_adapter._classify_chat_error(message),
                "OpenClawChatError",
                f"should stay generic: {message!r}",
            )

    def test_degrades_to_generic_rather_than_raising(self):
        # A None/odd message must not take down error handling itself — this
        # runs on the failure path, where raising would mask the real error.
        self.assertEqual(
            harness_adapter._classify_chat_error(None),
            "OpenClawChatError",
        )

    def test_class_name_matches_the_typescript_consumer(self):
        # agent-cron/job-promotion.ts keys promotion off this exact literal.
        # A rename here silently stops every scheduled restart.
        self.assertEqual(
            harness_adapter.CONTEXT_OVERFLOW_ERROR_CLASS, "ContextOverflow"
        )
        self.assertEqual(
            harness_adapter.INCOMPLETE_TOOL_TURN_ERROR_CLASS,
            "OpenClawIncompleteToolTurn",
        )


class TestFailedPartialNamesSideEffects(unittest.TestCase):
    """Name the side effects instead of the vague "some steps may have run".

    A principal told only that something *may* have happened cannot tell whether
    a doc was created, an event booked, or nothing at all. The harness records
    every completed tool call, so it can say which (agent_failures: 11 rows /
    7 users got the vague form).
    """

    def test_names_the_tools_that_completed(self):
        text = harness_adapter._frame_failed_partial(
            "",
            [
                {"name": "docs.create", "status": "success"},
                {"name": "drive.share", "status": "error"},
            ],
        )
        self.assertIn("docs.create", text)
        self.assertIn("drive.share", text)
        self.assertIn("check those before retrying", text)

    def test_says_retry_is_safe_when_nothing_ran(self):
        text = harness_adapter._frame_failed_partial("", [])
        self.assertIn("safe to retry", text)
        # Must not also tell them to go check — that was contradictory.
        self.assertNotIn("check before retrying", text)

    def test_a_tool_still_in_flight_is_never_safe_to_retry(self):
        # The dangerous case, not the safe one: the request may have reached the
        # broker and created the Doc before the turn died, with its result event
        # simply never arriving. Started calls live in tool_starts and never
        # appear in tool_calls, so this is exactly how an interrupted side effect
        # could otherwise leave the list empty and claim a safe retry.
        text = harness_adapter._frame_failed_partial(
            "", [], {"t1": {"name": "docs.create", "started_at": 0}}
        )
        self.assertNotIn("safe to retry", text)
        self.assertIn("docs.create", text)
        self.assertIn("may or may not have completed", text)

    def test_in_flight_reported_alongside_completed_tools(self):
        text = harness_adapter._frame_failed_partial(
            "",
            [{"name": "psd-data.query", "status": "success"}],
            {"t1": {"name": "drive.share", "started_at": 0}},
        )
        self.assertIn("psd-data.query", text)
        self.assertIn("drive.share", text)
        self.assertNotIn("safe to retry", text)

    def test_an_unnamed_in_flight_call_still_blocks_the_safe_claim(self):
        text = harness_adapter._frame_failed_partial(
            "", [], {"t1": {"started_at": 0}}
        )
        self.assertNotIn("safe to retry", text)
        self.assertIn("may have already run", text)

    def test_safe_to_retry_needs_both_lists_empty(self):
        text = harness_adapter._frame_failed_partial("", [], {})
        self.assertIn("safe to retry", text)

    def test_an_unrecognized_terminal_status_still_counts_as_run(self):
        # The legacy tool_result stream does not normalize `status`, so a real
        # completion can arrive as "completed"/"ok". Treating that as "did not
        # run" would claim a safe retry after a Doc was already created.
        text = harness_adapter._frame_failed_partial(
            "", [{"name": "docs.create", "status": "completed"}]
        )
        self.assertIn("docs.create", text)
        self.assertNotIn("safe to retry", text)

    def test_an_unreadable_record_suppresses_the_safe_retry_claim(self):
        for calls in (
            [{"status": "success"}],           # terminal, but no usable name
            [{"name": "unknown", "status": "success"}],
            ["not-a-dict"],
        ):
            text = harness_adapter._frame_failed_partial("", calls)
            self.assertNotIn("safe to retry", text, calls)
            self.assertIn("may have already run", text, calls)

    def test_named_and_unreadable_together_flags_the_uncertainty(self):
        text = harness_adapter._frame_failed_partial(
            "",
            [
                {"name": "docs.create", "status": "success"},
                {"status": "success"},
            ],
        )
        self.assertIn("docs.create", text)
        self.assertIn("possibly others", text)

    def test_dedupes_and_caps_a_long_tool_list(self):
        calls = [{"name": f"tool{i}", "status": "success"} for i in range(9)]
        calls += [{"name": "tool0", "status": "success"}]  # duplicate
        text = harness_adapter._frame_failed_partial("", calls)
        self.assertIn("+4 more", text)
        self.assertEqual(text.count("tool0"), 1)

    def test_preserves_the_partial_answer(self):
        text = harness_adapter._frame_failed_partial(
            "Here is what I found", [{"name": "psd-data.query", "status": "success"}]
        )
        self.assertIn("Here is what I found", text)
        self.assertIn("psd-data.query", text)

    def test_unknown_shape_keeps_the_conservative_warning(self):
        text = harness_adapter._frame_failed_partial("", None)
        self.assertIn("may have already run", text)


if __name__ == "__main__":
    unittest.main()
