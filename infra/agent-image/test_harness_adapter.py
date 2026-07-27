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


class GatewayTokenTests(unittest.TestCase):
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
        with mock.patch.object(harness_adapter.subprocess, "Popen") as popen, \
                mock.patch.object(harness_adapter.OpenClawAdapter, "_wait_for_ready"), \
                mock.patch.object(harness_adapter.time, "sleep"):
            a.configure({"gateway_port": 3100})

        popen.assert_called_once()
        argv = popen.call_args[0][0]
        self.assertIn("--token", argv)
        token_value = argv[argv.index("--token") + 1]
        self.assertEqual(token_value, a._gateway_token)
        self.assertNotEqual(token_value, OLD_LITERAL)


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

    def test_missing_transcript_returns_zeros_without_settling(self):
        started = time.monotonic()
        # Non-zero interval so a wrongly-taken settle path would be visible.
        self.adapter.USAGE_SETTLE_INTERVAL_S = 0.05
        usage = self.adapter._read_turn_usage("nope", "main", 0)
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


if __name__ == "__main__":
    unittest.main()
