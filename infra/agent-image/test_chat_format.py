"""Unit tests for chat_format."""

import json
import unittest

from chat_format import (
    RICH_ENVELOPE_CLOSE,
    RICH_ENVELOPE_OPEN,
    extract_rich_envelope,
    markdown_to_chat,
)


class TestMarkdownToChat(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(markdown_to_chat(""), "")
        self.assertEqual(markdown_to_chat(None), None)

    def test_double_asterisk_bold(self):
        self.assertEqual(markdown_to_chat("**hello**"), "*hello*")
        self.assertEqual(
            markdown_to_chat("a **b** c **d** e"),
            "a *b* c *d* e",
        )

    def test_single_asterisk_already_bold(self):
        # Single-asterisk is already Chat-correct; leave it alone.
        self.assertEqual(markdown_to_chat("*already bold*"), "*already bold*")

    def test_h1_h2_h3(self):
        self.assertEqual(markdown_to_chat("# Title"), "*Title*")
        self.assertEqual(markdown_to_chat("## Section"), "*Section*")
        self.assertEqual(markdown_to_chat("### Subsection"), "*Subsection*")

    def test_header_with_trailing_hashes(self):
        self.assertEqual(markdown_to_chat("## Section ##"), "*Section*")

    def test_header_with_inline_bold(self):
        self.assertEqual(
            markdown_to_chat("## **Important** notice"),
            "**Important* notice*",
        )
        # ^ Header wraps the whole line in *...*; inner ** becomes single *.
        # Result is technically Chat-renderable: the outer pair bolds the line
        # and the inner pair becomes literal asterisks. Acceptable trade.

    def test_bullets(self):
        md = "- one\n- two\n- three"
        self.assertEqual(markdown_to_chat(md), "• one\n• two\n• three")

    def test_bullets_with_asterisk_marker(self):
        md = "* alpha\n* beta"
        self.assertEqual(markdown_to_chat(md), "• alpha\n• beta")

    def test_bullets_with_plus_marker(self):
        md = "+ x\n+ y"
        self.assertEqual(markdown_to_chat(md), "• x\n• y")

    def test_indented_bullets(self):
        md = "- top\n  - nested\n    - deep"
        self.assertEqual(
            markdown_to_chat(md),
            "• top\n  • nested\n    • deep",
        )

    def test_numbered_list(self):
        md = "1. first\n2. second\n3. third"
        # Numbered lists pass through (Chat renders them OK).
        self.assertEqual(markdown_to_chat(md), "1. first\n2. second\n3. third")

    def test_markdown_link(self):
        self.assertEqual(
            markdown_to_chat("Click [here](https://x.com) now"),
            "Click <https://x.com|here> now",
        )

    def test_image_syntax_left_alone(self):
        # ![alt](url) is image syntax; we only convert link syntax.
        self.assertEqual(
            markdown_to_chat("![logo](https://x.com/img.png)"),
            "![logo](https://x.com/img.png)",
        )

    def test_horizontal_rule_dropped(self):
        md = "before\n---\nafter"
        self.assertEqual(markdown_to_chat(md), "before\nafter")

    def test_table(self):
        md = "| Col A | Col B |\n| --- | --- |\n| a1 | b1 |\n| a2 | b2 |"
        self.assertEqual(
            markdown_to_chat(md),
            "Col A | Col B\na1 | b1\na2 | b2",
        )

    def test_fenced_code_passes_through(self):
        md = "```python\n# this is a comment, not a header\n**not bold**\n```"
        self.assertEqual(markdown_to_chat(md), md)

    def test_inline_code_preserved(self):
        md = "Use the `**bold**` syntax in `[link](x)` for refs."
        self.assertEqual(
            markdown_to_chat(md),
            "Use the `**bold**` syntax in `[link](x)` for refs.",
        )

    def test_inline_code_alongside_real_markdown(self):
        md = "Set **mode** to `**production**` and click [go](https://x)."
        self.assertEqual(
            markdown_to_chat(md),
            "Set *mode* to `**production**` and click <https://x|go>.",
        )

    def test_realistic_calendar_response(self):
        md = (
            "## Monday 4/27\n"
            "- 8:00 AM | **AI Strategy Retreat** @ Swift Water\n"
            "- 2:45 PM | Banner Celebration\n"
            "\n"
            "## Tuesday 4/28\n"
            "- Flight to [Chicago](https://flights.example/AS538)\n"
        )
        expected = (
            "*Monday 4/27*\n"
            "• 8:00 AM | *AI Strategy Retreat* @ Swift Water\n"
            "• 2:45 PM | Banner Celebration\n"
            "\n"
            "*Tuesday 4/28*\n"
            "• Flight to <https://flights.example/AS538|Chicago>\n"
        )
        self.assertEqual(markdown_to_chat(md), expected)

    def test_triple_asterisk_left_alone(self):
        # Bold+italic ***x*** isn't a Chat primitive. Leaving it produces
        # mostly-readable literal asterisks; perfect handling isn't required.
        result = markdown_to_chat("***emphasis***")
        # Should not crash; should not mangle into something unreadable.
        self.assertIn("emphasis", result)

    def test_idempotent_on_chat_native(self):
        chat_native = "*bold* and _italic_ and ~strike~ and `code`"
        self.assertEqual(markdown_to_chat(chat_native), chat_native)

    def test_url_only_line_strips_surrounding_asterisks(self):
        # Incident 2026-04-27: LLM wrapped consent URLs in `**...**`, which
        # collided with Google Chat's auto-link parsing and corrupted the JWT
        # signature. URL-only lines must be emitted bare.
        self.assertEqual(
            markdown_to_chat("**https://aistudio.psd401.ai/agent-connect?token=eyJ.eyJ.sig**"),
            "https://aistudio.psd401.ai/agent-connect?token=eyJ.eyJ.sig",
        )
        self.assertEqual(
            markdown_to_chat("*https://example.com/x*"),
            "https://example.com/x",
        )

    def test_url_only_line_preserves_chat_hyperlink(self):
        # Pre-formatted <url|label> from psd-workspace must survive untouched
        # even if the LLM wraps it in bold.
        self.assertEqual(
            markdown_to_chat("**<https://aistudio.psd401.ai/agent-connect?token=abc|Authorize>**"),
            "<https://aistudio.psd401.ai/agent-connect?token=abc|Authorize>",
        )

    def test_url_inline_left_alone(self):
        # When the URL is mid-sentence (not on its own line), the URL-line
        # rule must not fire — bold around inline URLs is still converted to
        # single-asterisk italic.
        self.assertEqual(
            markdown_to_chat("Click **https://example.com** to continue"),
            "Click *https://example.com* to continue",
        )


def _wrap(payload: dict) -> str:
    return f"{RICH_ENVELOPE_OPEN}\n{json.dumps(payload)}\n{RICH_ENVELOPE_CLOSE}"


class TestExtractRichEnvelope(unittest.TestCase):
    def test_empty_input(self):
        self.assertEqual(extract_rich_envelope(""), (None, ""))
        self.assertEqual(extract_rich_envelope(None), (None, None))

    def test_no_envelope_passes_through(self):
        text = "Just a plain reply, nothing fancy."
        env, remaining = extract_rich_envelope(text)
        self.assertIsNone(env)
        self.assertEqual(remaining, text)

    def test_envelope_only(self):
        payload = {"cardsV2": [{"cardId": "x", "card": {"header": {"title": "Hi"}}}]}
        text = _wrap(payload)
        env, remaining = extract_rich_envelope(text)
        self.assertEqual(env, payload)
        self.assertEqual(remaining, "")

    def test_envelope_with_prose(self):
        payload = {"cardsV2": [{"cardId": "x"}]}
        text = "Here is your brief:\n" + _wrap(payload) + "\nLet me know if you need more."
        env, remaining = extract_rich_envelope(text)
        self.assertEqual(env, payload)
        self.assertEqual(
            remaining,
            "Here is your brief:\nLet me know if you need more.",
        )

    def test_malformed_json_returns_original(self):
        text = f"prose\n{RICH_ENVELOPE_OPEN}\n{{not json{RICH_ENVELOPE_CLOSE}\nmore prose"
        env, remaining = extract_rich_envelope(text)
        self.assertIsNone(env)
        self.assertEqual(remaining, text)

    def test_missing_close_returns_original(self):
        text = f"prose\n{RICH_ENVELOPE_OPEN}\n{{\"cardsV2\": []}}\nno close"
        env, remaining = extract_rich_envelope(text)
        self.assertIsNone(env)
        self.assertEqual(remaining, text)

    def test_multiple_envelopes_last_wins(self):
        first = {"cardsV2": [{"cardId": "first"}]}
        second = {"cardsV2": [{"cardId": "second"}]}
        text = "a\n" + _wrap(first) + "\nb\n" + _wrap(second) + "\nc"
        env, remaining = extract_rich_envelope(text)
        self.assertEqual(env, second)
        self.assertEqual(remaining, "a\nb\nc")

    def test_non_dict_payload_rejected(self):
        # A bare list is valid JSON but not a useful envelope shape.
        text = f"{RICH_ENVELOPE_OPEN}\n[1, 2, 3]\n{RICH_ENVELOPE_CLOSE}"
        env, remaining = extract_rich_envelope(text)
        self.assertIsNone(env)
        # Malformed-only path returns original text untouched.
        self.assertEqual(remaining, text)


if __name__ == "__main__":
    unittest.main()
