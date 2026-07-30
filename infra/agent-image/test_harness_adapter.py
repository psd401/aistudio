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
    def test_defaults_to_proven_baseline_gateway_identity(self):
        self.assertEqual(
            OpenClawAdapter.CLIENT_INFO,
            {
                "id": "openclaw-tui",
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

    def test_boundary_after_tool_activity_inserts_blank_line(self):
        a = self.acc("Now let's find recordings from 7/1 in Plaud.", "Good, done.", False, True)
        self.assertEqual(
            a, "Now let's find recordings from 7/1 in Plaud.\n\nGood, done."
        )

    def test_replace_resets_buffer_regardless_of_boundary(self):
        self.assertEqual(self.acc("old text", "fresh", True, True), "fresh")

    def test_boundary_with_empty_accum_adds_no_leading_separator(self):
        self.assertEqual(self.acc("", "First words", False, True), "First words")


class TestResolveDeadline(unittest.TestCase):
    """Turn-deadline resolution incl. the async-job override (#1138)."""

    resolve = staticmethod(OpenClawAdapter._resolve_deadline_s)

    def test_no_override_defaults_to_840(self):
        self.assertEqual(self.resolve(None), 840)

    def test_job_override_passes_within_ceiling(self):
        self.assertEqual(self.resolve(7200), 7200)
        self.assertEqual(self.resolve(3600), 3600)

    def test_job_override_clamps_to_bounds(self):
        self.assertEqual(self.resolve(50000), 7200)
        self.assertEqual(self.resolve(5), 60)

    def test_garbage_override_degrades_to_default(self):
        self.assertEqual(self.resolve("not-a-number"), 840)

    def test_env_path_still_clamped_to_840(self):
        import os
        from unittest import mock
        with mock.patch.dict(os.environ, {"OPENCLAW_CHAT_DEADLINE_S": "7200"}):
            self.assertEqual(self.resolve(None), 840)


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


class TranscriptUsageTests(unittest.TestCase):
    """Per-turn token usage read back from the OpenClaw session transcript.

    This is the only usage source on the post-#1384 SigV4 path: the gateway's
    WS event stream carries none, so before this the wrapper logged
    tokens_in=0 tokens_out=0 on every single invocation.
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


if __name__ == "__main__":
    unittest.main()
