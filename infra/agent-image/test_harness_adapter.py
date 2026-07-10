"""Unit tests for harness_adapter text extraction + failed-turn framing.

Covers issue #1138 F4:
  - _extract_text joins distinct text blocks with a blank line (no more
    "...in Plaud.Good, done." run-ons).
  - _frame_failed_partial never presents scratchpad narration as a clean
    answer.

Run: python3 -m unittest test_harness_adapter (from infra/agent-image).
"""

import unittest

from harness_adapter import OpenClawAdapter, _frame_failed_partial

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


if __name__ == "__main__":
    unittest.main()


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
