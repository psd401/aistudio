"""Fact-only tests for the NSPRA coordinate extractor.

No source PDF, generated Markdown, screenshots, or publication prose may be
added as fixtures. Run from the repository root with:

    uv run --python 3.12 --no-project -m unittest \
      infra/agent-image/skills/psd-observances/tools/test_nspra_markdown.py
"""

from __future__ import annotations

import datetime as dt
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS_DIRECTORY = Path(__file__).resolve().parent
REPOSITORY_ROOT = Path(__file__).resolve().parents[5]
sys.path.insert(0, str(TOOLS_DIRECTORY))

import nspra_markdown as extractor


def word(x0: float, text: str, *, y0: float = 100.0) -> extractor.Word:
    """Build a compact synthetic coordinate word."""

    return extractor.Word(
        x0=x0,
        y0=y0,
        x1=x0 + max(8.0, len(text) * 4.0),
        y1=y0 + 10.0,
        text=text,
    )


class DateParsingTests(unittest.TestCase):
    def test_same_month_range(self):
        parsed = extractor.parse_date_text("April 6-10", 2026)
        self.assertIsNotNone(parsed)
        assert parsed is not None
        self.assertEqual(parsed.start, dt.date(2026, 4, 6))
        self.assertEqual(parsed.end, dt.date(2026, 4, 10))
        self.assertEqual(parsed.iso_text(), "2026-04-06/2026-04-10")

    def test_cross_month_and_cross_year_ranges(self):
        within_year = extractor.parse_date_text("Feb. 27-March 1", 2026)
        cross_year = extractor.parse_date_text("Dec. 27-Jan. 1", 2026)
        self.assertIsNotNone(within_year)
        self.assertIsNotNone(cross_year)
        assert within_year is not None and cross_year is not None
        self.assertEqual(within_year.end, dt.date(2026, 3, 1))
        self.assertEqual(cross_year.end, dt.date(2027, 1, 1))

    def test_invalid_calendar_date_fails_closed(self):
        self.assertIsNone(extractor.parse_date_text("Feb. 30", 2026))
        self.assertIsNone(extractor.parse_date_text("not a date", 2026))


class CoordinateTests(unittest.TestCase):
    def test_partition_uses_detected_anchors(self):
        first_page = [
            word(36, "April"),
            word(62, "1"),
            word(108, "Sample"),
            word(145, "Day"),
            word(274, "Fact"),
        ]
        shifted_page = [
            word(54, "April"),
            word(80, "1"),
            word(126, "Sample"),
            word(163, "Day"),
            word(292, "Fact"),
        ]
        self.assertEqual(
            extractor.partition_line(first_page, [36, 108, 274]),
            ["April 1", "Sample Day", "Fact"],
        )
        self.assertEqual(
            extractor.partition_line(shifted_page, [54, 126, 292]),
            ["April 1", "Sample Day", "Fact"],
        )

    def test_cluster_lines_ignores_input_text_order(self):
        words = [
            word(120, "second", y0=125),
            word(40, "first", y0=100),
            word(80, "line", y0=100.8),
        ]
        lines = extractor.cluster_lines(words)
        self.assertEqual(
            [extractor.words_to_text(line) for line in lines],
            ["first line", "second"],
        )

    def test_directory_subentries_inherit_indented_parent_heading(self):
        pages = {page: [] for page in extractor.DIRECTORY_PAGES}
        pages[5] = [
            word(54, "Sample", y0=150),
            word(88, "Professionals", y0=150),
            word(63, "Day................April", y0=165),
            word(145, "22", y0=165),
            word(63, "Week...............April", y0=180),
            word(145, "19-25", y0=180),
        ]
        entries = extractor.parse_directory(pages)
        self.assertEqual(
            [entry.name for entry in entries],
            ["Sample Professionals Day", "Sample Professionals Week"],
        )


class ReconciliationTests(unittest.TestCase):
    def test_reordered_directory_name_matches_identical_date(self):
        date = extractor.parse_date_text("Oct. 20", 2026)
        self.assertIsNotNone(date)
        directory = [
            extractor.DirectoryEntry(
                raw_date="Oct. 20",
                date=date,
                name="Example, Jordan",
                pdf_page=5,
            )
        ]
        observances = [
            extractor.Observance(
                raw_date="Oct. 20",
                date=date,
                name="Jordan Example Day",
                comments="",
                pdf_page=40,
            )
        ]
        matched, mismatches = extractor.reconcile_directory(directory, observances)
        self.assertEqual(matched, 1)
        self.assertEqual(mismatches, [])

    def test_identical_name_with_different_date_does_not_match(self):
        directory_date = extractor.parse_date_text("Oct. 20", 2026)
        observance_date = extractor.parse_date_text("Oct. 21", 2026)
        self.assertIsNotNone(directory_date)
        self.assertIsNotNone(observance_date)
        directory = [
            extractor.DirectoryEntry(
                raw_date="Oct. 20",
                date=directory_date,
                name="Sample Day",
                pdf_page=5,
            )
        ]
        observances = [
            extractor.Observance(
                raw_date="Oct. 21",
                date=observance_date,
                name="Sample Day",
                comments="",
                pdf_page=40,
            )
        ]
        matched, mismatches = extractor.reconcile_directory(directory, observances)
        self.assertEqual(matched, 0)
        self.assertEqual(len(mismatches), 1)


class RenderingTests(unittest.TestCase):
    def test_renderer_produces_exact_target_layout(self):
        extraction = extractor.Extraction(
            observances=[],
            directory_entries=[],
            states={},
            summary={},
            conferences=[],
            malformed_conference_rows=[],
            metadata={},
        )
        documents = extractor.render_documents(extraction)
        self.assertEqual(len(documents), 76)
        self.assertIn("Observances 2026-01.md", documents)
        self.assertIn("State Holidays — District of Columbia.md", documents)
        self.assertIn("Education Conferences 2031.md", documents)
        self.assertIn("Six-Year Holiday Summary 2026-2031.md", documents)

    def test_output_directory_must_be_empty(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            output = Path(temporary_directory)
            (output / "existing.md").write_text("existing", encoding="utf-8")
            with self.assertRaises(ValueError):
                extractor.write_documents(output, {"new.md": "new\n"})


class CopyrightGuardTests(unittest.TestCase):
    def test_current_repository_has_no_tracked_output_or_unapproved_pdf(self):
        self.assertEqual(extractor.copyright_guard_violations(REPOSITORY_ROOT), [])

    def test_guard_detects_tracked_output_and_pdf(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            repository = Path(temporary_directory)
            subprocess.run(
                ["git", "init", "-q", str(repository)],
                check=True,
                capture_output=True,
            )
            generated = (
                repository
                / "infra/agent-image/skills/psd-observances/generated/item.md"
            )
            generated.parent.mkdir(parents=True)
            generated.write_text("fact-only", encoding="utf-8")
            source_pdf = repository / "source.pdf"
            source_pdf.write_bytes(b"%PDF-fact-only-test")
            subprocess.run(
                ["git", "-C", str(repository), "add", "."],
                check=True,
                capture_output=True,
            )
            violations = extractor.copyright_guard_violations(repository)
            self.assertIn(
                "infra/agent-image/skills/psd-observances/generated/item.md",
                violations,
            )
            self.assertIn("source.pdf", violations)


if __name__ == "__main__":
    unittest.main()
