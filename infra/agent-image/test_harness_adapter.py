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
