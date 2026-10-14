"""SOUL.md's conversation-isolation guidance is load-bearing prose (#1891).

Threads are isolated by design, so the agent genuinely cannot see work from
another thread. What it says when it hits that wall decides whether the person
learns how to get their context back. In a read of 375 staff members' agent use
(Aug-Oct 2026) about 85 people lost context in a new thread; the old wording
asked them a clarifying question and never mentioned "Reply in thread", so they
re-pasted files and instructions instead.

These assertions are deliberately about the TEXT: nothing else in the stack can
tell whether that one line is still in the prompt.
"""

import pathlib
import unittest

SOUL = pathlib.Path(__file__).resolve().parent / "SOUL.md"
SECTION_HEADING = "### Conversation isolation"


def isolation_section() -> str:
    text = SOUL.read_text(encoding="utf-8")
    start = text.index(SECTION_HEADING)
    end = text.index("\n## ", start)
    return text[start:end]


class ConversationIsolationGuidance(unittest.TestCase):
    def test_section_still_exists(self) -> None:
        self.assertIn(SECTION_HEADING, SOUL.read_text(encoding="utf-8"))

    def test_rule_against_reading_other_threads_is_intact(self) -> None:
        section = isolation_section()
        self.assertIn(
            "Never read another session transcript to answer the current "
            "conversation.",
            section,
        )
        self.assertIn("never read another thread", section)

    def test_points_the_person_at_the_originating_thread(self) -> None:
        section = isolation_section()
        self.assertIn("Reply in thread", section)
        self.assertIn("where it started", section)

    def test_offers_to_start_fresh_instead(self) -> None:
        self.assertIn("start fresh here", isolation_section())

    def test_old_generic_clarifying_question_wording_is_gone(self) -> None:
        section = isolation_section()
        self.assertNotIn("ask a\n  concise question", section)
        self.assertNotIn("ask a concise question", section)


if __name__ == "__main__":
    unittest.main()
