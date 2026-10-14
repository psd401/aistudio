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
    """The section body, bounded by the next heading of ANY level.

    Bounding on "\n## " alone would silently swallow later sections if someone
    added an H2-level example inside this one.
    """
    text = SOUL.read_text(encoding="utf-8")
    start = text.index(SECTION_HEADING)
    body_start = start + len(SECTION_HEADING)
    ends = [
        offset
        for offset in (
            text.find("\n## ", body_start),
            text.find("\n### ", body_start),
        )
        if offset != -1
    ]
    return text[start : min(ends)] if ends else text[start:]


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
        section = isolation_section()
        self.assertIn("start fresh here", section)
        # The offer is half the point: pointing at the old thread without it
        # leaves someone who genuinely wants a clean start with no way out.
        self.assertIn("keep both halves", section)

    def test_replaces_the_clarifying_question_rather_than_adding_to_it(
        self,
    ) -> None:
        self.assertIn(
            "Say that instead of a clarifying question", isolation_section()
        )

    def test_self_contained_messages_are_carved_out(self) -> None:
        # A bare file upload is usually a self-contained request. Without this
        # carve-out the guidance fires on "summarize this PDF" and the rule
        # forbids the clarifying question that would otherwise rescue it.
        section = isolation_section()
        self.assertIn("stands on its own", section)
        self.assertIn("only makes sense as a continuation", section)

    def test_does_not_promise_complete_context(self) -> None:
        # SOUL.md's own transport section says Chat thread placement does not
        # prove session isolation, so the agent must not guarantee it will have
        # everything — it offers the mechanism, not a certainty.
        section = isolation_section()
        self.assertIn("I should\n  pick it up from there", section)
        self.assertNotIn("I'll have all of", section)

    def test_old_generic_clarifying_question_wording_is_gone(self) -> None:
        section = isolation_section()
        self.assertNotIn("ask a\n  concise question", section)
        self.assertNotIn("ask a concise question", section)


if __name__ == "__main__":
    unittest.main()
